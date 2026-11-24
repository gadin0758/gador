// Gador Optical Browser Shell — Zen × Chrome × Lightfield Controller
// Connects to clients/ui/server.mjs (/api/state, /api/rpc, /api/events).

const PREF_KEY = "gador.prefs.v1";
const USER_TABS_KEY = "gador.userTabs.v1";

function loadUserTabs() {
  try {
    const raw = localStorage.getItem(USER_TABS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveUserTabs() {
  try {
    localStorage.setItem(USER_TABS_KEY, JSON.stringify(state.userTabs.slice(0, 30)));
  } catch {
    // ignore storage quota errors
  }
}

function loadPrefs() {
  const defaults = {
    theme: "system", // system | light | dark
    accent: "adaptive", // adaptive | cyan | sapphire | violet | amber | emerald | rose | custom
    customColor: "#38bdf8",
    layout: localStorage.getItem("gador.layout") === "chrome" ? "chrome" : "sidebar",
    compact: localStorage.getItem("gador.compact") === "true",
    frost: "off", // off (pure lightfield default) | soft | standard | rich
    glow: "standard", // subtle | standard | vivid
    defaultAuth: "shared", // shared | private
    viewport: "1280x800",
    liveRefresh: true,
  };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

const initialPrefs = loadPrefs();
const SHELL_MODE =
  new URLSearchParams(location.search).get("standalone") === "1"
    ? "standalone"
    : "embedded";

const ACCENT_HEX_MAP = {
  adaptive: "",
  cyan: "#38bdf8",
  sapphire: "#4f8dff",
  violet: "#a855f7",
  amber: "#f59e0b",
  emerald: "#10b981",
  rose: "#fb7185",
};

const state = {
  connected: false,
  socketPath: "",
  shellMode: SHELL_MODE, // "embedded" (single-layer inside native Gador) | "standalone"
  skillInfo: null,
  capabilities: null,
  spaces: [],
  pages: [],
  routes: [],
  vpnStore: { profiles: [], backups: [], profilesFile: "", backupsDir: "" },
  userTabs: loadUserTabs(), // Non-AI personal browsing entries { id, url, title, ts }
  spaceMode: SHELL_MODE === "embedded" ? "ai" : "normal",
  showBookmarkBar: true,
  nativeUiConfigPath: "~/.config/gador/native-ui.json",
  selectedSpaceId: null,
  selectedPageId: null,
  selectedUserTabId: null,
  openDialogs: new Map(), // pageId -> dialog params
  events: [],
  activeView: SHELL_MODE === "embedded" ? "settings" : "page", // page | overview | ai | vpn | personalization | settings
  overviewScope: "current", // current | all
  activeSheet: null, // "network" | "activity" | null
  ...initialPrefs,
  frameCache: new Map(), // pageId -> { src, ts }
  capturing: false,
  busy: new Set(),
  busyTargets: new Map(),
  suggestionIndex: -1,
  filteredSuggestions: [],
};

function savePrefs() {
  localStorage.setItem("gador.layout", state.layout);
  localStorage.setItem("gador.compact", String(state.compact));
  localStorage.setItem(
    PREF_KEY,
    JSON.stringify({
      theme: state.theme,
      accent: state.accent,
      customColor: state.customColor,
      layout: state.layout,
      compact: state.compact,
      frost: state.frost,
      glow: state.glow,
      defaultAuth: state.defaultAuth,
      viewport: state.viewport,
      liveRefresh: state.liveRefresh,
    })
  );
}

const $ = (id) => document.getElementById(id);

const els = {
  zen: $("zen"),
  sidebar: $("sidebar"),
  runtimeMeta: $("runtime-meta"),
  btnRefresh: $("btn-refresh"),
  btnLayoutSidebar: $("btn-layout-sidebar"),
  btnCompact: $("btn-compact"),
  chromeTop: $("chrome-top"),
  chromeToolbar: $("chrome-toolbar"),
  chromeWorkspaces: $("chrome-workspaces"),
  chromeTabList: $("chrome-tab-list"),
  chromeBtnNewTab: $("chrome-btn-new-tab"),
  chromeRuntimeMeta: $("chrome-runtime-meta"),
  chromeBtnRefresh: $("chrome-btn-refresh"),
  chromeWsName: $("chrome-ws-name"),
  chromeWsAuth: $("chrome-ws-auth"),
  chromeBtnCloseSpace: $("chrome-btn-close-space"),
  chromeOmnibox: $("chrome-omnibox"),
  chromeOmniboxText: $("chrome-omnibox-text"),
  chromeSpaceNormal: $("chrome-space-normal"),
  chromeSpaceAi: $("chrome-space-ai"),
  chromeSpaceAiBeacon: $("chrome-space-ai-beacon"),
  chromeAiCount: $("chrome-ai-count"),
  chromeBtnIncognito: $("chrome-btn-incognito"),
  chromeEssNetwork: $("chrome-ess-network"),
  chromeEssActivity: $("chrome-ess-activity"),
  chromeActivityDot: $("chrome-activity-dot"),
  chromeBadgePages: $("chrome-badge-pages"),
  chromeNavVpn: $("chrome-nav-vpn"),
  btnLayoutChrome: $("btn-layout-chrome"),
  urlTrigger: $("url-trigger"),
  urlTriggerText: $("url-trigger-text"),
  spaceBtnNormal: $("space-btn-normal"),
  spaceBtnAi: $("space-btn-ai"),
  sbSpaceAiBeacon: $("sb-space-ai-beacon"),
  sbAiCount: $("sb-ai-count"),
  btnIncognito: $("btn-incognito"),
  essNetwork: $("ess-network"),
  essActivity: $("ess-activity"),
  activityDot: $("activity-dot"),
  sbBadgePages: $("sb-badge-pages"),
  navVpn: $("nav-vpn"),
  wsName: $("ws-name"),
  wsAuth: $("ws-auth"),
  btnCloseSpace: $("btn-close-space"),
  tabList: $("tab-list"),
  btnNewTab: $("btn-new-tab"),
  workspaceList: $("workspace-list"),
  panel: $("panel"),
  panelSurface: $("view-page"),
  panelAiBeacon: $("panel-ai-beacon"),
  frameHost: $("frame-host"),
  framePath: $("frame-path"),
  frameTime: $("frame-time"),
  btnStopAiBar: $("btn-stop-ai-bar"),
  btnStopAi: $("btn-stop-ai"),
  btnCapsuleBack: $("btn-capsule-back"),
  btnCapsuleSettings: $("btn-capsule-settings"),
  capsuleAiBeacon: $("capsule-ai-beacon"),
  subnavBtnBack: $("subnav-btn-back"),
  subnavBtnForward: $("subnav-btn-forward"),
  subnavBtnBookmarks: $("subnav-btn-bookmarks"),
  btnOpenNativeTab: $("btn-open-native-tab"),
  btnOpenOverviewBar: $("btn-open-overview-bar"),
  viewport: $("viewport"),
  emptyState: $("empty-state"),
  emptyBtnNew: $("empty-btn-new"),
  emptyBtnPersonal: $("empty-btn-personal"),
  emptyBtnVpn: $("empty-btn-vpn"),
  emptyBtnAi: $("empty-btn-ai"),
  frameNote: $("frame-note"),
  frame: $("frame"),
  controlState: $("control-state"),
  btnCapture: $("btn-capture"),
  btnLive: $("btn-live"),
  btnTakeover: $("btn-takeover"),
  btnCollapse: $("btn-collapse"),
  dialogCard: $("dialog-card"),
  dialogType: $("dialog-type"),
  dialogMsg: $("dialog-msg"),
  dialogInput: $("dialog-input"),
  btnDialogDismiss: $("btn-dialog-dismiss"),
  btnDialogAccept: $("btn-dialog-accept"),
  // Overview view
  overviewTitle: $("overview-title"),
  overviewSub: $("overview-sub"),
  overviewGrid: $("overview-grid"),
  ovScopeCurrent: $("ov-scope-current"),
  ovScopeAll: $("ov-scope-all"),
  btnOvRefreshThumbs: $("btn-ov-refresh-thumbs"),
  btnOvNewPage: $("btn-ov-new-page"),
  // AI Hub view
  aiBtnCreateShared: $("ai-btn-create-shared"),
  aiBtnCreatePrivate: $("ai-btn-create-private"),
  aiBtnTakeover: $("ai-btn-takeover"),
  aiControlHeadline: $("ai-control-headline"),
  aiControlPill: $("ai-control-pill"),
  aiControlDesc: $("ai-control-desc"),
  aiStatRuntime: $("ai-stat-runtime"),
  aiStatSpaces: $("ai-stat-spaces"),
  aiStatPages: $("ai-stat-pages"),
  aiStatDialogs: $("ai-stat-dialogs"),
  aiGuardPill: $("ai-guard-pill"),
  aiSocketPath: $("ai-socket-path"),
  aiSkillPaths: $("ai-skill-paths"),
  aiMcpTools: $("ai-mcp-tools"),
  aiMcpBin: $("ai-mcp-bin"),
  aiSkillPreview: $("ai-skill-preview"),
  btnCopySkillMd: $("btn-copy-skill-md"),
  btnCopyMcpJson: $("btn-copy-mcp-json"),
  btnToggleSkillPreview: $("btn-toggle-skill-preview"),
  btnCopySocket: $("btn-copy-socket"),
  aiBtnClearEvents: $("ai-btn-clear-events"),
  aiEventLog: $("ai-event-log"),
  // VPN Hub view
  vpnHubOsChip: $("vpn-hub-os-chip"),
  vpnBtnQuickDirect: $("vpn-btn-quick-direct"),
  vpnMetricOs: $("vpn-metric-os"),
  vpnMetricWebrtc: $("vpn-metric-webrtc"),
  vpnMetricKillswitch: $("vpn-metric-killswitch"),
  vpnActiveBadge: $("vpn-active-badge"),
  vpnHubForm: $("vpn-hub-form"),
  vpnHubScope: $("vpn-hub-scope"),
  vpnHubEndpoint: $("vpn-hub-endpoint"),
  vpnHubDoh: $("vpn-hub-doh"),
  vpnHubFailClosed: $("vpn-hub-fail-closed"),
  vpnHubSubmit: $("vpn-hub-submit"),
  vpnBtnRefresh: $("vpn-btn-refresh"),
  vpnHubRoutes: $("vpn-hub-routes"),
  vpnPrivatePills: $("vpn-private-pills"),
  vpnProfileName: $("vpn-profile-name"),
  vpnBtnSaveProfile: $("vpn-btn-save-profile"),
  vpnProfilesPath: $("vpn-profiles-path"),
  vpnProfileList: $("vpn-profile-list"),
  vpnBtnManualBackup: $("vpn-btn-manual-backup"),
  vpnBtnClearBackups: $("vpn-btn-clear-backups"),
  vpnBackupsPath: $("vpn-backups-path"),
  vpnBackupList: $("vpn-backup-list"),
  // Personalization view
  btnResetPersonal: $("btn-reset-personal"),
  prefThemeLabel: $("pref-theme-label"),
  prefAccentLabel: $("pref-accent-label"),
  prefLayoutLabel: $("pref-layout-label"),
  prefFrostLabel: $("pref-frost-label"),
  customAccentInput: $("custom-accent-input"),
  customAccentHex: $("custom-accent-hex"),
  btnApplyCustomColor: $("btn-apply-custom-color"),
  prefCompactToggle: $("pref-compact-toggle"),
  // Settings view
  settingsBtnRefresh: $("settings-btn-refresh"),
  settingsLiveToggle: $("settings-live-toggle"),
  settingsBookmarkBarToggle: $("settings-bookmark-bar-toggle"),
  btnInitZenPreset: $("btn-init-zen-preset"),
  btnInitChromePreset: $("btn-init-chrome-preset"),
  btnResetAllInit: $("btn-reset-all-init"),
  subnavBtnIncognito: $("subnav-btn-incognito"),
  subnavAiSpace: $("subnav-ai-space"),
  setNativeUiPath: $("set-native-ui-path"),
  settingsConnPill: $("settings-conn-pill"),
  setEngineVer: $("set-engine-ver"),
  setRuntimeMode: $("set-runtime-mode"),
  setWindowDefault: $("set-window-default"),
  setProtoVer: $("set-proto-ver"),
  setFeatureTags: $("set-feature-tags"),
  // Legacy sheets + URL bar
  sheetNetwork: $("sheet-network"),
  sheetActivity: $("sheet-activity"),
  osProxyChip: $("os-proxy-chip"),
  vpnForm: $("vpn-form"),
  vpnSubmit: $("vpn-form")?.querySelector('button[type="submit"]'),
  vpnScope: $("vpn-scope"),
  vpnEndpoint: $("vpn-endpoint"),
  vpnDoh: $("vpn-doh"),
  vpnFailClosed: $("vpn-fail-closed"),
  routeList: $("route-list"),
  btnClearEvents: $("btn-clear-events"),
  eventLog: $("event-log"),
  urlbar: $("urlbar"),
  urlbarForm: $("urlbar-form"),
  urlbarInput: $("urlbar-input"),
  suggestions: $("suggestions"),
  urlbarTarget: $("urlbar-target"),
  toasts: $("toasts"),
};

const CONTROL_LABELS = {
  IDLE: "空闲待命",
  AGENT_RUNNING: "AI 运行中",
  USER_OBSERVING: "实时旁观",
  USER_ACTIVE: "人工接管中",
  OFFLINE: "未连接",
};

const ROUTE_MODE_LABELS = {
  strict_tunnel: "严格隧道",
  direct_only: "仅直连",
  custom: "自定义分流",
};

const THEME_LABELS = {
  system: "跟随系统",
  light: "日间模式",
  dark: "夜间模式",
};

const ACCENT_LABELS = {
  adaptive: "自适应状态",
  cyan: "极光青",
  sapphire: "冰川蓝",
  violet: "星云紫",
  amber: "日落琥珀",
  emerald: "翡翠光",
  rose: "玫瑰霓虹",
  custom: "自定义光色",
};

const FROST_LABELS = {
  off: "纯净光效 (关闭磨砂)",
  soft: "轻盈磨砂",
  standard: "标准磨砂",
  rich: "浓郁磨砂",
};

// ------------------------------------------------------------------ Helpers

async function rpc(method, params = {}) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || "RPC failed");
    err.code = data.code || "ERR_INTERNAL";
    throw err;
  }
  return data.result;
}

function toast(message, tone = "error") {
  while (els.toasts.children.length >= 3) {
    els.toasts.firstElementChild?.remove();
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.tone = tone;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

function parseUrlParts(raw) {
  try {
    const u = new URL(raw);
    const host = u.host || u.protocol.replace(":", "");
    const path = `${u.pathname}${u.search}${u.hash}`;
    return {
      host,
      path: path === "/" ? "" : path,
      initial: (host.replace(/^www\./, "")[0] || "g").toUpperCase(),
    };
  } catch {
    const clean = (raw || "about:blank").trim();
    return {
      host: clean || "about:blank",
      path: "",
      initial: (clean[0] || "g").toUpperCase(),
    };
  }
}

function normalizeUserUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "about:blank";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(v)) return v;
  if (v.includes(".") && !v.includes(" ")) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function parseViewportPref() {
  const [w, h] = String(state.viewport || "1280x800").split("x").map(Number);
  return { width: w > 0 ? w : 1280, height: h > 0 ? h : 800 };
}

function hueColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const palette = ["#4f8dff", "#2dd4bf", "#a77bff", "#f0509c", "#ffb547", "#38bdf8", "#4ade80"];
  return palette[hash % palette.length];
}

function hexToHsl(hex) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function getSelectedSpace() {
  return state.spaces.find((s) => s.spaceId === state.selectedSpaceId) || null;
}

function getSelectedPage() {
  return state.pages.find((p) => p.pageId === state.selectedPageId) || null;
}

function setBusyVisual(elements, isBusy) {
  for (const el of elements) {
    if (!el) continue;
    if (isBusy) {
      el.dataset.busy = "true";
      el.setAttribute("aria-busy", "true");
      if ("disabled" in el) el.disabled = true;
    } else {
      delete el.dataset.busy;
      el.removeAttribute("aria-busy");
      if ("disabled" in el) el.disabled = false;
    }
  }
}

function syncBusyVisuals() {
  for (const [key, targets] of state.busyTargets) {
    if (state.busy.has(key)) {
      setBusyVisual(targets, true);
    }
  }
}

async function runBusy(actionKey, targets, fn) {
  if (state.busy.has(actionKey)) return;
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  state.busy.add(actionKey);
  state.busyTargets.set(actionKey, list);
  setBusyVisual(list, true);
  try {
    return await fn();
  } finally {
    state.busy.delete(actionKey);
    state.busyTargets.delete(actionKey);
    setBusyVisual(list, false);
    renderAll();
  }
}

function runQuickBusy(actionKey, targets, fn, cooldownMs = 160) {
  if (state.busy.has(actionKey)) return;
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  state.busy.add(actionKey);
  state.busyTargets.set(actionKey, list);
  setBusyVisual(list, true);
  try {
    fn();
  } finally {
    setTimeout(() => {
      state.busy.delete(actionKey);
      state.busyTargets.delete(actionKey);
      setBusyVisual(list, false);
      renderAll();
    }, cooldownMs);
  }
}

async function copyText(text, label = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}：${text}`, "ok");
  } catch {
    toast(`复制内容：${text}`, "ok");
  }
}

// ------------------------------------------------------------ Light Tracking

function bindSpotlight(container, itemSelector) {
  if (!container) return;
  container.addEventListener("pointermove", (e) => {
    const rect = container.getBoundingClientRect();
    container.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    container.style.setProperty("--my", `${e.clientY - rect.top}px`);
    container.style.setProperty("--spot", "1");

    if (itemSelector) {
      const target = e.target.closest(itemSelector);
      if (target) {
        const r = target.getBoundingClientRect();
        target.style.setProperty("--mx", `${e.clientX - r.left}px`);
        target.style.setProperty("--my", `${e.clientY - r.top}px`);
      }
    }
  });
  container.addEventListener("pointerleave", () => {
    container.style.setProperty("--spot", "0");
  });
}

bindSpotlight(els.sidebar, ".essential, .tab, .pillar-btn, .pillar-tile");
bindSpotlight(els.chromeTop, ".chrome-tab, .chrome-pillar");
bindSpotlight(els.chromeToolbar, null);
bindSpotlight(els.panelSurface, null);

// ------------------------------------------------------------ Navigation

function setView(viewName) {
  state.activeView = viewName;
  state.activeSheet = null;
  if (viewName === "ai") {
    els.activityDot?.classList.remove("on");
    els.chromeActivityDot?.classList.remove("on");
  }
  if (viewName === "vpn") {
    loadVpnStore();
  }
  renderAll();
  if (
    viewName === "page" &&
    state.spaceMode === "ai" &&
    state.selectedPageId &&
    !state.frameCache.has(state.selectedPageId)
  ) {
    captureFrame({ silent: true });
  }
}

// ----------------------------------------------------------------- Rendering

function setSpaceMode(mode) {
  state.spaceMode = mode === "ai" ? "ai" : "normal";
  if (state.spaceMode === "ai" && !state.selectedPageId && state.pages.length > 0) {
    state.selectedSpaceId = state.pages[0].spaceId;
    state.selectedPageId = state.pages[0].pageId;
  }
  renderAll();
  if (state.spaceMode === "ai" && state.activeView === "page" && state.selectedPageId && !state.frameCache.has(state.selectedPageId)) {
    captureFrame({ silent: true });
  }
}

async function openNativeWindow(url, { incognito = false, recordUserTab = false } = {}) {
  const targetUrl = incognito ? (url || "about:blank") : normalizeUserUrl(url);
  if (recordUserTab && !incognito && /^https?:\/\//i.test(targetUrl)) {
    const { host } = parseUrlParts(targetUrl);
    const existing = state.userTabs.find((t) => t.url === targetUrl);
    if (existing) {
      existing.ts = Date.now();
      state.selectedUserTabId = existing.id;
    } else {
      const entry = { id: `ut_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, url: targetUrl, title: host, ts: Date.now() };
      state.userTabs.unshift(entry);
      state.selectedUserTabId = entry.id;
    }
    saveUserTabs();
    renderAll();
  }
  const res = await fetch("/api/user/open-native", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetUrl, incognito }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "无法打开原生窗口");
  toast(incognito ? "已打开 Gador 隐私窗口（无痕）" : `已在原生 Gador 窗口打开：${targetUrl}`, "ok");
}

