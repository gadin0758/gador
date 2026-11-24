import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectSandboxRuntime,
  getSandboxStatus,
  invokeInModuleContainer,
  probeModuleContainer,
  stopAllModuleContainers,
  stopModuleContainer,
} from "./sandbox/container-manager.mjs";
import {
  CUSTOM_SETTING_TYPES,
  evaluateModuleConflicts,
  EXCLUSIVE_CONFLICT_GROUPS,
  getDefaultCustomSettings,
  MODULE_CATEGORIES,
  MODULE_LIFECYCLE_METHODS,
  normalizeModuleSubmenus,
  normalizeSettingsSchema,
  resolveModuleSecurityTier,
  SUBMENU_ITEM_TYPES,
  validateModuleCustomSettings,
} from "./schema.mjs";
import {
  appendModuleAuditLog,
  consumeInstallChallenge,
  createInstallChallenge,
  getModuleAuthStatus,
  verifyModuleInstallPassphrase,
  verifyModulePackage,
} from "./verifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODULES_CATALOG_DIR = __dirname;

export const KNOWN_MODULE_IDS = ["vpn", "privacy-shield"];

export function resolveModulesRegistryPath() {
  if (process.env.GADOR_MODULES_FILE) {
    return process.env.GADOR_MODULES_FILE;
  }
  const cfgBase =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfgBase, "gador", "modules.json");
}

export function resolveInstalledModulesDir() {
  if (process.env.GADOR_MODULES_DIR) {
    return process.env.GADOR_MODULES_DIR;
  }
  const cfgBase =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfgBase, "gador", "installed-modules");
}

export function resolveModuleSettingsDir() {
  if (process.env.GADOR_MODULE_SETTINGS_DIR) {
    return process.env.GADOR_MODULE_SETTINGS_DIR;
  }
  const cfgBase =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfgBase, "gador", "module-settings");
}

function moduleSettingsFilePath(moduleId) {
  return path.join(resolveModuleSettingsDir(), `${moduleId}.json`);
}

