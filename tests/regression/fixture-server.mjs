import http from "node:http";
import { fileURLToPath } from "node:url";

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body>
</html>`;
}

function createOriginAHandler(getOriginB) {
  return (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/auth/login") {
      const user = url.searchParams.get("user") || "alice";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": [
          `ba_session=${encodeURIComponent(user)}_secret; Path=/; HttpOnly; SameSite=Lax`,
          `ba_user=${encodeURIComponent(user)}; Path=/; SameSite=Lax`,
        ],
      });
      res.end(
        htmlPage(
          "Auth Login",
          `<h1>Logged in as ${user}</h1>
           <script>localStorage.setItem("ba_ls_user", ${JSON.stringify(user)});</script>`
        )
      );
      return;
    }

    if (url.pathname === "/auth/whoami") {
      const cookieHeader = req.headers.cookie || "";
      const hasSession = cookieHeader.includes("ba_session=");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          authenticated: hasSession,
          cookies: cookieHeader,
        })
      );
      return;
    }

    if (url.pathname === "/popup") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Popup Capture Fixture",
          `<button id="open-js" onclick="window.open('/popup-child?via=js', '_blank', 'width=400,height=300')">Open JS Popup</button>
           <a id="open-link" href="/popup-child?via=anchor" target="_blank">Open Blank Link</a>`
        )
      );
      return;
    }

    if (url.pathname === "/popup-child") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Popup Child", `<h1 id="popup-marker">Captured Popup</h1>`));
      return;
    }

    if (url.pathname === "/dialogs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Dialog Governance Fixture",
          `<div id="result">none</div>
           <button id="btn-alert" onclick="alert('agent-alert'); document.getElementById('result').textContent='alert-ok'">Trigger Alert</button>
           <button id="btn-confirm" onclick="document.getElementById('result').textContent='confirm:' + confirm('agent-confirm')">Trigger Confirm</button>
           <button id="btn-prompt" onclick="document.getElementById('result').textContent='prompt:' + prompt('agent-prompt', 'default')">Trigger Prompt</button>
           <button id="btn-arm-unload" onclick="window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); document.getElementById('result').textContent='unload-armed'">Arm BeforeUnload</button>`
        )
      );
      return;
    }

    if (url.pathname === "/oopif") {
      const originB = getOriginB();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "OOPIF & Shadow DOM Fixture",
          `<h1>Top Document</h1>
           <button id="top-action">Submit</button>
           <div id="shadow-host"></div>
           <iframe id="same-origin" src="/iframe-inner?kind=same" width="320" height="120"></iframe>
           <iframe id="cross-origin" src="${originB}/iframe-inner?kind=cross" width="320" height="120"></iframe>
           <script>
             const host = document.getElementById("shadow-host");
             const root = host.attachShadow({ mode: "open" });
             root.innerHTML = '<button id="shadow-btn">Submit</button>';
           </script>`
        )
      );
      return;
    }

    if (url.pathname === "/iframe-inner") {
      const kind = url.searchParams.get("kind") || "same";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          `Iframe (${kind})`,
          `<div id="status">${kind}:idle</div>
           <button id="frame-btn" onclick="document.getElementById('status').textContent='${kind}:clicked'">Submit</button>`
        )
      );
      return;
    }

    if (url.pathname === "/background-throttle") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Background Boost & Viewport Fixture",
          `<pre id="metrics"></pre>
           <script>
             let ticks = 0;
             const start = performance.now();
             const timer = setInterval(() => {
               ticks++;
               const elapsed = Math.round(performance.now() - start);
               document.getElementById("metrics").textContent = JSON.stringify({
                 ticks,
                 elapsed,
                 viewport: { width: window.innerWidth, height: window.innerHeight },
                 hidden: document.hidden
               });
               if (ticks >= 20) clearInterval(timer);
             }, 25);
           </script>`
        )
      );
      return;
    }

    if (url.pathname === "/network-probe") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          remoteAddress: req.socket.remoteAddress,
          viaProxyHeader: req.headers["x-via-tunnel"] || null,
          host: req.headers.host,
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };
}

function createOriginBHandler() {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/iframe-inner") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Cross-Origin OOPIF",
          `<div id="status">cross:idle</div>
           <button id="frame-btn" onclick="document.getElementById('status').textContent='cross:clicked'">Submit</button>`
        )
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };
}

export async function startFixtureServers() {
  let originBUrl = "";
  const serverA = http.createServer(createOriginAHandler(() => originBUrl));
  const serverB = http.createServer(createOriginBHandler());

  await new Promise((resolve) => serverA.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => serverB.listen(0, "127.0.0.1", resolve));

  const portA = serverA.address().port;
  const portB = serverB.address().port;
  // Distinct origins: 127.0.0.1:<portA> vs localhost:<portB> (forces real OOPIF in Chromium)
  const originA = `http://127.0.0.1:${portA}`;
  originBUrl = `http://localhost:${portB}`;

  return {
    originA,
    originB: originBUrl,
    async close() {
      await Promise.all([
        new Promise((r) => serverA.close(r)),
        new Promise((r) => serverB.close(r)),
      ]);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const servers = await startFixtureServers();
  console.log(`Fixture Origin A: ${servers.originA}`);
  console.log(`Fixture Origin B (OOPIF): ${servers.originB}`);
  console.log("Press Ctrl+C to stop.");
}
