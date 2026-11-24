#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import {
  execModuleInSandbox,
  getModulesState,
  installModule,
  probeModuleInSandbox,
  requestModuleInstallChallenge,
  resolveEnabledExtensionDirs,
  runModulesDoctor,
  setModuleEnabled,
  uninstallModule,
} from "./registry.mjs";
import {
  getSandboxStatus,
  stopAllModuleContainers,
  stopModuleContainer,
} from "./sandbox/container-manager.mjs";
import {
  EXCLUSIVE_CONFLICT_GROUPS,
  MODULE_CATEGORIES,
  MODULE_LIFECYCLE_METHODS,
} from "./schema.mjs";
import {
  addTrustedPublisherKey,
  clearModuleInstallPassphrase,
  generatePublisherKeyPair,
  getModuleAuthStatus,
  getTrustedKeyring,
  removeTrustedPublisherKey,
  setModuleInstallPassphrase,
  signModuleDirectory,
  verifyModulePackage,
} from "./verifier.mjs";

function printUsage() {
  process.stdout.write(`gador-mod — Verified Standalone Module Installer, Authoring & Integrator for Gador

Usage:
  gador-mod list [--json]
  gador-mod status <moduleId> [--json]
  gador-mod verify <moduleId|/path/to/module> [--json]
  gador-mod install <moduleId|/path/to/module|all> [--confirm-digest <hex8+>] [--passphrase <pin>] [--disabled] [--json]
  gador-mod uninstall <moduleId|all> [--purge] [--json]
  gador-mod enable <moduleId> [--json]
  gador-mod disable <moduleId> [--json]
  gador-mod init <moduleId> [--dir <targetDir>] [--name <title>] [--category <network|privacy|identity|automation|appearance|security>] [--exclusive-group <group>] [--with-extension]
  gador-mod spec [--json]
  gador-mod auth status
  gador-mod auth set-passphrase [--passphrase <pin>]
  gador-mod auth clear-passphrase [--passphrase <currentPin>]
  gador-mod trust list [--json]
  gador-mod trust add <keyId> <public-key.pem> [--label <name>]
  gador-mod trust remove <keyId>
  gador-mod keygen --out <dir> [--key-id <id>]
  gador-mod sign <moduleDir> --key <private-key.pem> --key-id <id>
  gador-mod sandbox status
  gador-mod sandbox probe <moduleId>
  gador-mod sandbox exec <moduleId> <method> [jsonArgs]
  gador-mod sandbox stop [moduleId]
  gador-mod extensions
  gador-mod doctor [--json]
`);
}

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const k = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function formatTable(state) {
  const lines = [
    `Registry   : ${state.registryPath}`,
    `Installed  : ${state.installRoot}`,
    `Passphrase : ${state.passphraseEnabled ? "ENABLED (required on install)" : "not set (use 'gador-mod auth set-passphrase')"}`,
    "",
  ];
  for (const m of state.modules) {
    const badge = m.enabled
      ? "[INSTALLED & VERIFIED]"
      : m.installed
        ? !m.integrityOk
          ? "[🚫 INTEGRITY FAILED]"
          : m.conflictState?.blocked
            ? "[🚫 CONFLICT BLOCKED]"
            : "[INSTALLED / DISABLED]"
        : m.conflictState?.blocked
          ? "[NOT INSTALLED · 🚫 CONFLICT]"
          : "[NOT INSTALLED]";
    const sigInfo = m.verification?.valid
      ? `Ed25519 OK (${m.verification.keyId} · sha256:${m.verification.shortDigest})`
      : `UNVERIFIED (${(m.verification?.errors || []).join("; ")})`;
    const groups = m.conflictState?.exclusiveGroups || [];
    lines.push(`${m.id.padEnd(16)} v${m.version}  [${m.category}]  ${badge}`);
    lines.push(`  ${m.name} — ${m.description}`);
    lines.push(`  Signature: ${sigInfo}${groups.length ? ` | ExclusiveGroup: ${groups.join(", ")}` : ""}`);
    if (m.conflictState?.blocked) {
      for (const b of m.conflictState.blockedBy) {
        lines.push(`  🚫 Blocked: ${b.reason}`);
      }
      for (const d of m.conflictState.missingDependencies) {
        lines.push(`  🚫 Missing Dependency: ${d.reason}`);
      }
    }
    if (m.installed) {
      lines.push(`  Path: ${m.installPath}${m.extensionPath ? ` (ext: ${m.extensionPath})` : ""}`);
    } else {
      lines.push(`  Install: gador-mod install ${m.id}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const jsonOut = Boolean(flags.json);
  const [cmd, sub, arg3] = positionals;

  if (!cmd || cmd === "help" || flags.help) {
    printUsage();
    return;
  }

  if (cmd === "list") {
    const state = getModulesState();
    process.stdout.write(jsonOut ? JSON.stringify(state, null, 2) + "\n" : formatTable(state));
    return;
  }

  if (cmd === "extensions") {
    const dirs = resolveEnabledExtensionDirs();
    process.stdout.write(jsonOut ? JSON.stringify({ dirs }) + "\n" : dirs.join(",") + "\n");
    return;
  }

  if (cmd === "doctor") {
    const doc = runModulesDoctor();
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    process.exitCode = doc.ok ? 0 : 1;
    return;
  }

  if (cmd === "status") {
    const state = getModulesState();
    const mod = state.modules.find((m) => m.id === sub);
    if (!mod) throw new Error(`Unknown module: ${sub || "(missing)"}`);
    process.stdout.write(JSON.stringify(mod, null, 2) + "\n");
    return;
  }

  if (cmd === "verify") {
    if (!sub) throw new Error("Usage: gador-mod verify <vpn|privacy-shield|/path/to/module>");
    const state = getModulesState();
    const known = state.modules.find((m) => m.id === sub);
    const targetDir = known ? known.sourceDir : path.resolve(sub);
    const result = verifyModulePackage(targetDir, { expectedModuleId: known ? known.id : null });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (cmd === "spec") {
    process.stdout.write(
      JSON.stringify(
        {
          categories: MODULE_CATEGORIES,
          exclusiveGroups: EXCLUSIVE_CONFLICT_GROUPS,
          lifecycleMethods: MODULE_LIFECYCLE_METHODS,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (cmd === "init") {
    const modId = String(sub || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(modId)) {
      throw new Error(
        'Usage: gador-mod init <moduleId> [--dir <targetDir>] [--name <title>] [--category <network|privacy|identity|automation|appearance|security>] [--exclusive-group <group>] [--with-extension]'
      );
    }
    const category = typeof flags.category === "string" ? flags.category : "automation";
    if (!MODULE_CATEGORIES[category]) {
      throw new Error(
        `Unsupported category "${category}". Allowed: ${Object.keys(MODULE_CATEGORIES).join(", ")}`
      );
    }
    const exclusiveGroup = typeof flags["exclusive-group"] === "string" ? flags["exclusive-group"].trim() : "";
    const targetDir = path.resolve(
      typeof flags.dir === "string" ? flags.dir : path.join(process.cwd(), modId)
    );
    const title = typeof flags.name === "string" ? flags.name : `Gador Custom Module (${modId})`;
    const withExt = Boolean(flags["with-extension"]);
    if (fs.existsSync(path.join(targetDir, "module.json"))) {
      throw new Error(`Target directory already contains module.json: ${targetDir}`);
    }
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });

    const manifest = {
      id: modId,
      name: title,
      version: "0.1.0",
      category,
      optional: true,
      requiresSeparateInstall: true,
      plaintextSource: true,
      description: "用户自定义 Gador 独立模块（明文源码 + 敏感凭据 AES-256-GCM 加密存储 + Ed25519 签名验证）。",
      entry: "./index.mjs",
      readme: "./README.md",
      integration: {
        uiSlots: [],
        httpRoutes: [],
        mcpTools: [],
        mcpResources: [],
        extensionDir: withExt ? "./extension" : null,
      },
      storage: {
        plaintextConfig: `~/.config/gador/${modId}.json`,
        encryptedSecretsVault: `~/.config/gador/secrets/${modId}.vault.enc.json`,
      },
      securityBoundary: {
        plaintextSourceAllowed: true,
        sensitiveDataEncryptedOnly: true,
      },
      sandbox: {
        runtime: "bubblewrap",
        maxMemoryMb: 64,
        allowNetwork: false,
        idleTimeoutMs: 60000,
      },
      compatibility: {
        exclusiveGroups: exclusiveGroup ? [exclusiveGroup] : [],
        conflictsWith: [],
        requires: [],
        mutuallyExclusiveFeatures: [],
      },
    };
    fs.writeFileSync(
      path.join(targetDir, "module.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o644 }
    );
    fs.writeFileSync(
      path.join(targetDir, "index.mjs"),
      `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "module.json"), "utf8")
);

// Standard Gador Module Lifecycle Methods (Plaintext source; store secrets only via openModuleSecretVault)
export async function checkCompatibility(context = {}) {
  return { ok: true, moduleId: MODULE_MANIFEST.id, checkedAt: new Date().toISOString(), context };
}
export async function onInstall() { return { ok: true }; }
export async function onEnable() { return { ok: true }; }
export async function onDisable() { return { ok: true }; }
export async function onUninstall() { return { ok: true }; }
export function getStatus() { return { id: MODULE_MANIFEST.id, version: MODULE_MANIFEST.version, ready: true }; }
export async function healthCheck() { return { healthy: true, moduleId: MODULE_MANIFEST.id }; }

export default {
  manifest: MODULE_MANIFEST,
  checkCompatibility,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  getStatus,
  healthCheck,
};
`,
      { mode: 0o644 }
    );
    fs.writeFileSync(
      path.join(targetDir, "README.md"),
      `# ${title} (\`${modId}\`)

本模块为明文开源结构的 Gador 自定义模块；除敏感凭据使用 \`openModuleSecretVault("${modId}")\` 加密存储外，源码与常规配置均为可读明文。

## 签名与验证安装步骤

\`\`\`bash
# 1. 生成自己的发布者密钥（首次执行即可）
gador-mod keygen --out ~/.config/gador/my-keys --key-id my-dev-v1

# 2. 将公钥加入本机信任列表
gador-mod trust add my-dev-v1 ~/.config/gador/my-keys/my-dev-v1.public.pem --label "My Local Publisher"

# 3. 对本模块签名（生成 signature.json）
gador-mod sign "${targetDir}" --key ~/.config/gador/my-keys/my-dev-v1.private.pem --key-id my-dev-v1

# 4. 校验并安装整合
gador-mod verify "${targetDir}"
gador-mod install "${targetDir}"
\`\`\`
`,
      { mode: 0o644 }
    );
    if (withExt) {
      const extDir = path.join(targetDir, "extension");
      fs.mkdirSync(extDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(
        path.join(extDir, "manifest.json"),
        JSON.stringify(
          {
            manifest_version: 3,
            name: title,
            version: "0.1.0",
            description: manifest.description,
            permissions: ["storage"],
            background: { service_worker: "background.js" },
          },
          null,
          2
        ) + "\n",
        { mode: 0o644 }
      );
      fs.writeFileSync(
        path.join(extDir, "background.js"),
        `// Plaintext MV3 service worker for custom Gador module "${modId}"\nchrome.runtime.onInstalled.addListener(() => {\n  console.log("[gador-module:${modId}] ready");\n});\n`,
        { mode: 0o644 }
      );
    }
    const out = { ok: true, moduleId: modId, dir: targetDir, withExtension: withExt };
    process.stdout.write(
      jsonOut
        ? JSON.stringify(out, null, 2) + "\n"
        : `[OK] Scaffolded plaintext custom module "${modId}" at: ${targetDir}\n     Next: sign it with 'gador-mod sign' and install via 'gador-mod install "${targetDir}"'\n`
    );
    return;
  }

  if (cmd === "install") {
    if (!sub) throw new Error("Usage: gador-mod install <moduleId|/path/to/module|all>");
    const state = getModulesState();
    const isLocalPath =
      sub !== "all" &&
      !state.modules.some((m) => m.id === sub) &&
      fs.existsSync(path.resolve(sub)) &&
      fs.statSync(path.resolve(sub)).isDirectory();

    const targets = isLocalPath
      ? [{ id: null, sourceDir: path.resolve(sub) }]
      : sub === "all"
        ? state.modules.filter((m) => m.builtin).map((m) => ({ id: m.id, sourceDir: undefined }))
        : [{ id: sub, sourceDir: undefined }];

    const results = [];

    for (const item of targets) {
      const challenge = requestModuleInstallChallenge(item.id, {
        sourceDir: item.sourceDir,
      });
      const id = challenge.moduleId;
      const confirmDigestFlag = typeof flags["confirm-digest"] === "string" ? flags["confirm-digest"] : "";
      let passphrase = typeof flags.passphrase === "string" ? flags.passphrase : "";

      if (confirmDigestFlag) {
        const res = installModule(id, {
          enable: !flags.disabled,
          sourceDir: item.sourceDir,
          confirmDigest: confirmDigestFlag,
          passphrase,
          actor: "cli",
        });
        results.push(res);
      } else {
        if (!process.stdin.isTTY) {
          const err = new Error(
            `Non-interactive install of "${id}" requires explicit verification flag: --confirm-digest ${challenge.verification.shortDigest}` +
              (challenge.requiresPassphrase ? " --passphrase <pin>" : "")
          );
          err.code = "ERR_INSTALL_VERIFICATION_REQUIRED";
          throw err;
        }
        process.stdout.write(`\n[VERIFY] Module      : ${id} (v${challenge.verification.version})\n`);
        process.stdout.write(`[VERIFY] Publisher   : ${challenge.verification.publisherLabel || challenge.verification.keyId} (${challenge.verification.keyId})\n`);
        process.stdout.write(`[VERIFY] SHA-256     : ${challenge.verification.packageDigest}\n`);
        process.stdout.write(`[VERIFY] Files       : ${challenge.verification.fileCount} files verified (Ed25519 OK)\n`);
        process.stdout.write(`[VERIFY] Extension   : ${challenge.permissions.hasStandaloneExtension ? "Standalone MV3 extension (requires browser restart)" : "No browser extension"}\n`);
        process.stdout.write(`[VERIFY] Confirm Code: ${challenge.confirmCode}\n`);
        const typedCode = await promptLine(`Type confirmation code (${challenge.confirmCode}) to approve install: `);
        if (challenge.requiresPassphrase && !passphrase) {
          passphrase = await promptLine("Enter Gador module install passphrase: ");
        }
        const res = installModule(id, {
          enable: !flags.disabled,
          sourceDir: item.sourceDir,
          challengeId: challenge.challengeId,
          confirmCode: typedCode,
          passphrase,
          actor: "cli_interactive",
        });
        results.push(res);
      }
    }

    if (jsonOut) {
      process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : { ok: true, results }, null, 2) + "\n");
    } else {
      for (const r of results) {
        process.stdout.write(
          `[OK] Verified & integrated module "${r.module.id}" (sha256:${r.verification.shortDigest}) -> ${r.module.installPath}\n`
        );
        if (r.module.extensionPath) {
          process.stdout.write(`     Standalone extension ready: ${r.module.extensionPath}\n`);
          process.stdout.write(`     Restart "gador --desktop" to attach the extension into Chromium.\n`);
        }
      }
    }
    return;
  }

  if (cmd === "uninstall") {
    if (!sub) throw new Error("Usage: gador-mod uninstall <vpn|privacy-shield|all> [--purge]");
    const targets = sub === "all" ? getModulesState().modules.map((m) => m.id) : [sub];
    const results = targets.map((id) => uninstallModule(id, { purge: Boolean(flags.purge) }));
    if (jsonOut) {
      process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : { ok: true, results }, null, 2) + "\n");
    } else {
      for (const r of results) {
        process.stdout.write(`[OK] Uninstalled module "${r.module.id}"${flags.purge ? " (config purged)" : " (user data preserved)"}\n`);
      }
    }
    return;
  }

  if (cmd === "enable" || cmd === "disable") {
    if (!sub) throw new Error(`Usage: gador-mod ${cmd} <vpn|privacy-shield>`);
    const res = setModuleEnabled(sub, cmd === "enable");
    process.stdout.write(
      jsonOut
        ? JSON.stringify(res, null, 2) + "\n"
        : `[OK] Module "${res.module.id}" is now ${res.action}.\n`
    );
    return;
  }

  if (cmd === "auth") {
    if (sub === "status") {
      process.stdout.write(JSON.stringify(getModuleAuthStatus(), null, 2) + "\n");
      return;
    }
    if (sub === "set-passphrase") {
      let pin = typeof flags.passphrase === "string" ? flags.passphrase : "";
      if (!pin && process.stdin.isTTY) {
        pin = await promptLine("Set new module install passphrase (>= 4 chars): ");
      }
      const st = setModuleInstallPassphrase(pin);
      process.stdout.write(JSON.stringify({ ok: true, ...st }, null, 2) + "\n");
      return;
    }
    if (sub === "clear-passphrase") {
      let pin = typeof flags.passphrase === "string" ? flags.passphrase : "";
      if (!pin && process.stdin.isTTY) {
        pin = await promptLine("Enter current module install passphrase: ");
      }
      const st = clearModuleInstallPassphrase(pin);
      process.stdout.write(JSON.stringify({ ok: true, ...st }, null, 2) + "\n");
      return;
    }
    throw new Error("Usage: gador-mod auth <status|set-passphrase|clear-passphrase>");
  }

  if (cmd === "trust") {
    if (sub === "list") {
      process.stdout.write(JSON.stringify({ keys: getTrustedKeyring() }, null, 2) + "\n");
      return;
    }
    if (sub === "add") {
      if (!arg3 || !positionals[3]) {
        throw new Error("Usage: gador-mod trust add <keyId> <public-key.pem> [--label <name>]");
      }
      const pem = fs.readFileSync(path.resolve(positionals[3]), "utf8");
      const added = addTrustedPublisherKey(arg3, pem, typeof flags.label === "string" ? flags.label : "");
      process.stdout.write(JSON.stringify({ ok: true, ...added }, null, 2) + "\n");
      return;
    }
    if (sub === "remove") {
      if (!arg3) throw new Error("Usage: gador-mod trust remove <keyId>");
      const removed = removeTrustedPublisherKey(arg3);
      process.stdout.write(JSON.stringify({ ok: true, ...removed }, null, 2) + "\n");
      return;
    }
    throw new Error("Usage: gador-mod trust <list|add|remove>");
  }

  if (cmd === "keygen") {
    const outDir = typeof flags.out === "string" ? path.resolve(flags.out) : "";
    const keyId = typeof flags["key-id"] === "string" ? flags["key-id"] : "publisher-v1";
    if (!outDir) throw new Error("Usage: gador-mod keygen --out <dir> [--key-id <id>]");
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const kp = generatePublisherKeyPair();
    const privPath = path.join(outDir, `${keyId}.private.pem`);
    const pubPath = path.join(outDir, `${keyId}.public.pem`);
    fs.writeFileSync(privPath, kp.privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, kp.publicKeyPem, { mode: 0o644 });
    process.stdout.write(JSON.stringify({ ok: true, keyId, fingerprint: kp.fingerprint, privPath, pubPath }, null, 2) + "\n");
    return;
  }

  if (cmd === "sign") {
    const keyFile = typeof flags.key === "string" ? path.resolve(flags.key) : "";
    const keyId = typeof flags["key-id"] === "string" ? flags["key-id"] : "";
    if (!sub || !keyFile || !keyId) {
      throw new Error("Usage: gador-mod sign <moduleDir> --key <private.pem> --key-id <id>");
    }
    const privateKeyPem = fs.readFileSync(keyFile, "utf8");
    const sigDoc = signModuleDirectory(sub, { privateKeyPem, keyId });
    process.stdout.write(JSON.stringify({ ok: true, moduleId: sigDoc.moduleId, keyId: sigDoc.keyId, packageDigest: sigDoc.packageDigest }, null, 2) + "\n");
    return;
  }

  if (cmd === "sandbox") {
    if (sub === "status") {
      process.stdout.write(JSON.stringify(getSandboxStatus(), null, 2) + "\n");
      return;
    }
    if (sub === "probe") {
      if (!arg3) throw new Error("Usage: gador-mod sandbox probe <moduleId>");
      const res = await probeModuleInSandbox(arg3);
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      stopModuleContainer(arg3, "cli_oneshot_done");
      return;
    }
    if (sub === "exec") {
      const modId = arg3;
      const method = positionals[3];
      const rawArgs = positionals[4];
      if (!modId || !method) {
        throw new Error("Usage: gador-mod sandbox exec <moduleId> <method> [jsonArgs]");
      }
      const parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
      const res = await execModuleInSandbox(modId, method, parsedArgs);
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      stopModuleContainer(modId, "cli_oneshot_done");
      return;
    }
    if (sub === "stop") {
      const res = arg3 ? stopModuleContainer(arg3, "cli_stop") : stopAllModuleContainers("cli_stop_all");
      process.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + "\n");
      return;
    }
    throw new Error("Usage: gador-mod sandbox <status|probe|exec|stop>");
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ ok: false, code: err.code || "ERR_MOD_CLI", error: err.message }) + "\n"
  );
  process.exit(1);
});
