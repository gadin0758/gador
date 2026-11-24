// Gador Unified Native chrome://settings Architecture (Hot-Reloadable — ZERO C++ Recompile)
// Deeply fuses Gador's Optical Lightfield, AI Native-Tab Overview & Handover, and
// Independent VPN + Follow Host Proxy directly INTO Chromium's native Settings taxonomy:
//   - Replaces the top-left Chromium wheel logo + "设置" with Gador's luminous brand emblem + "Gador 设置"
//   - Refactors EVERY left-sidebar title into one coherent, zero-Chromium Gador IA
//   - Fuses Optical Lightfield & Tab Layout directly onto the native "外观与光场" (/appearance) page
//   - Replaces "Chrome 中的 AI" (/ai) with "AI 托管与总览" (Native Tab Overview + Handover + Skill/MCP)
//   - Integrates "网络与独立 VPN" natively right beside "隐私与安全"
//   - Adds Gador quick cards onto "密码与自动填充", "隐私与安全", and "初始化与重置"
// Strictly TrustedTypes-safe (document.createElement + textContent only; zero innerHTML).

import { sendWithPromise } from "chrome://resources/js/cr.js";

const API_BASE = "http://127.0.0.1:43118";

const UNIFIED_MENU_LABELS = {
  people: "账户与同步",
  autofill: "密码与自动填充",
  privacy: "隐私与安全",
  "gador-vpn": "网络与独立 VPN",
  ai: "AI 托管与总览",
  appearance: "外观与光场",
  performance: "性能与节能",
  search: "搜索引擎",
  defaultBrowser: "默认浏览器",
  onStartup: "启动与新标签页",
  languages: "语言与翻译",
  downloads: "下载与保存",
  accessibility: "辅助功能",
  system: "系统与硬件",
  reset: "初始化与重置",
  extensionsLink: "扩展与插件",
  "about-menu": "关于 Gador",
};

const ACCENT_PRESETS = [
  { id: "adaptive", label: "自适应", hex: "" },
  { id: "aurora", label: "极光青", hex: "#38bdf8" },
  { id: "glacier", label: "冰川蓝", hex: "#60a5fa" },
  { id: "nebula", label: "星云紫", hex: "#a855f7" },
  { id: "amber", label: "琥珀金", hex: "#f59e0b" },
  { id: "emerald", label: "翡翠绿", hex: "#10b981" },
  { id: "rose", label: "玫瑰粉", hex: "#f43f5e" },
];

