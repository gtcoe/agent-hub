#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const hubDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(hubDir, "..");
const previewRoot = path.join(hubDir, "generated", "install-preview");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function expandPath(input) {
  if (input.startsWith("${HOME}/")) {
    return path.join(os.homedir(), input.slice("${HOME}/".length));
  }
  if (path.isAbsolute(input)) return input;
  return path.join(workspaceRoot, input);
}

function relative(file) {
  if (file.startsWith(workspaceRoot)) return path.relative(workspaceRoot, file);
  return file.replace(os.homedir(), "~");
}

function writePreview(agentName, livePath, content) {
  const target = path.join(previewRoot, agentName, livePath.replace(/^\//, ""));
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content);
  return target;
}

function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonLike(text, file) {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`Could not parse ${relative(file)}: ${error.message}`);
  }
}

function replaceJsonObject(livePath, generatedPath, mergeKey) {
  const liveText = readText(livePath);
  const live = liveText ? parseJsonLike(liveText, livePath) : {};
  const generated = readJson(generatedPath);
  const merged = { ...live };
  merged[mergeKey] = generated[mergeKey] || {};
  return JSON.stringify(merged, null, 2) + "\n";
}

function mergeCopilot(livePath, generatedPath) {
  const liveText = readText(livePath);
  const live = liveText ? parseJsonLike(liveText, livePath) : {};
  const generated = readJson(generatedPath);
  return JSON.stringify({ ...live, mcpServers: generated.mcpServers }, null, 2) + "\n";
}

function stripManagedCodexMcpBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const isMcpHeader = /^\[mcp_servers(?:\.|\])/.test(line);
    const isManagedMarker = line.trim() === "# Agent Hub managed MCP blocks. Do not edit manually.";
    const isAnyHeader = /^\[.+\]/.test(line);
    if (isMcpHeader || isManagedMarker) {
      skipping = true;
      continue;
    }
    if (skipping && isAnyHeader) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function mergeCodex(livePath, generatedPath) {
  const liveText = readText(livePath);
  const generated = readText(generatedPath).trim();
  const base = stripManagedCodexMcpBlocks(liveText);
  return `${base}\n\n# Agent Hub managed MCP blocks. Do not edit manually.\n${generated}\n`;
}

function previewForAgent(agentName, agent) {
  const livePath = expandPath(agent.liveConfig);
  const generatedPath = expandPath(agent.generatedMcpConfig);
  if (!fs.existsSync(generatedPath)) {
    throw new Error(`Missing generated config for ${agentName}: ${relative(generatedPath)}`);
  }

  let content;
  if (agentName === "codex") {
    content = mergeCodex(livePath, generatedPath);
  } else if (agentName === "claude") {
    content = replaceJsonObject(livePath, generatedPath, "mcpServers");
  } else if (agentName === "opencode") {
    content = replaceJsonObject(livePath, generatedPath, "mcp");
  } else if (agentName === "github-copilot") {
    content = mergeCopilot(livePath, generatedPath);
  } else if (agentName === "cursor") {
    content = mergeCopilot(livePath, generatedPath); // same JSON shape as copilot
  } else {
    throw new Error(`No installer adapter for ${agentName}`);
  }

  const previewPath = writePreview(agentName, livePath, content);
  const liveText = readText(livePath);
  return {
    agentName,
    livePath,
    generatedPath,
    previewPath,
    liveExists: fs.existsSync(livePath),
    changed: liveText !== content,
    bytesBefore: Buffer.byteLength(liveText),
    bytesAfter: Buffer.byteLength(content),
  };
}

function planRows(agents, selected) {
  const rows = [];
  for (const [agentName, agent] of Object.entries(agents)) {
    if (selected !== "all" && selected !== agentName) continue;
    rows.push({
      agentName,
      liveConfig: expandPath(agent.liveConfig),
      generatedMcpConfig: expandPath(agent.generatedMcpConfig),
      installStrategy: agent.installStrategy,
    });
  }
  return rows;
}

function printPlan(rows) {
  console.log("Agent install plan:");
  for (const row of rows) {
    console.log(`- ${row.agentName}`);
    console.log(`  live: ${relative(row.liveConfig)}`);
    console.log(`  generated: ${relative(row.generatedMcpConfig)}`);
    console.log(`  strategy: ${row.installStrategy}`);
  }
}

function printResults(results) {
  console.log("Generated install previews:");
  for (const result of results) {
    console.log(`- ${result.agentName}: ${result.changed ? "changes pending" : "already matches"}`);
    console.log(`  live: ${relative(result.livePath)}${result.liveExists ? "" : " (missing)"}`);
    console.log(`  preview: ${relative(result.previewPath)}`);
    console.log(`  size: ${result.bytesBefore} -> ${result.bytesAfter} bytes`);
  }
}

