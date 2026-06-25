# MCP Test Report

Last full probe command:

```bash
node .agent-hub/bin/agent-test-mcps.js
```

Run mode: network-enabled shell, through central `.agent-hub/bin/agent-mcp.js`.

## Result Summary

| MCP | Status | Details |
| --- | --- | --- |
| `local-mysql` | PASS | Initialized, `tools/list` returned 1 tool. |
| `staging-mysql` | PASS | Initialized, `tools/list` returned 1 tool. |
| `prod-mysql` | PASS | Initialized, `tools/list` returned 1 tool. |
| `staging-clickhouse` | PASS | Initialized, `tools/list` returned 3 tools. |
| `prod-clickhouse` | PASS | Initialized through direct VPN/private network access, `tools/list` returned 3 tools. |
| `staging-redis` | PASS | Initialized, `tools/list` returned 4 tools. |
| `gitlab` | PASS | Initialized, `tools/list` returned 9 tools. |
| `atlassian` | PASS | Initialized, `tools/list` returned 49 tools. |
| `staging-kafka` | PASS | Initialized, `tools/list` returned 5 tools. |
| `figma` | PASS | Initialized, `tools/list` returned 5 tools. |
| `notion` | PASS | Remote endpoint reachable; returned HTTP 401, which means auth is required. |
| `figma-remote` | PASS | Remote endpoint reachable; returned HTTP 401, which means auth is required. |
| `growwmcp` | PASS | Initialized, `tools/list` returned 31 tools. |

## Groww Auth Note

Groww initially opened a browser authorization tab. After authorization, a lingering Node process was still listening on callback port `52155`, causing this sanitized error:

```text
Authentication required. Initializing auth...
Fatal error: TypeError: Cannot read properties of null (reading 'port')
```

Stopping the stale callback listener fixed the issue. `growwmcp` now initializes successfully through the central registry.

## Probe Notes

- The probe sends newline-delimited JSON-RPC because the installed MCP servers in this environment use that stdio format.
- The probe does not print secret values.
- Internal network MCPs need a network-enabled shell/VPN context. Without that, Redis and remote MCP hosts can fail DNS resolution.
- The probe launches stdio MCPs in their own process group and terminates that group after each test to avoid orphan test processes.