const state = {
  // mode: "appearance" (fused above native) | "ai" (full) | "vpn" (full)
  //     | "privacy" (banner above native) | "autofill" (banner) | "reset" (banner) | "native"
  viewMode: "native",
  appearance: {
    theme: "system",
    accentColor: "",
    layout: "chrome",
    compact: false,
    showBookmarkBar: true,
    nativeUi: {
      colorVariant: "neutral",
      tabActiveAccentBar: true,
      verticalTabCornerRadius: 10,
      tabAccentColor: "#7d98ff",
      aiAuraEnabled: true,
      aiAuraColor: "#7d98ff",
      aiAuraIntensity: 1.0,
    },
  },
  kernelState: { connected: false, spaces: [], pages: [], routes: [] },
  nativeTabs: [],
  vpnArchive: { profiles: [], backups: [], profilesPath: "~/.config/gador/vpn/profiles.json" },
  hostProxy: { enabled: false, detected: false, endpoint: "", source: "探测中…" },
  searchEngine: "google",
  googleAccounts: [],
  privacyShield: {
    level: "standard",
    canvasFarbling: true,
    webglFarbling: true,
    audioFarbling: true,
    clientRectsJitter: false,
    hardwareNormalization: true,
    webrtcLeakProtection: true,
    gpcHeader: true,
    hideAutomationHints: true,
  },
  modulesState: { registryPath: "", installRoot: "", passphraseEnabled: false, modules: [] },
  busyOps: {},
  skillInfo: null,
  vpnForm: {
    scope: "browser",
    mode: "strict_tunnel",
    endpoint: "",
    dohUrl: "",
    failClosed: true,
    profileName: "",
  },
  toastTimer: null,
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

async function bridgeFetch(method, path, bodyObj) {
  if (typeof sendWithPromise === "function") {
    const resp = await sendWithPromise(
      "gadorBridgeRequest",
      method,
      path,
      bodyObj !== undefined ? JSON.stringify(bodyObj) : ""
    );
    let parsed = {};
    try {
      parsed = resp?.body ? JSON.parse(resp.body) : {};
    } catch {
      parsed = { raw: resp?.body || "" };
    }
    if (!resp?.ok) {
      throw new Error(parsed.error || resp?.error || `HTTP ${resp?.status || 0}`);
    }
    return parsed;
  }
  const init = { method, cache: "no-store" };
  if (method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(bodyObj || {});
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const apiGet = (path) => bridgeFetch("GET", path);
const apiPost = (path, body) => bridgeFetch("POST", path, body || {});
const apiDelete = (path) => bridgeFetch("DELETE", path);

async function apiRpc(method, params = {}) {
  const data = await apiPost("/api/rpc", { method, params });
  if (data.error) throw new Error(data.error.message || data.error.code || "RPC failed");
  return data.result ?? data;
}

function showToast(msg, isErr = false) {
  let toast = document.getElementById("gador-fused-toast");
  if (!toast) {
    toast = el("div", { id: "gador-fused-toast", "data-toast-kind": "ok" });
    Object.assign(toast.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "99999",
      padding: "10px 16px",
      borderRadius: "12px",
      fontSize: "13px",
      fontWeight: "500",
      boxShadow: "0 12px 32px rgba(0, 0, 0, 0.24)",
      transition: "opacity 0.2s ease, transform 0.2s ease",
      pointerEvents: "none",
    });
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.setAttribute("data-toast-kind", isErr ? "error" : "ok");
  toast.style.background = isErr ? "#dc2626" : "#2563eb";
  toast.style.color = "#ffffff";
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
  }, 2400);
}

function injectHostStyles(settingsUiShadow) {
  if (settingsUiShadow.getElementById("gador-fused-styles")) return;
  const style = el("style", { id: "gador-fused-styles" });
  style.textContent = `
    #gador-main-column {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      height: auto;
      min-height: 0;
    }
    #gador-main-column > #main {
      flex: 0 0 auto !important;
      height: auto !important;
      overflow: visible !important;
      min-height: 0 !important;
    }
    #gador-integrated-main {
      flex: 0 0 auto;
      width: 100%;
      max-width: 680px;
      margin: 0 auto 4px;
      padding: 20px 0 8px;
      box-sizing: border-box;
      color: var(--cr-primary-text-color, #1f2937);
      font-family: var(--cr-font-family, "Inter", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif);
    }
    .gd-engine-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding: 14px 18px 18px;
    }
    @media (max-width: 560px) {
      .gd-engine-grid { grid-template-columns: 1fr; }
    }
    .gd-engine-card {
      appearance: none;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(127, 127, 127, 0.22);
      background: rgba(127, 127, 127, 0.04);
      color: var(--cr-primary-text-color, inherit);
      cursor: pointer;
      text-align: left;
      white-space: normal;
      overflow: hidden;
      transition: transform 0.14s ease, border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
    }
    .gd-engine-card:hover {
      transform: translateY(-1px);
      border-color: rgba(79, 124, 255, 0.55);
      background: rgba(79, 124, 255, 0.06);
    }
    .gd-engine-card.active {
      border-color: #4f7cff;
      background: rgba(79, 124, 255, 0.11);
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.22);
    }
    .gd-engine-badge {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 15px;
      font-weight: 700;
      color: #ffffff;
    }
    .gd-engine-meta {
      min-width: 0;
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .gd-engine-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .gd-engine-title-row strong {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.25;
    }
    .gd-engine-meta span {
      font-size: 12px;
      line-height: 1.38;
      color: var(--cr-secondary-text-color, #5f6368);
      word-break: break-word;
    }
    .gd-account-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-top: 1px solid rgba(127, 127, 127, 0.12);
    }
    .gd-account-avatar {
      width: 38px;
      height: 38px;
      flex: 0 0 38px;
      border-radius: 50%;
      object-fit: cover;
      background: linear-gradient(135deg, #4f8dff, #8b5cf6);
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 15px;
      border: 1px solid rgba(127, 127, 127, 0.2);
    }
    #gador-integrated-main.full-page {
      padding-bottom: 72px;
    }
    #gador-integrated-main[hidden] { display: none !important; }

    .gd-page-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .gd-page-head h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .gd-page-head p {
      margin: 4px 0 0;
      font-size: 12.5px;
      color: var(--cr-secondary-text-color, #5f6368);
      line-height: 1.5;
    }

    .gd-section-label {
      margin: 18px 0 8px 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--cr-secondary-text-color, #5f6368);
      letter-spacing: 0.02em;
    }
    .gd-native-divider {
      margin: 22px 0 2px 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--cr-secondary-text-color, #5f6368);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .gd-native-divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: rgba(127, 127, 127, 0.18);
    }

    .gd-card {
      background: var(--cr-card-background-color, #ffffff);
      border: 1px solid rgba(127, 127, 127, 0.18);
      border-radius: 12px;
      box-shadow: var(--cr-card-shadow, 0 1px 3px rgba(0, 0, 0, 0.06));
      overflow: hidden;
    }
    .gd-card + .gd-card { margin-top: 12px; }

    .gd-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 20px;
    }
    .gd-item.stack {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }
    .gd-item + .gd-item {
      border-top: 1px solid rgba(127, 127, 127, 0.14);
    }
    .gd-item-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .gd-item-info strong {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--cr-primary-text-color, inherit);
    }
    .gd-item-info span {
      font-size: 12px;
      color: var(--cr-secondary-text-color, #5f6368);
      line-height: 1.45;
    }
    .gd-item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .gd-preview-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(125, 152, 255, 0.12), rgba(168, 85, 247, 0.06));
      border: 1px solid rgba(125, 152, 255, 0.24);
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .gd-mini-tab {
      flex: 1 1 140px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 11px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 500;
      background: var(--cr-card-background-color, #ffffff);
      border: 1px solid rgba(127, 127, 127, 0.2);
    }
    .gd-mini-tab.ai-running {
      border-color: var(--gd-accent, #7d98ff);
      box-shadow: 0 0 0 1px var(--gd-accent, #7d98ff), 0 4px 14px -4px rgba(125, 152, 255, 0.45);
      background: linear-gradient(90deg, rgba(125, 152, 255, 0.18), var(--cr-card-background-color, #ffffff) 65%);
    }
    .gd-mini-tab.ai-paused {
      border-color: #f59e0b;
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.65);
      background: linear-gradient(90deg, rgba(245, 158, 11, 0.16), var(--cr-card-background-color, #ffffff) 65%);
    }
    .gd-mini-bar {
      width: 3px;
      height: 16px;
      border-radius: 999px;
      flex: none;
    }

    .gd-seg {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(0, 1fr);
      width: 100%;
      gap: 4px;
      padding: 3px;
      border-radius: 10px;
      background: rgba(127, 127, 127, 0.11);
      border: 1px solid rgba(127, 127, 127, 0.14);
      box-sizing: border-box;
    }
    .gd-seg.compact { max-width: 320px; }
    .gd-seg-btn {
      border: 0;
      cursor: pointer;
      padding: 7px 10px;
      border-radius: 7px;
      background: transparent;
      color: var(--cr-secondary-text-color, #5f6368);
      font-size: 12.5px;
      font-weight: 500;
      text-align: center;
      white-space: nowrap;
      transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
    }
    .gd-seg-btn:hover {
      color: var(--cr-primary-text-color, inherit);
      background: rgba(127, 127, 127, 0.08);
    }
    .gd-seg-btn.active {
      background: var(--cr-card-background-color, #ffffff);
      color: var(--cr-primary-text-color, #111827);
      font-weight: 600;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14), 0 0 0 1px rgba(79, 124, 255, 0.32);
    }

    .gd-swatches {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
    }
    @media (max-width: 640px) {
      .gd-swatches { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .gd-swatch {
      border: 1px solid rgba(127, 127, 127, 0.18);
      border-radius: 10px;
      padding: 9px 4px;
      background: rgba(127, 127, 127, 0.04);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      color: var(--cr-primary-text-color, inherit);
      font-size: 11.5px;
      white-space: nowrap;
      transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .gd-swatch:hover { transform: translateY(-1px); border-color: rgba(79, 124, 255, 0.55); }
    .gd-swatch.active {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.22);
      background: rgba(79, 124, 255, 0.09);
      font-weight: 600;
    }
    .gd-dot {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5), 0 2px 6px rgba(0, 0, 0, 0.16);
    }

    .gd-pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(79, 124, 255, 0.13);
      color: var(--google-blue-600, #4f7cff);
      white-space: nowrap;
    }
    .gd-pill.ok { background: rgba(16, 185, 129, 0.14); color: #059669; }
    .gd-pill.waiting { background: rgba(245, 158, 11, 0.16); color: #b45309; gap: 6px; }
    .gd-pill.forbidden { background: rgba(239, 68, 68, 0.14); color: #dc2626; gap: 5px; }
    @media (prefers-color-scheme: dark) {
      .gd-pill.ok { color: #34d399; }
      .gd-pill.waiting { color: #fbbf24; }
      .gd-pill.forbidden { color: #f87171; }
    }
    .gd-btn:disabled,
    .gd-toggle:disabled,
    .gd-seg-btn:disabled {
      opacity: 0.48;
      cursor: not-allowed !important;
    }
    .gd-item.is-blocked { opacity: 0.72; }

    .gd-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .gd-btn {
      border: 1px solid rgba(127, 127, 127, 0.25);
      background: rgba(127, 127, 127, 0.07);
      color: var(--cr-primary-text-color, inherit);
      padding: 6px 13px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .gd-btn:hover { background: rgba(127, 127, 127, 0.15); }
    .gd-btn.primary {
      background: #3b68ee;
      border-color: #3b68ee;
      color: #ffffff;
      font-weight: 600;
    }
    .gd-btn.primary:hover { background: #2d57d6; }
    .gd-btn.danger {
      background: rgba(239, 68, 68, 0.11);
      border-color: rgba(239, 68, 68, 0.35);
      color: #dc2626;
    }
    .gd-btn.danger:hover { background: rgba(239, 68, 68, 0.18); }

    .gd-toggle {
      position: relative;
      width: 38px;
      height: 22px;
      border-radius: 999px;
      border: 0;
      cursor: pointer;
      background: rgba(127, 127, 127, 0.32);
      transition: background 0.16s ease;
      flex: none;
    }
    .gd-toggle::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
      transition: transform 0.16s ease;
    }
    .gd-toggle[aria-checked="true"] { background: #3b68ee; }
    .gd-toggle[aria-checked="true"]::after { transform: translateX(16px); }

    .gd-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 11px;
      border-radius: 8px;
      border: 1px solid rgba(127, 127, 127, 0.26);
      background: rgba(127, 127, 127, 0.05);
      color: var(--cr-primary-text-color, inherit);
      font-size: 13px;
    }
    .gd-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 640px) {
      .gd-form-grid { grid-template-columns: minmax(0, 1fr); }
    }
    .gd-field { display: flex; flex-direction: column; gap: 5px; }
    .gd-field label { font-size: 12px; color: var(--cr-secondary-text-color, #5f6368); font-weight: 500; }

    .gd-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    @media (max-width: 640px) {
      .gd-metrics { grid-template-columns: minmax(0, 1fr); }
    }
    .gd-metric {
      padding: 12px 14px;
      border-radius: 11px;
      background: var(--cr-card-background-color, #ffffff);
      border: 1px solid rgba(127, 127, 127, 0.18);
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .gd-metric small {
      font-size: 11px;
      font-weight: 600;
      color: var(--google-blue-600, #4f7cff);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .gd-metric strong { font-size: 14px; }
    .gd-metric span { font-size: 11.5px; color: var(--cr-secondary-text-color, #5f6368); }

    .gd-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(127, 127, 127, 0.12);
      word-break: break-all;
    }
    .gd-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .gd-empty {
      padding: 16px 20px;
      font-size: 12.5px;
      color: var(--cr-secondary-text-color, #5f6368);
    }
  `;
  settingsUiShadow.appendChild(style);
}

function makeToggle(checked, ariaLabel, onChange, opts = {}) {
  const disabled = Boolean(opts?.disabled);
  const btn = el("button", {
    type: "button",
    class: "gd-toggle",
    role: "switch",
    "aria-label": ariaLabel,
    "aria-checked": checked ? "true" : "false",
    disabled: disabled ? true : undefined,
    title: opts?.title || undefined,
    onClick: () => {
      if (disabled) {
        if (opts?.blockedMessage) showToast(opts.blockedMessage, true);
        return;
      }
      const next = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", next ? "true" : "false");
      onChange(next);
    },
  });
  return btn;
}

function makeSegmented(options, current, onPick, compact = false, opts = {}) {
  const disabled = Boolean(opts?.disabled);
  return el(
    "div",
    { class: `gd-seg${compact ? " compact" : ""}` },
    options.map((opt) =>
      el("button", {
        type: "button",
        class: `gd-seg-btn${opt.value === current ? " active" : ""}`,
        "data-seg-value": opt.value,
        disabled: disabled || opt.disabled ? true : undefined,
        title: opt.title || opts?.title || undefined,
        text: opt.label,
        onClick: () => {
          if (disabled || opt.disabled) return;
          onPick(opt.value);
        },
      })
    )
  );
}

async function refreshAllData() {
  const [appRes, stRes, vpnRes, hostProxyRes, skillRes, tabsRes, seRes, psRes, modRes] = await Promise.allSettled([
    apiRpc("ui.getAppearance"),
    apiGet("/api/state"),
    apiGet("/api/vpn/store"),
    apiGet("/api/vpn/host-proxy"),
    apiGet("/api/skill"),
    apiRpc("page.listNativeTabs"),
    apiGet("/api/search-engine"),
    apiGet("/api/privacy-shield"),
    apiGet("/api/modules"),
  ]);
  if (appRes.status === "fulfilled" && appRes.value) {
    state.appearance = {
      ...state.appearance,
      ...appRes.value,
      nativeUi: { ...(state.appearance.nativeUi || {}), ...(appRes.value.nativeUi || {}) },
    };
  }
  if (stRes.status === "fulfilled" && stRes.value) state.kernelState = stRes.value;
  if (vpnRes.status === "fulfilled" && vpnRes.value) state.vpnArchive = vpnRes.value;
  if (hostProxyRes.status === "fulfilled" && hostProxyRes.value) state.hostProxy = hostProxyRes.value;
  if (skillRes.status === "fulfilled" && skillRes.value) state.skillInfo = skillRes.value;
  if (tabsRes.status === "fulfilled" && Array.isArray(tabsRes.value?.tabs)) {
    state.nativeTabs = tabsRes.value.tabs;
  }
  if (seRes.status === "fulfilled" && seRes.value?.engine) {
    state.searchEngine = seRes.value.engine;
  }
  if (psRes.status === "fulfilled" && psRes.value?.privacyShield) {
    state.privacyShield = { ...state.privacyShield, ...psRes.value.privacyShield };
  }
  if (modRes.status === "fulfilled" && Array.isArray(modRes.value?.modules)) {
    state.modulesState = modRes.value;
  }
  if (typeof sendWithPromise === "function") {
    try {
      const nativeSe = await sendWithPromise("gadorGetSearchEngine");
      if (nativeSe?.activeId) state.searchEngine = nativeSe.activeId;
    } catch {}
    try {
      const gAcc = await sendWithPromise("gadorGetGoogleAccounts");
      if (gAcc && Array.isArray(gAcc.accounts)) {
        state.googleAccounts = gAcc.accounts.filter((a) => !a.signedOut && a.valid !== false);
      }
    } catch {}
  }
}

async function applyAppearance(patch, toastMsg) {
  try {
    const res = await apiRpc("ui.setAppearance", patch);
    if (res) {
      state.appearance = {
        ...state.appearance,
        ...res,
        nativeUi: { ...(state.appearance.nativeUi || {}), ...(res.nativeUi || {}) },
      };
    }
    const latest = await apiRpc("ui.getAppearance").catch(() => null);
    if (latest) {
      state.appearance = {
        ...state.appearance,
        ...latest,
        nativeUi: { ...(state.appearance.nativeUi || {}), ...(latest.nativeUi || {}) },
      };
    }
    if (toastMsg) showToast(toastMsg);
    renderGadorPanel();
  } catch (err) {
    showToast(`应用失败：${err.message}`, true);
  }
}

function renderAppearanceFused(root) {
  const a = state.appearance;
  const nui = a.nativeUi || {};
  const activeHex = /^#[0-9a-f]{6}$/i.test(a.accentColor || "")
    ? a.accentColor
    : nui.tabAccentColor || "#7d98ff";

  root.style.setProperty("--gd-accent", activeHex);

  root.appendChild(
    el("div", { class: "gd-page-head" }, [
      el("div", {}, [
        el("h1", { text: "外观与光场" }),
        el("p", {
          text: "统一配置 Gador 的日夜间主题、光效主色、标签栏布局与原生字体缩放；日常与 AI 页面视口完全一致，仅以标签与边缘光效标识 AI 托管。",
        }),
      ]),
      el("button", {
        type: "button",
        class: "gd-btn",
        text: "恢复默认外观",
        onClick: () => applyAppearance({ resetDefaults: true }, "已恢复 Gador 默认外观"),
      }),
    ])
  );

  root.appendChild(
    el("div", { class: "gd-preview-banner" }, [
      el("div", { class: "gd-mini-tab" }, [
        el("span", { class: "gd-mini-bar", style: { background: "rgba(127,127,127,0.3)" } }),
        el("span", { text: "普通日常标签 · 无光效" }),
      ]),
      el("div", { class: "gd-mini-tab ai-running" }, [
        el("span", { class: "gd-mini-bar", style: { background: nui.aiAuraColor || "#7d98ff" } }),
        el("span", { text: "AI 运行中 · 蓝紫光效" }),
      ]),
      el("div", { class: "gd-mini-tab ai-paused" }, [
        el("span", { class: "gd-mini-bar", style: { background: "#f59e0b" } }),
        el("span", { text: "人工接管 · 琥珀暂停" }),
      ]),
    ])
  );

  const customColor = el("input", {
    type: "color",
    value: activeHex,
    "aria-label": "自定义主题色",
    style: { width: "32px", height: "28px", border: "0", background: "transparent", cursor: "pointer" },
  });

  root.appendChild(el("div", { class: "gd-section-label", text: "主题与光效色调" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "日夜间外观模式" }),
          el("span", { text: "同步切换浏览器窗口、标签栏与设置页主题" }),
        ]),
        makeSegmented(
          [
            { value: "system", label: "跟随系统" },
            { value: "light", label: "日间" },
            { value: "dark", label: "夜间" },
          ],
          a.theme || "system",
          (val) => applyAppearance({ theme: val }, "已切换外观模式"),
          true
        ),
      ]),
      el("div", { class: "gd-item stack" }, [
        el("div", { class: "gd-item-head" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "光效主题色" }),
            el("span", { text: "点亮激活标签光条、按钮焦点与细微框架色调" }),
          ]),
          el("span", { class: "gd-pill", text: a.accentColor || "自适应" }),
        ]),
        el(
          "div",
          { class: "gd-swatches" },
          ACCENT_PRESETS.map((preset) => {
            const isActive = preset.hex
              ? (a.accentColor || "").toLowerCase() === preset.hex.toLowerCase()
              : !a.accentColor;
            return el(
              "button",
              {
                type: "button",
                class: `gd-swatch${isActive ? " active" : ""}`,
                "data-accent-id": preset.id,
                onClick: () =>
                  applyAppearance(
                    { accentColor: preset.hex || "adaptive" },
                    `已应用主题色：${preset.label}`
                  ),
              },
              [
                el("span", {
                  class: "gd-dot",
                  style: {
                    background:
                      preset.hex ||
                      "conic-gradient(#38bdf8, #818cf8, #a855f7, #f43f5e, #38bdf8)",
                  },
                }),
                el("span", { text: preset.label }),
              ]
            );
          })
        ),
        el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } }, [
          el("div", { style: { display: "flex", alignItems: "center", gap: "10px" } }, [
            customColor,
            el("div", { class: "gd-item-info" }, [
              el("strong", { text: "自定义十六进制色值" }),
              el("span", { text: "自由取色并实时热更新至原生标签栏" }),
            ]),
          ]),
          el("button", {
            type: "button",
            class: "gd-btn primary",
            text: "应用自定义色",
            onClick: () =>
              applyAppearance({ accentColor: customColor.value }, `已应用自定义色 ${customColor.value}`),
          }),
        ]),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "标签栏色调饱和度" }),
          el("span", { text: "默认「柔雅中性」避免侧边栏/顶栏变成刺眼单色" }),
        ]),
        makeSegmented(
          [
            { value: "neutral", label: "柔雅中性" },
            { value: "tonal", label: "温和色调" },
            { value: "vibrant", label: "鲜明饱和" },
          ],
          nui.colorVariant || "neutral",
          (val) => applyAppearance({ colorVariant: val }, "已更新标签栏色调饱和度"),
          true
        ),
      ]),
    ])
  );

  const intensityVal = Number(nui.aiAuraIntensity ?? 1.0);
  const intensityBucket = intensityVal <= 0.72 ? "soft" : intensityVal >= 1.25 ? "vivid" : "standard";

  root.appendChild(el("div", { class: "gd-section-label", text: "标签栏布局与 AI 光效" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "标签栏排布方式" }),
          el("span", { text: "在 Zen 竖向侧边栏与顶部横向标签栏间无缝切换" }),
        ]),
        makeSegmented(
          [
            { value: "sidebar", label: "Zen 竖向侧边栏" },
            { value: "chrome", label: "顶部横向栏" },
          ],
          a.layout === "sidebar" ? "sidebar" : "chrome",
          (val) =>
            applyAppearance(
              { layout: val },
              val === "sidebar" ? "已切换为 Zen 竖向侧边栏" : "已切换为顶部横向栏"
            ),
          true
        ),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "Zen 侧边栏紧凑折叠" }),
          el("span", { text: "竖向模式下收窄为图标条，释放更大网页视口" }),
        ]),
        makeToggle(Boolean(a.compact), "Zen 侧边栏紧凑折叠", (val) =>
          applyAppearance({ compact: val }, val ? "已开启紧凑折叠" : "已展开侧边栏")
        ),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "始终显示书签栏" }),
          el("span", { text: "与原生书签栏快捷键（Ctrl+Shift+B）实时同步" }),
        ]),
        makeToggle(a.showBookmarkBar !== false, "始终显示书签栏", (val) =>
          applyAppearance({ showBookmarkBar: val }, val ? "已显示原生书签栏" : "已隐藏原生书签栏")
        ),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "激活标签光效指示条" }),
          el("span", { text: "竖向侧边栏左侧光柱 / 顶部标签栏顶缘高光条" }),
        ]),
        makeToggle(nui.tabActiveAccentBar !== false, "激活标签光效指示条", (val) =>
          applyAppearance({ tabActiveAccentBar: val }, val ? "已开启激活标签光条" : "已关闭激活标签光条")
        ),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "AI 托管视口边缘光效" }),
          el("span", { text: "仅在切到 AI 正在操作的标签页时于视口四边亮起" }),
        ]),
        makeToggle(nui.aiAuraEnabled !== false, "AI 托管视口边缘光效", (val) =>
          applyAppearance({ aiAuraEnabled: val }, val ? "已开启 AI 视口光效" : "已关闭 AI 视口光效")
        ),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "AI 光效亮度等级" }),
          el("span", { text: "实时写入 ~/.config/gador/native-ui.json 热生效" }),
        ]),
        makeSegmented(
          [
            { value: "soft", label: "柔和" },
            { value: "standard", label: "标准" },
            { value: "vivid", label: "璀璨" },
          ],
          intensityBucket,
          (val) => {
            const num = val === "soft" ? 0.65 : val === "vivid" ? 1.45 : 1.0;
            applyAppearance({ aiAuraIntensity: num }, "已调整 AI 光效亮度");
          },
          true
        ),
      ]),
    ])
  );

  root.appendChild(el("div", { class: "gd-native-divider", text: "基础外观、字体与页面缩放" }));
}

