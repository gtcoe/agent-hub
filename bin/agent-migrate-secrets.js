#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const hubDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(hubDir, "..");
const envExample = path.join(hubDir, "secrets", ".env.example");
const envTarget = path.join(hubDir, "secrets", ".env");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  const text = read(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unquote(value) {
  if (value === undefined || value === null) return "";
  let out = String(value).trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  return out;
}

function setValue(values, key, value, source) {
  const clean = unquote(value);
  if (!clean) return;
  if (clean.includes("<redacted>")) return;
  if (values[key] && values[key] !== clean) return;
  values[key] = clean;
  source.keys.add(key);
}

function parseEnvText(text, values, source) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = unquote(match[2]);
    const map = {
      MYSQL_HOST: "STAGING_MYSQL_HOST",
      MYSQL_PORT: "STAGING_MYSQL_PORT",
      MYSQL_USER: "STAGING_MYSQL_USER",
      MYSQL_PASS: "STAGING_MYSQL_PASS",
      REDIS_HOST: "STAGING_REDIS_HOST",
      REDIS_PORT: "STAGING_REDIS_PORT",
      REDIS_PASSWORD: "STAGING_REDIS_PASSWORD",
      CLICKHOUSE_HOST_URL: "STAGING_CLICKHOUSE_HOST_URL",
      CLICKHOUSE_USER: "STAGING_CLICKHOUSE_USER",
      CLICKHOUSE_PASSWORD: "STAGING_CLICKHOUSE_PASSWORD",
      CLICKHOUSE_DATABASE: "STAGING_CLICKHOUSE_DATABASE",
      CLICKHOUSE_SECURE: "STAGING_CLICKHOUSE_SECURE",
      CLICKHOUSE_VERIFY: "STAGING_CLICKHOUSE_VERIFY",
    };
    setValue(values, map[key] || key, value, source);
  }
}

function extractExportInCase(shellText, caseName, exportName) {
  const caseMatch = shellText.match(new RegExp(`${caseName}\\)\\n([\\s\\S]*?)(?:\\n\\s*;;)`, "m"));
  if (!caseMatch) return "";
  const body = caseMatch[1];
  const exportMatch = body.match(new RegExp(`export\\s+${exportName}=([^\\n]+)`));
  return exportMatch ? unquote(exportMatch[1]) : "";
}

function parseMysqlWrapper(values, source) {
  const text = read(path.join(os.homedir(), ".copilot", "mysql-mcp.sh"));
  if (!text) return;
  setValue(values, "LOCAL_MYSQL_PASS", extractExportInCase(text, "local", "MYSQL_PASS"), source);
  setValue(values, "STAGING_MYSQL_PASS", extractExportInCase(text, "staging", "MYSQL_PASS"), source);
  setValue(values, "PROD_MYSQL_PASS", extractExportInCase(text, "prod", "MYSQL_PASS"), source);
  setValue(values, "PROD_MYSQL_USER", extractExportInCase(text, "prod", "MYSQL_USER"), source);

  const localPort = text.match(/LOCAL_PORT=([0-9]+)/);
  const tunnel = text.match(/-L\s+\$\{LOCAL_PORT\}:([^:]+):([0-9]+)/);
  const key = text.match(/-i\s+([^\s\\]+)/);
  const bastion = text.match(/([A-Za-z0-9_.-]+)@([0-9.]+|[A-Za-z0-9_.-]+)/);
  if (localPort) setValue(values, "PROD_MYSQL_LOCAL_PORT", localPort[1], source);
  if (tunnel) {
    setValue(values, "PROD_MYSQL_REMOTE_HOST", tunnel[1], source);
    setValue(values, "PROD_MYSQL_REMOTE_PORT", tunnel[2], source);
  }
  if (key) setValue(values, "PROD_SSH_KEY_PATH", key[1], source);
  if (bastion) {
    setValue(values, "PROD_SSH_USER", bastion[1], source);
    setValue(values, "PROD_BASTION_HOST", bastion[2], source);
  }
}

