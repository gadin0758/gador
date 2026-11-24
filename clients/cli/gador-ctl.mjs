#!/usr/bin/env node
import path from "node:path";
import { AgentKernelClient } from "../protocol/index.mjs";
import {
  buildPrivacyAuditExpression,
  getPrivacyShieldState,
  PRIVACY_SHIELD_FLAG_KEYS,
  updatePrivacyShield,
} from "../protocol/privacy-shield-store.mjs";

function resolveSocketPath(flagValue) {
  if (flagValue) return flagValue;
  if (process.env.AGENT_KERNEL_SOCKET) return process.env.AGENT_KERNEL_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "gador", "ctl.sock");
  }
  return "/tmp/gador/ctl.sock";
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function printUsage() {
  const usage = `gador-ctl — Zero-dependency CLI for the gador Chromium kernel (0600 UDS)

Usage:
  gador-ctl [--socket <path>] <command> [args...]

Commands:
  capabilities
  space create --auth <shared|private> [--name <name>] [--width <w>] [--height <h>]
  space list
  space close <spaceId>
  page open <spaceId> <url> [--width <w>] [--height <h>]
  page list [spaceId]
  page close <pageId>
  page attach <pageId> [--interactive]
  page detach <pageId>
  takeover request <spaceId> --reason <reason> [--page <pageId>]
  takeover release <spaceId>
  dialog handle <pageId> (--accept | --dismiss) [--prompt <text>]
  cdp <pageId> <cdpMethod> [jsonParams]
  network set --mode <strict_tunnel|direct_only|custom> [--scope <browser|space:id>] [--endpoint <url>] [--doh <url>] [--fail-closed]
  network status [scope]
  privacy get
  privacy set [--level <off|standard|strict>] [--canvasFarbling <true|false>] [--webglFarbling <true|false>] [--audioFarbling <true|false>] [--clientRectsJitter <true|false>] [--hardwareNormalization <true|false>] [--gpcHeader <true|false>] [--hideAutomationHints <true|false>]
  privacy audit <pageId>
  rpc <method> [jsonParams]
`;
  process.stdout.write(usage);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (positionals.length === 0 || flags.help || positionals[0] === "help") {
    printUsage();
    return;
  }

  const socketPath = resolveSocketPath(
    typeof flags.socket === "string" ? flags.socket : undefined
  );
  const client = new AgentKernelClient({ socketPath });
  await client.connect();

  try {
    const [cmd, sub, ...rest] = positionals;
    let result;

    if (cmd === "capabilities") {
      result = await client.capabilities();
    } else if (cmd === "space" && sub === "create") {
      const viewport =
        flags.width && flags.height
          ? { width: Number(flags.width), height: Number(flags.height) }
          : undefined;
      result = await client.createSpace({
        name: typeof flags.name === "string" ? flags.name : undefined,
        authMode: typeof flags.auth === "string" ? flags.auth : "shared",
        viewport,
      });
    } else if (cmd === "space" && sub === "list") {
      result = await client.listSpaces();
    } else if (cmd === "space" && sub === "close") {
      result = await client.closeSpace(rest[0]);
    } else if (cmd === "page" && sub === "open") {
      const viewport =
        flags.width && flags.height
          ? { width: Number(flags.width), height: Number(flags.height) }
          : undefined;
      result = await client.openPage({
        spaceId: rest[0],
        url: rest[1] || "about:blank",
        viewport,
      });
    } else if (cmd === "page" && sub === "list") {
      result = await client.listPages(rest[0]);
    } else if (cmd === "page" && sub === "close") {
      result = await client.closePage(rest[0]);
    } else if (cmd === "page" && sub === "attach") {
      result = await client.attachView(rest[0], Boolean(flags.interactive));
    } else if (cmd === "page" && sub === "detach") {
      result = await client.detachView(rest[0]);
    } else if (cmd === "takeover" && sub === "request") {
      result = await client.requestTakeover(
        rest[0],
        typeof flags.reason === "string" ? flags.reason : "user_requested",
        typeof flags.page === "string" ? flags.page : undefined
      );
    } else if (cmd === "takeover" && sub === "release") {
      result = await client.releaseTakeover(rest[0]);
    } else if (cmd === "dialog" && sub === "handle") {
      const accept = flags.dismiss ? false : Boolean(flags.accept);
      result = await client.handleDialog(
        rest[0],
        accept,
        typeof flags.prompt === "string" ? flags.prompt : undefined
      );
    } else if (cmd === "cdp") {
      const cdpParams = rest[1] ? JSON.parse(rest[1]) : {};
      result = await client.sendCdp(sub, rest[0], cdpParams);
    } else if (cmd === "network" && sub === "set") {
      const mode = typeof flags.mode === "string" ? flags.mode : "strict_tunnel";
      result = await client.setTunnel({
        scope: typeof flags.scope === "string" ? flags.scope : "browser",
        mode,
        endpoint: typeof flags.endpoint === "string" ? flags.endpoint : undefined,
        dohServer: typeof flags.doh === "string" ? flags.doh : undefined,
        failClosed:
          flags["fail-closed"] !== undefined
            ? flags["fail-closed"] !== "false"
            : mode === "strict_tunnel",
      });
    } else if (cmd === "network" && sub === "status") {
      result = await client.getNetworkStatus(rest[0]);
    } else if (cmd === "privacy" && sub === "get") {
      const net = await client.getNetworkStatus().catch(() => ({ routes: [] }));
      result = { ...getPrivacyShieldState(), activeRoutes: net.routes || [] };
    } else if (cmd === "privacy" && sub === "set") {
      const patch = {};
      if (typeof flags.level === "string") patch.level = flags.level;
      else if (rest[0] && ["off", "standard", "strict"].includes(rest[0])) patch.level = rest[0];
      for (const key of PRIVACY_SHIELD_FLAG_KEYS) {
        if (flags[key] !== undefined) {
          patch[key] = flags[key] === true || flags[key] === "true";
        }
      }
      result = updatePrivacyShield(patch, { actor: "ai" });
    } else if (cmd === "privacy" && sub === "audit") {
      const pageId = rest[0];
      if (!pageId) throw new Error("Usage: gador-ctl privacy audit <pageId>");
      const evalRes = await client.sendCdp(pageId, "Runtime.evaluate", {
        expression: buildPrivacyAuditExpression(),
        returnByValue: true,
      });
      const raw = evalRes?.result?.value;
      const pageSignals = typeof raw === "string" ? JSON.parse(raw) : raw || {};
      const net = await client.getNetworkStatus().catch(() => ({ routes: [] }));
      result = {
        pageId,
        configuredShield: getPrivacyShieldState().privacyShield,
        pageSignals,
        networkRoutes: net.routes || [],
      };
    } else if (cmd === "rpc") {
      const params = rest[0] ? JSON.parse(rest[0]) : {};
      result = await client.call(sub, params);
    } else {
      throw new Error(`Unknown command: ${positionals.join(" ")}`);
    }

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      error: err.message,
      code: err.code || "ERR_CLI",
    }) + "\n"
  );
  process.exit(1);
});