function renderAiView(root) {
  const ks = state.kernelState || {};
  const spaces = Array.isArray(ks.spaces) ? ks.spaces : [];
  const pages = Array.isArray(ks.pages) ? ks.pages : [];
  const nativeTabs = Array.isArray(state.nativeTabs) ? state.nativeTabs : [];
  const aiTabs = nativeTabs.filter((t) => t.aiControlled);
  const humanTabs = nativeTabs.filter((t) => !t.aiControlled);
  const runningCount = pages.filter((p) => {
    const sp = spaces.find((s) => s.spaceId === p.spaceId);
    return sp?.controlState !== "USER_ACTIVE";
  }).length;
  const pausedCount = pages.length - runningCount;

  root.appendChild(
    el("div", { class: "gd-page-head" }, [
      el("div", {}, [
        el("h1", { text: "AI 托管与总览" }),
        el("p", {
          text: "平时 AI 网页直接作为原生标签运行，仅用标签与边缘光效标识；在此总览页按「AI 托管 / 普通日常」统一管理，支持一键把已有网页交给 AI 或随时收回。",
        }),
      ]),
      el("div", { class: "gd-actions" }, [
        el("button", {
          type: "button",
          class: "gd-btn danger",
          text: "■ 停止全部 AI",
          onClick: async () => {
            for (const sp of spaces) {
              if (sp.controlState !== "USER_ACTIVE") {
                await apiRpc("takeover.request", { spaceId: sp.spaceId, reason: "user_settings_stop" }).catch(() => {});
              }
            }
            await refreshAllData();
            showToast("已冻结所有 AI 写入操作");
            renderGadorPanel();
          },
        }),
        el("button", {
          type: "button",
          class: "gd-btn",
          text: "▶ 恢复 AI",
          onClick: async () => {
            for (const sp of spaces) {
              if (sp.controlState === "USER_ACTIVE") {
                await apiRpc("takeover.release", { spaceId: sp.spaceId }).catch(() => {});
              }
            }
            await refreshAllData();
            showToast("已恢复 AI 运行");
            renderGadorPanel();
          },
        }),
        el("button", {
          type: "button",
          class: "gd-btn",
          text: "刷新",
          onClick: async () => {
            await refreshAllData();
            renderGadorPanel();
          },
        }),
      ]),
    ])
  );

  root.appendChild(
    el("div", { class: "gd-metrics" }, [
      el("div", { class: "gd-metric" }, [
        el("small", { text: "AI 托管标签" }),
        el("strong", { text: aiTabs.length > 0 ? `${aiTabs.length} 个发光标签` : "暂无" }),
        el("span", { text: runningCount > 0 ? `${runningCount} 页运行中` : "当前无 AI 任务" }),
      ]),
      el("div", { class: "gd-metric" }, [
        el("small", { text: "普通日常标签" }),
        el("strong", { text: `${humanTabs.length} 个原生标签` }),
        el("span", { text: "支持下方一键移交给 AI" }),
      ]),
      el("div", { class: "gd-metric" }, [
        el("small", { text: "安全围栏" }),
        el("strong", { text: pausedCount > 0 ? `${pausedCount} 页人工接管` : "密码/支付已锁定" }),
        el("span", { text: "内置页与凭据页禁止 AI 访问" }),
      ]),
    ])
  );

  root.appendChild(el("div", { class: "gd-section-label", text: `AI 正在操作的标签页（${aiTabs.length}）` }));
  root.appendChild(
    el(
      "section",
      { class: "gd-card" },
      aiTabs.length === 0
        ? [el("div", { class: "gd-empty", text: "暂无 AI 托管中的原生标签。可点击下方任意普通网页的「交给 AI」，或由外部 AI 打开网页。" })]
        : aiTabs.map((t) =>
            el("div", { class: "gd-item" }, [
              el("div", { class: "gd-item-info" }, [
                el("strong", { text: t.title || t.url || "AI 标签页" }),
                el("span", { text: `${t.aiState === "USER_ACTIVE" ? "琥珀暂停 · " : "蓝紫光效 · "}${t.url}` }),
              ]),
              el("div", { class: "gd-actions" }, [
                el("button", {
                  type: "button",
                  class: "gd-btn primary",
                  text: "跳转",
                  onClick: () => apiRpc("page.focusTab", { tabIndex: t.tabIndex }),
                }),
                el("button", {
                  type: "button",
                  class: "gd-btn danger",
                  text: "收回",
                  onClick: async () => {
                    await apiRpc("page.detachTab", { pageId: t.pageId });
                    await refreshAllData();
                    showToast("已收回该标签（网页保持打开）");
                    renderGadorPanel();
                  },
                }),
              ]),
            ])
          )
    )
  );

  root.appendChild(el("div", { class: "gd-section-label", text: `普通日常标签页（${humanTabs.length}）` }));
  root.appendChild(
    el(
      "section",
      { class: "gd-card" },
      humanTabs.length === 0
        ? [el("div", { class: "gd-empty", text: "暂无其他普通日常标签页。" })]
        : humanTabs.map((t) => {
            const canHandover = /^https?:\/\//i.test(t.url || "") || t.url === "about:blank";
            return el("div", { class: "gd-item" }, [
              el("div", { class: "gd-item-info" }, [
                el("strong", { text: t.title || t.url || "标签页" }),
                el("span", { text: t.url || "about:blank" }),
              ]),
              el("div", { class: "gd-actions" }, [
                el("button", {
                  type: "button",
                  class: "gd-btn",
                  text: "跳转",
                  onClick: () => apiRpc("page.focusTab", { tabIndex: t.tabIndex }),
                }),
                canHandover
                  ? el("button", {
                      type: "button",
                      class: "gd-btn primary",
                      text: "交给 AI",
                      onClick: async () => {
                        try {
                          await apiRpc("page.attachActiveTab", { tabIndex: t.tabIndex });
                          await refreshAllData();
                          showToast("已将该网页交给 AI，对应标签已亮起光效");
                          renderGadorPanel();
                        } catch (e) {
                          showToast(`移交失败：${e.message}`, true);
                        }
                      },
                    })
                  : el("span", { class: "gd-pill", text: "内置保护页" }),
              ]),
            ]);
          })
    )
  );

  const skill = state.skillInfo;
  root.appendChild(el("div", { class: "gd-section-label", text: "外部 AI（MCP / Skill）接入" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "一键复制 Skill 与 MCP 配置" }),
          el("span", { text: `控制面 Socket：${ks.socketPath || "$XDG_RUNTIME_DIR/gador/ctl.sock"}（0600 权限）` }),
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn primary",
            text: "复制 SKILL.md",
            onClick: async () => {
              const md = skill?.skillContent || skill?.skillMarkdown;
              if (md) {
                await navigator.clipboard.writeText(md);
                showToast("已复制 SKILL.md 全文");
              }
            },
          }),
          el("button", {
            type: "button",
            class: "gd-btn",
            text: "复制 MCP JSON",
            onClick: async () => {
              const jsonStr =
                skill?.mcpConfigJson ||
                (skill?.mcpConfigSnippet ? JSON.stringify(skill.mcpConfigSnippet, null, 2) : "");
              if (jsonStr) {
                await navigator.clipboard.writeText(jsonStr);
                showToast("已复制 MCP 配置 JSON");
              }
            },
          }),
        ]),
      ]),
      el("div", { class: "gd-item stack" }, [
        el("div", { class: "gd-item-info" }, [el("strong", { text: "已开放给 AI 的工具" })]),
        el(
          "div",
          { class: "gd-tags" },
          (skill?.tools || []).map((t) => el("span", { class: "gd-code", text: typeof t === "string" ? t : t.name }))
        ),
      ]),
    ])
  );
}

function getModuleEntry(id) {
  return (state.modulesState?.modules || []).find((m) => m.id === id) || null;
}

