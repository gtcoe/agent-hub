# Security — Extended

> The core security rules (bootconfig, squirrel SQL, auth middleware) are in `.agent-hub/instructions/shared/workspace.md`.
> This file adds the OWASP checklist and additional security patterns.

## Pre-Commit Security Checklist

Before any commit:

- [ ] No hardcoded secrets — all via `bootconfig.ConfManager.Get`
- [ ] No `os.Getenv` for DB passwords, API keys, tokens
- [ ] All user inputs validated in `req.Validate()` before usecase
- [ ] All SQL queries built with squirrel — no `fmt.Sprintf` into SQL
- [ ] No auth middleware removed from `/public/` routes
- [ ] No auth middleware added to `/s2s/` routes
- [ ] Error messages returned to callers don't leak internal stack traces
- [ ] No sensitive data (tokens, passwords, PII) in log fields

## OWASP Top 10 — Go/Gin Context

### 1. Injection

```go
// CRITICAL — string concatenation into SQL
query := fmt.Sprintf("SELECT * FROM campaign WHERE merchant_id = '%s'", id)

// CORRECT — squirrel parameterized
qb := squirrel.Select("*").From("campaign").Where(squirrel.Eq{"merchant_id": id})
query, args, _ := qb.ToSql()
rows, err := db.QueryContext(ctx, query, args...)
```

### 2. Broken Authentication

- Every `/public/` route must have `auth.Auth` or `auth.Uauth` middleware
- Every `/s2s/` route must have **no** auth middleware
- Extract merchant/user IDs only via `auth.GetMerchantId(c)` / `auth.GetUserId(c)` — never from request body for identity

### 3. Sensitive Data Exposure

```go
// WRONG — logging sensitive fields
utils.DLogger.Info(ctx, logging.Fields{"token": userToken, "password": pass}, "user_action")

// CORRECT — log identifiers only
utils.DLogger.Info(ctx, logging.Fields{"merchant_id": merchantID, "action": "login"}, "user_action")
```

### 4. Broken Access Control

- Usecase layer must re-verify ownership — never trust that the handler-level auth is sufficient for multi-tenant data
- Pattern: fetch resource → verify `resource.MerchantID == auth.GetMerchantId(c)` before returning

```go
campaign, err := uc.repo.GetByID(ctx, campaignID)
if err != nil {
    return nil, errors.WrapMessage(err, "fetching campaign")
}
// Ownership check — do not skip
if campaign.MerchantID != merchantID {
    return nil, errors.NewWithCode("forbidden", entity.ErrCodeForbidden)
}
```

### 5. Security Misconfiguration

- Never set `InsecureSkipVerify: true` in TLS configs
- Never disable CORS validation for production routes
- Rate limiting must be applied on all public-facing endpoints

### 6. Logging & Monitoring

```go
// CORRECT — structured error logging
utils.DLogger.Error(ctx, logging.Fields{
    "error":       err.Error(),
    "merchant_id": merchantID,
    "campaign_id": campaignID,
}, "campaign_fetch_failed")

// WRONG — unstructured, no fields
fmt.Println("error fetching campaign:", err)
log.Printf("error: %v", err)
```

### 7. Input Validation at Every Boundary

Validate at **all** entry points — not just HTTP handlers:

- Kafka consumers: validate message payload before processing
- Cron jobs: validate config/input before executing
- S2S callers: validate request body even without auth

```go
// Kafka consumer example
func (c *campaignConsumer) process(msg *kafka.Message) error {
    var payload dto.CampaignEvent
    if err := json.Unmarshal(msg.Value, &payload); err != nil {
        return errors.WrapMessage(err, "unmarshal campaign event")
    }
    if payload.MerchantID == "" || payload.CampaignID == 0 {
        return errors.New("invalid campaign event: missing required fields")
    }
    // proceed
}
```

## Secret Rotation Protocol

If a secret is accidentally committed:

1. **Immediately rotate** the secret in AWS Secrets Manager
2. Remove from git history (`git filter-branch` or `git filter-repo`)
3. Notify the team
4. Review all logs for unauthorized usage of the exposed secret

