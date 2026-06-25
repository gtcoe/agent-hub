# ClickHouse Patterns — Marketing Service

Used in `marketing` service via `clickhouse-go/v2`. Config: `marketing/clickhouse` in bootconfig. Database: `crm`. Used for analytics, CRM reporting, and campaign performance data.

## Connection

```go
// Injected via bootstrap — never create ad-hoc connections
// Config key: "marketing/clickhouse"
// Available as: db.GetClickhouseClient() or injected ClickHouseDB
```

## Table Design — MergeTree Engine

```sql
-- Standard analytics table pattern
CREATE TABLE crm.campaign_analytics (
    date        Date,
    merchant_id String,
    campaign_id UInt64,
    sent        UInt32,
    delivered   UInt32,
    clicked     UInt32,
    created_at  DateTime
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (date, merchant_id, campaign_id)
SETTINGS index_granularity = 8192;
```

Key rules:

- **Always define `PARTITION BY`** — use `toYYYYMM(date)` for time-series data
- **`ORDER BY` = primary key** for MergeTree — put high-cardinality equality columns first (e.g. `merchant_id`), then range columns (e.g. `date`)
- **Use `String` for IDs** stored as strings, `UInt64` for numeric IDs
- **Use `DateTime` not `DateTime64`** unless sub-second precision is required

## Query Optimization

### Always filter on ORDER BY columns first

```sql
-- CORRECT — merchant_id is in ORDER BY, prunes partitions
SELECT campaign_id, sum(sent) as total_sent
FROM crm.campaign_analytics
WHERE merchant_id = 'merchant_123'
  AND date >= toDate('2024-01-01')
GROUP BY campaign_id;

-- WRONG — filtering on non-indexed column causes full scan
SELECT * FROM crm.campaign_analytics
WHERE campaign_name LIKE '%sale%';
```

### Batch Inserts — Never Insert Row by Row

```go
// CORRECT — batch insert
batch, err := conn.PrepareBatch(ctx, "INSERT INTO crm.campaign_analytics")
if err != nil {
    return errors.WrapMessage(err, "prepare clickhouse batch")
}
for _, row := range rows {
    if err := batch.Append(row.Date, row.MerchantID, row.CampaignID, row.Sent, row.Delivered, row.Clicked, row.CreatedAt); err != nil {
        return errors.WrapMessage(err, "append to clickhouse batch")
    }
}
if err := batch.Send(); err != nil {
    return errors.WrapMessage(err, "send clickhouse batch")
}

// WRONG — individual inserts are extremely slow in ClickHouse
for _, row := range rows {
    conn.Exec(ctx, "INSERT INTO crm.campaign_analytics VALUES (?, ?, ...)", row.Date, ...)
}
```

### Use `uniq()` not `COUNT(DISTINCT)` for Approximate Cardinality

```sql
-- CORRECT — much faster for large datasets
SELECT uniq(user_id) as unique_users
FROM crm.campaign_analytics
WHERE merchant_id = 'merchant_123';

-- SLOWER for very large datasets
SELECT COUNT(DISTINCT user_id) as unique_users
FROM crm.campaign_analytics
WHERE merchant_id = 'merchant_123';
```

## Go Client Patterns

```go
// Query with context and proper error handling
var results []dto.CampaignAnalyticsRow
rows, err := r.chDB.QueryContext(ctx,
    `SELECT date, campaign_id, sum(sent) as total_sent
     FROM crm.campaign_analytics
     WHERE merchant_id = ? AND date >= ?
     GROUP BY date, campaign_id
     ORDER BY date DESC`,
    merchantID, fromDate,
)
if err != nil {
    return nil, errors.WrapMessage(err, "query campaign analytics")
}
defer rows.Close()

for rows.Next() {
    var row dto.CampaignAnalyticsRow
    if err := rows.Scan(&row.Date, &row.CampaignID, &row.TotalSent); err != nil {
        return nil, errors.WrapMessage(err, "scan campaign analytics row")
    }
    results = append(results, row)
}
```

## What to Avoid

```sql
-- AVOID — JOIN in ClickHouse is expensive, denormalize instead
SELECT a.*, b.merchant_name
FROM crm.campaign_analytics a
JOIN crm.merchants b ON a.merchant_id = b.merchant_id;

-- AVOID — SELECT * on wide tables (ClickHouse is columnar, select only needed columns)
SELECT * FROM crm.campaign_analytics WHERE ...;

-- AVOID — OFFSET pagination (use date/id cursor instead)
SELECT ... FROM crm.campaign_analytics LIMIT 20 OFFSET 10000;
```

