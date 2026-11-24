import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DAEMON_BIN = path.join(REPO_ROOT, "build/agent_kernel_daemon");
const MCP_ENTRY = path.join(REPO_ROOT, "clients/mcp-server/index.mjs");

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

function createMcpStdioHarness(socketPath) {
  const proc = spawn(process.execPath, [MCP_ENTRY], {
    env: { ...process.env, AGENT_KERNEL_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP request ${method} timed out. stderr=${stderr}`)),
          5000
        );
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
        );
      });
    },
    notify(method, params = {}) {
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
      );
    },
    async close() {
      rl.close();
      proc.stdin.end();
      if (proc.exitCode === null) {
        await new Promise((r) => proc.once("exit", r));
      }
    },
  };
}

test("MCP Server E2E Gate: stdio MCP <-> real C++20 POSIX UDS kernel daemon (Tools, Resources, Prompts, Site Plugins, Dual-Auth, Takeover, VPN)", async (t) => {
  assert.ok(
    fs.existsSync(DAEMON_BIN),
    `Missing compiled C++ daemon at ${DAEMON_BIN}; run 'npm run test:cpp' first`
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-mcp-e2e-"));
  const socketPath = path.join(tmpDir, "ctl.sock");
  const daemon = await startCppDaemon(socketPath);
  const mcp = createMcpStdioHarness(socketPath);

  t.after(async () => {
    await mcp.close();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Handshake
  const init = await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "test-harness", version: "1.0.0" },
    capabilities: {},
  });
  assert.equal(init.serverInfo.name, "gador-mcp");
  mcp.notify("notifications/initialized");

  // 2. Tools list includes all core kernel tools + declarative Site Plugin
  const { tools } = await mcp.request("tools/list");
  const toolNames = new Set(tools.map((x) => x.name));
  assert.ok(toolNames.has("browser_capabilities"));
  assert.ok(toolNames.has("space_create"));
  assert.ok(toolNames.has("page_attach_view"));
  assert.ok(toolNames.has("network_set_tunnel"));
  assert.ok(toolNames.has("site_example_com_open_homepage"));

  // 3. Resources expose SKILL.md so any MCP Agent can self-onboard
  const { resources } = await mcp.request("resources/list");
  assert.ok(resources.some((r) => r.uri === "gador://skill"));
  const skillRes = await mcp.request("resources/read", {
    uri: "gador://skill",
  });
  assert.ok(skillRes.contents[0].text.includes("ERR_HUMAN_IN_CONTROL"));
  assert.ok(skillRes.contents[0].text.includes("network.setTunnel"));

  // 4. Prompts list & fetch
  const { prompts } = await mcp.request("prompts/list");
  assert.ok(prompts.some((p) => p.name === "start_private_vpn_task"));
  const promptMsg = await mcp.request("prompts/get", {
    name: "start_private_vpn_task",
    arguments: { endpoint: "socks5://127.0.0.1:10808", goal: "check ip" },
  });
  assert.ok(promptMsg.messages[0].content.text.includes("strict_tunnel"));

  // 5. Dual-mode auth + Site Plugin execution + Takeover freeze + VPN policy via MCP -> C++20 UDS
  const sharedRes = await mcp.request("tools/call", {
    name: "space_create",
    arguments: { name: "mcp-shared", authMode: "shared" },
  });
  assert.equal(sharedRes.isError, false);
  const shared = JSON.parse(sharedRes.content[0].text);

  const privRes = await mcp.request("tools/call", {
    name: "space_create",
    arguments: { name: "mcp-private", authMode: "private" },
  });
  const priv = JSON.parse(privRes.content[0].text);

  // Use declarative Site Plugin on private space
  const pluginRes = await mcp.request("tools/call", {
    name: "site_example_com_open_homepage",
    arguments: { spaceId: priv.spaceId },
  });
  assert.equal(pluginRes.isError, false);
  const pluginData = JSON.parse(pluginRes.content[0].text);
  const privPageId = pluginData.results[0].pageId;

  const sharedPage = JSON.parse(
    (
      await mcp.request("tools/call", {
        name: "page_open",
        arguments: { spaceId: shared.spaceId, url: "https://example.com" },
      })
    ).content[0].text
  );

  // Verify shared cookies vs zero private cookies
  const sharedCookies = JSON.parse(
    (
      await mcp.request("tools/call", {
        name: "cdp_send",
        arguments: { pageId: sharedPage.pageId, cdpMethod: "Network.getCookies" },
      })
    ).content[0].text
  );
  const privCookies = JSON.parse(
    (
      await mcp.request("tools/call", {
        name: "cdp_send",
        arguments: { pageId: privPageId, cdpMethod: "Network.getCookies" },
      })
    ).content[0].text
  );
  assert.ok(sharedCookies.cookies.some((c) => c.name === "ba_session"));
  assert.equal(privCookies.cookies.length, 0);

  // Personal tab scope isolation returns structured isError with ERR_TARGET_OUT_OF_SCOPE
  const oos = await mcp.request("tools/call", {
    name: "cdp_send",
    arguments: { pageId: "personal_tab_0", cdpMethod: "Page.navigate" },
  });
  assert.equal(oos.isError, true);
  assert.equal(JSON.parse(oos.content[0].text).code, "ERR_TARGET_OUT_OF_SCOPE");

  // Active user takeover freezes MCP writes -> release resumes
  await mcp.request("tools/call", {
    name: "page_attach_view",
    arguments: { pageId: sharedPage.pageId, interactive: true },
  });
  const frozen = await mcp.request("tools/call", {
    name: "cdp_send",
    arguments: { pageId: sharedPage.pageId, cdpMethod: "Page.navigate" },
  });
  assert.equal(frozen.isError, true);
  assert.equal(JSON.parse(frozen.content[0].text).code, "ERR_HUMAN_IN_CONTROL");

  await mcp.request("tools/call", {
    name: "takeover_release",
    arguments: { spaceId: shared.spaceId },
  });

  // Independent VPN configuration + live resource check
  const vpnRes = await mcp.request("tools/call", {
    name: "network_set_tunnel",
    arguments: {
      scope: `space:${priv.spaceId}`,
      mode: "strict_tunnel",
      endpoint: "socks5://127.0.0.1:10808",
      failClosed: true,
    },
  });
  assert.equal(vpnRes.isError, false);
  const netResource = JSON.parse(
    (
      await mcp.request("resources/read", { uri: "gador://network" })
    ).contents[0].text
  );
  assert.ok(netResource.routes.some((r) => r.scope === `space:${priv.spaceId}`));
});
