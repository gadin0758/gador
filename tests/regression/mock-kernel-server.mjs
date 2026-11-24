import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../../clients/protocol/framing.mjs";

const MUTATING_METHODS_BLOCKED_IN_USER_ACTIVE = new Set([
  "page.open",
  "page.close",
  "cdp.send",
]);

/**
 * Clean-room in-process UDS Mock Kernel implementing clients/protocol/schema.json.
 * Used to validate protocol framing, P0 state machines, dialog persistence,
 * dual-mode auth isolation, and Fail-Closed VPN semantics before/alongside
 * real Chromium builds.
 */
export class MockAgentKernelServer {
  #server = null;
  #clients = new Set();
  #nextSpaceSeq = 1;
  #nextPageSeq = 1;

  // Simulated browser state
  personalCookieJar = new Map();
  spaces = new Map();
  pages = new Map();
  routes = new Map();

  constructor({ socketPath }) {
    this.socketPath = socketPath;
    this.routes.set("browser", {
      scope: "browser",
      mode: "direct_only",
      endpoint: null,
      dohServer: null,
      bypassList: ["localhost", "127.0.0.1"],
      webrtcPolicy: "disable_non_proxied_udp",
      osProxyDisabled: true,
      failClosed: false,
      tunnelHealthy: true,
    });
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore if missing
    }

