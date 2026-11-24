import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { appendModuleAuditLog, verifyModulePackage } from "../verifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT_PATH = path.join(__dirname, "worker.mjs");

const DEFAULT_MAX_MEMORY_MB = 64;
const MAX_ALLOWED_MEMORY_MB = 128;
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

let cachedRuntimeInfo = null;
const runningContainers = new Map(); // moduleId -> container handle

function resolveSandboxDataRoot() {
  if (process.env.GADOR_SANDBOX_DATA_DIR) {
    return process.env.GADOR_SANDBOX_DATA_DIR;
  }
  const cfgBase =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfgBase, "gador", "sandbox-data");
}

function resolveNodeBin() {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export function detectSandboxRuntime() {
  if (cachedRuntimeInfo) return cachedRuntimeInfo;
  let bwrapPath = null;
  let bwrapVersion = null;
  let bwrapUsable = false;

  for (const candidate of ["/usr/bin/bwrap", "/usr/sbin/bwrap", "/bin/bwrap"]) {
    if (fs.existsSync(candidate)) {
      bwrapPath = candidate;
      break;
    }
  }
  if (!bwrapPath) {
    try {
      bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      bwrapPath = null;
    }
  }

  if (bwrapPath) {
    try {
      bwrapVersion = execFileSync(bwrapPath, ["--version"], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      execFileSync(
        bwrapPath,
        [
          "--unshare-all",
          "--die-with-parent",
          "--new-session",
          "--cap-drop",
          "ALL",
          "--ro-bind",
          "/usr",
          "/usr",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib",
          "/lib64",
          "--symlink",
          "usr/bin",
          "/bin",
          "--",
          "/bin/true",
        ],
        { timeout: 2000, stdio: "ignore" }
      );
      bwrapUsable = true;
    } catch {
      bwrapUsable = false;
    }
  }

  cachedRuntimeInfo = {
    runtime: bwrapUsable ? "bubblewrap" : "node-permission",
    lightweight: true,
    daemonless: true,
    bwrapPath: bwrapUsable ? bwrapPath : null,
    bwrapVersion: bwrapUsable ? bwrapVersion : null,
    isolationFeatures: bwrapUsable
      ? [
          "linux-user-ns",
          "linux-pid-ns",
          "linux-mount-ns",
          "linux-ipc-ns",
          "linux-uts-ns",
          "linux-net-ns-default-off",
          "cap-drop-all",
          "die-with-parent",
          "clearenv",
          "v8-heap-cap-64mb",
        ]
      : ["node-permission-model", "clearenv", "v8-heap-cap-64mb"],
  };
  return cachedRuntimeInfo;
}

function buildBwrapArgs({ bwrapPath, nodeBin, moduleId, moduleDir, dataDir, maxMemoryMb, allowNetwork }) {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/sandbox/data",
    "--setenv",
    "GADOR_SANDBOX",
    "1",
    "--setenv",
    "GADOR_SANDBOX_RUNTIME",
    "bubblewrap",
    "--setenv",
    "GADOR_MODULE_ID",
    moduleId,
    "--setenv",
    "GADOR_SANDBOX_MODULE_DIR",
    "/sandbox/module",
    "--setenv",
    "GADOR_SANDBOX_DATA_DIR",
    "/sandbox/data",
    "--ro-bind",
    "/usr",
    "/usr",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/sandbox",
    "--ro-bind",
    __dirname,
    "/sandbox/runtime",
    "--ro-bind",
    moduleDir,
    "/sandbox/module",
    "--bind",
    dataDir,
    "/sandbox/data",
    "--chdir",
    "/sandbox/data",
  ];

  // Handle merged-/usr (Arch/Fedora/Debian >=12) vs split /lib + /lib64 + /bin
  for (const [linkTarget, mountPoint] of [
    ["usr/lib", "/lib"],
    ["usr/lib", "/lib64"],
    ["usr/bin", "/bin"],
  ]) {
    if (fs.existsSync(mountPoint)) {
      const st = fs.lstatSync(mountPoint);
      if (st.isSymbolicLink()) {
        args.push("--symlink", linkTarget, mountPoint);
      } else {
        args.push("--ro-bind", mountPoint, mountPoint);
      }
    }
  }

  if (allowNetwork) {
    args.push("--share-net");
    if (fs.existsSync("/etc/resolv.conf")) {
      args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
    }
    if (fs.existsSync("/etc/ssl")) {
      args.push("--ro-bind", "/etc/ssl", "/etc/ssl");
    }
  }

  // If Node lives outside /usr (e.g. nvm/fnm/custom prefix), bind only its binary read-only
  let containerNodeBin = nodeBin;
  if (!nodeBin.startsWith("/usr/")) {
    containerNodeBin = "/sandbox/node-bin";
    args.push("--ro-bind", nodeBin, containerNodeBin);
  }

  args.push(
    "--",
    containerNodeBin,
    `--max-old-space-size=${maxMemoryMb}`,
    "/sandbox/runtime/worker.mjs"
  );

  return { cmd: bwrapPath, args };
}

function buildFallbackNodeArgs({ nodeBin, moduleId, moduleDir, dataDir, maxMemoryMb }) {
  const args = [
    `--max-old-space-size=${maxMemoryMb}`,
    "--permission",
    `--allow-fs-read=${__dirname}`,
    `--allow-fs-read=${moduleDir}`,
    `--allow-fs-read=${dataDir}`,
    `--allow-fs-write=${dataDir}`,
    WORKER_SCRIPT_PATH,
  ];
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: dataDir,
    GADOR_SANDBOX: "1",
    GADOR_SANDBOX_RUNTIME: "node-permission",
    GADOR_MODULE_ID: moduleId,
    GADOR_SANDBOX_MODULE_DIR: moduleDir,
    GADOR_SANDBOX_DATA_DIR: dataDir,
  };
  return { cmd: nodeBin, args, env };
}