function parseMcpJson(file, values, source) {
  const json = readJson(file);
  if (!json) return;
  const servers = json.mcpServers || json.mcp || {};
  for (const [name, server] of Object.entries(servers)) {
    const env = server.env || server.environment || {};
    if (env.CLICKHOUSE_HOST) setValue(values, "STAGING_CLICKHOUSE_HOST", env.CLICKHOUSE_HOST, source);
    if (env.CLICKHOUSE_HOST_URL) setValue(values, "STAGING_CLICKHOUSE_HOST_URL", env.CLICKHOUSE_HOST_URL, source);
    if (env.CLICKHOUSE_PORT) setValue(values, "STAGING_CLICKHOUSE_PORT", env.CLICKHOUSE_PORT, source);
    if (env.CLICKHOUSE_USER) setValue(values, "STAGING_CLICKHOUSE_USER", env.CLICKHOUSE_USER, source);
    if (env.CLICKHOUSE_PASSWORD) setValue(values, "STAGING_CLICKHOUSE_PASSWORD", env.CLICKHOUSE_PASSWORD, source);
    if (env.CLICKHOUSE_DATABASE) setValue(values, "STAGING_CLICKHOUSE_DATABASE", env.CLICKHOUSE_DATABASE, source);
    if (env.CLICKHOUSE_SECURE) setValue(values, "STAGING_CLICKHOUSE_SECURE", env.CLICKHOUSE_SECURE, source);
    if (env.CLICKHOUSE_VERIFY) setValue(values, "STAGING_CLICKHOUSE_VERIFY", env.CLICKHOUSE_VERIFY, source);
    if (env.GITLAB_PERSONAL_ACCESS_TOKEN) setValue(values, "GITLAB_PERSONAL_ACCESS_TOKEN", env.GITLAB_PERSONAL_ACCESS_TOKEN, source);
    if (env.GITLAB_API_URL) setValue(values, "GITLAB_API_URL", env.GITLAB_API_URL, source);
    if (env.FIGMA_API_KEY) setValue(values, "FIGMA_API_KEY", env.FIGMA_API_KEY, source);
    if (env.KAFKA_BROKERS) setValue(values, "STAGING_KAFKA_BROKERS", env.KAFKA_BROKERS, source);
    if (env.MYSQL_PASS && name.includes("stage")) setValue(values, "STAGING_MYSQL_PASS", env.MYSQL_PASS, source);

    const args = server.args || server.command || [];
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--jira-url") setValue(values, "JIRA_URL", args[i + 1], source);
        if (args[i] === "--jira-username") setValue(values, "JIRA_USERNAME", args[i + 1], source);
        if (args[i] === "--jira-token") setValue(values, "JIRA_TOKEN", args[i + 1], source);
        const redis = String(args[i]).match(/^redis:\/\/:([^@]+)@([^:/]+):([0-9]+)\/([0-9]+)$/);
        if (redis) {
          setValue(values, "STAGING_REDIS_PASSWORD", redis[1], source);
          setValue(values, "STAGING_REDIS_HOST", redis[2], source);
          setValue(values, "STAGING_REDIS_PORT", redis[3], source);
        }
      }
    }
  }
}

function parseClaudeSettings(values, source) {
  const json = readJson(path.join(os.homedir(), ".claude", "settings.json"));
  if (!json) return;
  const servers = json.mcpServers || {};
  for (const server of Object.values(servers)) {
    const args = server.args || [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--jira-url") setValue(values, "JIRA_URL", args[i + 1], source);
      if (args[i] === "--jira-username") setValue(values, "JIRA_USERNAME", args[i + 1], source);
      if (args[i] === "--jira-token") setValue(values, "JIRA_TOKEN", args[i + 1], source);
    }
  }
}

function renderEnv(values) {
  const template = read(envExample);
  return template
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return line;
      const key = match[1];
      if (!(key in values)) return line;
      return `${key}=${values[key]}`;
    })
    .join("\n")
    .replace(/\n*$/, "\n");
}

function main() {
  if (!fs.existsSync(envExample)) {
    console.error("Missing .agent-hub/secrets/.env.example");
    process.exit(1);
  }
  if (fs.existsSync(envTarget) && !process.argv.includes("--force")) {
    console.error(".agent-hub/secrets/.env already exists. Re-run with --force to overwrite.");
    process.exit(1);
  }

  const source = { keys: new Set() };
  const values = {};

  parseEnvText(read(path.join(os.homedir(), ".copilot", "staging.env")), values, source);
  parseMysqlWrapper(values, source);
  parseMcpJson(path.join(os.homedir(), ".copilot", "mcp-config.json"), values, source);
  parseMcpJson(path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"), values, source);
  parseMcpJson(path.join(workspaceRoot, ".mcp.json"), values, source);
  parseClaudeSettings(values, source);

  fs.writeFileSync(envTarget, renderEnv(values), { mode: 0o600 });
  fs.chmodSync(envTarget, 0o600);

  console.log(`Wrote .agent-hub/secrets/.env with ${source.keys.size} populated keys.`);
  console.log("Secret values were not printed.");
}

main();
