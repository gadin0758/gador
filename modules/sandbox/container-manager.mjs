import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendModuleAuditLog, verifyModulePackage } from "../verifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT_PATH = path.join(__dirname, "worker.mjs");

const DEFAULT_MAX_MEMORY_MB = 64;
const MAX_ALLOWED_MEMORY_MB = 128;
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_IDLE_TIMEOUT_MS = 120_000;
const TMPFS_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap on /tmp & /sandbox tmpfs
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB RLIMIT_FSIZE per file
const MAX_DATA_DIR_BYTES = 16 * 1024 * 1024; // 16 MiB total quota per module dataDir
const MAX_OPEN_FILES = 64; // RLIMIT_NOFILE
const MAX_IPC_FRAME_BYTES = 256 * 1024; // 256 KiB hard IPC line limit
const RSS_WATCHDOG_INTERVAL_MS = 120;
const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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

function resolvePrlimitInContainer() {
  for (const p of ["/usr/bin/prlimit", "/usr/sbin/prlimit"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isModuleNetworkWhitelistedByHost(moduleId) {
  const raw = String(process.env.GADOR_SANDBOX_ALLOW_NETWORK_MODULES || "").trim();
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(moduleId);
}

/**
 * Recursively verify a module's sandbox dataDir has no symlinks and stays within byte quota.
 */
function auditAndMeasureDataDir(dirPath) {
  let totalBytes = 0;
  function walk(cur) {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const err = new Error(
          `Forbidden symbolic link detected in module sandbox data directory: ${entry.name}`
        );
        err.code = "ERR_SANDBOX_SYMLINK_FORBIDDEN";
        throw err;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        totalBytes += st.size;
      }
    }
  }
  if (fs.existsSync(dirPath)) {
    walk(dirPath);
  }
  if (totalBytes > MAX_DATA_DIR_BYTES) {
    const err = new Error(
      `Module sandbox data directory exceeded ${Math.round(MAX_DATA_DIR_BYTES / 1024 / 1024)} MiB quota (${totalBytes} bytes)`
    );
    err.code = "ERR_SANDBOX_QUOTA_EXCEEDED";
    throw err;
  }
  return totalBytes;
}

/**
 * Sum VmRSS across a process and all its Linux descendants (/proc/<pid>/task/.../children).
 */
function readProcessTreeRssBytes(rootPid) {
  if (!rootPid || rootPid <= 0) return 0;
  const visited = new Set();
  const queue = [rootPid];
  let totalKb = 0;
  while (queue.length > 0) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) totalKb += Number(m[1]) || 0;
      const taskDir = `/proc/${pid}/task`;
      for (const tid of fs.readdirSync(taskDir)) {
        try {
          const children = fs
            .readFileSync(path.join(taskDir, tid, "children"), "utf8")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          for (const c of children) {
            const cpid = Number(c);
            if (cpid > 0 && !visited.has(cpid)) queue.push(cpid);
          }
        } catch {}
      }
    } catch {}
  }
  return totalKb * 1024;
}