function renderModuleInstallGate(root, moduleId, meta) {
  const mod = getModuleEntry(moduleId);
  const installed = Boolean(mod?.installed);
  const enabled = Boolean(mod?.enabled);
  const conflict = mod?.conflictState || { blocked: false, blockedBy: [], missingDependencies: [], exclusiveGroups: [] };
  const busy = Boolean(state.busyOps[`mod:${moduleId}`]);
  const ver = mod?.verification || {};
  const sigBadge = ver.valid
    ? `Ed25519 签名已校验 · ${ver.keyId || "trusted"} · sha256:${ver.shortDigest || ""}`
    : "🚫 签名校验失败";

  // Uninstalled modules NEVER expose a direct one-click install button inside regular browser settings;
  // installation must follow the Module Developer & Operations Manual via verified CLI (`gador-mod`).
  if (!installed) {
    root.appendChild(
      el("div", { class: "gd-page-head" }, [
        el("div", {}, [
          el("h1", { text: meta.title }),
          el("p", { text: meta.subtitle }),
        ]),
        el("span", { class: "gd-pill", text: "独立扩展模块 · 未整合" }),
      ])
    );
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item stack" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: `${meta.moduleName} 尚未整合` }),
            el("span", {
              text: "为保证安全边界，本页面不直接提供模块安装入口；如需启用官方模块或自研第三方同类模块，请查阅《自定义模块开发与签名验证指南》(docs/module-developer-guide.md)，在终端通过 gador-mod 完成签名核验后整合。",
            }),
          ]),
          el("div", { class: "gd-tags" }, [
            el("span", { class: "gd-code", text: `分类：${mod?.category || meta.category || "optional"}` }),
            ...(conflict.exclusiveGroups || []).map((g) =>
              el("span", { class: "gd-code", text: `互斥槽位：${g}` })
            ),
            el("span", { class: "gd-code", text: `验证命令：gador-mod verify ${moduleId}` }),
            el("span", { class: "gd-code", text: `文档：docs/module-developer-guide.md` }),
          ]),
        ]),
      ])
    );
    return { installed: false, enabled: false };
  }

  // Installed but currently disabled: show conflict / waiting badges + enable/uninstall controls
  const blockReasons = [
    ...(conflict.blockedBy || []).map((b) => b.reason),
    ...(conflict.missingDependencies || []).map((d) => d.reason),
  ];

  root.appendChild(
    el("div", { class: "gd-page-head" }, [
      el("div", {}, [
        el("h1", { text: meta.title }),
        el("p", { text: meta.subtitle }),
      ]),
      busy
        ? el("span", { class: "gd-pill waiting", text: "⏳ 正在处理，请等待…" })
        : conflict.blocked
          ? el("span", { class: "gd-pill forbidden", text: "🚫 冲突禁止同时开启" })
          : el("span", { class: "gd-pill", text: "已安装 · 当前已停用" }),
    ])
  );

  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: `gd-item stack${conflict.blocked ? " is-blocked" : ""}` }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", {
            text: conflict.blocked
              ? `🚫 ${meta.moduleName} 因互斥冲突禁止启用`
              : `${meta.moduleName} 当前处于停用状态`,
          }),
          el("span", {
            text: conflict.blocked
              ? blockReasons.join("；")
              : "重新启用前会自动复核 Ed25519 签名、文件 SHA-256 完整性与互斥槽位状态。",
          }),
        ]),
        el("div", { class: "gd-tags" }, [
          el("span", { class: `gd-pill${ver.valid ? " ok" : " forbidden"}`, text: sigBadge }),
          ...(conflict.exclusiveGroups || []).map((g) =>
            el("span", { class: "gd-code", text: `互斥槽位：${g}` })
          ),
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn primary",
            disabled: busy || conflict.blocked || !ver.valid ? true : undefined,
            title: conflict.blocked ? blockReasons.join("；") : undefined,
            text: busy
              ? "⏳ 等待校验启用…"
              : conflict.blocked
                ? "🚫 冲突禁止启用"
                : `验证并启用 ${meta.shortName} 模块`,
            onClick: async () => {
              if (busy || conflict.blocked) return;
              state.busyOps[`mod:${moduleId}`] = true;
              renderGadorPanel();
              try {
                await apiPost(`/api/modules/${encodeURIComponent(moduleId)}/toggle`, { enabled: true });
                await refreshAllData();
                showToast(`已通过完整性与冲突校验并启用 ${meta.shortName} 模块`);
              } catch (e) {
                showToast(`启用被拦截：${e.message}`, true);
              } finally {
                delete state.busyOps[`mod:${moduleId}`];
                renderGadorPanel();
              }
            },
          }),
          el("button", {
            type: "button",
            class: "gd-btn danger",
            disabled: busy ? true : undefined,
            text: busy ? "⏳ 等待中…" : "卸载模块",
            onClick: async () => {
              if (busy) return;
              state.busyOps[`mod:${moduleId}`] = true;
              renderGadorPanel();
              try {
                await apiPost(`/api/modules/${encodeURIComponent(moduleId)}/uninstall`, { purge: false });
                await refreshAllData();
                showToast(`已卸载 ${meta.shortName} 模块（用户配置已保留）`);
              } catch (e) {
                showToast(`卸载失败：${e.message}`, true);
              } finally {
                delete state.busyOps[`mod:${moduleId}`];
                renderGadorPanel();
              }
            },
          }),
        ]),
      ]),
    ])
  );
  return { installed, enabled };
}

function renderModuleStatusStrip(moduleId, shortName, restartHint = false) {
  const mod = getModuleEntry(moduleId);
  const busy = Boolean(state.busyOps[`mod:${moduleId}`]);
  const groups = mod?.conflictState?.exclusiveGroups || [];
  return el("div", { class: "gd-item" }, [
    el("div", { class: "gd-item-info" }, [
      el("strong", {
        text: busy
          ? `⏳ 正在更新模块状态：${shortName}…`
          : `独立模块状态：${shortName}（已验证整合${groups.length ? ` · 占用互斥槽位 ${groups.join("/")}` : ""}）`,
      }),
      el("span", {
        text: restartHint
          ? `同槽位其他模块将自动标记 🚫 禁止同时开启；可通过 CLI「gador-mod disable/uninstall ${moduleId}」管理。`
          : `同槽位其他模块将自动标记 🚫 禁止同时开启；可通过 CLI「gador-mod disable/uninstall ${moduleId}」随时停用或卸载。`,
      }),
    ]),
    el("div", { class: "gd-actions" }, [
      el("button", {
        type: "button",
        class: "gd-btn",
        disabled: busy ? true : undefined,
        text: busy ? "⏳ 等待中…" : "停用模块",
        onClick: async () => {
          if (busy) return;
          state.busyOps[`mod:${moduleId}`] = true;
          renderGadorPanel();
          try {
            await apiPost(`/api/modules/${encodeURIComponent(moduleId)}/toggle`, { enabled: false });
            await refreshAllData();
            showToast(`已停用 ${shortName} 模块`);
          } catch (e) {
            showToast(`停用失败：${e.message}`, true);
          } finally {
            delete state.busyOps[`mod:${moduleId}`];
            renderGadorPanel();
          }
        },
      }),
      el("button", {
        type: "button",
        class: "gd-btn danger",
        disabled: busy ? true : undefined,
        text: busy ? "⏳ 等待中…" : "卸载模块",
        onClick: async () => {
          if (busy) return;
          state.busyOps[`mod:${moduleId}`] = true;
          renderGadorPanel();
          try {
            await apiPost(`/api/modules/${encodeURIComponent(moduleId)}/uninstall`, { purge: false });
            await refreshAllData();
            showToast(`已卸载 ${shortName} 模块（历史配置已保留）`);
          } catch (e) {
            showToast(`卸载失败：${e.message}`, true);
          } finally {
            delete state.busyOps[`mod:${moduleId}`];
            renderGadorPanel();
          }
        },
      }),
    ]),
  ]);
}

