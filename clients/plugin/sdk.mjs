import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentKernelClient } from "../protocol/index.mjs";
import { executeSitePlugin, loadSitePlugins } from "../mcp-server/site-plugins.mjs";
import { CORE_MCP_TOOLS } from "../mcp-server/tools.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DEFAULT_SKILL_PATH = path.join(REPO_ROOT, "clients/skills/gador/SKILL.md");
const DEFAULT_PLUGINS_DIR = path.join(REPO_ROOT, "clients/site-plugins");

export function resolveDefaultGadorSocket() {
  if (process.env.AGENT_KERNEL_SOCKET) {
    return process.env.AGENT_KERNEL_SOCKET;
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "gador", "ctl.sock");
  }
  return "/tmp/gador/ctl.sock";
}

/**
 * Universal Function-Calling & Agent Framework Plugin for `gador`.
 * Exposes identical core kernel tools + declarative Site Plugins in
 * OpenAI/Gemini, Anthropic, and generic JSON Schema formats, plus
 * Skill prompt injection for zero-config Agent onboarding.
 */
export function createGadorPlugin({
  socketPath = resolveDefaultGadorSocket(),
  pluginsDir = DEFAULT_PLUGINS_DIR,
  skillPath = DEFAULT_SKILL_PATH,
} = {}) {
  const client = new AgentKernelClient({ socketPath });
  const sitePlugins = loadSitePlugins(pluginsDir);
  const registry = new Map();

  for (const tool of CORE_MCP_TOOLS) {
    registry.set(tool.name, { kind: "core", def: tool });
  }
  for (const plugin of sitePlugins) {
    registry.set(plugin.mcpName, { kind: "site_plugin", def: plugin });
  }

  function listToolSchemas() {
    const out = [];
    for (const [name, entry] of registry) {
      out.push({
        name,
        description: entry.def.description,
        inputSchema: entry.def.inputSchema,
      });
    }
    return out;
  }

  return {
    name: "gador-agent-plugin",
    version: "0.1.0",
    socketPath,

    async connect() {
      await client.connect();
    },

    async close() {
      await client.close();
    },

    getSystemSkillPrompt() {
      return fs.readFileSync(skillPath, "utf8");
    },

    listTools() {
      return listToolSchemas();
    },

    // OpenAI / Gemini / DeepSeek / OpenRouter tool format
    toOpenAITools() {
      return listToolSchemas().map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    },

    // Anthropic Claude tool_use format
    toAnthropicTools() {
      return listToolSchemas().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    },

    async executeTool(name, args = {}) {
      const entry = registry.get(name);
      if (!entry) {
        const err = new Error(`Unknown gador tool: ${name}`);
        err.code = "ERR_METHOD_NOT_FOUND";
        throw err;
      }
      if (entry.kind === "core") {
        return entry.def.invoke(client, args);
      }
      return executeSitePlugin(client, entry.def, args);
    },
  };
}