function removeUserTab(id) {
  state.userTabs = state.userTabs.filter((t) => t.id !== id);
  if (state.selectedUserTabId === id) {
    state.selectedUserTabId = state.userTabs[0]?.id || null;
  }
  saveUserTabs();
  renderAll();
}

async function syncNativeAppearance(patch = {}) {
  if (!state.connected) return;
  try {
    const accentColor =
      patch.accentColor !== undefined
        ? patch.accentColor
        : state.accent === "custom"
          ? state.customColor
          : ACCENT_HEX_MAP[state.accent] ?? "";
    const glowIntensity =
      state.glow === "subtle" ? 0.65 : state.glow === "vivid" ? 1.45 : 1.0;
    const payload = {
      theme: state.theme,
      accentColor,
      layout: state.layout,
      compact: Boolean(state.compact),
      showBookmarkBar: Boolean(state.showBookmarkBar),
      aiAuraIntensity: glowIntensity,
      ...patch,
    };
    const res = await rpc("ui.setAppearance", payload);
    if (res?.nativeUi?.configPath) {
      state.nativeUiConfigPath = res.nativeUi.configPath;
    }
  } catch {
    // non-fatal when daemon is offline
  }
}

async function loadNativeAppearance() {
  if (!state.connected) return;
  try {
    const res = await rpc("ui.getAppearance", {});
    if (typeof res?.showBookmarkBar === "boolean") {
      state.showBookmarkBar = res.showBookmarkBar;
    }
    if (res?.nativeUi?.configPath) {
      state.nativeUiConfigPath = res.nativeUi.configPath;
    }
    if (els.settingsBookmarkBarToggle) {
      els.settingsBookmarkBarToggle.checked = Boolean(state.showBookmarkBar);
    }
    if (els.setNativeUiPath && state.nativeUiConfigPath) {
      els.setNativeUiPath.textContent = state.nativeUiConfigPath;
    }
  } catch {
    // ignore if backend doesn't expose ui.getAppearance
  }
}

