#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const hubDir = path.resolve(__dirname, "..");
const runDir = path.join(hubDir, "run");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function runtimeEnv() {
  const defaults = { HOME: os.homedir(), AGENT_HUB_DIR: hubDir, PATH: process.env.PATH || "" };
  const env = { ...defaults };
  for (const file of [path.join(hubDir, "secrets", ".env"), path.join(os.homedir(), ".agent-hub", "secrets", ".env")]) {
    Object.assign(env, parseEnvFile(file));
  }
  Object.assign(env, process.env);
  return env;
}

function expand(value, env) {
  if (typeof value !== "string") return value;
  let prev, cur = value;
  for (let i = 0; i < 5; i++) {
    prev = cur;
    cur = cur.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_, key, _d, fallback) => {
      const found = env[key];
      if (found !== undefined && found !== "") return found;
      return fallback !== undefined ? fallback : "";
    });
    if (cur === prev) break;
  }
  return cur;
}

function pidFile(tunnelName) {
  fs.mkdirSync(runDir, { recursive: true });
  return path.join(runDir, `tunnel-${tunnelName}.pid`);
}

function readPid(tunnelName) {
  const f = pidFile(tunnelName);
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, "utf8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function writePid(tunnelName, pid) {
  fs.writeFileSync(pidFile(tunnelName), String(pid));
}

function clearPid(tunnelName) {
  try { fs.unlinkSync(pidFile(tunnelName)); } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function testPortConnectable(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.connect(port, host, () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf8" }).trim();
    if (pids) {
      for (const p of pids.split(/\s+/).filter(Boolean)) {
        try { process.kill(parseInt(p, 10), "SIGTERM"); } catch {}
      }
    }
  } catch {}
}

function resolveTunnel(tunnelName, mcpRegistry, env) {
  const server = mcpRegistry.servers && mcpRegistry.servers[tunnelName];
  const tunnel = server && server.tunnel;
  if (!tunnel) {
    for (const [name, srv] of Object.entries(mcpRegistry.servers || {})) {
      if (srv.tunnel && srv.tunnel.name === tunnelName) return resolveFields(srv.tunnel, env);
    }
    return null;
  }
  return resolveFields(tunnel, env);
}

function resolveFields(tunnel, env) {
  const out = {};
  for (const [k, v] of Object.entries(tunnel)) {
    out[k] = expand(v, env);
  }
  return out;
}

function listTunnels(mcpRegistry) {
  const out = [];
  for (const [name, server] of Object.entries(mcpRegistry.servers || {})) {
    if (server.tunnel) out.push({ name, tunnel: server.tunnel });
  }
  return out;
}

async function statusTunnel(tunnelName, env) {
  const mcpRegistry = readJson(path.join(hubDir, "registry", "mcps.json"));
  const tunnel = resolveTunnel(tunnelName, mcpRegistry, env);
  if (!tunnel) {
    console.log(`UNKNOWN ${tunnelName}: no tunnel config found in registry`);
    return false;
  }
  const port = parseInt(tunnel.localPort, 10);
  const pid = readPid(tunnelName);
  const pidAlive = pid ? isProcessAlive(pid) : false;
  const connectable = await testPortConnectable(port);
  const ok = connectable;

  if (ok) {
    console.log(`UP      ${tunnelName}: port=${port} connectable${pid ? ` pid=${pid}` : ""}`);
  } else {
    console.log(`DOWN    ${tunnelName}: port=${port} not connectable${pid ? ` pid=${pid} alive=${pidAlive}` : " (no pid)"}`);
  }
  return ok;
}

function validateTunnelFields(tunnelName, tunnel) {
  const required = ["localPort", "remoteHost", "remotePort", "sshKey", "sshUser", "bastionHost"];
  const missing = required.filter((k) => !tunnel[k]);
  if (missing.length > 0) {
    console.error(`agent-tunnel: tunnel "${tunnelName}" is missing required fields: ${missing.join(", ")}`);
    console.error(`  Check .agent-hub/secrets/.env for the corresponding env vars.`);
    process.exit(1);
  }
}

async function ensureTunnel(tunnelName, env) {
  const mcpRegistry = readJson(path.join(hubDir, "registry", "mcps.json"));
  const tunnel = resolveTunnel(tunnelName, mcpRegistry, env);
  if (!tunnel) {
    console.error(`agent-tunnel: no tunnel config for "${tunnelName}" in registry (mcps.json)`);
    process.exit(1);
  }

  validateTunnelFields(tunnelName, tunnel);
  const port = parseInt(tunnel.localPort, 10);

  // Port-first check: if connectable, tunnel is working regardless of PID state.
  if (await testPortConnectable(port)) {
    return;
  }

  // Tunnel is down. Kill any stale tracked process and anything holding the port.
  const pid = readPid(tunnelName);
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    clearPid(tunnelName);
  }
  killPort(port);
  // Brief pause to let OS release the port.
  await new Promise((r) => setTimeout(r, 400));

  // Start autossh. -f forks to background immediately (parent exits 0).
  const sshArgs = [
    "-M", "0",
    "-f", "-N",
    "-L", `${port}:${tunnel.remoteHost}:${tunnel.remotePort}`,
    "-i", tunnel.sshKey,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    `${tunnel.sshUser}@${tunnel.bastionHost}`,
  ];

  const result = spawnSync("autossh", sshArgs, {
    env: { ...process.env, AUTOSSH_GATETIME: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });

  if (result.error || (result.status !== null && result.status !== 0)) {
    const errMsg = result.error
      ? result.error.message
      : (result.stderr ? result.stderr.toString().trim() : `exit code ${result.status}`);
    console.error(`agent-tunnel: autossh failed to start tunnel "${tunnelName}": ${errMsg}`);
    if (result.error && result.error.code === "ENOENT") {
      console.error("  autossh is not installed. Install with: brew install autossh");
    }
    process.exit(1);
  }

  // Poll until port is connectable. autossh -f is background so SSH negotiation takes time.
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await testPortConnectable(port)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    console.error(`agent-tunnel: tunnel "${tunnelName}" started but port ${port} was not connectable after 15s`);
    console.error(`  Check bastion connectivity and SSH key: ${tunnel.sshKey}`);
    process.exit(1);
  }

  // Record the PID of the SSH process listening on the port so we can kill it cleanly.
  try {
    const pids = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf8" }).trim();
    const firstPid = pids.split(/\s+/).filter(Boolean)[0];
    if (firstPid) writePid(tunnelName, parseInt(firstPid, 10));
  } catch {}
}