function backupPath(livePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(hubDir, "backups", stamp, livePath.replace(/^\//, ""));
  ensureDir(path.dirname(target));
  return target;
}

function applyResults(results) {
  for (const result of results) {
    if (result.liveExists) {
      const backup = backupPath(result.livePath);
      fs.copyFileSync(result.livePath, backup);
      console.log(`Backed up ${relative(result.livePath)} -> ${relative(backup)}`);
    }
    ensureDir(path.dirname(result.livePath));
    fs.copyFileSync(result.previewPath, result.livePath);
    console.log(`Installed ${relative(result.livePath)}`);
  }
}

function installCursorInstructions(agent, agentsRegistry) {
  const agentCfg = agentsRegistry.agents && agentsRegistry.agents["cursor"];
  if (!agentCfg || !agentCfg.instructionInstallPath || !agentCfg.generatedInstructions) return;
  const src = expandPath(agentCfg.generatedInstructions);
  const dst = expandPath(agentCfg.instructionInstallPath);
  if (!fs.existsSync(src)) {
    console.warn(`Cursor instruction source missing: ${relative(src)}`);
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log(`Installed cursor instructions: ${relative(dst)}`);
}

function installSkillsCopilot(hubDir, workspaceRoot) {
  const skillsDir = path.join(hubDir, "skills");
  const githubSkillsDir = path.join(workspaceRoot, ".github", "skills");
  if (!fs.existsSync(skillsDir)) { console.log("No skills in hub yet."); return; }
  ensureDir(githubSkillsDir);
  let count = 0;
  for (const name of fs.readdirSync(skillsDir)) {
    const src = path.join(skillsDir, name);
    const dst = path.join(githubSkillsDir, name);
    if (!fs.statSync(src).isDirectory()) continue;
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.symlinkSync(src, dst);
    console.log(`Symlinked .github/skills/${name} → ${relative(src)}`);
    count++;
  }
  console.log(`Installed ${count} skill symlinks in .github/skills/`);
}

function installSkillsCodex(hubDir) {
  const skillsDir = path.join(hubDir, "skills");
  const generatedToml = path.join(hubDir, "generated", "codex", "config.mcp.toml");
  if (!fs.existsSync(generatedToml)) { console.log("Run agent-sync.js first to generate codex config."); return; }
  console.log(`Codex skill_paths are embedded in the generated TOML. Apply codex config to activate:`);
  console.log(`  node .agent-hub/bin/agent-install.js --apply --agent codex`);
  const skillsContent = fs.readFileSync(generatedToml, "utf8");
  const match = skillsContent.match(/skill_paths\s*=\s*\[([^\]]+)\]/);
  if (match) console.log(`  skill_paths = [${match[1].trim()}]`);
}

function parseArgs(argv) {
  const out = { mode: "dry-run", agent: "all", skills: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") out.mode = "plan";
    else if (arg === "--dry-run") out.mode = "dry-run";
    else if (arg === "--apply") out.mode = "apply";
    else if (arg === "--skills") out.skills = true;
    else if (arg === "--agent") {
      out.agent = argv[i + 1] || "all";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.mode = "help";
    }
  }
  return out;
}

function help() {
  console.log(`Usage:
  node .agent-hub/bin/agent-install.js --plan
  node .agent-hub/bin/agent-install.js --dry-run [--agent codex|claude|opencode|github-copilot|cursor|all]
  node .agent-hub/bin/agent-install.js --apply --agent <name>
  node .agent-hub/bin/agent-install.js --skills [--agent codex|github-copilot]

--skills installs skill references:
  codex         → shows skill_paths block to add to config
  github-copilot → creates symlinks in .github/skills/

Dry-run writes proposed merged configs under .agent-hub/generated/install-preview.
Apply backs up live configs under .agent-hub/backups before writing.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    help();
    return;
  }

  const agentsRegistry = readJson(path.join(hubDir, "registry", "agents.json"));
  const agents = agentsRegistry.agents || {};

  if (args.skills) {
    const target = args.agent;
    if (target === "all" || target === "github-copilot") installSkillsCopilot(hubDir, workspaceRoot);
    if (target === "all" || target === "codex") installSkillsCodex(hubDir);
    return;
  }

  if (args.agent !== "all" && !agents[args.agent]) {
    console.error(`Unknown agent "${args.agent}". Known: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const rows = planRows(agents, args.agent);
  if (args.mode === "plan") {
    printPlan(rows);
    return;
  }

  const results = rows.map((row) => previewForAgent(row.agentName, agents[row.agentName]));
  printResults(results);

  if (args.mode === "apply") {
    if (args.agent === "all") {
      console.error("Refusing --apply for all agents. Apply one agent at a time after reviewing previews.");
      process.exit(1);
    }
    applyResults(results);
    if (args.agent === "cursor") {
      installCursorInstructions(args.agent, agentsRegistry);
    }
  } else {
    console.log("No live config files were modified.");
  }
}

main();