function renderRootAtmosphere() {
  const space = getSelectedSpace();
  const hasAiPages = state.pages.length > 0;
  document.documentElement.dataset.theme = state.theme;
  els.zen.dataset.shell = state.shellMode;
  els.zen.dataset.layout = state.layout;
  els.zen.dataset.view = state.activeView;
  els.zen.dataset.spaceMode = state.spaceMode;
  els.zen.dataset.accent = state.accent;
  els.zen.dataset.frost = state.frost;
  els.zen.dataset.glow = state.glow;
  els.zen.dataset.compact = state.layout === "sidebar" && state.compact ? "true" : "false";
  els.zen.dataset.conn = state.connected ? "online" : "offline";
  els.zen.dataset.auth = state.spaceMode === "ai" && space ? space.authMode : "none";
  els.zen.dataset.hasAi = hasAiPages ? "true" : "false";
  els.zen.dataset.aiActive = state.spaceMode === "ai" && hasAiPages ? "true" : "false";

  // Sync space switcher active state & AI page counts
  document.querySelectorAll("[data-set-space-mode]").forEach((btn) => {
    const active = btn.dataset.setSpaceMode === state.spaceMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (els.sbAiCount) els.sbAiCount.textContent = String(state.pages.length);
  if (els.chromeAiCount) els.chromeAiCount.textContent = String(state.pages.length);
  const aiStopped = space?.controlState === "USER_ACTIVE";
  for (const b of [els.sbSpaceAiBeacon, els.chromeSpaceAiBeacon]) {
    if (b) b.dataset.control = aiStopped ? "USER_ACTIVE" : "AGENT_RUNNING";
  }

  if (state.accent === "custom" && /^#[0-9a-f]{6}$/i.test(state.customColor)) {
    const [h, s, l] = hexToHsl(state.customColor);
    const sat = Math.max(55, s);
    const lit = Math.min(68, Math.max(46, l));
    els.zen.style.setProperty("--custom-l1", state.customColor);
    els.zen.style.setProperty("--custom-l2", `hsl(${(h + 42) % 360} ${sat}% ${lit}%)`);
    els.zen.style.setProperty("--custom-l3", `hsl(${(h + 305) % 360} ${sat}% ${Math.min(66, lit + 4)}%)`);
  }

  const control = !state.connected
    ? "OFFLINE"
    : space
      ? space.controlState
      : "IDLE";
  els.zen.dataset.control = control;

  let metaText = "offline";
  if (state.connected && state.capabilities) {
    const mode = state.capabilities.runtimeMode || "daemon";
    const ver = (state.capabilities.chromiumVersion || "158").split(".")[0];
    metaText = `${mode} · gador ${ver}`;
  }
  els.runtimeMeta.textContent = metaText;
  els.chromeRuntimeMeta.textContent = metaText;

  // Network health glow synced across pillars
  const blocked = state.routes.some(
    (r) => r.mode === "strict_tunnel" && r.failClosed && !r.tunnelHealthy
  );
  const tunneled = state.routes.some(
    (r) => r.mode !== "direct_only" && r.tunnelHealthy
  );
  const netHealth = blocked ? "blocked" : tunneled ? "ok" : "direct";
  for (const el of [els.essNetwork, els.chromeEssNetwork, els.navVpn, els.chromeNavVpn]) {
    if (el) el.dataset.health = netHealth;
  }

  // Show unified Gador Settings top tab bar (always visible in single-layer embedded native mode)
  const inSettingsGroup = ["personalization", "ai", "vpn", "settings"].includes(state.activeView);
  const subnav = $("settings-subnav");
  if (subnav) subnav.classList.toggle("hidden", state.shellMode !== "embedded" && !inSettingsGroup);

  // Highlight active primary view buttons
  document.querySelectorAll("[data-nav-view]").forEach((btn) => {
    const target = btn.dataset.navView;
    const isGearBtn = btn.id === "nav-settings" || btn.id === "chrome-nav-settings";
    const active = isGearBtn ? inSettingsGroup : target === state.activeView;
    if (active) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });

  // Show only the active stage pane
  document.querySelectorAll("[data-view-pane]").forEach((pane) => {
    pane.classList.toggle("hidden", pane.dataset.viewPane !== state.activeView);
  });
}

function createAiBeacon(controlState = "AGENT_RUNNING", size = "sm") {
  const el = document.createElement("span");
  el.className = `ai-beacon ${size}`;
  el.dataset.control = controlState;
  el.title =
    controlState === "USER_ACTIVE"
      ? "已停止 / 人工接管中"
      : controlState === "USER_OBSERVING"
        ? "AI 页面 · 实时旁观"
        : "AI 正在运行此页面";
  el.setAttribute("aria-label", el.title);
  el.innerHTML = "<i></i>";
  return el;
}

function createAiStopButton(spaceId, pageId, controlState) {
  const btn = document.createElement("button");
  const isStopped = controlState === "USER_ACTIVE";
  btn.className = `ai-stop-btn${isStopped ? " stopped" : ""}`;
  btn.type = "button";
  btn.title = isStopped ? "恢复 AI 继续运行" : "立即停止 AI 运行";
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = isStopped
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12.5 8 5 12.5Z" fill="currentColor" stroke="none"/></svg>`
    : `<span class="stop-sq" aria-hidden="true"></span>`;
  btn.onclick = async (e) => {
    e.stopPropagation();
    await runBusy(`stop-ai:${spaceId}`, btn, () => stopOrResumeSpace(spaceId, pageId, !isStopped));
  };
  return btn;
}

async function stopOrResumeSpace(spaceId, pageId, shouldStop) {
  try {
    if (shouldStop) {
      await rpc("takeover.request", {
        spaceId,
        pageId: pageId || undefined,
        reason: "user_stopped_ai",
      });
      toast("已停止 AI 运行并冻结写入", "warm");
    } else {
      await rpc("takeover.release", { spaceId });
      toast("已恢复 AI 继续运行", "ok");
    }
    await refreshState();
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

function renderSidebar() {
  const isAiSpace = state.spaceMode === "ai";
  const space = getSelectedSpace();
  const page = isAiSpace ? getSelectedPage() : null;
  const userTab = !isAiSpace
    ? state.userTabs.find((t) => t.id === state.selectedUserTabId) || null
    : null;

  const activeUrl = isAiSpace ? page?.url : userTab?.url;
  if (activeUrl) {
    const { host, path } = parseUrlParts(activeUrl);
    els.urlTrigger.classList.add("has-url");
    els.urlTriggerText.textContent = `${host}${path}`;
    els.chromeOmnibox.classList.add("has-url");
    els.chromeOmniboxText.textContent = `${host}${path}`;
  } else {
    els.urlTrigger.classList.remove("has-url");
    els.urlTriggerText.textContent = isAiSpace ? "输入网址在 AI 空间打开…" : "搜索或输入网址…";
    els.chromeOmnibox.classList.remove("has-url");
    els.chromeOmniboxText.textContent = isAiSpace ? "输入网址在 AI 空间打开…" : "搜索或输入网址…";
  }

  if (!isAiSpace) {
    els.wsName.textContent = "日常空间";
    els.wsAuth.textContent = "非 AI";
    els.btnCloseSpace.disabled = true;
    els.chromeWsName.textContent = "日常空间";
    els.chromeWsAuth.textContent = "";
    els.chromeBtnCloseSpace.disabled = true;
  } else if (space) {
    els.wsName.textContent = "AI 运行中";
    els.wsAuth.textContent = `${state.pages.length} 页`;
    els.btnCloseSpace.disabled = false;
    els.chromeWsName.textContent = space.name;
    els.chromeWsAuth.textContent = space.controlState === "USER_ACTIVE" ? "已停止" : "AI";
    els.chromeBtnCloseSpace.disabled = false;
  } else {
    els.wsName.textContent = "AI 运行中";
    els.wsAuth.textContent = "空闲";
    els.btnCloseSpace.disabled = true;
    els.chromeWsName.textContent = "AI 空间";
    els.chromeWsAuth.textContent = "";
    els.chromeBtnCloseSpace.disabled = true;
  }

  // Non-AI Normal Space: render clean personal tabs (NO AI beacon, NO Stop AI button)
  if (!isAiSpace) {
    const countStr = String(state.userTabs.length);
    if (els.sbBadgePages) els.sbBadgePages.textContent = countStr;
    if (els.chromeBadgePages) els.chromeBadgePages.textContent = countStr;

    els.tabList.innerHTML = "";
    els.chromeTabList.innerHTML = "";

    if (state.userTabs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tabs-empty";
      empty.textContent = "干净的日常浏览空间，按 Ctrl+L 输入网址即可原生打开";
      els.tabList.append(empty);

      const cempty = document.createElement("span");
      cempty.className = "chrome-tabs-empty";
      cempty.textContent = "按 Ctrl+L 或点击 + 打开日常网页";
      els.chromeTabList.append(cempty);
    } else {
      for (const ut of state.userTabs) {
        const { host, path, initial } = parseUrlParts(ut.url);

        // Vertical Zen tab
        const tab = document.createElement("div");
        tab.className = "tab";
        tab.role = "option";
        tab.tabIndex = 0;
        tab.setAttribute(
          "aria-selected",
          state.activeView === "page" && ut.id === state.selectedUserTabId ? "true" : "false"
        );

        const fav = document.createElement("span");
        fav.className = "favicon";
        fav.style.setProperty("--fav", hueColor(host));
        fav.textContent = initial;

        const text = document.createElement("div");
        text.className = "tab-text";
        const title = document.createElement("span");
        title.className = "tab-title";
        title.textContent = host;
        const sub = document.createElement("span");
        sub.className = "tab-sub";
        sub.textContent = path || ut.url;
        text.append(title, sub);

        const close = document.createElement("button");
        close.className = "icon-btn sm tab-close";
        close.type = "button";
        close.setAttribute("aria-label", "移除记录");
        close.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`;
        close.onclick = (e) => {
          e.stopPropagation();
          removeUserTab(ut.id);
        };

        tab.append(fav, text, close);
        const launch = () => {
          state.selectedUserTabId = ut.id;
          state.activeView = "page";
          renderAll();
          runBusy(`native-tab:${ut.id}`, tab, () => openNativeWindow(ut.url, { recordUserTab: false }));
        };
        tab.onclick = launch;
        tab.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            launch();
          }
        };
        els.tabList.append(tab);

        // Horizontal Chrome tab
        const ctab = document.createElement("div");
        ctab.className = "chrome-tab";
        ctab.role = "option";
        ctab.tabIndex = 0;
        ctab.setAttribute(
          "aria-selected",
          state.activeView === "page" && ut.id === state.selectedUserTabId ? "true" : "false"
        );
        ctab.title = ut.url;

        const cfav = document.createElement("span");
        cfav.className = "favicon";
        cfav.style.setProperty("--fav", hueColor(host));
        cfav.textContent = initial;
        const ctitle = document.createElement("span");
        ctitle.className = "chrome-tab-title";
        ctitle.textContent = host;
        const cclose = document.createElement("button");
        cclose.className = "icon-btn sm tab-close";
        cclose.type = "button";
        cclose.setAttribute("aria-label", "移除记录");
        cclose.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`;
        cclose.onclick = (e) => {
          e.stopPropagation();
          removeUserTab(ut.id);
        };
        ctab.append(cfav, ctitle, cclose);
        ctab.onclick = launch;
        ctab.onkeydown = tab.onkeydown;
        els.chromeTabList.append(ctab);
      }
    }
    return;
  }

  // AI-Running Space: render all AI-managed pages with concentric luminous .ai-beacon + Stop AI button
  const aiPages = state.pages;
  const countStr = String(aiPages.length);
  if (els.sbBadgePages) els.sbBadgePages.textContent = countStr;
  if (els.chromeBadgePages) els.chromeBadgePages.textContent = countStr;

  els.tabList.innerHTML = "";
  if (aiPages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tabs-empty";
    empty.textContent = "当前没有正在运行的 AI 页面；当 AI 通过 MCP/Skill 接管网页时会自动出现在这里";
    els.tabList.append(empty);
  } else {
    for (const pg of aiPages) {
      const sp = state.spaces.find((s) => s.spaceId === pg.spaceId) || space;
      const ctrl = sp?.controlState || "AGENT_RUNNING";
      const { host, path, initial } = parseUrlParts(pg.url);
      const tab = document.createElement("div");
      tab.className = "tab";
      tab.role = "option";
      tab.tabIndex = 0;
      tab.setAttribute(
        "aria-selected",
        state.activeView === "page" && pg.pageId === state.selectedPageId ? "true" : "false"
      );

      const fav = document.createElement("span");
      fav.className = "favicon";
      fav.style.setProperty("--fav", hueColor(host));
      fav.textContent = initial;

      const text = document.createElement("div");
      text.className = "tab-text";
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = host;
      const sub = document.createElement("span");
      sub.className = "tab-sub";
      sub.textContent = path || pg.pageId;
      text.append(title, sub);

      tab.append(fav, text);

      tab.dataset.aiRunning = ctrl === "AGENT_RUNNING" ? "true" : "false";
      tab.append(
        createAiBeacon(ctrl, "xs"),
        createAiStopButton(pg.spaceId, pg.pageId, ctrl)
      );

      if (pg.hasOpenDialog || state.openDialogs.has(pg.pageId)) {
        const flag = document.createElement("span");
        flag.className = "tab-flag";
        flag.title = "有待处理的对话框";
        tab.append(flag);
      }

      const close = document.createElement("button");
      close.className = "icon-btn sm tab-close";
      close.type = "button";
      close.setAttribute("aria-label", "关闭页面");
      close.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`;
      close.onclick = async (e) => {
        e.stopPropagation();
        await runBusy(`close-page:${pg.pageId}`, close, () => closePage(pg.pageId));
      };
      tab.append(close);

      const activate = () => selectPage(pg.pageId);
      tab.onclick = activate;
      tab.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      };

      els.tabList.append(tab);
    }
  }

  // AI Workspace orbs (shown in AI Space when multiple AI spaces exist)
  els.workspaceList.innerHTML = "";
  els.chromeWorkspaces.innerHTML = "";
  for (const sp of state.spaces) {
    for (const hostList of [els.workspaceList, els.chromeWorkspaces]) {
      const orb = document.createElement("button");
      orb.className = "ws-orb";
      orb.type = "button";
      orb.role = "tab";
      orb.dataset.auth = sp.authMode;
      orb.dataset.control = sp.controlState;
      orb.setAttribute("aria-selected", sp.spaceId === state.selectedSpaceId ? "true" : "false");
      orb.title = `${sp.name} (${sp.controlState})`;
      orb.innerHTML = "<i></i>";
      orb.onclick = () => selectSpace(sp.spaceId);
      hostList.append(orb);
    }
  }

  // Horizontal Chrome tabs in AI Space
  els.chromeTabList.innerHTML = "";
  if (aiPages.length === 0) {
    const empty = document.createElement("span");
    empty.className = "chrome-tabs-empty";
    empty.textContent = "当前无运行中的 AI 页面";
    els.chromeTabList.append(empty);
  } else {
    for (const pg of aiPages) {
      const sp = state.spaces.find((s) => s.spaceId === pg.spaceId) || space;
      const ctrl = sp?.controlState || "AGENT_RUNNING";
      const { host, initial } = parseUrlParts(pg.url);
      const ctab = document.createElement("div");
      ctab.className = "chrome-tab";
      ctab.role = "option";
      ctab.tabIndex = 0;
      ctab.setAttribute(
        "aria-selected",
        state.activeView === "page" && pg.pageId === state.selectedPageId ? "true" : "false"
      );
      ctab.title = pg.url;

      const fav = document.createElement("span");
      fav.className = "favicon";
      fav.style.setProperty("--fav", hueColor(host));
      fav.textContent = initial;

      const title = document.createElement("span");
      title.className = "chrome-tab-title";
      title.textContent = host;

      ctab.append(fav, title);

      ctab.dataset.aiRunning = ctrl === "AGENT_RUNNING" ? "true" : "false";
      ctab.append(
        createAiBeacon(ctrl, "xs"),
        createAiStopButton(pg.spaceId, pg.pageId, ctrl)
      );

      if (pg.hasOpenDialog || state.openDialogs.has(pg.pageId)) {
        const flag = document.createElement("span");
        flag.className = "tab-flag";
        flag.title = "有待处理的对话框";
        ctab.append(flag);
      }

      const close = document.createElement("button");
      close.className = "icon-btn sm tab-close";
      close.type = "button";
      close.setAttribute("aria-label", "关闭标签页");
      close.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>`;
      close.onclick = async (e) => {
        e.stopPropagation();
        await runBusy(`close-page:${pg.pageId}`, close, () => closePage(pg.pageId));
      };
      ctab.append(close);

      const activate = () => selectPage(pg.pageId);
      ctab.onclick = activate;
      ctab.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      };

      els.chromeTabList.append(ctab);
    }
  }
}

function renderStage() {
  const isAiSpace = state.spaceMode === "ai";
  const space = getSelectedSpace();
  const page = isAiSpace ? getSelectedPage() : null;
  const control = !state.connected
    ? "OFFLINE"
    : space
      ? space.controlState
      : "IDLE";

  els.controlState.textContent = CONTROL_LABELS[control] || control;

  const isUserActive = space?.controlState === "USER_ACTIVE";
  els.btnTakeover.textContent = isUserActive ? "交回" : "接管";
  els.btnTakeover.className = `cap-btn ${isUserActive ? "cool" : "warm"}`;
  els.btnTakeover.disabled = !space || !state.connected;
  if (els.btnStopAi) {
    els.btnStopAi.textContent = isUserActive ? "▶ 恢复" : "■ 停止";
    els.btnStopAi.className = `cap-btn ${isUserActive ? "cool" : "danger"}`;
    els.btnStopAi.disabled = !space || !state.connected;
  }
  if (els.btnStopAiBar) {
    els.btnStopAiBar.classList.toggle("hidden", !isAiSpace || !page || !space);
    els.btnStopAiBar.classList.toggle("stopped", Boolean(isUserActive));
    els.btnStopAiBar.innerHTML = isUserActive
      ? `<svg viewBox="0 0 16 16" style="width:12px;height:12px" aria-hidden="true"><path d="M5 3.5 12.5 8 5 12.5Z" fill="currentColor" stroke="none"/></svg><span>恢复 AI</span>`
      : `<span class="stop-sq" aria-hidden="true"></span><span>停止 AI</span>`;
  }
  els.btnCapture.disabled = !page || !state.connected;
  els.btnLive.disabled = !page || !state.connected;
  els.btnLive.setAttribute("aria-pressed", state.liveRefresh ? "true" : "false");
  els.btnCollapse.disabled = !page || !state.connected;

  const emptyTitleEl = els.emptyState?.querySelector(".empty-title");
  const emptySubEl = els.emptyState?.querySelector(".empty-sub");

  if (isAiSpace && page) {
    const { host, path } = parseUrlParts(page.url);
    els.frameHost.textContent = host;
    els.framePath.textContent = path || `${page.viewport.width}×${page.viewport.height}`;
    els.btnOpenNativeTab?.classList.remove("hidden");
    if (els.panelAiBeacon) {
      els.panelAiBeacon.classList.remove("hidden");
      els.panelAiBeacon.dataset.control = space?.controlState || "AGENT_RUNNING";
    }
    if (els.capsuleAiBeacon) {
      els.capsuleAiBeacon.dataset.control = space?.controlState || "AGENT_RUNNING";
    }

    const cached = state.frameCache.get(page.pageId);
    if (cached) {
      if (els.frame.src !== cached.src) {
        els.frame.src = cached.src;
      }
      els.frame.classList.remove("hidden");
      els.emptyState.classList.add("hidden");
      els.frameNote.classList.add("hidden");
      els.frameTime.textContent = cached.ts;
    } else {
      els.frame.classList.add("hidden");
      els.emptyState.classList.add("hidden");
      els.frameNote.textContent = "AI 托管页面已就绪（点击「原生窗口打开」可 60fps 直接交互，或点击下方「画面」刷新预览）";
      els.frameNote.classList.remove("hidden");
      els.frameTime.textContent = "";
    }
  } else {
    els.frameHost.textContent = isAiSpace ? "AI 运行空间" : "gador · 日常空间";
    els.framePath.textContent = !state.connected
      ? "disconnected"
      : isAiSpace
        ? "暂无运行中的 AI 页面"
        : "纯净非 AI 浏览区";
    els.frameTime.textContent = "";
    els.btnOpenNativeTab?.classList.add("hidden");
    els.panelAiBeacon?.classList.add("hidden");
    els.frame.classList.add("hidden");
    els.frameNote.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    if (emptyTitleEl && emptySubEl) {
      if (isAiSpace) {
        emptyTitleEl.textContent = "AI 运行空间空闲待命";
        emptySubEl.innerHTML =
          "此处专门隔离展示 AI 正在执行的页面，配有同心光环与一键停止键。当 AI 通过 MCP/Skill 打开网页时会实时出现在这里，或按 <kbd>Ctrl</kbd> <kbd>L</kbd> 手动打开。";
      } else {
        emptyTitleEl.textContent = "安静地运行在光里";
        emptySubEl.innerHTML =
          "当前处于非 AI 干扰的日常空间。按 <kbd>Ctrl</kbd> <kbd>L</kbd> 搜索或直接原生打开网页；隐私窗口与 Google 账户设置位于左下角。";
      }
    }
  }

  // Non-blocking JS dialog card
  const dialog = page ? state.openDialogs.get(page.pageId) : null;
  if (dialog) {
    els.panel.classList.add("has-dialog");
    els.dialogCard.classList.remove("hidden");
    els.dialogType.textContent = (dialog.type || "dialog").toUpperCase();
    els.dialogMsg.textContent = dialog.message || "";
    const needsInput = dialog.type === "prompt";
    els.dialogInput.classList.toggle("hidden", !needsInput);
    if (needsInput && els.dialogInput.dataset.boundPage !== `${page.pageId}:${dialog.message}`) {
      els.dialogInput.value = dialog.defaultPrompt || "";
      els.dialogInput.dataset.boundPage = `${page.pageId}:${dialog.message}`;
    }
  } else {
    els.panel.classList.remove("has-dialog");
    els.dialogCard.classList.add("hidden");
  }
}

function renderOverview() {
  const isAiSpace = state.spaceMode === "ai";
  const isAll = state.overviewScope === "all";
  els.ovScopeCurrent.classList.toggle("active", !isAll);
  els.ovScopeAll.classList.toggle("active", isAll);
  els.ovScopeCurrent.textContent = isAiSpace ? "AI 运行空间" : "日常空间";

  const showUserTabs = isAll || !isAiSpace;
  const showAiPages = isAll || isAiSpace;
  const userList = showUserTabs ? state.userTabs : [];
  const aiList = showAiPages ? state.pages : [];
  const totalCount = userList.length + aiList.length;

  els.overviewTitle.textContent = isAll
    ? `全部页面总览 (${totalCount})`
    : isAiSpace
      ? `AI 运行空间全部页面 (${aiList.length})`
      : `日常空间全部页面 (${userList.length})`;
  els.overviewSub.textContent = isAll
    ? `日常浏览 ${state.userTabs.length} 页 · AI 运行中 ${state.pages.length} 页，两类空间清晰分离。`
    : isAiSpace
      ? `展示所有 AI 正在运行或已停止接管的页面，带同心光环标识与一键停止键。`
      : `非 AI 干扰的日常网页列表，点击即可在原生 Gador 窗口打开。`;

  els.overviewGrid.innerHTML = "";

  for (const ut of userList) {
    const { host, initial } = parseUrlParts(ut.url);
    const card = document.createElement("article");
    card.className = `ov-card${ut.id === state.selectedUserTabId ? " selected" : ""}`;

    const thumb = document.createElement("div");
    thumb.className = "ov-thumb";
    thumb.onclick = () => runBusy(`ov-open-native:${ut.id}`, card, () => openNativeWindow(ut.url, { recordUserTab: false }));
    const ph = document.createElement("div");
    ph.className = "ov-placeholder";
    ph.innerHTML = `<span class="ov-placeholder-orb" style="--ov-hue:${hueColor(host)}"></span><small>日常原生页面</small>`;
    ph.querySelector(".ov-placeholder-orb").textContent = initial;
    thumb.append(ph);

    const body = document.createElement("div");
    body.className = "ov-body";
    const h = document.createElement("div");
    h.className = "ov-host";
    h.textContent = host;
    const u = document.createElement("div");
    u.className = "ov-url";
    u.textContent = ut.url;
    u.title = ut.url;

    const actions = document.createElement("div");
    actions.className = "ov-actions";
    const btnOpen = document.createElement("button");
    btnOpen.className = "btn glow xs";
    btnOpen.type = "button";
    btnOpen.textContent = "原生打开";
    btnOpen.onclick = () => runBusy(`ov-open-native:${ut.id}`, btnOpen, () => openNativeWindow(ut.url, { recordUserTab: false }));
    const btnRemove = document.createElement("button");
    btnRemove.className = "btn ghost xs";
    btnRemove.type = "button";
    btnRemove.textContent = "移除";
    btnRemove.onclick = () => removeUserTab(ut.id);
    actions.append(btnOpen, btnRemove);
    body.append(h, u, actions);
    card.append(thumb, body);
    els.overviewGrid.append(card);
  }

  for (const pg of aiList) {
    const sp = state.spaces.find((s) => s.spaceId === pg.spaceId);
    const { host, initial } = parseUrlParts(pg.url);
    const cached = state.frameCache.get(pg.pageId);

    const card = document.createElement("article");
    card.className = `ov-card${pg.pageId === state.selectedPageId ? " selected" : ""}`;

    const thumb = document.createElement("div");
    thumb.className = "ov-thumb";
    thumb.onclick = () => selectPage(pg.pageId);

    if (cached?.src) {
      const img = document.createElement("img");
      img.src = cached.src;
      img.alt = host;
      thumb.append(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "ov-placeholder";
      ph.innerHTML = `<span class="ov-placeholder-orb" style="--ov-hue:${hueColor(host)}"></span><small>${pg.viewport.width}×${pg.viewport.height}</small>`;
      ph.querySelector(".ov-placeholder-orb").textContent = initial;
      thumb.append(ph);
    }

    const badges = document.createElement("div");
    badges.className = "ov-badges";
    if (sp) {
      badges.append(createAiBeacon(sp.controlState, "sm"));
    }
    if (pg.hasOpenDialog || state.openDialogs.has(pg.pageId)) {
      const d = document.createElement("span");
      d.className = "ov-badge warm";
      d.textContent = "弹窗";
      badges.append(d);
    }
    thumb.append(badges);

    const body = document.createElement("div");
    body.className = "ov-body";
    const h = document.createElement("div");
    h.className = "ov-host";
    h.textContent = host;
    const u = document.createElement("div");
    u.className = "ov-url";
    u.textContent = pg.url;
    u.title = pg.url;

    const actions = document.createElement("div");
    actions.className = "ov-actions";

    const btnOpen = document.createElement("button");
    btnOpen.className = "btn glow xs";
    btnOpen.type = "button";
    btnOpen.textContent = "进入";
    btnOpen.onclick = () =>
      runQuickBusy(`ov-enter:${pg.pageId}`, btnOpen, () => selectPage(pg.pageId));

    const btnSnap = document.createElement("button");
    btnSnap.className = "btn ghost xs";
    btnSnap.type = "button";
    btnSnap.textContent = "截帧";
    btnSnap.onclick = () =>
      runBusy(`ov-snap:${pg.pageId}`, btnSnap, () => capturePageFrame(pg.pageId, { silent: false }));

    const btnStop = document.createElement("button");
    const isStopped = sp?.controlState === "USER_ACTIVE";
    btnStop.className = `btn ${isStopped ? "ghost" : "danger-soft"} xs`;
    btnStop.type = "button";
    btnStop.textContent = isStopped ? "▶ 恢复" : "■ 停止";
    btnStop.onclick = () =>
      runBusy(`ov-stop:${pg.spaceId}`, btnStop, () => stopOrResumeSpace(pg.spaceId, pg.pageId, !isStopped));

    const btnClose = document.createElement("button");
    btnClose.className = "btn ghost xs";
    btnClose.type = "button";
    btnClose.textContent = "关闭";
    btnClose.onclick = () =>
      runBusy(`ov-close:${pg.pageId}`, btnClose, () => closePage(pg.pageId));

    actions.append(btnOpen, btnStop, btnSnap, btnClose);
    body.append(h, u, actions);
    card.append(thumb, body);
    els.overviewGrid.append(card);
  }

  // Add "+ New page in current area" luminous card
  const addCard = document.createElement("button");
  addCard.className = "ov-new-card";
  addCard.type = "button";
  addCard.innerHTML = `<svg viewBox="0 0 16 16" style="width:24px;height:24px" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg><span>在当前区域打开新页面</span>`;
  addCard.onclick = () => openUrlbar("");
  els.overviewGrid.append(addCard);
}

function renderAiHub() {
  const space = getSelectedSpace();
  const control = !state.connected ? "OFFLINE" : space ? space.controlState : "IDLE";
  els.aiControlHeadline.textContent = CONTROL_LABELS[control] || control;
  els.aiControlPill.textContent = control;
  els.aiControlPill.className = `status-pill ${
    control === "USER_ACTIVE" ? "warm" : control === "AGENT_RUNNING" ? "ok" : control === "OFFLINE" ? "danger" : ""
  }`;
  els.aiControlDesc.textContent =
    control === "USER_ACTIVE"
      ? "当前处于人工接管状态：所有 AI 写入、脚本执行与实时截屏已由内核强制冻结，操作完成后点击上方按钮交还控制权。"
      : "无窗口守护模式下，AI 页面保持非零视口与前台优先级运行；一旦触及密码框或支付页面，内核会自动切入人工接管。";

  els.aiBtnTakeover.textContent = space?.controlState === "USER_ACTIVE" ? "交还给 AI" : "立即人工接管";
  els.aiBtnTakeover.disabled = !space || !state.connected;

  const rt = state.capabilities?.runtimeMode === "daemon" ? "无窗口守护 (daemon)" : state.capabilities?.runtimeMode || "—";
  els.aiStatRuntime.textContent = rt;
  els.aiStatSpaces.textContent = String(state.spaces.length);
  els.aiStatPages.textContent = String(state.pages.length);
  els.aiStatDialogs.textContent = String(state.openDialogs.size);

  const hasGuard = state.capabilities?.features?.includes("credential-payment-guard");
  els.aiGuardPill.textContent = hasGuard ? "内核硬围栏已激活" : "等待内核同步";
  if (state.socketPath) {
    els.aiSocketPath.textContent = state.socketPath;
  }

  if (state.skillInfo) {
    if (els.aiMcpBin) els.aiMcpBin.textContent = state.skillInfo.mcpCommand || "gador-mcp";
    if (els.aiSkillPreview) els.aiSkillPreview.textContent = state.skillInfo.skillContent || "";
    if (els.aiSkillPaths) {
      els.aiSkillPaths.innerHTML = "";
      for (const item of state.skillInfo.installedSkillPaths || []) {
        const row = document.createElement("div");
        row.className = "cmd-row";
        row.innerHTML = `<div><span class="cmd-label">${item.exists ? "已安装 Skill" : "可选 Skill 路径"}</span><code></code></div>`;
        row.querySelector("code").textContent = item.path;
        const btn = document.createElement("button");
        btn.className = "btn ghost xs";
        btn.type = "button";
        btn.textContent = "复制路径";
        btn.onclick = () => runQuickBusy(`copy-skill:${item.path}`, btn, () => copyText(item.path, "已复制 Skill 路径"));
        row.append(btn);
        els.aiSkillPaths.append(row);
      }
    }
    if (els.aiMcpTools) {
      els.aiMcpTools.innerHTML = "";
      for (const tool of state.skillInfo.tools || []) {
        const pill = document.createElement("button");
        pill.className = "tool-pill";
        pill.type = "button";
        pill.textContent = tool.name;
        pill.title = tool.description;
        pill.onclick = () => runQuickBusy(`copy-tool:${tool.name}`, pill, () => copyText(tool.name, "已复制 MCP 工具名"));
        els.aiMcpTools.append(pill);
      }
    }
  }
}

function renderRouteItemsInto(container, clickable = false) {
  container.innerHTML = "";
  if (state.routes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "card-desc";
    empty.textContent = "当前浏览器使用默认直连策略（系统代理已隔离）。";
    container.append(empty);
    return;
  }
  for (const r of state.routes) {
    const health =
      r.mode === "strict_tunnel" && r.failClosed && !r.tunnelHealthy
        ? "blocked"
        : r.mode !== "direct_only" && r.tunnelHealthy
          ? "ok"
          : "direct";

    const item = document.createElement("div");
    item.className = "route";
    item.dataset.health = health;
    if (clickable) {
      item.style.cursor = "pointer";
      item.title = "点击回填此路由到左侧编辑器";
      item.onclick = () => {
        els.vpnHubScope.value = r.scope;
        const radio = els.vpnHubForm.querySelector(`input[name="vpn-hub-mode"][value="${r.mode}"]`);
        if (radio) radio.checked = true;
        els.vpnHubFailClosed.checked = Boolean(r.failClosed);
        toast(`已加载 ${r.scope} 路由策略`, "ok");
      };
    }
    item.innerHTML = `
      <span class="route-light" aria-hidden="true"></span>
      <span class="route-scope"></span>
      <span class="route-mode"></span>
      <span class="route-meta"></span>
    `;
    item.querySelector(".route-scope").textContent = r.scope;
    item.querySelector(".route-mode").textContent = ROUTE_MODE_LABELS[r.mode] || r.mode;
    item.querySelector(".route-meta").textContent =
      `failClosed=${r.failClosed ? "on" : "off"} · ${r.webrtcPolicy}`;
    container.append(item);
  }
}

function renderVpnHub() {
  const allOsDisabled = state.routes.length === 0 || state.routes.every((r) => r.osProxyDisabled);
  els.vpnHubOsChip.textContent = allOsDisabled ? "系统代理已隔离" : "检测到系统代理";
  els.vpnHubOsChip.classList.toggle("warn", !allOsDisabled);
  els.vpnMetricOs.textContent = allOsDisabled ? "osProxyDisabled = true" : "未隔离";

  const webrtc = state.routes[0]?.webrtcPolicy || "disable_non_proxied_udp";
  els.vpnMetricWebrtc.textContent = webrtc;

  const blocked = state.routes.some((r) => r.mode === "strict_tunnel" && r.failClosed && !r.tunnelHealthy);
  const tunneled = state.routes.some((r) => r.mode !== "direct_only" && r.tunnelHealthy);
  els.vpnMetricKillswitch.textContent = blocked
    ? "熔断已触发（已阻断出网）"
    : tunneled
      ? "严格隧道在线"
      : "严格熔断待命";

  els.vpnActiveBadge.textContent = blocked ? "已阻断" : tunneled ? "隧道在线" : "直连";
  els.vpnActiveBadge.className = `status-pill ${blocked ? "danger" : tunneled ? "ok" : ""}`;

  renderRouteItemsInto(els.vpnHubRoutes, true);

  // Quick private-space scope selector pills
  els.vpnPrivatePills.innerHTML = "";
  const privSpaces = state.spaces.filter((s) => s.authMode === "private");
  if (privSpaces.length === 0) {
    const note = document.createElement("span");
    note.className = "card-desc";
    note.textContent = "暂无私密 OTR 空间（新建私密空间后可在此一键绑定独立出口）";
    els.vpnPrivatePills.append(note);
  } else {
    for (const sp of privSpaces) {
      const pill = document.createElement("button");
      pill.className = "btn ghost xs";
      pill.type = "button";
      pill.textContent = `选择 ${sp.name} (space:${sp.spaceId})`;
      pill.onclick = () =>
        runQuickBusy(`vpn-pick:${sp.spaceId}`, pill, () => {
          els.vpnHubScope.value = `space:${sp.spaceId}`;
          toast(`已将作用域切换至 space:${sp.spaceId}`, "ok");
        });
      els.vpnPrivatePills.append(pill);
    }
  }

  renderVpnArchiveAndBackups();
}

function renderVpnArchiveAndBackups() {
  const store = state.vpnStore || { profiles: [], backups: [] };
  if (els.vpnProfilesPath && store.profilesFile) {
    els.vpnProfilesPath.textContent = store.profilesFile;
  }
  if (els.vpnBackupsPath && store.backupsDir) {
    els.vpnBackupsPath.textContent = store.backupsDir;
  }

  // Profiles list
  if (els.vpnProfileList) {
    els.vpnProfileList.innerHTML = "";
    const profiles = store.profiles || [];
    if (profiles.length === 0) {
      const empty = document.createElement("p");
      empty.className = "card-desc";
      empty.textContent = "尚无已保存的 VPN 档案。填入上方策略后点击「保存为档案」，或由 AI 调用 vpn_update_profile 自动写入。";
      els.vpnProfileList.append(empty);
    } else {
      for (const p of profiles) {
        const row = document.createElement("div");
        row.className = "vpn-item";

        const main = document.createElement("div");
        main.className = "vpn-item-main";
        const title = document.createElement("div");
        title.className = "vpn-item-title";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = p.name;
        const tag = document.createElement("span");
        tag.className = `vpn-actor-tag${p.updatedBy === "ai" ? " ai" : ""}`;
        tag.textContent = p.updatedBy === "ai" ? "AI" : "用户";
        title.append(nameSpan, tag);

        const meta = document.createElement("div");
        meta.className = "vpn-item-meta";
        meta.textContent = `${p.scope} · ${ROUTE_MODE_LABELS[p.mode] || p.mode}${p.endpoint ? ` · ${p.endpoint}` : ""}`;
        meta.title = meta.textContent;
        main.append(title, meta);

        const actions = document.createElement("div");
        actions.className = "vpn-item-actions";

        const btnLoad = document.createElement("button");
        btnLoad.className = "btn ghost xs";
        btnLoad.type = "button";
        btnLoad.textContent = "载入";
        btnLoad.onclick = () => {
          els.vpnHubScope.value = p.scope || "browser";
          const radio = els.vpnHubForm.querySelector(`input[name="vpn-hub-mode"][value="${p.mode}"]`);
          if (radio) radio.checked = true;
          els.vpnHubEndpoint.value = p.endpoint || "";
          els.vpnHubDoh.value = p.dohServer || "";
          els.vpnHubFailClosed.checked = Boolean(p.failClosed);
          if (els.vpnProfileName) els.vpnProfileName.value = p.name || "";
          toast(`已载入 VPN 档案：${p.name}`, "ok");
        };

        const btnApply = document.createElement("button");
        btnApply.className = "btn glow xs";
        btnApply.type = "button";
        btnApply.textContent = "应用";
        btnApply.onclick = () =>
          runBusy(`vpn-apply-prof:${p.id}`, btnApply, () =>
            applyTunnelForm({
              scope: p.scope,
              mode: p.mode,
              endpoint: p.endpoint,
              dohServer: p.dohServer,
              failClosed: p.failClosed,
            })
          );

        const btnDel = document.createElement("button");
        btnDel.className = "btn danger-soft xs";
        btnDel.type = "button";
        btnDel.textContent = "删除";
        btnDel.onclick = () =>
          runBusy(`vpn-del-prof:${p.id}`, btnDel, () => deleteVpnProfileFromUi(p.id, p.name));

        actions.append(btnLoad, btnApply, btnDel);
        row.append(main, actions);
        els.vpnProfileList.append(row);
      }
    }
  }

  // Backups list (Mandatory pre-modify snapshots + quick delete)
  if (els.vpnBackupList) {
    els.vpnBackupList.innerHTML = "";
    const backups = store.backups || [];
    if (els.vpnBtnClearBackups) {
      els.vpnBtnClearBackups.disabled = backups.length === 0;
    }
    if (backups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "card-desc";
      empty.textContent = "备份区暂无快照。任何 AI 或用户修改 VPN 档案前都会自动生成备份留存于此。";
      els.vpnBackupList.append(empty);
    } else {
      for (const b of backups) {
        const row = document.createElement("div");
        row.className = "vpn-item";

        const main = document.createElement("div");
        main.className = "vpn-item-main";
        const title = document.createElement("div");
        title.className = "vpn-item-title";
        const reasonSpan = document.createElement("span");
        reasonSpan.textContent = b.reason || b.backupId;
        const tag = document.createElement("span");
        tag.className = `vpn-actor-tag${b.actor === "ai" ? " ai" : ""}`;
        tag.textContent = b.actor === "ai" ? "AI 修改前" : "手动/用户";
        title.append(reasonSpan, tag);

        const meta = document.createElement("div");
        meta.className = "vpn-item-meta";
        const ts = b.createdAt ? new Date(b.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
        meta.textContent = `${ts} · ${b.profileCount} 个档案 · ${b.backupId}`;
        meta.title = b.filePath || b.backupId;
        main.append(title, meta);

        const actions = document.createElement("div");
        actions.className = "vpn-item-actions";

        const btnRestore = document.createElement("button");
        btnRestore.className = "btn ghost xs";
        btnRestore.type = "button";
        btnRestore.textContent = "还原";
        btnRestore.onclick = () =>
          runBusy(`vpn-restore:${b.backupId}`, btnRestore, () => restoreVpnBackupFromUi(b.backupId));

        const btnDel = document.createElement("button");
        btnDel.className = "btn danger-soft xs";
        btnDel.type = "button";
        btnDel.textContent = "删除";
        btnDel.onclick = () =>
          runBusy(`vpn-del-bak:${b.backupId}`, btnDel, () => deleteVpnBackupFromUi(b.backupId));

        actions.append(btnRestore, btnDel);
        row.append(main, actions);
        els.vpnBackupList.append(row);
      }
    }
  }
}

async function loadVpnStore() {
  try {
    const res = await fetch("/api/vpn/store");
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) {
      state.vpnStore = data;
      if (state.activeView === "vpn") renderVpnArchiveAndBackups();
    }
  } catch {
    // non-fatal
  }
}

async function saveCurrentVpnProfile() {
  const scope = els.vpnHubScope.value.trim() || "browser";
  const mode = els.vpnHubForm.querySelector('input[name="vpn-hub-mode"]:checked')?.value || "strict_tunnel";
  const endpoint = els.vpnHubEndpoint.value.trim();
  const dohServer = els.vpnHubDoh.value.trim();
  const failClosed = els.vpnHubFailClosed.checked;
  const name = els.vpnProfileName?.value.trim() || `${ROUTE_MODE_LABELS[mode] || mode} (${scope})`;
  try {
    const res = await fetch("/api/vpn/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        scope,
        mode,
        endpoint,
        dohServer,
        failClosed,
        backupReason: `save_profile:${name}`,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "保存档案失败");
    state.vpnStore = data.store || state.vpnStore;
    if (els.vpnProfileName) els.vpnProfileName.value = "";
    renderVpnArchiveAndBackups();
    toast(`已自动备份并保存 VPN 档案：${name}`, "ok");
  } catch (err) {
    toast(err.message);
  }
}

async function deleteVpnProfileFromUi(id, name) {
  try {
    const res = await fetch(`/api/vpn/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "删除档案失败");
    state.vpnStore = data.store || state.vpnStore;
    renderVpnArchiveAndBackups();
    toast(`已留存备份并删除档案：${name}`, "ok");
  } catch (err) {
    toast(err.message);
  }
}

async function createManualVpnBackup() {
  try {
    const res = await fetch("/api/vpn/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "用户手动备份", actor: "user" }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "备份失败");
    state.vpnStore = data.store || state.vpnStore;
    renderVpnArchiveAndBackups();
    toast(`已创建 VPN 快照备份：${data.backup.backupId}`, "ok");
  } catch (err) {
    toast(err.message);
  }
}

async function restoreVpnBackupFromUi(backupId) {
  try {
    const res = await fetch(`/api/vpn/backups/${encodeURIComponent(backupId)}/restore`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "还原失败");
    state.vpnStore = data.store || state.vpnStore;
    renderVpnArchiveAndBackups();
    toast(`已从备份还原 VPN 档案（原状态已自动备份）`, "ok");
  } catch (err) {
    toast(err.message);
  }
}

async function deleteVpnBackupFromUi(backupId) {
  try {
    const res = await fetch(`/api/vpn/backups/${encodeURIComponent(backupId)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "删除备份失败");
    state.vpnStore = data.store || state.vpnStore;
    renderVpnArchiveAndBackups();
    toast("已快捷删除该备份", "ok");
  } catch (err) {
    toast(err.message);
  }
}

async function clearAllVpnBackupsFromUi() {
  try {
    const res = await fetch("/api/vpn/backups", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "清空失败");
    state.vpnStore = data.store || state.vpnStore;
    renderVpnArchiveAndBackups();
    toast(`已清空备份区（共删除 ${data.deletedCount || 0} 份备份）`, "ok");
  } catch (err) {
    toast(err.message);
  }
}

function renderPersonalization() {
  els.prefThemeLabel.textContent = THEME_LABELS[state.theme] || state.theme;
  els.prefAccentLabel.textContent =
    state.accent === "custom" ? `自定义 ${state.customColor.toUpperCase()}` : ACCENT_LABELS[state.accent] || state.accent;
  els.prefLayoutLabel.textContent = state.layout === "chrome" ? "顶部横向栏 × 光效" : "竖向侧边栏";
  els.prefFrostLabel.textContent = FROST_LABELS[state.frost] || state.frost;

  document.querySelectorAll("[data-set-theme]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setTheme === state.theme);
  });
  document.querySelectorAll("[data-set-accent]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setAccent === state.accent);
  });
  document.querySelectorAll("[data-set-layout]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setLayout === state.layout);
  });
  document.querySelectorAll("[data-set-frost]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setFrost === state.frost);
  });
  document.querySelectorAll("[data-set-glow]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setGlow === state.glow);
  });

  if (els.customAccentInput) {
    els.customAccentInput.value = state.customColor;
  }
  if (els.customAccentHex) {
    els.customAccentHex.textContent = `${state.customColor.toUpperCase()} · 点击调色板实时渲染光场`;
  }
  if (els.prefCompactToggle) {
    els.prefCompactToggle.checked = Boolean(state.compact);
    els.prefCompactToggle.disabled = state.layout !== "sidebar";
  }
}

