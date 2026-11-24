import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getModulesState } from "../../modules/registry.mjs";
import { AgentKernelClient } from "../protocol/index.mjs";
import { getPrivacyShieldState } from "../protocol/privacy-shield-store.mjs";
import { getVpnStoreState } from "../protocol/vpn-store.mjs";
import { executeSitePlugin, loadSitePlugins } from "./site-plugins.mjs";
import { CORE_MCP_TOOLS } from "./tools.mjs";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "gador-mcp", version: "0.1.0" };

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const SKILL_PATH = path.join(REPO_ROOT, "clients/skills/gador/SKILL.md");
const SITE_PLUGINS_DIR = path.join(REPO_ROOT, "clients/site-plugins");

const MCP_PROMPTS = [
  {
    name: "start_shared_task",
    description:
      "Guide the Agent to run a task reusing the user's logged-in browser state without disturbing personal tabs.",
    arguments: [
      { name: "goal", description: "Task description", required: true },
    ],
  },
  {
    name: "start_private_vpn_task",
    description:
      "Guide the Agent to open a zero-cookie private AgentSpace bound to a strict Fail-Closed VPN tunnel.",
    arguments: [
      { name: "endpoint", description: "VPN endpoint URL (e.g. socks5://127.0.0.1:10808)", required: true },
      { name: "goal", description: "Task description", required: true },
    ],
  },
  {
    name: "request_human_takeover",
    description:
      "Guide the Agent to safely hand off CAPTCHA, 2FA, or sensitive confirmation to the user.",
    arguments: [
      { name: "spaceId", description: "Active AgentSpace ID", required: true },
      { name: "reason", description: "Why human input is required", required: true },
    ],
  },
  {
    name: "debug_environment_privacy",
    description:
      "Guide the Agent to audit browser fingerprint/environment signals on a page and compare off/standard/strict Privacy Shield profiles.",
    arguments: [
      { name: "pageId", description: "Agent-owned pageId to audit", required: true },
    ],
  },
];

export class GadorMcpServer {
  #client;
  #sitePlugins;
  #toolMap = new Map();

  constructor({ socketPath, pluginsDir = SITE_PLUGINS_DIR } = {}) {
    this.#client = new AgentKernelClient({ socketPath });
    this.#sitePlugins = loadSitePlugins(pluginsDir);

    for (const tool of CORE_MCP_TOOLS) {
      this.#toolMap.set(tool.name, { kind: "core", def: tool });
    }
    for (const plugin of this.#sitePlugins) {
      this.#toolMap.set(plugin.mcpName, { kind: "site_plugin", def: plugin });
    }
  }

  async connectKernel() {
    await this.#client.connect();
  }

  async close() {
    await this.#client.close();
  }

