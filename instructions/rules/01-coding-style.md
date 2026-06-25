# Coding Style

## Core Principles

### KISS — Keep It Simple

- Prefer the simplest solution that works
- Avoid premature abstraction and over-engineering
- Optimize for clarity first, performance only when measured

### DRY — Don't Repeat Yourself

- Extract repeated logic into shared functions or utilities
- Introduce abstractions when repetition is real, not speculative
- Avoid copy-paste across services — create shared packages instead

### YAGNI — You Aren't Gonna Need It

- Do not build features or abstractions before they are needed
- Start simple, refactor only when the pressure is real
- Do not add error handling for scenarios that cannot happen

## File Organization

- Prefer many small focused files over few large ones
- 200–400 lines typical, 800 lines maximum per file
- Organize by feature/domain, not by type
- High cohesion, low coupling between packages

## Function Design

- Functions should do one thing
- Keep functions under 50 lines
- No deep nesting — prefer early returns over nested conditionals
- Use named constants for meaningful thresholds, limits, and delays

## Naming Conventions

- Variables and functions: `camelCase` (Go standard)
- Exported identifiers: `PascalCase`
- Constants: `PascalCase` for exported, `camelCase` for unexported
- Booleans: prefer `is`, `has`, `should`, `can` prefixes

## Error Handling

- Handle errors explicitly at every level — never silently swallow
- Never use `_` to discard errors from important operations
- Log detailed error context server-side; never expose internals to callers
- Validate all inputs at system boundaries (handlers, Kafka consumers, cron jobs)

## Code Quality Checklist

Before marking work complete:

- [ ] Code is readable and well-named
- [ ] Functions are focused (`< 50 lines`)
- [ ] Files are cohesive (`< 800 lines`)
- [ ] No deep nesting (`> 4 levels`)
- [ ] Errors handled explicitly at every layer boundary
- [ ] No hardcoded values (use constants or bootconfig)
- [ ] No unused variables/imports