function renderSettings() {
  document.querySelectorAll("[data-set-default-auth]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setDefaultAuth === state.defaultAuth);
  });
  document.querySelectorAll("[data-set-viewport]").forEach((el) => {
    el.classList.toggle("active", el.dataset.setViewport === state.viewport);
  });
  if (els.settingsLiveToggle) {
    els.settingsLiveToggle.checked = Boolean(state.liveRefresh);
  }
  if (els.settingsBookmarkBarToggle) {
    els.settingsBookmarkBarToggle.checked = Boolean(state.showBookmarkBar);
  }
  if (els.subnavBtnBookmarks) {
    els.subnavBtnBookmarks.setAttribute("aria-pressed", state.showBookmarkBar ? "true" : "false");
  }
  if (els.setNativeUiPath) {
    els.setNativeUiPath.textContent = state.nativeUiConfigPath || "~/.config/gador/native-ui.json";
  }

  els.settingsConnPill.textContent = state.connected ? "在线" : "离线";
  els.settingsConnPill.className = `status-pill ${state.connected ? "ok" : "danger"}`;

  const caps = state.capabilities;
  els.setEngineVer.textContent = caps ? `Gador Engine ${caps.chromiumVersion}` : "—";
  els.setRuntimeMode.textContent = caps
    ? caps.runtimeMode === "daemon"
      ? "daemon（无窗口后台守护）"
      : "desktop（桌面模式）"
    : "—";
  els.setWindowDefault.textContent = caps
    ? caps.windowShownByDefault
      ? "true"
      : "false（默认零弹窗）"
    : "—";
  els.setProtoVer.textContent = caps?.protocolVersion || "—";

  els.setFeatureTags.innerHTML = "";
  for (const feat of caps?.features || []) {
    const tag = document.createElement("span");
    tag.className = "feature-tag";
    tag.textContent = feat;
    els.setFeatureTags.append(tag);
  }
}

