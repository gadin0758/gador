import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORE_MCP_TOOLS } from "../mcp-server/tools.mjs";
import { AgentKernelClient } from "../protocol/index.mjs";
import {
  getPrivacyShieldState,
  updatePrivacyShield,
} from "../protocol/privacy-shield-store.mjs";
import {
  execModuleInSandbox,
  getModuleCustomSettings,
  getModulesState,
  installModule,
  isModuleEnabled,
  isModuleInstalled,
  listActiveCustomSettingsPanels,
  probeModuleInSandbox,
  requestModuleInstallChallenge,
  resetModuleCustomSettings,
  runModulesDoctor,
  setModuleEnabled,
  uninstallModule,
  updateModuleCustomSettings,
} from "../../modules/registry.mjs";
import {
  getSandboxStatus,
  stopAllModuleContainers,
  stopModuleContainer,
} from "../../modules/sandbox/container-manager.mjs";
import {
  clearModuleInstallPassphrase,
  getModuleAuthStatus,
  getTrustedKeyring,
  setModuleInstallPassphrase,
} from "../../modules/verifier.mjs";
import {
  clearVpnBackups,
  createVpnBackup,
  deleteVpnBackup,
  deleteVpnProfile,
  getVpnStoreState,
  restoreVpnBackup,
  upsertVpnProfile,
} from "../protocol/vpn-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENTS_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const ALLOWED_RPC_METHODS = new Set([
  "agent.capabilities",
  "space.create",
  "space.list",
  "space.close",
  "page.open",
  "page.list",
  "page.close",
  "page.attachView",
  "page.detachView",
  "page.listNativeTabs",
  "page.attachActiveTab",
  "page.detachTab",
  "page.focusTab",
  "takeover.request",
  "takeover.release",
  "dialog.handle",
  "cdp.send",
  "network.setTunnel",
  "network.getStatus",
  "ui.getAppearance",
  "ui.setAppearance",
]);

const ALLOWED_NATIVE_USER_URLS = new Set([
  "https://accounts.google.com",
  "https://myaccount.google.com",
  "https://chromewebstore.google.com",
  "chrome://settings/people",
  "chrome://settings/syncSetup",
  "chrome://password-manager/passwords",
  "chrome://settings/payments",
  "chrome://settings/addresses",
  "chrome://extensions",
  "chrome://extensions/shortcuts",
  "chrome://downloads",
  "chrome://settings/downloads",
  "chrome://bookmarks",
  "chrome://history",
  "chrome://settings/clearBrowserData",
  "chrome://settings/importData",
  "chrome://settings/privacy",
  "chrome://settings/content",
  "chrome://settings/search",
  "chrome://settings/onStartup",
  "chrome://settings/defaultBrowser",
  "chrome://settings/appearance",
  "chrome://settings/fonts",
  "chrome://settings/performance",
  "chrome://settings/system",
  "chrome://settings/languages",
  "chrome://settings/reset",
  "chrome://version",
]);

function probeTcpPort(host, port, timeoutMs = 80) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function normalizeProxyEndpoint(raw, fallbackScheme = "http") {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^(socks5h?|socks4a?|https?|quic):\/\//i.test(s)) {
    return s.replace(/^socks5h:\/\//i, "socks5://");
  }
  return `${fallbackScheme}://${s}`;
}

function parseBypassEnv() {
  const raw = process.env.NO_PROXY || process.env.no_proxy || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ["localhost", "127.0.0.1"];
}