function renderVpnView(root) {
  const vpnMod = getModuleEntry("vpn");
  if (vpnMod && (!vpnMod.installed || !vpnMod.enabled)) {
    renderModuleInstallGate(root, "vpn", {
      title: "网络与独立 VPN",
      subtitle: "独立隧道档案库、修改前强制快照备份、宿主机代理跟随与 AI VPN-Only MCP 工具集。",
      moduleName: "Gador 独立 VPN 与代理管理模块（vpn）",
      shortName: "VPN",
      capabilities: ["独立隧道配置", "强制备份库", "跟随宿主机代理", "vpn_* MCP"],
      restartHint: false,
    });
    return;
  }

  const archive = state.vpnArchive || { profiles: [], backups: [] };
  const routes = Array.isArray(state.kernelState?.routes) ? state.kernelState.routes : [];
  const hp = state.hostProxy || { enabled: false, detected: false, endpoint: "", source: "未探测" };
  const f = state.vpnForm;
  const vpnBusy = Boolean(state.busyOps.vpn);
  const hostProxyOn = Boolean(hp.enabled);
  const hasStrictManualTunnel =
    !hostProxyOn && routes.some((r) => r.scope === "browser" && r.mode === "strict_tunnel");

  const toggleFollowHostProxy = async (enable) => {
    if (vpnBusy) return;
    if (enable && hasStrictManualTunnel) {
      showToast("🚫 冲突禁止：当前严格独立隧道正在运行，请先点击「恢复浏览器直连」后再开启跟随宿主机代理", true);
      return;
    }
    state.busyOps.vpn = true;
    renderGadorPanel();
    try {
      const res = await apiPost("/api/vpn/follow-host-proxy", {
        enabled: enable,
        scope: f.scope.trim() || "browser",
      });
      state.hostProxy = res;
      await refreshAllData();
      if (enable) {
        showToast(
          res.detected && res.endpoint
            ? `已开启跟随宿主机代理：${res.endpoint}`
            : "已开启跟随宿主机代理（当前宿主机直连，检测到代理后自动同步）"
        );
      } else {
        showToast("已关闭跟随宿主机代理，恢复独立网络隔离");
      }
    } catch (e) {
      showToast(`切换宿主机代理失败：${e.message}`, true);
    } finally {
      delete state.busyOps.vpn;
      renderGadorPanel();
    }
  };

  root.appendChild(
    el("div", { class: "gd-page-head" }, [
      el("div", {}, [
        el("h1", { text: "网络与独立 VPN" }),
        el("p", {
          text: "默认彻底隔离宿主机代理并阻断 WebRTC 泄漏；「跟随宿主机代理」与「手动独立隧道」互斥，同一时间仅允许启用一种出口模式。",
        }),
      ]),
      el("div", { class: "gd-actions" }, [
        vpnBusy ? el("span", { class: "gd-pill waiting", text: "⏳ 正在同步路由，请等待…" }) : null,
        el("button", {
          type: "button",
          class: hp.enabled ? "gd-btn primary" : "gd-btn",
          "data-vpn-action": "follow-host",
          disabled: vpnBusy || (!hp.enabled && hasStrictManualTunnel) ? true : undefined,
          title:
            !hp.enabled && hasStrictManualTunnel
              ? "🚫 冲突禁止：严格独立隧道生效中，无法同时开启跟随宿主机代理"
              : undefined,
          text: vpnBusy
            ? "⏳ 同步中…"
            : !hp.enabled && hasStrictManualTunnel
              ? "🚫 冲突禁止：跟随宿主机代理"
              : hp.enabled
                ? "✓ 正在跟随宿主机代理"
                : "跟随宿主机代理",
          onClick: () => toggleFollowHostProxy(!hp.enabled),
        }),
        el("button", {
          type: "button",
          class: "gd-btn",
          disabled: vpnBusy ? true : undefined,
          text: vpnBusy ? "⏳ 等待中…" : "恢复浏览器直连",
          onClick: async () => {
            if (vpnBusy) return;
            state.busyOps.vpn = true;
            renderGadorPanel();
            try {
              await apiPost("/api/vpn/follow-host-proxy", { enabled: false, scope: "browser" });
              await apiRpc("network.setTunnel", { scope: "browser", mode: "direct_only", failClosed: false });
              await refreshAllData();
              showToast("已恢复浏览器独立直连");
            } catch (e) {
              showToast(`切换失败：${e.message}`, true);
            } finally {
              delete state.busyOps.vpn;
              renderGadorPanel();
            }
          },
        }),
      ]),
    ])
  );

  root.appendChild(
    el("div", { class: "gd-metrics" }, [
      el("div", { class: "gd-metric" }, [
        el("small", { text: "代理出口模式" }),
        el("strong", { text: hp.enabled ? "跟随宿主机代理" : "系统代理已隔离" }),
        el("span", { text: hp.enabled ? (hp.endpoint || hp.source) : "宿主机代理变更绝不覆写 Gador" }),
      ]),
      el("div", { class: "gd-metric" }, [
        el("small", { text: "WebRTC 防泄漏" }),
        el("strong", { text: "disable_non_proxied_udp" }),
        el("span", { text: "阻断非隧道 UDP 真实 IP 泄漏" }),
      ]),
      el("div", { class: "gd-metric" }, [
        el("small", { text: "Fail-Closed 熔断" }),
        el("strong", { text: routes.length > 0 ? `${routes.length} 条策略生效` : "待命保护" }),
        el("span", { text: "断链绝不静默回退直连" }),
      ]),
    ])
  );

  root.appendChild(el("div", { class: "gd-section-label", text: "宿主机代理联动" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "跟随宿主机代理" }),
          el("span", {
            text: hp.detected
              ? `已探测到宿主机代理：${hp.endpoint}（来源：${hp.source}）`
              : `${hp.source}；开启后自动同步环境变量 / GNOME / KDE / 本机 Clash·V2Ray 端口`,
          }),
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn",
            text: "重新探测",
            onClick: async () => {
              await refreshAllData();
              showToast(
                state.hostProxy?.detected
                  ? `已探测到宿主机代理：${state.hostProxy.endpoint}`
                  : "未检测到运行中的宿主机代理"
              );
              renderGadorPanel();
            },
          }),
          makeToggle(Boolean(hp.enabled), "跟随宿主机代理", (next) => toggleFollowHostProxy(next), {
            disabled: vpnBusy || (!hp.enabled && hasStrictManualTunnel),
            blockedMessage: "🚫 冲突禁止：严格独立隧道运行中，请先恢复直连再开启跟随宿主机代理",
          }),
        ]),
      ]),
    ])
  );

  const scopeInput = el("input", {
    class: "gd-input",
    value: f.scope,
    placeholder: "browser 或 space:sp_1",
    onInput: (e) => (f.scope = e.target.value),
  });
  const endpointInput = el("input", {
    class: "gd-input",
    value: f.endpoint,
    placeholder: "socks5://127.0.0.1:7890",
    onInput: (e) => (f.endpoint = e.target.value),
  });
  const dohInput = el("input", {
    class: "gd-input",
    value: f.dohUrl,
    placeholder: "https://dns.quad9.net/dns-query",
    onInput: (e) => (f.dohUrl = e.target.value),
  });
  const nameInput = el("input", {
    class: "gd-input",
    value: f.profileName,
    placeholder: "为策略命名（如：日本低延迟节点）",
    onInput: (e) => (f.profileName = e.target.value),
  });

  root.appendChild(el("div", { class: "gd-section-label", text: "独立出口策略配置" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item stack" }, [
        el("div", { class: "gd-form-grid" }, [
          el("div", { class: "gd-field" }, [el("label", { text: "作用域（shared 沿用 browser；private 可独立）" }), scopeInput]),
          el("div", { class: "gd-field" }, [
            el("label", { text: "路由模式" }),
            makeSegmented(
              [
                { value: "strict_tunnel", label: "严格隧道" },
                { value: "direct_only", label: "仅直连" },
                { value: "custom", label: "自定义分流" },
              ],
              f.mode,
              (v) => {
                f.mode = v;
                renderGadorPanel();
              }
            ),
          ]),
          el("div", { class: "gd-field" }, [el("label", { text: "隧道端点（socks5 / http / https / quic）" }), endpointInput]),
          el("div", { class: "gd-field" }, [el("label", { text: "独立 DoH 服务器（可选）" }), dohInput]),
        ]),
      ]),
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "启用 Fail-Closed 断链熔断" }),
          el("span", { text: "隧道断开时严格阻断出网并返回错误码，杜绝静默直连" }),
        ]),
        makeToggle(f.failClosed, "启用 Fail-Closed 熔断", (v) => {
          f.failClosed = v;
        }),
      ]),
      el("div", { class: `gd-item${hostProxyOn ? " is-blocked" : ""}` }, [
        el("div", { style: { flex: "1", minWidth: "180px" } }, [
          nameInput,
          hostProxyOn
            ? el("div", { style: { marginTop: "6px" } }, [
                el("span", {
                  class: "gd-pill forbidden",
                  text: "🚫 冲突禁止热更新：正在跟随宿主机代理，请先关闭跟随再手动下发独立隧道",
                }),
              ])
            : null,
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn primary",
            disabled: vpnBusy || hostProxyOn ? true : undefined,
            title: hostProxyOn ? "🚫 冲突禁止：请先关闭「跟随宿主机代理」" : undefined,
            text: vpnBusy ? "⏳ 同步中…" : hostProxyOn ? "🚫 禁止热更新" : "热更新出口",
            onClick: async () => {
              if (vpnBusy || hostProxyOn) return;
              state.busyOps.vpn = true;
              renderGadorPanel();
              try {
                await apiRpc("network.setTunnel", {
                  scope: f.scope.trim() || "browser",
                  mode: f.mode,
                  endpoint: f.endpoint.trim() || undefined,
                  dohServer: f.dohUrl.trim() || undefined,
                  failClosed: f.failClosed,
                });
                await refreshAllData();
                showToast("独立出口策略已热更新");
              } catch (e) {
                showToast(`更新失败：${e.message}`, true);
              } finally {
                delete state.busyOps.vpn;
                renderGadorPanel();
              }
            },
          }),
          el("button", {
            type: "button",
            class: "gd-btn",
            text: "保存为档案",
            onClick: async () => {
              try {
                await apiPost("/api/vpn/profiles", {
                  actor: "user",
                  backupReason: "user_settings_save_profile",
                  name: f.profileName.trim() || "未命名 VPN 档案",
                  scope: f.scope.trim() || "browser",
                  mode: f.mode,
                  endpoint: f.endpoint.trim(),
                  dohServer: f.dohUrl.trim(),
                  failClosed: f.failClosed,
                });
                f.profileName = "";
                await refreshAllData();
                showToast("已自动备份并保存 VPN 档案");
                renderGadorPanel();
              } catch (e) {
                showToast(`保存失败：${e.message}`, true);
              }
            },
          }),
        ]),
      ]),
    ])
  );

  root.appendChild(el("div", { class: "gd-section-label", text: `VPN 开放档案（仅 VPN 允许 AI 修改 · ${(archive.profiles || []).length} 条）` }));
  root.appendChild(
    el(
      "section",
      { class: "gd-card" },
      (archive.profiles || []).length === 0
        ? [el("div", { class: "gd-empty", text: "暂无保存的 VPN 档案。上方配置后可点击「保存为档案」。" })]
        : archive.profiles.map((p) =>
            el("div", { class: "gd-item" }, [
              el("div", { class: "gd-item-info" }, [
                el("strong", { text: p.name }),
                el("span", { text: `${p.scope} · ${p.mode} · ${p.endpoint || "直连"}` }),
              ]),
              el("div", { class: "gd-actions" }, [
                el("button", {
                  type: "button",
                  class: "gd-btn",
                  text: "应用",
                  onClick: async () => {
                    await apiRpc("network.setTunnel", {
                      scope: p.scope,
                      mode: p.mode,
                      endpoint: p.endpoint || undefined,
                      dohServer: p.dohServer || p.dohUrl || undefined,
                      failClosed: Boolean(p.failClosed),
                    });
                    await refreshAllData();
                    showToast(`已应用档案：${p.name}`);
                    renderGadorPanel();
                  },
                }),
                el("button", {
                  type: "button",
                  class: "gd-btn danger",
                  text: "删除",
                  onClick: async () => {
                    try {
                      await apiDelete(`/api/vpn/profiles/${encodeURIComponent(p.id)}`);
                      await refreshAllData();
                      showToast(`已自动备份并删除：${p.name}`);
                      renderGadorPanel();
                    } catch (e) {
                      showToast(`删除失败：${e.message}`, true);
                    }
                  },
                }),
              ]),
            ])
          )
    )
  );

  root.appendChild(el("div", { class: "gd-section-label", text: `修改前强制备份区（${(archive.backups || []).length} 份快照 · 同页快捷删除）` }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", { text: "快照管理" }),
          el("span", { text: `路径：${archive.profilesPath || "~/.config/gador/vpn/profiles.json"}` }),
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn",
            text: "立即备份",
            onClick: async () => {
              await apiPost("/api/vpn/backups", { actor: "user", reason: "manual_settings_backup" });
              await refreshAllData();
              showToast("已创建 VPN 快照备份");
              renderGadorPanel();
            },
          }),
          el("button", {
            type: "button",
            class: "gd-btn danger",
            text: "清空备份",
            onClick: async () => {
              try {
                await apiDelete("/api/vpn/backups");
                await refreshAllData();
                showToast("已清空全部 VPN 备份");
                renderGadorPanel();
              } catch (e) {
                showToast(`清空失败：${e.message}`, true);
              }
            },
          }),
        ]),
      ]),
      ...((archive.backups || []).length === 0
        ? [el("div", { class: "gd-empty", text: "暂无备份快照。" })]
        : archive.backups.map((b) =>
            el("div", { class: "gd-item" }, [
              el("div", { class: "gd-item-info" }, [
                el("strong", { text: b.id }),
                el("span", { text: `${b.actor || "system"} · ${b.reason || "auto_backup"} · ${b.profileCount ?? 0} 条档案` }),
              ]),
              el("div", { class: "gd-actions" }, [
                el("button", {
                  type: "button",
                  class: "gd-btn",
                  text: "恢复",
                  onClick: async () => {
                    try {
                      await apiPost(`/api/vpn/backups/${encodeURIComponent(b.id)}/restore`, {
                        actor: "user",
                        reason: "user_settings_restore",
                      });
                      await refreshAllData();
                      showToast(`已恢复备份：${b.id}`);
                      renderGadorPanel();
                    } catch (e) {
                      showToast(`恢复失败：${e.message}`, true);
                    }
                  },
                }),
                el("button", {
                  type: "button",
                  class: "gd-btn danger",
                  text: "删除",
                  onClick: async () => {
                    try {
                      await apiDelete(`/api/vpn/backups/${encodeURIComponent(b.id)}`);
                      await refreshAllData();
                      showToast(`已删除备份：${b.id}`);
                      renderGadorPanel();
                    } catch (e) {
                      showToast(`删除失败：${e.message}`, true);
                    }
                  },
                }),
              ]),
            ])
          )),
    ])
  );

  root.appendChild(el("div", { class: "gd-section-label", text: "独立模块管理" }));
  root.appendChild(
    el("section", { class: "gd-card" }, [
      renderModuleStatusStrip("vpn", "独立 VPN", false),
    ])
  );
}

