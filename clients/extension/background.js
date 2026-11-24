const API_BASE = "http://127.0.0.1:43118";

let lastStatus = {
  connected: false,
  pageCount: 0,
  runningCount: 0,
  stoppedCount: 0,
  state: "IDLE", // IDLE | AGENT_RUNNING | USER_ACTIVE | OFFLINE
  spaces: [],
  pages: [],
};

function computeStatus(data) {
  const spaces = Array.isArray(data.spaces) ? data.spaces : [];
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const spaceMap = new Map(spaces.map((s) => [s.spaceId, s]));

  let runningCount = 0;
  let stoppedCount = 0;
  for (const pg of pages) {
    const sp = spaceMap.get(pg.spaceId);
    if (sp?.controlState === "USER_ACTIVE") {
      stoppedCount++;
    } else {
      runningCount++;
    }
  }

  let state = "IDLE";
  if (!data.connected) {
    state = "OFFLINE";
  } else if (runningCount > 0) {
    state = "AGENT_RUNNING";
  } else if (stoppedCount > 0) {
    state = "USER_ACTIVE";
  }

  return {
    connected: Boolean(data.connected),
    pageCount: pages.length,
    runningCount,
    stoppedCount,
    state,
    spaces,
    pages,
  };
}

function updateBadge(st) {
  if (st.runningCount > 0) {
    chrome.action.setBadgeText({ text: String(st.runningCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#6d88ff" });
  } else if (st.stoppedCount > 0) {
    chrome.action.setBadgeText({ text: "停" });
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function broadcastToTabs(st) {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      if (!tab.id || tab.url?.startsWith(API_BASE)) continue;
      chrome.tabs.sendMessage(tab.id, { type: "GADOR_AI_STATUS", status: st }).catch(() => {});
    }
  } catch {
    // ignore tab query failures
  }
}

async function pollStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const next = computeStatus(data);
    const changed =
      next.state !== lastStatus.state ||
      next.pageCount !== lastStatus.pageCount ||
      next.runningCount !== lastStatus.runningCount ||
      next.stoppedCount !== lastStatus.stoppedCount;
    lastStatus = next;
    updateBadge(next);
    if (changed) {
      await broadcastToTabs(next);
    }
  } catch {
    const offline = {
      connected: false,
      pageCount: 0,
      runningCount: 0,
      stoppedCount: 0,
      state: "OFFLINE",
      spaces: [],
      pages: [],
    };
    const changed = lastStatus.state !== offline.state || lastStatus.pageCount !== 0;
    lastStatus = offline;
    updateBadge(offline);
    if (changed) {
      await broadcastToTabs(offline);
    }
  }
  return lastStatus;
}

async function rpc(method, params) {
  const res = await fetch(`${API_BASE}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
}

async function stopAllAi() {
  const st = await pollStatus();
  for (const sp of st.spaces) {
    if (sp.controlState !== "USER_ACTIVE") {
      await rpc("takeover.request", { spaceId: sp.spaceId, reason: "user_stopped_ai" }).catch(() => {});
    }
  }
  const updated = await pollStatus();
  await broadcastToTabs(updated);
  return updated;
}

async function resumeAllAi() {
  const st = await pollStatus();
  for (const sp of st.spaces) {
    if (sp.controlState === "USER_ACTIVE") {
      await rpc("takeover.release", { spaceId: sp.spaceId }).catch(() => {});
    }
  }
  const updated = await pollStatus();
  await broadcastToTabs(updated);
  return updated;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "GET_AI_STATUS") {
    pollStatus().then((status) => sendResponse({ ok: true, status }));
    return true;
  }
  if (msg.type === "STOP_AI") {
    stopAllAi().then((status) => sendResponse({ ok: true, status }));
    return true;
  }
  if (msg.type === "RESUME_AI") {
    resumeAllAi().then((status) => sendResponse({ ok: true, status }));
    return true;
  }
  if (msg.type === "OPEN_CONSOLE") {
    const hash = String(msg.hash || "").trim();
    const fusedMap = {
      settings: "chrome://settings#gador-personalize",
      personalization: "chrome://settings#gador-personalize",
      ai: "chrome://settings#gador-ai",
      vpn: "chrome://settings#gador-vpn",
    };
    const targetUrl = fusedMap[hash] || `${API_BASE}/${hash ? `#${hash}` : ""}`;
    chrome.tabs.create({ url: targetUrl });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "OPEN_INCOGNITO") {
    chrome.windows.create({ incognito: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

const upgradedStartupTabs = new Set();

async function upgradeStartupNewTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || upgradedStartupTabs.has(tab.id)) continue;
      const url = tab.url || tab.pendingUrl || "";
      const isNewTab =
        url === "chrome://newtab/" ||
        url === "chrome://newtab" ||
        url === "chrome://new-tab-page/" ||
        url === "chrome://new-tab-page";
      const title = String(tab.title || "");
      // If the very first startup tab raced --load-extension and rendered stock Google NTP,
      // re-navigate it cleanly to chrome://newtab/ now that the override is registered.
      if (isNewTab && !title.includes("Gador")) {
        upgradedStartupTabs.add(tab.id);
        await chrome.tabs.update(tab.id, { url: "chrome://newtab/" }).catch(() => {});
      }
    }
  } catch {
    // ignore startup tab query errors
  }
}

chrome.runtime.onStartup.addListener(() => {
  upgradeStartupNewTabs();
});
chrome.runtime.onInstalled.addListener(() => {
  upgradeStartupNewTabs();
});

chrome.alarms.create("gador-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gador-poll") {
    pollStatus();
  }
});

// Fast local loop while service worker is awake
setInterval(pollStatus, 1800);
pollStatus();
upgradeStartupNewTabs();
setTimeout(upgradeStartupNewTabs, 450);
