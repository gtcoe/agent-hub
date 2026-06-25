# Cron Job Patterns — DotPe Services

Used in marketing (`CRMCronService`, `UpdateCampaignClicksCount`) and loyalty (`VisitCronService`). All follow the same structure.

## Standard Cron Service Structure

```go
type MyCronService struct {
    cronScheduler *cron.Cron
    // injected deps as interfaces — never concrete repos
    isRunning bool
    mu        sync.RWMutex
}

func NewMyCronService(dep1 interfaces.IMyRepo, dep2 interfaces.IMyUC) *MyCronService {
    // REQUIRED — all DotPe cron jobs run in IST
    istLocation, err := utils.GetISTLocation()
    if err != nil {
        panic("failed to load IST timezone: " + err.Error())
    }
    return &MyCronService{
        cronScheduler: cron.New(
            cron.WithLocation(istLocation),
            cron.WithSeconds(),   // enables 6-field cron expressions
        ),
        dep1: dep1,
        dep2: dep2,
    }
}
```

## Start / Stop Pattern

```go
func (s *MyCronService) Start() error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if s.isRunning {
        return fmt.Errorf("my cron service is already running")
    }

    ctx := corel.NewOrphanContext("startMyCronService")
    utils.DLogger.Info(ctx, logging.Fields{}, "starting_my_cron_service")

    // Each AddFunc gets its own panic recovery and fresh context
    _, err := s.cronScheduler.AddFunc("0 */30 * * * *", func() { // every 30 min
        defer func() {
            if r := recover(); r != nil {
                ctx := corel.NewOrphanContext("cronMyJobPanicRecovery")
                utils.DLogger.Error(ctx, logging.Fields{"panic": r}, "my_cron_job_panicked")
            }
        }()
        ctx := corel.NewOrphanContext("cronMyJob")  // fresh context each invocation
        lockCfg := helper.NewDistributedLockConfig("cron:lock:my_job").WithTTL(25 * time.Minute)
        helper.WithDistributedLock(ctx, lockCfg, func() {
            s.runMyJob(ctx)
        })
    })
    if err != nil {
        return errors.WrapMessage(err, "register my cron job")
    }

    s.cronScheduler.Start()
    s.isRunning = true
    utils.DLogger.Info(ctx, logging.Fields{}, "my_cron_service_started")
    return nil
}

func (s *MyCronService) Stop() {
    s.mu.Lock()
    defer s.mu.Unlock()
    if !s.isRunning {
        return
    }
    s.cronScheduler.Stop()
    s.isRunning = false
}
```

## Job Body — Required Structure

Every cron job body must:

1. Have panic recovery (already in `AddFunc` wrapper above)
2. Use a fresh `corel.NewOrphanContext` per run
3. Check `isRunning` via `s.mu.RLock()` at entry — graceful shutdown guard
4. Log start and completion with duration
5. Cursor-paginate large datasets — never load everything at once

```go
func (s *MyCronService) runMyJob(ctx context.Context) {
    // Intra-process guard: abort if Stop() was called before this tick fired.
    s.mu.RLock()
    if !s.isRunning {
        s.mu.RUnlock()
        return
    }
    s.mu.RUnlock()

    start := time.Now()
    utils.DLogger.Info(ctx, logging.Fields{}, "my_job_started")

    var lastID int64
    const batchSize = 500

    for {
        batch, err := s.repo.GetPendingBatch(ctx, lastID, batchSize)
        if err != nil {
            utils.DLogger.Error(ctx, logging.Fields{"error": err, "last_id": lastID}, "my_job_fetch_batch_failed")
            return
        }
        if len(batch) == 0 {
            break
        }

        for _, item := range batch {
            if err := s.processItem(ctx, item); err != nil {
                utils.DLogger.Error(ctx, logging.Fields{"error": err, "item_id": item.ID}, "my_job_item_failed")
                // continue processing remaining items
            }
        }

        lastID = batch[len(batch)-1].ID
        if len(batch) < batchSize {
            break  // last partial page
        }
    }

    utils.DLogger.Info(ctx, logging.Fields{"duration_ms": time.Since(start).Milliseconds()}, "my_job_completed")
}
```

## Multi-Pod Safety — Three Layers (All Required)

Every cron job uses all three layers together. They solve different problems and are not interchangeable.

### Layer 1: `sync.RWMutex` — intra-process guard (always required)

Protects `isRunning` from data races **within a single pod**:

- `Start()` / `Stop()` acquire the **write lock** to mutate `isRunning`
- Each job acquires the **read lock** at entry — multiple jobs read concurrently, but block if `Stop()` holds the write lock
- Ensures no job starts new batch work after `Stop()` has been called (graceful shutdown)
- Provides **zero** protection across pods

### Layer 2: Distributed lock (Redis `SetNX`) — always add, wraps the job call in `AddFunc`

Prevents all pods from doing redundant work simultaneously:

