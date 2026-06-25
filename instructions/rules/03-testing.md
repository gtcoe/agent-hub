# Testing — Go

## Minimum Coverage: 80%

All new code requires tests. Types:

1. **Unit tests** — individual functions, usecase logic, pure helpers
2. **Integration tests** — repository layer against real DB through the stage connection directly or the mcp connection. If any db connection is missing, raise the error
3. Test files live parallel to source: There will bw test folder with the same structure as usecase and test file name will be like `campaign_usecase_test.go` with respect to `campaign_usecase.go`

## TDD Workflow — RED-GREEN-REFACTOR

1. Write a failing test first (RED) — `go test` must fail
2. Write minimal implementation to pass (GREEN) — `go test` must pass
3. Refactor while keeping tests green (IMPROVE)
4. Verify coverage: `go test -cover ./...`

Never write implementation before the test exists.

## Table-Driven Tests — Standard Pattern

All Go tests must use table-driven format:

```go
func TestGetCampaignByMerchant(t *testing.T) {
    tests := []struct {
        name       string
        merchantID string
        want       []*entity.Campaign
        wantErr    bool
    }{
        {
            name:       "returns active campaigns",
            merchantID: "merchant_123",
            want:       []*entity.Campaign{{ID: 1, Status: "active"}},
        },
        {
            name:       "returns empty slice for unknown merchant",
            merchantID: "unknown",
            want:       []*entity.Campaign{},
        },
        {
            name:       "propagates db error",
            merchantID: "error_trigger",
            wantErr:    true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := uc.GetByMerchant(ctx, tt.merchantID)
            if tt.wantErr {
                if err == nil {
                    t.Error("expected error, got nil")
                }
                return
            }
            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
            if !reflect.DeepEqual(got, tt.want) {
                t.Errorf("got %+v; want %+v", got, tt.want)
            }
        })
    }
}
```

## Test Context

Use `corel.NewOrphanContext("test-session")` — never `context.Background()` in tests:

```go
ctx := corel.NewOrphanContext("test-campaign-usecase")
```

## Race Detection — Mandatory in CI

Always run with `-race`:

```bash
go test -race ./...
go test -race ./business/campaign/usecase/
```

## Run Commands

```bash
# All tests
go test ./...

# Specific package
go test ./business/visit/usecase/ -run TestSpecificCase

# With race + coverage
go test -race -cover ./...

# Verbose for debugging
go test -v ./business/campaign/usecase/ -run TestGetCampaign
```

## Mocking Interfaces

Mock the interfaces from `domain/interfaces/` — never mock concrete implementations:

```go
type mockCampaignRepo struct {
    getCampaigns func(ctx context.Context, merchantID string) ([]*entity.Campaign, error)
}

func (m *mockCampaignRepo) GetByMerchant(ctx context.Context, merchantID string) ([]*entity.Campaign, error) {
    return m.getCampaigns(ctx, merchantID)
}
```

## AAA Pattern — Arrange-Act-Assert

Structure tests in three clear sections:

```go
func TestCreateCampaign(t *testing.T) {
    // Arrange
    ctx := corel.NewOrphanContext("test")
    repo := &mockCampaignRepo{...}
    uc := NewCampaignUsecase(repo, logger)

    // Act
    result, err := uc.Create(ctx, &dto.CreateCampaignReq{MerchantID: "m_123"})

    // Assert
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if result.MerchantID != "m_123" {
        t.Errorf("got merchantID %q; want %q", result.MerchantID, "m_123")
    }
}
```

## Test Naming

Use descriptive names that explain behavior:

```go
// CORRECT
func TestGetCampaign_ReturnsCampaignForValidMerchant(t *testing.T) {}
func TestGetCampaign_ReturnsErrorWhenDBFails(t *testing.T) {}
func TestEnrollUser_SkipsAlreadyEnrolledUser(t *testing.T) {}

// WRONG
func TestGetCampaign(t *testing.T) {}
func TestError(t *testing.T) {}
```

