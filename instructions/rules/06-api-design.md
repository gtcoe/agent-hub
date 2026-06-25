# API Design

## Route Structure

All services use Gin. Route groups follow this structure:

```go
// Public routes (merchant JWT) — /public/
api.POST("/public/campaign/create", auth.Auth, handler.CreateCampaign)

// User-facing routes (user JWT) — /user/
api.POST("/user/enroll", auth.Uauth, handler.EnrollUser)

// Admin routes (no auth from trusted internal caller) — /admin/
api.POST("/admin/sync", handler.SyncData)

// Service-to-service routes (no auth) — /s2s/
s2s := api.Group("/s2s")
s2s.POST("/campaign/notify", handler.NotifyCampaign)
```

## URL Naming

```
# CORRECT — noun-based, snake_case or kebab-case
POST /public/campaign/create
GET  /public/campaign/list
POST /user/loyalty/enroll
GET  /s2s/merchant/config

# WRONG — verbs in URL, inconsistent casing
POST /public/createCampaign
GET  /public/getCampaignList
```

## Response Envelope — DotPe Standard

Every response must use this exact envelope:

```go
// Success
response.SuccessWithObject(c, gin.H{
    "status": true,
    "data":   result,
})

// Error
response.ServerError(c, err)       // 500
response.ValidationError(c, req, err)  // 400
```

JSON envelope shape:

```json
{
  "status": true,
  "data": { ... },
  "message": "...",
  "error": ""
}
```

Never return raw errors in JSON. Never expose internal error messages in the `error` field.

## HTTP Status Code Usage

```
200 — successful read or update
201 — resource created (POST that creates something)
400 — validation failure, malformed request (use response.ValidationError)
401 — missing/invalid auth token
403 — valid token but insufficient permission
404 — resource not found
409 — duplicate entry or state conflict
422 — semantically invalid request (valid JSON, wrong business logic)
429 — rate limit exceeded
500 — unexpected failure (use response.ServerError)
```

## Pagination

For list endpoints, support cursor or offset pagination consistently:

```go
// Request params
type ListCampaignReq struct {
    MerchantID string `json:"merchant_id" binding:"required"`
    Page       int    `json:"page"`
    Limit      int    `json:"limit"`
}

// Default safe limits
const (
    DefaultLimit = 20
    MaxLimit     = 100
)

// In usecase — enforce max
if req.Limit <= 0 || req.Limit > MaxLimit {
    req.Limit = DefaultLimit
}
```

Response for collections always includes metadata:

```json
{
  "status": true,
  "data": {
    "items": [...],
    "total": 142,
    "page": 1,
    "limit": 20
  }
}
```

## Validation Location

Validation happens in **two places**:

1. Binding: `c.BindJSON(&req)` — structure/type validation
2. Domain: `req.Validate(c)` — business rule validation

```go
func (r *CreateCampaignReq) Validate(c *gin.Context) error {
    if r.StartDate.After(r.EndDate) {
        return errors.New("start_date must be before end_date")
    }
    if r.Budget <= 0 {
        return errors.New("budget must be positive")
    }
    return nil
}
```

## Request Logging

Whether `utils.RequestBodyLog` is needed depends on the service's logger configuration in `utils/logger.go`:

| Service | Logger includes `AccessLogOptionRequestBody`? | `RequestBodyLog` needed? |
|---|---|---|
| `loyalty` | ✅ Yes | ❌ Already in access log — do NOT add |
| `comm` | ✅ Yes | ❌ Already in access log — do NOT add |
| `marketing` | ❌ No | ✅ **Required** after every bind |

**Rule:** check `utils.InitLogger()` in the service you are working in. If `logging.AccessLogOptionRequestBody` is present, the request body is auto-logged on every request — an explicit call would duplicate the log line. If it is absent, call `utils.RequestBodyLog` immediately after a successful bind.

```go
// marketing — AccessLogOptionRequestBody NOT in logger → explicit call required
func createCampaign(c *gin.Context) {
    var req requests.CreateCampaignReq
    if err := c.BindJSON(&req); err != nil {
        response.ValidationError(c, req, err)
        return
    }
    utils.RequestBodyLog(c, req)  // ← required only in services without AccessLogOptionRequestBody
    // ...
}

// loyalty / comm — AccessLogOptionRequestBody IS in logger → no explicit call needed
func createProgram(c *gin.Context) {
    var req requests.CreateProgramReq
    if err := c.ShouldBindJSON(&req); err != nil {
        // ...
    }
    // no RequestBodyLog — access log middleware already captures the body
    // ...
}
```