async function killTunnel(tunnelName, env) {
  const mcpRegistry = readJson(path.join(hubDir, "registry", "mcps.json"));
  const tunnel = resolveTunnel(tunnelName, mcpRegistry, env);
  const port = tunnel ? parseInt(tunnel.localPort, 10) : null;

  const pid = readPid(tunnelName);
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    clearPid(tunnelName);
    console.log(`killed pid ${pid} for tunnel "${tunnelName}"`);
  }
  if (port) {
    killPort(port);
    console.log(`cleared port ${port}`);
  }
  if (!pid && !port) {
    console.log(`nothing to kill for "${tunnelName}"`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const env = runtimeEnv();

  if (!command || command === "list") {
    const mcpRegistry = readJson(path.join(hubDir, "registry", "mcps.json"));
    const tunnels = listTunnels(mcpRegistry);
    if (tunnels.length === 0) { console.log("No tunnels configured."); return; }
    for (const { name } of tunnels) {
      await statusTunnel(name, env);
    }
    return;
  }

  if (command === "status") {
    const name = args[0];
    if (!name) {
      const mcpRegistry = readJson(path.join(hubDir, "registry", "mcps.json"));
      for (const { name: n } of listTunnels(mcpRegistry)) await statusTunnel(n, env);
    } else {
      const ok = await statusTunnel(name, env);
      if (!ok) process.exit(1);
    }
    return;
  }

  if (command === "ensure") {
    const name = args[0];
    if (!name) { console.error("Usage: agent-tunnel.js ensure <tunnel-name>"); process.exit(2); }
    await ensureTunnel(name, env);
    return;
  }

  if (command === "start") {
    const name = args[0];
    if (!name) { console.error("Usage: agent-tunnel.js start <tunnel-name>"); process.exit(2); }
    await ensureTunnel(name, env);
    console.log(`tunnel "${name}" is up`);
    return;
  }

  if (command === "kill") {
    const name = args[0];
    if (!name) { console.error("Usage: agent-tunnel.js kill <tunnel-name>"); process.exit(2); }
    await killTunnel(name, env);
    return;
  }

  if (command === "restart") {
    const name = args[0];
    if (!name) { console.error("Usage: agent-tunnel.js restart <tunnel-name>"); process.exit(2); }
    await killTunnel(name, env);
    await new Promise((r) => setTimeout(r, 500));
    await ensureTunnel(name, env);
    console.log(`tunnel "${name}" restarted`);
    return;
  }

  console.error(`Usage: agent-tunnel.js <list|status|start|ensure|kill|restart> [tunnel-name]`);
  process.exit(2);
}

main().catch((err) => {
  console.error("agent-tunnel:", err.message || err);
  process.exit(1);
});
