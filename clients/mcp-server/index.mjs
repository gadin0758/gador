#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GadorMcpServer } from "./server.mjs";

function resolveSocketPath() {
  if (process.env.AGENT_KERNEL_SOCKET) {
    return process.env.AGENT_KERNEL_SOCKET;
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "gador", "ctl.sock");
  }
  return "/tmp/gador/ctl.sock";
}

function findGadorLauncher() {
  const candidates = [
    path.join(os.homedir(), ".local/bin/gador"),
    path.join(os.homedir(), ".local/share/gador/bin/gador"),
    "gador",
  ];
  for (const c of candidates) {
    if (c === "gador" || fs.existsSync(c)) return c;
  }
  return "gador";
}

async function ensureKernelSocketReady(socketPath) {
  if (fs.existsSync(socketPath)) return;
  if (process.env.GADOR_MCP_NO_AUTOBOOT === "1") return;
  const bin = findGadorLauncher();
  const gadorDataDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "gador"
  );
  const child = spawn(
    bin,
    [
      "--agent-daemon",
      `--user-data-dir=${gadorDataDir}`,
      `--agent-socket=${socketPath}`,
      "--class=gador",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_KERNEL_SOCKET: socketPath,
        CHROME_DESKTOP: "gador.desktop",
      },
    }
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const socketPath = resolveSocketPath();
const server = new GadorMcpServer({ socketPath });

try {
  await ensureKernelSocketReady(socketPath);
  await server.connectKernel();
} catch (err) {
  process.stderr.write(
    `[gador-mcp] Failed to connect to kernel UDS (${socketPath}): ${err.message}\n`
  );
  process.exit(1);
}

const rl = server.serveStdio();
rl.on("close", async () => {
  await server.close();
  process.exit(0);
});
