# Agent Hub

Central control plane for agent configuration in this workspace.

Agent Hub keeps MCP servers, instruction layers, and skill sources in one place, then generates agent-specific adapters for Codex, Claude, Copilot, Cursor, and OpenCode.

## Why Agent Hub

- Single source of truth for MCP, instructions, and skills.
- No secret sprawl in agent-native files.
- Consistent setup across multiple coding agents.
- Fast regeneration when adding or updating tools.

## How It Works

```text
registry/* + instructions/* + skills/*
                     |
                     v
          bin/agent-sync.js
                     |
                     v
              generated/*
                     |
                     v
    agent-install -> live agent configs
```

## Project Layout

- `registry/mcps.json`: MCP definitions and profiles.
- `registry/instructions.json`: instruction layers and output mappings.
- `registry/skills.json`: skill roots and generated skill index target.
- `registry/agents.json`: live config targets and install strategies per agent.
- `instructions/`: reusable instruction sources.
- `skills/`: reusable agent skills.
- `bin/agent-mcp.js`: universal MCP launcher.
- `bin/agent-sync.js`: generates all adapter outputs.
- `bin/agent-validate.js`: validates registry and generated artifacts.
- `bin/agent-install.js`: plans, previews, and applies generated configs.
- `generated/`: generated outputs. Treat as build artifacts.
- `secrets/.env.example`: local secret template.

## Quick Start

```bash
cp agent-hub/secrets/.env.example agent-hub/secrets/.env
chmod 600 agent-hub/secrets/.env

node agent-hub/bin/agent-sync.js
node agent-hub/bin/agent-validate.js
```

## Daily Workflow

1. Update source of truth.
   - MCPs: `agent-hub/registry/mcps.json`
   - Instructions: `agent-hub/registry/instructions.json`
   - Skills: `agent-hub/skills/<skill-name>/SKILL.md`
2. Regenerate artifacts.
   - `node agent-hub/bin/agent-sync.js`
3. Validate.
   - `node agent-hub/bin/agent-validate.js`
4. Preview changes to live configs.
   - `node agent-hub/bin/agent-install.js --plan`
   - `node agent-hub/bin/agent-install.js --dry-run`
5. Apply for one agent.
   - `node agent-hub/bin/agent-install.js --apply --agent codex`

## Profiles

Set the runtime profile before launching an agent:

```bash
export AGENT_HUB_PROFILE=safe-data
```

Available profiles:

- `offline`: Local-only setup.
- `work`: Full default profile for normal development.
- `safe-data`: Read-only data access profile.
- `groww-manual`: Groww MCP only.

## Security Model

- Keep secrets only in `agent-hub/secrets/.env` or process environment.
- Do not hardcode credentials in registry or generated files.
- Generated outputs are not the source of truth.
- Prefer `safe-data` profile for routine work.

## Useful Commands

Check one MCP resolves correctly:

```bash
agent-hub/bin/agent-mcp.js staging-mysql --check
```

Probe MCP connectivity through the central launcher:

```bash
node agent-hub/bin/agent-test-mcps.js
```

Migrate existing local secrets into Agent Hub format:

```bash
node agent-hub/bin/agent-migrate-secrets.js
```

## Troubleshooting

### Warning: instruction source not found under `.agent-hub/...`

If sync prints missing source warnings with `.agent-hub` paths while your folder is `agent-hub`, update source paths in `agent-hub/registry/instructions.json` (and any related registry files) to the active directory name.

### Copilot CLI hangs while loading MCP servers

Use MCP server timeouts in Copilot config and keep generated config installed from Agent Hub.

### MCP server works in one agent but not another

Run `--dry-run` install and compare each agent's live config target defined in `agent-hub/registry/agents.json`.

## Supported Agents

- Codex
- Claude
- GitHub Copilot
- Cursor
- OpenCode

For full setup and migration details, see `agent-hub/SETUP.md` and `agent-hub/MIGRATION.md`.
