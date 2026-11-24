(() => {
  if (window.top !== window) return;
  if (document.getElementById("gador-ai-light-host")) return;

  const host = document.createElement("div");
  host.id = "gador-ai-light-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .root {
        display: none;
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: "Inter", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;
      }
      .root.visible { display: block; }

      /* Delicate optical edge aura signaling AI activity without blocking clicks */
      .rim {
        position: fixed;
        inset: 0;
        pointer-events: none;
        border-radius: 0;
        box-shadow:
          inset 0 0 0 2px rgba(125, 152, 255, 0.52),
          inset 0 0 34px 2px rgba(125, 152, 255, 0.22);
        animation: gador-rim-breathe 2.8s ease-in-out infinite;
      }
      .root[data-state="USER_ACTIVE"] .rim {
        box-shadow:
          inset 0 0 0 2px rgba(255, 181, 71, 0.55),
          inset 0 0 28px 1px rgba(255, 181, 71, 0.16);
        animation: none;
      }

      /* Floating optical status pill in bottom-right corner */
      .pill {
        position: fixed;
        right: 18px;
        bottom: 18px;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        padding: 7px 10px 7px 9px;
        border-radius: 999px;
        background: rgba(13, 17, 29, 0.86);
        color: #eef2ff;
        border: 1px solid rgba(138, 162, 255, 0.34);
        box-shadow:
          0 12px 34px -10px rgba(7, 10, 22, 0.72),
          0 0 24px -6px rgba(125, 152, 255, 0.6);
        font-size: 12px;
        line-height: 1;
        user-select: none;
      }
      .root[data-state="USER_ACTIVE"] .pill {
        border-color: rgba(255, 181, 71, 0.44);
        box-shadow:
          0 12px 34px -10px rgba(7, 10, 22, 0.72),
          0 0 20px -6px rgba(255, 181, 71, 0.5);
      }

      /* Pearlescent white-to-periwinkle-blue concentric luminous halo beacon */
      .beacon {
        --orb: #7d98ff;
        --soft: rgba(125, 152, 255, 0.38);
        --ring: rgba(138, 162, 255, 0.34);
        position: relative;
        width: 24px;
        height: 24px;
        display: inline-grid;
        place-items: center;
        flex: none;
        cursor: pointer;
      }
      .beacon::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: radial-gradient(circle, var(--soft) 0%, rgba(125, 152, 255, 0.16) 50%, transparent 76%);
        animation: gador-halo 2.6s ease-in-out infinite;
      }
      .beacon::after {
        content: "";
        position: absolute;
        inset: 2px;
        border-radius: 50%;
        border: 1px solid var(--ring);
        animation: gador-ring 2.6s ease-out infinite;
      }
      .beacon > i {
        position: relative;
        z-index: 1;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: radial-gradient(circle, #ffffff 0%, #eef3ff 34%, var(--orb) 78%, #526fff 100%);
        box-shadow: 0 0 0 1.2px rgba(255,255,255,0.75), 0 0 10px 2px rgba(125,152,255,0.75);
      }
      .root[data-state="USER_ACTIVE"] .beacon {
        --orb: #ffb547;
        --soft: rgba(255, 181, 71, 0.34);
        --ring: rgba(255, 181, 71, 0.34);
      }
      .root[data-state="USER_ACTIVE"] .beacon::before,
      .root[data-state="USER_ACTIVE"] .beacon::after {
        animation: none;
      }

      .label {
        font-weight: 600;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }

      .btn {
        border: 0;
        border-radius: 999px;
        padding: 5px 10px;
        font: 600 11.5px/1 inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      .btn:hover { filter: brightness(1.12); transform: translateY(-0.5px); }
      .btn-stop {
        background: rgba(255, 93, 115, 0.24);
        color: #ff8a9b;
        box-shadow: inset 0 0 0 1px rgba(255, 93, 115, 0.4);
      }
      .btn-resume {
        background: rgba(125, 152, 255, 0.26);
        color: #dce5ff;
        box-shadow: inset 0 0 0 1px rgba(125, 152, 255, 0.45);
      }
      .btn-ghost {
        background: rgba(255, 255, 255, 0.08);
        color: #dce3f8;
      }
      .sq {
        width: 7px;
        height: 7px;
        border-radius: 1.5px;
        background: currentColor;
        display: inline-block;
      }
      .pill.minimized .label,
      .pill.minimized .btn-view,
      .pill.minimized .btn-min {
        display: none;
      }
      .pill.minimized {
        padding: 6px;
        gap: 6px;
      }

      @keyframes gador-rim-breathe {
        0%, 100% { opacity: 0.72; }
        50% { opacity: 1; }
      }
      @keyframes gador-halo {
        0%, 100% { transform: scale(0.88); opacity: 0.75; }
        50% { transform: scale(1.18); opacity: 1; }
      }
      @keyframes gador-ring {
        0% { transform: scale(0.7); opacity: 0.85; }
        78% { transform: scale(1.3); opacity: 0.12; }
        100% { transform: scale(1.4); opacity: 0; }
      }
    </style>
    <div class="root" id="root" data-state="IDLE">
      <div class="rim" aria-hidden="true"></div>
      <div class="pill" id="pill">
        <span class="beacon" id="beacon" title="点击展开 / 收起 AI 光效胶囊"><i></i></span>
        <span class="label" id="label">AI 运行中</span>
        <button class="btn btn-stop" id="btn-stop" type="button"><span class="sq"></span>停止 AI</button>
        <button class="btn btn-ghost btn-view" id="btn-view" type="button">AI 空间</button>
        <button class="btn btn-ghost btn-min" id="btn-min" type="button" title="收起为光点">−</button>
      </div>
    </div>
  `;

  const root = shadow.getElementById("root");
  const pill = shadow.getElementById("pill");
  const beacon = shadow.getElementById("beacon");
  const label = shadow.getElementById("label");
  const btnStop = shadow.getElementById("btn-stop");
  const btnView = shadow.getElementById("btn-view");
  const btnMin = shadow.getElementById("btn-min");

  let currentState = "IDLE";

  function applyStatus(st) {
    if (!st || st.pageCount === 0 || st.state === "IDLE" || st.state === "OFFLINE") {
      currentState = "IDLE";
      root.classList.remove("visible");
      root.dataset.state = "IDLE";
      return;
    }
    currentState = st.state;
    root.dataset.state = st.state;
    root.classList.add("visible");

    if (st.state === "USER_ACTIVE") {
      label.textContent = `AI 已停止 (${st.pageCount} 页)`;
      btnStop.className = "btn btn-resume";
      btnStop.innerHTML = "▶ 恢复 AI";
    } else {
      label.textContent = `AI 正在操作 (${st.runningCount} 页)`;
      btnStop.className = "btn btn-stop";
      btnStop.innerHTML = `<span class="sq"></span>停止 AI`;
    }
  }

  btnStop.onclick = () => {
    const type = currentState === "USER_ACTIVE" ? "RESUME_AI" : "STOP_AI";
    chrome.runtime.sendMessage({ type }, (resp) => {
      if (resp?.status) applyStatus(resp.status);
    });
  };
  btnView.onclick = () => {
    chrome.runtime.sendMessage({ type: "OPEN_CONSOLE", hash: "ai" });
  };
  btnMin.onclick = () => pill.classList.add("minimized");
  beacon.onclick = () => pill.classList.toggle("minimized");

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "GADOR_AI_STATUS") {
      applyStatus(msg.status);
    }
  });

  document.documentElement.appendChild(host);
  chrome.runtime.sendMessage({ type: "GET_AI_STATUS" }, (resp) => {
    if (resp?.status) applyStatus(resp.status);
  });
})();
