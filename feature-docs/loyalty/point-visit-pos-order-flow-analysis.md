# Point and Visit Loyalty: End-to-End POS Order Flow

Generated from code inspection and read-only staging MySQL schema checks on 2026-06-23.

## Purpose and Scope

This is the durable reference for the current point-based and visit-based loyalty implementation across `marketing` and `loyalty`. It covers:

- program configuration, versioning, enrollment, opt-out, Redis caches, communications, and cron jobs;
- `POST /api/marketing/s2s/pos/order` through raw Kafka, enrichment, and the Marketing and Loyalty consumer groups;
- visit earning, milestone rewards, Marketing-owned loyalty coupons, and reward consumption;
- point earning, redeemable calculation, block/unblock, POS burn settlement, review, reversal, and expiry;
- MySQL/ClickHouse tables and the fields/keys that matter for analytics;
- delivery, idempotency, ordering, and known implementation/schema gaps.

The primary runtime path described here is the unified V2 program model (`loyalty_programs` with `program_type=visit|point`). The older provider facade (`provider_store_mapping`, `provider_configs`, `transactions`, `/api/loyalty/redeemable`, `/redeem`, etc.) remains adjacent and is used to bridge Rista checkout callbacks, but it is not the POS Kafka earn ledger.

## Executive Summary

```text
POS/order service
  -> POST marketing /s2s/pos/order
  -> aws.marketing.pos.order[.<env>]
  -> marketing.pos.order.enricher
       brandId -> merchantId (Aggregator; Redis 24h)
       UTC wall clock -> RFC3339 IST
       website|rista source -> rista
  -> aws.platform.pos.order[.<env>]
       |-> marketing.pos.order consumer
       |     |-> campaign attribution
       |     |-> CRM ClickHouse ingestion
       |     `-> automation stats/rules/coupon consumption
       `-> loyalty.pos.order consumer
             -> completed/non-aggregator/phone-exclusion gates
             -> current active program by merchant group
             |-> visit: RecordVisit -> stamp/milestone/reward/coupon
             |          then consume coupon-backed rewards
             `-> point: EarnPoints -> ledger/counter
                        then settle a prior point block as burn/review