  async handleRpcMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: expected JSON-RPC object" },
      };
    }
    // Notifications have no id and expect no response.
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) {
      return null;
    }
    if (typeof msg.method !== "string" || !msg.method) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32600, message: "Invalid Request: missing method string" },
      };
    }
    if (
      msg.params !== undefined &&
      (msg.params === null || typeof msg.params !== "object" || Array.isArray(msg.params))
    ) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "Invalid params: expected JSON object" },
      };
    }

    try {
      const result = await this.#dispatch(msg.method, msg.params || {});
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: err.rpcCode || -32603,
          message: err.message || "Internal MCP error",
          data: err.code ? { kernelErrorCode: err.code } : undefined,
        },
      };
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        };

      case "ping":
        return {};

      case "tools/list": {
        const tools = [];
        for (const [name, entry] of this.#toolMap) {
          tools.push({
            name,
            description: entry.def.description,
            inputSchema: entry.def.inputSchema,
          });
        }
        return { tools };
      }

      case "tools/call": {
        const name = params.name;
        const args = params.arguments || {};
        const entry = this.#toolMap.get(name);
        if (!entry) {
          const e = new Error(`Unknown MCP tool: ${name}`);
          e.rpcCode = -32602;
          throw e;
        }
        try {
          let payload;
          if (entry.kind === "core") {
            payload = await entry.def.invoke(this.#client, args);
          } else {
            payload = await this.#executeSitePlugin(entry.def, args);
          }
          if (payload && payload.__mcpImage && payload.data) {
            return {
              content: [
                { type: "image", data: payload.data, mimeType: payload.mimeType || "image/png" },
                { type: "text", text: JSON.stringify({ pageId: payload.pageId, captured: true }) },
              ],
              isError: false,
            };
          }
          return {
            content: [
              { type: "text", text: JSON.stringify(payload, null, 2) },
            ],
            isError: false,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: err.message,
                    code: err.code || "ERR_INTERNAL",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "resources/list":
        return {
          resources: [
            {
              uri: "gador://skill",
              name: "gador SKILL.md Guide",
              description: "Canonical Agent operating guide and error code reference.",
              mimeType: "text/markdown",
            },
            {
              uri: "gador://spaces",
              name: "Active AgentSpaces",
              description: "Live list of isolated AgentSpaces and control states.",
              mimeType: "application/json",
            },
            {
              uri: "gador://pages",
              name: "Active Agent Pages",
              description: "Live list of Agent-owned pages detached from personal tabs.",
              mimeType: "application/json",
            },
            {
              uri: "gador://network",
              name: "Independent VPN Tunnel Status",
              description: "Live tunnel routes, OS-proxy override state, and Fail-Closed health.",
              mimeType: "application/json",
            },
            {
              uri: "gador://vpn-profiles",
              name: "VPN-Only Editable Profiles & Backups",
              description: "Saved VPN profiles and pre-modify backup snapshots (only VPN config is editable by AI).",
              mimeType: "application/json",
            },
            {
              uri: "gador://privacy-shield",
              name: "Privacy & Anti-Fingerprinting Shield Policy",
              description: "Current browser anti-fingerprinting preset (off/standard/strict) and individual protection flags.",
              mimeType: "application/json",
            },
            {
              uri: "gador://modules",
              name: "Optional Pluggable Modules Registry",
              description: "Installation and integration status of optional Gador modules (vpn, privacy-shield).",
              mimeType: "application/json",
            },
          ],
        };

      case "resources/read": {
        const uri = params.uri;
        if (uri === "gador://skill") {
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: fs.readFileSync(SKILL_PATH, "utf8"),
              },
            ],
          };
        }
        if (uri === "gador://spaces") {
          const data = await this.#client.listSpaces();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        if (uri === "gador://pages") {
          const data = await this.#client.listPages();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        if (uri === "gador://network") {
          const data = await this.#client.getNetworkStatus();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        if (uri === "gador://vpn-profiles") {
          const data = getVpnStoreState();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        if (uri === "gador://privacy-shield") {
          const data = getPrivacyShieldState();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        if (uri === "gador://modules") {
          const data = getModulesState();
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
          };
        }
        const e = new Error(`Unknown resource URI: ${uri}`);
        e.rpcCode = -32602;
        throw e;
      }

      case "prompts/list":
        return { prompts: MCP_PROMPTS };

      case "prompts/get": {
        const name = params.name;
        const args = params.arguments || {};
        if (name === "start_shared_task") {
          return {
            description: "Shared-login AgentSpace workflow",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Read gador://skill first, call browser_capabilities, create an AgentSpace with authMode='shared', and complete: ${args.goal || ""}. If you hit CAPTCHA/2FA or receive ERR_HUMAN_IN_CONTROL, pause and wait for human takeover release.`,
                },
              },
            ],
          };
        }
        if (name === "start_private_vpn_task") {
          return {
            description: "Isolated private AgentSpace with strict Fail-Closed VPN exit",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Create an AgentSpace with authMode='private', bind space:<spaceId> via network_set_tunnel (mode='strict_tunnel', endpoint='${args.endpoint || ""}', failClosed=true), and execute: ${args.goal || ""}.`,
                },
              },
            ],
          };
        }
        if (name === "request_human_takeover") {
          return {
            description: "Safe human handoff",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Call takeover_request on spaceId='${args.spaceId || ""}' with reason='${args.reason || "human_verification_required"}' and wait until the user finishes and returns control.`,
                },
              },
            ],
          };
        }
        if (name === "debug_environment_privacy") {
          return {
            description: "Browser environment and anti-fingerprinting audit workflow",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `1) Call privacy_shield_get to read the active preset. 2) Call privacy_audit_page on pageId='${args.pageId || ""}' to collect navigator/GPC/Canvas/WebGL/Audio/viewport signals. 3) If debugging site compatibility, switch via privacy_shield_set (off/standard/strict), reload the page, and re-audit. Never bypass CAPTCHAs or access controls; call takeover_request when human verification appears.`,
                },
              },
            ],
          };
        }
        const e = new Error(`Unknown prompt: ${name}`);
        e.rpcCode = -32602;
        throw e;
      }

      default: {
        const e = new Error(`Method not found: ${method}`);
        e.rpcCode = -32601;
        throw e;
      }
    }
  }

  async #executeSitePlugin(plugin, args) {
    return executeSitePlugin(this.#client, plugin, args);
  }

  serveStdio(input = process.stdin, output = process.stdout) {
    const MAX_MCP_FRAME_BYTES = 1024 * 1024; // 1 MiB hard cap per JSON-RPC stdio line
    let chunks = [];
    let bufferedBytes = 0;
    let discardingOversize = false;

    const handleLine = async (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        output.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }) + "\n"
        );
        return;
      }
      const response = await this.handleRpcMessage(msg);
      if (response) {
        output.write(JSON.stringify(response) + "\n");
      }
    };

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          const piece = buf.subarray(start, i);
          start = i + 1;
          if (discardingOversize || bufferedBytes + piece.length > MAX_MCP_FRAME_BYTES) {
            chunks = [];
            bufferedBytes = 0;
            discardingOversize = false;
            output.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32600,
                  message: `Request frame too large (max ${MAX_MCP_FRAME_BYTES} bytes)`,
                  data: { code: "ERR_FRAME_TOO_LARGE" },
                },
              }) + "\n"
            );
          } else {
            chunks.push(piece);
            const line = Buffer.concat(chunks).toString("utf8");
            chunks = [];
            bufferedBytes = 0;
            handleLine(line);
          }
        }
      }
      if (start < buf.length) {
        const rest = buf.subarray(start);
        if (discardingOversize || bufferedBytes + rest.length > MAX_MCP_FRAME_BYTES) {
          chunks = [];
          bufferedBytes = 0;
          discardingOversize = true;
        } else {
          chunks.push(rest);
          bufferedBytes += rest.length;
        }
      }
    };

    const controller = new EventEmitter();
    let closed = false;
    const emitClose = () => {
      if (closed) return;
      closed = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", emitClose);
      controller.emit("close");
    };
    const onEnd = () => {
      if (!discardingOversize && bufferedBytes > 0) {
        const tail = Buffer.concat(chunks).toString("utf8");
        chunks = [];
        bufferedBytes = 0;
        handleLine(tail);
      }
      emitClose();
    };
    controller.close = emitClose;

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", emitClose);
    return controller;
  }
}
