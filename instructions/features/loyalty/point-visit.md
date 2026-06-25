# Point and Visit Loyalty Feature Memory

Use this as quick context before changing POS-order loyalty, configuration, or analytics code. Full reference:
`.agent-hub/feature-docs/loyalty/point-visit-pos-order-flow-analysis.md`.

## End-to-end Topology

1. `POST /api/marketing/s2s/pos/order` validates raw `POSOrder` and publishes `aws.marketing.pos.order`.
2. `marketing.pos.order.enricher` resolves `brandId -> merchantId`, converts UTC wall-clock `createdAt` to RFC3339 IST, normalizes `website|rista -> rista`, and publishes `aws.platform.pos.order`.
3. `marketing.pos.order` consumes the platform event and asynchronously fans out campaign attribution, CRM ClickHouse ingest, and automation.
4. `loyalty.pos.order` consumes the same event, applies completed/source/phone gates, resolves the merchant group's active program, and dispatches by `program_type`.
5. Visit order: `RecordVisit` then coupon-backed reward consumption.
6. Point order: `EarnPoints` then prior-block burn settlement.

Topics are environment-suffixed outside dev/prod.

## Delivery Semantics

- Both common consumers commit offsets even when callbacks return errors.
- Marketing commits after launching goroutines, before their work necessarily finishes.
- There is no retry/DLQ here; failures are log-only after commit.
- Worker pools can complete same-partition messages out of order.
- Table idempotency is essential but incomplete.

## Identity and Versioning

- `merchant_group_mapping`: merchant -> `group_id`.
- `user_accounts`: unique `(phone, group_id)` -> `account_id`.
- `program_key`: logical program identity across versions; used by enrollment/counters/history.
- `program_id`: exact immutable configuration version.
- Program update expires old row and inserts new active row with same key/new ID.
- `merchant_groups.active_program_id` identifies current active/paused row.
- Drafts are Redis-only at `loyalty:program_draft:{groupId}`, TTL 10 days.
- Current program cache: `loyalty:current_program:{groupId}`, 2h; merchant-group cache: 24h.

## Shared Configuration

Base `loyalty_programs` fields: name/collectible display, earn MOV + basis, cooloff, earning/burning surface JSON.

Child tables:

- `visit_program_config`, `visit_program_milestones`
- `point_program_config`, `point_multiplier_rules`, `program_bonuses`
- `program_exclusions` (catalog/SKU/payment mode; earn/burn/both)
- `program_comm_config` (merchant + type + event + medium)
- `phone_exclusions` (global merchant-phone exclusion)

Program resources are committed atomically except comm configs, which are upserted after the program transaction.

## Loyalty Consumer Gates

- status must be `completed`;
- source `aggregator` is skipped;
- phone exclusion lookup is fail-open in the consumer;
- `rista|website` becomes `pos` for surface checks;
- missing/no active/paused program is a skip;
- unknown sources do not match a surface.

Hard earn errors prevent burn in the same message; soft eligibility skips allow burn to continue.

## Visit Flow

Preflight requires existing account, active program, and active enrollment. Eligibility: surface -> payment mode -> post-exclusion MOV -> cooloff.

Transaction:

1. `user_visits` audit row, unique `(program_key,account_id,source,order_id)`.
2. Eligible visit creates one `user_collectibles` row.
3. Refresh rolling expiry on all active collectibles when configured.
4. Lock/count active collectibles; exact milestone equality creates `user_rewards`.
5. Upsert `user_visit_counters`.

After commit, Marketing generates `deal_coupon_codes` + `customer_deals(source=loyalty)` and Loyalty stores coupon data in `user_rewards.reward_details`. Coupon failure after reward commit has no automatic repair/retry.

Visit reward burn matches platform `couponCodes`, marks active reward consumed, updates counters, then best-effort syncs Marketing status. Non-DotPe `marketingProvider` skips this burn.

Visit cooloff uses processing time (`user_visits.created_at`/`time.Now`), not order event time.

## Point Earn

Requires existing account/enrollment, enabled surface, accepted payment mode, post-exclusion MOV, positive eligible amount, and non-empty order items.

- gross/final earn basis is independent from MOV basis;
- exclusions prorate eligible amount by item value;
- percentage earn is floored; flat earn is fixed;
- highest category/day-time multiplier per item wins, no stacking;
- cap applies before uncapped exact-visit milestone bonus;
- flat earn ignores weighted amount, so category/day multipliers do not change its base award;
- ledger idempotency: `earn:{order_id}:{account_id}`;
- `user_point_ledger` is truth; `user_point_counters` is a projection.

