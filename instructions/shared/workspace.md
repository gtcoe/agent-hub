# DotPe Backend — Workspace Rules

Go microservices monorepo. All services (`comm`, `marketing`, `loyalty`) share this stack and conventions.
Per-service instructions in `<service>/.github/copilot-instructions.md` extend these — read both.

## Workspace Layout

```
ai/
  comm/       → module dotpe/comm      — WhatsApp/SMS/email communication service
  marketing/  → module dotpe/marketing — campaign, segments, CRM, coupon, credits
  loyalty/    → module dotpe/loyalty   — points, visit-based loyalty, provider integrations
```

Each service follows the same internal layout:

```
bootstrap/init.go          ← manual DI: repos → providers → usecases → routes
business/<domain>/
  web/http/ or net/        ← Gin handlers (bind → validate → usecase → respond)
  usecase/                 ← business logic; depends on interfaces only
  repository/mysql|redis|net|kafka/ ← data access only; no business logic
domain/interfaces/         ← all contracts (interfaces defined here, not in business/)
domain/entity/ or domain/dto/ ← structs, domain constants, error codes
db/                        ← DB/Redis init via bootconfig
utils/                     ← logger, webservices map, constants
```

> **comm** is older and uses `handler/` + `models/` instead of `business/<domain>/`. Same layering rules apply.

## Stack

- **Go 1.24** · **Gin** · **`github.com/Masterminds/squirrel`** + raw `database/sql` — **no ORM**
- **`gitlab.com/dotpe/mindbenders`** — logging (`logging.ILogWriter`), bootconfig, corel, middleware
- **`gitlab.dotpe.in/core/flerken`** — JWT auth (`auth.Auth`, `auth.Uauth`)
- **MySQL** (write: `db.Client`, read: `db.ClientSlave` in marketing; `db.Client` everywhere else)
- **Redis** — `db.GetRedisClient()` (loyalty/marketing) · `*redis.Client` injected in comm
- **Kafka** — `confluent-kafka-go/v2`
- **ClickHouse** — marketing only (`clickhouse-go/v2`)

## Secrets & Config

```go
// CORRECT — always use bootconfig
secret, err := bootconfig.ConfManager.Get(os.Getenv("APP") + "/mysql")

// WRONG — never use os.Getenv for secrets
password := os.Getenv("DB_PASSWORD")
```

- `os.Getenv` is only acceptable for non-secret env flags: `APP`, `ENV`, `PORT`
- Config keys follow the pattern `"<app>/<resource>"` e.g. `"comm/mysql"`, `"marketing/redis"`

## Service URLs

```go
// comm and loyalty — utils.GetWS / utils.SetWS
url := utils.GetWS("marketing") + "/api/marketing/s2s/..."

// marketing — utils.WSProvider.Get(services.<SERVICE>)
url := utils.WSProvider.Get(services.LOYALTY) + "/api/loyalty/s2s/..."
```

- Never hardcode service base URLs — they are loaded from Secrets Manager at startup via `utils.LoadWebServices()` / `utils.InitWSProvider()`
- S2S routes live under `/s2s/` and have **no auth middleware** — do not add `auth.Auth` to them

## Authentication

```go
commApi.POST("/public/admin/add/event", auth.Auth, handler.AddEvent)   // merchant JWT
commApi.POST("/user/action", auth.Uauth, handler.UserAction)           // user JWT
s2s := commApi.Group("/s2s")                                           // no auth — internal only

// Extract IDs from context
merchantID := auth.GetMerchantId(c)
userID := auth.GetUserId(c)
```

- `/public/` routes require `auth.Auth` (merchant) or `auth.Uauth` (user)
- `/s2s/` routes must have **no auth middleware** — they are internal service-to-service only

## Handler Contract

Every Gin handler must follow this exact sequence — no exceptions:

```go
func doSomething(c *gin.Context) {
    var req requests.SomethingReq
    if err := c.BindJSON(&req); err != nil {         // or ShouldBindJSON for non-fatal
        response.ValidationError(c, req, err)
        return
    }
    // utils.RequestBodyLog(c, req)  ← ONLY add this if the service logger does NOT include
    //   logging.AccessLogOptionRequestBody in utils/logger.go (currently: marketing only).
    //   loyalty and comm already log the body via access log middleware — no explicit call needed.
    if err := req.Validate(c); err != nil {
        response.ValidationError(c, req, err)
        return
    }
    result, err := domainUC.DoSomething(c, &req)
    if err != nil {
        response.ServerError(c, err)
        return
    }
    response.SuccessWithObject(c, gin.H{"status": true, "data": result})
}
```