function renderSheets() {
  els.sheetNetwork.classList.toggle("hidden", state.activeSheet !== "network");
  els.sheetActivity.classList.toggle("hidden", state.activeSheet !== "activity");
  const allOsDisabled = state.routes.length === 0 || state.routes.every((r) => r.osProxyDisabled);
  els.osProxyChip.textContent = allOsDisabled ? "系统代理已隔离" : "检测到系统代理";
  els.osProxyChip.classList.toggle("warn", !allOsDisabled);
  renderRouteItemsInto(els.routeList, false);
}

function renderEvents() {
  for (const listEl of [els.eventLog, els.aiEventLog]) {
    if (!listEl) continue;
    listEl.innerHTML = "";
    if (state.events.length === 0) {
      const li = document.createElement("li");
      li.className = "card-desc";
      li.textContent = "等待内核实时事件…";
      listEl.append(li);
      continue;
    }
    for (const item of state.events) {
      const li = document.createElement("li");
      li.className = "event";
      li.style.setProperty("--el", item.color);
      li.innerHTML = `
        <span class="event-light" aria-hidden="true"></span>
        <span class="event-name"></span>
        <span class="event-time"></span>
        <span class="event-detail"></span>
      `;
      li.querySelector(".event-name").textContent = item.name;
      li.querySelector(".event-time").textContent = item.time;
      li.querySelector(".event-detail").textContent = item.detail;
      listEl.append(li);
    }
  }
}

