const beacon = document.getElementById("beacon");
const statusText = document.getElementById("status-text");
const statusSub = document.getElementById("status-sub");
const btnToggle = document.getElementById("btn-toggle-ai");

let currentState = "IDLE";

function render(st) {
  currentState = st?.state || "IDLE";
  if (!st || st.pageCount === 0) {
    beacon.className = "beacon idle";
    statusText.textContent = "原生浏览 · 无 AI 干扰";
    statusSub.textContent = "当前没有运行中的 AI 任务，浏览器完全安静原生运行。";
    btnToggle.classList.add("hidden");
    return;
  }
  btnToggle.classList.remove("hidden");
  if (st.state === "USER_ACTIVE") {
    beacon.className = "beacon paused";
    statusText.textContent = `AI 已停止 (${st.pageCount} 页)`;
    statusSub.textContent = "AI 写入与截屏已冻结，你可以安全操作或随时恢复。";
    btnToggle.className = "btn-primary";
    btnToggle.textContent = "▶ 恢复 AI 运行";
  } else {
    beacon.className = "beacon";
    statusText.textContent = `AI 正在运行 (${st.runningCount} 页)`;
    statusSub.textContent = "页面边缘已亮起蓝紫同心光环，随时可一键停止。";
    btnToggle.className = "btn-danger";
    btnToggle.textContent = "■ 停止 AI 操作";
  }
}

btnToggle.onclick = () => {
  const type = currentState === "USER_ACTIVE" ? "RESUME_AI" : "STOP_AI";
  chrome.runtime.sendMessage({ type }, (resp) => {
    if (resp?.status) render(resp.status);
  });
};

document.getElementById("btn-ai-space").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: "ai" });
  window.close();
};
document.getElementById("btn-incognito").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_INCOGNITO" });
  window.close();
};
document.getElementById("btn-skill").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: "ai" });
  window.close();
};
document.getElementById("btn-vpn").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: "vpn" });
  window.close();
};
document.getElementById("btn-settings").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: "settings" });
  window.close();
};

chrome.runtime.sendMessage({ type: "GET_AI_STATUS" }, (resp) => {
  render(resp?.status);
});
