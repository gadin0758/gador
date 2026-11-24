import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentKernelClient,
  encodeFrame,
  FrameDecoder,
} from "../../clients/protocol/index.mjs";
import { startFixtureServers } from "./fixture-server.mjs";
import { MockAgentKernelServer } from "./mock-kernel-server.mjs";

const EXTERNAL_SOCKET = process.env.AGENT_KERNEL_SOCKET || "";

test("UDS length-prefixed framing handles split & coalesced chunks", () => {
  const decoder = new FrameDecoder();
  const f1 = encodeFrame({ id: 1, method: "space.list", params: {} });
  const f2 = encodeFrame({
    id: 2,
    method: "page.open",
    params: { url: "https://example.com/测试中文" },
  });
  const combined = Buffer.concat([f1, f2]);

  const out = [];
  // Feed 3 bytes at a time to stress partial header & partial payload boundaries
  for (let i = 0; i < combined.length; i += 3) {
    out.push(...decoder.push(combined.subarray(i, i + 3)));
  }

  assert.equal(out.length, 2);
  assert.equal(out[0].id, 1);
  assert.equal(out[1].params.url, "https://example.com/测试中文");
});

test("Fixture dual-origin server serves auth, OOPIF, popup, dialog, throttle, and network probes", async () => {
  const fixtures = await startFixtureServers();
  try {
    assert.notEqual(fixtures.originA, fixtures.originB);

    const loginRes = await fetch(`${fixtures.originA}/auth/login?user=gadin`);
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie();
    assert.ok(setCookies.some((c) => c.includes("ba_session=gadin_secret") && c.includes("HttpOnly")));

    const unauth = await (await fetch(`${fixtures.originA}/auth/whoami`)).json();
    assert.equal(unauth.authenticated, false);

    const authed = await (
      await fetch(`${fixtures.originA}/auth/whoami`, {
        headers: { Cookie: "ba_session=gadin_secret" },
      })
    ).json();
    assert.equal(authed.authenticated, true);

    const oopifHtml = await (await fetch(`${fixtures.originA}/oopif`)).text();
    assert.ok(oopifHtml.includes(fixtures.originB));

    const crossFrameRes = await fetch(`${fixtures.originB}/iframe-inner?kind=cross`);
    assert.equal(crossFrameRes.status, 200);
  } finally {
    await fixtures.close();
  }
});