function spawnModuleContainer({ moduleId, installPath, manifest }) {
  const rt = detectSandboxRuntime();
  const sbCfg = manifest?.sandbox && typeof manifest.sandbox === "object" ? manifest.sandbox : {};
  const maxMemoryMb = Math.min(
    MAX_ALLOWED_MEMORY_MB,
    Math.max(16, Number(sbCfg.maxMemoryMb) || DEFAULT_MAX_MEMORY_MB)
  );
  const idleTimeoutMs = Math.max(5000, Number(sbCfg.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS);
  const allowNetwork = Boolean(sbCfg.allowNetwork);

  const dataDir = path.join(resolveSandboxDataRoot(), moduleId);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const nodeBin = resolveNodeBin();
  const launch =
    rt.runtime === "bubblewrap"
      ? buildBwrapArgs({
          bwrapPath: rt.bwrapPath,
          nodeBin,
          moduleId,
          moduleDir: path.resolve(installPath),
          dataDir,
          maxMemoryMb,
          allowNetwork,
        })
      : buildFallbackNodeArgs({
          nodeBin,
          moduleId,
          moduleDir: path.resolve(installPath),
          dataDir,
          maxMemoryMb,
        });

  const proc = spawn(launch.cmd, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: launch.env || undefined,
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-2048);
  });

  const pending = new Map();
  let nextReqId = 1;
  let idleTimer = null;

  const handle = {
    moduleId,
    runtime: rt.runtime,
    pid: proc.pid,
    maxMemoryMb,
    allowNetwork,
    startedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    dataDir,
    proc,
    stop(reason = "manual") {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      runningContainers.delete(moduleId);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Module container "${moduleId}" stopped (${reason})`));
      }
      pending.clear();
      try {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      } catch {}
    },
    touchIdle() {
      handle.lastUsedAt = new Date().toISOString();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        handle.stop("idle_timeout");
      }, idleTimeoutMs);
      idleTimer.unref?.();
    },
    request(payload, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
      handle.touchIdle();
      return new Promise((resolve, reject) => {
        const id = nextReqId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          handle.stop("execution_timeout");
          const err = new Error(
            `Module "${moduleId}" container timed out after ${timeoutMs}ms and was terminated`
          );
          err.code = "ERR_SANDBOX_TIMEOUT";
          reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      });
    },
  };

  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const readyTimer = setTimeout(() => {
    handle.stop("boot_timeout");
    rejectReady(new Error(`Sandbox container boot timeout for "${moduleId}". stderr=${stderrBuf}`));
  }, 5000);

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.ready) {
      clearTimeout(readyTimer);
      resolveReady(handle);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      const err = new Error(msg.error || "Sandbox invocation failed");
      err.code = msg.code || "ERR_SANDBOX_EXEC";
      entry.reject(err);
    }
  });

  proc.once("exit", (code) => {
    clearTimeout(readyTimer);
    if (runningContainers.get(moduleId) === handle) {
      runningContainers.delete(moduleId);
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Container exited (${code}): ${stderrBuf}`));
    }
    pending.clear();
    rejectReady(new Error(`Container exited early (${code}): ${stderrBuf}`));
  });

  runningContainers.set(moduleId, handle);
  handle.touchIdle();
  appendModuleAuditLog({
    action: "sandbox_container_started",
    moduleId,
    runtime: rt.runtime,
    maxMemoryMb,
    allowNetwork,
    ok: true,
  });

  return readyPromise;
}

