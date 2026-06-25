# Agent Hub Core Instructions

This workspace uses `.agent-hub` as the central source of truth for coding-agent setup.

## Agent Configuration Rules

- MCP servers are declared only in `.agent-hub/registry/mcps.json`.
- Secret values are loaded only from `.agent-hub/secrets/.env` or process environment.
- Repo and team instructions are declared only through `.agent-hub/registry/instructions.json`.
- New reusable skills should be added under `.agent-hub/skills/<skill-name>/SKILL.md`.
- Generated files under `.agent-hub/generated` are adapter output, not source of truth.

## Before Changing Agent Setup

1. Update the central registry or central skill/instruction source.
2. Run `node .agent-hub/bin/agent-sync.js`.
3. Run `node .agent-hub/bin/agent-validate.js`.
4. Install generated adapters into the agent-specific config locations only after reviewing the diff.

## Security

Never place tokens, passwords, API keys, private keys, or Redis URLs with embedded passwords in agent-native config files. Agent-native configs should point to `.agent-hub/bin/agent-mcp.js`; the launcher resolves secrets at runtime.