```

The durable loyalty identity is `(program_key, account_id)`. `program_key` remains constant across configuration versions; `program_id` identifies the exact version used by an event. Analytics must preserve both.

## 1. Identifiers and Version Model

| Identifier | Meaning |
| --- | --- |
| `merchant_id` | DotPe merchant. Resolved from inbound `brandId` by Aggregator. |
| `group_id` | Loyalty tenancy boundary. `merchant_group_mapping` maps a merchant to a group. |
| `account_id` | Loyalty user within a group. `user_accounts` is unique on `(phone, group_id)`. |
| `program_key` | Logical program identity across versions and the key used by enrollment/counters/history. |
| `program_id` | Physical `loyalty_programs.id`; changes on every program update. |
| `order_id` | Upstream order identity used for visit and point-earn idempotency. |
| `block_id` | External point-redemption reservation identifier. |

Program lifecycle:

1. `POST /api/loyalty/programs` resolves or creates the merchant group.
2. Only one active/paused program is allowed through `merchant_groups.active_program_id`.
3. Creation generates a new `program_key`, writes the base and type-specific rows in one app transaction, and points `active_program_id` to the new row.
4. `PUT /programs/:programKey` expires the current row and inserts a new active row with the same `program_key` and a new `program_id`.
5. Allowed status transitions are active -> paused/expired and paused -> active/expired. Expired is terminal.
6. Paused programs are returned by the internal current-program lookup, but order processing explicitly skips them.
7. Drafts are request-shaped JSON stored only in Redis. They are not MySQL program rows.

Important transaction boundary: base program, type config, milestones/multipliers/bonuses, exclusions, and active pointer are atomic. `program_comm_config` upserts run after that transaction. A comm-config failure can return an API error even though the program was already committed.

## 2. Marketing POS Ingress and Event Contract

### 2.1 Ingress API

- Route: `POST /api/marketing/s2s/pos/order`
- Handler: `marketing/business/campaign/net/http.go:receivedPOSOrder`
- Auth: none; it is an S2S route.
- Action: validate and publish the raw request to `aws.marketing.pos.order` using the canonical environment-suffixed topic name.

Required/validated raw fields:

- `orderId`, `createdAt`, `serviceType` (`instore|outstore`), `status` (`completed|cancelled`), `brandId`, `source` (`rista|dotpe|website|aggregator|aggregators`);
- `amount >= 0`;
- `createdAt` must be exactly `2006-01-02 15:04:05` and is treated as a UTC wall-clock;
- phone comes from `user.phone`, is normalized, and is also copied into the raw request's top-level `phone`.

The request can also carry branch/business IDs, user name/email, items, deal IDs, coupon codes, bill URL, gross/final totals, point burn fields (`pointsConsumed`, `blockId`), marketing provider, source order ID, payment legs, and discount details.

`SavePOSOrder` only publishes Kafka. The HTTP 200 means Kafka push succeeded, not that enrichment or loyalty processing succeeded.

### 2.2 Enrichment Consumer

- Consumer group: `marketing.pos.order.enricher`
- Input: `aws.marketing.pos.order`
- Output: `aws.platform.pos.order`
- File: `marketing/scripts/consumers/pos-order/main.go`

Steps:

1. Unmarshal `POSOrder`.
2. Resolve `merchantId` from `brandId` using Aggregator `GET /api/aggregator/merchant/mapping/brands/:brandId`.
3. Cache the brand mapping for 24 hours.
4. Convert the raw UTC wall-clock to RFC3339 with IST offset. On conversion error, log a warning and retain the original value.
5. Normalize source `website` or `rista` to `rista`; other values pass through.
6. Flatten `user.phone/name/email` into `PlatformPOSOrder` and preserve the remaining order/burn fields.
7. Publish to the platform topic.

If Aggregator returns an error containing `merchantid not found`, the record is deliberately dropped. Other callback errors are returned, but the common consumer still commits the Kafka offset.

### 2.3 Enriched Platform Event

The contract is declared in Marketing and manually mirrored in the Loyalty consumer. There is no shared schema package.

| Area | Fields used downstream |
| --- | --- |
| Identity | `orderId`, `merchantId`, `brandId`, `branchId`, `businessId` |
| Customer | `phone`, `name`, `email` |
| Order | `amount`, `createdAt`, `serviceType`, `serviceSubType`, `status`, `source` |
| Financial | `totalAmountWithoutTax`, `totalAmountWithTax`, `paymentInfo`, `discounts` |
| Items | IDs, SKU/category/subcategory, quantity, tax/discount, with/without-tax totals, item discounts |
| Campaign/reward | `dealIds`, `couponCodes`, `billUrl` |
| Point settlement | `pointsConsumed` (INR), `blockId`, `marketingProvider` |

Schema changes must be made in both `marketing/domain/requests/campaign.go` and `loyalty/scripts/consumers/pos-order/main.go`.

### 2.4 Kafka Delivery Semantics

Both services use a worker pool and `consumer.CommitMessage(msg)` after invoking the callback, regardless of callback error.

- Enricher and Loyalty callback failures are logged but still committed: there is no Kafka retry/DLQ in this code.
- Marketing's platform callback launches three goroutines and returns immediately. Its offset can be committed before campaign, CRM, or automation work finishes.
- Marketing goroutine failures are only logged and cannot cause replay.
- Worker-pool execution can process records from the same partition concurrently, so completion order is not guaranteed.
- `auto.offset.reset=latest`; a new group does not backfill old events.

Treat the pipeline as loss-prone at failure boundaries, not exactly-once. Table-level idempotency protects some duplicates but does not repair a committed failure.

## 3. Marketing Platform Consumer Fan-out

- Group: `marketing.pos.order`
- File: `marketing/scripts/consumers/pos-order-marketing/main.go`
- Non-`completed` events are ignored.

Three independent goroutines run for each completed event.

### 3.1 Campaign Attribution

`CampaignUC.UpdateStats`:

- skips zero-amount orders;
- marks matching `customer_deals` consumed when `dealIds` are present;
- finds the latest campaign sent to the contact before the order;
- inserts `campaign_attributed_orders` with unique `(campaign_id, order_id)` behavior;
- increments `campaign_order_analytics` for 1/7/30/90-day attribution buckets only on the first insert.

This branch is idempotent at the attributed-order boundary.

### 3.2 CRM Order Ingestion

`DataIngestionService.IngestMerchantOrder`:

- gates on an active MySQL `crm_merchants` record, cached as active/inactive for 24 hours;
- writes the order to ClickHouse `crm.merchant_orders`;
- consolidates item rows by item ID, drops non-positive final quantity, and writes `crm.merchant_order_items`;
- treats item failure as non-fatal after the order row succeeds.

`crm.merchant_orders` uses ReplacingMergeTree semantics keyed for order replacement; it is the raw source later aggregated for CRM/RFM. See the separate RFM feature document for the downstream daily-order and RFM pipeline.

### 3.3 Automation

Automation is also gated on active CRM status. It:

1. increments/upserts `automation_customer_stats`;
2. evaluates active new-customer, nth-order, and high-value rules;
3. writes automation dispatch/coupon state and sends qualifying communications;
4. independently marks matching automation coupon codes consumed.

`RecordCustomerOrder` increments counters on every call and has no order-id dedup guard. Duplicate platform events can inflate automation customer stats.

## 4. Loyalty Platform Consumer Dispatch

- Group: `loyalty.pos.order`
- File: `loyalty/scripts/consumers/pos-order/main.go`

Global gates:

1. status must equal `completed` exactly;
2. source `aggregator` is skipped;
3. `phone_exclusions` is checked when phone is non-empty; lookup failure is fail-open;
4. source `rista` or `website` is converted to `pos` for surface evaluation;
5. resolve the current program by merchant -> group -> `active_program_id`;
6. missing merchant/program, paused program, and unknown type are expected skips.

The singular/plural source distinction matters: `aggregator` is skipped globally; `aggregators` passes that gate but does not match any surface and is rejected later.

Dispatch order matters:

- visit: earn/record visit first, then consume visit rewards;
- point: earn points first, then consume a prior point block.

A soft earn skip returns nil and burn still runs. A hard earn error returns immediately and prevents burn for that event. The offset is committed either way.

## 5. Shared Program Configuration

Base request fields persisted in `loyalty_programs`:

| Field | Semantics |
| --- | --- |
| `name`, `collectibleName`, image | Display configuration. Point programs use collectible name as the point alias. |
| `movType` | `gross` uses `totalAmountWithoutTax`; `final` uses `totalAmountWithTax`. |
| `mov` | Earn minimum order value after earn-scoped catalog exclusions. |
| `cooloffType/value` | `hours` or `calendar_day`; value 0 means every distinct qualifying order. |
| `earningSurfaces` | JSON flags for `pos`, `dotpe`, `sok`, `aggregator`. |
| `burningSurfaces` | Same flags for redemption/consumption. |

Shared child configuration:

- `program_exclusions`: category, subcategory, item/SKU, or payment mode; scope `earn|burn|both`; version-scoped by `program_id`.
- `program_comm_config`: merchant + program type + event + medium; shared across versions.
- `program_bonuses`: currently point welcome bonus (`native` points) with optional expiry override.
- `phone_exclusions`: merchant + phone global kill switch, independent of a program version.

Surface mapping is exact: `pos`, `dotpe`, `sok`, `aggregator`. Unknown sources are ineligible.

Catalog IDs are stored in Rista form. Public/DotPe reads can ask Aggregator to map them to DotPe IDs; POS/Rista reads keep raw IDs.

## 6. Enrollment and Opt-out

Enrollment routes dispatch by active program type. The shared flow:

1. reject a phone in `phone_exclusions` (fail-closed);
2. optionally trigger/verify OTP;
3. require active program;
4. get/create `user_accounts` for `(phone, group_id)`;
5. insert or reactivate `program_enrollments` keyed by `(program_key, account_id)`;
6. dispatch type-specific communication.

Point first enrollment optionally writes a welcome-bonus ledger entry and counter update. Re-enrollment does not award it again. Visit re-enrollment can return progress/history.

Opt-out atomically changes enrollment status and cleans type resources:

- visit: active rewards and collectibles become cancelled; active counter values reset, lifetime totals remain;
- point: current balance is expired with FIFO allocation rows, balance/visit/activity fields reset, lifetime earned/burned/expired totals remain.

Re-enrollment reuses the same logical `program_key` and account.

## 7. Visit-based Loyalty

### 7.1 Configuration

`visit_program_config`:

- `collectible_expiry_days`: nil means stamps never expire;
- `reward_expiry_value` + `reward_expiry_type`: reward TTL in hours or calendar days.

`visit_program_milestones`:

- unique collectible threshold per program;
- only `reward_type=rista_deal` is supported;
- `reward` stores the Rista deal snapshot, including `deal_id` and optional coupon prefix;
- label/description/image are display metadata.

Visit item/category exclusions are always converted to earn scope. Payment-mode exclusions may be earn, burn, or both.

### 7.2 RecordVisit Flow

Input is built from the platform event using phone, merchant, branch, source, order ID, gross/final totals, items, and payment modes.

Preflight:

1. phone must resolve to an existing account; orders do not auto-enroll;
2. current program must exist and be active;
3. enrollment must be active.

Eligibility:

1. earning surface enabled;
2. no earn/both payment-mode exclusion;
3. calculate eligible amount using configured MOV basis;
4. subtract matching excluded item totals directly from the order base amount;
5. eligible amount >= MOV;
6. cooloff passed.

Visit cooloff uses the last eligible `user_visits.created_at` and `time.Now()`, not the order event timestamp. Late/out-of-order events are therefore evaluated by processing time.

Transactional writes:

1. insert `user_visits` for eligible and post-preflight ineligible attempts;
2. duplicate unique `(program_key, account_id, source, order_id)` returns existing state;
3. for eligible visits, insert one `user_collectibles` row;
4. if configured, set the new expiry and refresh all active collectibles to the same rolling expiry;
5. lock/count all active collectibles;
6. if active count exactly equals a milestone threshold, insert `user_rewards`;
7. link the new collectible to the reward and upsert `user_visit_counters`.

Milestones trigger on exact active-count equality. Stamps are not reset after reward issuance, so ascending thresholds represent cumulative progression.

### 7.3 Reward Coupon Generation

After the visit transaction commits, a newly issued `rista_deal` reward synchronously calls Marketing:

- `POST /api/marketing/s2s/crm/loyalty/coupon/generate`;
- Marketing creates `deal_coupon_codes` and `customer_deals` with `source=loyalty`;
- Loyalty stores `coupon_code`, `coupon_id`, and `loyalty_campaign_id` in `user_rewards.reward_details`;
- reward/stamp communications are fire-and-forget.

Failure gap: the reward transaction is already committed before coupon generation. If coupon generation fails, the consumer returns an error but commits the Kafka message. A duplicate visit returns the existing visit without re-running coupon generation. Such rewards require reconciliation.

### 7.4 Reward Consumption

After visit earning, platform coupon codes are processed only when `marketingProvider` is empty or `dotpe`.

1. resolve account and active program;
2. enforce burning surface and burn/both payment-mode exclusions;
3. find active, unexpired rewards whose JSON coupon code matches;
4. mark each reward consumed and update `user_visit_counters` in a transaction;
5. best-effort call Marketing `PUT /s2s/crm/coupon/status` with order/bill/time data.

Marketing sync failure is intentionally not returned because Loyalty is already committed.

### 7.5 Visit Expiry Jobs

- Every 30 minutes: expire rewards and refresh active-reward counters transactionally; then best-effort expire Marketing coupons and send expired communication.
- Every 30 minutes: expire collectibles and recompute active collectible/next-milestone counters.
- Daily 10:00: reward and stamp expiry reminders. Reminder days come from comm-config `extra_info.reminder_days`.
- `comm_dispatch_log` deduplicates reminder sends.

## 8. Point-based Loyalty

### 8.1 Configuration

`point_program_config`:

| Field | Semantics |
| --- | --- |
| `earn_basis` | gross/final amount used for point calculation; independent from base MOV basis. |
| `earn_calc_type` | `percentage` or `flat`. |
| `earn_per_points` | Percentage rate or fixed point count. |
| `earn_cap` | Optional cap before milestone bonus. |
| `redemption_value` | INR represented by one point. |
| `burn_min_order_value`, `burn_mov_type` | Independent redemption MOV gate. |
| `burn_method` | `order_pct`, `balance_pct`, or `flat`. |
| `burn_value`, `burn_cap` | Method parameter and optional final cap. |
| `expiry_model` | `activity_based`, `rolling`, or `none`. |
| `expiry_days` | TTL for activity/rolling models. |
| `exclude_manual_discount` | Gate exists, but POS event currently never sets `HasManualDiscount`. |

Multiplier rules (`point_multiplier_rules`, maximum five entries in request validation):

- `category_item`: catalog/SKU-specific multiplier;
- `day_time`: optional inclusive date range, weekday list (0 Sunday), and half-open time slots;
- `visit_milestone`: flat bonus when the next qualifying earn makes total visits exactly N.

For an item, the highest applicable category/day-time multiplier wins; rules do not stack. Earn cap applies before the milestone bonus, and the milestone bonus is uncapped. Percentage calculations are floored. For `flat` earn type, amount weighting/multipliers still feed `calcBasePoints`, but flat calculation ignores amount; category/day multipliers therefore do not change the flat base award.

### 8.2 Point Earn Flow

Preflight:

1. resolve existing account by phone; no auto-enrollment;
2. current program must be active point type with config;
3. active enrollment required;
4. earning surface enabled;
5. no earn/both payment-mode exclusion;
6. optional manual-discount gate (not populated by this Kafka path).

Calculation:

1. choose base MOV and earn amounts independently;
2. prorate both by eligible item value when catalog exclusions match;
3. require post-exclusion MOV and positive eligible amount;
4. require non-empty order items (orders without items earn zero even when amount is present);
5. calculate base and per-item highest multipliers;
6. apply earn cap;
7. add exact-visit milestone bonus.

Commit in one point transaction:

- lock `user_point_counters` when it exists;
- enforce cooloff using `last_qualifying_earn_at` and event `OrderTime`;
- insert append-only `user_point_ledger` type `earn`, idempotency `earn:{order_id}:{account_id}`;
- upsert balance/lifetime totals/visits/last qualifying earn;
- fire points-earned communication.

`EarnRules` JSON on the ledger stores base points, effective multiplier type/value, final points, milestone bonus, and rule IDs. It is the strongest audit source for explaining an award.

Concurrency caveat: `SELECT ... FOR UPDATE` cannot lock a missing first counter row. Concurrent first distinct earns can both observe nil and then upsert; the ledger remains correct but the denormalized counter can lose an update.

### 8.3 Redeemable Calculation

`POST /api/loyalty/s2s/programs/redeemable` is read-only and is used by the Rista bridge for point programs.

1. resolve brand -> merchant, phone -> account, active point program;
2. reject phone exclusion and disabled burn surface;
3. require active enrollment;
4. apply burn-scope item exclusions and burn MOV;
5. compute cart ceiling `floor(eligible INR / redemption_value)`;
6. calculate by method:
   - order_pct: floor(order percentage value / redemption value);
   - balance_pct: percentage of balance, capped by cart ceiling;
   - flat: fixed points, capped by cart ceiling;
7. apply `burn_cap`, then current-balance cap;
8. return point count, floored INR value, balance, and reduction reasons.

### 8.4 Block, Burn, Review, Unblock

Block route: `POST /api/loyalty/s2s/points/block`.

- resolves active enrolled user and phone exclusion;
- Rista source requires OTP; DotPe source must not send OTP;
- locks counter, verifies balance, inserts ledger `block` with a fresh UUID `block_id` and negative amount;
- creates FIFO `ledger_allocations` against earn lots;
- decrements current balance.

The block endpoint does not itself re-check burning surface, payment mode, item exclusions, burn MOV, or configured maximum redeemable points. `PaymentModes` is accepted but unused. Normal callers are expected to calculate redeemable first; invalid reservations are caught later at settlement.

Point POS settlement runs after point earn when the event has `pointsConsumed > 0`, a `blockId`, and an empty/`dotpe` marketing provider.

Burn gates:

1. burning surface;
2. burn/both payment-mode exclusions;
3. item exclusions + burn MOV when actual item/amount data is present;
4. `pointsConsumed` INR must equal `floor(blocked points * redemption_value)` within 0.01.

On success, one transaction writes an unblock leg to release the reservation allocation, then a burn leg that re-consumes the same lots, and increments `total_points_burned`; net current balance remains at its post-block value.

Any gate mismatch or unexpected settlement error writes a zero-amount `review` ledger row and leaves the block held. Admin `POST /admin/points/review/resolve` can settle it as burn or unblock.

Explicit unblock writes `unblock`, reverses allocations, restores only non-expired points, and immediately expires prior-enrollment-cycle points. A cron releases unsettled, non-review blocks older than 12 hours every 10 minutes.

### 8.5 Reversal

`POST /api/loyalty/s2s/points/reverse` handles cancellation after the provider grace window:

- settled burn -> `reverse_burn`, restore lots/balance, decrement lifetime burned;
- unsettled block -> atomic unblock -> forced burn -> reverse burn so a later Kafka burn becomes a no-op;
- already reversed/unblocked -> idempotent no-op;
- review -> manual resolution required.

Earned points from the cancelled order are intentionally not reversed by this flow.

### 8.6 Point Expiry

- rolling: each earn/welcome ledger row gets `expires_at`; cron expires only its unallocated remainder;
- activity-based: `last_qualifying_earn_at + expiry_days`; cron drains each unallocated earn lot;
- none: no scheduled expiry;
- blocks preserve lot allocations so held points are not double-expired;
- opt-out expires remaining lots immediately.

Point jobs:

- every 30 minutes: activity and rolling expiry, batch size 500;
- daily 09:00: seven-day activity-expiry warning;
- every 10 minutes: stale-block release.

## 9. Communications

`program_comm_config` is unique by `(merchant_id, program_type, event_type, medium)` and supports SMS/WhatsApp with variable mappings. Active status is `A`; disabled is `D`.

Visit events include enrolled, stamp earned/expiring, reward earned/expiring/expired/claimed, and opt-out. Point events include point enrollment, welcome bonus, earned, redeemed, expiring, and opt-out.

Template content is fetched from Comm/Marketing with Redis cache. Runtime variables are resolved from program, merchant, account, reward, point, and counter data. Most event sends are fire-and-forget and are not covered by an outbox. Reminder jobs use `comm_dispatch_log`; immediate earn/enroll/redeem sends do not.

## 10. Persistence Catalog

The following Loyalty schemas and indexes were verified in staging `loyaltyDB` on 2026-06-23.

### 10.1 Tenancy and Program Configuration

| Table | Purpose | Important columns and keys |
| --- | --- | --- |
| `merchant_groups` | Group-level loyalty type/current program. | PK `group_id`; `source`, `rule_id`, `loyalty_type`, `active_program_id`. |
| `merchant_group_mapping` | Merchant -> group. | PK `merchant_id`; index `group_id`; legacy `exclude_items`. |
| `user_accounts` | Customer identity inside group. | PK `id`; unique `(phone, group_id)`; legacy `points` is not the V2 point balance. |
| `loyalty_programs` | Versioned base config. | PK `id`; indexed `program_key`, `group_id`; type/status/MOV/cooloff/surfaces/display fields. |
| `visit_program_config` | Visit scalar config 1:1. | PK `id`; unique `program_id`; collectible/reward expiry fields. |
| `visit_program_milestones` | Visit thresholds/reward snapshots. | PK `id`; unique `(program_id, collectibles_required)`. |
| `point_program_config` | Point scalar config 1:1. | PK `program_id`; earn, redemption, burn, expiry, discount fields. |
| `point_multiplier_rules` | Version-scoped point multipliers. | PK `id`; index `(program_id,status)`; rule/config/date/status. |
| `program_exclusions` | Version-scoped catalog/payment exclusions. | PK `id`; unique `(program_id, exclusion_type, exclusion_id)`; scope is not part of uniqueness. |
| `program_bonuses` | Version-scoped bonus definitions. | PK `id`; unique `(program_id, bonus_type, value_type)`. |
| `program_comm_config` | Merchant/type communication config. | PK `id`; unique `(merchant_id, program_type, event_type, medium)`. |
| `phone_exclusions` | Global merchant-phone exclusion. | PK `id`; unique `(merchant_id,phone)`. |

Because `program_exclusions.scope` is absent from its unique key, the same catalog/payment ID cannot be stored as separate earn and burn rows. Use a single `both` row when both sides must be excluded.

### 10.2 Enrollment and Visit Runtime

| Table | Purpose | Important columns and keys |
| --- | --- | --- |
| `program_enrollments` | Logical-program enrollment. | PK `id`; unique `(program_key,account_id)`; current `program_id`, source, consent, status, enrollment/cancellation times. |
| `user_visits` | Visit attempt audit after preflight. | PK `id`; unique `(program_key,account_id,source,order_id)`; amounts, reason, collectible link. |
| `user_collectibles` | Earned stamps. | PK `id`; same idempotency unique key; status/expiry/reward link; index `(program_key,account_id,status)`. |
| `user_rewards` | Issued visit rewards. | PK `id`; program/account/milestone, JSON runtime coupon detail, status/validity/redemption. |
| `user_visit_counters` | Denormalized visit progress. | PK `id`; unique `(program_key,account_id)`; lifetime/active collectible and reward counts. |

`user_visits` does not contain preflight failures such as user-not-found, not-enrolled, or program-not-configured; those are log-only skips.

### 10.3 Point Runtime

| Table | Purpose | Important columns and keys |
| --- | --- | --- |
| `user_point_counters` | Fast current balance/lifetime metrics. | PK `id`; unique `(program_key,account_id)`; balance, earned/burned/expired, visits, last qualifying earn. |
| `user_point_ledger` | Append-only point event truth. | PK `id`; unique nullable `idempotency_key`; program version, type, signed amount, order/source link, expiry, rules, block ID. |
| `ledger_allocations` | FIFO lot consumption/release. | PK `id`; unique `(txn_id,earn_txn_id)`; indexed `earn_txn_id`; signed allocation amount. |
| `comm_dispatch_log` | Expiry/reminder dedup. | PK `id`; seven-column unique dispatch identity. |

Ledger sign convention:

- positive: earn, welcome bonus, unblock, reverse burn;
- negative: block, burn, expire, reverse earn;
- zero: review marker.

The counter is a projection and can drift; the ledger plus allocations are the accounting source of truth.

### 10.4 Adjacent Legacy Provider Tables

| Table | Role |
| --- | --- |
| `provider_store_mapping` | Selects provider by source/merchant/store. |
| `provider_configs` | Store/provider callback URLs and keys such as Rista get-user/OTP/store key. |
| `transactions` | Legacy provider earn/burn/reverse transactions. Not the V2 point ledger. |
| `excluded_objects_mapping` | Legacy store/provider exclusion path. Not `program_exclusions`. |

### 10.5 Marketing-side Tables Touched by the Platform Event or Loyalty Reward

| Store | Tables | Role |
| --- | --- | --- |
| Marketing MySQL | `campaign_attributed_orders`, `campaign_order_analytics` | Per-order campaign attribution and bucket aggregates. |
| Marketing MySQL | `customer_deals`, `deal_coupon_codes` | Campaign/automation/loyalty coupon assignment and status. Loyalty rows use `source=loyalty`. |
| Marketing MySQL | `automation_customer_stats`, automation rule/dispatch/config tables | Realtime automation state and coupon trace. |
| Marketing MySQL | `crm_merchants` | CRM enablement gate for ClickHouse/automation. |
| Marketing ClickHouse | `crm.merchant_orders`, `crm.merchant_order_items` | Raw completed order and item facts used by CRM/RFM. |

## 11. Redis and External Dependencies

Important Loyalty keys:

- `loyalty:program_draft:{groupId}`: one draft per group, TTL 10 days;
- `loyalty:current_program:{groupId}`: active/paused base program + exclusions, TTL 2h;
- `loyalty:merchant_group:{merchantId}`: merchant-group mapping, TTL 24h;
- Rista sale/OTP response keys: checkout bridge state, generally 10-minute scope.

External calls:

- Aggregator: brand/merchant mapping and catalog ID mappings;
- Marketing: loyalty coupon generate/list/status/bulk-expire and communication send;
- Comm/template service: template lookup and message send;
- Rista/provider callbacks: get user/redeemable, OTP, block/unblock/reverse.

## 12. API Map

Program/configuration:

- authenticated: `POST/GET /api/loyalty/programs`, `GET/PUT/PATCH /programs/:programKey...`, draft and comm-config routes;
- public/S2S: active program, enroll, user data, opt-out, redeemable;
- admin: comm-config and point review resolution.

Point settlement:

- `POST /api/loyalty/s2s/points/block`
- `POST /api/loyalty/s2s/points/unblock`
- `POST /api/loyalty/s2s/points/reverse`

Visit coupon bridge:

- `POST /api/loyalty/s2s/programs/coupon/verify`
- `PUT /api/loyalty/s2s/programs/coupon/status`
- `POST /api/loyalty/s2s/programs/coupon/list`

Phone exclusion sync:

- `POST /api/loyalty/s2s/phone-exclusions`

## 13. Analytics Guidance

Use event tables as facts and counters as projections:

- visit attempt fact: `user_visits`;
- earned stamp fact: `user_collectibles`;
- issued/redeemed/expired reward fact: `user_rewards`;
- point accounting fact: `user_point_ledger` + `ledger_allocations`;
- configuration-as-of-event: join event `program_id` to `loyalty_programs` and its type config;
- cross-version customer/program identity: group by `program_key` and `account_id`;
- merchant: `loyalty_programs.group_id -> merchant_group_mapping.merchant_id`;
- phone: `account_id -> user_accounts`.

Do not derive historical rules from the current active program. Every event stores `program_id` because configuration changes create a new version.

Recommended reconciliation checks before analytics rollout:

1. point counter balance vs signed ledger/allocation-derived balance;
2. point lifetime counters vs ledger types, separating block/unblock internal legs;
3. visit counters vs active/all-time collectible and reward facts;
4. reward rows missing `reward_details.coupon_code` vs Marketing loyalty deals;
5. blocks with no terminal burn/unblock and reviews awaiting resolution;
6. completed POS orders present in Marketing ClickHouse but absent from eligible Loyalty facts;
7. duplicate automation increments by order ID;
8. event `program_id` whose type config row is missing.

## 14. Known Gaps and High-risk Caveats

1. Kafka callback errors are committed; there is no retry/DLQ.
2. Marketing fan-out commits before goroutines complete.
3. Loyalty event struct is manually duplicated from Marketing.
4. Visit coupon generation happens after reward commit with no repair/outbox.
5. Point block does not enforce redemption eligibility; settlement may route to review later.
6. Point POS earn requires items; missing-item events earn nothing.
7. Manual-discount exclusion is not populated by the current POS event path.
8. Visit cooloff uses processing time; point cooloff uses event time.
9. Point first-counter creation has a concurrent lost-update window.
10. Automation customer stats increment without order idempotency.
11. Immediate communication sends lack durable dispatch/outbox state.
12. Staging schema drift: `comm_dispatch_log.entity_type` is `ENUM('reward','collectible')`, but point expiry code inserts `point_counter`; point warning dispatch will fail until schema is expanded.
13. MySQL `loyalty_programs.status` is `ENUM('active','paused','expired')`; drafts are Redis-only despite a domain `draft` constant.
14. Marketing accepts source `aggregators`, but surface logic recognizes only singular `aggregator`.
15. Non-DotPe `marketingProvider` skips visit/point burn to avoid double redemption; analytics must distinguish provider-managed consumption from Loyalty ledger consumption.

## 15. Code Map

Marketing ingress and fan-out:

- `marketing/business/campaign/net/http.go`
- `marketing/business/campaign/usecase/campaign.go`
- `marketing/domain/requests/campaign.go`
- `marketing/scripts/consumers/pos-order/main.go`
- `marketing/scripts/consumers/pos-order-marketing/main.go`
- `marketing/scripts/consumers/process.go`
- `marketing/business/crm/ingestion/etl_service.go`
- `marketing/business/automation/usecase/automation_engine.go`

Loyalty dispatch/configuration:

- `loyalty/scripts/consumers/pos-order/main.go`
- `loyalty/business/program/usecase/program.go`
- `loyalty/business/program/usecase/enrollment.go`
- `loyalty/business/program/repository/mysql/`
- `loyalty/domain/dto/requests/program.go`, `visit.go`, `point.go`

Visit:

- `loyalty/business/visit/usecase/tracking.go`
- `loyalty/business/visit/usecase/reward.go`
- `loyalty/business/visit/repository/mysql/`
- `loyalty/business/visit/scheduler/`

Point:

- `loyalty/business/point/usecase/tracking_earn.go`
- `tracking_redeemable.go`, `tracking_block.go`, `tracking_burn.go`
- `tracking_reverse.go`, `tracking_review.go`, `tracking_expiry.go`
- `loyalty/business/point/repository/mysql/`
- `loyalty/business/point/scheduler/jobs.go`