function renderAll() {
  renderRootAtmosphere();
  renderSidebar();
  renderStage();
  if (state.activeView === "overview") renderOverview();
  if (state.activeView === "ai") renderAiHub();
  if (state.activeView === "vpn") renderVpnHub();
  if (state.activeView === "personalization") renderPersonalization();
  if (state.activeView === "settings") renderSettings();
  renderSheets();
  renderEvents();
  syncBusyVisuals();
}

// ------------------------------------------------------------ Core Actions

async function refreshState() {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "无法连接内核");
    state.connected = true;
    state.socketPath = data.socketPath || "";
    state.capabilities = data.capabilities;
    state.spaces = data.spaces || [];
    state.pages = data.pages || [];
    state.routes = data.routes || [];

    if (state.selectedSpaceId && !state.spaces.some((s) => s.spaceId === state.selectedSpaceId)) {
      state.selectedSpaceId = null;
    }
    if (!state.selectedSpaceId && state.spaces.length > 0) {
      state.selectedSpaceId = state.spaces[0].spaceId;
    }
    const spacePages = state.pages.filter((p) => p.spaceId === state.selectedSpaceId);
    if (state.selectedPageId && !spacePages.some((p) => p.pageId === state.selectedPageId)) {
      state.selectedPageId = spacePages[0]?.pageId || null;
    }
    if (!state.selectedPageId && spacePages.length > 0) {
      state.selectedPageId = spacePages[0].pageId;
    }

    renderAll();
    if (state.activeView === "page" && state.selectedPageId && !state.frameCache.has(state.selectedPageId)) {
      captureFrame({ silent: true });
    }
  } catch (err) {
    state.connected = false;
    renderAll();
    pushEvent("ui.offline", { message: err.message });
  }
}

