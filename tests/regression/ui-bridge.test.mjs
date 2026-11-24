import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startGadorUiServer } from "../../clients/ui/server.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DAEMON_BIN = path.join(REPO_ROOT, "build/agent_kernel_daemon");

async function startCppDaemon(socketPath) {
  const proc = spawn(DAEMON_BIN, [socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`C++ daemon timeout: ${stderr}`)),
      5000
    );
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      if (stdout.includes("READY ")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`C++ daemon exited early (${code}): ${stderr}`));
    });
  });
  return {
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => proc.once("exit", r));
      }
    },
  };
}

test("Decoupled Frontend UI Console Shell Gate (Loopback CSRF Guard, /api/state, /api/rpc, Static Shell)", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-ui-gate-"));
  const socketPath = path.join(tmpDir, "ctl.sock");
  const daemon = await startCppDaemon(socketPath);
  const ui = await startGadorUiServer({ socketPath, port: 0 });

  t.after(async () => {
    await ui.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Serves decoupled HTML/CSS/JS shell
  const htmlRes = await fetch(`${ui.url}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes("Gador"));

  // 2. Blocks external cross-origin requests (loopback CSRF guard)
  const evilRes = await fetch(`${ui.url}/api/state`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(evilRes.status, 403);

  // 3. Reads live kernel state & invokes RPCs cleanly
  const stateRes = await (await fetch(`${ui.url}/api/state`)).json();
  assert.equal(stateRes.connected, true);
  assert.equal(stateRes.capabilities.runtimeMode, "daemon");

  const createRes = await (
    await fetch(`${ui.url}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "space.create",
        params: { name: "ui-space", authMode: "private" },
      }),
    })
  ).json();
  assert.equal(createRes.ok, true);
  assert.equal(createRes.result.authMode, "private");

  await fetch(`${ui.url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "space.close",
      params: { spaceId: createRes.result.spaceId },
    }),
  });
});
