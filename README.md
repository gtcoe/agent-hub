# Agent Hub

Central registry for terminal coding agents in this workspace.

The goal is one source of truth:

- Add an MCP server in `.agent-hub/registry/mcps.json`.
- Add an instruction source in `.agent-hub/registry/instructions.json`.
- Add a skill under `.agent-hub/skills/<skill-name>/SKILL.md`.
- Run `node .agent-hub/bin/agent-sync.js`.
- Agent-specific adapter files are generated under `.agent-hub/generated`.

Do not put secrets in agent-native config files. Agent-native configs should point to:

```bash
.agent-hub/bin/agent-mcp.js <server-name>
```

Secrets are resolved at runtime from `.agent-hub/secrets/.env` or process environment.

## Files

- `registry/mcps.json`: central MCP registry and profile membership.
- `registry/services.json`: service-name to MySQL/Redis DB mapping.
- `registry/instructions.json`: canonical instruction source list.
- `registry/skills.json`: canonical skill roots.
- `bin/agent-mcp.js`: universal stdio MCP launcher.
- `bin/agent-sync.js`: generates Codex, Claude, OpenCode, Copilot adapters.
- `bin/agent-validate.js`: validates registry consistency and checks generated files for obvious secrets.
- `generated/`: generated adapter output. Do not edit manually.
- `secrets/.env.example`: local secret template.

## Profiles

Set `AGENT_HUB_PROFILE` before launching an agent:

```bash
export AGENT_HUB_PROFILE=safe-data
```

Available profiles:

- `offline`: local-only.
- `work`: normal full work profile.
- `safe-data`: read-only data and work tools.
- `groww-manual`: Groww MCP only; use only when Groww access is explicitly needed.

## Manual MCPs

Some MCPs can trigger browser authorization or noisy reconnect behavior. These stay in
the registry, but are marked manual and are not installed into normal agent configs.

Current manual MCPs:

- `growwmcp`: Groww remote MCP via `mcp-remote`.

Check it explicitly without installing it into all agents:

```bash
AGENT_HUB_PROFILE=groww-manual .agent-hub/bin/agent-mcp.js growwmcp --check
```

## Workflow

```bash
cp .agent-hub/secrets/.env.example .agent-hub/secrets/.env
chmod 600 .agent-hub/secrets/.env

node .agent-hub/bin/agent-sync.js
node .agent-hub/bin/agent-validate.js
```

Review `.agent-hub/generated` before installing generated config into live agent config paths.

Check one MCP without starting it:

```bash
.agent-hub/bin/agent-mcp.js staging-mysql --check
```

To migrate values from existing legacy configs without printing secrets:

```bash
node .agent-hub/bin/agent-migrate-secrets.js
```

If `.agent-hub/secrets/.env` already exists, use `--force` only after confirming you want to overwrite it.

Preview live agent config installation without modifying live files:

```bash
node .agent-hub/bin/agent-install.js --plan
node .agent-hub/bin/agent-install.js --dry-run
```

Probe MCP connectivity through the central launcher:

```bash
node .agent-hub/bin/agent-test-mcps.js
```
