import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentKernelClient } from "../../clients/protocol/index.mjs";

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
      () => reject(new Error(`C++ daemon startup timeout. stderr=${stderr}`)),
      5000
    );
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("READY ")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
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

test("Cross-Language E2E Gate: Real C++20 POSIX UDS daemon <-> Node protocol client", async (t) => {
  assert.ok(
    fs.existsSync(DAEMON_BIN),
    `Missing compiled C++ daemon at ${DAEMON_BIN}; run 'npm run test:cpp' first`
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-cpp-e2e-"));
  const socketPath = path.join(tmpDir, "ctl.sock");
  const daemon = await startCppDaemon(socketPath);
  const client = new AgentKernelClient({ socketPath });

  t.after(async () => {
    await client.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await client.connect();

  // 1. Verify C++ daemon created strict 0600 socket and accepted same-UID SO_PEERCRED
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  // 2. Verify self-describing capabilities from real C++20 router
  const caps = await client.capabilities();
  assert.equal(caps.protocolVersion, "0.1.0");
  assert.ok(caps.chromiumVersion.includes("158.0.8127.36"));
  assert.equal(caps.runtimeMode, "daemon");
  assert.equal(caps.windowShownByDefault, false);
  assert.ok(caps.features.includes("windowless-daemon"));
  assert.deepEqual(caps.authModes, ["shared", "private"]);

  // 3. Dual-mode auth isolation + out-of-scope personal tab protection
  const shared = await client.createSpace({ name: "cpp-shared", authMode: "shared" });
  const priv = await client.createSpace({ name: "cpp-private", authMode: "private" });
  const pShared = await client.openPage({ spaceId: shared.spaceId, url: "https://example.com" });
  const pPriv = await client.openPage({ spaceId: priv.spaceId, url: "https://example.com" });

  const sharedCookies = await client.sendCdp(pShared.pageId, "Network.getCookies");
  const privCookies = await client.sendCdp(pPriv.pageId, "Network.getCookies");
  assert.ok(sharedCookies.cookies.some((c) => c.name === "ba_session"));
  assert.equal(privCookies.cookies.length, 0);

  await assert.rejects(
    () => client.sendCdp("personal_tab_77", "Page.navigate", { url: "https://evil.test" }),
    (err) => err.code === "ERR_TARGET_OUT_OF_SCOPE"
  );

  // 4. 50x hot-mount / detach cycle across real POSIX UDS IPC
  for (let i = 1; i <= 50; i++) {
    const a = await client.attachView(pShared.pageId, false);
    assert.equal(a.viewAttached, true);
    assert.equal(a.mountCount, i);
    assert.equal(a.controlState, "USER_OBSERVING");

    const d = await client.detachView(pShared.pageId);
    assert.equal(d.viewAttached, false);
    assert.equal(d.controlState, "AGENT_RUNNING");
  }

  // 5. Active user takeover freezes Agent writes -> release resumes
  const active = await client.attachView(pShared.pageId, true);
  assert.equal(active.controlState, "USER_ACTIVE");
  await assert.rejects(
    () => client.sendCdp(pShared.pageId, "Page.navigate", { url: "https://example.org" }),
    (err) => err.code === "ERR_HUMAN_IN_CONTROL"
  );
  const released = await client.releaseTakeover(shared.spaceId);
  assert.equal(released.controlState, "AGENT_RUNNING");
  const nav = await client.sendCdp(pShared.pageId, "Page.navigate", { url: "https://example.org" });
  assert.ok(nav.frameId);

  // 6. Independent VPN interface rules (shared space override rejected, private allowed)
  const vpn = await client.setTunnel({
    scope: "browser",
    mode: "strict_tunnel",
    endpoint: "socks5://127.0.0.1:10808",
    dohServer: "https://dns.quad9.net/dns-query",
    failClosed: true,
  });
  assert.equal(vpn.osProxyDisabled, true);
  assert.equal(vpn.webrtcPolicy, "disable_non_proxied_udp");
  assert.equal(vpn.failClosed, true);

  await assert.rejects(
    () =>
      client.setTunnel({
        scope: `space:${shared.spaceId}`,
        mode: "strict_tunnel",
        endpoint: "socks5://127.0.0.1:10809",
        failClosed: true,
      }),
    (err) => err.code === "ERR_INVALID_PARAMS"
  );

  const privVpn = await client.setTunnel({
    scope: `space:${priv.spaceId}`,
    mode: "strict_tunnel",
    endpoint: "socks5://127.0.0.1:10809",
    failClosed: true,
  });
  assert.equal(privVpn.scope, `space:${priv.spaceId}`);

  await client.closeSpace(shared.spaceId);
  await client.closeSpace(priv.spaceId);
});
