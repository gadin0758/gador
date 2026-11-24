import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GadorMcpServer } from "../../clients/mcp-server/server.mjs";
import { AgentKernelClient } from "../../clients/protocol/index.mjs";
import { startGadorUiServer } from "../../clients/ui/server.mjs";
import { installModule, setModuleEnabled, uninstallModule } from "../../modules/registry.mjs";
import { openModuleSecretVault } from "../../modules/secret-vault.mjs";
import {
  addTrustedPublisherKey,
  generatePublisherKeyPair,
  signModuleDirectory,
  verifyModulePackage,
} from "../../modules/verifier.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DAEMON_BIN = path.join(REPO_ROOT, "build/agent_kernel_daemon");
const EXTERNAL_SOCKET = process.env.AGENT_KERNEL_SOCKET || "";

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

test("Comprehensive Settings, Personalization, Space Separation, VPN Archive/Backup, Skill & Extension Gate", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gador-full-suite-"));
  const vpnStoreDir = path.join(tmpDir, "vpn-store");
  const privacyShieldFile = path.join(tmpDir, "privacy-shield.json");
  const modulesFile = path.join(tmpDir, "modules.json");
  const modulesDir = path.join(tmpDir, "installed-modules");
  const moduleAuthFile = path.join(tmpDir, "module-auth.json");
  const moduleAuditLog = path.join(tmpDir, "module-audit.log");
  const prevVpnEnv = process.env.GADOR_VPN_STORE_DIR;
  const prevPrivacyEnv = process.env.GADOR_PRIVACY_SHIELD_FILE;
  const prevModulesFileEnv = process.env.GADOR_MODULES_FILE;
  const prevModulesDirEnv = process.env.GADOR_MODULES_DIR;
  const prevModuleAuthEnv = process.env.GADOR_MODULE_AUTH_FILE;
  const prevModuleAuditEnv = process.env.GADOR_MODULE_AUDIT_LOG;
  process.env.GADOR_VPN_STORE_DIR = vpnStoreDir;
  process.env.GADOR_PRIVACY_SHIELD_FILE = privacyShieldFile;
  process.env.GADOR_MODULES_FILE = modulesFile;
  process.env.GADOR_MODULES_DIR = modulesDir;
  process.env.GADOR_MODULE_AUTH_FILE = moduleAuthFile;
  process.env.GADOR_MODULE_AUDIT_LOG = moduleAuditLog;

  let socketPath = EXTERNAL_SOCKET;
  let daemon = null;
  if (!socketPath) {
    socketPath = path.join(tmpDir, "ctl.sock");
    daemon = await startCppDaemon(socketPath);
  }

  const launchedCalls = [];
  const ui = await startGadorUiServer({
    socketPath,
    port: 0,
    launchNative: async (info) => {
      launchedCalls.push(info);
    },
  });

  t.after(async () => {
    await ui.close();
    if (daemon) await daemon.stop();
    if (prevVpnEnv === undefined) delete process.env.GADOR_VPN_STORE_DIR;
    else process.env.GADOR_VPN_STORE_DIR = prevVpnEnv;
    if (prevPrivacyEnv === undefined) delete process.env.GADOR_PRIVACY_SHIELD_FILE;
    else process.env.GADOR_PRIVACY_SHIELD_FILE = prevPrivacyEnv;
    if (prevModulesFileEnv === undefined) delete process.env.GADOR_MODULES_FILE;
    else process.env.GADOR_MODULES_FILE = prevModulesFileEnv;
    if (prevModulesDirEnv === undefined) delete process.env.GADOR_MODULES_DIR;
    else process.env.GADOR_MODULES_DIR = prevModulesDirEnv;
    if (prevModuleAuthEnv === undefined) delete process.env.GADOR_MODULE_AUTH_FILE;
    else process.env.GADOR_MODULE_AUTH_FILE = prevModuleAuthEnv;
    if (prevModuleAuditEnv === undefined) delete process.env.GADOR_MODULE_AUDIT_LOG;
    else process.env.GADOR_MODULE_AUDIT_LOG = prevModuleAuditEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Settings Native Tools & Google Account Launchers (ALL 11 entries + Incognito + Rejects)
  // -------------------------------------------------------------------------
  await t.test("1. All 11 Settings native browser tools, Google Account, Incognito & URL security filter", async () => {
    const html = await (await fetch(`${ui.url}/`)).text();
    const nativeUrls = [...html.matchAll(/data-open-native="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(nativeUrls.length >= 25, `Expected >= 25 native browser tool buttons in Settings, got ${nativeUrls.length}`);
    for (const mustHave of [
      "https://accounts.google.com",
      "https://chromewebstore.google.com",
      "chrome://settings/search",
      "chrome://settings/onStartup",
      "chrome://settings/defaultBrowser",
      "chrome://settings/content",
      "chrome://settings/downloads",
      "chrome://settings/appearance",
      "chrome://settings/fonts",
      "chrome://settings/performance",
      "chrome://settings/system",
      "chrome://settings/languages",
      "chrome://password-manager/passwords",
      "chrome://settings/payments",
      "chrome://extensions",
      "chrome://extensions/shortcuts",
      "chrome://bookmarks",
      "chrome://history",
      "chrome://settings/clearBrowserData",
      "chrome://settings/importData",
      "chrome://settings/reset",
      "chrome://version",
    ]) {
      assert.ok(nativeUrls.includes(mustHave), `Missing native browser tool launcher: ${mustHave}`);
    }

    for (const targetUrl of nativeUrls) {
      const res = await fetch(`${ui.url}/api/user/open-native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      assert.equal(res.status, 200, `Native launcher failed for ${targetUrl}`);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.launched, targetUrl);
    }

    assert.equal(launchedCalls.length, nativeUrls.length);
    for (const call of launchedCalls) {
      assert.equal(call.env.CHROME_DESKTOP, "gador.desktop");
      assert.equal(call.env.AGENT_KERNEL_DISABLE_IPC, "1");
      assert.ok(call.args.includes("--class=gador"));
      assert.ok(
        call.args.some((a) => a.startsWith("--user-data-dir=") && a.endsWith("/gador")),
        `Native launch must use ~/.config/gador profile, got: ${call.args.join(" ")}`
      );
      assert.ok(
        !call.args.some((a) => a.includes("chromium")),
        "Native launch must never target chromium profile"
      );
    }

    // Incognito window button beside Settings
    const incRes = await fetch(`${ui.url}/api/user/open-native`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "about:blank", incognito: true }),
    });
    assert.equal(incRes.status, 200);
    const incData = await incRes.json();
    assert.equal(incData.ok, true);
    assert.equal(incData.incognito, true);
    const lastLaunch = launchedCalls[launchedCalls.length - 1];
    assert.ok(lastLaunch.args.includes("--incognito"), "Incognito launch must pass --incognito");

    // Dangerous / disallowed URLs must return 400 JSON (never 404 text)
    for (const badUrl of ["javascript:alert(1)", "file:///etc/passwd", "chrome://kill"]) {
      const badRes = await fetch(`${ui.url}/api/user/open-native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: badUrl }),
      });
      assert.equal(badRes.status, 400);
      const badJson = await badRes.json();
      assert.equal(badJson.ok, false);
    }

    // Native C++ Appearance & Hot-Reloadable Config RPC (ui.getAppearance / ui.setAppearance)
    const getApp = await (
      await fetch(`${ui.url}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "ui.getAppearance", params: {} }),
      })
    ).json();
    assert.equal(getApp.ok, true);
    assert.equal(getApp.result.nativeUi.windowTitleSuffix, "Gador");

    const setApp = await (
      await fetch(`${ui.url}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "ui.setAppearance",
          params: { theme: "dark", accentColor: "#38bdf8", layout: "sidebar", showBookmarkBar: true },
        }),
      })
    ).json();
    assert.equal(setApp.ok, true);
    assert.equal(setApp.result.applied, true);
  });

  // -------------------------------------------------------------------------
  // 2. AI Hub & /api/skill Endpoint
  // -------------------------------------------------------------------------
  await t.test("2. /api/skill exposes SKILL.md, MCP config, link-scoped tools, and VPN-only tools", async () => {
    const res = await fetch(`${ui.url}/api/skill`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.skillContent.includes("gador"), "SKILL.md content missing");
    assert.ok(data.skillContent.includes("vpn_update_profile"), "SKILL.md missing VPN backup/update docs");
    const parsedMcp = JSON.parse(data.mcpConfigJson);
    assert.ok(parsedMcp.mcpServers?.gador?.command);
    const toolNames = new Set((data.tools || []).map((t) => t.name));
    for (const required of [
      "browser_navigate",
      "browser_snapshot",
      "browser_get_links",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_scroll",
      "browser_screenshot",
      "vpn_get_profiles",
      "vpn_backup_create",
      "vpn_update_profile",
      "vpn_delete_profile",
      "vpn_restore_backup",
      "privacy_shield_get",
      "privacy_shield_set",
      "privacy_audit_page",
      "module_list",
    ]) {
      assert.ok(toolNames.has(required), `Missing tool in /api/skill: ${required}`);
    }
    assert.ok(data.skillContent.includes("privacy_shield_get"), "SKILL.md missing privacy_shield_get docs");
    assert.ok(data.skillContent.includes("privacy_audit_page"), "SKILL.md missing privacy_audit_page docs");
    assert.ok(data.skillContent.includes("gador-mod install"), "SKILL.md missing standalone module install docs");
  });

  // -------------------------------------------------------------------------
  // 2b. Standalone Modules (VPN & Privacy Shield) Install/Toggle/Uninstall + Privacy Shield API/MCP
  // -------------------------------------------------------------------------
  await t.test("2b. Standalone VPN & Privacy-Shield modules require separate install/integration, then unlock HTTP + MCP", async () => {
    // 1. Fresh install: both optional modules start uninstalled & disabled, and sandbox container MUST NOT start!
    const modInit = await (await fetch(`${ui.url}/api/modules`)).json();
    assert.equal(modInit.ok, true);
    const vpnMod0 = modInit.modules.find((m) => m.id === "vpn");
    const psMod0 = modInit.modules.find((m) => m.id === "privacy-shield");
    assert.equal(vpnMod0?.installed, false);
    assert.equal(psMod0?.installed, false);
    assert.equal(modInit.sandbox.state, "STOPPED_IDLE");
    assert.equal(modInit.sandbox.activeCount, 0);

    // Attempting to probe sandbox when no modules are installed MUST fail (container stays stopped!)
    const idleProbe = await fetch(`${ui.url}/api/modules/privacy-shield/sandbox-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(idleProbe.status, 409);
    const sbStillIdle = await (await fetch(`${ui.url}/api/modules/sandbox`)).json();
    assert.equal(sbStillIdle.activeCount, 0);

    // Uninstalled privacy-shield rejects writes with 409 ERR_MODULE_NOT_INSTALLED
    const blockedWrite = await fetch(`${ui.url}/api/privacy-shield`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "strict" }),
    });
    assert.equal(blockedWrite.status, 409);
    const blockedJson = await blockedWrite.json();
    assert.equal(blockedJson.code, "ERR_MODULE_NOT_INSTALLED");

    // 2. Unverified direct install MUST be rejected (403 ERR_INSTALL_VERIFICATION_REQUIRED)
    const unverifiedRes = await fetch(`${ui.url}/api/modules/vpn/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable: true }),
    });
    assert.equal(unverifiedRes.status, 403);
    assert.equal((await unverifiedRes.json()).code, "ERR_INSTALL_VERIFICATION_REQUIRED");

    // Wrong confirmation code MUST be rejected (403 ERR_INSTALL_VERIFICATION_FAILED)
    const vpnCh = await (
      await fetch(`${ui.url}/api/modules/vpn/install-challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json();
    assert.equal(vpnCh.ok, true);
    assert.equal(vpnCh.verification.valid, true);
    assert.equal(vpnCh.verification.keyId, "gador-official-v1");

    const badCodeRes = await fetch(`${ui.url}/api/modules/vpn/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable: true, challengeId: vpnCh.challengeId, confirmCode: "GDR-WRONG" }),
    });
    assert.equal(badCodeRes.status, 403);
    assert.equal((await badCodeRes.json()).code, "ERR_INSTALL_VERIFICATION_FAILED");

    // Valid challenge + confirmation code succeeds
    const instVpn = await (
      await fetch(`${ui.url}/api/modules/vpn/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enable: true,
          challengeId: vpnCh.challengeId,
          confirmCode: vpnCh.confirmCode,
        }),
      })
    ).json();
    assert.equal(instVpn.ok, true);
    assert.equal(instVpn.verified, true);
    assert.equal(instVpn.module.installed, true);
    assert.equal(instVpn.module.enabled, true);

    // Enable local passphrase lock -> wrong passphrase rejected, right passphrase installs privacy-shield
    const setPinRes = await (
      await fetch(`${ui.url}/api/modules/auth/passphrase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: "gador-secret-pin" }),
      })
    ).json();
    assert.equal(setPinRes.ok, true);
    assert.equal(setPinRes.passphraseEnabled, true);

    const psCh = await (
      await fetch(`${ui.url}/api/modules/privacy-shield/install-challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json();
    assert.equal(psCh.ok, true);
    assert.equal(psCh.requiresPassphrase, true);

    const wrongPinRes = await fetch(`${ui.url}/api/modules/privacy-shield/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enable: true,
        challengeId: psCh.challengeId,
        confirmCode: psCh.confirmCode,
        passphrase: "wrong-pin",
      }),
    });
    assert.equal(wrongPinRes.status, 403);
    assert.equal((await wrongPinRes.json()).code, "ERR_INSTALL_VERIFICATION_FAILED");

    const instPs = await (
      await fetch(`${ui.url}/api/modules/privacy-shield/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enable: true,
          challengeId: psCh.challengeId,
          confirmCode: psCh.confirmCode,
          passphrase: "gador-secret-pin",
        }),
      })
    ).json();
    assert.equal(instPs.ok, true);
    assert.equal(instPs.verified, true);
    assert.equal(instPs.module.installed, true);
    assert.equal(instPs.module.enabled, true);
    assert.equal(instPs.module.extensionReady, true);
    assert.ok(fs.existsSync(path.join(instPs.module.extensionPath, "manifest.json")));

    // Post-install tamper check: modifying an installed file must immediately fail verification & disable extension loading
    const targetFile = path.join(instPs.module.installPath, "index.mjs");
    const origContent = fs.readFileSync(targetFile, "utf8");
    fs.writeFileSync(targetFile, origContent + "\n// tampered\n");
    const tamperVerify = verifyModulePackage(instPs.module.installPath, { expectedModuleId: "privacy-shield" });
    assert.equal(tamperVerify.valid, false);
    assert.equal(tamperVerify.code, "ERR_MODULE_SIGNATURE_INVALID");
    const tamperedDoctor = await (await fetch(`${ui.url}/api/modules/doctor`)).json();
    assert.equal(tamperedDoctor.ok, false);
    assert.equal(tamperedDoctor.enabledExtensionDirs.length, 0);
    // Restore original clean content and confirm healthy again
    fs.writeFileSync(targetFile, origContent);

    const doctor = await (await fetch(`${ui.url}/api/modules/doctor`)).json();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.enabledExtensionDirs.length, 1);
    assert.ok(fs.existsSync(moduleAuditLog));

    // Lightweight Bubblewrap Container Isolation & Auto-Stop Test
    const prevSbData = process.env.GADOR_SANDBOX_DATA_DIR;
    process.env.GADOR_SANDBOX_DATA_DIR = path.join(tmpDir, "sandbox-data");
    try {
      // Probe inside real isolated container for privacy-shield
      const probeRes = await (
        await fetch(`${ui.url}/api/modules/privacy-shield/sandbox-probe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json();
      assert.equal(probeRes.ok, true);
      assert.equal(probeRes.maxMemoryMb, 64);
      assert.equal(probeRes.allowNetwork, false);
      assert.equal(probeRes.probe.moduleCodeReadOnly, true, "Module source must be read-only inside container");
      assert.equal(probeRes.probe.dataDirWritable, true, "Isolated module dataDir must be writable");
      assert.equal(probeRes.probe.hostEnvCleared, true, "Host env variables must be cleared");
      if (probeRes.runtime === "bubblewrap") {
        assert.equal(probeRes.probe.pidNamespaceIsolated, true, "PID namespace must be isolated");
        assert.equal(probeRes.probe.hostHomeVisible, false, "Host $HOME must be invisible inside bwrap container");
        assert.equal(probeRes.probe.rootEtcShadowVisible, false, "/etc/shadow must be invisible");
        assert.equal(probeRes.probe.networkIsolated, true, "Network must be isolated by default");
      }

      // Execute lifecycle method inside container
      const execRes = await (
        await fetch(`${ui.url}/api/modules/privacy-shield/sandbox-exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "healthCheck", args: {} }),
        })
      ).json();
      assert.equal(execRes.ok, true);
      assert.equal(execRes.result.healthy, true);
      assert.equal(execRes.result.sandboxed, true);

      // Stopping containers returns cleanly to STOPPED_IDLE (0 active)
      const stopRes = await (
        await fetch(`${ui.url}/api/modules/sandbox/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json();
      assert.equal(stopRes.ok, true);
      assert.equal(stopRes.sandbox.state, "STOPPED_IDLE");
      assert.equal(stopRes.sandbox.activeCount, 0);
    } finally {
      if (prevSbData === undefined) delete process.env.GADOR_SANDBOX_DATA_DIR;
      else process.env.GADOR_SANDBOX_DATA_DIR = prevSbData;
    }

    // Mutual-exclusion conflict check: custom module in same exclusiveGroups ('fingerprint-engine') MUST be blocked while privacy-shield is enabled
    const prevTrustedEnv = process.env.GADOR_TRUSTED_KEYS_FILE;
    process.env.GADOR_TRUSTED_KEYS_FILE = path.join(tmpDir, "trusted-keys.json");
    try {
      const customDir = path.join(tmpDir, "custom-fp-conflict");
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(
        path.join(customDir, "module.json"),
        JSON.stringify({
          id: "custom-fp-conflict",
          name: "Custom Conflicting Fingerprint Module",
          version: "0.1.0",
          category: "privacy",
          compatibility: { exclusiveGroups: ["fingerprint-engine"], conflictsWith: [], requires: [] },
          integration: { extensionDir: null },
        }, null, 2) + "\n"
      );
      fs.writeFileSync(path.join(customDir, "index.mjs"), "export default {};\n");
      const kp = generatePublisherKeyPair();
      addTrustedPublisherKey("test-custom-v1", kp.publicKeyPem, "Test Publisher");
      const sigDoc = signModuleDirectory(customDir, { privateKeyPem: kp.privateKeyPem, keyId: "test-custom-v1" });

      // Attempting to install & enable while privacy-shield is enabled MUST throw ERR_MODULE_CONFLICT
      assert.throws(
        () =>
          installModule("custom-fp-conflict", {
            enable: true,
            sourceDir: customDir,
            confirmDigest: sigDoc.packageDigest.slice(0, 12),
            passphrase: "gador-secret-pin",
          }),
        (err) => err.code === "ERR_MODULE_CONFLICT"
      );

      // Install disabled succeeds, then trying to enable via HTTP toggle returns 409 ERR_MODULE_CONFLICT
      installModule("custom-fp-conflict", {
        enable: false,
        sourceDir: customDir,
        confirmDigest: sigDoc.packageDigest.slice(0, 12),
        passphrase: "gador-secret-pin",
      });
      const conflictToggle = await fetch(`${ui.url}/api/modules/custom-fp-conflict/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(conflictToggle.status, 409);
      const conflictJson = await conflictToggle.json();
      assert.equal(conflictJson.code, "ERR_MODULE_CONFLICT");
      assert.equal(conflictJson.conflictState.blocked, true);
      assert.equal(conflictJson.conflictState.blockedBy[0].moduleId, "privacy-shield");

      // Disable privacy-shield -> now custom module can enable, and privacy-shield becomes blocked!
      setModuleEnabled("privacy-shield", false);
      const enableOk = await fetch(`${ui.url}/api/modules/custom-fp-conflict/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(enableOk.status, 200);

      const psBlocked = await fetch(`${ui.url}/api/modules/privacy-shield/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(psBlocked.status, 409);
      assert.equal((await psBlocked.json()).code, "ERR_MODULE_CONFLICT");

      // Clean up custom module & restore privacy-shield enabled for remaining assertions
      uninstallModule("custom-fp-conflict");
      setModuleEnabled("privacy-shield", true);
    } finally {
      if (prevTrustedEnv === undefined) delete process.env.GADOR_TRUSTED_KEYS_FILE;
      else process.env.GADOR_TRUSTED_KEYS_FILE = prevTrustedEnv;
    }

    // Secret vault test: plaintext code + AES-256-GCM encryption ONLY for sensitive credentials
    const prevVaultDir = process.env.GADOR_VAULT_DIR;
    const prevVaultKey = process.env.GADOR_VAULT_KEY_FILE;
    process.env.GADOR_VAULT_DIR = path.join(tmpDir, "vaults");
    process.env.GADOR_VAULT_KEY_FILE = path.join(tmpDir, "vault-master.key");
    try {
      const vault = openModuleSecretVault("custom-demo");
      vault.setSecret("proxy_password", "super-secret-value-991");
      const rawDisk = fs.readFileSync(vault.vaultPath, "utf8");
      assert.ok(!rawDisk.includes("super-secret-value-991"), "Sensitive secret must NOT appear in plaintext on disk");
      assert.equal(vault.getSecret("proxy_password"), "super-secret-value-991");
      assert.equal(vault.listKeys().length, 1);
      assert.equal(vault.deleteSecret("proxy_password").deleted, true);
      assert.equal(vault.getSecret("proxy_password"), null);
    } finally {
      if (prevVaultDir === undefined) delete process.env.GADOR_VAULT_DIR;
      else process.env.GADOR_VAULT_DIR = prevVaultDir;
      if (prevVaultKey === undefined) delete process.env.GADOR_VAULT_KEY_FILE;
      else process.env.GADOR_VAULT_KEY_FILE = prevVaultKey;
    }

    // Module-gated user custom settings permission test:
    // Custom settings are ONLY granted when a matching verified module is installed & enabled,
    // strictly scoped to its declared settingsSchema features, and revoked on disable/uninstall.
    const prevCustomSettingsDir = process.env.GADOR_MODULE_SETTINGS_DIR;
    const prevTrustedEnv2 = process.env.GADOR_TRUSTED_KEYS_FILE;
    process.env.GADOR_MODULE_SETTINGS_DIR = path.join(tmpDir, "module-settings");
    process.env.GADOR_TRUSTED_KEYS_FILE = path.join(tmpDir, "trusted-keys-custom-settings.json");
    try {
      const modId = "custom-feature-mod";
      // 1) Before module is added: no panel & 409 ERR_MODULE_NOT_INSTALLED
      const beforePanels = await (await fetch(`${ui.url}/api/custom-settings`)).json();
      assert.equal(beforePanels.ok, true);
      assert.equal(beforePanels.panels.some((p) => p.moduleId === modId), false);

      const beforeGet = await fetch(`${ui.url}/api/modules/${modId}/settings`);
      assert.equal(beforeGet.status, 409);
      const beforeGetJson = await beforeGet.json();
      assert.equal(beforeGetJson.code, "ERR_MODULE_NOT_INSTALLED");

      // 2) Author, sign & install custom module declaring feature-scoped settingsSchema
      const kp2 = generatePublisherKeyPair();
      addTrustedPublisherKey("custom-settings-pub-v1", kp2.publicKeyPem, { label: "Custom Settings Publisher" });
      const customModDir = path.join(tmpDir, modId);
      fs.mkdirSync(customModDir, { recursive: true });
      fs.writeFileSync(
        path.join(customModDir, "module.json"),
        JSON.stringify(
          {
            id: modId,
            name: "自定义功能设置测试模块",
            version: "0.1.0",
            category: "automation",
            optional: true,
            plaintextSource: true,
            entry: "./index.mjs",
            compatibility: { exclusiveGroups: [], conflictsWith: [], requires: [] },
            settingsSchema: [
              {
                key: "strictFilter",
                label: "严格规则模式",
                feature: "filter",
                slot: "ai",
                type: "boolean",
                default: false,
                mutuallyExclusiveWith: ["compatPass"],
              },
              {
                key: "compatPass",
                label: "兼容直通模式",
                feature: "filter",
                slot: "ai",
                type: "boolean",
                default: true,
                mutuallyExclusiveWith: ["strictFilter"],
              },
              {
                key: "logLevel",
                label: "日志级别",
                feature: "audit",
                slot: "ai",
                type: "select",
                default: "info",
                options: [
                  { value: "warn", label: "警告" },
                  { value: "info", label: "信息" },
                  { value: "debug", label: "调试" },
                ],
              },
              {
                key: "maxRetries",
                label: "最大重试次数",
                feature: "scheduler",
                slot: "ai",
                type: "number",
                default: 3,
                min: 0,
                max: 10,
              },
            ],
          },
          null,
          2
        ) + "\n"
      );
      fs.writeFileSync(path.join(customModDir, "index.mjs"), `export const ok = true;\n`);
      const sigDoc2 = signModuleDirectory(customModDir, {
        privateKeyPem: kp2.privateKeyPem,
        keyId: "custom-settings-pub-v1",
      });
      installModule(modId, {
        sourceDir: customModDir,
        confirmDigest: sigDoc2.packageDigest.slice(0, 12),
        passphrase: "gador-secret-pin",
        enable: true,
      });

      // 3) Now panel is dynamically exposed & valid custom settings updates succeed
      const activePanels = await (await fetch(`${ui.url}/api/custom-settings`)).json();
      const foundPanel = activePanels.panels.find((p) => p.moduleId === modId);
      assert.ok(foundPanel, "Installed module with settingsSchema must unlock custom settings panel");
      assert.equal(foundPanel.values.logLevel, "info");
      assert.equal(foundPanel.values.maxRetries, 3);

      const updateOk = await (
        await fetch(`${ui.url}/api/modules/${modId}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: { logLevel: "debug", maxRetries: 7 } }),
        })
      ).json();
      assert.equal(updateOk.ok, true);
      assert.equal(updateOk.values.logLevel, "debug");
      assert.equal(updateOk.values.maxRetries, 7);

      // 4) Undeclared key & out-of-range number are rejected (400 ERR_INVALID_SETTING)
      const badKeyRes = await fetch(`${ui.url}/api/modules/${modId}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { undeclaredHack: true } }),
      });
      assert.equal(badKeyRes.status, 400);
      assert.equal((await badKeyRes.json()).code, "ERR_INVALID_SETTING");

      const badRangeRes = await fetch(`${ui.url}/api/modules/${modId}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { maxRetries: 99 } }),
      });
      assert.equal(badRangeRes.status, 400);
      assert.equal((await badRangeRes.json()).code, "ERR_INVALID_SETTING");

      // 5) Mutually exclusive custom settings cannot be enabled simultaneously (409 ERR_SETTING_CONFLICT)
      const conflictSettingRes = await fetch(`${ui.url}/api/modules/${modId}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { strictFilter: true } }),
      });
      assert.equal(conflictSettingRes.status, 409);
      assert.equal((await conflictSettingRes.json()).code, "ERR_SETTING_CONFLICT");

      // Disabling compatPass while enabling strictFilter succeeds cleanly
      const switchModeRes = await (
        await fetch(`${ui.url}/api/modules/${modId}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: { compatPass: false, strictFilter: true } }),
        })
      ).json();
      assert.equal(switchModeRes.ok, true);
      assert.equal(switchModeRes.values.strictFilter, true);
      assert.equal(switchModeRes.values.compatPass, false);

      // 6) Reset restores defaults
      const resetRes = await (
        await fetch(`${ui.url}/api/modules/${modId}/settings`, { method: "DELETE" })
      ).json();
      assert.equal(resetRes.ok, true);
      assert.equal(resetRes.values.logLevel, "info");
      assert.equal(resetRes.values.compatPass, true);
      assert.equal(resetRes.values.strictFilter, false);

      // 7) Disabling / uninstalling module immediately revokes custom settings permission
      setModuleEnabled(modId, false);
      const disabledRes = await fetch(`${ui.url}/api/modules/${modId}/settings`);
      assert.equal(disabledRes.status, 409);
      assert.equal((await disabledRes.json()).code, "ERR_MODULE_NOT_INSTALLED");

      uninstallModule(modId, { purge: true });
      const afterPanels = await (await fetch(`${ui.url}/api/custom-settings`)).json();
      assert.equal(afterPanels.panels.some((p) => p.moduleId === modId), false);
    } finally {
      if (prevCustomSettingsDir === undefined) delete process.env.GADOR_MODULE_SETTINGS_DIR;
      else process.env.GADOR_MODULE_SETTINGS_DIR = prevCustomSettingsDir;
      if (prevTrustedEnv2 === undefined) delete process.env.GADOR_TRUSTED_KEYS_FILE;
      else process.env.GADOR_TRUSTED_KEYS_FILE = prevTrustedEnv2;
    }

    // 3. Now Privacy Shield HTTP & MCP APIs work cleanly
    const initial = await (await fetch(`${ui.url}/api/privacy-shield`)).json();
    assert.equal(initial.ok, true);
    assert.equal(initial.moduleInstalled, true);
    assert.equal(initial.moduleEnabled, true);
    assert.equal(initial.privacyShield.level, "standard");
    assert.equal(initial.privacyShield.canvasFarbling, true);
    assert.equal(initial.privacyShield.clientRectsJitter, false);

    const strictRes = await (
      await fetch(`${ui.url}/api/privacy-shield`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "strict" }),
      })
    ).json();
    assert.equal(strictRes.ok, true);
    assert.equal(strictRes.privacyShield.level, "strict");
    assert.equal(strictRes.privacyShield.clientRectsJitter, true);

    const mcp = new GadorMcpServer({ socketPath });
    await mcp.connectKernel();
    try {
      const modListRes = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 700,
        method: "tools/call",
        params: { name: "module_list", arguments: {} },
      });
      assert.equal(modListRes.result.isError, false);
      const modListData = JSON.parse(modListRes.result.content[0].text);
      assert.equal(modListData.modules.find((m) => m.id === "privacy-shield")?.enabled, true);

      const getRes = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 701,
        method: "tools/call",
        params: { name: "privacy_shield_get", arguments: {} },
      });
      assert.equal(getRes.result.isError, false);
      const getData = JSON.parse(getRes.result.content[0].text);
      assert.equal(getData.privacyShield.level, "strict");

      const setRes = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 702,
        method: "tools/call",
        params: { name: "privacy_shield_set", arguments: { level: "standard", webglFarbling: true } },
      });
      assert.equal(setRes.result.isError, false);
      const setData = JSON.parse(setRes.result.content[0].text);
      assert.equal(setData.privacyShield.level, "standard");
      assert.equal(setData.privacyShield.updatedBy, "ai");

      const resRead = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 703,
        method: "resources/read",
        params: { uri: "gador://privacy-shield" },
      });
      const resJson = JSON.parse(resRead.result.contents[0].text);
      assert.equal(resJson.privacyShield.level, "standard");

      const modResRead = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 704,
        method: "resources/read",
        params: { uri: "gador://modules" },
      });
      const modResJson = JSON.parse(modResRead.result.contents[0].text);
      assert.equal(modResJson.modules.length, 2);

      // 4. Disable -> write blocked -> re-enable -> works
      await fetch(`${ui.url}/api/modules/privacy-shield/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const disabledSet = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 705,
        method: "tools/call",
        params: { name: "privacy_shield_set", arguments: { level: "strict" } },
      });
      assert.equal(disabledSet.result.isError, true);

      await fetch(`${ui.url}/api/modules/privacy-shield/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
    } finally {
      await mcp.close();
    }
  });

  // -------------------------------------------------------------------------
  // 3. VPN-Only Open Archive, Mandatory Pre-Modify Backup, Restore & Quick Delete (HTTP + MCP)
  // -------------------------------------------------------------------------
  await t.test("3. VPN-only HTTP API & MCP tools enforce mandatory backup before modify + quick delete", async () => {
    // 3a. HTTP API lifecycle
    const initStore = await (await fetch(`${ui.url}/api/vpn/store`)).json();
    assert.equal(initStore.ok, true);
    assert.equal(initStore.editableScope, "vpn_only");
    assert.equal(initStore.profiles.length, 0);

    // Save a VPN profile -> auto-creates pre-modify backup
    const saveRes = await (
      await fetch(`${ui.url}/api/vpn/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SG Tunnel",
          scope: "browser",
          mode: "strict_tunnel",
          endpoint: "socks5://127.0.0.1:7890",
          failClosed: true,
          forbiddenSetting: "must_be_stripped",
        }),
      })
    ).json();
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.profile.name, "SG Tunnel");
    assert.equal("forbiddenSetting" in saveRes.profile, false);
    assert.ok(saveRes.backup.backupId.startsWith("vpn-backup-"));
    assert.equal(saveRes.store.backups.length, 1);

    // Manual backup
    const manualBak = await (
      await fetch(`${ui.url}/api/vpn/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual_checkpoint" }),
      })
    ).json();
    assert.equal(manualBak.ok, true);
    assert.equal(manualBak.backup.profileCount, 1);

    // Delete profile -> creates pre-delete backup
    const delProf = await (
      await fetch(`${ui.url}/api/vpn/profiles/${encodeURIComponent(saveRes.profile.id)}`, {
        method: "DELETE",
      })
    ).json();
    assert.equal(delProf.ok, true);
    assert.equal(delProf.profiles.length, 0);
    assert.equal(delProf.backup.profileCount, 1);

    // Restore from pre-delete backup -> recovers profile + snapshots current state
    const restored = await (
      await fetch(`${ui.url}/api/vpn/backups/${encodeURIComponent(delProf.backup.backupId)}/restore`, {
        method: "POST",
      })
    ).json();
    assert.equal(restored.ok, true);
    assert.equal(restored.profiles.length, 1);
    assert.equal(restored.profiles[0].name, "SG Tunnel");

    // Quick delete single backup & clear all backups
    const firstBakId = restored.store.backups[0].backupId;
    const delOne = await (
      await fetch(`${ui.url}/api/vpn/backups/${encodeURIComponent(firstBakId)}`, {
        method: "DELETE",
      })
    ).json();
    assert.equal(delOne.ok, true);
    assert.equal(delOne.deleted, true);

    const clearAll = await (
      await fetch(`${ui.url}/api/vpn/backups`, { method: "DELETE" })
    ).json();
    assert.equal(clearAll.ok, true);
    assert.equal(clearAll.store.backups.length, 0);

    // 3b. MCP Server VPN-only tools + gador://vpn-profiles resource
    const mcp = new GadorMcpServer({ socketPath });
    await mcp.connectKernel();
    try {
      const resList = await mcp.handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "resources/list" });
      assert.ok(resList.result.resources.some((r) => r.uri === "gador://vpn-profiles"));

      // AI update WITHOUT backupReason must fail
      const noReason = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "vpn_update_profile",
          arguments: { name: "NoBackup", mode: "direct_only" },
        },
      });
      assert.equal(noReason.result.isError, true);

      // AI update WITH backupReason must succeed and produce a backupId
      const aiUpdate = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "vpn_update_profile",
          arguments: {
            backupReason: "ai_add_direct_fallback",
            name: "AI Direct",
            scope: "browser",
            mode: "direct_only",
            failClosed: false,
          },
        },
      });
      assert.equal(aiUpdate.result.isError, false);
      const aiPayload = JSON.parse(aiUpdate.result.content[0].text);
      assert.equal(aiPayload.profile.updatedBy, "ai");
      assert.ok(aiPayload.backup.backupId.startsWith("vpn-backup-"));
      assert.equal(aiPayload.backup.actor, "ai");

      const readRes = await mcp.handleRpcMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: "gador://vpn-profiles" },
      });
      const vpnDoc = JSON.parse(readRes.result.contents[0].text);
      assert.ok(vpnDoc.profiles.some((p) => p.name === "AI Direct"));
      assert.ok(vpnDoc.backups.some((b) => b.backupId === aiPayload.backup.backupId));
    } finally {
      await mcp.close();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Native Gador Extension Manifest, Scripts, CORS & Launcher Isolation
  // -------------------------------------------------------------------------
  await t.test("4. Bundled MV3 extension, CORS for chrome-extension://, and launcher profile isolation", async () => {
    const extDir = path.join(REPO_ROOT, "clients/extension");
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, "background.js");
    assert.equal(manifest.chrome_url_overrides.newtab, "newtab.html");
    assert.ok(fs.existsSync(path.join(extDir, "background.js")));
    assert.ok(fs.existsSync(path.join(extDir, "content.js")));
    assert.ok(fs.existsSync(path.join(extDir, "popup.html")));
    assert.ok(fs.existsSync(path.join(extDir, "newtab.html")));

    // Extension CORS preflight & state fetch allowed; external origins still 403
    const extOrigin = "chrome-extension://lckofficpncjaaleapojdecocpmodbdk";
    const optRes = await fetch(`${ui.url}/api/state`, {
      method: "OPTIONS",
      headers: { Origin: extOrigin },
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), extOrigin);

    const extState = await fetch(`${ui.url}/api/state`, { headers: { Origin: extOrigin } });
    assert.equal(extState.status, 200);

    // Launcher script isolation check (native single-layer Gador, zero forced 127.0.0.1 double-chrome)
    const pkgScript = fs.readFileSync(path.join(REPO_ROOT, "scripts/package-gador.sh"), "utf8");
    assert.ok(pkgScript.includes('CHROME_DESKTOP="gador.desktop"'));
    assert.ok(pkgScript.includes('--user-data-dir="$GADOR_DATA_DIR"'));
    assert.ok(pkgScript.includes("--class=gador"));
    assert.ok(pkgScript.includes("--load-extension="));
  });

  // -------------------------------------------------------------------------
  // 5. Real Browser Live DOM & Computed CSS Verification (when running against real Gador Engine 158)
  // -------------------------------------------------------------------------
  if (EXTERNAL_SOCKET) {
    await t.test("5. Real Gador Engine 158 live DOM: Personalization styles, Space separation, Stop AI, VPN UI & Settings", async () => {
      const client = new AgentKernelClient({ socketPath });
      await client.connect();
      const sp = await client.createSpace({
        name: "ui-e2e-suite",
        authMode: "shared",
        viewport: { width: 1280, height: 800 },
      });
      try {
        await client.openPage({ spaceId: sp.spaceId, url: "data:text/html,<h1>AI Active Page</h1>" });
        const uiPg = await client.openPage({ spaceId: sp.spaceId, url: ui.url });
        await new Promise((r) => setTimeout(r, 900));

        const evalJs = async (expression) => {
          const res = await client.sendCdp(uiPg.pageId, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (res?.exceptionDetails) {
            throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
          }
          return res?.result?.value;
        };

        const result = await evalJs(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const r = {};

          // A. Single-layer native embedded hub mode (ZERO double-chrome!) + Settings About / Bookmarks / Init
          r.embeddedShell = document.getElementById("zen").dataset.shell;
          r.sidebarHiddenInNative = getComputedStyle(document.getElementById("sidebar")).display;
          r.chromeTopHiddenInNative = getComputedStyle(document.getElementById("chrome-top")).display;
          r.noOldSpaceCards = !document.getElementById("ess-shared") && !document.getElementById("ess-private");
          r.noUselessViewportCard = !document.getElementById("settings-live-toggle") && document.querySelectorAll("[data-set-viewport]").length === 0;
          r.hasBookmarksAndInitAndAbout =
            Boolean(document.getElementById("settings-bookmark-bar-toggle")) &&
            Boolean(document.getElementById("btn-init-zen-preset")) &&
            Boolean(document.getElementById("btn-reset-all-init")) &&
            Boolean(document.getElementById("set-native-ui-path"));
          r.incognitoNextToSettings =
            document.getElementById("btn-incognito")?.nextElementSibling?.id === "nav-settings" &&
            document.getElementById("chrome-btn-incognito")?.nextElementSibling?.id === "chrome-nav-settings";

          // B. Personalization: Light/Dark theme, Accent color, Optional Frost off/rich + native sync
          document.querySelector('[data-nav-view="personalization"]').click();
          await sleep(220);
          document.querySelector('[data-set-theme="light"]').click();
          await sleep(220);
          r.lightBg = getComputedStyle(document.body).backgroundColor;
          document.querySelector('[data-set-theme="dark"]').click();
          await sleep(220);
          r.darkBg = getComputedStyle(document.body).backgroundColor;

          document.querySelector('[data-set-accent="violet"]').click();
          await sleep(220);
          r.violetAccent = document.getElementById("zen").dataset.accent;

          const card = document.querySelector("#view-personalization .glass-card");
          r.defaultFrostBackdrop = getComputedStyle(card).backdropFilter;
          document.querySelector('[data-set-frost="rich"]').click();
          await sleep(220);
          r.richFrostBackdrop = getComputedStyle(card).backdropFilter;
          document.querySelector('[data-set-frost="off"]').click();
          await sleep(220);

          // C. AI Running Space: FULL-BLEED 100% same viewport size as normal page (differentiated ONLY by optical aura + Stop AI!)
          document.getElementById("subnav-ai-space").click();
          await sleep(300);
          const vpRect = document.getElementById("viewport").getBoundingClientRect();
          r.aiMode = document.getElementById("zen").dataset.spaceMode;
          r.aiViewportMatchesWindow =
            Math.abs(vpRect.width - window.innerWidth) <= 2 &&
            Math.abs(vpRect.height - window.innerHeight) <= 2;
          r.hasStopAiBtn = !document.getElementById("btn-stop-ai").disabled;

          document.getElementById("btn-stop-ai").click();
          await sleep(450);
          r.afterStopControl = document.getElementById("zen").dataset.control;
          document.getElementById("btn-stop-ai").click();
          await sleep(450);
          r.afterResumeControl = document.getElementById("zen").dataset.control;

          // Jump back from full-bleed AI Space to Settings/VPN via capsule Settings button
          document.getElementById("btn-capsule-settings").click();
          await sleep(220);

          // D. VPN Same-page Archive + Backup + Quick Delete UI
          document.querySelector('#settings-subnav [data-nav-view="vpn"]').click();
          await sleep(300);
          document.getElementById("vpn-profile-name").value = "UI Test VPN";
          document.getElementById("vpn-hub-endpoint").value = "socks5://127.0.0.1:10808";
          document.getElementById("vpn-btn-save-profile").click();
          await sleep(400);
          r.vpnProfilesRendered = document.querySelectorAll("#vpn-profile-list .vpn-item").length;
          r.vpnBackupsRendered = document.querySelectorAll("#vpn-backup-list .vpn-item").length;
          document.getElementById("vpn-btn-clear-backups").click();
          await sleep(400);
          r.vpnBackupsAfterClear = document.querySelectorAll("#vpn-backup-list .vpn-item").length;

          return r;
        })()`);

        assert.equal(result.embeddedShell, "embedded");
        assert.equal(result.sidebarHiddenInNative, "none");
        assert.equal(result.chromeTopHiddenInNative, "none");
        assert.equal(result.noOldSpaceCards, true);
        assert.equal(result.noUselessViewportCard, true);
        assert.equal(result.hasBookmarksAndInitAndAbout, true);
        assert.equal(result.incognitoNextToSettings, true);
        assert.equal(result.lightBg, "rgb(236, 240, 250)");
        assert.equal(result.darkBg, "rgb(6, 7, 11)");
        assert.equal(result.violetAccent, "violet");
        assert.equal(result.defaultFrostBackdrop, "none");
        assert.ok(result.richFrostBackdrop.includes("blur(42px)"));
        assert.equal(result.aiMode, "ai");
        assert.equal(result.aiViewportMatchesWindow, true);
        assert.equal(result.hasStopAiBtn, true);
        assert.equal(result.afterStopControl, "USER_ACTIVE");
        assert.equal(result.afterResumeControl, "AGENT_RUNNING");
        assert.ok(result.vpnProfilesRendered >= 1);
        assert.ok(result.vpnBackupsRendered >= 1);
        assert.equal(result.vpnBackupsAfterClear, 0);
      } finally {
        await client.closeSpace(sp.spaceId);
        await client.close();
      }
    });
  }
});
