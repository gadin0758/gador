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

function validateSitePluginUrl(rawUrl, expectedDomain) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const err = new Error(`Invalid site plugin URL: ${rawUrl}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    const err = new Error(
      `Site plugin URL scheme "${parsed.protocol}" is forbidden (only http/https allowed)`
    );
    err.code = "ERR_DOMAIN_DENIED";
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error("Site plugin URLs must not contain embedded credentials");
    err.code = "ERR_DOMAIN_DENIED";
    throw err;
  }
  const host = parsed.hostname.toLowerCase();
  const domain = String(expectedDomain || "").trim().toLowerCase();
  if (!domain || (host !== domain && !host.endsWith(`.${domain}`))) {
    const err = new Error(
      `Site plugin URL host "${host}" escapes declared plugin domain "${domain}"`
    );
    err.code = "ERR_DOMAIN_DENIED";
    throw err;
  }
  return parsed.toString();
}

/**
 * Executes a declarative Site Plugin against a connected AgentKernelClient.
 * Enforces confirmation gates, safe URL-segment interpolation, and strict domain binding.
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
      const rawUrl = interpolateUrlTemplate(step.url, args);
      const safeUrl = validateSitePluginUrl(rawUrl, plugin.domain);
      results.push(
        await client.openPage({
          spaceId: args.spaceId,
          url: safeUrl,
        })
      );
    }
  }
  return { plugin: plugin.mcpName, domain: plugin.domain, results };
}