```go
// In AddFunc — wrap the job call with a distributed lock
ctx := corel.NewOrphanContext("cronMyJob")
lockCfg := helper.NewDistributedLockConfig("cron:lock:my_job").WithTTL(25 * time.Minute)
helper.WithDistributedLock(ctx, lockCfg, func() {
    s.runMyJob(ctx)
})
```

- One pod acquires the lock → runs the job → releases on completion
- Other pods get `acquired=false` → log and skip — no DB work done
- TTL must be set to slightly less than the job interval (e.g. 25 min for a 30-min job)
- **Fail behaviour:** if Redis is unavailable, `WithDistributedLock` returns false and **all pods skip the job** — accept this trade-off in exchange for no cross-pod contention

### Layer 3: DB-level correctness guard — choose one per job type

The distributed lock is the primary efficiency gate, but if it fails (Redis flap, lock expiry under long job) the DB guard ensures correctness:

**Option A — `SELECT FOR UPDATE` (state-transition jobs)**

```go
// Only one pod can lock and commit the active→expired transition for a given row.
// After commit, row no longer matches WHERE status='active' — other pods skip it.
rows, err := txRepo.GetExpiredActiveForUpdate(ctx, batchSize, cursor)
```
Used by `expireRewards` and `expireCollectibles`. Even if two pods both enter the batch loop (distributed lock missed), each row transitions exactly once.

**Option B — Unique-constraint dedup (notification/dispatch jobs)**

```go
// UNIQUE KEY on (entity_id, event_type, reminder_day, account_id, medium, expires_at)
// First pod to INSERT IGNORE wins; second gets rowsAffected=0 → skips the send.
inserted, err := s.dispatchLogRepo.TryInsert(ctx, &DispatchLogEntry{...})
if !inserted {
    return false
}
s.commService.Send(ctx, ...)
```
Used by `sendExpiryReminders`. Each notification sent exactly once regardless of how many pods attempt it.

### TTL guidelines

| Job interval | Lock TTL | Context timeout |
|---|---|---|
| 30 minutes | 25 minutes | 10 minutes |
| Daily | 2 hours | 30 minutes |

TTL < interval ensures the lock expires before the next tick if a pod dies mid-job.

## Cron Schedule Reference (IST)

```
"0 */30 * * * *"    → every 30 minutes
"0 0 * * * *"       → every hour at :00
"0 0 1 * * *"       → daily at 01:00 AM IST
"0 0 9 * * 1-5"     → weekdays at 09:00 AM IST
"0 0 0 1 * *"       → first day of every month at midnight IST
```

Note: `cron.WithSeconds()` is used, so expressions have 6 fields (seconds first).

## Distributed Lock Key Naming

```
cron:lock:<job_name>                  → cron-level (one per pod cluster)
<domain>:<operation>:<merchant_id>    → usecase-level per merchant
```

Examples:

```
cron:lock:crm_etl
cron:lock:campaign_clicks_update
cron:lock:expire_rewards
segment:rebuild:12345
```

## What Must NOT Be Done in Cron Jobs

```go
// WRONG — unbounded query that loads entire table
rows, err := r.db.QueryContext(ctx, "SELECT * FROM collectibles WHERE expires_at < NOW()")

// WRONG — distributed lock missing (all pods run the job simultaneously)
s.cronScheduler.AddFunc("@every 5m", func() {
    ctx := corel.NewOrphanContext("cronMyJob")
    s.runMyJob(ctx)  // every pod does full DB work in parallel
})

// WRONG — DB correctness guard missing (distributed lock is not enough alone)
// If Redis flaps and all pods enter the job, nothing prevents double state-transitions.
s.cronScheduler.AddFunc("@every 5m", func() {
    ctx := corel.NewOrphanContext("cronMyJob")
    lockCfg := helper.NewDistributedLockConfig("cron:lock:my_job").WithTTL(25 * time.Minute)
    helper.WithDistributedLock(ctx, lockCfg, func() {
        s.runMyJobWithNoForUpdateOrDedup(ctx)  // no correctness guard
    })
})

// WRONG — shared context between job runs
ctx := corel.NewOrphanContext("sharedCtx")  // created once, reused across ticks
s.cronScheduler.AddFunc("@every 5m", func() {
    doWork(ctx)  // ctx must be created fresh inside each AddFunc invocation
})

// WRONG — no panic recovery
s.cronScheduler.AddFunc("@every 5m", func() {
    s.doWork(ctx)  // one panic kills the goroutine silently; job never runs again
})
```

## Bootstrap Wiring for Cron Services

```go
// main.go (or bootstrap/init.go) — init → start → defer stop
ctx := corel.NewOrphanContext("initCronServices")
cronSvc := scheduler.NewMyCronService(repo, usecase)
if err := cronSvc.Start(); err != nil {
    utils.DLogger.Error(ctx, logging.Fields{"error": err}, "failed_to_start_cron_service")
    return
}
defer cronSvc.Stop()
```