function killProcessGroup(proc) {
  if (!proc || !proc.pid) return;
  try {
    // Negative PID kills the entire detached process group (bwrap + node + any descendants)
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {}
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
      bwrapPath = execFileSync("which", ["bwrap"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
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
          "linux-cgroup-ns-try",
          "linux-net-ns-strict-off",
          "cap-drop-all",
          "die-with-parent",
          "clearenv",
          "tmpfs-size-cap-4mb",
          "prlimit-fsize-8mb-nofile-64-nocore",
          "node-permission-no-child-process-no-worker-no-addons",
          "authenticated-fd3-ipc-nonce",
          "rss-tree-watchdog-128mb",
          "v8-heap-cap-64mb",
        ]
      : [
          "node-permission-model",
          "clearenv",
          "authenticated-fd3-ipc-nonce",
          "rss-tree-watchdog-128mb",
          "v8-heap-cap-64mb",
        ],
  };
  return cachedRuntimeInfo;
}

function buildBwrapArgs({
  bwrapPath,
  nodeBin,
  moduleId,
  moduleDir,
  dataDir,
  maxMemoryMb,
  allowNetwork,
  ipcNonce,
}) {
  const args = [
    "--unshare-all",
    "--unshare-cgroup-try",
    "--hostname",
    "gador-sandbox",
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
    "--setenv",
    "GADOR_IPC_FD",
    "3",
    "--setenv",
    "GADOR_IPC_NONCE",
    ipcNonce,
    "--ro-bind",
    "/usr",
    "/usr",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(TMPFS_MAX_BYTES),
    "--tmpfs",
    "/tmp",
    "--size",
    String(TMPFS_MAX_BYTES),
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

  // Only grant host network sharing if explicitly whitelisted by host policy
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

  args.push("--");

  // Enforce OS kernel rlimits (max file size 8 MiB, max open FDs 64, core dump 0)
  const prlimitBin = resolvePrlimitInContainer();
  if (prlimitBin) {
    args.push(
      prlimitBin,
      `--fsize=${MAX_FILE_SIZE_BYTES}`,
      `--nofile=${MAX_OPEN_FILES}`,
      "--core=0",
      "--"
    );
  }

  // Double-layer defense: combine bwrap OS namespaces with Node --permission model
  // (explicitly blocks child_process, worker_threads, native addons, and out-of-scope FS reads)
  args.push(
    containerNodeBin,
    `--max-old-space-size=${maxMemoryMb}`,
    "--permission",
    "--allow-fs-read=/sandbox/runtime",
    "--allow-fs-read=/sandbox/module",
    "--allow-fs-read=/sandbox/data",
    "--allow-fs-write=/sandbox/data",
    "--allow-fs-read=/tmp",
    "--allow-fs-write=/tmp",
    "/sandbox/runtime/worker.mjs"
  );

  return { cmd: bwrapPath, args };
}

function buildFallbackNodeArgs({
  nodeBin,
  moduleId,
  moduleDir,
  dataDir,
  maxMemoryMb,
  ipcNonce,
}) {
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
    GADOR_IPC_FD: "3",
    GADOR_IPC_NONCE: ipcNonce,
  };
  return { cmd: nodeBin, args, env };
}

function spawnModuleContainer({ moduleId, installPath, manifest }) {
  if (!MODULE_ID_RE.test(String(moduleId || ""))) {
    const err = new Error(`Invalid moduleId for sandbox container: "${moduleId}"`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const rt = detectSandboxRuntime();
  const sbCfg =
    manifest?.sandbox && typeof manifest.sandbox === "object" ? manifest.sandbox : {};
  const maxMemoryMb = Math.min(
    MAX_ALLOWED_MEMORY_MB,
    Math.max(16, Number(sbCfg.maxMemoryMb) || DEFAULT_MAX_MEMORY_MB)
  );
  const maxRssBytes = Math.max(128, maxMemoryMb * 2) * 1024 * 1024;
  const idleTimeoutMs = Math.min(
    MAX_IDLE_TIMEOUT_MS,
    Math.max(5000, Number(sbCfg.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS)
  );

  // Zero-trust network policy: module.json CANNOT self-grant host --share-net access.
  const requestedNetwork = Boolean(sbCfg.allowNetwork);
  const allowNetwork = requestedNetwork && isModuleNetworkWhitelistedByHost(moduleId);
  if (requestedNetwork && !allowNetwork) {
    appendModuleAuditLog({
      action: "sandbox_network_denied_by_host_policy",
      moduleId,
      ok: false,
      detail: "Module requested allowNetwork=true but is not host-whitelisted; forced strict network isolation",
    });
  }

  const dataRoot = path.resolve(resolveSandboxDataRoot());
  const dataDir = path.resolve(dataRoot, moduleId);
  if (!dataDir.startsWith(dataRoot + path.sep)) {
    const err = new Error(`Sandbox dataDir escaped root for module "${moduleId}"`);
    err.code = "ERR_SANDBOX_PATH_ESCAPE";
    throw err;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  auditAndMeasureDataDir(dataDir);

  const ipcNonce = crypto.randomBytes(16).toString("hex");
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
          ipcNonce,
        })
      : buildFallbackNodeArgs({
          nodeBin,
          moduleId,
          moduleDir: path.resolve(installPath),
          dataDir,
          maxMemoryMb,
          ipcNonce,
        });

  // FD 0 = stdin, FD 1 = stdout (untrusted module logs, ignored for IPC), FD 2 = stderr, FD 3 = authenticated IPC response pipe
  const proc = spawn(launch.cmd, launch.args, {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: launch.env || undefined,
    detached: true,
  });

  // Drain & discard untrusted stdout (bounded) so pipe never blocks & cannot spoof IPC
  proc.stdout.on("data", () => {});

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-2048);
  });

  const pending = new Map();
  let nextReqId = 1;
  let idleTimer = null;
  let rssTimer = null;
  let stoppedReason = null;

  const handle = {
    moduleId,
    runtime: rt.runtime,
    pid: proc.pid,
    maxMemoryMb,
    maxRssMb: Math.round(maxRssBytes / 1024 / 1024),
    idleTimeoutMs,
    allowNetwork,
    startedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    dataDir,
    proc,
    stop(reason = "manual", errCode = "ERR_SANDBOX_STOPPED") {
      if (!stoppedReason) stoppedReason = reason;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (rssTimer) {
        clearInterval(rssTimer);
        rssTimer = null;
      }
      runningContainers.delete(moduleId);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        const err = new Error(`Module container "${moduleId}" stopped (${reason})`);
        err.code = errCode;
        p.reject(err);
      }
      pending.clear();
      killProcessGroup(proc);
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
          handle.stop("execution_timeout", "ERR_SANDBOX_TIMEOUT");
          const err = new Error(
            `Module "${moduleId}" container timed out after ${timeoutMs}ms and was terminated`
          );
          err.code = "ERR_SANDBOX_TIMEOUT";
          reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
        } catch (writeErr) {
          clearTimeout(timer);
          pending.delete(id);
          reject(writeErr);
        }
      });
    },
  };

  // Real-time process-tree RSS watchdog (catches off-heap Buffer / ArrayBuffer bombs that bypass --max-old-space-size)
  rssTimer = setInterval(() => {
    if (proc.exitCode !== null) return;
    const rssBytes = readProcessTreeRssBytes(proc.pid);
    if (rssBytes > maxRssBytes) {
      const rssMb = Math.round(rssBytes / 1024 / 1024);
      appendModuleAuditLog({
        action: "sandbox_container_oom_killed",
        moduleId,
        rssMb,
        limitMb: handle.maxRssMb,
        ok: false,
      });
      handle.stop(`rss_limit_exceeded_${rssMb}mb`, "ERR_SANDBOX_OOM");
    }
  }, RSS_WATCHDOG_INTERVAL_MS);
  rssTimer.unref?.();

  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const readyTimer = setTimeout(() => {
    handle.stop("boot_timeout", "ERR_SANDBOX_TIMEOUT");
    rejectReady(
      new Error(`Sandbox container boot timeout for "${moduleId}". stderr=${stderrBuf}`)
    );
  }, 5000);

  // Read authenticated IPC frames strictly from FD 3 with hard byte cap (prevents unbounded OOM lines)
  const ipcStream = proc.stdio[3];
  let ipcChunks = [];
  let ipcBufferedBytes = 0;

  const processIpcLine = (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      appendModuleAuditLog({
        action: "sandbox_protocol_violation",
        moduleId,
        detail: "Non-JSON frame on FD 3",
        ok: false,
      });
      handle.stop("protocol_violation", "ERR_SANDBOX_PROTOCOL_VIOLATION");
      return;
    }
    if (msg.__gadorNonce !== ipcNonce) {
      appendModuleAuditLog({
        action: "sandbox_ipc_spoof_blocked",
        moduleId,
        detail: "Missing or invalid IPC nonce on FD 3",
        ok: false,
      });
      handle.stop("invalid_ipc_nonce", "ERR_SANDBOX_PROTOCOL_VIOLATION");
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
  };

  ipcStream.on("data", (chunk) => {
    ipcChunks.push(chunk);
    ipcBufferedBytes += chunk.length;
    if (ipcBufferedBytes > MAX_IPC_FRAME_BYTES) {
      ipcChunks = [];
      ipcBufferedBytes = 0;
      appendModuleAuditLog({
        action: "sandbox_ipc_flood_killed",
        moduleId,
        limitBytes: MAX_IPC_FRAME_BYTES,
        ok: false,
      });
      handle.stop("ipc_frame_too_large", "ERR_SANDBOX_PROTOCOL_VIOLATION");
      return;
    }
    const combined = Buffer.concat(ipcChunks);
    let start = 0;
    let nlIdx;
    while ((nlIdx = combined.indexOf(0x0a, start)) !== -1) {
      const lineBuf = combined.subarray(start, nlIdx);
      start = nlIdx + 1;
      processIpcLine(lineBuf.toString("utf8"));
    }
    if (start > 0) {
      const rest = combined.subarray(start);
      ipcChunks = rest.length > 0 ? [rest] : [];
      ipcBufferedBytes = rest.length;
    }
  });

  proc.once("exit", (code) => {
    clearTimeout(readyTimer);
    if (rssTimer) {
      clearInterval(rssTimer);
      rssTimer = null;
    }
    if (runningContainers.get(moduleId) === handle) {
      runningContainers.delete(moduleId);
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      const err = new Error(
        `Container exited (${code}, reason=${stoppedReason || "crash"}): ${stderrBuf}`
      );
      err.code = stoppedReason?.startsWith("rss_limit")
        ? "ERR_SANDBOX_OOM"
        : "ERR_SANDBOX_EXITED";
      p.reject(err);
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
    maxRssMb: handle.maxRssMb,
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
    auditAndMeasureDataDir(existing.dataDir);
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
  // Post-call audit to catch any symlink creation or quota abuse inside dataDir immediately
  try {
    auditAndMeasureDataDir(handle.dataDir);
  } catch (err) {
    handle.stop("data_dir_policy_violation", err.code || "ERR_SANDBOX_POLICY");
    throw err;
  }
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
    maxRssMb: c.maxRssMb,
    idleTimeoutMs: c.idleTimeoutMs,
    allowNetwork: c.allowNetwork,
    startedAt: c.startedAt,
    lastUsedAt: c.lastUsedAt,
  }));
  return {
    state: containers.length > 0 ? "ACTIVE" : "STOPPED_IDLE",
    activeCount: containers.length,
    runtime: rt.runtime,
    bwrapVersion: rt.bwrapVersion,
    daemonless: true,
    isolationFeatures: rt.isolationFeatures,
    policy: {
      startOnlyWhenModuleEnabled: true,
      autoStopWhenNoModules: true,
      defaultMaxMemoryMb: DEFAULT_MAX_MEMORY_MB,
      maxAllowedMemoryMb: MAX_ALLOWED_MEMORY_MB,
      maxIdleTimeoutMs: MAX_IDLE_TIMEOUT_MS,
      tmpfsMaxMb: Math.round(TMPFS_MAX_BYTES / 1024 / 1024),
      maxFileSizeMb: Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024),
      maxDataDirMb: Math.round(MAX_DATA_DIR_BYTES / 1024 / 1024),
      maxIpcFrameKb: Math.round(MAX_IPC_FRAME_BYTES / 1024),
      networkIsolatedByDefault: true,
      manifestNetworkSelfGrantBlocked: true,
    },
    containers,
  };
}
