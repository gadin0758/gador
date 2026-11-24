// MCP Tool catalog mapped 1:1 to clients/protocol/schema.json.
import {
  getModulesState,
  isModuleEnabled,
  isModuleInstalled,
} from "../../modules/registry.mjs";
import {
  buildPrivacyAuditExpression,
  getPrivacyShieldState,
  updatePrivacyShield,
} from "../protocol/privacy-shield-store.mjs";
import {
  createVpnBackup,
  deleteVpnProfile,
  getVpnStoreState,
  restoreVpnBackup,
  upsertVpnProfile,
} from "../protocol/vpn-store.mjs";

// Track fresh page_open timestamps so an immediate 0ms CDP call does not race
// Chromium's initial about:blank -> target RenderFrameHost swap.
const pageOpenedAt = new Map();
function markPageOpened(pageId) {
  if (pageId) pageOpenedAt.set(pageId, Date.now());
}
function clearPageOpened(pageId) {
  if (pageId) pageOpenedAt.delete(pageId);
}
async function waitForInitialNavigationSettle(pageId, minSettleMs = 380) {
  const ts = pageOpenedAt.get(pageId);
  if (!ts) return;
  const remaining = minSettleMs - (Date.now() - ts);
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }
  pageOpenedAt.delete(pageId);
}

