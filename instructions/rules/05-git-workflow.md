# Git Workflow

## Commit Message Format

```
<type>: <short description>

<optional body — explain WHY, not WHAT>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

Examples:

```
feat: add visit program enrollment endpoint

fix: handle nil merchant config in campaign usecase

refactor: extract coupon validation into separate method

test: add table-driven tests for credit conversion rules

chore: bump mindbenders to v1.4.2
```

Rules:

- Subject line: max 72 characters, imperative mood, no period at end
- Keep subject and body separated by a blank line
- Body: explain the reasoning/context, not the diff

## Branch Naming

```
feat/<ticket-id>-short-description
fix/<ticket-id>-short-description
chore/<description>

# Examples
feat/DM-67-visit-program-milestone
fix/DM-102-campaign-null-pointer
chore/upgrade-go-1.24
```

## Pull Request Workflow

Before raising a PR:

1. `go build ./...` — must pass
2. `go test ./...` — must pass
3. `go vet ./...` — must pass
4. Merge conflicts resolved
5. Branch is up to date with base branch

PR description must include:

- What was changed and why
- How to test it
- Any risks or side effects

## What NOT to Commit

- Secrets, passwords, API keys (use bootconfig)
- Local config overrides (`.local.json` files are gitignored for a reason)
- Debug `fmt.Println` or `log.Println` left in code
- Commented-out dead code
- Binary files or large generated files

