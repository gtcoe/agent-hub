# Marketing RFM Feature Memory

Use this as quick context before changing Marketing CRM/RFM code. Full reference:
`.agent-hub/feature-docs/marketing/rfm-flow-analysis.md`.

## Core Flow

Marketing RFM is ClickHouse-first:

1. POS orders enter `crm.merchant_orders`.
2. Orders are aggregated into the active daily-order table.
3. RFM scoring writes customer-level rows to `crm.rfm_customers`.
4. Cohort aggregation writes dashboard rows to `crm.rfm_cohort_aggregations`.
5. Customer profile sync upserts MySQL `customer_profiles`.
6. Movement detection compares latest two RFM dates and writes `crm.customer_movement_history`.
7. `crm.movement_summary` materialized view powers movement dashboard reads.

Main orchestrator:

- `marketing/business/crm/ingestion/etl_service.go`
- `DataIngestionService.ProcessCRMAnalysis`
- Order: `ProcessRFMAnalysis` -> `ProcessCohortAggregations` -> `IngestCustomerProfilesFromOrders` -> `ProcessCustomerMovements`

## Entry Points

- Onboarding: `POST /admin/crm/onboard` -> `CRMUseCase.runFullRFMAnalysisAndCreateSegments` -> `DataIngestionService.FullETLPipeline`.
- On-demand smart segment refresh: `segmentUC.runOnDemandRFM`, guarded by `ondemand:lock:rfm_analysis_<merchantID>`.
- Daily cron: only rebuilds daily order aggregates for rolling two-day window. Do not assume it reruns RFM for all merchants.

## Write Tables

ClickHouse:

- `crm.merchant_orders`: raw completed POS orders from Kafka and Snowflake backfill.
- `crm.merchant_order_items`: item rows from Kafka/Snowflake.
- Active daily-order table: code constant `utils.CRMDailyOrdersLiveTable`.
- `crm.rfm_customers`: customer RFM metrics, scores, cohort, evaluation date.
- `crm.rfm_cohort_aggregations`: cohort counts, revenue, distribution, AOV, visit frequency.
- `crm.customer_movement_history`: cohort transition records.
- `crm.movement_summary`: materialized view over movement history.

MySQL:

- `crm_merchants`: active CRM merchant/source config.
- `customer_profiles`: customer list/profile lookup data from daily orders.
- `segment`: default smart RFM segment metadata and counts.
- `segment_customers`: not populated for default RFM smart segments; those contacts are fetched dynamically.
- `exclusion_list`: RFM exclusion flags.

## RFM Scoring

Source: active daily-order table, grouped by `merchant_id, phone`.

Filters:

- `merchant_id`
- `order_date >= subtractDays(today(), timeWindowDays)`
- excludes test phones matching `^(6{10}|7{10}|8{10}|9{10})$`
- excludes MySQL `exclusion_list` phones with `entity.ExcludeRFM`

Metrics:

- recency: days since max order date
- frequency: sum order count
- monetary: sum order value

Scores are percentile buckets `1..5` within merchant/window. Cohorts:

- Champions
- Loyal Customers
- Cannot Lose Them
- Potential Loyalists
- At Risk
- Promising Customers
- New Customers
- Need Attention
- About to Sleep
- Hibernating

Current implementation is merchant-wide. It does not produce branch-scoped persisted RFM rows.

## Movement Analysis

Runs after RFM and aggregation.

1. Reads latest two `evaluation_date` values from `crm.rfm_customers`.
2. Loads all RFM customers for both dates.
3. For phones present in both dates, records only cohort changes.
4. New customers and lost customers are not recorded as movement rows.

Cohort rank for movement:

1. Hibernating
2. About to Sleep
3. At Risk
4. Cannot Lose Them
5. Need Attention
6. New Customers
7. Promising Customers
8. Potential Loyalists
9. Loyal Customers
10. Champions

Higher rank means `Up`; lower rank means `Down`. Impact level is rank jump: 1 low, 2 medium, otherwise high.

## Read Paths

- `GET /crm/dashboard/segment/distribution`: reads latest `crm.rfm_cohort_aggregations`, merges MySQL default segment IDs.
- `GET /crm/dashboard/movement/summary`: reads latest `crm.movement_summary`.
- `GET /crm/dashboard/metrics`: reads daily-order metrics plus movement upgrades.
- `GET /crm/customer/list`: reads MySQL `customer_profiles`, then enriches page phones from latest `crm.rfm_customers`.
- Default smart segment contacts: dynamically read latest `crm.rfm_customers` by cohort and re-check `exclusion_list`.

## Caveats

- `utils.RFMAnalysisDays = 90`; backfill uses `utils.CrmBackfillDays = 365`.
- `rfm_customers` and `customer_movement_history` have 90-day TTL in prod; daily orders have 365-day TTL.
- Code currently points `utils.CRMDailyOrdersLiveTable` to `crm.merchant_daily_orders_branch`, while prod may have `crm.merchant_daily_orders`. Verify environment/table rename before changing queries.
- Do not hardcode service URLs or table names beyond existing constants.
- Do not add auth middleware to `/s2s/` routes.
- Use the full feature doc before changing RFM SQL, movement rules, daily-order aggregation, or default smart segment behavior.