export const CORE_MCP_TOOLS = [
  {
    name: "browser_capabilities",
    description:
      "Inspect gador kernel capabilities, protocol version, runtimeMode (daemon/desktop), supported authModes (shared/private), and independent VPN policies. Call this first.",
    inputSchema: { type: "object", properties: {} },
    invoke: (client) => client.capabilities(),
  },
  {
    name: "space_create",
    description:
      "Create an isolated AgentSpace completely detached from the user's personal tab strip. Use authMode='shared' to reuse logged-in state without polluting personal history, or authMode='private' for zero-cookie ephemeral OTR isolation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable workspace label." },
        authMode: {
          type: "string",
          enum: ["shared", "private"],
          description: "shared = persistent Profile login; private = isolated OTRProfile.",
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
          },
        },
      },
      required: ["authMode"],
    },
    invoke: (client, args) => client.createSpace(args),
  },
  {
    name: "space_list",
    description: "List all active AgentSpaces, their authMode, and current controlState.",
    inputSchema: { type: "object", properties: {} },
    invoke: (client) => client.listSpaces(),
  },
  {
    name: "space_close",
    description: "Close an AgentSpace and destroy all of its pages (and OTR profile if private).",
    inputSchema: {
      type: "object",
      properties: { spaceId: { type: "string" } },
      required: ["spaceId"],
    },
    invoke: (client, args) => client.closeSpace(args.spaceId),
  },
  {
    name: "page_open",
    description:
      "Open a new detached WebContents inside an AgentSpace (never inserted into personal browser tabs, always non-zero viewport).",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        url: { type: "string" },
        viewport: {
          type: "object",
          properties: {
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
          },
        },
      },
      required: ["spaceId"],
    },
    invoke: async (client, args) => {
      const res = await client.openPage(args);
      if (res?.pageId && args.url && args.url !== "about:blank") {
        markPageOpened(res.pageId);
      }
      return res;
    },
  },
  {
    name: "page_list",
    description: "List Agent-owned pages (optionally filtered by spaceId).",
    inputSchema: {
      type: "object",
      properties: { spaceId: { type: "string" } },
    },
    invoke: (client, args) => client.listPages(args.spaceId),
  },
  {
    name: "page_close",
    description: "Close an Agent-owned page.",
    inputSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      clearPageOpened(args.pageId);
      return client.closePage(args.pageId);
    },
  },
  {
    name: "page_attach_view",
    description:
      "Hot-mount an Agent page into the expandable Agent Space window so the user can observe live (interactive=false) or immediately take over and interact (interactive=true).",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        interactive: { type: "boolean", default: false },
      },
      required: ["pageId"],
    },
    invoke: (client, args) =>
      client.attachView(args.pageId, Boolean(args.interactive)),
  },
  {
    name: "page_detach_view",
    description:
      "Collapse the Agent page back into the unobtrusive dock button while continuing background execution.",
    inputSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
    },
    invoke: (client, args) => client.detachView(args.pageId),
  },
  {
    name: "takeover_request",
    description:
      "Hand control of an AgentSpace to the human user (USER_ACTIVE) for CAPTCHA, 2FA, payment confirmation, or sensitive hardware permissions.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        pageId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["spaceId", "reason"],
    },
    invoke: (client, args) =>
      client.requestTakeover(args.spaceId, args.reason, args.pageId),
  },
  {
    name: "takeover_release",
    description: "Return control of an AgentSpace from USER_ACTIVE back to AGENT_RUNNING.",
    inputSchema: {
      type: "object",
      properties: { spaceId: { type: "string" } },
      required: ["spaceId"],
    },
    invoke: (client, args) => client.releaseTakeover(args.spaceId),
  },
  {
    name: "dialog_handle",
    description:
      "Accept or dismiss an open JavaScript dialog (alert/confirm/prompt/beforeunload) without blocking CDP.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        accept: { type: "boolean" },
        promptText: { type: "string" },
      },
      required: ["pageId", "accept"],
    },
    invoke: (client, args) =>
      client.handleDialog(args.pageId, args.accept, args.promptText),
  },
  {
    name: "cdp_send",
    description:
      "Send a scoped CDP command to an Agent-owned pageId. Personal browser tabs are strictly unreachable (ERR_TARGET_OUT_OF_SCOPE). Avoid Runtime.enable unless explicitly needed.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        cdpMethod: { type: "string" },
        cdpParams: { type: "object" },
        sessionId: { type: "string" },
      },
      required: ["pageId", "cdpMethod"],
    },
    invoke: (client, args) =>
      client.sendCdp(
        args.pageId,
        args.cdpMethod,
        args.cdpParams || {},
        args.sessionId
      ),
  },
  {
    name: "network_set_tunnel",
    description:
      "Configure an independent VPN/tunnel endpoint (disabling host OS proxy overrides, enforcing WebRTC disable_non_proxied_udp, and Fail-Closed Kill-Switch in strict_tunnel mode).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "'browser' for global exit, or 'space:<spaceId>' for private-space independent exit.",
          default: "browser",
        },
        mode: {
          type: "string",
          enum: ["strict_tunnel", "direct_only", "custom"],
        },
        endpoint: {
          type: "string",
          description: "Tunnel URL such as socks5://127.0.0.1:10808 or https://...",
        },
        dohServer: { type: "string" },
        bypassList: { type: "array", items: { type: "string" } },
        webrtcPolicy: { type: "string", default: "disable_non_proxied_udp" },
        failClosed: { type: "boolean", default: true },
      },
      required: ["mode"],
    },
    invoke: async (client, args) => {
      const backup = createVpnBackup({
        reason: `ai_set_tunnel:${args.scope || "browser"}:${args.mode}`,
        actor: "ai",
        extraMeta: { scope: args.scope || "browser", mode: args.mode, endpoint: args.endpoint || "" },
      });
      const result = await client.setTunnel(args);
      return { ...result, backupId: backup.backupId, backupFile: backup.filePath };
    },
  },
  {
    name: "network_get_status",
    description: "Inspect active independent VPN/tunnel status and health.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string" } },
    },
    invoke: (client, args) => client.getNetworkStatus(args.scope),
  },
  // ---- VPN-Only Open Profile & Mandatory Pre-Modify Backup Tools ----
  {
    name: "vpn_get_profiles",
    description:
      "Read Gador's VPN-only configuration profiles archive, backup directory path, and existing backups. Only VPN configuration is editable by AI; all other browser settings/passwords/payments remain strictly locked.",
    inputSchema: { type: "object", properties: {} },
    invoke: async (client) => {
      const store = getVpnStoreState();
      const live = await client.getNetworkStatus().catch(() => ({ routes: [] }));
      return { ...store, activeRoutes: live.routes || [] };
    },
  },
  {
    name: "vpn_backup_create",
    description:
      "Create a timestamped snapshot backup of the current VPN profiles archive before making any VPN modification.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for creating this VPN backup snapshot." },
      },
      required: ["reason"],
    },
    invoke: async (_client, args) => createVpnBackup({ reason: args.reason, actor: "ai" }),
  },
  {
    name: "vpn_update_profile",
    description:
      "Create or update a VPN-only configuration profile. Enforces mandatory automatic backup BEFORE modifying the archive (backupReason required). Optionally hot-applies to the kernel when applyNow=true.",
    inputSchema: {
      type: "object",
      properties: {
        backupReason: {
          type: "string",
          description: "Mandatory explanation recorded on the automatic pre-modify backup snapshot.",
        },
        id: { type: "string", description: "Existing profile id to update, or omit to create a new VPN profile." },
        name: { type: "string", description: "Human-readable VPN profile name." },
        scope: { type: "string", default: "browser", description: "'browser' or 'space:<spaceId>'." },
        mode: { type: "string", enum: ["strict_tunnel", "direct_only", "custom"] },
        endpoint: { type: "string", description: "Tunnel endpoint URL (socks5://, http://, https://, quic://)." },
        dohServer: { type: "string" },
        bypassList: { type: "array", items: { type: "string" } },
        failClosed: { type: "boolean", default: true },
        note: { type: "string" },
        applyNow: { type: "boolean", default: false, description: "Also hot-apply this VPN policy immediately." },
      },
      required: ["backupReason", "name", "mode"],
    },
    invoke: async (client, args) => {
      const saved = upsertVpnProfile(args, { actor: "ai", backupReason: args.backupReason });
      let applied = null;
      if (args.applyNow) {
        applied = await client.setTunnel({
          scope: saved.profile.scope,
          mode: saved.profile.mode,
          endpoint: saved.profile.endpoint || undefined,
          dohServer: saved.profile.dohServer || undefined,
          bypassList: saved.profile.bypassList,
          failClosed: saved.profile.failClosed,
        });
      }
      return { ...saved, applied };
    },
  },
  {
    name: "vpn_delete_profile",
    description:
      "Delete a VPN-only configuration profile by id. Automatically writes a backup snapshot BEFORE deletion (backupReason required).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "VPN profile id to delete." },
        backupReason: { type: "string", description: "Mandatory explanation for pre-delete backup." },
      },
      required: ["id", "backupReason"],
    },
    invoke: async (_client, args) =>
      deleteVpnProfile(args.id, { actor: "ai", backupReason: args.backupReason }),
  },
  {
    name: "vpn_restore_backup",
    description:
      "Restore the VPN profiles archive from a saved backupId in the backup zone (automatically backs up current state before restoring).",
    inputSchema: {
      type: "object",
      properties: {
        backupId: { type: "string", description: "Backup ID from vpn_get_profiles." },
      },
      required: ["backupId"],
    },
    invoke: async (_client, args) => restoreVpnBackup(args.backupId, { actor: "ai" }),
  },
  // ---- High-level link-scoped AI Self-Operation Tools ----
  {
    name: "browser_navigate",
    description:
      "Open or navigate to a web URL inside an AgentSpace (auto-creates a space/page if pageId is omitted). Strictly restricted to web links; internal chrome:// password/payment storage and file:// paths are hard-blocked by the kernel.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target http(s) web URL." },
        pageId: { type: "string", description: "Existing pageId to navigate (optional)." },
        spaceId: { type: "string", description: "Existing spaceId when opening a new page (optional)." },
        authMode: { type: "string", enum: ["shared", "private"], default: "shared" },
      },
      required: ["url"],
    },
    invoke: async (client, args) => {
      if (args.pageId) {
        const res = await client.sendCdp(args.pageId, "Page.navigate", { url: args.url });
        return { pageId: args.pageId, url: args.url, navigated: true, ...res };
      }
      let spaceId = args.spaceId;
      if (!spaceId) {
        const spacesRes = await client.listSpaces();
        const existing = (spacesRes.spaces || []).find((s) => s.authMode === (args.authMode || "shared"));
        if (existing) {
          spaceId = existing.spaceId;
        } else {
          const sp = await client.createSpace({
            name: "AI Workspace",
            authMode: args.authMode || "shared",
          });
          spaceId = sp.spaceId;
        }
      }
      return client.openPage({ spaceId, url: args.url });
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Read a compact semantic snapshot of an Agent-owned web page: title, URL, visible text excerpt, and interactive elements with CSS selectors (password values are always redacted).",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        maxTextChars: { type: "integer", default: 4000 },
        maxElements: { type: "integer", default: 60 },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      await waitForInitialNavigationSettle(args.pageId);
      const maxText = Math.min(20000, Math.max(200, Number(args.maxTextChars) || 4000));
      const maxEls = Math.min(150, Math.max(10, Number(args.maxElements) || 60));
      const expr = `(() => {
        const cssPath = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute('name');
          if (name) return tag + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && parts.length < 4) {
            let sel = cur.tagName.toLowerCase();
            if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
            const sibs = cur.parentElement ? [...cur.parentElement.children].filter(c => c.tagName === cur.tagName) : [];
            if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
            parts.unshift(sel);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        };
        const nodes = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]')].slice(0, ${maxEls});
        const elements = nodes.map((el, i) => {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const t = (el.getAttribute('type') || '').toLowerCase();
          const sensitive = t === 'password' || /password|cc-|card|cvv|cvc/i.test((el.getAttribute('autocomplete') || '') + ' ' + (el.name || ''));
          return {
            ref: 'e' + (i + 1),
            tag,
            type: t || undefined,
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 100),
            href: tag === 'a' ? el.href : undefined,
            selector: cssPath(el),
            sensitive,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
        });
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxText});
        return JSON.stringify({ title: document.title, url: location.href, text, elements });
      })()`;
      const res = await client.sendCdp(args.pageId, "Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      const val = res?.result?.value;
      return typeof val === "string" ? JSON.parse(val) : res;
    },
  },
  {
    name: "browser_get_links",
    description: "List hyperlinks (text and href) on an Agent-owned web page.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        limit: { type: "integer", default: 50 },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const res = await client.sendCdp(args.pageId, "Runtime.evaluate", {
        expression: `JSON.stringify([...document.querySelectorAll('a[href]')].slice(0, ${limit}).map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 120), href: a.href })))`,
        returnByValue: true,
      });
      const val = res?.result?.value;
      return { pageId: args.pageId, links: typeof val === "string" ? JSON.parse(val) : [] };
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on an Agent-owned web page by CSS selector, visible text, or (x, y) viewport coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        selector: { type: "string", description: "CSS selector from browser_snapshot." },
        text: { type: "string", description: "Fallback visible text match for button/link." },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      let x = args.x;
      let y = args.y;
      if (typeof x !== "number" || typeof y !== "number") {
        const findExpr = args.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`
          : `(() => { const q = ${JSON.stringify(String(args.text || "").toLowerCase())}; const el = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')].find(n => (n.innerText || n.value || n.getAttribute('aria-label') || '').toLowerCase().includes(q)); if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`;
        const locRes = await client.sendCdp(args.pageId, "Runtime.evaluate", {
          expression: findExpr,
          returnByValue: true,
        });
        const raw = locRes?.result?.value;
        if (!raw) {
          const e = new Error("Element not found on page");
          e.code = "ERR_INVALID_PARAMS";
          throw e;
        }
        const pt = JSON.parse(raw);
        x = pt.x;
        y = pt.y;
      }
      await client.sendCdp(args.pageId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      await client.sendCdp(args.pageId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await client.sendCdp(args.pageId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return { clicked: true, pageId: args.pageId, x: Math.round(x), y: Math.round(y) };
    },
  },
  {
    name: "browser_type",
    description:
      "Focus an input field by CSS selector and type text. Password and payment fields are automatically intercepted by the kernel (ERR_SENSITIVE_ACTION_REQUIRES_HUMAN) and handed to the human user.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", default: false },
      },
      required: ["pageId", "text"],
    },
    invoke: async (client, args) => {
      if (args.selector) {
        const focusExpr = `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.focus(); ${args.clear ? "if ('value' in el) el.value = '';" : ""} return true; })()`;
        const focusRes = await client.sendCdp(args.pageId, "Runtime.evaluate", {
          expression: focusExpr,
          returnByValue: true,
        });
        if (focusRes?.result?.value === false) {
          const e = new Error(`Input selector not found: ${args.selector}`);
          e.code = "ERR_INVALID_PARAMS";
          throw e;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      await client.sendCdp(args.pageId, "Input.insertText", { text: args.text });
      return { typed: true, pageId: args.pageId, length: args.text.length };
    },
  },
  {
    name: "browser_press_key",
    description: "Send a keyboard key press (e.g. Enter, Tab, Escape, ArrowDown) to an Agent-owned page.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        key: { type: "string" },
      },
      required: ["pageId", "key"],
    },
    invoke: async (client, args) => {
      await client.sendCdp(args.pageId, "Input.dispatchKeyEvent", { type: "keyDown", key: args.key });
      await client.sendCdp(args.pageId, "Input.dispatchKeyEvent", { type: "keyUp", key: args.key });
      return { pressed: true, pageId: args.pageId, key: args.key };
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll an Agent-owned web page vertically or horizontally.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        deltaY: { type: "number", default: 500 },
        deltaX: { type: "number", default: 0 },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      const dx = Number(args.deltaX) || 0;
      const dy = Number(args.deltaY ?? 500);
      await client.sendCdp(args.pageId, "Runtime.evaluate", {
        expression: `window.scrollBy(${dx}, ${dy}); true`,
        returnByValue: true,
      });
      return { scrolled: true, pageId: args.pageId, deltaX: dx, deltaY: dy };
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a live PNG screenshot of an Agent-owned web page (blocked during USER_ACTIVE human takeover).",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      // Wait for Chromium's initial about:blank -> target RenderFrameHost swap
      // if browser_screenshot is called right after page_open.
      await waitForInitialNavigationSettle(args.pageId);
      const waitDeadline = Date.now() + 2500;
      let sawCommitted = false;
      while (Date.now() < waitDeadline) {
        try {
          const probe = await client.call(
            "cdp.send",
            {
              pageId: args.pageId,
              cdpMethod: "Runtime.evaluate",
              cdpParams: {
                expression: "document.readyState + '|' + location.href",
                returnByValue: true,
              },
            },
            1500
          );
          const raw = probe?.result?.value;
          // Simulation daemon returns mock object without string payload -> capture immediately
          if (typeof raw !== "string") {
            sawCommitted = true;
            break;
          }
          const sep = raw.indexOf("|");
          const readyState = sep >= 0 ? raw.slice(0, sep) : raw;
          const href = sep >= 0 ? raw.slice(sep + 1) : "";
          if (readyState !== "loading" && href && href !== "about:blank") {
            sawCommitted = true;
            // Give Chromium's offscreen compositor one beat to submit the committed frame
            await new Promise((r) => setTimeout(r, 120));
            break;
          }
        } catch (err) {
          if (
            err?.code === "ERR_HUMAN_IN_CONTROL" ||
            err?.code === "ERR_TARGET_OUT_OF_SCOPE" ||
            err?.code === "ERR_DOMAIN_DENIED" ||
            err?.code === "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN"
          ) {
            throw err;
          }
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      if (!sawCommitted) {
        await new Promise((r) => setTimeout(r, 150));
      }
      const shot = await client.call(
        "cdp.send",
        {
          pageId: args.pageId,
          cdpMethod: "Page.captureScreenshot",
          cdpParams: { format: "png", fromSurface: true },
        },
        10000
      );
      return {
        __mcpImage: true,
        mimeType: "image/png",
        data: shot?.data || "",
        pageId: args.pageId,
      };
    },
  },
  {
    name: "browser_list_native_tabs",
    description:
      "List native browser tabs in Overview format, distinguishing AI-controlled glowing tabs from normal human tabs.",
    inputSchema: { type: "object", properties: {} },
    invoke: (client) => client.call("page.listNativeTabs", {}),
  },
  {
    name: "browser_attach_active_tab",
    description:
      "Attach to an existing user-opened browser tab (active tab or given tabIndex) so AI can operate it directly in-place with tab-level optical glow.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        tabIndex: { type: "integer" },
      },
    },
    invoke: (client, args) => client.call("page.attachActiveTab", args || {}),
  },
  {
    name: "browser_detach_tab",
    description:
      "Release an AI-controlled native tab back to normal human browsing without closing the webpage.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
      },
    },
    invoke: (client, args) => client.call("page.detachTab", args || {}),
  },
  // ---- Optional Pluggable Module Discovery & Privacy-Shield Audit Tools ----
  {
    name: "module_list",
    description:
      "List Gador optional pluggable modules (vpn, privacy-shield), their installation/enabled status, integration hooks, and CLI install commands.",
    inputSchema: { type: "object", properties: {} },
    invoke: async () => getModulesState(),
  },
  // ---- Privacy & Anti-Fingerprinting Shield + AI Environment Audit Tools ----
  {
    name: "privacy_shield_get",
    description:
      "Inspect Gador's current Privacy & Anti-Fingerprinting Shield configuration (off/standard/strict presets, Canvas/WebGL/Audio/DOMRect/Hardware/GPC/WebRTC flags) and live network leak-protection status.",
    inputSchema: { type: "object", properties: {} },
    invoke: async (client) => {
      const store = getPrivacyShieldState();
      const net = await client.getNetworkStatus().catch(() => ({ routes: [] }));
      return {
        moduleInstalled: isModuleInstalled("privacy-shield"),
        moduleEnabled: isModuleEnabled("privacy-shield"),
        ...store,
        activeRoutes: net.routes || [],
      };
    },
  },
  {
    name: "privacy_shield_set",
    description:
      "Configure Gador's Privacy & Anti-Fingerprinting Shield preset (off | standard | strict) or toggle individual browser fingerprint protections for privacy tuning and website environment compatibility debugging. Requires the optional 'privacy-shield' module to be installed and enabled (gador-mod install privacy-shield). Never use to bypass CAPTCHAs or access controls; use takeover_request for human verification.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["off", "standard", "strict"],
          description: "Preset level: off, standard (balanced anti-fingerprinting), or strict (+ DOMRect sub-pixel jitter).",
        },
        canvasFarbling: { type: "boolean", description: "Deterministic per-origin Canvas 2D farbling." },
        webglFarbling: { type: "boolean", description: "Normalize WebGL vendor/renderer and readPixels." },
        audioFarbling: { type: "boolean", description: "Subtle deterministic AudioContext farbling." },
        clientRectsJitter: { type: "boolean", description: "Sub-pixel DOMRect jitter (strict mode)." },
        hardwareNormalization: { type: "boolean", description: "Normalize hardwareConcurrency/deviceMemory and hide getBattery." },
        webrtcLeakProtection: { type: "boolean", description: "Keep WebRTC non-proxied UDP leak protection enabled." },
        gpcHeader: { type: "boolean", description: "Send Sec-GPC: 1 header and expose navigator.globalPrivacyControl." },
        hideAutomationHints: { type: "boolean", description: "Keep standard browsing navigator.webdriver=false and native Function.toString." },
      },
    },
    invoke: async (_client, args) => {
      if (!isModuleEnabled("privacy-shield")) {
        const err = new Error(
          'Optional module "privacy-shield" is not installed or enabled. Ask the user to run "gador-mod install privacy-shield" or enable it in Gador Settings.'
        );
        err.code = "ERR_INVALID_PARAMS";
        throw err;
      }
      return {
        moduleInstalled: true,
        moduleEnabled: true,
        ...updatePrivacyShield(args || {}, { actor: "ai" }),
      };
    },
  },
  {
    name: "privacy_audit_page",
    description:
      "Run a structured read-only browser environment and fingerprint self-check on an Agent-owned pageId (navigator signals, GPC, WebGL vendor/renderer, Canvas determinism, AudioContext, viewport/DPR, and active WebRTC/tunnel policy) to diagnose environment checks or compatibility issues.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Agent-owned pageId to inspect." },
      },
      required: ["pageId"],
    },
    invoke: async (client, args) => {
      const evalRes = await client.sendCdp(args.pageId, "Runtime.evaluate", {
        expression: buildPrivacyAuditExpression(),
        returnByValue: true,
      });
      const raw = evalRes?.result?.value;
      const pageSignals = typeof raw === "string" ? JSON.parse(raw) : raw || {};
      const shield = getPrivacyShieldState();
      const net = await client.getNetworkStatus().catch(() => ({ routes: [] }));
      return {
        pageId: args.pageId,
        moduleInstalled: isModuleInstalled("privacy-shield"),
        moduleEnabled: isModuleEnabled("privacy-shield"),
        configuredShield: shield.privacyShield,
        pageSignals,
        networkRoutes: net.routes || [],
      };
    },
  },
];