function renderContextualBanner(root, mode) {
  if (mode === "people") {
    const accounts = Array.isArray(state.googleAccounts) ? state.googleAccounts : [];
    const signedIn = accounts.length > 0;
    const cardChildren = [
      el("div", { class: "gd-item" }, [
        el("div", { class: "gd-item-info" }, [
          el("strong", {
            text: signedIn
              ? `已登录 Google 账号（共 ${accounts.length} 个）`
              : "Google 账号登录与共享工作区",
          }),
          el("span", {
            text: signedIn
              ? "您的 Google 网页登录态已在普通标签页与 shared 共享 AI 空间无缝互通，随时可管理账号或切换更多账号。"
              : "支持直接登录 Google 账号（Gmail / YouTube / Drive / Gemini），登录后在普通标签页与 shared 共享 AI 空间无缝互通。",
          }),
        ]),
        el("div", { class: "gd-actions" }, [
          el("button", {
            type: "button",
            class: "gd-btn primary",
            text: signedIn ? "管理 Google 账号" : "登录 Google 账号",
            onClick: () =>
              window.open(
                signedIn ? "https://myaccount.google.com/" : "https://accounts.google.com/",
                "_blank"
              ),
          }),
          el("button", {
            type: "button",
            class: "gd-btn",
            text: signedIn ? "切换 / 添加账号" : "Google 服务设置",
            onClick: () => {
              if (signedIn) window.open("https://accounts.google.com/", "_blank");
              else location.href = "chrome://settings/syncSetup";
            },
          }),
        ]),
      ]),
    ];

    for (const acc of accounts) {
      const initial = (acc.displayName || acc.email || "G").trim().charAt(0).toUpperCase();
      const avatarNode = acc.photoUrl
        ? el("img", {
            class: "gd-account-avatar",
            src: acc.photoUrl,
            alt: acc.displayName || acc.email,
          })
        : el("div", { class: "gd-account-avatar", text: initial });
      cardChildren.push(
        el("div", { class: "gd-account-row" }, [
          avatarNode,
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: acc.displayName || acc.email }),
            el("span", { text: acc.email }),
          ]),
          el("span", { class: "gd-pill ok", text: acc.isDefault ? "默认已登录" : "已登录" }),
        ])
      );
    }

    root.appendChild(el("section", { class: "gd-card" }, cardChildren));
  } else if (mode === "search") {
    const engines = [
      { id: "google", name: "Google", desc: "google.com · 全球综合与技术检索", badge: "G", bg: "linear-gradient(135deg,#4285f4,#34a853)" },
      { id: "bing", name: "Bing", desc: "bing.com · 微软必应中英文检索", badge: "B", bg: "linear-gradient(135deg,#008373,#0ea5e9)" },
      { id: "baidu", name: "百度", desc: "baidu.com · 中文网页与百科检索", badge: "度", bg: "linear-gradient(135deg,#2563eb,#3b82f6)" },
      { id: "duckduckgo", name: "DuckDuckGo", desc: "duckduckgo.com · 隐私无追踪检索", badge: "D", bg: "linear-gradient(135deg,#de5833,#f97316)" },
    ];
    const switchEngine = async (engineId, engineName) => {
      try {
        if (typeof sendWithPromise === "function") {
          await sendWithPromise("gadorSetSearchEngine", engineId);
        }
        await apiPost("/api/search-engine", { engine: engineId }).catch(() => {});
        state.searchEngine = engineId;
        showToast(`默认搜索引擎已切换为 ${engineName}（地址栏与新标签页同步生效）`);
        renderGadorPanel();
      } catch (e) {
        showToast(`切换失败：${e.message}`, true);
      }
    };
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "Gador 快捷搜索引擎切换" }),
            el("span", { text: "一键切换地址栏与新标签页默认搜索引擎，内置 Google、Bing、百度、DuckDuckGo 四个引擎。" }),
          ]),
          el("span", { class: "gd-pill ok", text: `当前：${(engines.find((x) => x.id === state.searchEngine) || engines[0]).name}` }),
        ]),
        el(
          "div",
          { class: "gd-engine-grid" },
          engines.map((eng) => {
            const active = state.searchEngine === eng.id;
            return el(
              "button",
              {
                type: "button",
                class: `gd-engine-card${active ? " active" : ""}`,
                onClick: () => switchEngine(eng.id, eng.name),
              },
              [
                el("span", { class: "gd-engine-badge", text: eng.badge, style: { background: eng.bg } }),
                el("div", { class: "gd-engine-meta" }, [
                  el("div", { class: "gd-engine-title-row" }, [
                    el("strong", { text: eng.name }),
                    active ? el("span", { class: "gd-pill ok", text: "当前默认" }) : null,
                  ]),
                  el("span", { text: eng.desc }),
                ]),
              ]
            );
          })
        ),
      ])
    );
  } else if (mode === "autofill") {
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "Gador 凭据与支付物理隔离已启用" }),
            el("span", { text: "密码管理器、付款方式与自动填充对所有 AI 空间物理不可达；页面聚焦密码框时将强制切回人工接管。" }),
          ]),
          el("span", { class: "gd-pill ok", text: "AI 零权限" }),
        ]),
      ])
    );
  } else if (mode === "privacy") {
    const psMod = getModuleEntry("privacy-shield");
    if (!psMod || !psMod.installed) {
      // Do NOT display a direct one-click install button to regular users inside Settings.
      // Only show native Chromium privacy settings cleanly (with a minimal status card).
      const hp = state.hostProxy || {};
      root.appendChild(
        el("section", { class: "gd-card" }, [
          el("div", { class: "gd-item" }, [
            el("div", { class: "gd-item-info" }, [
              el("strong", { text: hp.enabled ? "当前出口：跟随宿主机代理" : "独立网络防泄漏与 WebRTC 保护已启用" }),
              el("span", { text: "强制 disable_non_proxied_udp；扩展型指纹防护模块遵循独立开发与签名验证规范，未整合时保持核心零注入。" }),
            ]),
            el("button", {
              type: "button",
              class: "gd-btn primary",
              text: "网络与独立 VPN",
              onClick: () => openFusedMode("vpn", true),
            }),
          ]),
        ])
      );
      return;
    }
    if (!psMod.enabled) {
      renderModuleInstallGate(root, "privacy-shield", {
        title: "隐私与指纹防护",
        subtitle: "独立可插拔 MV3 反指纹扩展模块，提供 Canvas/WebGL/Audio/DOMRect 扰动、Sec-GPC: 1 与 AI 环境体检。",
        moduleName: "Gador 隐私与指纹防护模块（privacy-shield）",
        shortName: "隐私指纹防护",
        category: "privacy",
        restartHint: true,
      });
      root.appendChild(el("div", { class: "gd-native-divider", text: "浏览器原生隐私、Cookie 与安全选项" }));
      return;
    }

    const hp = state.hostProxy || {};
    const ps = state.privacyShield || {
      level: "standard",
      canvasFarbling: true,
      webglFarbling: true,
      audioFarbling: true,
      clientRectsJitter: false,
      hardwareNormalization: true,
      webrtcLeakProtection: true,
      gpcHeader: true,
      hideAutomationHints: true,
    };
    const psBusy = Boolean(state.busyOps["privacy-shield"]);
    const isOff = ps.level === "off";

    const updateShield = async (patch, toastMsg) => {
      if (psBusy) return;
      state.busyOps["privacy-shield"] = true;
      renderGadorPanel();
      try {
        const res = await apiPost("/api/privacy-shield", patch);
        if (res?.privacyShield) {
          state.privacyShield = { ...state.privacyShield, ...res.privacyShield };
        }
        if (toastMsg) showToast(toastMsg);
      } catch (e) {
        showToast(`更新指纹防护失败：${e.message}`, true);
      } finally {
        delete state.busyOps["privacy-shield"];
        renderGadorPanel();
      }
    };
    const levelLabel =
      ps.level === "strict"
        ? "严格指纹隐藏"
        : ps.level === "off"
          ? "已关闭"
          : "标准防追踪";

    root.appendChild(
      el("div", { class: "gd-page-head" }, [
        el("div", {}, [
          el("h1", { text: "隐私与指纹防护" }),
          el("p", {
            text: "提供同源会话确定性指纹扰动、硬件特征收敛、Sec-GPC 隐私信号与 WebRTC 防泄漏；总档位关闭时禁止单独启用分项开关。",
          }),
        ]),
        psBusy
          ? el("span", { class: "gd-pill waiting", text: "⏳ 正在同步策略，请等待…" })
          : isOff
            ? el("span", { class: "gd-pill forbidden", text: "🚫 已关闭（分项开关已锁定）" })
            : el("span", { class: "gd-pill ok", text: `当前等级：${levelLabel}` }),
      ])
    );

    const makeSubToggle = (checked, label, key, onMsg, offMsg) =>
      makeToggle(checked, label, (val) => updateShield({ [key]: val }, val ? onMsg : offMsg), {
        disabled: psBusy || isOff,
        title: isOff ? "🚫 禁止：总档位处于「关闭」状态，请先切至标准或严格档位" : undefined,
        blockedMessage: "🚫 冲突禁止：总防护档位处于「关闭」，请先切至「标准防追踪」或「严格隐藏」",
      });

    root.appendChild(el("div", { class: "gd-section-label", text: "指纹隐藏与环境防检测（实时同步至所有新打开网页）" }));
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "指纹防护强度档位" }),
            el("span", { text: "「标准」兼顾网站兼容与防追踪；「严格」额外启用 DOMRect 亚像素布局微扰；「关闭」锁定全部子项" }),
          ]),
          makeSegmented(
            [
              { value: "off", label: "关闭" },
              { value: "standard", label: "标准防追踪" },
              { value: "strict", label: "严格隐藏" },
            ],
            ps.level || "standard",
            (val) =>
              updateShield(
                { level: val },
                val === "strict"
                  ? "已切换至「严格指纹隐藏」（新加载页面生效）"
                  : val === "off"
                    ? "已关闭指纹扰动（保留 WebRTC 防泄漏）"
                    : "已切换至「标准防追踪」"
              ),
            true,
            { disabled: psBusy }
          ),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 Canvas 2D 指纹扰动" : "Canvas 2D 指纹扰动" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "同源会话内确定性微扰，跨站哈希唯一，不影响正常网页渲染" }),
          ]),
          makeSubToggle(Boolean(ps.canvasFarbling), "Canvas 2D 指纹扰动", "canvasFarbling", "已开启 Canvas 指纹扰动", "已关闭 Canvas 指纹扰动"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 WebGL 显卡型号与渲染器隐藏" : "WebGL 显卡型号与渲染器隐藏" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "统一 UNMASKED_VENDOR / RENDERER 信息并对 readPixels 像素采样做轻量扰动" }),
          ]),
          makeSubToggle(Boolean(ps.webglFarbling), "WebGL 显卡型号隐藏", "webglFarbling", "已开启 WebGL 指纹隐藏", "已关闭 WebGL 指纹隐藏"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 AudioContext 音频指纹扰动" : "AudioContext 音频指纹扰动" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "对 OfflineAudioContext / getChannelData 施加极低幅确定性噪声" }),
          ]),
          makeSubToggle(Boolean(ps.audioFarbling), "AudioContext 音频指纹扰动", "audioFarbling", "已开启音频指纹扰动", "已关闭音频指纹扰动"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 硬件特征与电池接口收敛" : "硬件特征与电池接口收敛" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "规整 hardwareConcurrency / deviceMemory 档位并隐藏 navigator.getBattery()" }),
          ]),
          makeSubToggle(Boolean(ps.hardwareNormalization), "硬件特征收敛", "hardwareNormalization", "已开启硬件特征收敛", "已关闭硬件特征收敛"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 常规浏览环境信号清理" : "常规浏览环境信号清理" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "保持 navigator.webdriver = false 及原生 Function.prototype.toString 签名" }),
          ]),
          makeSubToggle(Boolean(ps.hideAutomationHints), "常规浏览环境信号清理", "hideAutomationHints", "已开启环境信号清理", "已关闭环境信号清理"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 DOMRect 亚像素微扰（严格模式）" : "DOMRect 亚像素微扰（严格模式）" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "防止通过字体测量与元素几何边界提取跨站设备指纹" }),
          ]),
          makeSubToggle(Boolean(ps.clientRectsJitter), "DOMRect 亚像素微扰", "clientRectsJitter", "已开启 DOMRect 亚像素微扰", "已关闭 DOMRect 亚像素微扰"),
        ]),
        el("div", { class: `gd-item${isOff ? " is-blocked" : ""}` }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: isOff ? "🚫 Global Privacy Control 隐私信号（Sec-GPC: 1）" : "Global Privacy Control 隐私信号（Sec-GPC: 1）" }),
            el("span", { text: isOff ? "总档位为「关闭」，禁止单独开启此项" : "通过请求头与 navigator.globalPrivacyControl 向站点声明拒绝跨站追踪" }),
          ]),
          makeSubToggle(Boolean(ps.gpcHeader), "Global Privacy Control 请求头", "gpcHeader", "已开启 Sec-GPC: 1 隐私头", "已关闭 Sec-GPC 隐私头"),
        ]),
      ])
    );

    root.appendChild(el("div", { class: "gd-section-label", text: "网络防泄漏与 AI 环境自检接口" }));
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: hp.enabled ? "当前出口：跟随宿主机代理" : "独立网络防泄漏与 WebRTC 保护已启用" }),
            el("span", { text: "强制 disable_non_proxied_udp，可随时在「网络与独立 VPN」切换独立隧道或跟随宿主机代理。" }),
          ]),
          el("button", {
            type: "button",
            class: "gd-btn primary",
            text: "管理独立 VPN",
            onClick: () => openFusedMode("vpn", true),
          }),
        ]),
        el("div", { class: "gd-item stack" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "已向 AI Agent 开放的环境调试与自检接口" }),
            el("span", { text: "AI 可通过 MCP 工具或 CLI 读取/切换防护档位并对受管页面执行只读环境体检（规范已同步写入 SKILL.md）。" }),
          ]),
          el("div", { class: "gd-tags" }, [
            el("span", { class: "gd-code", text: "privacy_shield_get" }),
            el("span", { class: "gd-code", text: "privacy_shield_set" }),
            el("span", { class: "gd-code", text: "privacy_audit_page" }),
            el("span", { class: "gd-code", text: "gador://privacy-shield" }),
            el("span", { class: "gd-code", text: "GET/POST /api/privacy-shield" }),
          ]),
        ]),
        renderModuleStatusStrip("privacy-shield", "隐私与指纹防护", true),
      ])
    );

    root.appendChild(el("div", { class: "gd-native-divider", text: "浏览器原生隐私、Cookie 与安全选项" }));
  } else if (mode === "reset") {
    root.appendChild(
      el("div", { class: "gd-page-head" }, [
        el("div", {}, [
          el("h1", { text: "初始化与重置" }),
          el("p", { text: "选择仅恢复 Gador 界面与光场偏好，或将全部浏览器设置还原至初始默认状态。" }),
        ]),
      ])
    );
    root.appendChild(
      el("section", { class: "gd-card" }, [
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "仅重置 Gador 光场、标签栏布局与原生界面配置" }),
            el("span", { text: "将 ~/.config/gador/native-ui.json 与外观偏好恢复为初始默认，不影响书签、密码、登录态与扩展。" }),
          ]),
          el("button", {
            type: "button",
            class: "gd-btn primary",
            text: "重置界面与光场",
            onClick: () => applyAppearance({ resetDefaults: true }, "已重置 Gador 默认外观与布局"),
          }),
        ]),
        el("div", { class: "gd-item" }, [
          el("div", { class: "gd-item-info" }, [
            el("strong", { text: "将浏览器全部设置还原为原始默认设置" }),
            el("span", { text: "重置启动页、新标签页、搜索引擎与固定标签页，并停用所有扩展和清除临时 Cookie（保留书签、历史与已存密码）。" }),
          ]),
          el("button", {
            type: "button",
            class: "gd-btn danger",
            text: "还原原始默认设置",
            onClick: () => {
              const trigger = findDeepElement(
                document.querySelector("settings-ui")?.shadowRoot,
                "#resetProfile"
              );
              if (trigger) {
                trigger.click();
              } else {
                location.href = "chrome://settings/resetProfileSettings";
              }
            },
          }),
        ]),
      ])
    );
  }
}

