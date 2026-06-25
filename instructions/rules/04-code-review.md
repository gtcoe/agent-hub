# Code Review Standards

## When to Review

Mandatory review triggers:

- After writing or modifying any code
- Before committing to shared branches
- When changing auth, DB queries, Kafka consumers, or cron logic
- When adding new API routes or modifying existing ones
- Before any PR is raised

## Review Checklist

Before marking code complete:

- [ ] Code is readable and functions are well-named
- [ ] Functions are focused (`< 50 lines`)
- [ ] Files are cohesive (`< 800 lines`)
- [ ] No deep nesting (`> 4 levels`) — use early returns
- [ ] Errors wrapped with `errors.WrapMessage` at every layer boundary
- [ ] No bare `return nil, err` — always add context
- [ ] All new handlers follow the DotPe handler contract (bind → log → validate → usecase → respond)
- [ ] `utils.RequestBodyLog` called in every handler **only if** the service logger does NOT include `logging.AccessLogOptionRequestBody` (check `utils/logger.go`). Services that already include it in the access log (e.g. `loyalty`, `comm`) must NOT add a duplicate call; services that omit it (e.g. `marketing`) must call it explicitly after every bind.
- [ ] No `fmt.Println` or `log.Println` — only `utils.DLogger` or `models.Logger`
- [ ] No `context.Background()` — use `corel.NewOrphanContext`
- [ ] No `os.Getenv` for secrets — use `bootconfig.ConfManager.Get`
- [ ] No hardcoded service URLs — use `utils.GetWS` or `utils.WSProvider.Get`
- [ ] No raw SQL string concatenation — only squirrel builder + `.ToSql()` + args
- [ ] Tests exist for new functionality (80% coverage)
- [ ] No unused imports or variables

## Review Severity Levels

| Level    | Meaning                                           | Action                             |
| -------- | ------------------------------------------------- | ---------------------------------- |
| CRITICAL | Security vulnerability, data loss, auth bypass    | **Block** — must fix before merge  |
| HIGH     | Bug or significant correctness issue              | **Warn** — should fix before merge |
| MEDIUM   | Maintainability concern, missing test, bad naming | **Info** — consider fixing         |
| LOW      | Style or minor suggestion                         | **Note** — optional                |

## Security Review Triggers

Stop immediately and perform a security review when:

- Any route has auth middleware added or removed
- Any DB query is constructed from user-provided input
- Any new `/public/` or `/s2s/` route is added
- Any secret, key, or credential is referenced in code
- Any external HTTP call is added

## Layer Boundary Rules (Flag Violations)

| Layer      | Allowed dependencies                                              |
| ---------- | ----------------------------------------------------------------- |
| Handler    | Request binding, validation, usecase call, response               |
| Usecase    | Interfaces only — never concrete repos or other usecases directly |
| Repository | DB/Redis/Kafka only — no business logic                           |
| Domain     | Structs, constants, error codes — no external imports             |

## Common Anti-Patterns to Flag

```go
// CRITICAL: raw SQL string with input
query := fmt.Sprintf("SELECT * FROM campaign WHERE merchant_id = '%s'", id)

// CRITICAL: os.Getenv for secrets
password := os.Getenv("DB_PASSWORD")

// CRITICAL: raw Gin context passed to goroutine
go processAsync(c, &req)  // should be c.Copy()

// HIGH: missing error wrap
return nil, err  // should include context

// HIGH: wrong logger
fmt.Println("something happened")  // use utils.DLogger

// HIGH: hardcoded URL
url := "https://api.stage4.dotnu.co/api/loyalty/..."

// HIGH: context.Background() in application code
ctx := context.Background()  // use corel.NewOrphanContext("label")

// MEDIUM: handler missing RequestBodyLog
func doSomething(c *gin.Context) {
    var req SomeReq
    c.BindJSON(&req)
    // missing: utils.RequestBodyLog(c, req)
    uc.DoSomething(c, &req)
}
```

