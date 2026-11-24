import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGadorPlugin } from "../../clients/plugin/sdk.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DAEMON_BIN = path.join(REPO_ROOT, "build/agent_kernel_daemon");
const CLI_ENTRY = path.join(REPO_ROOT, "clients/cli/gador-ctl.mjs");
const INSTALL_ENTRY = path.join(REPO_ROOT, "clients/plugin/install.mjs");

async function startCppDaemon(socketPath) {
  const proc = spawn(DAEMON_BIN, [socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`C++ daemon timeout: ${stderr}`)),
      5000
    );
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      if (stdout.includes("READY ")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`C++ daemon exited early (${code}): ${stderr}`));
    });
  });
  return {
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => proc.once("exit", r));
      }
    },
  };
}

function runCli(socketPath, args) {
  const raw = execFileSync(
    process.execPath,
    [CLI_ENTRY, "--socket", socketPath, ...args],
    { encoding: "utf8" }
  );
  return JSON.parse(raw);
}

test("Plugin Manifest, Universal SDK, Site Plugins, Installer, and gador-ctl CLI E2E Gate", async (t) => {
  // 1. Validate plugin.json and .mcp.json manifests
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "clients/plugin/plugin.json"), "utf8")
  );
  const mcpJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "clients/plugin/.mcp.json"), "utf8")
  );
  assert.equal(manifest.name, "gador");
  assert.ok(manifest.skills.includes("../skills/gador"));
  assert.ok(mcpJson.mcpServers.gador.command === "node");

  // 2. Validate skill installer dry-run works without mutating home dir
  const dryRunOut = JSON.parse(
    execFileSync(process.execPath, [INSTALL_ENTRY, "--all", "--dry-run"], {
      encoding: "utf8",
    })
  );
  assert.equal(dryRunOut.installedSkills.length, 3);
  assert.ok(dryRunOut.installedSkills.every((x) => x.dryRun === true));

  // 3. Spin up real C++20 UDS daemon for CLI + Universal Plugin SDK E2E checks
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-plugin-cli-"));
  const socketPath = path.join(tmpDir, "ctl.sock");
  const daemon = await startCppDaemon(socketPath);
  const plugin = createGadorPlugin({ socketPath });

  t.after(async () => {
    await plugin.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 4. Test gador-ctl CLI end-to-end against C++20 UDS daemon
  const cliCaps = runCli(socketPath, ["capabilities"]);
  assert.equal(cliCaps.runtimeMode, "daemon");
  assert.equal(cliCaps.windowShownByDefault, false);

  const cliSpace = runCli(socketPath, [
    "space",
    "create",
    "--auth",
    "private",
    "--name",
    "cli-space",
  ]);
  assert.equal(cliSpace.authMode, "private");

  const cliVpn = runCli(socketPath, [
    "network",
    "set",
    "--scope",
    `space:${cliSpace.spaceId}`,
    "--mode",
    "strict_tunnel",
    "--endpoint",
    "socks5://127.0.0.1:10808",
    "--fail-closed",
  ]);
  assert.equal(cliVpn.osProxyDisabled, true);
  assert.equal(cliVpn.failClosed, true);

  const cliPage = runCli(socketPath, [
    "page",
    "open",
    cliSpace.spaceId,
    "https://example.com",
  ]);
  assert.ok(cliPage.pageId);
  assert.equal(cliPage.viewAttached, false);

  runCli(socketPath, ["space", "close", cliSpace.spaceId]);

  // 5. Test Universal Agent Plugin SDK (OpenAI + Anthropic + Site Plugin interpolation + confirmation gate)
  await plugin.connect();
  assert.ok(plugin.getSystemSkillPrompt().includes("# `gador`"));

  const openaiTools = plugin.toOpenAITools();
  const anthropicTools = plugin.toAnthropicTools();
  assert.ok(openaiTools.some((x) => x.type === "function" && x.function.name === "browser_capabilities"));
  assert.ok(openaiTools.some((x) => x.function.name === "site_github_com_open_pulls"));
  assert.ok(anthropicTools.some((x) => x.name === "space_create" && x.input_schema.type === "object"));

  const shared = await plugin.executeTool("space_create", {
    name: "sdk-shared",
    authMode: "shared",
  });
  const prOpen = await plugin.executeTool("site_github_com_open_pulls", {
    spaceId: shared.spaceId,
    owner: "chromium",
    repo: "chromium",
  });
  assert.equal(prOpen.domain, "github.com");
  assert.equal(prOpen.results[0].url, "https://github.com/chromium/chromium/pulls");

  // Confirmation-gated Site Plugin must NOT mutate without human confirmation
  const gated = await plugin.executeTool("site_github_com_open_new_issue", {
    spaceId: shared.spaceId,
    owner: "chromium",
    repo: "chromium",
  });
  assert.equal(gated.status, "confirmation_required");

  await plugin.executeTool("space_close", { spaceId: shared.spaceId });
});