function findDeepElement(root, selector) {
  if (!root) return null;
  const hit = root.querySelector(selector);
  if (hit) return hit;
  for (const node of root.querySelectorAll("*")) {
    if (node.shadowRoot) {
      const nested = findDeepElement(node.shadowRoot, selector);
      if (nested) return nested;
    }
  }
  return null;
}

const NATIVE_SECTION_TITLE_MAP = {
  "我与 Google": "本地档案与数据",
  "自动填充和密码": "保存的信息类别",
  "隐私和安全": "隐私与安全",
  "性能": "性能与节能",
  "外观": "字体与缩放（原生）",
  "搜索引擎": "高级网站搜索管理",
  "起始页面": "启动与新标签页",
  "启动时": "启动与新标签页",
  "语言": "语言与翻译",
  "下载内容": "下载与保存",
  "无障碍": "辅助功能",
  "系统": "系统与硬件",
  "重置设置": "初始化与重置",
  "关于 Chromium": "关于 Gador",
};

const GADOR_NATIVE_UNIFY_CSS = `
  :host {
    --google-blue-600: #4f7cff;
    --google-blue-500: #4f7cff;
    --cr-checked-color: #4f7cff;
    --cr-radio-button-checked-color: #4f7cff;
    --cr-focus-outline-color: rgba(79, 124, 255, 0.45);
    --cr-card-border-radius: 12px;
    --cr-section-padding: 18px;
  }
  #card, .card, settings-card {
    border-radius: 12px !important;
    border: 1px solid rgba(127, 127, 127, 0.18) !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06) !important;
    overflow: hidden !important;
  }
  h2.title, .page-title, #title, .section-title {
    font-size: 13px !important;
    font-weight: 600 !important;
    letter-spacing: 0.02em !important;
    color: var(--cr-secondary-text-color, #5f6368) !important;
    padding-top: 14px !important;
    padding-bottom: 8px !important;
  }
  .settings-box, .list-item {
    min-height: 52px !important;
    padding-inline: 18px !important;
    border-top-color: rgba(127, 127, 127, 0.12) !important;
  }
  cr-link-row {
    min-height: 52px !important;
    padding-inline: 18px !important;
    --cr-section-padding: 18px;
    transition: background 0.14s ease !important;
  }
  cr-link-row:hover {
    background: rgba(79, 124, 255, 0.05) !important;
  }
  cr-button {
    border-radius: 9px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    min-height: 34px !important;
    padding: 0 14px !important;
    border-color: rgba(127, 127, 127, 0.24) !important;
    --ink-color: #4f7cff;
    --hover-bg-color: rgba(79, 124, 255, 0.08);
    --text-color: var(--cr-primary-text-color, #1f2937);
    transition: background 0.15s ease, border-color 0.15s ease !important;
  }
  cr-button.action-button {
    background: linear-gradient(135deg, #4f8dff, #4f7cff) !important;
    border-color: transparent !important;
    color: #ffffff !important;
    --text-color: #ffffff;
  }
  select.md-select {
    border-radius: 9px !important;
    min-height: 34px !important;
    padding-inline: 10px 28px !important;
    border: 1px solid rgba(127, 127, 127, 0.24) !important;
    font-size: 13px !important;
  }
  cr-toggle {
    --cr-toggle-checked-bar-color: rgba(79, 124, 255, 0.45);
    --cr-toggle-checked-button-color: #4f7cff;
    --cr-toggle-checked-ripple-color: rgba(79, 124, 255, 0.2);
  }
  .gador-about-emblem {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    display: inline-grid;
    place-items: center;
    background: linear-gradient(135deg, #4f8dff, #8b5cf6);
    color: #ffffff;
    font-weight: 800;
    font-size: 20px;
    letter-spacing: -0.02em;
    box-shadow: 0 3px 12px -2px rgba(79, 124, 255, 0.55);
    margin-inline-end: 14px;
    flex: none;
  }
  [data-gador-deduped="1"] {
    display: none !important;
  }
`;

const GADOR_CR_BUTTON_CSS = `
  :host {
    border-radius: 9px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    min-height: 34px !important;
    padding: 0 14px !important;
    border-color: rgba(127, 127, 127, 0.24) !important;
  }
  :host(.action-button) {
    background: linear-gradient(135deg, #4f8dff, #4f7cff) !important;
    border-color: transparent !important;
    color: #ffffff !important;
  }
`;

function unifyNativeSettingsUi() {
  const settingsUi = document.querySelector("settings-ui");
  const mainEl = settingsUi?.shadowRoot?.getElementById("main");
  if (!mainEl) return;

  const visitShadow = (root) => {
    if (!root) return;
    const hostTag = root.host?.tagName?.toLowerCase() || "";
    if (!root.querySelector('style[data-gador-native-theme="1"]')) {
      const st = document.createElement("style");
      st.setAttribute("data-gador-native-theme", "1");
      st.textContent = hostTag === "cr-button" ? GADOR_CR_BUTTON_CSS : GADOR_NATIVE_UNIFY_CSS;
      root.appendChild(st);
    }

    // Refactor native section headings so zero "我与 Google" / "Chromium" / mismatch remains
    for (const h of root.querySelectorAll("h1, h2.title, h2, .page-title, #title")) {
      const txt = (h.textContent || "").trim();
      if (NATIVE_SECTION_TITLE_MAP[txt]) {
        h.textContent = NATIVE_SECTION_TITLE_MAP[txt];
      } else if (txt === "Chromium") {
        h.textContent = "Gador";
      } else if (txt.includes("Chromium")) {
        h.textContent = txt.replace(/Chromium/g, "Gador");
      }
    }

    // Rebrand About Gador page: replace blue Chromium wheel logo & "Chromium" copyright header
    if (hostTag === "settings-about-page") {
      const logo = root.querySelector("img#product-logo, img.product-logo, #product-logo, picture, img");
      if (logo && !logo.dataset.gadorLogoReplaced) {
        logo.dataset.gadorLogoReplaced = "1";
        const badge = document.createElement("span");
        badge.className = "gador-about-emblem";
        badge.textContent = "R";
        logo.replaceWith(badge);
      }
      for (const elNode of root.querySelectorAll("#copyright > div, .secondary, .product-title")) {
        if (elNode.children.length === 0 && (elNode.textContent || "").trim() === "Chromium") {
          elNode.textContent = "Gador AI-Agent Browser";
        }
      }
    }

    // Deduplicate redundant centered hero header in Autofill page (keep clean section heading + cards)
    if (hostTag === "settings-autofill-page") {
      const hero = root.querySelector("settings-account-card, #header, .header-container");
      if (hero) hero.setAttribute("data-gador-deduped", "1");
    }

    // Clean up "Chrome 应用商店" wording in Accessibility page
    if (hostTag === "settings-a11y-page") {
      for (const row of root.querySelectorAll("cr-link-row")) {
        const sub = row.getAttribute("sub-label") || "";
        if (sub.includes("Chrome 应用商店")) {
          row.setAttribute("sub-label", sub.replace(/Chrome 应用商店/g, "扩展商店"));
        }
      }
    }

    // Deduplicate native Reset card (already unified cleanly inside Gador's 初始化与重置 card above)
    if (hostTag === "settings-reset-page") {
      const card = root.querySelector("settings-section, settings-card, .card, #card");
      if (card) card.setAttribute("data-gador-deduped", "1");
      const resetRow = root.getElementById("resetProfile");
      if (resetRow && resetRow.closest("settings-section")) {
        resetRow.closest("settings-section").setAttribute("data-gador-deduped", "1");
      }
    }

    // Deduplicate native Search Engine selector row (already unified by Gador 4-engine card above),
    // keeping "管理搜索引擎和网站搜索" right below!
    if (hostTag === "settings-search-page") {
      for (const box of root.querySelectorAll(".settings-box, .cr-row")) {
        if (
          box.querySelector("select, settings-dropdown-menu, #openDialogButton, cr-button") ||
          (box.textContent || "").includes("您选择的搜索引擎将用于多种功能")
        ) {
          box.setAttribute("data-gador-deduped", "1");
        }
      }
    }

    // Deduplicate native Appearance rows already owned by Gador Optical Lightfield above,
    // keeping Fonts & Page Zoom cleanly below!
    if (hostTag === "settings-appearance-page") {
      for (const row of root.querySelectorAll(".settings-box, .settings-row, .cr-row, settings-toggle-button, cr-link-row, div[id]")) {
        const id = row.id || "";
        const label = (row.textContent || row.getAttribute("label") || "").trim();
        if (
          id === "themeRow" ||
          id === "openTheme" ||
          id === "colorSchemeModeRow" ||
          id === "colorSchemeRow" ||
          id === "showBookmarksBar" ||
          row.querySelector?.("#bookmarksBarVisibilityDropdown, #tabStripPosition, #showBookmarksBar") ||
          label.startsWith("主题背景") ||
          label.startsWith("模式") ||
          label.startsWith("显示书签栏") ||
          label.startsWith("标签页位置")
        ) {
          row.setAttribute("data-gador-deduped", "1");
        }
      }
    }

    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        visitShadow(child.shadowRoot);
      }
    }
  };

  visitShadow(mainEl.shadowRoot);
}