async function ensureContainerForModule(moduleEntry) {
  if (!moduleEntry || !moduleEntry.installed || !moduleEntry.enabled) {
    const err = new Error(
      `Refusing to start sandbox container: module "${moduleEntry?.id || "unknown"}" is not installed/enabled`
    );
    err.code = "ERR_MODULE_NOT_INSTALLED";
    throw err;
  }
  // Always re-verify Ed25519 signature + SHA-256 before booting container
  const ver = verifyModulePackage(moduleEntry.installPath, { expectedModuleId: moduleEntry.id });
  if (!ver.valid) {
    stopModuleContainer(moduleEntry.id, "signature_failed");
    const err = new Error(
      `Refusing to boot container for tampered/unverified module "${moduleEntry.id}": ${ver.errors.join("; ")}`
    );
    err.code = ver.code || "ERR_MODULE_SIGNATURE_INVALID";
    throw err;
  }

  const existing = runningContainers.get(moduleEntry.id);
  if (existing && existing.proc.exitCode === null) {
    return existing;
  }
  return spawnModuleContainer({
    moduleId: moduleEntry.id,
    installPath: moduleEntry.installPath,
    manifest: moduleEntry.manifest,
  });
}

export async function invokeInModuleContainer(moduleEntry, method, args = {}, { timeoutMs } = {}) {
  const handle = await ensureContainerForModule(moduleEntry);
  const result = await handle.request(
    { op: "invoke", method, args },
    timeoutMs || DEFAULT_CALL_TIMEOUT_MS
  );
  return {
    ok: true,
    moduleId: moduleEntry.id,
    runtime: handle.runtime,
    containerPid: handle.pid,
    maxMemoryMb: handle.maxMemoryMb,
    result,
  };
}

export async function probeModuleContainer(moduleEntry, { loopbackPort = 43118 } = {}) {
  const handle = await ensureContainerForModule(moduleEntry);
  const probe = await handle.request(
    {
      op: "probe",
      hostHome: os.homedir(),
      loopbackPort,
    },
    DEFAULT_CALL_TIMEOUT_MS
  );
  return {
    ok: true,
    moduleId: moduleEntry.id,
    runtime: handle.runtime,
    maxMemoryMb: handle.maxMemoryMb,
    allowNetwork: handle.allowNetwork,
    probe,
  };
}

export function stopModuleContainer(moduleId, reason = "stopped") {
  const handle = runningContainers.get(moduleId);
  if (!handle) return { stopped: false, moduleId };
  handle.stop(reason);
  appendModuleAuditLog({ action: "sandbox_container_stopped", moduleId, reason, ok: true });
  return { stopped: true, moduleId };
}

export function stopAllModuleContainers(reason = "shutdown") {
  const stopped = [];
  for (const [id, handle] of [...runningContainers.entries()]) {
    handle.stop(reason);
    stopped.push(id);
  }
  return { stoppedCount: stopped.length, stopped };
}

export function getSandboxStatus() {
  const rt = detectSandboxRuntime();
  const containers = [...runningContainers.values()].map((c) => ({
    moduleId: c.moduleId,
    runtime: c.runtime,
    pid: c.pid,
    maxMemoryMb: c.maxMemoryMb,
    allowNetwork: c.allowNetwork,
    startedAt: c.startedAt,
    lastUsedAt: c.lastUsedAt,
  }));
  return {
    state: containers.length > 0 ? "ACTIVE" : "STOPPED_IDLE",
    activeCount: containers.length,
    runtime: rt.runtime,
    bwrapVersion: rt.bwrapVersion,
    daemonless: rt.daemonless,
    isolationFeatures: rt.isolationFeatures,
    policy: {
      startOnlyWhenModuleEnabled: true,
      autoStopWhenNoModules: true,
      defaultMaxMemoryMb: DEFAULT_MAX_MEMORY_MB,
      maxAllowedMemoryMb: MAX_ALLOWED_MEMORY_MB,
      idleAutoReapMs: DEFAULT_IDLE_TIMEOUT_MS,
      networkIsolatedByDefault: true,
    },
    containers,
  };
}
