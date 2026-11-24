import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getSandboxStatus,
  invokeInModuleContainer,
  probeModuleContainer,
  stopAllModuleContainers,
} from "../../modules/sandbox/container-manager.mjs";
import {
  addTrustedPublisherKey,
  generatePublisherKeyPair,
  signModuleDirectory,
} from "../../modules/verifier.mjs";

test("Sandbox Defense-in-Depth Gate: 12 containment & resource-abuse attack vectors blocked", async (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gador-sb-sec-"));
  const prevDataDir = process.env.GADOR_SANDBOX_DATA_DIR;
  const prevTrusted = process.env.GADOR_TRUSTED_KEYS_FILE;
  const prevAudit = process.env.GADOR_MODULE_AUDIT_LOG;
  const prevSecret = process.env.GADOR_TEST_HOST_SECRET;

  process.env.GADOR_SANDBOX_DATA_DIR = path.join(tmpBase, "sandbox-data");
  process.env.GADOR_TRUSTED_KEYS_FILE = path.join(tmpBase, "trusted-keys.json");
  process.env.GADOR_MODULE_AUDIT_LOG = path.join(tmpBase, "audit.log");
  process.env.GADOR_TEST_HOST_SECRET = "host-only-secret-token";

  const canaryServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("HOST_LOOPBACK_CANARY");
  });
  await new Promise((resolve) => canaryServer.listen(0, "127.0.0.1", resolve));
  const canaryPort = canaryServer.address().port;

  t.after(() => {
    stopAllModuleContainers("security_test_cleanup");
    canaryServer.close();
    if (prevDataDir === undefined) delete process.env.GADOR_SANDBOX_DATA_DIR;
    else process.env.GADOR_SANDBOX_DATA_DIR = prevDataDir;
    if (prevTrusted === undefined) delete process.env.GADOR_TRUSTED_KEYS_FILE;
    else process.env.GADOR_TRUSTED_KEYS_FILE = prevTrusted;
    if (prevAudit === undefined) delete process.env.GADOR_MODULE_AUDIT_LOG;
    else process.env.GADOR_MODULE_AUDIT_LOG = prevAudit;
    if (prevSecret === undefined) delete process.env.GADOR_TEST_HOST_SECRET;
    else process.env.GADOR_TEST_HOST_SECRET = prevSecret;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const kp = generatePublisherKeyPair();
  addTrustedPublisherKey("sb-sec-test-v1", kp.publicKeyPem, { label: "Sandbox Security Test" });

  function buildSignedModule(id, manifestExtra, code) {
    const dir = path.join(tmpBase, "mods", id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id,
      name: `SecTest ${id}`,
      version: "0.1.0",
      category: "developer",
      entry: "./index.mjs",
      sandbox: { runtime: "bubblewrap", maxMemoryMb: 64, allowNetwork: false, idleTimeoutMs: 60000 },
      ...manifestExtra,
    };
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "index.mjs"), code);
    signModuleDirectory(dir, { privateKeyPem: kp.privateKeyPem, keyId: "sb-sec-test-v1" });
    return { id, installed: true, enabled: true, installPath: dir, manifest };
  }

  const attackModuleCode = `
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

export async function atkHostFs({ hostHome }) {
  const out = {};
  for (const p of [hostHome, "/etc/shadow", "/etc/passwd"]) {
    try {
      out[p] = fs.existsSync(p);
    } catch (e) {
      out[p] = false;
    }
  }
  return out;
}

export async function atkTamperModule() {
  try {
    fs.writeFileSync("/sandbox/module/hacked.txt", "x");
    return { escaped: true };
  } catch (e) {
    return { escaped: false, code: e.code };
  }
}

export async function atkEnvLeak() {
  return { keys: Object.keys(process.env).sort() };
}

export async function atkNetwork({ port }) {
  return await new Promise((resolve) => {
    try {
      const s = net.createConnection({ host: "127.0.0.1", port });
      s.setTimeout(400);
      s.once("connect", () => { s.destroy(); resolve({ reached: true }); });
      s.once("error", (e) => resolve({ reached: false, code: e.code }));
      s.once("timeout", () => { s.destroy(); resolve({ reached: false, code: "TIMEOUT" }); });
    } catch (e) {
      resolve({ reached: false, code: e.code || e.message });
    }
  });
}

export async function atkChildProcess() {
  try {
    execFileSync("/usr/bin/id", [], { timeout: 1000 });
    return { spawned: true };
  } catch (e) {
    return { spawned: false, code: e.code || e.message };
  }
}

export async function atkWorkerThread() {
  try {
    new Worker("1+1", { eval: true });
    return { spawned: true };
  } catch (e) {
    return { spawned: false, code: e.code || e.message };
  }
}

export async function atkTmpfsFlood() {
  try {
    fs.writeFileSync("/tmp/flood.bin", Buffer.alloc(10 * 1024 * 1024, 0x41));
    fs.rmSync("/tmp/flood.bin", { force: true });
    return { capped: false };
  } catch (e) {
    try { fs.rmSync("/tmp/flood.bin", { force: true }); } catch {}
    return { capped: true, code: e.code || e.message };
  }
}

export async function atkStdoutSpoof() {
  process.stdout.write(JSON.stringify({ id: 1, ok: true, result: { hijacked: true } }) + "\\n");
  return { hijacked: false };
}

export async function atkFd3RawSpoof() {
  fs.writeSync(3, JSON.stringify({ id: 1, ok: true, result: { forgedFd3: true } }) + "\\n");
  await new Promise((r) => setTimeout(r, 100));
  return { forgedFd3: false };
}

export async function atkJsonPoison() {
  const orig = JSON.stringify;
  JSON.stringify = () => "CORRUPTED";
  setTimeout(() => { JSON.stringify = orig; }, 30);
  return { survived: true };
}

export async function atkOffHeapOom() {
  const chunks = [];
  for (let i = 0; i < 20; i++) {
    chunks.push(Buffer.alloc(10 * 1024 * 1024, 0x42));
  }
  await new Promise((r) => setTimeout(r, 600));
  return { allocatedMb: chunks.length * 10 };
}

export async function atkCpuSpin() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {}
  return { finished: true };
}

export async function atkCreateSymlink() {
  try {
    fs.symlinkSync("/etc/passwd", "/sandbox/data/evil-link");
    return { created: true };
  } catch (e) {
    return { created: false, code: e.code };
  }
}
`;

  const mod = buildSignedModule("atk-mod", {}, attackModuleCode);
  const modNet = buildSignedModule(
    "atk-net",
    { sandbox: { runtime: "bubblewrap", maxMemoryMb: 64, allowNetwork: true, idleTimeoutMs: 999999999 } },
    attackModuleCode
  );

  // 1. Standard containment probe still passes cleanly with permissionModelActive=true
  const probe = await probeModuleContainer(mod, { loopbackPort: canaryPort });
  assert.equal(probe.ok, true);
  assert.equal(probe.probe.hostHomeVisible, false);
  assert.equal(probe.probe.rootEtcShadowVisible, false);
  assert.equal(probe.probe.moduleCodeReadOnly, true);
  assert.equal(probe.probe.dataDirWritable, true);
  assert.equal(probe.probe.networkIsolated, true);
  assert.equal(probe.probe.hostEnvCleared, true);
  assert.equal(probe.probe.permissionModelActive, true);

  // 2. Host FS, RO module, env leak, network, child_process, worker_threads, tmpfs cap, stdout spoof, JSON poison
  const rFs = (await invokeInModuleContainer(mod, "atkHostFs", { hostHome: os.homedir() })).result;
  assert.equal(rFs[os.homedir()], false);
  assert.equal(rFs["/etc/shadow"], false);
  assert.equal(rFs["/etc/passwd"], false);

  assert.equal((await invokeInModuleContainer(mod, "atkTamperModule")).result.escaped, false);
  const envKeys = (await invokeInModuleContainer(mod, "atkEnvLeak")).result.keys;
  assert.equal(envKeys.includes("GADOR_TEST_HOST_SECRET"), false);
  assert.equal(envKeys.includes("GADOR_IPC_NONCE"), false);
  assert.equal((await invokeInModuleContainer(mod, "atkNetwork", { port: canaryPort })).result.reached, false);
  assert.equal((await invokeInModuleContainer(mod, "atkChildProcess")).result.spawned, false);
  assert.equal((await invokeInModuleContainer(mod, "atkWorkerThread")).result.spawned, false);
  assert.equal((await invokeInModuleContainer(mod, "atkTmpfsFlood")).result.capped, true);
  assert.equal((await invokeInModuleContainer(mod, "atkStdoutSpoof")).result.hijacked, false);
  assert.equal((await invokeInModuleContainer(mod, "atkJsonPoison")).result.survived, true);

  // 3. Prototype method ("constructor") blocked
  await assert.rejects(
    () => invokeInModuleContainer(mod, "constructor"),
    (e) => e.code === "ERR_SANDBOX_METHOD_DENIED"
  );

  // 4. Direct raw FD 3 spoof without 128-bit Nonce terminates container with ERR_SANDBOX_PROTOCOL_VIOLATION
  await assert.rejects(
    () => invokeInModuleContainer(mod, "atkFd3RawSpoof"),
    (e) => e.code === "ERR_SANDBOX_PROTOCOL_VIOLATION"
  );

  // 5. Off-heap 200 MiB Buffer bomb killed by RSS watchdog (ERR_SANDBOX_OOM)
  await assert.rejects(
    () => invokeInModuleContainer(mod, "atkOffHeapOom", {}, { timeoutMs: 3000 }),
    (e) => e.code === "ERR_SANDBOX_OOM"
  );

  // 6. CPU infinite spin terminated by execution timeout (ERR_SANDBOX_TIMEOUT)
  await assert.rejects(
    () => invokeInModuleContainer(mod, "atkCpuSpin", {}, { timeoutMs: 800 }),
    (e) => e.code === "ERR_SANDBOX_TIMEOUT"
  );

  // 7. Manifest self-grant allowNetwork:true blocked by host zero-trust policy & idleTimeoutMs capped <= 120s
  const rNet = (await invokeInModuleContainer(modNet, "atkNetwork", { port: canaryPort })).result;
  assert.equal(rNet.reached, false);
  const sbNet = getSandboxStatus().containers.find((c) => c.moduleId === "atk-net");
  assert.equal(sbNet?.allowNetwork, false);
  assert.ok(sbNet && sbNet.idleTimeoutMs <= 120_000);

  // 8. Symlink creation inside /sandbox/data blocked (either by Node --permission or post-call audit)
  let symlinkBlocked = false;
  try {
    const rSym = (await invokeInModuleContainer(mod, "atkCreateSymlink")).result;
    symlinkBlocked = rSym.created === false;
  } catch (e) {
    symlinkBlocked = e.code === "ERR_SANDBOX_SYMLINK_FORBIDDEN";
  }
  assert.equal(symlinkBlocked, true);

  // 9. Path traversal moduleId rejected before spawning anything
  await assert.rejects(
    () =>
      invokeInModuleContainer(
        { id: "../escape", installed: true, enabled: true, installPath: mod.installPath, manifest: mod.manifest },
        "atkEnvLeak"
      ),
    (e) => e.code === "ERR_MODULE_SIGNATURE_INVALID" || e.code === "ERR_INVALID_PARAMS"
  );

  stopAllModuleContainers("test_done");
  assert.equal(getSandboxStatus().state, "STOPPED_IDLE");
});