let containerPanel = null;
const vpnLinks = [];
const aiLinks = [];

function rebrandToolbarAndDocument(settingsUiShadow) {
  document.title = "Gador 设置";
  const toolbar = settingsUiShadow.getElementById("toolbar");
  if (!toolbar) return;
  if (toolbar.getAttribute("page-name") !== "Gador 设置") {
    toolbar.setAttribute("page-name", "Gador 设置");
    toolbar.pageName = "Gador 设置";
  }
  if (!toolbar.querySelector("[slot='product-logo']")) {
    const badge = el("span", {
      slot: "product-logo",
      text: "R",
      "aria-hidden": "true",
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "26px",
        height: "26px",
        marginRight: "10px",
        borderRadius: "8px",
        fontSize: "15px",
        fontWeight: "800",
        color: "#ffffff",
        background: "linear-gradient(135deg, #4f8dff, #8b5cf6)",
        boxShadow: "0 2px 10px -2px rgba(79, 141, 255, 0.7)",
        flex: "none",
      },
    });
    toolbar.appendChild(badge);
  }
}

function refactorSettingsMenu(settingsMenuEl) {
  if (!settingsMenuEl || !settingsMenuEl.shadowRoot) return false;
  const selector = settingsMenuEl.shadowRoot.getElementById("menu");
  if (!selector) return false;

  // 1. Rename EVERY native menu label into our unified Gador taxonomy
  for (const [id, newLabel] of Object.entries(UNIFIED_MENU_LABELS)) {
    const item = selector.querySelector(`#${CSS.escape(id)}`);
    if (!item) continue;
    const labelSpan = item.querySelector(".menu-label");
    if (labelSpan && labelSpan.textContent.trim() !== newLabel) {
      labelSpan.textContent = newLabel;
    }
    if (id === "about-menu") {
      // Replace the tiny Chromium wheel icon on "关于 Gador" with Gador's miniature R emblem
      const oldIcon = item.querySelector("cr-icon");
      if (oldIcon && !item.querySelector("[data-gador-about-icon]")) {
        oldIcon.style.display = "none";
        const miniMark = el("span", {
          "data-gador-about-icon": "1",
          text: "R",
          "aria-hidden": "true",
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "18px",
            height: "18px",
            marginInlineEnd: "16px",
            borderRadius: "5px",
            fontSize: "11px",
            fontWeight: "800",
            color: "#ffffff",
            background: "linear-gradient(135deg, #4f8dff, #8b5cf6)",
            flex: "none",
          },
        });
        oldIcon.parentNode.insertBefore(miniMark, oldIcon);
      }
    }
    if (id === "ai") {
      // Ensure "AI 托管与总览" is ALWAYS visible even when Chromium's Google AI flag is off
      item.removeAttribute("hidden");
      item.hidden = false;
      if (!item.dataset.gadorAiBound) {
        item.dataset.gadorAiBound = "1";
        aiLinks.push(item);
        item.addEventListener(
          "click",
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFusedMode("ai", true);
          },
          true
        );
      }
    }
  }

  // 2. Insert "网络与独立 VPN" seamlessly right after "隐私与安全" using native cr-nav-menu-item look
  if (!selector.querySelector("#gador-vpn")) {
    const privacyItem = selector.querySelector("#privacy");
    const vpnItem = el(
      "a",
      {
        role: "menuitem",
        id: "gador-vpn",
        href: "#gador-vpn",
        class: "cr-nav-menu-item",
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openFusedMode("vpn", true);
        },
      },
      [
        el("cr-icon", { icon: "settings:security" }),
        el("span", { class: "menu-label", text: UNIFIED_MENU_LABELS["gador-vpn"] }),
      ]
    );
    if (privacyItem && privacyItem.parentNode) {
      privacyItem.parentNode.insertBefore(vpnItem, privacyItem.nextSibling);
    } else {
      selector.insertBefore(vpnItem, selector.firstChild);
    }
    vpnLinks.push(vpnItem);
  }

  if (!selector.dataset.gadorMenuListener) {
    selector.dataset.gadorMenuListener = "1";
    selector.addEventListener("click", (e) => {
      const path = e.composedPath();
      const clickedItem = path.find(
        (n) => n instanceof Element && n.matches("a.cr-nav-menu-item")
      );
      if (!clickedItem) return;
      if (clickedItem.id === "gador-vpn" || clickedItem.id === "ai") return;
      if (location.hash.startsWith("#gador-")) {
        history.replaceState(null, "", clickedItem.getAttribute("href") || "/");
      }
      setTimeout(() => syncRouteFromLocation(), 30);
    });
  }

  syncCustomMenuSelection();
  return true;
}

function syncCustomMenuSelection() {
  const settingsUi = document.querySelector("settings-ui");
  const menus = [
    settingsUi?.shadowRoot?.getElementById("leftMenu")?.shadowRoot?.getElementById("menu"),
    settingsUi?.shadowRoot?.getElementById("drawer")?.querySelector("settings-menu")?.shadowRoot?.getElementById("menu"),
  ].filter(Boolean);

  if (state.viewMode === "vpn" || state.viewMode === "ai") {
    const activeId = state.viewMode === "vpn" ? "gador-vpn" : "ai";
    for (const menu of menus) {
      for (const item of menu.querySelectorAll("a.cr-nav-menu-item")) {
        if (item.id === activeId) {
          item.setAttribute("selected", "");
          item.setAttribute("aria-current", "page");
        } else {
          item.removeAttribute("selected");
          item.removeAttribute("aria-current");
        }
      }
    }
  } else {
    for (const link of [...vpnLinks, ...aiLinks]) {
      link.removeAttribute("selected");
      link.removeAttribute("aria-current");
    }
  }
}

function renderGadorPanel() {
  if (!containerPanel) return;
  const settingsUi = document.querySelector("settings-ui");
  const mainEl = settingsUi?.shadowRoot?.getElementById("main");
  const mode = state.viewMode;

  containerPanel.replaceChildren();
  containerPanel.classList.remove("full-page");

  if (mode === "ai" || mode === "vpn") {
    if (mainEl) mainEl.hidden = true;
    containerPanel.hidden = false;
    containerPanel.classList.add("full-page");
    if (mode === "ai") renderAiView(containerPanel);
    else renderVpnView(containerPanel);
  } else if (mode === "appearance") {
    // Deep fusion: Gador Optical Lightfield cards sit directly ABOVE Chromium native Appearance settings!
    if (mainEl) mainEl.hidden = false;
    containerPanel.hidden = false;
    renderAppearanceFused(containerPanel);
  } else if (
    mode === "people" ||
    mode === "search" ||
    mode === "privacy" ||
    mode === "autofill" ||
    mode === "reset"
  ) {
    if (mainEl) mainEl.hidden = false;
    containerPanel.hidden = false;
    renderContextualBanner(containerPanel, mode);
  } else {
    containerPanel.hidden = true;
    if (mainEl) mainEl.hidden = false;
  }

  syncCustomMenuSelection();
  unifyNativeSettingsUi();
  setTimeout(unifyNativeSettingsUi, 120);
  setTimeout(unifyNativeSettingsUi, 450);
}

function resolveModeFromLocation() {
  const hash = (location.hash || "").replace(/^#/, "");
  const pathname = (location.pathname || "/").replace(/\/+$/, "") || "/";
  if (hash === "gador-vpn" || pathname === "/vpn") return "vpn";
  if (hash === "gador-ai" || pathname === "/ai") return "ai";
  if (hash === "gador-personalize" || pathname === "/appearance") return "appearance";
  if (pathname === "/" || pathname === "/people") return "people";
  if (pathname === "/search" || pathname === "/searchEngines") return "search";
  if (pathname === "/privacy") return "privacy";
  if (pathname === "/autofill") return "autofill";
  if (pathname === "/reset") return "reset";
  return "native";
}

async function openFusedMode(mode, updateUrl = false) {
  state.viewMode = mode;
  if (updateUrl) {
    if (mode === "vpn") history.replaceState(null, "", "/#gador-vpn");
    else if (mode === "ai") history.replaceState(null, "", "/#gador-ai");
    else if (mode === "appearance") {
      // Navigate via native menu click so Chromium's router loads the real native Appearance section below!
      const settingsUi = document.querySelector("settings-ui");
      const appLink = settingsUi?.shadowRoot?.getElementById("leftMenu")?.shadowRoot?.getElementById("appearance");
      if (appLink) appLink.click();
      else history.replaceState(null, "", "/appearance");
    }
  }
  renderGadorPanel();
  if (mode !== "native") {
    await refreshAllData();
    renderGadorPanel();
  }
}

async function syncRouteFromLocation() {
  const hash = (location.hash || "").replace(/^#/, "");
  if (hash === "gador-personalize" && location.pathname !== "/appearance") {
    // Redirect legacy #gador-personalize straight onto native /appearance so both Gador + native Appearance fuse on ONE page
    const settingsUi = document.querySelector("settings-ui");
    const appLink = settingsUi?.shadowRoot?.getElementById("leftMenu")?.shadowRoot?.getElementById("appearance");
    if (appLink) {
      history.replaceState(null, "", "/appearance");
      appLink.click();
    }
  }
  const next = resolveModeFromLocation();
  if (next !== state.viewMode) {
    state.viewMode = next;
    renderGadorPanel();
    if (next !== "native") {
      await refreshAllData();
      renderGadorPanel();
    }
  }
}

function bootstrap() {
  const settingsUi = document.querySelector("settings-ui");
  if (!settingsUi || !settingsUi.shadowRoot) {
    setTimeout(bootstrap, 120);
    return;
  }
  const sr = settingsUi.shadowRoot;
  const container = sr.getElementById("container");
  const mainEl = sr.getElementById("main");
  const leftMenu = sr.getElementById("leftMenu");
  if (!container || !mainEl || !leftMenu) {
    setTimeout(bootstrap, 120);
    return;
  }

  injectHostStyles(sr);
  rebrandToolbarAndDocument(sr);

  // Wrap our fused top/full panel + Chromium's real <settings-main> inside ONE flex column
  // so fused pages (外观与光场 / 隐私与安全 / 密码与自动填充 / 初始化与重置) scroll seamlessly together!
  if (!sr.getElementById("gador-main-column")) {
    const col = el("div", { id: "gador-main-column" });
    containerPanel = el("section", { id: "gador-integrated-main", hidden: true });
    container.insertBefore(col, mainEl);
    col.appendChild(containerPanel);
    col.appendChild(mainEl);
  } else {
    containerPanel = sr.getElementById("gador-integrated-main");
  }

  const mountAllMenus = () => {
    rebrandToolbarAndDocument(sr);
    refactorSettingsMenu(leftMenu);
    const drawer = sr.getElementById("drawer");
    const drawerMenu = drawer?.querySelector("settings-menu");
    if (drawerMenu) refactorSettingsMenu(drawerMenu);
  };
  mountAllMenus();
  const pollMenu = setInterval(() => {
    mountAllMenus();
    const m = leftMenu.shadowRoot?.getElementById("menu");
    if (m && m.querySelector("#gador-vpn") && m.querySelector("#appearance .menu-label")?.textContent === "外观与光场") {
      clearInterval(pollMenu);
    }
  }, 200);

  // Watch SPA route changes inside chrome://settings (pushState / popstate / hashchange)
  let lastLoc = location.pathname + location.hash;
  setInterval(() => {
    const cur = location.pathname + location.hash;
    if (cur !== lastLoc) {
      lastLoc = cur;
      syncRouteFromLocation();
    }
    unifyNativeSettingsUi();
  }, 250);
  window.addEventListener("popstate", syncRouteFromLocation);
  window.addEventListener("hashchange", syncRouteFromLocation);
  window.addEventListener("focus", () => {
    if (state.viewMode === "people" || state.viewMode === "search" || state.viewMode === "ai") {
      refreshAllData().then(() => renderGadorPanel());
    }
  });

  syncRouteFromLocation();
  unifyNativeSettingsUi();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