async function detectHostProxy() {
  // 1. Environment variables (ALL_PROXY / HTTPS_PROXY / HTTP_PROXY)
  for (const key of ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const val = process.env[key];
    if (val && val.trim()) {
      return {
        detected: true,
        endpoint: normalizeProxyEndpoint(val, key.toLowerCase().includes("all") ? "socks5" : "http"),
        source: `环境变量 ${key}`,
        bypassList: parseBypassEnv(),
      };
    }
  }

  // 2. GNOME gsettings system proxy
  try {
    const mode = execFileSync("gsettings", ["get", "org.gnome.system.proxy", "mode"], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/^'|'$/g, "");
    if (mode === "manual") {
      const readG = (schema, k) =>
        execFileSync("gsettings", ["get", schema, k], {
          encoding: "utf8",
          timeout: 400,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .replace(/^'|'$/g, "");
      const socksHost = readG("org.gnome.system.proxy.socks", "host");
      const socksPort = Number(readG("org.gnome.system.proxy.socks", "port")) || 0;
      if (socksHost && socksPort > 0) {
        return {
          detected: true,
          endpoint: `socks5://${socksHost}:${socksPort}`,
          source: "GNOME 系统代理 (SOCKS)",
          bypassList: ["localhost", "127.0.0.1"],
        };
      }
      const httpHost = readG("org.gnome.system.proxy.http", "host");
      const httpPort = Number(readG("org.gnome.system.proxy.http", "port")) || 0;
      if (httpHost && httpPort > 0) {
        return {
          detected: true,
          endpoint: `http://${httpHost}:${httpPort}`,
          source: "GNOME 系统代理 (HTTP)",
          bypassList: ["localhost", "127.0.0.1"],
        };
      }
    }
  } catch {
    // gsettings not available or not GNOME
  }

  // 3. KDE kioslaverc system proxy
  try {
    const kdePath = path.join(os.homedir(), ".config", "kioslaverc");
    if (fs.existsSync(kdePath)) {
      const text = fs.readFileSync(kdePath, "utf8");
      if (/ProxyType\s*=\s*1/.test(text)) {
        const socksMatch = text.match(/socksProxy\s*=\s*(.+)/i);
        if (socksMatch?.[1]?.trim()) {
          const ep = socksMatch[1].trim().replace(/\s+/, ":");
          return {
            detected: true,
            endpoint: normalizeProxyEndpoint(ep, "socks5"),
            source: "KDE 系统代理 (SOCKS)",
            bypassList: ["localhost", "127.0.0.1"],
          };
        }
        const httpMatch = text.match(/https?Proxy\s*=\s*(.+)/i);
        if (httpMatch?.[1]?.trim()) {
          const ep = httpMatch[1].trim().replace(/\s+/, ":");
          return {
            detected: true,
            endpoint: normalizeProxyEndpoint(ep, "http"),
            source: "KDE 系统代理 (HTTP)",
            bypassList: ["localhost", "127.0.0.1"],
          };
        }
      }
    }
  } catch {
    // ignore KDE config read error
  }

  // 4. Probe common local proxy daemons (Clash/Mihomo/Clash Verge/V2Ray/Sing-box)
  const commonLocal = [
    { port: 7890, scheme: "http", label: "本机代理 Clash/Mihomo (:7890)" },
    { port: 7897, scheme: "http", label: "本机代理 Clash Verge (:7897)" },
    { port: 10808, scheme: "socks5", label: "本机代理 V2Ray/v2rayN (:10808)" },
    { port: 10809, scheme: "http", label: "本机代理 V2Ray HTTP (:10809)" },
    { port: 2080, scheme: "socks5", label: "本机代理 Sing-box (:2080)" },
    { port: 1080, scheme: "socks5", label: "本机代理 SOCKS5 (:1080)" },
  ];
  for (const probe of commonLocal) {
    if (await probeTcpPort("127.0.0.1", probe.port)) {
      return {
        detected: true,
        endpoint: `${probe.scheme}://127.0.0.1:${probe.port}`,
        source: probe.label,
        bypassList: ["localhost", "127.0.0.1"],
      };
    }
  }

  return {
    detected: false,
    endpoint: "",
    source: "当前宿主机未检测到系统代理（直连）",
    bypassList: ["localhost", "127.0.0.1"],
  };
}

function resolveGadorBinPath() {
  const candidates = [
    path.join(os.homedir(), ".local", "share", "gador", "lib", "gador-engine", "gador-bin"),
    path.resolve(CLIENTS_DIR, "..", "lib", "gador-engine", "gador-bin"),
    path.resolve(CLIENTS_DIR, "..", "sources", "chromium-158.0.8127.36", "out", "AgentDev", "chrome"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function resolveGadorSocketPath() {
  if (process.env.AGENT_KERNEL_SOCKET) return process.env.AGENT_KERNEL_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "gador", "ctl.sock");
  }
  return "/tmp/gador/ctl.sock";
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export async function startGadorUiServer({
  socketPath = resolveGadorSocketPath(),
  host = "127.0.0.1",
  port = Number(process.env.GADOR_UI_PORT || 43118),
  launchNative = null,
} = {}) {
  const client = new AgentKernelClient({ socketPath });
  const sseClients = new Set();
  let connected = false;
  let followHostProxy = false;
  let followHostProxyScope = "browser";
  let lastHostProxyState = {
    enabled: false,
    scope: "browser",
    detected: false,
    endpoint: "",
    source: "未启用",
  };
  let hostProxyTimer = null;

  async function syncHostProxyNow(scope = followHostProxyScope) {
    const info = await detectHostProxy();
    lastHostProxyState = {
      enabled: followHostProxy,
      scope,
      ...info,
    };
    if (!followHostProxy) return lastHostProxyState;
    try {
      await ensureConnected();
      if (info.detected && info.endpoint) {
        await client.setTunnel({
          scope,
          mode: "custom",
          endpoint: info.endpoint,
          bypassList: info.bypassList,
          failClosed: false,
        });
      } else {
        await client.setTunnel({
          scope,
          mode: "direct_only",
          failClosed: false,
        });
      }
    } catch {
      // Kernel might reconnect shortly
    }
    return lastHostProxyState;
  }

  async function ensureConnected() {
    if (connected) return;
    await client.connect();
    connected = true;
  }

  client.on("close", () => {
    connected = false;
  });

  client.on("event", (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      if (!res.writableEnded) {
        res.write(line);
      }
    }
  });

  let addrPort = port;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);

    // Block cross-origin browser requests (loopback CSRF protection);
    // allow our bundled Gador extension and Chromium's fused chrome://settings WebUI
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const isLoopback = originUrl.hostname === "127.0.0.1" || originUrl.hostname === "localhost";
        const isExtension = originUrl.protocol === "chrome-extension:";
        const isChromeSettings = origin === "chrome://settings";
        if (!isLoopback && !isExtension && !isChromeSettings) {
          sendJson(res, 403, { error: "Forbidden cross-origin access" });
          return;
        }
        if (isExtension || isChromeSettings) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }
        }
      } catch {
        sendJson(res, 403, { error: "Invalid origin" });
        return;
      }
    }

    try {
      if (req.method === "POST" && url.pathname === "/api/user/open-native") {
        // Human-only local browser launcher (NEVER exposed via AI UDS/MCP).
        const body = await readJsonBody(req);
        const incognito = Boolean(body.incognito);
        const targetUrl = String(body.url || (incognito ? "about:blank" : "")).trim();
        const isSafeHttp = /^https?:\/\//i.test(targetUrl);
        const isAllowedSpecial = targetUrl === "about:blank" || targetUrl === "chrome://newtab";
        if (!ALLOWED_NATIVE_USER_URLS.has(targetUrl) && !isSafeHttp && !(incognito && (!targetUrl || isAllowedSpecial))) {
          sendJson(res, 400, { ok: false, error: "URL not allowed for native launch" });
          return;
        }
        const bin = resolveGadorBinPath();
        if (!bin) {
          sendJson(res, 500, { ok: false, error: "Gador engine binary not found" });
          return;
        }
        const env = {
          ...process.env,
          AGENT_KERNEL_DISABLE_IPC: "1",
          CHROME_DESKTOP: "gador.desktop",
          CHROME_VERSION_EXTRA: "Gador",
        };
        if (env.TMPDIR && env.TMPDIR.length > 48) env.TMPDIR = "/tmp";
        const engineDir = path.dirname(bin);
        const gadorDataDir = path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "gador"
        );
        env.LD_LIBRARY_PATH = `${engineDir}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ""}`;
        const args = [
          "--disable-agent-ipc",
          `--user-data-dir=${gadorDataDir}`,
          "--class=gador",
          "--no-first-run",
          "--no-default-browser-check",
        ];
        if (incognito) {
          args.push("--incognito");
        }
        if (targetUrl && !(incognito && targetUrl === "about:blank")) {
          args.push(targetUrl);
        }
        if (typeof launchNative === "function") {
          await launchNative({ bin, args, env, targetUrl, incognito });
        } else {
          const child = spawn(bin, args, { detached: true, stdio: "ignore", env });
          child.unref();
        }
        sendJson(res, 200, { ok: true, launched: targetUrl || "incognito", incognito });
        return;
      }

      // ---- Standalone Pluggable Module Management Endpoints (VPN & Privacy Shield) ----
      if (req.method === "GET" && url.pathname === "/api/modules") {
        sendJson(res, 200, { ok: true, ...getModulesState() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/modules/doctor") {
        sendJson(res, 200, runModulesDoctor());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/modules/sandbox") {
        sendJson(res, 200, { ok: true, ...getSandboxStatus() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/modules/sandbox/stop") {
        const body = await readJsonBody(req);
        const stopped = body.moduleId
          ? stopModuleContainer(String(body.moduleId), "api_stop")
          : stopAllModuleContainers("api_stop_all");
        sendJson(res, 200, { ok: true, ...stopped, sandbox: getSandboxStatus() });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/sandbox-probe")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/sandbox-probe".length)
        );
        try {
          const result = await probeModuleInSandbox(modId, { loopbackPort: addrPort });
          sendJson(res, 200, result);
        } catch (err) {
          const code = err.code || "ERR_SANDBOX_EXEC";
          const status = code === "ERR_MODULE_NOT_INSTALLED" ? 409 : code.startsWith("ERR_MODULE_") ? 403 : 500;
          sendJson(res, status, { ok: false, code, error: err.message });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/sandbox-exec")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/sandbox-exec".length)
        );
        const body = await readJsonBody(req);
        try {
          const result = await execModuleInSandbox(modId, String(body.method || "getStatus"), body.args || {});
          sendJson(res, 200, result);
        } catch (err) {
          const code = err.code || "ERR_SANDBOX_EXEC";
          const status = code === "ERR_MODULE_NOT_INSTALLED" ? 409 : code.startsWith("ERR_MODULE_") ? 403 : 500;
          sendJson(res, status, { ok: false, code, error: err.message });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/modules/auth") {
        sendJson(res, 200, {
          ok: true,
          ...getModuleAuthStatus(),
          trustedKeys: Object.values(getTrustedKeyring()).map((k) => ({
            id: k.id,
            label: k.label,
            fingerprint: k.fingerprint,
            source: k.source,
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/modules/auth/passphrase") {
        const body = await readJsonBody(req);
        try {
          const authStatus =
            body.action === "clear"
              ? clearModuleInstallPassphrase(body.currentPassphrase || body.passphrase || "")
              : setModuleInstallPassphrase(body.passphrase || "");
          sendJson(res, 200, { ok: true, ...authStatus });
        } catch (err) {
          const status =
            err.code === "ERR_INSTALL_VERIFICATION_FAILED"
              ? 403
              : err.code === "ERR_INVALID_PARAMS"
                ? 400
                : 500;
          sendJson(res, status, {
            ok: false,
            code: err.code || "ERR_INTERNAL",
            error: err.message,
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/install-challenge")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/install-challenge".length)
        );
        try {
          const challenge = requestModuleInstallChallenge(modId);
          sendJson(res, 200, { ok: true, ...challenge });
        } catch (err) {
          const status =
            err.code === "ERR_INVALID_PARAMS"
              ? 400
              : String(err.code || "").startsWith("ERR_MODULE_")
                ? 403
                : 500;
          sendJson(res, status, {
            ok: false,
            code: err.code || "ERR_INTERNAL",
            error: err.message,
            verification: err.verification || undefined,
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/install")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/install".length)
        );
        const body = await readJsonBody(req);
        try {
          const result = installModule(modId, {
            enable: body.enable !== false,
            challengeId: body.challengeId,
            confirmCode: body.confirmCode,
            confirmDigest: body.confirmDigest,
            passphrase: body.passphrase || "",
            actor: "user_webui",
          });
          sendJson(res, 200, result);
        } catch (err) {
          const code = err.code || "ERR_INTERNAL";
          const status =
            code === "ERR_MODULE_CONFLICT"
              ? 409
              : code === "ERR_INSTALL_VERIFICATION_REQUIRED" ||
                  code === "ERR_INSTALL_VERIFICATION_FAILED" ||
                  code.startsWith("ERR_MODULE_")
                ? 403
                : code === "ERR_INVALID_PARAMS"
                  ? 400
                  : 500;
          sendJson(res, status, {
            ok: false,
            code,
            error: err.message,
            verification: err.verification || undefined,
            conflictState: err.conflictState || undefined,
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/uninstall")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/uninstall".length)
        );
        const body = await readJsonBody(req);
        try {
          const result = uninstallModule(modId, { purge: Boolean(body.purge) });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.code === "ERR_INVALID_PARAMS" ? 400 : 500, {
            ok: false,
            code: err.code || "ERR_INTERNAL",
            error: err.message,
          });
        }
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/toggle")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/toggle".length)
        );
        const body = await readJsonBody(req);
        try {
          const result = setModuleEnabled(modId, Boolean(body.enabled));
          sendJson(res, 200, result);
        } catch (err) {
          const code = err.code || "ERR_INTERNAL";
          const status =
            code === "ERR_MODULE_CONFLICT"
              ? 409
              : code === "ERR_MODULE_SIGNATURE_INVALID"
                ? 403
                : code === "ERR_INVALID_PARAMS"
                  ? 400
                  : 500;
          sendJson(res, status, {
            ok: false,
            code,
            error: err.message,
            conflictState: err.conflictState || undefined,
          });
        }
        return;
      }

      // ---- Module-Gated User Custom Settings Routes ----
      if (req.method === "GET" && url.pathname === "/api/custom-settings") {
        sendJson(res, 200, listActiveCustomSettingsPanels());
        return;
      }

      if (
        url.pathname.startsWith("/api/modules/") &&
        url.pathname.endsWith("/settings")
      ) {
        const modId = decodeURIComponent(
          url.pathname.slice("/api/modules/".length, -"/settings".length)
        );
        try {
          if (req.method === "GET") {
            sendJson(res, 200, getModuleCustomSettings(modId));
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const patch =
              body && typeof body.values === "object" && body.values
                ? body.values
                : body;
            const actor = body?.actor === "ai" ? "ai" : "user";
            const updated = updateModuleCustomSettings(modId, patch, { actor });
            sendJson(res, 200, updated);
            return;
          }
          if (req.method === "DELETE") {
            const reset = resetModuleCustomSettings(modId, { actor: "user" });
            sendJson(res, 200, reset);
            return;
          }
        } catch (err) {
          const code = err.code || "ERR_INTERNAL";
          const status =
            code === "ERR_MODULE_NOT_INSTALLED" || code === "ERR_SETTING_CONFLICT"
              ? 409
              : code === "ERR_MODULE_NO_CUSTOM_SETTINGS"
                ? 404
                : code === "ERR_INVALID_SETTING"
                  ? 400
                  : 500;
          sendJson(res, status, {
            ok: false,
            code,
            error: err.message,
            conflictKeys: err.conflictKeys || undefined,
          });
          return;
        }
      }

      // ---- VPN-Only Open Archive & Mandatory Pre-Modify Backup Endpoints ----
      if (req.method === "GET" && url.pathname === "/api/vpn/host-proxy") {
        const info = await detectHostProxy();
        sendJson(res, 200, {
          ok: true,
          enabled: followHostProxy,
          scope: followHostProxyScope,
          ...info,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/vpn/follow-host-proxy") {
        const body = await readJsonBody(req);
        const nextEnabled = Boolean(body.enabled);
        const scope = String(body.scope || "browser").trim() || "browser";
        followHostProxy = nextEnabled;
        followHostProxyScope = scope;
        if (hostProxyTimer) {
          clearInterval(hostProxyTimer);
          hostProxyTimer = null;
        }
        if (followHostProxy) {
          const synced = await syncHostProxyNow(scope);
          hostProxyTimer = setInterval(() => {
            if (followHostProxy) syncHostProxyNow(followHostProxyScope).catch(() => {});
          }, 8000);
          hostProxyTimer.unref?.();
          sendJson(res, 200, { ok: true, ...synced });
        } else {
          const info = await detectHostProxy();
          lastHostProxyState = { enabled: false, scope, ...info };
          sendJson(res, 200, { ok: true, ...lastHostProxyState });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/vpn/store") {
        sendJson(res, 200, {
          ok: true,
          moduleInstalled: isModuleInstalled("vpn"),
          moduleEnabled: isModuleEnabled("vpn"),
          ...getVpnStoreState(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/vpn/profiles") {
        const body = await readJsonBody(req);
        const actor = body.actor === "ai" ? "ai" : "user";
        const saved = upsertVpnProfile(body, {
          actor,
          backupReason: body.backupReason || `${actor}_save_vpn_profile`,
        });
        let applied = null;
        if (body.applyNow) {
          await ensureConnected();
          applied = await client.setTunnel({
            scope: saved.profile.scope,
            mode: saved.profile.mode,
            endpoint: saved.profile.endpoint || undefined,
            dohServer: saved.profile.dohServer || undefined,
            bypassList: saved.profile.bypassList,
            failClosed: saved.profile.failClosed,
          });
        }
        sendJson(res, 200, { ok: true, ...saved, applied, store: getVpnStoreState() });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/vpn/profiles/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/vpn/profiles/".length));
        const resDel = deleteVpnProfile(id, {
          actor: "user",
          backupReason: `user_delete_profile:${id}`,
        });
        sendJson(res, 200, { ok: true, ...resDel, store: getVpnStoreState() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/vpn/backups") {
        const body = await readJsonBody(req);
        const backup = createVpnBackup({
          reason: body.reason || "manual_backup",
          actor: body.actor === "ai" ? "ai" : "user",
        });
        sendJson(res, 200, { ok: true, backup, store: getVpnStoreState() });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/vpn/backups/") &&
        url.pathname.endsWith("/restore")
      ) {
        const backupId = decodeURIComponent(
          url.pathname.slice("/api/vpn/backups/".length, -"/restore".length)
        );
        const restored = restoreVpnBackup(backupId, { actor: "user" });
        sendJson(res, 200, { ok: true, ...restored, store: getVpnStoreState() });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/vpn/backups") {
        const cleared = clearVpnBackups();
        sendJson(res, 200, { ok: true, ...cleared, store: getVpnStoreState() });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/vpn/backups/")) {
        const backupId = decodeURIComponent(url.pathname.slice("/api/vpn/backups/".length));
        const removed = deleteVpnBackup(backupId);
        sendJson(res, 200, { ok: true, ...removed, store: getVpnStoreState() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/skill") {
        const skillPath = path.join(CLIENTS_DIR, "skills", "gador", "SKILL.md");
        const pluginPath = path.join(CLIENTS_DIR, "plugin", "plugin.json");
        const mcpBin = path.join(os.homedir(), ".local", "bin", "gador-mcp");
        const skillContent = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : "";
        const pluginManifest = fs.existsSync(pluginPath)
          ? JSON.parse(fs.readFileSync(pluginPath, "utf8"))
          : null;
        const installedSkillPaths = [
          path.join(os.homedir(), ".agents", "skills", "gador", "SKILL.md"),
          path.join(os.homedir(), ".claude", "skills", "gador", "SKILL.md"),
          path.join(os.homedir(), ".codex", "skills", "gador", "SKILL.md"),
        ].map((p) => ({ path: p, exists: fs.existsSync(p) }));
        sendJson(res, 200, {
          skillPath,
          skillContent,
          installedSkillPaths,
          mcpCommand: mcpBin,
          mcpConfigJson: JSON.stringify(
            { mcpServers: { gador: { command: mcpBin, args: [] } } },
            null,
            2
          ),
          pluginManifest,
          tools: CORE_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        await ensureConnected();
        const [capabilities, spacesRes, pagesRes, networkRes] = await Promise.all([
          client.capabilities(),
          client.listSpaces(),
          client.listPages(),
          client.getNetworkStatus(),
        ]);
        sendJson(res, 200, {
          connected: true,
          socketPath,
          capabilities,
          spaces: spacesRes.spaces || [],
          pages: pagesRes.pages || [],
          routes: networkRes.routes || [],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/rpc") {
        await ensureConnected();
        const body = await readJsonBody(req);
        if (!body.method || !ALLOWED_RPC_METHODS.has(body.method)) {
          sendJson(res, 400, {
            error: `Method not allowed: ${body.method || ""}`,
            code: "ERR_METHOD_NOT_FOUND",
          });
          return;
        }
        if (body.method === "network.setTunnel" && followHostProxy) {
          // User explicitly switched to a custom/strict/direct tunnel -> disable host-proxy following
          followHostProxy = false;
          if (hostProxyTimer) {
            clearInterval(hostProxyTimer);
            hostProxyTimer = null;
          }
        }
        const result = await client.call(body.method, body.params || {});
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/privacy-shield") {
        const moduleInstalled = isModuleInstalled("privacy-shield");
        const moduleEnabled = isModuleEnabled("privacy-shield");
        sendJson(res, 200, {
          ok: true,
          moduleInstalled,
          moduleEnabled,
          ...getPrivacyShieldState(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/privacy-shield") {
        if (!isModuleEnabled("privacy-shield")) {
          sendJson(res, 409, {
            ok: false,
            code: "ERR_MODULE_NOT_INSTALLED",
            error:
              'Module "privacy-shield" is not installed or enabled. Install it via "gador-mod install privacy-shield" or Gador Settings.',
          });
          return;
        }
        const body = await readJsonBody(req);
        try {
          const actor = body.actor === "ai" ? "ai" : "user";
          const nextState = updatePrivacyShield(body, { actor });
          sendJson(res, 200, {
            ok: true,
            moduleInstalled: true,
            moduleEnabled: true,
            ...nextState,
          });
        } catch (err) {
          sendJson(res, err.code === "ERR_INVALID_PARAMS" ? 400 : 500, {
            ok: false,
            code: err.code || "ERR_INTERNAL",
            error: err.message,
          });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/search-engine") {
        const cfgDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gador");
        const cfgFile = path.join(cfgDir, "search-engine.json");
        let engine = "google";
        try {
          if (fs.existsSync(cfgFile)) {
            const parsed = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
            if (["google", "bing", "baidu", "duckduckgo"].includes(parsed.engine)) {
              engine = parsed.engine;
            }
          }
        } catch {}
        sendJson(res, 200, {
          ok: true,
          engine,
          engines: [
            { id: "google", name: "Google", url: "https://www.google.com/search?q={query}" },
            { id: "bing", name: "Bing", url: "https://www.bing.com/search?q={query}" },
            { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd={query}" },
            { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q={query}" },
          ],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/search-engine") {
        const body = await readJsonBody(req);
        const engine = String(body.engine || "").toLowerCase();
        if (!["google", "bing", "baidu", "duckduckgo"].includes(engine)) {
          sendJson(res, 400, { ok: false, error: "Unsupported search engine" });
          return;
        }
        const cfgDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gador");
        fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(cfgDir, "search-engine.json"),
          JSON.stringify({ engine, updatedAt: new Date().toISOString() }, null, 2) + "\n",
          { mode: 0o600 }
        );
        sendJson(res, 200, { ok: true, engine });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ event: "ui.connected", params: { socketPath } })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        try {
          await ensureConnected();
        } catch {
          // Will connect lazily on next /api/state or /api/rpc call
        }
        return;
      }

      // Serve decoupled frontend files from clients/ui/public/
      const relPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const filePath = path.resolve(PUBLIC_DIR, relPath);
      if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        code: err.code || "ERR_INTERNAL",
        error: err.message || "Internal error",
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  addrPort = addr.port;
  const actualUrl = `http://${host}:${addr.port}`;

  return {
    url: actualUrl,
    port: addr.port,
    async close() {
      stopAllModuleContainers("ui_server_close");
      for (const res of sseClients) res.end();
      sseClients.clear();
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ui = await startGadorUiServer();
  process.stdout.write(`[gador-ui] Control Console running at ${ui.url}\n`);
  process.stdout.write(`[gador-ui] Connected socket: ${resolveGadorSocketPath()}\n`);
  const stop = async () => {
    await ui.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
