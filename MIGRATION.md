# Agent Hub Migration

This tracks the move from per-agent duplicated config to the central `.agent-hub` registry.

## Inventory Found

- GitHub Copilot
  - Config: `~/.copilot/settings.json`, `~/.copilot/mcp-config.json`
  - Existing mode switcher: `~/.copilot/mcp-mode.sh`
  - Existing launcher idea: `~/.copilot/codex-mcp-launcher.js`
- Codex
  - Config: `~/.codex/config.toml`
  - Already uses Copilot MCP launcher for several servers.
- OpenCode
  - Config: `~/.config/opencode/opencode.jsonc`
  - Has duplicated MCP definitions and inline environment values.
- Claude Code
  - Config: `~/.claude/settings.json`
  - Has a small MCP set and one `gopls` plugin.
- Repo-local MCPs
  - Config: `.mcp.json`
  - Contains many stage4 MySQL and Redis entries.
- Instructions
  - Primary source today: `.github/copilot-instructions.md`
  - Additional scoped instructions: `.github/instructions/*.instructions.md`
  - Prompt packs: `.github/prompts/**`
- Skills
  - Repo-local: `.agents/skills`
  - User-level: `~/.agents/skills`
  - Codex system: `~/.codex/skills/.system`
  - Claude plugins: `~/.claude/plugins`

## Phase 1 Completed

- Created `.agent-hub/registry/mcps.json`.
- Created `.agent-hub/registry/services.json`.
- Created `.agent-hub/registry/instructions.json`.
- Created `.agent-hub/registry/skills.json`.
- Created `.agent-hub/registry/agents.json`.
- Created `.agent-hub/bin/agent-mcp.js`.
- Created `.agent-hub/bin/agent-sync.js`.
- Created `.agent-hub/bin/agent-validate.js`.
- Created `.agent-hub/secrets/.env.example`.
- Generated initial adapters under `.agent-hub/generated`.
- Added setup guide for future/new agents.

## Phase 2 Completed

- Added `.agent-hub/bin/agent-migrate-secrets.js`.
- Generated `.agent-hub/secrets/.env` from existing legacy configs without printing secret values.
- Set `.agent-hub/secrets/.env` permissions to `600`.
- Verified representative MCPs with `agent-mcp.js <server> --check`.
- Verified `AGENT_HUB_PROFILE=offline` blocks staging DB access.

## Phase 3 Completed

- Added `.agent-hub/bin/agent-install.js`.
- Added `.agent-hub/bin/agent-test-mcps.js`.
- Generated merged previews under `.agent-hub/generated/install-preview`.
- Preserved existing non-MCP live settings while replacing MCP adapter blocks.
- Added backup behavior for eventual `--apply`.
- Verified preview Codex TOML parses.
- Verified preview Claude/OpenCode/Copilot JSON parses.
- Verified previews do not contain common raw token patterns.
- Recorded MCP probe results in `.agent-hub/MCP_TEST_REPORT.md`.

## Remaining Phases

### Phase 2 Follow-Up: Legacy Secret Cleanup

- Rotate any credentials that were stored inline in configs.
- Remove old plaintext secret values from legacy wrappers once live agents use `.agent-hub/bin/agent-mcp.js`.

### Phase 4: Live Agent Adapter Installation

- Back up current live config files.
- [x] Merge generated Codex MCP blocks into `~/.codex/config.toml`.
- [x] Merge generated Claude `mcpServers` into `~/.claude/settings.json`.
- [x] Merge generated OpenCode `mcp` into `~/.config/opencode/opencode.jsonc`.
- [x] Replace or merge Copilot `~/.copilot/mcp-config.json`.
- Keep model/personality/theme settings in each agent's native config.

Codex backup:

```text
.agent-hub/backups/2026-06-10T12-02-14-639Z/Users/garvittyagi/.codex/config.toml
```

GitHub Copilot backup:

```text
.agent-hub/backups/2026-06-10T12-19-51-113Z/Users/garvittyagi/.copilot/mcp-config.json
```

Claude backup:

```text
.agent-hub/backups/2026-06-10T11-59-34-090Z/Users/garvittyagi/.claude/settings.json
```

OpenCode backup:

```text
.agent-hub/backups/2026-06-10T11-53-16-516Z/Users/garvittyagi/.config/opencode/opencode.jsonc
```

Prod ClickHouse addition backups:

```text
.agent-hub/backups/2026-06-11T06-42-05-481Z/Users/garvittyagi/.codex/config.toml
.agent-hub/backups/2026-06-11T06-42-16-822Z/Users/garvittyagi/.claude/settings.json
.agent-hub/backups/2026-06-11T06-42-26-576Z/Users/garvittyagi/.config/opencode/opencode.jsonc
.agent-hub/backups/2026-06-11T06-42-36-918Z/Users/garvittyagi/.copilot/mcp-config.json
```

### Phase 5: Instruction Migration

- Promote `.agent-hub/generated/instructions/AGENTS.md` or a reviewed copy to root `AGENTS.md`.
- Decide whether `.github/copilot-instructions.md` remains source or becomes generated output.
- Move new shared rules into `.agent-hub/instructions`.

### Phase 6: Skill Migration

- Move custom skills from `.agents/skills` into `.agent-hub/skills`.
- Symlink/copy central skills to agent-specific skill directories as supported.
- Leave vendor/system skills unmanaged.

## Acceptance Criteria

- Adding one MCP entry to `.agent-hub/registry/mcps.json` and running sync updates all generated agent configs.
- Adding one instruction source to `.agent-hub/registry/instructions.json` and running sync updates all generated instruction files.
- Adding one skill under `.agent-hub/skills/<name>/SKILL.md` and running sync updates the generated skill index.
- No live agent config contains raw secrets.
- `node .agent-hub/bin/agent-validate.js` passes.