    this.#server = net.createServer((sock) => this.#onConnection(sock));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
  }

  async stop() {
    for (const sock of this.#clients) {
      sock.destroy();
    }
    this.#clients.clear();
    if (this.#server) {
      await new Promise((resolve) => this.#server.close(resolve));
      this.#server = null;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }

  broadcast(event, params) {
    const frame = encodeFrame({ event, params });
    for (const sock of this.#clients) {
      if (!sock.destroyed) sock.write(frame);
    }
  }

  // Test helper hooks to simulate browser-side events
  simulateWindowOpen(sourcePageId, targetUrl) {
    const source = this.pages.get(sourcePageId);
    if (!source) throw new Error(`Unknown sourcePageId ${sourcePageId}`);
    const pageId = `pg_${this.#nextPageSeq++}`;
    const page = {
      pageId,
      spaceId: source.spaceId,
      url: targetUrl,
      viewport: { ...source.viewport },
      viewAttached: false,
      mountCount: 0,
      openDialog: null,
      openerPageId: sourcePageId,
      inPersonalTabStrip: false,
    };
    this.pages.set(pageId, page);
    this.broadcast("page.created", {
      pageId,
      spaceId: page.spaceId,
      url: page.url,
      openerPageId: sourcePageId,
      capturedFromPopup: true,
    });
    return page;
  }

  simulateDialogOpen(pageId, { type, message, defaultPrompt = "" }) {
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Unknown pageId ${pageId}`);
    page.openDialog = { type, message, defaultPrompt, url: page.url };
    this.broadcast("dialog.opened", { pageId, ...page.openDialog });
  }

  simulateTunnelHealth(scope, healthy) {
    const route = this.routes.get(scope);
    if (!route) throw new Error(`Unknown route scope ${scope}`);
    route.tunnelHealthy = healthy;
    this.broadcast("network.tunnelStateChanged", {
      scope,
      tunnelHealthy: healthy,
      blockedByFailClosed: route.mode === "strict_tunnel" && route.failClosed && !healthy,
    });
  }

  #onConnection(sock) {
    this.#clients.add(sock);
    const decoder = new FrameDecoder();

    // Replay any still-open dialogs to newly connected sessions (cross-invocation survival)
    for (const page of this.pages.values()) {
      if (page.openDialog) {
        sock.write(
          encodeFrame({
            event: "dialog.opened",
            params: { pageId: page.pageId, ...page.openDialog, replayed: true },
          })
        );
      }
    }

    sock.on("data", (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        sock.write(
          encodeFrame({
            id: 0,
            error: { code: "ERR_INVALID_PARAMS", message: err.message },
          })
        );
        sock.destroy();
        return;
      }

      for (const req of messages) {
        try {
          const result = this.#dispatch(req.method, req.params || {});
          sock.write(encodeFrame({ id: req.id, result }));
        } catch (err) {
          sock.write(
            encodeFrame({
              id: req.id,
              error: {
                code: err.code || "ERR_INTERNAL",
                message: err.message || "Internal error",
              },
            })
          );
        }
      }
    });

    sock.on("close", () => this.#clients.delete(sock));
    sock.on("error", () => this.#clients.delete(sock));
  }

  #fail(code, message) {
    const err = new Error(message);
    err.code = code;
    throw err;
  }

  #checkNetworkAllowed(spaceId) {
    const route =
      this.routes.get(`space:${spaceId}`) || this.routes.get("browser");
    if (
      route &&
      route.mode === "strict_tunnel" &&
      route.failClosed &&
      !route.tunnelHealthy
    ) {
      this.#fail(
        "ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED",
        `Network blocked by Fail-Closed Kill-Switch on scope ${route.scope}`
      );
    }
  }

  #assertSpaceWritable(space, method) {
    if (
      space.controlState === "USER_ACTIVE" &&
      MUTATING_METHODS_BLOCKED_IN_USER_ACTIVE.has(method)
    ) {
      this.#fail(
        "ERR_HUMAN_IN_CONTROL",
        `Space ${space.spaceId} is currently under USER_ACTIVE control`
      );
    }
  }

  #dispatch(method, params) {
    switch (method) {
      case "agent.capabilities":
        return {
          protocolVersion: "0.1.0",
          chromiumVersion: "158.0.8127.36-mock",
          runtimeMode: "daemon",
          windowShownByDefault: false,
          features: [
            "dual-mode-auth",
            "detached-agent-space",
            "hot-view-mount",
            "non-blocking-dialogs",
            "independent-vpn-tunnel",
            "webmcp-ready",
            "windowless-daemon",
          ],
          authModes: ["shared", "private"],
          networkPolicies: ["strict_tunnel", "direct_only", "custom"],
        };

      case "space.create": {
        const authMode = params.authMode;
        if (authMode !== "shared" && authMode !== "private") {
          this.#fail("ERR_INVALID_PARAMS", "authMode must be shared or private");
        }
        const spaceId = `sp_${this.#nextSpaceSeq++}`;
        const space = {
          spaceId,
          name: params.name || spaceId,
          authMode,
          controlState: "AGENT_RUNNING",
          viewport: params.viewport || { width: 1280, height: 800 },
          ephemeralCookies: new Map(),
        };
        this.spaces.set(spaceId, space);
        return {
          spaceId: space.spaceId,
          name: space.name,
          authMode: space.authMode,
          controlState: space.controlState,
        };
      }

      case "space.list":
        return {
          spaces: [...this.spaces.values()].map((s) => ({
            spaceId: s.spaceId,
            name: s.name,
            authMode: s.authMode,
            controlState: s.controlState,
          })),
        };

      case "space.close": {
        const space = this.spaces.get(params.spaceId);
        if (!space) this.#fail("ERR_SPACE_NOT_FOUND", "Space not found");
        for (const [pid, page] of this.pages) {
          if (page.spaceId === space.spaceId) {
            this.pages.delete(pid);
            this.broadcast("page.closed", { pageId: pid, spaceId: space.spaceId });
          }
        }
        this.routes.delete(`space:${space.spaceId}`);
        this.spaces.delete(space.spaceId);
        return { closed: true };
      }

      case "page.open": {
        const space = this.spaces.get(params.spaceId);
        if (!space) this.#fail("ERR_SPACE_NOT_FOUND", "Space not found");
        this.#assertSpaceWritable(space, method);
        this.#checkNetworkAllowed(space.spaceId);
        const rawUrl = String(params.url || "about:blank").trim();
        const normUrl = rawUrl.toLowerCase().replace(/^(view-source:)+/, "");
        if (/^(chrome|chrome-untrusted|chrome-extension|chrome-search|devtools|file|filesystem|javascript):|^blob:(chrome|file):/.test(normUrl)) {
          this.#fail("ERR_DOMAIN_DENIED", "Access to browser internals, password/payment storage, and local files is strictly forbidden for AI Agents");
        }
        const pageId = `pg_${this.#nextPageSeq++}`;
        const viewport = params.viewport || { ...space.viewport };
        if (viewport.width <= 0 || viewport.height <= 0) {
          this.#fail("ERR_INVALID_PARAMS", "Viewport must be non-zero");
        }
        const page = {
          pageId,
          spaceId: space.spaceId,
          url: params.url || "about:blank",
          viewport,
          viewAttached: false,
          mountCount: 0,
          openDialog: null,
          inPersonalTabStrip: false,
        };
        this.pages.set(pageId, page);
        this.broadcast("page.created", {
          pageId,
          spaceId: space.spaceId,
          url: page.url,
          capturedFromPopup: false,
        });
        return {
          pageId: page.pageId,
          spaceId: page.spaceId,
          url: page.url,
          viewport: page.viewport,
          viewAttached: page.viewAttached,
        };
      }

      case "page.list": {
        const pages = [...this.pages.values()]
          .filter((p) => !params.spaceId || p.spaceId === params.spaceId)
          .map((p) => ({
            pageId: p.pageId,
            spaceId: p.spaceId,
            url: p.url,
            viewport: p.viewport,
            viewAttached: p.viewAttached,
            hasOpenDialog: Boolean(p.openDialog),
          }));
        return { pages };
      }

      case "page.close": {
        const page = this.pages.get(params.pageId);
        if (!page) this.#fail("ERR_PAGE_NOT_FOUND", "Page not found");
        const space = this.spaces.get(page.spaceId);
        this.#assertSpaceWritable(space, method);
        this.pages.delete(page.pageId);
        this.broadcast("page.closed", {
          pageId: page.pageId,
          spaceId: page.spaceId,
        });
        return { closed: true };
      }

      case "page.attachView": {
        const page = this.pages.get(params.pageId);
        if (!page) this.#fail("ERR_PAGE_NOT_FOUND", "Page not found");
        const space = this.spaces.get(page.spaceId);
        page.viewAttached = true;
        page.mountCount += 1;
        space.controlState = params.interactive
          ? "USER_ACTIVE"
          : space.controlState === "USER_ACTIVE"
            ? "USER_ACTIVE"
            : "USER_OBSERVING";
        this.broadcast("takeover.changed", {
          spaceId: space.spaceId,
          pageId: page.pageId,
          controlState: space.controlState,
        });
        return {
          pageId: page.pageId,
          viewAttached: page.viewAttached,
          controlState: space.controlState,
          mountCount: page.mountCount,
        };
      }

      case "page.detachView": {
        const page = this.pages.get(params.pageId);
        if (!page) this.#fail("ERR_PAGE_NOT_FOUND", "Page not found");
        const space = this.spaces.get(page.spaceId);
        page.viewAttached = false;
        if (space.controlState === "USER_OBSERVING") {
          space.controlState = "AGENT_RUNNING";
        }
        return {
          pageId: page.pageId,
          viewAttached: page.viewAttached,
          controlState: space.controlState,
        };
      }

      case "takeover.request": {
        const space = this.spaces.get(params.spaceId);
        if (!space) this.#fail("ERR_SPACE_NOT_FOUND", "Space not found");
        space.controlState = "USER_ACTIVE";
        this.broadcast("takeover.changed", {
          spaceId: space.spaceId,
          pageId: params.pageId || null,
          reason: params.reason || "user_requested",
          controlState: space.controlState,
        });
        return { spaceId: space.spaceId, controlState: space.controlState };
      }

      case "takeover.release": {
        const space = this.spaces.get(params.spaceId);
        if (!space) this.#fail("ERR_SPACE_NOT_FOUND", "Space not found");
        space.controlState = "AGENT_RUNNING";
        this.broadcast("takeover.changed", {
          spaceId: space.spaceId,
          controlState: space.controlState,
        });
        return { spaceId: space.spaceId, controlState: space.controlState };
      }

      case "dialog.handle": {
        const page = this.pages.get(params.pageId);
        if (!page) this.#fail("ERR_PAGE_NOT_FOUND", "Page not found");
        if (!page.openDialog) {
          this.#fail("ERR_DIALOG_NOT_OPEN", "No open dialog on page");
        }
        const closed = page.openDialog;
        page.openDialog = null;
        this.broadcast("dialog.closed", {
          pageId: page.pageId,
          dialogType: closed.type,
          accepted: Boolean(params.accept),
          promptText: params.promptText ?? null,
        });
        return { handled: true, dialogType: closed.type };
      }

      case "cdp.send": {
        const page = this.pages.get(params.pageId);
        if (!page) {
          this.#fail(
            "ERR_TARGET_OUT_OF_SCOPE",
            `Target ${params.pageId} is not an Agent-owned page`
          );
        }
        const space = this.spaces.get(page.spaceId);
        this.#assertSpaceWritable(space, method);
        this.#checkNetworkAllowed(space.spaceId);

        const cdpMethod = String(params.cdpMethod || "");
        const cdpParamsStr = JSON.stringify(params.cdpParams || {}).toLowerCase();
        if (
          /^(Autofill|WebAuthn|FedCm|Browser|FileSystem|IO|SystemInfo|Tethering)\./.test(cdpMethod) ||
          ["DOM.setFileInputFiles", "Target.createTarget", "Target.attachToBrowserTarget", "Target.exposeDevToolsProtocol", "Storage.getSharedStorageEntries"].includes(cdpMethod)
        ) {
          this.#fail("ERR_DOMAIN_DENIED", "CDP domain/method blocked to protect passwords, payment methods, and local files");
        }
        if (cdpMethod === "Page.navigate") {
          const navUrl = String(params.cdpParams?.url || "").trim().toLowerCase().replace(/^(view-source:)+/, "");
          if (/^(chrome|chrome-untrusted|chrome-extension|chrome-search|devtools|file|filesystem|javascript):|^blob:(chrome|file):/.test(navUrl)) {
            this.#fail("ERR_DOMAIN_DENIED", "Blocked internal or local navigation");
          }
        }
        const isSensitiveUrl = /\/(checkout|payment|payments|billing|wallet|credit-card|password|passwords|change-password|reset-password)(\/|$|\?)|checkout\.stripe\.com|pay\.google\.com|checkout\.paypal\.com/i.test(page.url || "");
        const isMutating = /^(Input\.|Runtime\.evaluate$|Runtime\.callFunctionOn$|DOM\.(focus|setAttributeValue|setAttributesAsText|setNodeValue|setOuterHTML)$)/.test(cdpMethod);
        const touchesCredOrCard = /(type=.{0,2}password|current-password|new-password|cc-number|cc-csc|cc-exp|navigator\.credentials|paymentrequest|cardnumber|card_number)/.test(cdpParamsStr);
        if ((isSensitiveUrl && isMutating) || touchesCredOrCard) {
          space.controlState = "USER_ACTIVE";
          this.broadcast("takeover.changed", {
            spaceId: space.spaceId,
            pageId: page.pageId,
            reason: "credential_or_payment_requires_human",
            controlState: "USER_ACTIVE",
          });
          this.#fail("ERR_SENSITIVE_ACTION_REQUIRES_HUMAN", "Password/payment interaction locked into USER_ACTIVE for mandatory human operation");
        }

        if (params.cdpMethod === "Network.getCookies") {
          const jar =
            space.authMode === "shared"
              ? this.personalCookieJar
              : space.ephemeralCookies;
          return {
            cookies: [...jar.entries()].map(([name, value]) => ({ name, value })),
          };
        }
        if (params.cdpMethod === "Page.navigate") {
          page.url = params.cdpParams?.url || page.url;
          return { frameId: `frame_${page.pageId}` };
        }
        return { ok: true, method: params.cdpMethod };
      }

      case "network.setTunnel": {
        const scope = params.scope || "browser";
        if (scope.startsWith("space:")) {
          const spaceId = scope.slice("space:".length);
          const space = this.spaces.get(spaceId);
          if (!space) this.#fail("ERR_SPACE_NOT_FOUND", "Space not found");
          if (space.authMode !== "private") {
            this.#fail(
              "ERR_INVALID_PARAMS",
              "Per-space tunnel override requires authMode=private (shared spaces use browser scope to keep login IP consistent)"
            );
          }
        }
        const mode = params.mode || "strict_tunnel";
        if (!["strict_tunnel", "direct_only", "custom"].includes(mode)) {
          this.#fail("ERR_INVALID_PARAMS", `Invalid route mode: ${mode}`);
        }
        if (mode === "strict_tunnel" && !params.endpoint) {
          this.#fail(
            "ERR_INVALID_PARAMS",
            "strict_tunnel mode requires an endpoint"
          );
        }
        const route = {
          scope,
          mode,
          endpoint: params.endpoint || null,
          dohServer: params.dohServer || null,
          bypassList: params.bypassList || ["localhost", "127.0.0.1"],
          webrtcPolicy: params.webrtcPolicy || "disable_non_proxied_udp",
          osProxyDisabled: true,
          failClosed: params.failClosed ?? mode === "strict_tunnel",
          tunnelHealthy: true,
        };
        this.routes.set(scope, route);
        return {
          scope: route.scope,
          mode: route.mode,
          osProxyDisabled: route.osProxyDisabled,
          webrtcPolicy: route.webrtcPolicy,
          failClosed: route.failClosed,
          tunnelHealthy: route.tunnelHealthy,
        };
      }

      case "network.getStatus": {
        const routes = [...this.routes.values()].filter(
          (r) => !params.scope || r.scope === params.scope
        );
        return { routes };
      }

      default:
        this.#fail("ERR_METHOD_NOT_FOUND", `Unknown method: ${method}`);
    }
  }
}
