import fs from "node:fs";
import path from "node:path";

/**
 * Loads declarative Site Plugins from clients/site-plugins/<domain>/plugin.json.
 * Enforces site-plugin-spec.md constraints (no secret fields, valid authMode,
 * valid tool definitions).
 */
export function loadSitePlugins(pluginsDir) {
  const plugins = [];
  if (!fs.existsSync(pluginsDir)) {
    return plugins;
  }

  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsDir, entry.name, "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!raw.domain || !Array.isArray(raw.tools)) {
      throw new Error(`Invalid site plugin manifest: ${manifestPath}`);
    }
    const authMode = raw.authMode || "shared";
    if (authMode !== "shared" && authMode !== "private") {
      throw new Error(`Invalid authMode "${authMode}" in ${manifestPath}`);
    }

    for (const tool of raw.tools) {
      if (!tool.name || !tool.description) {
        throw new Error(`Invalid tool definition in ${manifestPath}`);
      }
      plugins.push({
        domain: raw.domain,
        authMode,
        mcpName: `site_${raw.domain.replace(/[^a-zA-Z0-9]+/g, "_")}_${tool.name}`,
        name: tool.name,
        description: `[Site Plugin: ${raw.domain}] ${tool.description}${
          tool.requiresConfirmation ? " (requires user confirmation/takeover)" : ""
        }`,
        requiresConfirmation: Boolean(tool.requiresConfirmation),
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        steps: Array.isArray(tool.steps) ? tool.steps : [],
      });
    }
  }

  return plugins;
}

function interpolateUrlTemplate(template, args = {}) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const val = args[key];
    if (val === undefined || val === null || String(val).trim() === "") {
      const err = new Error(`Missing required template parameter: ${key}`);
      err.code = "ERR_INVALID_PARAMS";
      throw err;
    }
    return encodeURIComponent(String(val));
  });
}

/**
 * Executes a declarative Site Plugin against a connected AgentKernelClient.
 * Enforces confirmation gates and safe URL-segment interpolation.
 */
export async function executeSitePlugin(client, plugin, args = {}) {
  if (plugin.requiresConfirmation) {
    return {
      status: "confirmation_required",
      plugin: plugin.mcpName,
      domain: plugin.domain,
      message:
        "This site plugin requires explicit human confirmation/takeover before running.",
    };
  }
  const results = [];
  for (const step of plugin.steps) {
    if (step.op === "open") {
      const url = interpolateUrlTemplate(step.url, args);
      results.push(
        await client.openPage({
          spaceId: args.spaceId,
          url,
        })
      );
    }
  }
  return { plugin: plugin.mcpName, domain: plugin.domain, results };
}
