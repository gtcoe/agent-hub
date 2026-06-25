# Loyalty Analytics and Reports: Ticket, Design, and Data-Readiness Analysis

Analysis snapshot: 2026-06-23

## 1. Scope and source priority

This document analyses the P0 loyalty analytics and reporting scope for both program types:

- [DM-49 — Visit based loyalty (Analytics and reporting)](https://dotpe.atlassian.net/browse/DM-49), last updated 2026-05-12;
- [DM-89 — Point loyalty (Analytics, reporting, cust)](https://dotpe.atlassian.net/browse/DM-89), last updated 2026-05-27;
- [Approved Loyalty Figma designs](https://www.figma.com/design/Rtge3sLswQPgIyV3RlmA9L/Loyalty?node-id=5171-29636), including the visit dashboard, point dashboard, CRM overview component, and Reports flow;
- the current `loyalty`, `marketing`, `panel-dashboard`, and report-request implementations;
- the detailed runtime/data reference in [point-visit-pos-order-flow-analysis.md](./point-visit-pos-order-flow-analysis.md).

When sources disagree, the resolution order used here is:

1. approved Figma frame and visible copy;
2. Jira requirement/calculation;
3. a documented product decision where neither source is sufficient;
4. current implementation only determines feasibility, not intended behavior.

The Jira P1 Customer 360 additions are recorded as adjacent scope, but this document's implementation specification concentrates on the requested P0 surfaces:

1. the compact loyalty metrics component on the CRM Overview Dashboard;
2. the full Analytics tab on the loyalty home page;
3. loyalty earn and burn reports.

The inspected Figma frames were visit analytics `5171:29638`, point analytics `7583:479`, visit Overview `5171:30474`, point Overview `7573:1542`, and Reports `7781:1530`, plus the report-request and point multiplier-state variants adjacent to those approved frames.

## 2. Executive assessment and thoughts

Both visit-based and point-based loyalty are covered. They must not share a single metric formula merely because the screens look similar. They share the presentation shell, filters, comparison-period behavior, and store table pattern; their event facts and several denominators differ.

The approved design defines three clear product surfaces:

- a five-tile `Loyalty program performance` component on the CRM Overview Dashboard;
- a dedicated Analytics tab with reach, health, expiry/liability, and store-performance sections;
- a `Loyalty` category in Reports with `Loyalty earn report` and `Loyalty burn report` request types.

The current frontend has `Analytics coming soon` for both visit and point programs. There is no loyalty analytics API or report generator in the inspected backend. The existing Reports UI already has an asynchronous request/list/download pattern, but only Commerce and WhatsApp categories are implemented.

The current data is enough for many loyalty-native counts:

- visit stamps, rewards, redemption timestamps, and expiry state;
- point ledger credits, burns, expiry, multiplier audit JSON, and FIFO allocations;
- enrollments and the current/latest opt-out state;
- completed orders and item facts in Marketing ClickHouse.

It is not enough to calculate every approved metric accurately under every filter. The main gaps are:

- enrollment and opt-out events do not store a store/outlet, so store-filtered enrolment and opt-out metrics are not currently attributable;
- `program_enrollments` is mutable and does not preserve every enrolment/opt-out cycle, so historical member/non-member classification is incomplete;
- point ledger rows do not persist store, channel, order value, eligible order value, redemption value, applied burn cap, or balance-after snapshots;
- visit processing stores `user_visits.created_at`, not the original order event time, which weakens visit-gap and event-period accuracy for delayed events;
- monetary reward liability has no normalized, immutable reward-cost/value snapshot;
- communication cost is not captured and the Jira ROI formula is incomplete;
- city is only partially available through store sources, while region and COCO/FOFO are not established shared dimensions in the inspected analytics data;
- cross-service callback failures can be committed at Kafka, so analytics cannot assume that every completed Marketing order has a corresponding Loyalty fact.

The correct engineering direction is to build an immutable loyalty analytics fact in ClickHouse, fed by Loyalty events or CDC and enriched with Marketing order/store dimensions. Repeated live joins between Loyalty MySQL, Marketing MySQL, ClickHouse, and Reports API would be slow, hard to reconcile, and unsuitable for report generation.

## 3. Canonical analytics semantics

The following semantics should be common to both program types unless a metric explicitly overrides them.

### 3.1 Time range and comparison

- Treat a selected period as `[from, to)` in the merchant's reporting timezone.
- The comparison period is the immediately preceding interval of equal duration.
- A `Last 30/60/90 days` selection and a custom range should use the same API contract.
- Event metrics use the event's business timestamp, not Kafka processing time.
- Snapshot metrics use the state as of `to`, not necessarily the state at query time.
- A lifetime metric shown with a period filter should be a lifetime-as-of-`to` snapshot; its trend is the change from the prior period-end snapshot.
- If a program was paused, clamp event data to the pause timestamp and show the resume nudge. Expired/deleted programs follow the product visibility rules in section 10.

### 3.2 Program identity and versions

- Group across configuration versions with `program_key`.
- Join each event through its stored `program_id` to obtain rules/configuration as of that event.
- Do not join historical events only to `merchant_groups.active_program_id`; that would rewrite history with the latest program version.
- Deduplicate a customer across stores when calculating merchant-level members. Store rows are not additive for customers who used multiple stores.

### 3.3 Filter behavior

The dedicated approved designs visibly show:

- `Period`, defaulting to `Last 90 days`;
- `Store type`, defaulting to `All`;
- `Stores`, showing an all-store count and allowing selection.

The Jira tickets mention City and, for DM-89, omit Store type. The approved design wins: Period, Store type, and Stores are the P0 controls. City can remain a later enhancement or be represented through the Stores selector. The backend should still accept city/region dimensions if available so another UI revision does not require a data redesign.

All applicable metrics should receive the same filter object. The meaning depends on the fact:

- transaction metrics are filtered by the store on the earning/redemption order;
- reward liability is filtered by the reward's originating store for visit programs;
- point liability cannot currently be assigned to a store without lot-level earn-store attribution;
- enrolment and opt-out cannot currently honor store filters because those events have no outlet;
- merchant-level customer counts must use `uniq(account_id)` after filtering, not sum store-level counts.

The Overview Dashboard design contains stale contradictory copy: a `Last 90 days` selector and 90-day deltas are visible, while a banner says the data below reflects the last 365 days. The selector should be authoritative and the banner should be made dynamic or removed.

### 3.4 Availability legend

| Status | Meaning |
| --- | --- |
| Available | Can be derived reliably from current persisted facts for the unfiltered merchant/program case. |
| Partial | A derivation exists, but one or more required dimensions, event timestamps, history, or snapshots are missing. |
| Missing | A required source or a settled calculation definition does not exist. |

## 4. CRM Overview Dashboard component

The Figma design reduces each program type to exactly five metrics and adds `View detailed analytics`.

| Order | Visit-based component | Point-based component | Resolution |
| --- | --- | --- | --- |
| 1 | Total members enrolled | Total active members | Program-type-specific reach metric. |
| 2 | Avg. visits/member | Avg. visits/member | Use qualifying loyalty transactions and show the non-member comparison. |
| 3 | Program ROI | ARPU lift | Preserve the order shown in each approved design. |
| 4 | Redemption rate | Program ROI | Preserve the order shown in each approved design. |
| 5 | ARPU lift | Redemption rate | Preserve the order shown in each approved design. |

For visit programs, Jira proposed eight CRM tiles. Reward unlock rate and reward liability are not in the approved compact component; they remain on detailed analytics. For point programs, Jira says “Top 5” but lists six metrics; outstanding liability is excluded from the approved compact component and remains on detailed analytics.

### 4.1 Figma data/copy artifacts

The layout and visible metric names are authoritative, but the mock values and some hidden text layers are not internally consistent:

- the visit card shows 3,876 total program members while also saying 12,469 new members in the period;
- the point card shows 32,876 active members while its growth-chart scale/sample values are much lower;
- several secondary captions in point Earning/Expiry cards are copied from visit reward examples and do not describe the point metric above them;
- hidden legend layers duplicate `30-40% watch` and label `>40% healthy` for expiry, conflicting with the ticket thresholds;
- ROI example copy mixes `3.8x` with `₹1 spent → ₹2.8 back` in underlying layers.

Implement the metric contract and visible labels, not arithmetic inferred from the mock numbers. Replace the placeholder/copy-pasted captions with calculated numerator/denominator text.

## 5. Visit-based analytics: ticket versus approved design

| Feature/metric | DM-49 | Approved Figma | Resolution and remarks |
| --- | --- | --- | --- |
| CRM overview size | Eight tiles: members, enrolment, visits, ARPU, ROI, unlock rate, redemption, liability. | Five tiles: total members, visits, ROI, redemption, ARPU. | Implement the five design tiles. Detailed analytics retains the other health metrics. |
| Dedicated filters | Date, Store Type, City, Store. City and Store are multi-select. | Period, Store type, Stores. | Use the three visible design controls for P0. Keep city in the backend dimension model. |
| Total reach | “Total members enrolled”; ticket says date range does not apply. | `Total program members` has a selected range, current value, trend, enrolment rate, and growth chart. | Return lifetime-as-of-period-end plus period growth and rate. The period does not restrict the lifetime base, but it does determine the as-of snapshot and delta. |
| Member growth | Not a separate specified chart. | `Member growth - last 90 days` with `New enrolments`. | Required time series. Aggregate first enrolments by day/week according to range. |
| Enrolment rate | New enrolments / active customers. | Shown under total members with the same numerator/denominator wording. | Required; denominator is distinct completed-order customers in period. Store attribution is currently incomplete. |
| Avg visits/member | Transactions / active loyalty members. | Value, non-member comparison, and trend. | Required. Define loyalty numerator as distinct qualifying loyalty order IDs. |
| ARPU | Ticket calls it ARPU but formula is member AOV lift. | Label is `ARPU lift`; caption compares ₹12,400 vs ₹8,200 per member/non-member. | Follow design terminology and calculate actual ARPU: revenue / unique customers. Do not use AOV under an ARPU label. |
| Program ROI | Long frequency × basket lift formula divided by reward and communication cost; expression is syntactically incomplete. | `Program ROI`, shown as `3.8x`. | Required visually, but calculation is not implementation-ready. Product/Finance must settle incremental revenue, reward cost, and comm cost. |
| Avg time between visits | Latest visit date minus preceding visit date, eligible or ineligible. | Value in days plus non-member comparison and trend. | Required. Prefer average of consecutive completed-order gaps per customer; document whether ineligible visits count. Current visit facts use processing time. |
| Rewards unlocked | Count rewards generated in range. | `Members unlocked rewards`, a distinct-member count with `% of program members`. | Design changes grain from rewards to customers. Use distinct accounts; optionally return raw reward count as drill-down only. |
| Reward unlock rate | Customers reaching at least one milestone / active members. | Embedded as the subtitle percentage under members unlocked. | Required as a secondary value, not a separate tile. Denominator needs a settled “active member” definition. |
| Rewards redeemed | Count rewards with redeemed date in range. | `Customers redeemed rewards`, a distinct-customer count. | Design changes grain from rewards to customers. |
| Redemption rate | Rewards redeemed / rewards generated and existent in period. | Redeeming customers / members unlocked, shown as `48.3% of 1,042 unlocked`. | Use customer grain per design. The cohort/window denominator remains ambiguous and must be fixed before SQL is frozen. |
| Avg time to redemption | Average redeemed date minus unlock date. | Same metric, with trend. | Required. Use `redeemed_at - created_at` or `valid_from`; choose one and expose it in metric metadata. |
| Opt-out rate | Only present in Store Performance and P1 profile sections. | Dedicated Redemption Health tile: opt-outs / total enrolled members. | Required overall and per store in the table. Per-store attribution is missing today. |
| Stamp expiry rate | Expired / “active stamps in range”; thresholds red >40, yellow 20–40, green <20. | Caption explicitly shows `expired of issued`. | Use expired stamps / issued stamps for the same period, matching visible design. Ticket's “active” denominator is discarded. |
| Reward expiry rate | Expired / active rewards in range; thresholds red >30, yellow 15–30, green <15. | Caption explicitly shows `expired of unlocked`. | Use expired rewards / unlocked rewards for the same period. |
| Reward liability | Selling price of active unredeemed rewards. | ₹ outstanding reward value across all stores. | Required. Monetary valuation is only partial because reward value is unstructured and no normalized cost snapshot exists. |
| Store table dimensions | Store, City/Region, Store Type. | Same. | Required. Region and COCO/FOFO need an authoritative dimension source. |
| Store table measures | Active members, enrolment, opt-out, stamps, redemption, expiry, liability. | Exactly the same columns. | Required. Several store allocations need new event fields. |
| Store export | Not explicitly specified for the table. | `Export CSV`. | Required direct export of the filtered store aggregation, separate from detailed earn/burn reports. |
| Health legends | Explicit thresholds in ticket. | Design metadata contains duplicated/mislabeled legend text, including “>40% healthy” for expiry. | Use ticket thresholds until design copy is corrected. Do not implement the malformed hidden legend text. |
| Paused/deleted/role state | Paused: show bounded history and nudge. Deleted/no CRM role: hide CRM section. | Approved frame shows live state; Jira attachment is a paused configuration screen, not an analytics specification. | Use Jira state behavior; add analytics-specific empty/paused states during implementation. |

## 6. Point-based analytics: ticket versus approved design

| Feature/metric | DM-89 | Approved Figma | Resolution and remarks |
| --- | --- | --- | --- |
| CRM overview size | Says top five but lists six, including liability. | Five tiles: active members, visits, ARPU, ROI, redemption. | Implement the five design tiles; liability remains in detailed analytics. |
| Dedicated filters | Date, City, Store; explicitly removes COCO/FOFO. | Period, Store type, Stores. | Design wins: include Store type, omit standalone City in P0. This requires a valid store-type dimension. |
| Top reach value | Total enrolled and active members are separate ticket metrics. | `Total active members` is the main value; `Lifetime enrolled` is a subtitle. | Return both in one reach card. Active members is period-bound; lifetime enrolled is an as-of snapshot. |
| Member growth | New enrolments is a ticket metric. | Growth chart and `New enrolments` series. | Required. |
| Enrolment rate | New enrolments / unique customers. | Shown under active members. | Required. Store attribution is incomplete. |
| Opt-out rate | Program Reach metric. | Not a top reach card; present in Store Performance. | Keep it in the store table. If an overall value is required, it can be returned but is not a visible P0 tile. |
| Avg visits/member | Qualifying transactions / active members. | Value, non-member comparison, and trend. | Required. |
| Avg time between visits | Average D2-D1. | Value, non-member comparison, and trend. | Required. Join earn ledger order IDs to original order times; ledger `created_at` is processing time. |
| ARPU lift | Ticket formula uses AOV. | Label/caption indicate per-member revenue comparison. | Calculate actual ARPU lift to match design terminology. |
| Program ROI | Two inconsistent Jira formulas: `Revenue/(point value burn + WA comms)` and a visit/basket lift formula. | `Program ROI`, shown as a multiplier. | Required visually but calculation is missing. Settle one Finance-owned formula. |
| Total points issued | Sum of points earned. | Same tile. | Required. Decide whether welcome bonuses are included; this affects all point-rate denominators. |
| Avg points/customer | Issued points / transacting customers. | Same tile. | Required. Use distinct accounts with qualifying earn transactions. |
| Transactions with multiplier | Multiplier >1 transactions / earning transactions. | Same tile. | Required and directly supported by ledger `rules.multiplierVal`. |
| Multiplier rule breakdown | Bar chart of issued points by active rule. | Replaced by `Points issued with multiplier(s)`. Design also includes separate states: no rule, one active rule, and multiple-rule detail rows. | Implement the design KPI and expandable breakdown states, not a full bar chart. |
| Total points redeemed | Sum redeemed. | Same tile. | Required; exclude or offset reversed burns. |
| INR value redeemed | Sum redemption value. | Same tile. | Required; use event-time redemption value, not today's rate. |
| Redemption rate | Points redeemed / points issued. | Same, with numerator/denominator caption. | Required. Settle gross versus net-of-reversal and period/cohort semantics. |
| Avg INR/redemption | INR value / redemption transactions. | Same. | Required. |
| Avg time to first redemption | First redemption minus enrolment. | Same. | Required. Historical re-enrolment cycles are not fully stored. |
| Redemption frequency | Redemptions/member/month. | `Avg redemptions per member per month`. | Required. Define denominator as members with at least one redemption or all active members; ticket does not say. |
| Point expiry rate | Expired / issued. | Same with `expired of issued` caption. | Required. Use actual expire ledger entries and explicit treatment of reversed credits. |
| Expiring in seven days | Members whose balance expires within seven days. | Same. | Required. For rolling expiry, inspect remaining FIFO lots, not only counter balance. |
| Outstanding liability | Balance × redemption rate. | Same ₹ tile. | Required overall. Per-store allocation is not currently available. |
| Store dimensions | Store and City/Region; ticket explicitly removes Store Type. | Store and City/Region; no Store Type column, despite Store type being a filter. | Table follows design and ticket; filter still needs a dimension. |
| Store measures | Active, enrolment, opt-out, visits, issued, redemption, expiry, liability. | Exactly those columns. | Required. Enrollment, opt-out, and liability attribution are currently missing. |
| Store export | Not explicitly specified. | `Export CSV`. | Required direct export of the filtered store aggregate. |
| Reports names | `points_earn_report.csv`, `points_burn_report.csv`. | Generic `Loyalty earn report` and `Loyalty burn report`; no program-type selector. | Keep the two visible names. Resolve the logical program/type in the request contract; mixed historical program types need a product decision. |
| State handling | Explicit live, paused, deleted, not enrolled, opted out, no CRM role behavior. | Approved frame shows live state only. | Use Jira state behavior and add designed empty/paused/error states before implementation. |

## 7. Visit-based metric inventory and data readiness

Required metrics below follow the approved design. Overview-component metrics reuse the same canonical definitions as detailed analytics.

| Metric | Canonical calculation | Current sources | Availability | Calculation status / remarks |
| --- | --- | --- | --- | --- |
| Total program members | Distinct accounts first enrolled on or before `to`; show change versus prior period end. | `program_enrollments`, `program_key`, `account_id`, `created_at`. | Partial | Overall lifetime is available. Historical membership intervals and store attribution are not. |
| Active members | Distinct enrolled accounts with at least one selected qualifying loyalty order in period. | Eligible `user_visits`/`user_collectibles`. | Available | Needed as a denominator even though not a standalone visit tile. Product must confirm eligible-only versus all enrolled visitors. |
| New enrolments | Distinct accounts whose first enrollment `created_at` is in period. | `program_enrollments.created_at`. | Partial | First enrollment is available; repeated enrollment cycles and enrollment store are not. |
| Member growth series | New enrolments bucketed by day/week, plus cumulative members as of each bucket end. | `program_enrollments`. | Partial | Store-filtered series is unavailable. |
| Enrolment rate | New enrolments / distinct completed-order customers in the same filters × 100. | Enrollment + `crm.merchant_orders`. | Partial | Formula is known. Member store/event attribution and historical classification are incomplete. |
| Avg visits/member | Distinct qualifying loyalty orders / active members. | Eligible `user_visits` or `user_collectibles`. | Available | Use `order_id` deduplication. Ticket's generic “transactions” must not count ineligible attempts unless explicitly chosen. |
| Non-member visits/customer | Completed orders by customers not enrolled as of order time / distinct such customers. | `crm.merchant_orders` + enrollment history. | Partial | Full enrollment state history is missing. |
| ARPU lift | `(member revenue/member customers - non-member revenue/non-member customers) / non-member ARPU × 100`. | `crm.merchant_orders`, loyalty identity. | Partial | This is a design-led correction of the Jira AOV formula. Historical member status is incomplete. |
| Program ROI | Incremental attributable revenue / total program cost, displayed as `x`. | Orders, rewards, communications. | Missing | Neither source defines a complete formula; reward and communication cost facts are missing. |
| Avg time between visits | Average consecutive completed-order gaps per customer; return member and non-member values. | `user_visits` and/or `crm.merchant_orders`. | Partial | `user_visits.created_at` is processing time. Prefer original order time from ClickHouse; settle whether ineligible attempts count. |
| Members unlocked rewards | Distinct accounts with `user_rewards.created_at` in period. | `user_rewards`. | Available | Design uses customer grain, not reward-row count. |
| Reward unlock rate | Members unlocking at least one reward / active members × 100. | Rewards + active-member set. | Available | Denominator definition must be frozen. |
| Customers redeemed rewards | Distinct accounts with `redeemed_at` in period and status consistent with consumed. | `user_rewards`. | Available | Exclude administrative/cancelled states. |
| Redemption rate | Distinct redeeming customers / distinct unlocked/available-reward customers × 100. | `user_rewards`. | Partial | Design establishes customer grain but not whether denominator is unlock cohort, period unlocks, or rewards available during period. |
| Avg time to redemption | Average `redeemed_at - reward_unlock_at` for redeemed rewards. | `user_rewards.created_at`, `valid_from`, `redeemed_at`. | Available | Decide whether unlock starts at creation or `valid_from`. |
| Opt-out rate | Distinct opt-outs in period / total enrolled members as of period end × 100. | `program_enrollments.last_cancelled_at`, status. | Partial | Only the latest cancellation is retained; no store is captured. |
| Stamp expiry rate | Collectibles with expiry in period and expired status / collectibles issued in period × 100. | `user_collectibles`. | Partial | Current status and `expires_at` exist; there is no immutable expiry-status event history. |
| Reward expiry rate | Rewards expiring in period with expired status / rewards unlocked in period × 100. | `user_rewards`. | Partial | Same-period flow ratio follows design; a cohort rate would require a different denominator. |
| Reward liability | Sum normalized monetary obligation for active, unexpired rewards as of `to`. | `user_rewards`, milestone reward JSON, Marketing loyalty deal/coupon rows. | Partial | Counts are available; selling price/merchant cost is not normalized or snapshotted. |
| Store active members | Distinct accounts with qualifying visit at store. | `user_visits.client_outlet_id`. | Available | Merchant total must deduplicate across stores. |
| Store enrolment rate | New enrollments attributed to store / unique store customers × 100. | Enrollment + orders. | Missing | Enrollment has no outlet. Do not silently attribute to first later visit without product approval. |
| Store opt-out rate | Store-attributed opt-outs / store members × 100. | Enrollment. | Missing | Opt-out has no outlet. |
| Store stamps issued | Count collectibles created at store in period. | `user_collectibles.client_outlet_id`. | Available | Use event program version and order source. |
| Store redemption rate | Store-attributed redeemed customers / unlocked customers × 100. | Rewards + redemption orders. | Partial | Redemption store comes from the redemption order join; denominator attribution needs a settled rule. |
| Store stamp expiry rate | Expired stamps originating at store / issued stamps originating at store × 100. | Collectibles. | Partial | Status-event history limitation applies. |
| Store liability | Value of active rewards originating at store. | Reward -> linked collectible -> store. | Partial | Origin is available; monetary valuation is not. |
| Store/City/Region/Type | Outlet dimension at event time. | `client_outlet_id`, Reports/Aggregator store data. | Partial | City may be available; region and COCO/FOFO require an authoritative dimension and slowly-changing history. |

Ticket-only visit metrics not present in the approved P0 screens should not be added to the compact component: raw rewards-unlocked count, raw rewards-redeemed count, and a standalone unlock-rate tile. They can be retained in API drill-down fields if inexpensive.

## 8. Point-based metric inventory and data readiness

| Metric | Canonical calculation | Current sources | Availability | Calculation status / remarks |
| --- | --- | --- | --- | --- |
| Total active members | Distinct accounts with a qualifying `earn` transaction in period. | `user_point_ledger(type=earn)`. | Available | Store filtering requires an order join because ledger rows have no outlet. |
| Lifetime enrolled | Distinct first-enrolled accounts as of `to`. | `program_enrollments`. | Partial | Overall is available; historical intervals/store attribution are not. |
| New enrolments | First enrollments in period. | `program_enrollments.created_at`. | Partial | Same limitations as visit. |
| Member growth series | New enrollments by bucket and cumulative lifetime enrollment. | `program_enrollments`. | Partial | Same limitations as visit. |
| Enrolment rate | New enrollments / unique completed-order customers × 100. | Enrollment + ClickHouse orders. | Partial | Formula is known; store attribution/history gaps remain. |
| Avg visits/member | Distinct point-earning order IDs / active members. | Earn ledger. | Available | Welcome bonuses must not count as visits. |
| Non-member visits/customer | Completed non-member orders / distinct non-member customers. | ClickHouse + enrollment history. | Partial | Membership intervals are missing. |
| Avg time between visits | Average consecutive earning-order gaps per member; compare non-members. | Earn order IDs joined to `crm.merchant_orders.order_time`. | Partial | Ledger creation time is not the business event time. |
| ARPU lift | True member ARPU lift relative to non-members. | ClickHouse orders + loyalty membership. | Partial | Same historical-classification gap. |
| Program ROI | Incremental attributable revenue / point redemption cost + communication/program costs. | Orders, point ledger, comm delivery/cost. | Missing | Jira contains inconsistent/incomplete formulas. |
| Total points issued | Sum positive credited points selected by the agreed scope. | Earn and welcome-bonus ledger rows. | Available | Jira implies transaction earn only; business must decide whether welcome bonus is included. Return components separately. |
| Avg points earned/customer | Transaction-earned points / distinct earning accounts. | Earn ledger. | Available | Exclude welcome bonuses unless the numerator is explicitly “all issued points.” |
| Transactions with multiplier | Earn rows where `rules.multiplierVal > 1` / all earn rows × 100. | `user_point_ledger.rules`. | Available | Directly auditable. |
| Points issued with multipliers | Sum earn-row amounts for multiplier transactions; return share of transaction-earned points. | Earn ledger + rules JSON. | Available | Ledger amount includes milestone bonus; decide whether tile means all points on such transactions or only multiplier-attributable increment. |
| Multiplier rule detail | Points and transaction count grouped by applied rule ID/name/version. | `rules.ruleIds`, `point_multiplier_rules`. | Available | Multiple-rule allocation can double count if one transaction lists more than one rule. Define attribution to winning rule or allocate explicitly. |
| Total points redeemed | Sum absolute settled burn amounts, net of reversed burns according to reporting policy. | Burn/reverse-burn ledger. | Available | Do not count block/unblock internal legs as redemption. |
| INR value redeemed | Sum effective redeemed points × event-time `redemption_value`. | Burn ledger + burn `program_id` config. | Available | Use event version, not today's rate. |
| Redemption rate | Redeemed points / issued points × 100. | Point ledger. | Available | Gross/net reversal and period/cohort semantics still need a decision. |
| Avg INR/redemption | INR redeemed / distinct settled burn transactions. | Burn ledger. | Available | Exclude review/unblock/reversed settlements per policy. |
| Avg time to first redemption | First settled burn time minus enrollment-cycle start. | Burn ledger + enrollment. | Partial | Multiple enrollment cycles are not preserved. |
| Avg redemptions/member/month | Settled burn count normalized by months and chosen member denominator. | Burn ledger. | Partial | Ticket does not define whether denominator is redeemers or all active members. |
| Point expiry rate | Expired points / issued points × 100. | Expire and earn/bonus ledger rows. | Available | Define period-flow versus cohort calculation and reversal treatment. |
| Members with points expiring in seven days | Distinct accounts with positive remaining expiring lots in `[as_of, as_of+7d]`, or activity expiry in that window. | Ledger, allocations, counter, expiry config. | Available | Rolling and activity-based models require different queries. Counter alone is insufficient for rolling. |
| Outstanding liability | Reconciled active balance × current/effective redemption value as of snapshot. | Ledger/allocations, counter, point config. | Available | Use ledger reconciliation when the counter has drift. Per-store allocation is missing. |
| Store active members | Distinct earn accounts whose order maps to store. | Earn ledger + ClickHouse order. | Partial | Ledger itself has no store/source. |
| Store enrolment rate | Store-attributed first enrollments / store customers. | Enrollment + orders. | Missing | Enrollment event has no store. |
| Store opt-out rate | Store-attributed opt-outs / store members. | Enrollment. | Missing | Opt-out event has no store. |
| Store avg visits/member | Store earn order count / distinct earning members. | Earn ledger + order join. | Partial | Requires complete order ingestion. |
| Store points issued | Earn amount grouped by earn-order store. | Earn ledger + order join. | Partial | Welcome bonus has no store and should be separated. |
| Store redemption rate | Redeemed points at store / issued points attributed to store × 100. | Burn + earn ledgers joined to orders. | Partial | Burn has order ID; block does not. Provider-managed burns may not be in the V2 ledger. |
| Store expiry rate | Expired points attributed back to originating earn lots/store / issued points at store. | Expire allocations -> earn lots -> earn orders. | Partial | Technically derivable only with complete allocation lineage and order joins. |
| Store liability | Remaining earn-lot points attributed to earn store × rate. | Ledger allocations + earn order store. | Partial | Current screen's simple balance model needs this lot-level allocation for store filters. |
| Store/City/Region/Type filter | Outlet dimension at event time. | Order branch/store IDs + external store dimension. | Partial | Region and COCO/FOFO are not established shared dimensions. |

## 9. Loyalty report inventory, exact columns, and derivation

### 9.1 Report request and delivery flow

The approved Reports flow is shared by both program types:

1. Open Reports and select the `Loyalty` category.
2. Select `Loyalty earn report` or `Loyalty burn report`.
3. Select a date range. The design says data is available through yesterday.
4. Submit `Download`; this creates an asynchronous request.
5. The Loyalty tab lists report name, date range, request timestamp, status, and download action with pagination.

The current `panel-dashboard` already posts asynchronous requests to `api/batch/downloadRequest` and polls the request list. Loyalty should extend this contract rather than generate large CSVs synchronously.

The Figma flow has no program selector. The request must still carry a resolved `program_key` and `program_type`. For merchants with more than one historical loyalty program or a date range spanning program types, product must choose one of:

- show a Program selector only when ambiguity exists;
- infer the current program and explicitly exclude older programs;
- produce separate files per logical program in one archive.

Silently mixing visit and point schemas is not acceptable.

### 9.2 Visit loyalty earn report

Use one row per earned collectible/stamp. The reconciled schema includes all columns from the ticket's declared list and its example table.

| Column | Derivation | Availability / notes |
| --- | --- | --- |
| `stamp_id` | `user_collectibles.id`. | Available. |
| `reward_id` | `user_collectibles.reward_id`; null when this stamp did not unlock a milestone. | Available. |
| `customer_id` | `account_id`; expose the approved external format if one exists. | Available. |
| `customer_name` | Latest reliable CRM/order name for the account/phone. | Partial; enrollment currently creates accounts with phone only. |
| `customer_phone` | `user_accounts.phone`, masked according to export permissions. | Available. |
| `store_name` | Store dimension joined from `client_outlet_id` and source. | Partial. |
| `store_id` | `user_collectibles.client_outlet_id`. | Available, but it may be DotPe store ID or Rista branch code. Include source-aware normalization. |
| `city` | Store dimension as of transaction. | Partial. |
| `region` | Store dimension as of transaction. | Missing authoritative source. |
| `store_type` | COCO/FOFO store dimension as of transaction. | Missing authoritative source. |
| `earned_date` | Business order timestamp converted to report timezone. | Partial; collectible stores processing time, so join order time. |
| `earned_time` | Same timestamp, `HH:MM:SS`; present in Jira example but absent from its initial list. | Partial. |
| `txn_id` | `user_collectibles.order_id`. | Available. |
| `order_value` | Matching `user_visits.order_amount`; reconcile against Marketing order amount. | Available in visit fact. |
| `channel` | Normalized collectible `source`: POS / QR(DotPe) / SOK / Aggregator as approved naming. | Available. |
| `stamp_count_after` | Active/cumulative stamp count immediately after this earn. | Partial; no immutable historical counter snapshot. A simple row number is not equivalent after expiry/opt-out. |
| `expiry_date` | `user_collectibles.expires_at` as initially/effectively assigned. | Partial; rolling expiry refresh mutates older rows, so this is current/final expiry, not necessarily expiry at earn time. |
| `threshold_stamp_count` | Linked milestone `collectibles_required`; null if no reward unlocked. | Available. |
| `reward_type` | Linked milestone `reward_type`. | Available. |
| `reward_value` | Normalized milestone reward snapshot: item name, flat amount, or percentage. | Partial; current reward JSON is not a normalized value contract. |

### 9.3 Visit loyalty burn report

Use one row per consumed reward.

| Column | Derivation | Availability / notes |
| --- | --- | --- |
| `reward_id` | `user_rewards.id`. | Available. Jira incorrectly describes it as a stamp identifier. |
| `customer_id` | `user_rewards.account_id`. | Available. |
| `customer_name` | CRM/order-derived customer name. | Partial. |
| `customer_phone` | `user_accounts.phone`, permission-masked. | Available. |
| `store_name` | Store on `redeemed_order_id`. | Partial; requires Marketing order/store join. |
| `store_id` | Redemption order branch/store ID. | Partial; not stored on `user_rewards`. |
| `city` | Redemption-store dimension. | Partial. |
| `region` | Redemption-store dimension. | Missing authoritative source. |
| `store_type` | Redemption-store COCO/FOFO. | Missing authoritative source. |
| `txn_id` | `user_rewards.redeemed_order_id`. | Available. |
| `order_value` | Marketing order amount for redeemed order. | Partial. |
| `channel` | Redemption order source normalized to product labels. | Partial; reward row does not persist burn source. |
| `redeemed_date` | `user_rewards.redeemed_at` in report timezone. | Available. |
| `redeemed_time` | `user_rewards.redeemed_at`, `HH:MM:SS`. | Available. |
| `reward_value` | Normalized reward discount/item value from milestone snapshot. | Partial. |

Recommended addition: `reward_type`. Without it, `reward_value` cannot be interpreted consistently. This is not in DM-49's burn list and requires product approval.

### 9.4 Point loyalty earn report

Use one row per transaction `earn` ledger entry. Welcome bonus rows are not transaction earns and should not appear in this file unless a separate event type is added.

| Column | Derivation | Availability / notes |
| --- | --- | --- |
| `transaction_id` | Earn ledger `order_id`. | Available. |
| `customer_id` | Ledger `account_id`. | Available. |
| `customer_name` | Matching order/CRM customer name. | Partial. |
| `customer_phone` | `user_accounts.phone`, masked. | Available. |
| `store_id` | Matching Marketing order branch/store ID. | Partial; not stored in ledger. |
| `store_name` | Store dimension. | Partial. |
| `city` | Store dimension. | Partial. |
| `region` | Store dimension. | Missing authoritative source. |
| `transaction_date` | Original order timestamp in report timezone. | Partial; join Marketing order. |
| `transaction_time` | Original order timestamp, `HH:MM:SS`. | Partial. |
| `channel` | Original order source normalized to POS / QR / DotPe. | Partial; not stored in ledger. |
| `order_value` | Full order value from the canonical Marketing order fact. | Partial; confirm which amount field is product-authoritative. |
| `eligible_order_value` | Post-exclusion point earn basis used by calculation. | Missing as a persisted snapshot; recomputation from current ClickHouse items is not guaranteed exact. |
| `points_earned_total` | Earn ledger positive `amount`. | Available. |
| `multiplier_applied` | `Y` when `rules.multiplierVal > 1`, else `N`. | Available. |
| `effective_multiplier` | `rules.multiplierVal`, default `1x`. | Available. |
| `flat_bonus_points` | `rules.milestoneBonus`, default `0`. | Available. |
| `points_balance_after` | Running ledger balance immediately after the earn event. | Partial; reconstructable by ledger ID, but no immutable snapshot and counter drift/concurrency must be handled. |

### 9.5 Point loyalty burn report

Use one row per successfully settled burn. Exclude review and unblock rows. A reversed burn should either be excluded or appear with an explicit reversal policy; do not report it as a normal redeemed transaction.

| Column | Derivation | Availability / notes |
| --- | --- | --- |
| `transaction_id` | Burn ledger `order_id`. | Available for normal POS settlement. |
| `customer_id` | Burn ledger `account_id`. | Available. |
| `customer_name` | Matching order/CRM name. | Partial. |
| `customer_phone` | `user_accounts.phone`, masked. | Available. |
| `store_id` | Matching redemption order's branch/store. | Partial. |
| `store_name` | Store dimension. | Partial. |
| `city` | Store dimension. | Partial. |
| `region` | Store dimension. | Missing authoritative source. |
| `store_type` | COCO/FOFO store dimension. | Missing authoritative source; DM-89 includes it in report despite removing it from the analytics table. |
| `redemption_date` | Original redemption order time, falling back to burn creation time only when explicitly marked. | Partial. |
| `redemption_time` | Same timestamp, `HH:MM:SS`. | Partial. |
| `channel` | Redemption order source. | Partial. |
| `order_value` | Full redemption order value. | Partial. |
| `eligible_order_value` | Burn-eligible value after exclusions. | Missing as an immutable snapshot. |
| `points_redeemed` | Absolute burn ledger amount. | Available. |
| `redemption_inr_value` | Points redeemed × event-time redemption value. | Available via burn `program_id` config. |
| `redemption_rate_at_txn` | `point_program_config.redemption_value` for burn `program_id`. | Available. |
| `burn_limit_applied` | Actual cap that constrained this redemption, in ₹ as ticketed. | Missing; configured cap exists, but applied constraint/reduction is not persisted. |
| `points_balance_before` | Reconstructed balance immediately before the original block. | Partial; block is linked but has no order ID and balance snapshots are absent. |
| `points_balance_after` | Balance after reservation/settlement. | Partial; reconstructable from ordered ledger legs, not directly stored. |

### 9.6 Store-performance CSV exports

The `Export CSV` buttons on both dedicated analytics pages are separate from the detailed reports. They should export exactly the visible filtered table columns:

- visit: Store, City/Region, Store Type, Active Members, Enrolment Rate, Opt-out Rate, Stamps Issued, Redemption %, Stamp Expiry %, Liability (₹);
- point: Store, City/Region, Active Members, Enrolment Rate, Opt-out Rate, Avg Visits/Member, Points Issued, Redemption %, Expiry %, Liability (₹).

The export should reuse the same query result/calculation version as the screen, not independently reimplement formulas.

## 10. State, visibility, and empty-data behavior

| State | Required behavior |
| --- | --- |
| Live program | Show all permitted analytics and reports. |
| Paused program | Show data only through pause time and a resume nudge. Preserve historical filters up to that boundary. |
| Expired/deleted program | Jira says hide CRM analytics. Historical report access needs an explicit retention decision; deleting the read model would be incorrect. |
| No program yet / draft only | Hide detailed analytics or show a zero state explaining that analytics begins after publish. Drafts exist only in Redis and have no facts. |
| No data in selected period | Show zero/empty cards and an empty store table, not an error. Lifetime-as-of metrics may still be non-zero. |
| Customer not enrolled | P1 Customer 360 fields show `—`; irrelevant to aggregate analytics. |
| Customer opted out | Aggregate historical facts remain; P1 history stops/flags at opt-out according to Jira. |
| Merchant lacks CRM feature role | Jira says hide CRM Overview tiles and loyalty analytics page. Backend must enforce authorization as well as UI hiding. |
| Partial ingestion/reconciliation failure | Do not silently show complete-looking data. Expose freshness and reconciliation status internally, with alerting. |

## 11. Recommended analytics data model and flow

### 11.1 Ownership

- Loyalty remains the source of truth for enrollment, visit, reward, point-ledger, expiry, and settlement events.
- Marketing owns the existing ClickHouse order/customer analytics data and the CRM Overview surface.
- Build the loyalty analytics read model in ClickHouse, populated from immutable Loyalty event facts and enriched with Marketing order/store/customer dimensions.
- The async report worker should query the same read model and calculation definitions as the APIs.

### 11.2 Required immutable facts

At minimum, capture these event families:

- enrollment, re-enrollment, opt-out, suspension, with `event_at`, `account_id`, `program_key`, `program_id`, source, and outlet when known;
- visit attempt and collectible issued, with original order time, amounts, eligibility result, outlet, source, counter-after snapshot, and expiry-at-issuance;
- reward unlocked, redeemed, expired, cancelled, with originating and redemption outlets plus normalized monetary value/cost snapshot;
- point earn, bonus, block, burn, unblock, review, reversal, and expiry, with business event time, outlet/source, full and eligible order values, rules, balance before/after, redemption value, applied limits, and source ledger IDs;
- communication dispatch and actual cost, keyed to program/account/event;
- store dimension snapshots containing name, city, region, and COCO/FOFO with valid-from/to timestamps.

### 11.3 Suggested analytics fact columns

An immutable `loyalty_event_fact` should include, where applicable:

`event_id`, `event_type`, `event_at`, `ingested_at`, `merchant_id`, `group_id`, `program_key`, `program_id`, `program_type`, `account_id`, privacy-safe customer key, `order_id`, `store_id`, `store_source`, `channel`, `order_value`, `eligible_value`, `collectible_id`, `reward_id`, `point_ledger_id`, `points_delta`, `points_earned`, `points_redeemed`, `redemption_value`, `reward_value`, `balance_before`, `balance_after`, `expires_at`, `rule_ids`, `effective_multiplier`, `milestone_bonus`, and `status_reason`.

Use a separate slowly changing store dimension rather than copying mutable store names/geography into every query path.

### 11.4 Aggregate tables

For efficient dashboards and reports:

- daily merchant/program/store aggregates for enrollments, active customers, orders, stamps, reward events, point flows, revenue, and liability deltas;
- customer-day or customer-month facts for visit frequency, inter-visit gaps, first redemption, and member/non-member comparisons;
- snapshot tables for liability and expiring balances;
- materialized views only after formulas and reversal semantics are frozen.

Do not derive merchant totals by summing store-level distinct-member counts.

### 11.5 API shape

Use one shared filter contract and program-type-specific payload sections. A response should carry:

- applied filters and merchant timezone;
- data-as-of/freshness timestamp;
- current and comparison values;
- numerator and denominator for every percentage;
- formula/calculation version;
- time-series points;
- paginated/sortable store rows;
- reconciliation warnings for internal observability.

The Overview endpoint should reuse the same metric service, requesting only the five design metrics. The store CSV endpoint should export the same calculated result rather than use separate SQL.

## 12. Decisions required before implementation

These are specification blockers, not implementation details:

1. **ROI:** settle one formula, attribution window, incremental-revenue model, reward cost basis, and communication cost source.
2. **ARPU versus AOV:** this document chooses actual ARPU because the approved design says ARPU and shows per-member ₹ values. Confirm explicitly.
3. **Visit active member:** decide whether any enrolled visitor, any completed order, any post-preflight attempt, or only stamp-earning visits qualifies.
4. **Visit redemption denominator:** choose period unlocks, unlock cohort, or customers with a reward available at any time in period.
5. **Point issued scope:** decide whether welcome bonuses are included in Total Points Issued and liability/rate denominators.
6. **Reversals/refunds:** define gross versus net points issued/redeemed and how reversed or cancelled orders appear.
7. **Redemption frequency denominator:** all active members or only redeemers.
8. **Liability valuation:** selling price, face discount, expected merchant cost, or another Finance-defined value for visit rewards; current versus event-time rate for points.
9. **Store attribution:** capture outlet on enroll/opt-out and define origin versus redemption store for reward metrics.
10. **Store dimensions:** identify authoritative City, Region, and COCO/FOFO sources and history.
11. **Report program selection:** resolve current versus historical/multiple logical programs without adding an always-visible selector that conflicts with Figma.
12. **Event time:** add original order/event timestamps to Loyalty facts; do not use processing timestamps for business analytics.
13. **Threshold copy:** correct the malformed hidden Figma legends; until then use Jira's explicit health thresholds.
14. **Overview time copy:** remove the fixed 365-day statement or bind it to the selected period.

## 13. Delivery order and validation

Recommended sequence:

1. Freeze metric definitions and the decisions in section 12.
2. Add immutable event capture and missing dimensions/snapshots.
3. Backfill from current Loyalty MySQL and Marketing ClickHouse, tagging partial/backfilled fields.
4. Reconcile event facts against source tables before exposing UI.
5. Build daily/customer aggregates and program-type analytics APIs.
6. Implement the five-metric Overview component and detailed tabs from the same metric service.
7. Extend the existing async Reports flow and generate all four logical datasets behind the two visible earn/burn choices.
8. Add store-table export using the dashboard calculation result.

Minimum reconciliation tests:

- point ledger-derived balance versus counters and liability snapshots;
- point issue/burn/expiry/reversal totals balance by program and day;
- visit collectible/reward facts versus visit counters;
- reward unlock, consume, and expiry status transitions;
- completed Loyalty-linked orders versus Marketing ClickHouse order IDs;
- store and merchant distinct-member rollups;
- comparison-period boundary and timezone tests;
- program-version joins across edits;
- paused-program cutoff behavior;
- report totals matching dashboard numerators for identical filters;
- sampled CSV rows traced end to end to the source order and loyalty event.

## 14. Final conclusions

- The approved designs cover both visit and point loyalty and are materially more focused than the Jira tickets.
- The compact Overview component is exactly five metrics per program type.
- The dedicated visit design is customer-grain for unlock/redemption health, while the ticket often uses reward-row grain; the design must win.
- The point design replaces the ticket's multiplier bar chart with a points-issued-with-multipliers KPI plus single/multiple/no-rule states.
- Period, Store type, and Stores are the approved dedicated filters for both types, even though DM-89 removes Store type.
- Four logical detailed datasets are required: visit earn, visit burn, point earn, point burn. The UI exposes two generic choices and therefore needs an implicit or conditional program resolution rule.
- Core loyalty counts are derivable today, but store-filtered enrollment/opt-out, reliable historical membership, exact point report financial snapshots, normalized liability, ROI, and several store dimensions require new capture.
- A shared immutable ClickHouse read model is the efficient and auditable path for both dashboards and reports.