async function createSpace(authMode) {
  try {
    const count = state.spaces.filter((s) => s.authMode === authMode).length + 1;
    const label = authMode === "private" ? `私密空间 ${count}` : `共享空间 ${count}`;
    const sp = await rpc("space.create", { name: label, authMode, viewport: parseViewportPref() });
    state.selectedSpaceId = sp.spaceId;
    state.selectedPageId = null;
    const scopeVal = authMode === "private" ? `space:${sp.spaceId}` : "browser";
    els.vpnScope.value = scopeVal;
    els.vpnHubScope.value = scopeVal;
    await refreshState();
    toast(`已创建${authMode === "private" ? "私密 OTR " : "共享登录"}空间：${sp.name}`, "ok");
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function closeCurrentSpace() {
  const sp = getSelectedSpace();
  if (!sp) return;
  try {
    await rpc("space.close", { spaceId: sp.spaceId });
    for (const p of state.pages.filter((x) => x.spaceId === sp.spaceId)) {
      state.frameCache.delete(p.pageId);
      state.openDialogs.delete(p.pageId);
    }
    state.selectedSpaceId = null;
    state.selectedPageId = null;
    await refreshState();
    toast(`已关闭空间 ${sp.name}`, "ok");
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

function selectSpace(spaceId) {
  state.selectedSpaceId = spaceId;
  const sp = getSelectedSpace();
  if (sp) {
    const scopeVal = sp.authMode === "private" ? `space:${sp.spaceId}` : "browser";
    els.vpnScope.value = scopeVal;
    els.vpnHubScope.value = scopeVal;
  }
  const firstPage = state.pages.find((p) => p.spaceId === spaceId);
  state.selectedPageId = firstPage ? firstPage.pageId : null;
  renderAll();
  if (state.activeView === "page" && state.selectedPageId) {
    captureFrame({ silent: true });
  }
}

function selectPage(pageId) {
  const pg = state.pages.find((p) => p.pageId === pageId);
  if (!pg) return;
  state.spaceMode = "ai";
  state.selectedSpaceId = pg.spaceId;
  state.selectedPageId = pg.pageId;
  state.activeView = "page";
  renderAll();
  captureFrame({ silent: true });
}

async function openUrlInCurrentSpace(rawUrl) {
  const url = normalizeUserUrl(rawUrl);
  try {
    const vp = parseViewportPref();
    if (!state.selectedSpaceId) {
      const sp = await rpc("space.create", {
        name: state.defaultAuth === "private" ? "私密空间 1" : "共享空间 1",
        authMode: state.defaultAuth,
        viewport: vp,
      });
      state.selectedSpaceId = sp.spaceId;
    }
    const pg = await rpc("page.open", { spaceId: state.selectedSpaceId, url, viewport: vp });
    state.selectedPageId = pg.pageId;
    state.activeView = "page";
    await refreshState();
    setTimeout(() => captureFrame({ silent: true }), 650);
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function closePage(pageId) {
  try {
    await rpc("page.close", { pageId });
    state.frameCache.delete(pageId);
    state.openDialogs.delete(pageId);
    if (state.selectedPageId === pageId) {
      state.selectedPageId = null;
    }
    await refreshState();
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function capturePageFrame(pageId, { silent = false } = {}) {
  if (!pageId || !state.connected) return;
  const pg = state.pages.find((p) => p.pageId === pageId);
  const sp = pg ? state.spaces.find((s) => s.spaceId === pg.spaceId) : null;
  if (sp?.controlState === "USER_ACTIVE") {
    if (!silent) toast("该空间处于人工接管中，内核已冻结截屏", "warm");
    return;
  }
  try {
    const shot = await rpc("cdp.send", {
      pageId,
      cdpMethod: "Page.captureScreenshot",
      cdpParams: { format: "png" },
    });
    if (shot && shot.data) {
      const src = `data:image/png;base64,${shot.data}`;
      state.frameCache.set(pageId, { src, ts: formatTime() });
      renderAll();
    }
  } catch (err) {
    if (!silent) toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function refreshAllOverviewThumbs() {
  const space = getSelectedSpace();
  const targets =
    state.overviewScope === "all"
      ? state.pages
      : space
        ? state.pages.filter((p) => p.spaceId === space.spaceId)
        : [];
  for (const pg of targets) {
    await capturePageFrame(pg.pageId, { silent: true });
  }
  toast(`已刷新 ${targets.length} 个页面预览`, "ok");
}

let lastSyncedViewportKey = "";

async function syncAiPageViewportToWindow(pageId) {
  if (!pageId || !state.connected || state.shellMode !== "embedded") return;
  const w = Math.max(320, Math.round(window.innerWidth));
  const h = Math.max(240, Math.round(window.innerHeight));
  const key = `${pageId}:${w}x${h}`;
  if (key === lastSyncedViewportKey) return;
  lastSyncedViewportKey = key;
  try {
    await rpc("cdp.send", {
      pageId,
      cdpMethod: "Emulation.setDeviceMetricsOverride",
      cdpParams: {
        width: w,
        height: h,
        deviceScaleFactor: window.devicePixelRatio || 1,
        mobile: false,
      },
    });
  } catch {
    // non-fatal if page is under USER_ACTIVE or detached
  }
}

async function captureFrame({ silent = false } = {}) {
  const pageId = state.selectedPageId;
  if (!pageId || !state.connected || state.capturing) return;
  const space = getSelectedSpace();
  if (space?.controlState === "USER_ACTIVE") {
    if (!silent) toast("当前处于人工接管中，暂停 CDP 截帧", "warm");
    return;
  }

  state.capturing = true;
  const isFirst = !state.frameCache.has(pageId);
  if (isFirst) {
    els.viewport.dataset.loading = "true";
  }

  try {
    await syncAiPageViewportToWindow(pageId);
    const shot = await rpc("cdp.send", {
      pageId,
      cdpMethod: "Page.captureScreenshot",
      cdpParams: { format: "png" },
    });
    if (shot && shot.data) {
      const src = `data:image/png;base64,${shot.data}`;
      state.frameCache.set(pageId, { src, ts: formatTime() });
      if (state.selectedPageId === pageId) {
        els.frame.src = src;
        if (isFirst) {
          els.frame.classList.remove("developing");
          void els.frame.offsetWidth;
          els.frame.classList.add("developing");
        }
        renderStage();
      }
    } else if (!silent) {
      els.frameNote.textContent = "当前后端未返回图像数据（纯协议守护模式）";
      els.frameNote.classList.remove("hidden");
    }
  } catch (err) {
    if (!silent) {
      toast(`${err.code || "ERR"}: ${err.message}`);
    } else if (isFirst && state.selectedPageId === pageId) {
      els.frameNote.textContent = `暂无法抓取画面：${err.message}`;
      els.frameNote.classList.remove("hidden");
    }
  } finally {
    state.capturing = false;
    els.viewport.dataset.loading = "false";
  }
}

async function toggleTakeover() {
  const sp = getSelectedSpace();
  if (!sp) return;
  try {
    if (sp.controlState === "USER_ACTIVE") {
      await rpc("takeover.release", { spaceId: sp.spaceId });
      toast("已将控制权交回 AI", "ok");
    } else {
      await rpc("takeover.request", {
        spaceId: sp.spaceId,
        pageId: state.selectedPageId || undefined,
        reason: "user_console_takeover",
      });
      toast("已进入人工接管，AI 写入与截屏已冻结", "warm");
    }
    await refreshState();
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function collapseCurrentPage() {
  const pg = getSelectedPage();
  if (!pg) return;
  try {
    await rpc("page.detachView", { pageId: pg.pageId });
    state.frameCache.delete(pg.pageId);
    state.selectedPageId = null;
    await refreshState();
    toast("已收起到后台静默执行", "ok");
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function respondDialog(accept) {
  const pg = getSelectedPage();
  if (!pg || !state.openDialogs.has(pg.pageId)) return;
  try {
    const dialog = state.openDialogs.get(pg.pageId);
    await rpc("dialog.handle", {
      pageId: pg.pageId,
      accept,
      promptText: dialog.type === "prompt" ? els.dialogInput.value : undefined,
    });
    state.openDialogs.delete(pg.pageId);
    await refreshState();
    setTimeout(() => captureFrame({ silent: true }), 300);
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

async function applyTunnelForm({ scope, mode, endpoint, dohServer, failClosed }) {
  try {
    await rpc("network.setTunnel", {
      scope: scope || "browser",
      mode,
      endpoint: endpoint || undefined,
      dohServer: dohServer || undefined,
      failClosed,
    });
    await refreshState();
    toast("独立出口策略已热更新", "ok");
  } catch (err) {
    toast(`${err.code || "ERR"}: ${err.message}`);
  }
}

// ------------------------------------------------------------ Floating URL

function openUrlbar(prefill = "") {
  const isAi = state.spaceMode === "ai" || state.activeView === "ai";
  els.urlbarTarget.textContent = isAi
    ? "在「AI 运行空间」中打开"
    : "在「日常空间」原生窗口打开（Shift+Enter 发往 AI 空间）";
  els.urlbar.classList.remove("hidden");
  els.urlbarInput.value = prefill;
  state.suggestionIndex = -1;
  renderSuggestions("");
  requestAnimationFrame(() => {
    els.urlbarInput.focus();
    els.urlbarInput.select();
  });
}

function closeUrlbar() {
  els.urlbar.classList.add("hidden");
}

function renderSuggestions(query) {
  const q = query.trim().toLowerCase();
  const matches = state.pages
    .filter((p) => !q || p.url.toLowerCase().includes(q) || p.pageId.toLowerCase().includes(q))
    .slice(0, 6);

  state.filteredSuggestions = matches;
  if (state.suggestionIndex >= matches.length) state.suggestionIndex = -1;

  els.suggestions.innerHTML = "";
  matches.forEach((pg, idx) => {
    const sp = state.spaces.find((s) => s.spaceId === pg.spaceId);
    const { host, initial } = parseUrlParts(pg.url);
    const li = document.createElement("li");
    li.className = "suggestion";
    li.role = "option";
    li.setAttribute("aria-selected", idx === state.suggestionIndex ? "true" : "false");

    const fav = document.createElement("span");
    fav.className = "favicon";
    fav.style.setProperty("--fav", hueColor(host));
    fav.textContent = initial;

    const urlSpan = document.createElement("span");
    urlSpan.className = "s-url";
    urlSpan.textContent = pg.url;

    const spSpan = document.createElement("span");
    spSpan.className = "s-space";
    if (sp?.authMode === "private") {
      spSpan.style.setProperty("--s-tone", "var(--light-private-1)");
    }
    spSpan.textContent = sp ? `${sp.name} · ${sp.authMode}` : pg.spaceId;

    li.append(fav, urlSpan, spSpan);
    li.onclick = () => {
      closeUrlbar();
      selectPage(pg.pageId);
    };
    els.suggestions.append(li);
  });
}

// ------------------------------------------------------------ Event Stream

function eventColor(name) {
  if (name.startsWith("dialog") || name.startsWith("takeover")) return "var(--light-warm)";
  if (name.startsWith("network")) return "var(--light-ok)";
  if (name.includes("error") || name.includes("offline")) return "var(--light-danger)";
  return "var(--l2)";
}

function pushEvent(name, params) {
  state.events.unshift({
    name,
    time: formatTime(),
    detail: JSON.stringify(params || {}),
    color: eventColor(name),
  });
  if (state.events.length > 80) state.events.pop();
  if (state.activeView !== "ai") {
    els.activityDot?.classList.add("on");
    els.chromeActivityDot?.classList.add("on");
  }
  renderEvents();
}

function toggleLayout(targetLayout) {
  state.layout = targetLayout || (state.layout === "sidebar" ? "chrome" : "sidebar");
  savePrefs();
  renderAll();
  syncNativeAppearance({ layout: state.layout });
  toast(
    state.layout === "chrome"
      ? "已切换原生浏览器为顶部横向标签栏"
      : "已切换原生浏览器为竖向侧边栏",
    "ok"
  );
}

// ------------------------------------------------------------ Wire Events

// Primary Navigation buttons (Settings gear opens Settings Hub defaulting to Personalization, or closes back to page)
document.querySelectorAll("[data-nav-view]").forEach((btn) => {
  btn.onclick = () => {
    const view = btn.dataset.navView;
    const isGear = btn.id === "nav-settings" || btn.id === "chrome-nav-settings";
    const inSettingsGroup = ["personalization", "ai", "vpn", "settings"].includes(state.activeView);
    runQuickBusy(`nav:${view}`, btn, () => {
      if (isGear && inSettingsGroup) {
        setView("page");
      } else if (state.activeView === view && !btn.classList.contains("jump-card") && !btn.classList.contains("subnav-tab")) {
        setView("page");
      } else {
        setView(view);
      }
    });
  };
});

document.querySelectorAll("[data-back-page]").forEach((btn) => {
  btn.onclick = () => runQuickBusy("nav:page", btn, () => setView("page"));
});

els.btnOpenOverviewBar.onclick = () =>
  runQuickBusy("nav:overview", els.btnOpenOverviewBar, () => setView("overview"));

els.emptyBtnNew.onclick = () => openUrlbar("");
els.emptyBtnPersonal.onclick = () => runQuickBusy("nav:personalization", els.emptyBtnPersonal, () => setView("personalization"));
els.emptyBtnVpn.onclick = () => runQuickBusy("nav:vpn", els.emptyBtnVpn, () => setView("vpn"));
els.emptyBtnAi.onclick = () => runQuickBusy("nav:ai", els.emptyBtnAi, () => setView("ai"));

// Refresh & Layout & Compact
const onRefreshClick = () =>
  runBusy("refresh", [els.btnRefresh, els.chromeBtnRefresh, els.settingsBtnRefresh, els.vpnBtnRefresh], () => refreshState());
els.btnRefresh.onclick = onRefreshClick;
els.chromeBtnRefresh.onclick = onRefreshClick;
els.settingsBtnRefresh.onclick = onRefreshClick;
els.vpnBtnRefresh.onclick = onRefreshClick;

const onLayoutClick = () =>
  runQuickBusy("layout", [els.btnLayoutSidebar, els.btnLayoutChrome], () => toggleLayout());
els.btnLayoutSidebar.onclick = onLayoutClick;
els.btnLayoutChrome.onclick = onLayoutClick;

els.btnCompact.onclick = () =>
  runQuickBusy("compact", els.btnCompact, () => {
    state.compact = !state.compact;
    savePrefs();
    renderAll();
  });

const openCurrentUrlbar = () => {
  const pg = getSelectedPage();
  openUrlbar(pg && pg.url !== "about:blank" ? pg.url : "");
};
els.urlTrigger.onclick = openCurrentUrlbar;
els.chromeOmnibox.onclick = openCurrentUrlbar;
els.btnNewTab.onclick = () => openUrlbar("");
els.chromeBtnNewTab.onclick = () => openUrlbar("");
els.btnOvNewPage.onclick = () => openUrlbar("");

// Space Switcher (Normal Non-AI vs AI-Running) & Incognito Window beside Settings
document.querySelectorAll("[data-set-space-mode]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy(`space-mode:${btn.dataset.setSpaceMode}`, btn, () =>
      setSpaceMode(btn.dataset.setSpaceMode)
    );
});

const onOpenIncognito = () =>
  runBusy("open-incognito", [els.btnIncognito, els.chromeBtnIncognito, els.subnavBtnIncognito].filter(Boolean), () =>
    openNativeWindow("about:blank", { incognito: true })
  );
if (els.btnIncognito) els.btnIncognito.onclick = onOpenIncognito;
if (els.chromeBtnIncognito) els.chromeBtnIncognito.onclick = onOpenIncognito;
if (els.subnavBtnIncognito) els.subnavBtnIncognito.onclick = onOpenIncognito;
if (els.subnavAiSpace) {
  els.subnavAiSpace.onclick = () => {
    state.spaceMode = "ai";
    setView("page");
  };
}

// Spaces creation / closing (kept inside AI Hub for power users)
const onCreateShared = () =>
  runBusy("create-shared", [els.aiBtnCreateShared].filter(Boolean), () => createSpace("shared"));
const onCreatePrivate = () =>
  runBusy("create-private", [els.aiBtnCreatePrivate].filter(Boolean), () => createSpace("private"));
const onCloseSpace = () =>
  runBusy("close-space", [els.btnCloseSpace, els.chromeBtnCloseSpace].filter(Boolean), () => closeCurrentSpace());

if (els.aiBtnCreateShared) els.aiBtnCreateShared.onclick = onCreateShared;
if (els.aiBtnCreatePrivate) els.aiBtnCreatePrivate.onclick = onCreatePrivate;
if (els.btnCloseSpace) els.btnCloseSpace.onclick = onCloseSpace;
if (els.chromeBtnCloseSpace) els.chromeBtnCloseSpace.onclick = onCloseSpace;

// Overview actions
els.ovScopeCurrent.onclick = () =>
  runQuickBusy("ov-scope", [els.ovScopeCurrent, els.ovScopeAll], () => {
    state.overviewScope = "current";
    renderOverview();
  });
els.ovScopeAll.onclick = () =>
  runQuickBusy("ov-scope", [els.ovScopeCurrent, els.ovScopeAll], () => {
    state.overviewScope = "all";
    renderOverview();
  });
els.btnOvRefreshThumbs.onclick = () =>
  runBusy("ov-refresh-thumbs", els.btnOvRefreshThumbs, () => refreshAllOverviewThumbs());

// AI Hub actions
els.aiBtnTakeover.onclick = () =>
  runBusy("takeover", [els.btnTakeover, els.aiBtnTakeover], () => toggleTakeover());
els.aiBtnClearEvents.onclick = () =>
  runQuickBusy("clear-events", [els.btnClearEvents, els.aiBtnClearEvents], () => {
    state.events = [];
    renderEvents();
  });
document.querySelectorAll("[data-copy-cmd]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy(`copy:${btn.dataset.copyCmd}`, btn, () => copyText(btn.dataset.copyCmd, "已复制命令"));
});
els.btnCopySocket.onclick = () =>
  runQuickBusy("copy-sock", els.btnCopySocket, () =>
    copyText(state.socketPath || "$XDG_RUNTIME_DIR/gador/ctl.sock", "已复制 Socket 路径")
  );
els.btnCopySkillMd.onclick = () =>
  runQuickBusy("copy-skill-md", els.btnCopySkillMd, () =>
    copyText(state.skillInfo?.skillContent || "", "已复制 SKILL.md 全文")
  );
els.btnCopyMcpJson.onclick = () =>
  runQuickBusy("copy-mcp-json", els.btnCopyMcpJson, () =>
    copyText(state.skillInfo?.mcpConfigJson || "", "已复制 MCP 配置 JSON")
  );
els.btnToggleSkillPreview.onclick = () =>
  runQuickBusy("toggle-skill-preview", els.btnToggleSkillPreview, () => {
    els.aiSkillPreview?.classList.toggle("hidden");
  });
els.btnOpenNativeTab.onclick = () => {
  const pg = getSelectedPage();
  if (!pg) return;
  runBusy("open-native", els.btnOpenNativeTab, () => openNativeWindow(pg.url, { recordUserTab: false }));
};

// VPN Hub actions
els.vpnHubForm.onsubmit = async (e) => {
  e.preventDefault();
  await runBusy("vpn-apply", [els.vpnHubSubmit, els.vpnSubmit], () =>
    applyTunnelForm({
      scope: els.vpnHubScope.value.trim() || "browser",
      mode: els.vpnHubForm.querySelector('input[name="vpn-hub-mode"]:checked')?.value || "strict_tunnel",
      endpoint: els.vpnHubEndpoint.value.trim(),
      dohServer: els.vpnHubDoh.value.trim(),
      failClosed: els.vpnHubFailClosed.checked,
    })
  );
};
els.vpnBtnQuickDirect.onclick = () =>
  runBusy("vpn-direct", els.vpnBtnQuickDirect, () =>
    applyTunnelForm({ scope: "browser", mode: "direct_only", failClosed: false })
  );
if (els.vpnBtnSaveProfile) {
  els.vpnBtnSaveProfile.onclick = () =>
    runBusy("vpn-save-profile", els.vpnBtnSaveProfile, () => saveCurrentVpnProfile());
}
if (els.vpnBtnManualBackup) {
  els.vpnBtnManualBackup.onclick = () =>
    runBusy("vpn-manual-backup", els.vpnBtnManualBackup, () => createManualVpnBackup());
}
if (els.vpnBtnClearBackups) {
  els.vpnBtnClearBackups.onclick = () =>
    runBusy("vpn-clear-backups", els.vpnBtnClearBackups, () => clearAllVpnBackupsFromUi());
}

// Personalization actions (live-synced directly into native Chromium 158 ThemeService & VerticalTabs!)
document.querySelectorAll("[data-set-theme]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-theme", btn, () => {
      state.theme = btn.dataset.setTheme;
      savePrefs();
      renderAll();
      syncNativeAppearance({ theme: state.theme });
      toast(`已同步原生外观：${THEME_LABELS[state.theme]}`, "ok");
    });
});
document.querySelectorAll("[data-set-accent]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-accent", btn, () => {
      state.accent = btn.dataset.setAccent;
      savePrefs();
      renderAll();
      syncNativeAppearance();
      toast(`已同步原生光效色系：${ACCENT_LABELS[state.accent]}`, "ok");
    });
});
els.customAccentInput.oninput = () => {
  state.customColor = els.customAccentInput.value;
  state.accent = "custom";
  savePrefs();
  renderRootAtmosphere();
  renderPersonalization();
};
els.btnApplyCustomColor.onclick = () =>
  runQuickBusy("pref-custom-color", els.btnApplyCustomColor, () => {
    state.customColor = els.customAccentInput.value;
    state.accent = "custom";
    savePrefs();
    renderAll();
    syncNativeAppearance({ accentColor: state.customColor });
    toast(`已同步原生自定义光效色 ${state.customColor.toUpperCase()}`, "ok");
  });
document.querySelectorAll("[data-set-layout]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-layout", btn, () => toggleLayout(btn.dataset.setLayout));
});
els.prefCompactToggle.onchange = () => {
  state.compact = els.prefCompactToggle.checked;
  savePrefs();
  renderAll();
  syncNativeAppearance({ compact: state.compact });
};
document.querySelectorAll("[data-set-frost]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-frost", btn, () => {
      state.frost = btn.dataset.setFrost;
      savePrefs();
      renderAll();
    });
});
document.querySelectorAll("[data-set-glow]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-glow", btn, () => {
      state.glow = btn.dataset.setGlow;
      savePrefs();
      renderAll();
      syncNativeAppearance();
    });
});
els.btnResetPersonal.onclick = () =>
  runQuickBusy("pref-reset", els.btnResetPersonal, () => {
    state.theme = "system";
    state.accent = "adaptive";
    state.customColor = "#38bdf8";
    state.layout = "chrome";
    state.compact = false;
    state.frost = "off";
    state.glow = "standard";
    savePrefs();
    renderAll();
    syncNativeAppearance({ resetDefaults: true });
    toast("已恢复原生默认光效配置", "ok");
  });

// Bookmarks bar toggle & Initialization / Reset presets
if (els.settingsBookmarkBarToggle) {
  els.settingsBookmarkBarToggle.onchange = () => {
    state.showBookmarkBar = els.settingsBookmarkBarToggle.checked;
    syncNativeAppearance({ showBookmarkBar: state.showBookmarkBar });
    toast(state.showBookmarkBar ? "已显示原生书签栏" : "已隐藏原生书签栏", "ok");
  };
}
if (els.btnInitZenPreset) {
  els.btnInitZenPreset.onclick = () =>
    runBusy("init-zen", els.btnInitZenPreset, async () => {
      state.layout = "sidebar";
      state.compact = false;
      state.showBookmarkBar = true;
      state.frost = "off";
      savePrefs();
      renderAll();
      await syncNativeAppearance({ layout: "sidebar", compact: false, showBookmarkBar: true });
      toast("已初始化为 Zen 原生竖向侧边栏 + 书签栏", "ok");
    });
}
if (els.btnInitChromePreset) {
  els.btnInitChromePreset.onclick = () =>
    runBusy("init-chrome", els.btnInitChromePreset, async () => {
      state.layout = "chrome";
      state.compact = false;
      state.showBookmarkBar = true;
      state.frost = "off";
      savePrefs();
      renderAll();
      await syncNativeAppearance({ layout: "chrome", compact: false, showBookmarkBar: true });
      toast("已初始化为 Chrome 原生顶部标签栏 + 书签栏", "ok");
    });
}
if (els.btnResetAllInit) {
  els.btnResetAllInit.onclick = () =>
    runBusy("init-reset", els.btnResetAllInit, async () => {
      state.theme = "system";
      state.accent = "adaptive";
      state.customColor = "#38bdf8";
      state.layout = "chrome";
      state.compact = false;
      state.frost = "off";
      state.glow = "standard";
      state.showBookmarkBar = true;
      savePrefs();
      renderAll();
      await syncNativeAppearance({ resetDefaults: true });
      toast("已恢复 Gador 全部初始化默认设置", "ok");
    });
}

// Settings actions
document.querySelectorAll("[data-set-default-auth]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-def-auth", btn, () => {
      state.defaultAuth = btn.dataset.setDefaultAuth;
      savePrefs();
      renderAll();
    });
});
document.querySelectorAll("[data-set-viewport]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("pref-viewport", btn, () => {
      state.viewport = btn.dataset.setViewport;
      savePrefs();
      renderAll();
    });
});
if (els.settingsLiveToggle) {
  els.settingsLiveToggle.onchange = () => {
    state.liveRefresh = els.settingsLiveToggle.checked;
    savePrefs();
    renderAll();
  };
}