Response envelope must always be: `{"status": bool, "data": ..., "message": "...", "error": "..."}`

For typed use-case errors (loyalty pattern), define error codes in `domain/entity/` and map them
in a `respondWithUsecaseErr` helper — never return raw error messages for domain errors.

## Logging

```go
// CORRECT
utils.DLogger.Info(ctx, logging.Fields{"merchant_id": id, "key": val}, "snake_case_event")
utils.DLogger.Error(ctx, logging.Fields{"error": err}, "operation_failed")

// WRONG — never use these
fmt.Println(...)
log.Println(...)
```

- Logger is always `utils.DLogger` (type `logging.IDotpeLogger`)
- Log message strings must be `snake_case`
- Fields key `"error"` for errors — never `"err"` or `"e"`
- In comm, logger is `models.Logger` (same interface, injected via `models.Init`)

## Context Rules

```go
// Passing Gin context to a goroutine — always copy first
go someFunc(c.Copy(), &req)

// Background context (cron, kafka, bootstrap, workers)
ctx := corel.NewOrphanContext("cron_job_name")
ctx := corel.NewOrphanContext("kafka-consumer")

// Always pass ctx as first arg through every function call chain
func (r *repo) GetUser(ctx context.Context, id int) (*entity.User, error)
```

- Never pass `c` (the raw Gin context) directly to a goroutine — use `c.Copy()`
- Never use `context.Background()` — use `corel.NewOrphanContext("label")` for top-level contexts

## Database — Squirrel Query Builder

```go
// CORRECT — always use squirrel; never fmt.Sprintf into SQL
qbuilder := squirrel.Select("id", "merchant_id", "status").
    From("campaign").
    Where(squirrel.Eq{"merchant_id": merchantID, "status": "active"}).
    Limit(uint64(limit))

query, args, err := qbuilder.ToSql()
if err != nil {
    return nil, errors.WrapMessage(err, "failed to build query")
}
rows, err := r.db.QueryContext(ctx, query, args...)

// Writes (master), reads (slave where available)
// marketing: db.Client (writes), db.ClientSlave (reads)
// loyalty/comm: db.Client for all

// WRONG — raw string SQL with user input
query := fmt.Sprintf("SELECT * FROM users WHERE id = %d", id)
```

- **Never** concatenate user input into SQL strings
- Always call `.ToSql()` and use the returned `args` slice — never inline values
- Wrap query build errors: `errors.WrapMessage(err, "failed to build <operation> query")`

## Error Handling

```go
// Wrap errors with context at every layer boundary
return nil, errors.WrapMessage(err, "fetching merchant config")

// Domain/typed errors (usecase layer only)
return errors.NewWithCode("program not found", entity.ErrCodeProgramNotFound)

// Standard errors (no context needed)
return errors.New("mandatory data missing")

// Check error type
code := errors.Code(err)  // returns empty string if not a coded error
```

- Use `errors` from `gitlab.com/dotpe/mindbenders/errors` — **not** stdlib `errors` or `fmt.Errorf`
- Wrap at every layer boundary so stack traces are meaningful
- Usecase layer uses `errors.NewWithCode` for domain errors; handlers map codes to HTTP status

## Goroutines & Workers

```go
// Worker pool pattern (marketing/loyalty)
worker.Dispatch(func() { processOrder(ctx, order) })

// Direct goroutine — only for fire-and-forget where worker pool isn't available
go sendNotification(c.Copy(), &req)
```

- Prefer the service's existing worker pool over raw goroutines
- Every goroutine must have a context with cancellation path back to app shutdown

## Testing

```go
PORT=9400 go run .      # run locally
go test ./...           # run all tests
go test ./business/visit/usecase/ -run TestSpecificCase   # targeted test
```

- Table-driven tests preferred
- Always run with `-race` flag in CI: `go test -race ./...`
- Use `corel.NewOrphanContext("test-session")` for test contexts

## What Must Never Be Done

- Use `os.Getenv` for DB passwords, API keys, or any secret
- Hardcode service base URLs in any form
- Use `fmt.Println` or `log.Println` — always `utils.DLogger`
- Concatenate user data into SQL strings — always squirrel + parameterized
- Pass the raw Gin `c` to a goroutine — always `c.Copy()`
- Use `context.Background()` — always `corel.NewOrphanContext("label")`
- Import concrete repository packages from the usecase layer
- Add `auth.Auth` middleware to `/s2s/` routes
- Use stdlib `errors` or `fmt.Errorf` for wrapping — use mindbenders `errors.WrapMessage`
