# Go Patterns & Idioms

## Accept Interfaces, Return Structs

Struct fields should be interface types (defined in `domain/interfaces/`). Constructors accept and store interfaces. Methods operate on those fields — never accept a repo/service as a method parameter.

```go
// CORRECT — struct field is an interface; injected via constructor
type campaignUsecase struct {
    repo interfaces.CampaignRepository  // interface type
}

func (uc *campaignUsecase) GetActive(ctx context.Context) ([]*entity.Campaign, error) {
    return uc.repo.GetActive(ctx)  // uses the interface field
}

// WRONG — repo passed as method argument (not how DotPe usecases work)
func (uc *campaignUsecase) GetActive(ctx context.Context, repo interfaces.CampaignRepository) ([]*entity.Campaign, error)

// WRONG — accepting a concrete struct loses testability
func GetCampaigns(repo *mysql.CampaignRepository) ([]*entity.Campaign, error)
```

## Small Interfaces

Keep interfaces focused — 1 to 3 methods. Split large interfaces into composable smaller ones.

```go
// CORRECT
type CampaignReader interface {
    GetByID(ctx context.Context, id int64) (*entity.Campaign, error)
    GetByMerchant(ctx context.Context, merchantID string) ([]*entity.Campaign, error)
}

// WRONG — too broad, hard to mock
type CampaignRepository interface {
    GetByID(...) ...
    GetByMerchant(...) ...
    Create(...) ...
    Update(...) ...
    Delete(...) ...
    GetAnalytics(...) ...
}
```

## Dependency Injection via Constructors

Use constructor functions to inject dependencies. All wiring happens in `bootstrap/init.go`.

```go
// CORRECT
func NewCampaignUsecase(
    repo interfaces.CampaignRepository,
    segmentRepo interfaces.SegmentRepository,
    logger logging.IDotpeLogger,
) *campaignUsecase {
    return &campaignUsecase{repo: repo, segmentRepo: segmentRepo, logger: logger}
}

// WRONG — creating dependencies inside the struct
func NewCampaignUsecase() *campaignUsecase {
    return &campaignUsecase{repo: mysql.NewCampaignRepo()}
}
```

## Make the Zero Value Useful

Design types so their zero value works without additional initialization.

```go
// CORRECT — sync.Mutex zero value is usable
type merchantCache struct {
    mu    sync.Mutex
    cache map[string]*entity.Merchant
}

// WRONG — nil map will panic on write
type merchantCache struct {
    cache map[string]*entity.Merchant // must be initialized first
}
```

## Functional Options (for complex constructors)

```go
type Option func(*providerConfig)

func WithTimeout(d time.Duration) Option {
    return func(c *providerConfig) { c.timeout = d }
}

func NewProviderClient(baseURL string, opts ...Option) *providerClient {
    cfg := &providerConfig{timeout: 30 * time.Second}
    for _, opt := range opts {
        opt(cfg)
    }
    return &providerClient{baseURL: baseURL, cfg: cfg}
}
```

## Error Handling Patterns

Always wrap errors with context using `errors.WrapMessage` from `gitlab.com/dotpe/mindbenders/errors`:

```go
// CORRECT
if err != nil {
    return nil, errors.WrapMessage(err, "fetching campaign by merchant")
}

// WRONG — bare return loses context
if err != nil {
    return nil, err
}

// WRONG — stdlib (import shadowing is common mistake)
return nil, fmt.Errorf("failed: %w", err)
```

## Concurrency Patterns

Always use `context.Context` for cancellation/timeout. Never start a goroutine without one.

```go
// CORRECT — goroutine with copied Gin context
go processAsync(c.Copy(), &req)

// CORRECT — background context for cron/kafka
ctx := corel.NewOrphanContext("process-campaign-worker")

// WRONG — raw context.Background()
ctx := context.Background()

// CORRECT — coordinate goroutines with WaitGroup
var wg sync.WaitGroup
for _, item := range items {
    wg.Add(1)
    go func(i *entity.Item) {
        defer wg.Done()
        process(ctx, i)
    }(item)
}
wg.Wait()
```

## Package-Level Variables

Avoid mutable package-level variables. Use dependency injection instead.

```go
// WRONG
var globalDB *sql.DB

// CORRECT — inject db via constructor
func NewUserRepo(db *sql.DB) *userRepo {
    return &userRepo{db: db}
}
```

## Context First

`ctx context.Context` must always be the first parameter:

```go
// CORRECT
func (r *repo) GetByMerchant(ctx context.Context, merchantID string) ([]*entity.Campaign, error)

// WRONG
func (r *repo) GetByMerchant(merchantID string, ctx context.Context) ([]*entity.Campaign, error)
```

## Defer for Cleanup

Always use `defer` for resource cleanup:

```go
rows, err := r.db.QueryContext(ctx, query, args...)
if err != nil {
    return nil, errors.WrapMessage(err, "querying campaigns")
}
defer rows.Close()
```

## One Query Per Repository Function

Each repository method must execute exactly **one** SQL statement. Never run two queries inside a single repo function.

```go
// CORRECT — one function, one INSERT
func (r *visitProgramRepo) CreateProgram(ctx context.Context, program *entity.Program) (int, error) {
    // INSERT INTO loyalty_programs ...
}

func (r *visitProgramRepo) CreateVisitProgramConfig(ctx context.Context, program *entity.Program) error {
    // INSERT INTO visit_program_config ...
}

// WRONG — two queries hidden inside one repo function
func (r *visitProgramRepo) CreateProgram(ctx context.Context, program *entity.Program) (int, error) {
    // INSERT INTO loyalty_programs ...
    // INSERT INTO visit_program_config ...  ← violates single-query rule
}
```

When multiple mutations must be atomic, call each single-query repo method from the **usecase layer** inside a `Transact` closure:

```go
// CORRECT — usecase orchestrates multiple single-query repo calls in a transaction
vpuc.appTxManager.Transact(ctx, func(repos apptx.AppTxRepos) error {
    programID, err := repos.Visit.CreateProgram(ctx, program)       // one INSERT
    // ...
    program.ID = programID
    if err := repos.Visit.CreateVisitProgramConfig(ctx, program); err != nil { // one INSERT
        return errors.WrapMessage(err, "failed to create visit program config")
    }
    // ...
    return nil
})
```

## Use Constants for Domain String Values

Never use raw string literals for enum-like domain values. Define them as constants in the appropriate `*_constants.go` file in `domain/entity/` and reference the constant everywhere.

```go
// CORRECT — constant defined in domain/entity/visit_constants.go
const (
    ExclusionScopeEarn = "earn"
    ExclusionScopeBurn = "burn"
    ExclusionScopeBoth = "both"
)

// CORRECT — usage references the constant
if exclusion.Scope == "" {
    exclusion.Scope = entity.ExclusionScopeBoth
}

// WRONG — string literal used directly in code
if exclusion.Scope == "" {
    exclusion.Scope = "both"  // hard to find, easy to typo, impossible to rename safely
}
```

