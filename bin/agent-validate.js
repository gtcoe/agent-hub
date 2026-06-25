#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const hubDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(hubDir, "..");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(hubDir, rel), "utf8"));
}

function expandPath(input) {
  if (input.startsWith("${HOME}/")) return path.join(os.homedir(), input.slice("${HOME}/".length));
  if (path.isAbsolute(input)) return input;
  return path.join(workspaceRoot, input);
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walkFiles(file, out);
    else out.push(file);
  }
  return out;
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function validateRegistries(errors) {
  const mcps = readJson("registry/mcps.json");
  const instructions = readJson("registry/instructions.json");
  readJson("registry/services.json");
  readJson("registry/skills.json");
  readJson("registry/agents.json");

  for (const [profileName, profile] of Object.entries(mcps.profiles || {})) {
    for (const serverName of profile.servers || []) {
      assert(Boolean(mcps.servers[serverName]), `Profile ${profileName} references unknown MCP server ${serverName}`, errors);
    }
  }

  for (const [serverName, server] of Object.entries(mcps.servers || {})) {
    assert(["stdio", "remote"].includes(server.type), `MCP server ${serverName} has invalid type ${server.type}`, errors);
    if (server.type === "stdio") assert(Boolean(server.command), `MCP server ${serverName} missing command`, errors);
    if (server.type === "remote") assert(Boolean(server.url), `Remote MCP server ${serverName} missing url`, errors);
  }

  for (const source of instructions.sources || []) {
    const abs = expandPath(source.path);
    if (source.required) assert(fs.existsSync(abs), `Required instruction source missing: ${source.path}`, errors);
  }
}

function validateNoSecrets(errors) {
  const files = [
    ...walkFiles(path.join(hubDir, "registry")),
    ...walkFiles(path.join(hubDir, "instructions")),
    ...walkFiles(path.join(hubDir, "generated")),
  ];
  const tokenPatterns = [
    /glpat-[A-Za-z0-9_-]+/,
    /figd_[A-Za-z0-9_-]+/,
    /ATATT[A-Za-z0-9_=.-]+/,
    /redis:\/\/:(?!\$|<|REDACTED|redacted)[^@]+@/i,
  ];
  const assignmentPattern = /["']?([A-Za-z_]*(PASSWORD|PASS|TOKEN|SECRET|API_KEY)[A-Za-z_]*)["']?\s*[:=]\s*["']?([^"',\n]+)["']?/i;
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const isMarkdown = file.endsWith(".md");
    for (const line of lines) {
      if (tokenPatterns.some((pattern) => pattern.test(line))) {
        errors.push(`Potential secret detected in ${path.relative(workspaceRoot, file)}`);
        break;
      }
      if (isMarkdown) continue;
      const assignment = line.match(assignmentPattern);
      if (!assignment) continue;
      const value = assignment[3].trim();
      const safe =
        value === "" ||
        value.startsWith("$") ||
        value.startsWith("<") ||
        value.includes("${") ||
        value.includes("os.Getenv") ||
        /^(REDACTED|redacted|null|undefined)$/i.test(value);
      if (!safe) {
        errors.push(`Potential secret detected in ${path.relative(workspaceRoot, file)}`);
        break;
      }
    }
  }
}

function validateGeneratedJson(errors) {
  const jsonFiles = [
    "generated/copilot/mcp-config.json",
    "generated/claude/settings.mcp.json",
  ];
  for (const rel of jsonFiles) {
    const abs = path.join(hubDir, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`Generated file missing: .agent-hub/${rel}`);
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      errors.push(`Invalid JSON in .agent-hub/${rel}: ${error.message}`);
    }
  }
}

function main() {
  const errors = [];
  validateRegistries(errors);
  validateNoSecrets(errors);
  validateGeneratedJson(errors);

  if (errors.length > 0) {
    console.error("Agent hub validation failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Agent hub validation passed.");
}

main();