test("P0/P1 Kernel Contract Regression Suite (UDS 0600, Dual-Auth, 50x Hot-Mount, Active Takeover, Dialog Survival, Popup Capture, VPN Fail-Closed)", async (t) => {
  const fixtures = await startFixtureServers();
  let mockKernel = null;
  let socketPath = EXTERNAL_SOCKET;

  if (!socketPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-test-"));
    socketPath = path.join(tmpDir, "ctl.sock");
    mockKernel = new MockAgentKernelServer({ socketPath });
    mockKernel.personalCookieJar.set("ba_session", "personal_logged_in_token");
    await mockKernel.start();
  }

  const client = new AgentKernelClient({ socketPath });

  t.after(async () => {
    await client.close();
    if (mockKernel) {
      await mockKernel.stop();
      fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    }
    await fixtures.close();
  });

  await client.connect();

  await t.test("1. UDS socket permissions are strictly 0600", () => {
    const mode = fs.statSync(socketPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  await t.test("2. Self-describing capabilities advertise dual-mode auth, windowless daemon, and independent VPN", async () => {
    const caps = await client.capabilities();
    assert.equal(caps.protocolVersion, "0.1.0");
    assert.ok(["desktop", "daemon"].includes(caps.runtimeMode));
    assert.equal(typeof caps.windowShownByDefault, "boolean");
    assert.ok(caps.features.includes("windowless-daemon"));
    assert.deepEqual(caps.authModes, ["shared", "private"]);
    assert.ok(caps.networkPolicies.includes("strict_tunnel"));
  });

  await t.test("3. Dual-mode auth: shared space sees personal login; private space sees ZERO personal cookies", async () => {
    const shared = await client.createSpace({ name: "work", authMode: "shared" });
    const priv = await client.createSpace({ name: "secret", authMode: "private" });

    const pShared = await client.openPage({
      spaceId: shared.spaceId,
      url: `${fixtures.originA}/auth/login?user=gadin`,
    });
    const pPriv = await client.openPage({
      spaceId: priv.spaceId,
      url: `${fixtures.originA}/auth/whoami`,
    });

    assert.ok(pShared.viewport.width > 0 && pShared.viewport.height > 0);
    assert.equal(pShared.viewAttached, false);

    // Against a live Chromium instance with a fresh profile, wait for real
    // /auth/login Set-Cookie (or seed via real CDP Network.setCookie) on shared
    // Profile* and confirm a second shared space inherits it while private OTR sees 0.
    if (!mockKernel) {
      await client.sendCdp(pShared.pageId, "Network.setCookie", {
        name: "ba_session",
        value: "personal_logged_in_token",
        url: fixtures.originA,
        httpOnly: true,
      });
    }

    const sharedCookies = await client.sendCdp(pShared.pageId, "Network.getCookies", {
      urls: [fixtures.originA],
    });
    const privCookies = await client.sendCdp(pPriv.pageId, "Network.getCookies", {
      urls: [fixtures.originA],
    });

    assert.ok(sharedCookies.cookies.some((c) => c.name === "ba_session"));
    assert.equal(privCookies.cookies.length, 0);

    // Out-of-scope / personal target access must always be rejected
    await assert.rejects(
      () => client.sendCdp("personal_tab_999", "Runtime.evaluate", { expression: "1+1" }),
      (err) => err.code === "ERR_TARGET_OUT_OF_SCOPE"
    );

    await client.closeSpace(shared.spaceId);
    await client.closeSpace(priv.spaceId);
  });

  await t.test("4. P0 Stress: 50x hot attachView/detachView cycle (collapsed dock <-> expanded Agent space)", async () => {
    const space = await client.createSpace({ name: "hot-mount", authMode: "shared" });
    const page = await client.openPage({
      spaceId: space.spaceId,
      url: `${fixtures.originA}/background-throttle`,
    });

    for (let i = 1; i <= 50; i++) {
      const attached = await client.attachView(page.pageId, false);
      assert.equal(attached.viewAttached, true);
      assert.equal(attached.controlState, "USER_OBSERVING");
      assert.equal(attached.mountCount, i);

      const detached = await client.detachView(page.pageId);
      assert.equal(detached.viewAttached, false);
      assert.equal(detached.controlState, "AGENT_RUNNING");
    }

    await client.closeSpace(space.spaceId);
  });

  await t.test("5. Active user takeover blocks mutating Agent commands and resumes cleanly on release", async () => {
    const space = await client.createSpace({ name: "collab", authMode: "shared" });
    const page = await client.openPage({
      spaceId: space.spaceId,
      url: `${fixtures.originA}/dialogs`,
    });

    // User opens dedicated Agent view and interacts directly -> USER_ACTIVE
    const attached = await client.attachView(page.pageId, true);
    assert.equal(attached.controlState, "USER_ACTIVE");

    // Mutating Agent commands must be blocked with ERR_HUMAN_IN_CONTROL
    await assert.rejects(
      () => client.sendCdp(page.pageId, "Page.navigate", { url: `${fixtures.originA}/popup` }),
      (err) => err.code === "ERR_HUMAN_IN_CONTROL"
    );

    // Release control back to Agent
    const released = await client.releaseTakeover(space.spaceId);
    assert.equal(released.controlState, "AGENT_RUNNING");

    const nav = await client.sendCdp(page.pageId, "Page.navigate", {
      url: `${fixtures.originA}/popup`,
    });
    assert.ok(nav.frameId);

    await client.closeSpace(space.spaceId);
  });

  await t.test("6. P0 Popup capture and cross-invocation JS dialog survival without deadlock", async () => {
    const space = await client.createSpace({ name: "popups-dialogs", authMode: "shared" });
    const page = await client.openPage({
      spaceId: space.spaceId,
      url: `${fixtures.originA}/popup`,
    });

    if (mockKernel) {
      // Popup must stay inside AgentSpace
      const createdPromise = new Promise((resolve) => client.once("page.created", resolve));
      const child = mockKernel.simulateWindowOpen(page.pageId, `${fixtures.originA}/popup-child`);
      const evt = await createdPromise;
      assert.equal(evt.spaceId, space.spaceId);
      assert.equal(evt.capturedFromPopup, true);
      assert.equal(child.inPersonalTabStrip, false);

      // Open a prompt dialog, disconnect client, reconnect new client -> dialog must still be discoverable & handleable
      mockKernel.simulateDialogOpen(page.pageId, {
        type: "prompt",
        message: "agent-prompt",
        defaultPrompt: "default",
      });

      const client2 = new AgentKernelClient({ socketPath });
      const replayedDialog = new Promise((resolve) => client2.once("dialog.opened", resolve));
      await client2.connect();
      const dialogEvt = await replayedDialog;
      assert.equal(dialogEvt.pageId, page.pageId);
      assert.equal(dialogEvt.type, "prompt");
      assert.equal(dialogEvt.replayed, true);

      const handled = await client2.handleDialog(page.pageId, true, "agent-answer");
      assert.equal(handled.handled, true);
      assert.equal(handled.dialogType, "prompt");

      await client2.close();
    } else {
      // Real Chromium 158 live verification:
      // 1) Trigger real window.open() via userGesture Runtime.evaluate -> captured inside AgentSpace!
      await new Promise((r) => setTimeout(r, 400));
      const popupCreated = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Popup capture timed out")), 8000);
        const onCreated = (evt) => {
          if (evt.capturedFromPopup && evt.spaceId === space.spaceId) {
            clearTimeout(timer);
            client.off("page.created", onCreated);
            resolve(evt);
          }
        };
        client.on("page.created", onCreated);
      });
      await client.sendCdp(page.pageId, "Runtime.evaluate", {
        expression: `window.open(${JSON.stringify(`${fixtures.originA}/popup-child`)}, "_blank", "width=400,height=300")`,
        userGesture: true,
      });
      const popupEvt = await popupCreated;
      assert.equal(popupEvt.spaceId, space.spaceId);
      assert.equal(popupEvt.capturedFromPopup, true);

      // 2) Trigger real non-blocking JS prompt() -> disconnect/reconnect second client -> replayed & handled without deadlocking CDP!
      const dialogOpened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Dialog opened event timed out")), 8000);
        const onDlg = (evt) => {
          if (evt.pageId === page.pageId) {
            clearTimeout(timer);
            client.off("dialog.opened", onDlg);
            resolve(evt);
          }
        };
        client.on("dialog.opened", onDlg);
      });
      // Fire asynchronously via setTimeout so Runtime.evaluate returns cleanly while prompt opens
      await client.sendCdp(page.pageId, "Runtime.evaluate", {
        expression: `setTimeout(() => { window.__promptRes = prompt("agent-prompt", "default"); }, 20)`,
      });
      const openedEvt = await dialogOpened;
      assert.equal(openedEvt.type, "prompt");

      const client2 = new AgentKernelClient({ socketPath });
      const replayedDialog = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Dialog replay timed out")), 5000);
        client2.once("dialog.opened", (evt) => {
          clearTimeout(timer);
          resolve(evt);
        });
      });
      await client2.connect();
      const replayEvt = await replayedDialog;
      assert.equal(replayEvt.pageId, page.pageId);
      assert.equal(replayEvt.replayed, true);

      const handled = await client2.handleDialog(page.pageId, true, "real-chromium-answer");
      assert.equal(handled.handled, true);
      assert.equal(handled.dialogType, "prompt");

      // Verify JS resumed cleanly with the exact prompt text we supplied!
      await new Promise((r) => setTimeout(r, 100));
      const checkRes = await client2.sendCdp(page.pageId, "Runtime.evaluate", {
        expression: "window.__promptRes",
        returnByValue: true,
      });
      assert.equal(checkRes.result.value, "real-chromium-answer");
      await client2.close();
    }

    await client.closeSpace(space.spaceId);
  });

  await t.test("7. P1 Independent VPN interface: OS proxy disabled, WebRTC leak blocked, Fail-Closed Kill-Switch enforced", async () => {
    const tunnel = await client.setTunnel({
      scope: "browser",
      mode: "strict_tunnel",
      endpoint: "socks5://127.0.0.1:10808",
      dohServer: "https://dns.quad9.net/dns-query",
      failClosed: true,
    });
    assert.equal(tunnel.osProxyDisabled, true);
    assert.equal(tunnel.webrtcPolicy, "disable_non_proxied_udp");
    assert.equal(tunnel.failClosed, true);

    const space = await client.createSpace({ name: "vpn-check", authMode: "shared" });
    // Shared space cannot override browser tunnel to prevent dual-IP account risk
    await assert.rejects(
      () =>
        client.setTunnel({
          scope: `space:${space.spaceId}`,
          mode: "strict_tunnel",
          endpoint: "socks5://127.0.0.1:10809",
          failClosed: true,
        }),
      (err) => err.code === "ERR_INVALID_PARAMS"
    );

    // Private space CAN bind its own independent exit
    const priv = await client.createSpace({ name: "vpn-priv", authMode: "private" });
    const privTunnel = await client.setTunnel({
      scope: `space:${priv.spaceId}`,
      mode: "strict_tunnel",
      endpoint: "socks5://127.0.0.1:10809",
      failClosed: true,
    });
    assert.equal(privTunnel.scope, `space:${priv.spaceId}`);

    // Simulate VPN tunnel drop -> strict_tunnel + failClosed MUST block requests (no silent fallback to OS direct!)
    if (mockKernel) {
      mockKernel.simulateTunnelHealth("browser", false);
      await assert.rejects(
        () => client.openPage({ spaceId: space.spaceId, url: `${fixtures.originA}/network-probe` }),
        (err) => err.code === "ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED"
      );

      // Private space has its own healthy exit, so it continues working unaffected!
      const privPage = await client.openPage({
        spaceId: priv.spaceId,
        url: `${fixtures.originA}/network-probe`,
      });
      assert.ok(privPage.pageId);

      // Restore browser tunnel health
      mockKernel.simulateTunnelHealth("browser", true);
    }

    await client.closeSpace(space.spaceId);
    await client.closeSpace(priv.spaceId);
  });

  await t.test("8. Security Guard: password/payment storage unreachable & password/payment input forces USER_ACTIVE takeover", async () => {
    const space = await client.createSpace({ name: "sec-guard", authMode: "shared" });

    // 1. Browser password manager, payment settings, and local files are strictly blocked
    for (const forbiddenUrl of [
      "chrome://password-manager/passwords",
      "chrome://settings/payments",
      "chrome://settings/passwords",
      "file:///etc/passwd",
      "view-source:chrome://settings/payments",
    ]) {
      await assert.rejects(
        () => client.openPage({ spaceId: space.spaceId, url: forbiddenUrl }),
        (err) => err.code === "ERR_DOMAIN_DENIED",
        `Expected ERR_DOMAIN_DENIED for ${forbiddenUrl}`
      );
    }

    // 2. Sensitive CDP domains/methods & forbidden Page.navigate URLs are blocked
    const page = await client.openPage({
      spaceId: space.spaceId,
      url: "data:text/html,<form><input id='pw' type='password' autocomplete='current-password'></form>",
    });
    for (const [cdpMethod, cdpParams] of [
      ["Autofill.trigger", {}],
      ["WebAuthn.enable", {}],
      ["FedCm.enable", {}],
      ["DOM.setFileInputFiles", { files: ["/etc/passwd"] }],
      ["Page.navigate", { url: "chrome://settings/payments" }],
    ]) {
      await assert.rejects(
        () => client.sendCdp(page.pageId, cdpMethod, cdpParams),
        (err) => err.code === "ERR_DOMAIN_DENIED",
        `Expected ERR_DOMAIN_DENIED for ${cdpMethod}`
      );
    }

    // 3. Attempting to touch password/payment fields automatically forces USER_ACTIVE takeover
    const takeoverEvents = [];
    const onTakeover = (evt) => {
      if (evt.event === "takeover.changed" && evt.params?.spaceId === space.spaceId) {
        takeoverEvents.push(evt.params);
      }
    };
    client.on("event", onTakeover);

    if (!mockKernel) {
      // Real Gador Engine 158: focus a real <input type="password"> and verify Blink TEXT_INPUT_TYPE_PASSWORD
      // triggers forced USER_ACTIVE takeover on Input.insertText!
      await new Promise((r) => setTimeout(r, 400));
      await client.sendCdp(page.pageId, "Runtime.evaluate", {
        expression: "document.getElementById('pw').focus()",
      });
      await new Promise((r) => setTimeout(r, 250));
      await assert.rejects(
        () => client.sendCdp(page.pageId, "Input.insertText", { text: "my-secret-pass" }),
        (err) => err.code === "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN"
      );
    } else {
      await assert.rejects(
        () =>
          client.sendCdp(page.pageId, "Runtime.evaluate", {
            expression: "document.querySelector('input[type=\"password\"]').value = 'x'",
          }),
        (err) => err.code === "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN"
      );
    }

    // Subsequent writes AND screenshots are now frozen in USER_ACTIVE until human releases control
    await assert.rejects(
      () => client.sendCdp(page.pageId, "Page.captureScreenshot", { format: "png" }),
      (err) => err.code === "ERR_HUMAN_IN_CONTROL"
    );
    assert.ok(
      takeoverEvents.some((e) => e.controlState === "USER_ACTIVE"),
      "Expected takeover.changed event with USER_ACTIVE"
    );
    client.off("event", onTakeover);

    // Human completes password/payment and releases takeover -> resumes cleanly
    const released = await client.releaseTakeover(space.spaceId);
    assert.equal(released.controlState, "AGENT_RUNNING");

    // 4. Dedicated checkout/payment URL also forces USER_ACTIVE takeover on mutating input
    const payPage = await client.openPage({
      spaceId: space.spaceId,
      url: `${fixtures.originA}/checkout`,
    });
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(
      () => client.sendCdp(payPage.pageId, "Input.insertText", { text: "4242" }),
      (err) => err.code === "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN"
    );
    await client.releaseTakeover(space.spaceId);
    await client.closeSpace(space.spaceId);
  });
});
