// Gador Module Sandbox Worker — executes INSIDE the lightweight bubblewrap (bwrap) container.
// Communicates strictly over stdin/stdout JSON lines (zero network ports, zero host FS access).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const MODULE_DIR = process.env.GADOR_SANDBOX_MODULE_DIR || "/sandbox/module";
const DATA_DIR = process.env.GADOR_SANDBOX_DATA_DIR || "/sandbox/data";
const MODULE_ID = process.env.GADOR_MODULE_ID || "unknown";

let loadedModule = null;

async function ensureModuleLoaded() {
  if (loadedModule) return loadedModule;
  const manifestPath = path.join(MODULE_DIR, "module.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entryRel = manifest.entry || "./index.mjs";
  const entryAbs = path.resolve(MODULE_DIR, entryRel);
  if (!entryAbs.startsWith(path.resolve(MODULE_DIR) + path.sep)) {
    throw new Error("Module entry escapes sandbox module directory");
  }
  const mod = await import(pathToFileURL(entryAbs).href);
  loadedModule = {
    manifest,
    exports: mod.default && typeof mod.default === "object" ? { ...mod, ...mod.default } : mod,
  };
  return loadedModule;
}

async function runContainmentProbe(probeHostHome, probeLoopbackPort) {
  const hostHomeVisible = Boolean(probeHostHome && fs.existsSync(probeHostHome));
  const rootEtcShadowVisible = fs.existsSync("/etc/shadow");

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

  const envKeys = Object.keys(process.env).sort();
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
    req = JSON.parse(trimmed);
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
      const method = String(req.method || "");
      const fn = modExp[method];
      if (typeof fn !== "function") {
        throw new Error(`Module "${manifest.id}" does not export callable method "${method}"`);
      }
      result = await fn(req.args || {}, {
        sandbox: true,
        moduleId: manifest.id,
        moduleDir: MODULE_DIR,
        dataDir: DATA_DIR,
      });
    } else {
      throw new Error(`Unknown sandbox op: ${req.op}`);
    }
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        id,
        ok: false,
        error: err?.message || String(err),
        code: err?.code || "ERR_SANDBOX_EXEC",
      }) + "\n"
    );
  }
});

// Signal parent that container worker is booted and ready
process.stdout.write(JSON.stringify({ ready: true, moduleId: MODULE_ID, pid: process.pid }) + "\n");