function readManifestFromDir(dir) {
  const manifestPath = path.join(dir, "module.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

export function listCatalogModules() {
  const entries = [];
  if (!fs.existsSync(MODULES_CATALOG_DIR)) return entries;
  for (const name of fs.readdirSync(MODULES_CATALOG_DIR)) {
    const dir = path.join(MODULES_CATALOG_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifest = readManifestFromDir(dir);
    if (manifest && manifest.id) {
      entries.push({
        id: manifest.id,
        sourceDir: dir,
        manifest,
      });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function readRawRegistry() {
  const regPath = resolveModulesRegistryPath();
  if (!fs.existsSync(regPath)) {
    return { version: 1, modules: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(regPath, "utf8"));
    return {
      version: 1,
      modules: parsed && typeof parsed.modules === "object" ? parsed.modules : {},
    };
  } catch {
    return { version: 1, modules: {} };
  }
}

function writeRawRegistry(data) {
  const regPath = resolveModulesRegistryPath();
  fs.mkdirSync(path.dirname(regPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    regPath,
    JSON.stringify({ version: 1, modules: data.modules || {}, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 }
  );
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function getModulesState() {
  const catalog = listCatalogModules();
  const catalogMap = new Map(catalog.map((c) => [c.id, c]));
  const raw = readRawRegistry();
  const installRoot = resolveInstalledModulesDir();
  const registryPath = resolveModulesRegistryPath();
  const auth = getModuleAuthStatus();

  // Merge built-in catalog modules + any user-authored custom installed modules
  const allIds = new Set([...catalogMap.keys(), ...Object.keys(raw.modules || {})]);
  const sortedIds = [...allIds].sort((a, b) => a.localeCompare(b));

  const modules = [];
  for (const id of sortedIds) {
    const cat = catalogMap.get(id) || null;
    const rec = raw.modules[id] || {};
    const installPath = rec.installPath || path.join(installRoot, id);
    const installedManifest = readManifestFromDir(installPath);
    const hasInstalledFiles = Boolean(installedManifest && installedManifest.id);
    const installed = Boolean(rec.installed && hasInstalledFiles);

    // Skip stale uninstalled custom entries that are no longer in built-in catalog
    if (!cat && !installed) continue;

    const manifest = installed ? installedManifest : cat.manifest;
    const sourceDir = cat ? cat.sourceDir : rec.source || installPath;
    const installedVerification = installed
      ? verifyModulePackage(installPath, { expectedModuleId: id })
      : null;
    const catalogVerification = cat
      ? verifyModulePackage(cat.sourceDir, { expectedModuleId: id })
      : installedVerification;
    const integrityOk = installed
      ? Boolean(installedVerification?.valid)
      : Boolean(catalogVerification?.valid);
    const enabled = installed && rec.enabled !== false && integrityOk;
    const extRel = manifest.integration?.extensionDir || null;
    const extensionPath =
      installed && extRel ? path.resolve(installPath, extRel) : null;
    const extensionReady = Boolean(
      integrityOk &&
        extensionPath &&
        fs.existsSync(path.join(extensionPath, "manifest.json"))
    );

    const settingsSchema = normalizeSettingsSchema(manifest);
    const submenus = normalizeModuleSubmenus(manifest, settingsSchema);

    modules.push({
      id,
      name: manifest.name,
      version: manifest.version,
      category: manifest.category || "custom",
      securityTier: resolveModuleSecurityTier(manifest),
      builtin: Boolean(cat),
      optional: manifest.optional !== false,
      requiresSeparateInstall: manifest.requiresSeparateInstall !== false,
      description: manifest.description || "",
      installed,
      enabled,
      integrityOk,
      installedAt: installed ? rec.installedAt || null : null,
      updatedAt: rec.updatedAt || null,
      sourceDir,
      installPath,
      extensionPath,
      extensionReady,
      settingsSchema,
      customSettingsCount: settingsSchema.length,
      submenus,
      submenusCount: submenus.length,
      verification: installed ? installedVerification : catalogVerification,
      manifest,
    });
  }

  // Annotate every module with live mutual-exclusion conflict & dependency state
  for (const mod of modules) {
    mod.conflictState = evaluateModuleConflicts(mod, modules);
  }

  return {
    registryPath,
    installRoot,
    verificationRequired: true,
    passphraseEnabled: auth.passphraseEnabled,
    sandbox: getSandboxStatus(),
    categories: MODULE_CATEGORIES,
    exclusiveGroups: EXCLUSIVE_CONFLICT_GROUPS,
    lifecycleMethods: MODULE_LIFECYCLE_METHODS,
    modules,
  };
}

export function isModuleEnabled(moduleId) {
  const st = getModulesState();
  const found = st.modules.find((m) => m.id === moduleId);
  return Boolean(found && found.installed && found.enabled && found.integrityOk);
}

export function isModuleInstalled(moduleId) {
  const st = getModulesState();
  const found = st.modules.find((m) => m.id === moduleId);
  return Boolean(found && found.installed);
}

export function requestModuleInstallChallenge(moduleId, { sourceDir: customSource } = {}) {
  const catalog = listCatalogModules();
  const entry = catalog.find((c) => c.id === moduleId);
  if (!entry && !customSource) {
    const err = new Error(
      `Unknown module "${moduleId}". Available modules: ${catalog.map((c) => c.id).join(", ")}`
    );
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const srcDir = customSource ? path.resolve(customSource) : entry.sourceDir;
  const manifest = readManifestFromDir(srcDir);
  if (!manifest || !manifest.id) {
    const err = new Error(`Invalid module directory (missing module.json): ${srcDir}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  return createInstallChallenge({ moduleId: manifest.id, srcDir, manifest });
}

export function installModule(
  moduleId,
  {
    enable = true,
    sourceDir: customSource,
    challengeId,
    confirmCode,
    confirmDigest,
    passphrase = "",
    actor = "user",
  } = {}
) {
  const catalog = listCatalogModules();
  const entry = catalog.find((c) => c.id === moduleId);
  if (!entry && !customSource) {
    const err = new Error(
      `Unknown module "${moduleId}". Available modules: ${catalog.map((c) => c.id).join(", ")}`
    );
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const srcDir = customSource ? path.resolve(customSource) : entry.sourceDir;
  const manifest = readManifestFromDir(srcDir);
  if (!manifest || !manifest.id) {
    const err = new Error(`Invalid module directory (missing module.json): ${srcDir}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const targetId = manifest.id;

  // 1. Mandatory Ed25519 signature + SHA-256 file integrity verification (NO bypass allowed)
  const verification = verifyModulePackage(srcDir, { expectedModuleId: targetId });
  if (!verification.valid) {
    appendModuleAuditLog({
      action: "install_blocked_signature",
      actor,
      moduleId: targetId,
      code: verification.code,
      errors: verification.errors,
      ok: false,
    });
    const err = new Error(
      `Module signature/integrity verification failed for "${targetId}": ${verification.errors.join("; ")}`
    );
    err.code = verification.code || "ERR_MODULE_VERIFICATION_FAILED";
    err.verification = verification;
    throw err;
  }

  // 1b. Check mutual-exclusion conflicts BEFORE enabling on install
  if (enable) {
    const preState = getModulesState();
    const candidate = { id: targetId, name: manifest.name, manifest };
    const conflict = evaluateModuleConflicts(candidate, preState.modules);
    if (conflict.blocked) {
      const reasons = [
        ...conflict.blockedBy.map((b) => b.reason),
        ...conflict.missingDependencies.map((d) => d.reason),
      ];
      appendModuleAuditLog({
        action: "install_blocked_conflict",
        actor,
        moduleId: targetId,
        reasons,
        ok: false,
      });
      const err = new Error(
        `Cannot enable module "${targetId}" due to conflict/dependency: ${reasons.join("; ")} (install with --disabled or disable the conflicting module first)`
      );
      err.code = "ERR_MODULE_CONFLICT";
      err.conflictState = conflict;
      throw err;
    }
  }

  // 2. Mandatory human authorization check:
  //    - Either single-use challengeId + confirmCode (WebUI / HTTP flow)
  //    - Or explicit confirmDigest prefix (>= 8 hex chars matching verified packageDigest) + passphrase (CLI flow)
  if (challengeId || confirmCode) {
    consumeInstallChallenge({
      challengeId,
      moduleId: targetId,
      confirmCode,
      passphrase,
      expectedDigest: verification.packageDigest,
    });
  } else if (confirmDigest) {
    const clean = String(confirmDigest).trim().toLowerCase();
    if (clean.length < 8 || !verification.packageDigest.startsWith(clean)) {
      appendModuleAuditLog({
        action: "install_blocked_digest_confirm",
        actor,
        moduleId: targetId,
        ok: false,
      });
      const err = new Error(
        `Confirmation digest mismatch for "${targetId}". Expected prefix of ${verification.shortDigest}`
      );
      err.code = "ERR_INSTALL_VERIFICATION_FAILED";
      throw err;
    }
    if (!verifyModuleInstallPassphrase(passphrase)) {
      appendModuleAuditLog({
        action: "install_blocked_passphrase",
        actor,
        moduleId: targetId,
        ok: false,
      });
      const err = new Error("Module install passphrase is required or incorrect");
      err.code = "ERR_INSTALL_VERIFICATION_FAILED";
      throw err;
    }
  } else {
    appendModuleAuditLog({
      action: "install_blocked_unverified",
      actor,
      moduleId: targetId,
      ok: false,
    });
    const err = new Error(
      `Module "${targetId}" installation requires verification (provide challengeId+confirmCode or confirmDigest).`
    );
    err.code = "ERR_INSTALL_VERIFICATION_REQUIRED";
    throw err;
  }

  // 3. Stage into a temporary directory, verify, then swap into installPath (NEVER rmSync srcDir!)
  const installRoot = resolveInstalledModulesDir();
  const installPath = path.join(installRoot, targetId);
  const resolvedSrc = path.resolve(srcDir);
  const resolvedDst = path.resolve(installPath);

  if (resolvedSrc !== resolvedDst) {
    fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
    const stagePath = `${installPath}.staging.${process.pid}.${Date.now()}`;
    try {
      copyDirRecursive(resolvedSrc, stagePath);
      const stageVerify = verifyModulePackage(stagePath, { expectedModuleId: targetId });
      if (!stageVerify.valid) {
        const err = new Error(
          `Post-install verification failed for "${targetId}": ${stageVerify.errors.join("; ")}`
        );
        err.code = "ERR_MODULE_VERIFICATION_FAILED";
        throw err;
      }
      if (fs.existsSync(installPath)) {
        fs.rmSync(installPath, { recursive: true, force: true });
      }
      fs.renameSync(stagePath, installPath);
    } catch (err) {
      if (fs.existsSync(stagePath)) {
        fs.rmSync(stagePath, { recursive: true, force: true });
      }
      throw err;
    }
  }

  const postVerify = verifyModulePackage(installPath, { expectedModuleId: targetId });
  if (!postVerify.valid) {
    if (resolvedSrc !== resolvedDst && fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    const err = new Error(
      `Post-install verification failed for "${targetId}": ${postVerify.errors.join("; ")}`
    );
    err.code = "ERR_MODULE_VERIFICATION_FAILED";
    throw err;
  }

  const raw = readRawRegistry();
  const now = new Date().toISOString();
  raw.modules[targetId] = {
    installed: true,
    enabled: Boolean(enable),
    version: manifest.version,
    keyId: postVerify.keyId,
    packageDigest: postVerify.packageDigest,
    installPath,
    source: customSource ? srcDir : "builtin-catalog",
    installedAt: raw.modules[targetId]?.installedAt || now,
    updatedAt: now,
  };
  writeRawRegistry(raw);

  appendModuleAuditLog({
    action: "install_verified",
    actor,
    moduleId: targetId,
    version: manifest.version,
    keyId: postVerify.keyId,
    digest: postVerify.shortDigest,
    ok: true,
  });

  const state = getModulesState();
  return {
    ok: true,
    action: "installed",
    verified: true,
    verification: postVerify,
    module: state.modules.find((m) => m.id === targetId),
    state,
  };
}

export function setModuleEnabled(moduleId, enabled) {
  const stateBefore = getModulesState();
  const mod = stateBefore.modules.find((m) => m.id === moduleId);
  if (!mod) {
    const err = new Error(`Unknown module "${moduleId}"`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  if (!mod.installed) {
    const err = new Error(
      `Module "${moduleId}" is not installed yet. Run "gador-mod install ${moduleId}" first.`
    );
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  if (enabled && !mod.integrityOk) {
    const err = new Error(
      `Cannot enable module "${moduleId}": installed package failed signature/integrity verification`
    );
    err.code = "ERR_MODULE_SIGNATURE_INVALID";
    throw err;
  }
  if (enabled) {
    const conflict = evaluateModuleConflicts(mod, stateBefore.modules);
    if (conflict.blocked) {
      const reasons = [
        ...conflict.blockedBy.map((b) => b.reason),
        ...conflict.missingDependencies.map((d) => d.reason),
      ];
      appendModuleAuditLog({
        action: "enable_blocked_conflict",
        moduleId,
        reasons,
        ok: false,
      });
      const err = new Error(
        `Cannot enable module "${moduleId}": ${reasons.join("; ")}`
      );
      err.code = "ERR_MODULE_CONFLICT";
      err.conflictState = conflict;
      throw err;
    }
  }

  const raw = readRawRegistry();
  raw.modules[moduleId] = {
    ...(raw.modules[moduleId] || {}),
    installed: true,
    enabled: Boolean(enabled),
    installPath: mod.installPath,
    updatedAt: new Date().toISOString(),
  };
  writeRawRegistry(raw);

  if (!enabled) {
    stopModuleContainer(moduleId, "module_disabled");
  }

  appendModuleAuditLog({
    action: enabled ? "module_enabled" : "module_disabled",
    moduleId,
    ok: true,
  });

  const state = getModulesState();
  if (!state.modules.some((m) => m.installed && m.enabled)) {
    stopAllModuleContainers("no_enabled_modules");
  }
  return {
    ok: true,
    action: enabled ? "enabled" : "disabled",
    module: state.modules.find((m) => m.id === moduleId),
    state,
  };
}

export function uninstallModule(moduleId, { purge = false } = {}) {
  const stateBefore = getModulesState();
  const mod = stateBefore.modules.find((m) => m.id === moduleId);
  if (!mod) {
    const err = new Error(`Unknown module "${moduleId}"`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  stopModuleContainer(moduleId, "module_uninstalled");

  // Never delete a built-in catalog directory if an older registry pointed installPath to it
  const isCatalogDir = path.resolve(mod.installPath).startsWith(path.resolve(MODULES_CATALOG_DIR) + path.sep);
  if (!isCatalogDir && fs.existsSync(mod.installPath)) {
    fs.rmSync(mod.installPath, { recursive: true, force: true });
  }

  const raw = readRawRegistry();
  raw.modules[moduleId] = {
    installed: false,
    enabled: false,
    installPath: mod.installPath,
    updatedAt: new Date().toISOString(),
  };
  writeRawRegistry(raw);

  if (purge) {
    const cfgBase =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    if (moduleId === "privacy-shield") {
      const psFile =
        process.env.GADOR_PRIVACY_SHIELD_FILE ||
        path.join(cfgBase, "gador", "privacy-shield.json");
      if (fs.existsSync(psFile)) fs.rmSync(psFile, { force: true });
    } else if (moduleId === "vpn") {
      const vpnDir =
        process.env.GADOR_VPN_STORE_DIR || path.join(cfgBase, "gador", "vpn");
      if (fs.existsSync(vpnDir)) fs.rmSync(vpnDir, { recursive: true, force: true });
    }
    const customSettingsPath = moduleSettingsFilePath(moduleId);
    if (fs.existsSync(customSettingsPath)) {
      fs.rmSync(customSettingsPath, { force: true });
    }
  }

  appendModuleAuditLog({
    action: "module_uninstalled",
    moduleId,
    purged: Boolean(purge),
    ok: true,
  });

  const state = getModulesState();
  if (!state.modules.some((m) => m.installed && m.enabled)) {
    stopAllModuleContainers("no_enabled_modules");
  }
  return {
    ok: true,
    action: "uninstalled",
    moduleId,
    purged: Boolean(purge),
    module: state.modules.find((m) => m.id === moduleId) || {
      id: moduleId,
      installed: false,
      enabled: false,
    },
    state,
  };
}

export async function execModuleInSandbox(moduleId, method, args = {}, opts = {}) {
  const state = getModulesState();
  const mod = state.modules.find((m) => m.id === moduleId);
  if (!mod || !mod.installed || !mod.enabled) {
    const err = new Error(
      `Module "${moduleId}" is not installed/enabled — sandbox container will not start.`
    );
    err.code = "ERR_MODULE_NOT_INSTALLED";
    throw err;
  }
  return invokeInModuleContainer(mod, method, args, opts);
}

export async function probeModuleInSandbox(moduleId, opts = {}) {
  const state = getModulesState();
  const mod = state.modules.find((m) => m.id === moduleId);
  if (!mod || !mod.installed || !mod.enabled) {
    const err = new Error(
      `Module "${moduleId}" is not installed/enabled — sandbox container will not start.`
    );
    err.code = "ERR_MODULE_NOT_INSTALLED";
    throw err;
  }
  return probeModuleContainer(mod, opts);
}

// ---- Module-Gated User Custom Settings (only active when matching module is installed & enabled) ----

function readStoredCustomSettings(moduleId, schema) {
  const defaults = getDefaultCustomSettings(schema);
  const filePath = moduleSettingsFilePath(moduleId);
  if (!fs.existsSync(filePath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const stored =
      parsed && typeof parsed.values === "object" && parsed.values
        ? parsed.values
        : {};
    const merged = { ...defaults };
    for (const field of schema) {
      if (Object.prototype.hasOwnProperty.call(stored, field.key)) {
        merged[field.key] = stored[field.key];
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

function writeStoredCustomSettings(moduleId, values, actor = "user") {
  const filePath = moduleSettingsFilePath(moduleId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        moduleId,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
        values,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  return filePath;
}

function requireActiveCustomSettingsModule(moduleId, { allowSubmenusOnly = false } = {}) {
  const state = getModulesState();
  const mod = state.modules.find((m) => m.id === moduleId);
  if (!mod || !mod.installed || !mod.enabled || !mod.integrityOk) {
    const err = new Error(
      `Custom settings for module "${moduleId}" are unavailable: install and enable module "${moduleId}" first.`
    );
    err.code = "ERR_MODULE_NOT_INSTALLED";
    throw err;
  }
  const schema = Array.isArray(mod.settingsSchema) ? mod.settingsSchema : [];
  const submenus = Array.isArray(mod.submenus) ? mod.submenus : [];
  if (schema.length === 0 && (!allowSubmenusOnly || submenus.length === 0)) {
    const err = new Error(
      `Module "${moduleId}" does not declare any settingsSchema entries.`
    );
    err.code = "ERR_MODULE_NO_CUSTOM_SETTINGS";
    throw err;
  }
  return { mod, schema, submenus };
}

export function getModuleCustomSettings(moduleId) {
  const { mod, schema, submenus } = requireActiveCustomSettingsModule(moduleId, {
    allowSubmenusOnly: true,
  });
  const values = readStoredCustomSettings(moduleId, schema);
  return {
    ok: true,
    moduleId: mod.id,
    moduleName: mod.name,
    category: mod.category,
    version: mod.version,
    features: [...new Set(schema.map((f) => f.feature))],
    submenus,
    schema,
    values,
    settingsPath: moduleSettingsFilePath(moduleId),
  };
}

export function updateModuleCustomSettings(moduleId, patch, { actor = "user" } = {}) {
  const { mod, schema, submenus } = requireActiveCustomSettingsModule(moduleId);
  const current = readStoredCustomSettings(moduleId, schema);
  const { values, changedKeys } = validateModuleCustomSettings(schema, current, patch);
  const settingsPath = writeStoredCustomSettings(moduleId, values, actor);
  appendModuleAuditLog({
    action: "module_custom_settings_updated",
    moduleId,
    actor,
    changedKeys,
    ok: true,
  });
  return {
    ok: true,
    moduleId: mod.id,
    moduleName: mod.name,
    changedKeys,
    submenus,
    schema,
    values,
    settingsPath,
  };
}

export function resetModuleCustomSettings(moduleId, { actor = "user" } = {}) {
  const { mod, schema, submenus } = requireActiveCustomSettingsModule(moduleId);
  const defaults = getDefaultCustomSettings(schema);
  const settingsPath = writeStoredCustomSettings(moduleId, defaults, actor);
  appendModuleAuditLog({
    action: "module_custom_settings_reset",
    moduleId,
    actor,
    ok: true,
  });
  return {
    ok: true,
    moduleId: mod.id,
    moduleName: mod.name,
    submenus,
    schema,
    values: defaults,
    settingsPath,
  };
}

export function listActiveCustomSettingsPanels() {
  const state = getModulesState();
  const panels = [];
  for (const mod of state.modules) {
    if (!mod.installed || !mod.enabled || !mod.integrityOk) continue;
    const schema = Array.isArray(mod.settingsSchema) ? mod.settingsSchema : [];
    const submenus = Array.isArray(mod.submenus) ? mod.submenus : [];
    if (schema.length === 0 && submenus.length === 0) continue;
    panels.push({
      moduleId: mod.id,
      moduleName: mod.name,
      category: mod.category,
      categoryLabel: MODULE_CATEGORIES[mod.category]?.label || mod.category,
      version: mod.version,
      description: mod.description,
      features: [...new Set(schema.map((f) => f.feature))],
      submenus,
      schema,
      values: readStoredCustomSettings(mod.id, schema),
      settingsPath: moduleSettingsFilePath(mod.id),
    });
  }
  return {
    ok: true,
    supportedTypes: CUSTOM_SETTING_TYPES,
    supportedSubmenuItemTypes: SUBMENU_ITEM_TYPES,
    panels,
  };
}

export function resolveEnabledExtensionDirs() {
  const state = getModulesState();
  return state.modules
    .filter(
      (m) =>
        m.installed &&
        m.enabled &&
        m.integrityOk &&
        m.extensionReady &&
        m.extensionPath
    )
    .map((m) => m.extensionPath);
}

export function runModulesDoctor() {
  const state = getModulesState();
  const checks = state.modules.map((m) => {
    const manifestExists = m.builtin
      ? fs.existsSync(path.join(m.sourceDir, "module.json"))
      : fs.existsSync(path.join(m.installPath, "module.json"));
    const catalogVerify = m.builtin
      ? verifyModulePackage(m.sourceDir, { expectedModuleId: m.id })
      : null;
    const installedFilesOk = !m.installed || fs.existsSync(path.join(m.installPath, "module.json"));
    const installedVerify = m.installed
      ? verifyModulePackage(m.installPath, { expectedModuleId: m.id })
      : null;
    const activeVerify = installedVerify || catalogVerify || { valid: false, errors: ["Unverified module"] };
    const signatureOk = Boolean(activeVerify.valid);
    const extOk = !m.manifest.integration?.extensionDir || !m.installed || m.extensionReady;
    return {
      id: m.id,
      builtin: m.builtin,
      installed: m.installed,
      enabled: m.enabled,
      catalogOk: manifestExists,
      installedFilesOk,
      signatureOk,
      keyId: activeVerify.keyId || null,
      shortDigest: activeVerify.shortDigest || null,
      verificationErrors: activeVerify.errors || [],
      extensionOk: extOk,
      healthy: manifestExists && installedFilesOk && signatureOk && extOk,
      installPath: m.installPath,
      extensionPath: m.extensionPath,
    };
  });
  return {
    ok: checks.every((c) => c.healthy),
    registryPath: state.registryPath,
    installRoot: state.installRoot,
    passphraseEnabled: state.passphraseEnabled,
    sandboxRuntime: detectSandboxRuntime(),
    sandboxStatus: getSandboxStatus(),
    enabledExtensionDirs: resolveEnabledExtensionDirs(),
    checks,
  };
}