// Human-only native browser launchers (Google Account, Sync, Passwords, Payments, Extensions, etc.)
document.querySelectorAll("[data-open-native]").forEach((btn) => {
  btn.onclick = () => {
    const targetUrl = btn.dataset.openNative;
    runBusy(`native:${targetUrl}`, btn, async () => {
      try {
        const res = await fetch("/api/user/open-native", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "无法打开原生窗口");
        toast(`已在原生 Gador 窗口打开：${targetUrl}`, "ok");
      } catch (err) {
        toast(`打开失败：${err.message}`);
      }
    });
  };
});

// Page control capsule & Dialogs
els.btnCapture.onclick = () => runBusy("capture", els.btnCapture, () => captureFrame({ silent: false }));
els.btnLive.onclick = () =>
  runQuickBusy("live-toggle", els.btnLive, () => {
    state.liveRefresh = !state.liveRefresh;
    savePrefs();
    renderAll();
    if (state.liveRefresh) captureFrame({ silent: true });
  });
const onStopAiClick = () => {
  const sp = getSelectedSpace();
  if (!sp) return;
  const shouldStop = sp.controlState !== "USER_ACTIVE";
  runBusy(`stop-ai:${sp.spaceId}`, [els.btnStopAi, els.btnStopAiBar, els.btnTakeover, els.aiBtnTakeover], () =>
    stopOrResumeSpace(sp.spaceId, state.selectedPageId, shouldStop)
  );
};
if (els.btnStopAi) els.btnStopAi.onclick = onStopAiClick;
if (els.btnStopAiBar) els.btnStopAiBar.onclick = onStopAiClick;

els.btnTakeover.onclick = () =>
  runBusy("takeover", [els.btnTakeover, els.aiBtnTakeover, els.btnStopAi, els.btnStopAiBar], () => toggleTakeover());
els.btnCollapse.onclick = () => runBusy("collapse", els.btnCollapse, () => collapseCurrentPage());
if (els.btnCapsuleBack) {
  els.btnCapsuleBack.onclick = () =>
    runBusy("cap-back", els.btnCapsuleBack, async () => {
      const pg = getSelectedPage();
      if (!pg) return;
      try {
        await rpc("cdp.send", {
          pageId: pg.pageId,
          cdpMethod: "Runtime.evaluate",
          cdpParams: { expression: "history.back(); true", returnByValue: true },
        });
        setTimeout(() => captureFrame({ silent: true }), 450);
      } catch (err) {
        toast(`${err.code || "ERR"}: ${err.message}`);
      }
    });
}
if (els.subnavBtnBack) {
  els.subnavBtnBack.onclick = () => {
    if (history.length > 1) {
      history.back();
    } else if (state.activeView !== "settings") {
      setView("settings");
    }
  };
}
if (els.subnavBtnForward) {
  els.subnavBtnForward.onclick = () => history.forward();
}
if (els.subnavBtnBookmarks) {
  els.subnavBtnBookmarks.onclick = () =>
    runQuickBusy("toggle-bm-bar", els.subnavBtnBookmarks, () => {
      state.showBookmarkBar = !state.showBookmarkBar;
      renderAll();
      syncNativeAppearance({ showBookmarkBar: state.showBookmarkBar });
      toast(state.showBookmarkBar ? "已显示原生书签栏" : "已隐藏原生书签栏", "ok");
    });
}
if (els.btnCapsuleSettings) {
  els.btnCapsuleSettings.onclick = () =>
    runQuickBusy("cap-settings", els.btnCapsuleSettings, () => setView("settings"));
}
window.addEventListener("resize", () => {
  if (state.activeView === "page" && state.spaceMode === "ai" && state.selectedPageId) {
    lastSyncedViewportKey = "";
    captureFrame({ silent: true });
  }
});

els.btnDialogAccept.onclick = () =>
  runBusy("dialog", [els.btnDialogAccept, els.btnDialogDismiss], () => respondDialog(true));
els.btnDialogDismiss.onclick = () =>
  runBusy("dialog", [els.btnDialogAccept, els.btnDialogDismiss], () => respondDialog(false));
els.dialogInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    runBusy("dialog", [els.btnDialogAccept, els.btnDialogDismiss], () => respondDialog(true));
  }
  if (e.key === "Escape") {
    runBusy("dialog", [els.btnDialogAccept, els.btnDialogDismiss], () => respondDialog(false));
  }
};

// Legacy sheets compatibility
document.querySelectorAll("[data-close-sheet]").forEach((btn) => {
  btn.onclick = () =>
    runQuickBusy("close-sheet", btn, () => {
      state.activeSheet = null;
      renderSheets();
    });
});
els.vpnForm.onsubmit = async (e) => {
  e.preventDefault();
  await runBusy("vpn-apply", [els.vpnSubmit, els.vpnHubSubmit], () =>
    applyTunnelForm({
      scope: els.vpnScope.value.trim() || "browser",
      mode: els.vpnForm.querySelector('input[name="vpn-mode"]:checked')?.value || "strict_tunnel",
      endpoint: els.vpnEndpoint.value.trim(),
      dohServer: els.vpnDoh.value.trim(),
      failClosed: els.vpnFailClosed.checked,
    })
  );
};
els.btnClearEvents.onclick = () =>
  runQuickBusy("clear-events", [els.btnClearEvents, els.aiBtnClearEvents], () => {
    state.events = [];
    renderEvents();
  });

// Floating URL bar
els.urlbar.onclick = (e) => {
  if (e.target === els.urlbar) closeUrlbar();
};
els.urlbarInput.oninput = () => renderSuggestions(els.urlbarInput.value);
let urlbarShiftSubmit = false;
els.urlbarInput.onkeydown = (e) => {
  urlbarShiftSubmit = Boolean(e.shiftKey);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (state.filteredSuggestions.length > 0) {
      state.suggestionIndex = (state.suggestionIndex + 1) % state.filteredSuggestions.length;
      renderSuggestions(els.urlbarInput.value);
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (state.filteredSuggestions.length > 0) {
      state.suggestionIndex =
        (state.suggestionIndex - 1 + state.filteredSuggestions.length) %
        state.filteredSuggestions.length;
      renderSuggestions(els.urlbarInput.value);
    }
  } else if (e.key === "Escape") {
    closeUrlbar();
  }
};
els.urlbarForm.onsubmit = async (e) => {
  e.preventDefault();
  if (state.suggestionIndex >= 0 && state.filteredSuggestions[state.suggestionIndex]) {
    const picked = state.filteredSuggestions[state.suggestionIndex];
    closeUrlbar();
    selectPage(picked.pageId);
    return;
  }
  const raw = els.urlbarInput.value.trim();
  const isAiContext = state.spaceMode === "ai" || state.activeView === "ai";
  const useAgentSpace = isAiContext ? !urlbarShiftSubmit : urlbarShiftSubmit;
  urlbarShiftSubmit = false;
  closeUrlbar();
  if (raw) {
    if (!useAgentSpace) {
      // Non-AI normal space: open directly in a real 60fps native Gador window (never Chromium, never screenshot-proxied!)
      await runBusy("open-native-url", [els.btnNewTab, els.chromeBtnNewTab, els.urlTrigger, els.chromeOmnibox], () =>
        openNativeWindow(raw, { recordUserTab: true })
      );
      return;
    }
    state.spaceMode = "ai";
    await runBusy("open-url", [els.btnNewTab, els.chromeBtnNewTab, els.urlTrigger, els.chromeOmnibox], () =>
      openUrlInCurrentSpace(raw)
    );
  }
};

// Global Keyboard Shortcuts
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "l") {
    e.preventDefault();
    openCurrentUrlbar();
  } else if (e.altKey && k === "l") {
    e.preventDefault();
    toggleLayout();
  } else if (e.altKey && k === "g") {
    e.preventDefault();
    setView(state.activeView === "overview" ? "page" : "overview");
  } else if (e.altKey && k === "a") {
    e.preventDefault();
    setView(state.activeView === "ai" ? "page" : "ai");
  } else if (e.altKey && k === "v") {
    e.preventDefault();
    setView(state.activeView === "vpn" ? "page" : "vpn");
  } else if (e.altKey && k === "p") {
    e.preventDefault();
    setView(state.activeView === "personalization" ? "page" : "personalization");
  } else if (e.altKey && k === "s") {
    e.preventDefault();
    setView(state.activeView === "settings" ? "page" : "settings");
  } else if ((e.ctrlKey || e.metaKey) && k === "b" && state.layout === "sidebar") {
    e.preventDefault();
    state.compact = !state.compact;
    savePrefs();
    renderAll();
  } else if (e.key === "Escape") {
    if (!els.urlbar.classList.contains("hidden")) {
      closeUrlbar();
    } else if (state.activeSheet) {
      state.activeSheet = null;
      renderSheets();
    } else if (state.activeView !== "page") {
      setView("page");
    }
  }
});

// Live SSE stream from gador UDS kernel
const sse = new EventSource("/api/events");
sse.onmessage = (msg) => {
  try {
    const parsed = JSON.parse(msg.data);
    pushEvent(parsed.event, parsed.params);
    if (parsed.event === "dialog.opened" && parsed.params?.pageId) {
      state.openDialogs.set(parsed.params.pageId, parsed.params);
    } else if (parsed.event === "dialog.closed" && parsed.params?.pageId) {
      state.openDialogs.delete(parsed.params.pageId);
    } else if (parsed.event === "takeover.changed" && parsed.params?.controlState === "USER_ACTIVE") {
      const reason = parsed.params?.reason || "";
      if (reason.includes("password") || reason.includes("payment") || reason.includes("credential")) {
        toast("检测到密码或支付操作，内核已强制切换至人工接管！", "warm");
      }
    } else if (parsed.event === "network.tunnelStateChanged" && parsed.params?.blockedByFailClosed) {
      toast(`Fail-Closed 已阻断 ${parsed.params.scope} 出网`, "error");
    }
    refreshState();
  } catch {
    // ignore malformed SSE chunk
  }
};

// Periodic live frame refresh when observing a running page
setInterval(() => {
  if (
    state.liveRefresh &&
    state.activeView === "page" &&
    state.connected &&
    state.selectedPageId &&
    !document.hidden &&
    els.urlbar.classList.contains("hidden")
  ) {
    captureFrame({ silent: true });
  }
}, 2400);

async function loadSkillInfo() {
  try {
    const res = await fetch("/api/skill");
    if (res.ok) {
      state.skillInfo = await res.json();
      if (state.activeView === "ai") renderAiHub();
    }
  } catch {
    // non-fatal
  }
}

function applyRouteHash() {
  const h = (location.hash || "").replace(/^#/, "").toLowerCase();
  if (h === "ai-space") {
    state.spaceMode = "ai";
    state.activeView = "page";
  } else if (["ai", "vpn", "personalization", "settings", "overview"].includes(h)) {
    state.activeView = h;
  }
}

window.addEventListener("hashchange", () => {
  applyRouteHash();
  renderAll();
});

applyRouteHash();
renderAll();
refreshState().then(() => loadNativeAppearance());
loadSkillInfo();
loadVpnStore();
