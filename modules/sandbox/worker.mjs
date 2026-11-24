// Gador Hardened Module Sandbox Worker — executes INSIDE bubblewrap + Node --permission container.
// Communicates strictly over dedicated FD 3 authenticated with a per-container 128-bit nonce.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

// Snapshot critical built-ins BEFORE loading any untrusted module code so global/prototype
// poisoning (e.g. overwriting JSON.stringify or process.stdout.write) cannot disrupt IPC.
const safeJsonStringify = JSON.stringify;
const safeJsonParse = JSON.parse;
const safeWriteSync = fs.writeSync.bind(fs);
const safeHasOwn = Object.hasOwn.bind(Object);
const safeObjectKeys = Object.keys.bind(Object);
const safeBufferByteLength = Buffer.byteLength.bind(Buffer);

const IPC_FD = Number(process.env.GADOR_IPC_FD) === 3 ? 3 : 1;
const IPC_NONCE = String(process.env.GADOR_IPC_NONCE || "");
const MAX_IPC_RESPONSE_BYTES = 256 * 1024; // 256 KiB hard response cap

// Immediately scrub sensitive IPC bootstrap vars from process.env before any module executes
delete process.env.GADOR_IPC_NONCE;
delete process.env.GADOR_IPC_FD;

const MODULE_DIR = process.env.GADOR_SANDBOX_MODULE_DIR || "/sandbox/module";
const DATA_DIR = process.env.GADOR_SANDBOX_DATA_DIR || "/sandbox/data";
const MODULE_ID = process.env.GADOR_MODULE_ID || "unknown";

// Redirect module stdout writes to stderr so untrusted console.log/stdout.write can never touch IPC
if (IPC_FD === 3) {
  try {
    process.stdout.write = (...args) => process.stderr.write(...args);
  } catch {}
}

const BLOCKED_METHOD_NAMES = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function sendIpcFrame(payload) {
  const frameObj = IPC_NONCE ? { __gadorNonce: IPC_NONCE, ...payload } : payload;
  let encoded;
  try {
    encoded = safeJsonStringify(frameObj);
  } catch (err) {
    encoded = safeJsonStringify({
      ...(IPC_NONCE ? { __gadorNonce: IPC_NONCE } : {}),
      id: payload.id,
      ok: false,
      code: "ERR_SANDBOX_SERIALIZE",
      error: `Failed to serialize sandbox response: ${err?.message || "unknown"}`,
    });
  }
  if (safeBufferByteLength(encoded, "utf8") > MAX_IPC_RESPONSE_BYTES) {
    encoded = safeJsonStringify({
      ...(IPC_NONCE ? { __gadorNonce: IPC_NONCE } : {}),
      id: payload.id,
      ok: false,
      code: "ERR_SANDBOX_RESPONSE_TOO_LARGE",
      error: `Sandbox response exceeded ${MAX_IPC_RESPONSE_BYTES} byte limit`,
    });
  }
  safeWriteSync(IPC_FD, encoded + "\n", "utf8");
}

function safePathVisible(targetPath) {
  if (!targetPath) return false;
  try {
    return fs.existsSync(targetPath);
  } catch {
    // Node --permission throws ERR_ACCESS_DENIED for out-of-scope paths -> not visible
    return false;
  }
}

let loadedModule = null;

async function ensureModuleLoaded() {
  if (loadedModule) return loadedModule;
  const manifestPath = path.join(MODULE_DIR, "module.json");
  const manifest = safeJsonParse(fs.readFileSync(manifestPath, "utf8"));
  const entryRel = manifest.entry || "./index.mjs";
  const entryAbs = path.resolve(MODULE_DIR, entryRel);
  if (!entryAbs.startsWith(path.resolve(MODULE_DIR) + path.sep)) {
    throw new Error("Module entry escapes sandbox module directory");
  }
  const mod = await import(pathToFileURL(entryAbs).href);
  const combined = Object.create(null);
  for (const k of safeObjectKeys(mod || {})) {
    if (k !== "default" && !BLOCKED_METHOD_NAMES.has(k)) {
      combined[k] = mod[k];
    }
  }
  if (mod?.default && typeof mod.default === "object") {
    for (const k of safeObjectKeys(mod.default)) {
      if (!BLOCKED_METHOD_NAMES.has(k)) {
        combined[k] = mod.default[k];
      }
    }
  }
  loadedModule = {
    manifest,
    exports: Object.freeze(combined),
  };
  return loadedModule;
}

