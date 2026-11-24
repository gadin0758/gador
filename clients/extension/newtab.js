const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const aiStrip = document.getElementById("ai-strip");
const aiLabel = document.getElementById("ai-label");
const btnStop = document.getElementById("btn-stop");
const engineButtons = Array.from(document.querySelectorAll("[data-engine]"));

const SEARCH_ENGINES = {
  google: { name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing: { name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  baidu: { name: "百度", url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
  duckduckgo: { name: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
};

let currentEngine = localStorage.getItem("gador.searchEngine") || "google";
if (!SEARCH_ENGINES[currentEngine]) currentEngine = "google";
let currentState = "IDLE";

function applyEngineUi(engineId) {
  if (!SEARCH_ENGINES[engineId]) return;
  currentEngine = engineId;
  for (const btn of engineButtons) {
    btn.classList.toggle("active", btn.dataset.engine === engineId);
  }
  input.placeholder = `使用 ${SEARCH_ENGINES[engineId].name} 搜索，或输入网址直接浏览…`;
}

applyEngineUi(currentEngine);

for (const btn of engineButtons) {
  btn.onclick = () => {
    const id = btn.dataset.engine;
    applyEngineUi(id);
    localStorage.setItem("gador.searchEngine", id);
    fetch("http://127.0.0.1:43118/api/search-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: id }),
    }).catch(() => {});
    input.focus();
  };
}

fetch("http://127.0.0.1:43118/api/search-engine")
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data?.engine && SEARCH_ENGINES[data.engine]) {
      applyEngineUi(data.engine);
      localStorage.setItem("gador.searchEngine", data.engine);
    }
  })
  .catch(() => {});

function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(v)) return v;
  if (v.includes(".") && !v.includes(" ")) return `https://${v}`;
  return SEARCH_ENGINES[currentEngine].url(v);
}

form.onsubmit = (e) => {
  e.preventDefault();
  const url = normalizeUrl(input.value);
  if (url) location.href = url;
};

document.getElementById("btn-incognito").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_INCOGNITO" });
};

for (const btn of document.querySelectorAll("[data-open-hash]")) {
  btn.onclick = () => {
    chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: btn.dataset.openHash });
  };
}

function renderAi(st) {
  currentState = st?.state || "IDLE";
  if (!st || st.pageCount === 0 || st.state === "IDLE" || st.state === "OFFLINE") {
    aiStrip.classList.remove("visible");
    return;
  }
  aiStrip.classList.add("visible");
  if (st.state === "USER_ACTIVE") {
    aiLabel.textContent = `AI 已停止 (${st.pageCount} 页)`;
    btnStop.textContent = "▶ 恢复 AI";
  } else {
    aiLabel.textContent = `AI 正在运行 (${st.runningCount} 页)`;
    btnStop.textContent = "■ 停止 AI";
  }
}

btnStop.onclick = () => {
  const type = currentState === "USER_ACTIVE" ? "RESUME_AI" : "STOP_AI";
  chrome.runtime.sendMessage({ type }, (resp) => {
    if (resp?.status) renderAi(resp.status);
  });
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "GADOR_AI_STATUS") renderAi(msg.status);
});

chrome.runtime.sendMessage({ type: "GET_AI_STATUS" }, (resp) => {
  if (resp?.status) renderAi(resp.status);
});
