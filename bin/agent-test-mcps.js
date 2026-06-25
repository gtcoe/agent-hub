#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");

const hubDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(hubDir, "..");
const launcher = path.join(hubDir, "bin", "agent-mcp.js");
const registryPath = path.join(hubDir, "registry", "mcps.json");

const timeoutMs = Number(process.env.AGENT_HUB_MCP_TEST_TIMEOUT_MS || 20000);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sanitize(text) {
  return String(text || "")
    .replace(/glpat-[A-Za-z0-9_-]+/g, "<redacted-gitlab-token>")
    .replace(/figd_[A-Za-z0-9_-]+/g, "<redacted-figma-token>")
    .replace(/ATATT[A-Za-z0-9_=.-]+/g, "<redacted-atlassian-token>")
    .replace(/redis:\/\/:[^@]+@/g, "redis://:<redacted>@")
    .replace(/(TOKEN|PASSWORD|PASS|SECRET|API_KEY)=([^,\s]+)/gi, "$1=<redacted>");
}

function stderrSummary(stderr) {
  const lines = sanitize(stderr).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...lines.slice(0, 4), ...lines.slice(-8)].filter((line, index, arr) => arr.indexOf(line) === index).join(" | ");
}

function wireMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function extractMessages(state, chunk) {
  state.buffer += chunk.toString("utf8");
  const messages = [];

  while (state.buffer.length > 0) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = state.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        state.buffer = state.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (Buffer.byteLength(state.buffer.slice(bodyStart), "utf8") < len) break;
      const body = state.buffer.slice(bodyStart, bodyStart + len);
      state.buffer = state.buffer.slice(bodyStart + len);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Ignore malformed non-protocol output.
      }
      continue;
    }

    const newline = state.buffer.indexOf("\n");
    if (newline === -1) break;
    const line = state.buffer.slice(0, newline).trim();
    state.buffer = state.buffer.slice(newline + 1);
    if (!line.startsWith("{")) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Ignore logs.
    }
  }

  return messages;
}

function testCwdFor(serverName) {
  const marketing = path.join(workspaceRoot, "marketing");
  if (fs.existsSync(marketing) && /(mysql|redis)/.test(serverName)) return marketing;
  return workspaceRoot;
}

function waitForResponse(child, state, id, getStderr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for response id ${id}`));
    }, timeoutMs);

    function onData(chunk) {
      for (const message of extractMessages(state, chunk)) {
        if (message.id === id) {
          cleanup();
          resolve(message);
          return;
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      const stderr = getStderr ? getStderr() : "";
      reject(new Error(`process exited before response id ${id}: code=${code} signal=${signal || ""}${stderr ? `; stderr=${stderrSummary(stderr)}` : ""}`));
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }

    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function testStdio(serverName) {
  const child = spawn(launcher, [serverName], {
    cwd: testCwdFor(serverName),
    env: {
      ...process.env,
      AGENT_HUB_IGNORE_PROFILE: "1",
      AGENT_HUB_PROFILE: process.env.AGENT_HUB_PROFILE || "work",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const state = { buffer: "" };
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const killTimer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs + 5000);

  try {
    child.stdin.write(wireMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-hub-probe", version: "1.0.0" },
      },
    }));
    const init = await waitForResponse(child, state, 1, () => stderr);
    if (init.error) {
      return { ok: false, detail: `initialize error: ${init.error.message || JSON.stringify(init.error)}` };
    }

    child.stdin.write(wireMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));
    child.stdin.write(wireMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }));
    const tools = await waitForResponse(child, state, 2, () => stderr);
    if (tools.error) {
      return { ok: false, detail: `tools/list error: ${tools.error.message || JSON.stringify(tools.error)}` };
    }
    const count = Array.isArray(tools.result && tools.result.tools) ? tools.result.tools.length : 0;
    return { ok: true, detail: `initialized; tools=${count}` };
  } catch (error) {
    const alreadyHasStderr = String(error.message).includes("; stderr=");
    return { ok: false, detail: `${error.message}${stderr && !alreadyHasStderr ? `; stderr=${stderrSummary(stderr)}` : ""}` };
  } finally {
    clearTimeout(killTimer);
    if (!child.killed) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

function testRemote(serverName, url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-hub-probe", version: "1.0.0" },
      },
    });
    const req = client.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 500;
        resolve({ ok, detail: `http ${res.statusCode}` });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolve({ ok: false, detail: error.message });
    });
    req.end(body);
  });
}

function selectedServers(registry) {
  const requested = process.argv.slice(2);
  if (requested.length > 0) return requested;
  return Object.keys(registry.servers || {});
}

function net() {
  return require("net");
}

async function checkTunnelConnectable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net().createConnection({ port, host }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(2000);
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

async function reportTunnels(registry) {
  const tunnelResults = [];
  for (const [name, server] of Object.entries(registry.servers || {})) {
    if (!server.tunnel) continue;
    // Best-effort port parse from unexpanded registry value; env resolution happens in agent-tunnel.js.
    // Extract fallback from ${VAR:-PORT} patterns, or use literal value if already numeric.
    const portRaw = server.tunnel.localPort || "";
    const fallback = portRaw.match(/:-(\d+)/);
    const localPort = fallback ? parseInt(fallback[1], 10) : parseInt(portRaw, 10);
    const connectable = localPort > 0 ? await checkTunnelConnectable(localPort) : false;
    tunnelResults.push({ name, localPort, connectable });
  }
  if (tunnelResults.length > 0) {
    console.log("Tunnel status:");
    for (const { name, localPort, connectable } of tunnelResults) {
      console.log(`  ${connectable ? "UP  " : "DOWN"} ${name}: port=${localPort}`);
    }
    console.log("");
  }
  return tunnelResults;
}

async function main() {
  const registry = readJson(registryPath);
  const names = selectedServers(registry);
  const results = [];

  await reportTunnels(registry);

  for (const name of names) {
    const server = registry.servers[name];
    if (!server) {
      results.push({ name, ok: false, detail: "not found in registry" });
      continue;
    }
    process.stderr.write(`Testing ${name}...\n`);
    const result = server.type === "remote"
      ? await testRemote(name, server.url)
      : await testStdio(name);
    results.push({ name, ...result });
  }

  console.log("MCP probe results:");
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${sanitize(result.detail)}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(sanitize(error.stack || error.message));
  process.exit(1);
});
