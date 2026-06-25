# Database Migration Safety (MySQL + Liquibase)

All schema changes in DotPe services go through Liquibase changelogs. These rules apply to any migration file or raw `ALTER TABLE` / `CREATE INDEX` SQL.

## Core Rules

1. **Every change is a migration** — never alter tables directly in production or staging
2. **Schema and data migrations are always separate** — never mix DDL (`ALTER TABLE`) and DML (`UPDATE`) in one changeset
3. **Test on production-sized data** — a migration that works on 100 rows may lock on 10M rows
4. **Migrations are immutable once deployed** — never edit a changeset that has already run in production
5. **Always have a rollback plan** — rollback changesets or document that it is an irreversible forward-only migration

## Safety Checklist Before Any Migration

- [ ] New columns are nullable OR have a DEFAULT value (never `NOT NULL` without default on existing table)
- [ ] Indexes are created without locking writes (`ALGORITHM=INPLACE, LOCK=NONE` in MySQL)
- [ ] Large data backfills are batched — never one `UPDATE` for all rows
- [ ] Migration tested against a copy of production data
- [ ] Rollback changeset written or documented as intentionally irreversible

## Adding a Column Safely (MySQL)

```sql
-- CORRECT — nullable, no table lock
ALTER TABLE campaign ADD COLUMN discount_type VARCHAR(50) NULL;

-- CORRECT — with default (instant in MySQL 8+)
ALTER TABLE campaign ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;

-- WRONG — NOT NULL without default on large existing table (full table rewrite)
ALTER TABLE campaign ADD COLUMN discount_type VARCHAR(50) NOT NULL;
```

## Adding an Index Without Downtime (MySQL)

```sql
-- CORRECT — online DDL, doesn't block reads/writes
ALTER TABLE campaign
ADD INDEX idx_campaign_merchant_status (merchant_id, status)
ALGORITHM=INPLACE, LOCK=NONE;

-- WRONG — may lock table on older MySQL versions
CREATE INDEX idx_campaign_merchant_status ON campaign (merchant_id, status);
```

## Renaming a Column — Expand-Contract Pattern

Never rename directly. Use three separate migrations:

```sql
-- Migration 001: Add new column
ALTER TABLE campaign ADD COLUMN display_name VARCHAR(255) NULL;

-- (Deploy app code that writes BOTH old and new column)

-- Migration 002: Backfill data
UPDATE campaign SET display_name = name WHERE display_name IS NULL;

-- (Deploy app code that reads new column)

-- Migration 003: Drop old column
ALTER TABLE campaign DROP COLUMN name;
```

## Large Data Migrations — Always Batch

```sql
-- WRONG — single UPDATE locks table for entire duration
UPDATE customer_profiles SET tier = 'gold' WHERE points > 1000;

-- CORRECT — batch with LIMIT to avoid long locks
UPDATE customer_profiles
SET tier = 'gold'
WHERE points > 1000
  AND tier != 'gold'
LIMIT 10000;
-- Run repeatedly until rows_affected = 0
```

In Go (for programmatic migrations):

```go
for {
    result, err := db.ExecContext(ctx,
        `UPDATE customer_profiles SET tier = 'gold'
         WHERE points > 1000 AND tier != 'gold' LIMIT 10000`)
    if err != nil {
        return errors.WrapMessage(err, "batch update customer tiers")
    }
    n, _ := result.RowsAffected()
    if n == 0 {
        break
    }
    time.Sleep(100 * time.Millisecond) // brief pause between batches
}
```

## Index Design Principles

- **Always index foreign key columns** — `merchant_id`, `user_id`, `store_id` must be indexed
- **Composite index column order** — equality columns first, range columns last
  ```sql
  -- Query: WHERE merchant_id = ? AND status = ? AND created_at > ?
  -- CORRECT composite index order:
  INDEX idx_campaign_lookup (merchant_id, status, created_at)
  ```
- **Partial indexes for soft deletes** — `WHERE deleted_at IS NULL`
- **Covering indexes** — include frequently selected columns to avoid table lookups

## What to Never Do

```sql
-- NEVER — drops column without checking all app code references first
ALTER TABLE campaign DROP COLUMN some_column;

-- NEVER — truncate production table (even in a migration)
TRUNCATE TABLE temp_data;

-- NEVER — data migration mixed with schema change in one changeset
ALTER TABLE campaign ADD COLUMN total_spent DECIMAL(10,2);
UPDATE campaign SET total_spent = (SELECT SUM(amount) FROM orders WHERE ...);
```

