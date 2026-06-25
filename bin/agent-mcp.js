#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const hubDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(hubDir, "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function runtimeEnv() {
  const defaults = {
    HOME: os.homedir(),
    PWD: process.cwd(),
    AGENT_HUB_DIR: hubDir,
    WORKSPACE_ROOT: workspaceRoot,
    PATH: process.env.PATH || "",
  };
  const envFiles = [
    path.join(hubDir, "secrets", ".env"),
    path.join(os.homedir(), ".agent-hub", "secrets", ".env"),
  ];
  const env = { ...defaults };
  for (const file of envFiles) {
    Object.assign(env, parseEnvFile(file));
  }
  Object.assign(env, process.env);
  return env;
}

function expand(value, env) {
  if (typeof value !== "string") return value;
  let previous;
  let current = value;
  for (let i = 0; i < 5; i += 1) {
    previous = current;
    current = current.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, key, _d, fallback) => {
      const found = env[key];
      if (found !== undefined && found !== "") return found;
      return fallback !== undefined ? fallback : "";
    });
    if (current === previous) break;
  }
  return current;
}

function expandObject(obj, env) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    out[key] = expand(value, env);
  }
  return out;
}

function findServiceName(cwd) {
  return path.basename(cwd);
}

function applyServiceEnv(server, services, env) {
  const serviceName = findServiceName(process.cwd());
  for (const [envKey, mapName] of Object.entries(server.serviceEnv || {})) {
    if (env[envKey]) continue;
    const serviceMap = services[mapName] || {};
    if (serviceMap[serviceName] !== undefined) {
      env[envKey] = String(serviceMap[serviceName]);
    }
  }
}

function unresolved(values) {
  return values.filter((value) => typeof value === "string" && value.includes("${"));
}

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/redis:\/\/:[^@]+@/g, "redis://:<redacted>@")
    .replace(/glpat-[A-Za-z0-9_-]+/g, "<redacted-gitlab-token>")
    .replace(/figd_[A-Za-z0-9_-]+/g, "<redacted-figma-token>")
    .replace(/ATATT[A-Za-z0-9_=.-]+/g, "<redacted-atlassian-token>")
    .replace(/(TOKEN|PASSWORD|PASS|SECRET|API_KEY)=([^,\s]+)/gi, "$1=<redacted>");
}

function redactArgs(args) {
  return args.map((arg, index) => {
    const previous = args[index - 1] || "";
    if (/(token|password|pass|secret|api[-_]?key|key)$/i.test(previous)) {
      return "<redacted>";
    }
    return redact(arg);
  });
}

function main() {
  const serverName = process.argv[2];
  if (!serverName) {
    console.error("Usage: agent-mcp.js <server-name>");
    process.exit(2);
  }

  const registry = readJson(path.join(hubDir, "registry", "mcps.json"));
  const services = readJson(path.join(hubDir, "registry", "services.json"));
  const server = registry.servers && registry.servers[serverName];
  if (!server) {
    console.error(`Unknown MCP server "${serverName}" in .agent-hub/registry/mcps.json`);
    process.exit(1);
  }
  if (server.type !== "stdio") {
    console.error(`MCP server "${serverName}" is type "${server.type}". It is not launchable through agent-mcp.js.`);
    process.exit(1);
  }

  const profileName = process.env.AGENT_HUB_PROFILE || registry.defaultProfile || "work";
  const profile = registry.profiles && registry.profiles[profileName];
  if (!profile) {
    console.error(`Unknown AGENT_HUB_PROFILE "${profileName}".`);
    process.exit(1);
  }
  if (!process.env.AGENT_HUB_IGNORE_PROFILE && !profile.servers.includes(serverName)) {
    console.error(`MCP server "${serverName}" is not enabled in profile "${profileName}".`);
    process.exit(1);
  }

  const env = runtimeEnv();
  applyServiceEnv(server, services, env);

  const command = expand(server.command, env);
  const args = (server.args || []).map((arg) => expand(arg, env));
  const childEnv = {
    ...process.env,
    ...env,
    ...expandObject(server.env, env),
  };

  const badValues = unresolved([command, ...args, ...Object.values(childEnv)]);
  if (badValues.length > 0) {
    console.error(`MCP server "${serverName}" has unresolved variables: ${badValues.slice(0, 3).join(", ")}`);
    process.exit(1);
  }
  if (!command) {
    console.error(`MCP server "${serverName}" has no command after expansion.`);
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    const serverEnvKeys = Object.keys(server.env || {});
    const serviceEnvKeys = Object.keys(server.serviceEnv || {});
    console.log(`MCP server "${serverName}" resolves under profile "${profileName}".`);
    console.log(`command: ${redact(command)}`);
    console.log(`args: ${redactArgs(args).join(" ")}`);
    if (serviceEnvKeys.length > 0) console.log(`service env: ${serviceEnvKeys.join(", ")}`);
    if (serverEnvKeys.length > 0) console.log(`server env: ${serverEnvKeys.join(", ")}`);
    return;
  }

  const child = spawn(command, args, {
    env: childEnv,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Failed to start MCP server "${serverName}": ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