async function runContainmentProbe(probeHostHome, probeLoopbackPort) {
  const hostHomeVisible = safePathVisible(probeHostHome);
  const rootEtcShadowVisible = safePathVisible("/etc/shadow");

  let moduleCodeReadOnly = false;
  try {
    fs.writeFileSync(path.join(MODULE_DIR, ".sandbox-write-probe"), "x");
    fs.rmSync(path.join(MODULE_DIR, ".sandbox-write-probe"), { force: true });
    moduleCodeReadOnly = false;
  } catch {
    moduleCodeReadOnly = true;
  }

  let dataDirWritable = false;
  try {
    const p = path.join(DATA_DIR, ".sandbox-probe.tmp");
    fs.writeFileSync(p, "ok");
    fs.rmSync(p, { force: true });
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }

  let networkIsolated = true;
  if (probeLoopbackPort) {
    networkIsolated = await new Promise((resolve) => {
      const sock = net.createConnection({ host: "127.0.0.1", port: Number(probeLoopbackPort) });
      sock.setTimeout(300);
      sock.once("connect", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("error", () => resolve(true));
      sock.once("timeout", () => {
        sock.destroy();
        resolve(true);
      });
    });
  }

  const envKeys = safeObjectKeys(process.env).sort();
  const allowedEnv = new Set([
    "PATH",
    "HOME",
    "PWD",
    "GADOR_SANDBOX",
    "GADOR_MODULE_ID",
    "GADOR_SANDBOX_MODULE_DIR",
    "GADOR_SANDBOX_DATA_DIR",
    "GADOR_SANDBOX_RUNTIME",
  ]);
  const hostEnvCleared = envKeys.every((k) => allowedEnv.has(k));

  return {
    moduleId: MODULE_ID,
    pid: process.pid,
    pidNamespaceIsolated: process.pid <= 10,
    hostHomeVisible,
    rootEtcShadowVisible,
    moduleCodeReadOnly,
    dataDirWritable,
    networkIsolated,
    hostEnvCleared,
    permissionModelActive: Boolean(process.permission),
    envKeys,
    memoryRssBytes: process.memoryUsage().rss,
  };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = safeJsonParse(trimmed);
  } catch {
    return;
  }
  const id = req.id;
  try {
    let result;
    if (req.op === "ping") {
      result = {
        pong: true,
        moduleId: MODULE_ID,
        pid: process.pid,
        rssBytes: process.memoryUsage().rss,
      };
    } else if (req.op === "probe") {
      result = await runContainmentProbe(req.hostHome || "", req.loopbackPort || 0);
    } else if (req.op === "invoke") {
      const { exports: modExp, manifest } = await ensureModuleLoaded();
      const method = String(req.method || "").trim();
      if (!method || BLOCKED_METHOD_NAMES.has(method) || !safeHasOwn(modExp, method)) {
        const err = new Error(
          `Module "${manifest.id}" does not export allowed callable method "${method}"`
        );
        err.code = "ERR_SANDBOX_METHOD_DENIED";
        throw err;
      }
      const fn = modExp[method];
      if (typeof fn !== "function") {
        const err = new Error(
          `Module "${manifest.id}" export "${method}" is not callable`
        );
        err.code = "ERR_SANDBOX_METHOD_DENIED";
        throw err;
      }
      result = await fn(req.args || {}, Object.freeze({
        sandbox: true,
        moduleId: manifest.id,
        moduleDir: MODULE_DIR,
        dataDir: DATA_DIR,
      }));
    } else {
      throw new Error(`Unknown sandbox op: ${req.op}`);
    }
    sendIpcFrame({ id, ok: true, result });
  } catch (err) {
    sendIpcFrame({
      id,
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "ERR_SANDBOX_EXEC",
    });
  }
});

// Signal parent over dedicated authenticated FD 3 that container worker is booted and ready
sendIpcFrame({ ready: true, moduleId: MODULE_ID, pid: process.pid });