POS path does not populate `HasManualDiscount`, so that exclusion flag is currently ineffective.

## Point Redemption

Redeemable read applies enrollment, burn surface, catalog exclusions, burn MOV, method (`order_pct|balance_pct|flat`), cart ceiling, burn cap, and balance cap.

Block:

- `POST /s2s/points/block`; Rista OTP, DotPe no OTP;
- creates negative `block` ledger row and FIFO `ledger_allocations`, decrements balance;
- does not itself enforce surface/payment/MOV/exclusions/max redeemable; settlement catches violations.

POS burn requires `pointsConsumed > 0`, `blockId`, and DotPe/empty marketing provider. It validates surface, payment, item/MOV, and INR equality `pointsConsumed == floor(blocked points * redemption_value)`.

- success: unblock allocation leg + burn leg; lifetime burned increments;
- mismatch: zero-amount `review` row, block remains held;
- admin resolves review as burn/unblock;
- stale unsettled blocks release after 12h;
- reversal restores settled burn; earned points from cancelled order are intentionally retained.

## Expiry and Communications

- Visit reward/collectible expiry: every 30m; reminders daily 10:00.
- Point activity/rolling expiry: every 30m; warning daily 09:00; stale blocks every 10m.
- Point expiry consumes only unallocated earn-lot remainder.
- `comm_dispatch_log` deduplicates scheduled reminders only; immediate sends have no outbox.

## Analytics Table Map

Configuration/identity:

- `merchant_groups`, `merchant_group_mapping`, `user_accounts`
- `loyalty_programs`, type config/milestone/multiplier tables
- `program_exclusions`, `program_bonuses`, `program_comm_config`, `phone_exclusions`
- `program_enrollments`

Visit facts/projection:

- `user_visits`, `user_collectibles`, `user_rewards`
- `user_visit_counters` (projection)

Point facts/projection:

- `user_point_ledger`, `ledger_allocations`
- `user_point_counters` (projection)

Marketing order/reward bridge:

- ClickHouse `crm.merchant_orders`, `crm.merchant_order_items`
- MySQL `campaign_attributed_orders`, `campaign_order_analytics`
- `automation_customer_stats`, automation rule/dispatch tables
- `customer_deals`, `deal_coupon_codes`

For historical analytics, join fact `program_id` to the exact configuration version; group continuity by `program_key`. Never apply the current config to old facts.

## Analytics and Reports Specification

Before changing loyalty analytics or reports, read
`.agent-hub/feature-docs/loyalty/loyalty-analytics-ticket-design-analysis.md`.
It reconciles DM-49, DM-89, the approved Figma frames, report columns, metric formulas, and current data readiness. Figma is authoritative where it differs from Jira.

- CRM Overview shows five metrics. Visit: total members, visits/member, ROI, redemption rate, ARPU lift. Point: active members, visits/member, ARPU lift, ROI, redemption rate.
- Dedicated P0 filters are Period, Store type, and Stores for both program types.
- Visit redemption design uses customer grain: members unlocking and customers redeeming, not raw reward-row counts.
- Point earning design uses Points issued with multiplier(s), including no-rule/single-rule/multiple-rule states, instead of Jira's standalone bar chart.
- Reports UI exposes generic Loyalty earn/burn choices, but there are four logical schemas: visit earn/burn and point earn/burn.
- Current blockers: no enrollment/opt-out store, mutable enrollment history, missing point order/eligible-value/balance/cap snapshots, unnormalized visit reward liability, missing comm cost/ROI definition, and incomplete Region/COCO/FOFO dimensions.
- Build a shared immutable ClickHouse loyalty-event read model enriched with Marketing orders/store dimensions; do not make dashboard/report queries perform repeated live cross-service joins.

## Critical Caveats

- Kafka errors still commit; Marketing fan-out is fire-and-forget.
- Loyalty mirrors Marketing's platform event manually.
- Point first-counter concurrent creation can lose a projection update while ledger stays correct.
- Automation customer stats increment without order idempotency.
- Visit preflight skips (not enrolled/user missing/program missing) do not create `user_visits`.
- `program_exclusions` unique key omits scope; use one `both` row rather than duplicate earn/burn rows.
- Staging `comm_dispatch_log.entity_type` only permits `reward|collectible`, but point warnings insert `point_counter`.
- MySQL program status has no `draft`; drafts are only Redis.
- `aggregators` is accepted at ingress but only singular `aggregator` is recognized downstream.
