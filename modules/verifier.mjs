import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_TRUSTED_KEYS_PATH = path.join(__dirname, "trusted-keys.json");

const CHALLENGE_TTL_MS = 120_000;
const activeChallenges = new Map();

function resolveConfigRoot() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "gador"
  );
}

export function resolveUserTrustedKeysPath() {
  if (process.env.GADOR_TRUSTED_KEYS_FILE) {
    return process.env.GADOR_TRUSTED_KEYS_FILE;
  }
  return path.join(resolveConfigRoot(), "trusted-module-keys.json");
}

export function resolveModuleAuthPath() {
  if (process.env.GADOR_MODULE_AUTH_FILE) {
    return process.env.GADOR_MODULE_AUTH_FILE;
  }
  return path.join(resolveConfigRoot(), "module-auth.json");
}

export function resolveModuleAuditLogPath() {
  if (process.env.GADOR_MODULE_AUDIT_LOG) {
    return process.env.GADOR_MODULE_AUDIT_LOG;
  }
  return path.join(resolveConfigRoot(), "module-audit.log");
}

export function appendModuleAuditLog(entry) {
  try {
    const logPath = resolveModuleAuditLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {
    // audit log failures should not crash runtime
  }
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function getTrustedKeyring() {
  const builtin = readJsonSafe(BUILTIN_TRUSTED_KEYS_PATH, { keys: {} });
  const user = readJsonSafe(resolveUserTrustedKeysPath(), { keys: {} });
  const merged = {};
  for (const [id, info] of Object.entries(builtin.keys || {})) {
    merged[id] = { ...info, id, source: "builtin" };
  }
  for (const [id, info] of Object.entries(user.keys || {})) {
    merged[id] = { ...info, id, source: "user" };
  }
  return merged;
}

export function addTrustedPublisherKey(keyId, publicKeyPem, label = "") {
  const cleanId = String(keyId || "").trim();
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(cleanId)) {
    const err = new Error("Invalid keyId format (use 2-64 chars: a-z, A-Z, 0-9, ., _, -)");
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  // Validate that PEM is a real Ed25519 public key
  const keyObj = crypto.createPublicKey(publicKeyPem);
  if (keyObj.asymmetricKeyType !== "ed25519") {
    const err = new Error(`Expected Ed25519 public key, got ${keyObj.asymmetricKeyType || "unknown"}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const normalizedPem = keyObj.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = crypto
    .createHash("sha256")
    .update(normalizedPem)
    .digest("hex")
    .slice(0, 16);

  const userPath = resolveUserTrustedKeysPath();
  const data = readJsonSafe(userPath, { version: 1, keys: {} });
  data.keys = data.keys || {};
  data.keys[cleanId] = {
    label: label || cleanId,
    algorithm: "ed25519",
    fingerprint,
    publicKeyPem: normalizedPem,
    addedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(userPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(userPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  appendModuleAuditLog({ action: "trust_key_add", keyId: cleanId, fingerprint, ok: true });
  return { keyId: cleanId, fingerprint, label: data.keys[cleanId].label };
}

export function removeTrustedPublisherKey(keyId) {
  const userPath = resolveUserTrustedKeysPath();
  const data = readJsonSafe(userPath, { version: 1, keys: {} });
  if (!data.keys || !data.keys[keyId]) {
    const err = new Error(`User trusted key not found: ${keyId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  delete data.keys[keyId];
  fs.mkdirSync(path.dirname(userPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(userPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  appendModuleAuditLog({ action: "trust_key_remove", keyId, ok: true });
  return { removed: true, keyId };
}

export function generatePublisherKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fingerprint = crypto
    .createHash("sha256")
    .update(publicKeyPem)
    .digest("hex")
    .slice(0, 16);
  return { publicKeyPem, privateKeyPem, fingerprint };
}

function collectModuleFiles(rootDir, currentRel = "", out = {}) {
  const fullDir = currentRel ? path.join(rootDir, currentRel) : rootDir;
  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (rel === "signature.json") continue;
    const full = path.join(fullDir, entry.name);
    if (entry.isSymbolicLink()) {
      const err = new Error(`Symlinks are forbidden inside verifiable module packages: ${rel}`);
      err.code = "ERR_MODULE_VERIFICATION_FAILED";
      throw err;
    }
    if (entry.isDirectory()) {
      collectModuleFiles(rootDir, rel, out);
    } else if (entry.isFile()) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      out[rel] = hash;
    }
  }
  return out;
}

function buildCanonicalPayload({ moduleId, version, keyId, files }) {
  const sortedFiles = {};
  for (const k of Object.keys(files).sort()) {
    sortedFiles[k] = files[k];
  }
  return JSON.stringify({
    schema: "gador-module-sig-v1",
    moduleId,
    version,
    keyId,
    files: sortedFiles,
  });
}

export function computePackageDigest(canonicalPayload) {
  return crypto.createHash("sha256").update(canonicalPayload).digest("hex");
}

export function signModuleDirectory(moduleDir, { privateKeyPem, keyId }) {
  const absDir = path.resolve(moduleDir);
  const manifestPath = path.join(absDir, "module.json");
  if (!fs.existsSync(manifestPath)) {
    const err = new Error(`Missing module.json in ${absDir}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.id || !manifest.version) {
    const err = new Error("module.json must define id and version");
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const files = collectModuleFiles(absDir);
  const payload = buildCanonicalPayload({
    moduleId: manifest.id,
    version: manifest.version,
    keyId,
    files,
  });
  const packageDigest = computePackageDigest(payload);
  const privKey = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), privKey).toString("base64");

  const sigDoc = {
    schema: "gador-module-sig-v1",
    algorithm: "ed25519",
    moduleId: manifest.id,
    version: manifest.version,
    keyId,
    signedAt: new Date().toISOString(),
    packageDigest,
    files,
    signature: sig,
  };
  fs.writeFileSync(
    path.join(absDir, "signature.json"),
    JSON.stringify(sigDoc, null, 2) + "\n",
    { mode: 0o644 }
  );
  return sigDoc;
}

export function verifyModulePackage(moduleDir, { expectedModuleId = null } = {}) {
  const absDir = path.resolve(moduleDir);
  const errors = [];
  const manifestPath = path.join(absDir, "module.json");
  const sigPath = path.join(absDir, "signature.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      code: "ERR_MODULE_VERIFICATION_FAILED",
      errors: [`Missing module.json in ${absDir}`],
    };
  }
  if (!fs.existsSync(sigPath)) {
    return {
      valid: false,
      code: "ERR_MODULE_UNSIGNED",
      errors: [`Missing signature.json in ${absDir} — unsigned modules cannot be installed`],
    };
  }

  let manifest;
  let sigDoc;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    sigDoc = JSON.parse(fs.readFileSync(sigPath, "utf8"));
  } catch (err) {
    return {
      valid: false,
      code: "ERR_MODULE_VERIFICATION_FAILED",
      errors: [`Malformed manifest or signature JSON: ${err.message}`],
    };
  }

  if (expectedModuleId && manifest.id !== expectedModuleId) {
    errors.push(`Module id mismatch: expected ${expectedModuleId}, got ${manifest.id}`);
  }
  if (sigDoc.schema !== "gador-module-sig-v1" || sigDoc.algorithm !== "ed25519") {
    errors.push(`Unsupported signature schema/algorithm: ${sigDoc.schema}/${sigDoc.algorithm}`);
  }
  if (sigDoc.moduleId !== manifest.id || sigDoc.version !== manifest.version) {
    errors.push("Signature metadata does not match module.json id/version");
  }

  const keyring = getTrustedKeyring();
  const keyEntry = keyring[sigDoc.keyId];
  if (!keyEntry || !keyEntry.publicKeyPem) {
    errors.push(`Untrusted or unknown publisher keyId: "${sigDoc.keyId || ""}"`);
  }

  let actualFiles = {};
  try {
    actualFiles = collectModuleFiles(absDir);
  } catch (err) {
    errors.push(err.message);
  }

  const signedFiles = sigDoc.files || {};
  const actualKeys = new Set(Object.keys(actualFiles));
  const signedKeys = new Set(Object.keys(signedFiles));

  for (const rel of signedKeys) {
    if (!actualKeys.has(rel)) {
      errors.push(`Missing signed file: ${rel}`);
    } else if (actualFiles[rel] !== signedFiles[rel]) {
      errors.push(`SHA-256 mismatch (file tampered): ${rel}`);
    }
  }
  for (const rel of actualKeys) {
    if (!signedKeys.has(rel)) {
      errors.push(`Unexpected unsigned file detected: ${rel}`);
    }
  }

  const canonicalPayload = buildCanonicalPayload({
    moduleId: sigDoc.moduleId,
    version: sigDoc.version,
    keyId: sigDoc.keyId,
    files: signedFiles,
  });
  const computedDigest = computePackageDigest(canonicalPayload);
  if (sigDoc.packageDigest !== computedDigest) {
    errors.push("Package digest mismatch");
  }

  let cryptoOk = false;
  if (keyEntry?.publicKeyPem && sigDoc.signature) {
    try {
      const pubKey = crypto.createPublicKey(keyEntry.publicKeyPem);
      cryptoOk = crypto.verify(
        null,
        Buffer.from(canonicalPayload, "utf8"),
        pubKey,
        Buffer.from(sigDoc.signature, "base64")
      );
      if (!cryptoOk) {
        errors.push("Ed25519 cryptographic signature verification failed");
      }
    } catch (err) {
      errors.push(`Signature verification error: ${err.message}`);
    }
  }

  const valid = errors.length === 0 && cryptoOk;
  return {
    valid,
    code: valid ? null : keyEntry ? "ERR_MODULE_SIGNATURE_INVALID" : "ERR_MODULE_UNTRUSTED_KEY",
    moduleId: manifest.id,
    version: manifest.version,
    keyId: sigDoc.keyId || null,
    publisherLabel: keyEntry?.label || null,
    keySource: keyEntry?.source || null,
    signedAt: sigDoc.signedAt || null,
    packageDigest: computedDigest,
    shortDigest: computedDigest.slice(0, 12),
    fileCount: Object.keys(actualFiles).length,
    errors,
  };
}

// ---- Local Human Install Passphrase (Optional Extra Lock) ----
export function getModuleAuthStatus() {
  const authPath = resolveModuleAuthPath();
  const data = readJsonSafe(authPath, null);
  const passphraseEnabled = Boolean(data && data.salt && data.hash);
  return {
    authFile: authPath,
    passphraseEnabled,
    updatedAt: data?.updatedAt || null,
  };
}

export function setModuleInstallPassphrase(passphrase) {
  const text = String(passphrase || "");
  if (text.length < 4) {
    const err = new Error("Install passphrase must be at least 4 characters long");
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(text, salt, 32).toString("hex");
  const authPath = resolveModuleAuthPath();
  fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    authPath,
    JSON.stringify({ version: 1, kdf: "scrypt", salt, hash, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 }
  );
  appendModuleAuditLog({ action: "auth_passphrase_set", ok: true });
  return getModuleAuthStatus();
}

export function verifyModuleInstallPassphrase(passphrase) {
  const authPath = resolveModuleAuthPath();
  const data = readJsonSafe(authPath, null);
  if (!data || !data.salt || !data.hash) {
    return true; // No passphrase configured
  }
  const text = String(passphrase || "");
  if (!text) return false;
  const derived = crypto.scryptSync(text, data.salt, 32);
  const expected = Buffer.from(data.hash, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function clearModuleInstallPassphrase(currentPassphrase) {
  const status = getModuleAuthStatus();
  if (status.passphraseEnabled && !verifyModuleInstallPassphrase(currentPassphrase)) {
    const err = new Error("Current install passphrase is incorrect");
    err.code = "ERR_INSTALL_VERIFICATION_FAILED";
    throw err;
  }
  const authPath = resolveModuleAuthPath();
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { force: true });
  }
  appendModuleAuditLog({ action: "auth_passphrase_cleared", ok: true });
  return getModuleAuthStatus();
}

// ---- Single-Use Human Confirmation Challenge (Anti-Silent Install) ----
function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, ch] of activeChallenges.entries()) {
    if (ch.expiresAtMs <= now) activeChallenges.delete(id);
  }
}

export function createInstallChallenge({ moduleId, srcDir, manifest }) {
  pruneExpiredChallenges();
  const verification = verifyModulePackage(srcDir, { expectedModuleId: moduleId });
  if (!verification.valid) {
    appendModuleAuditLog({
      action: "install_challenge_rejected",
      moduleId,
      code: verification.code,
      errors: verification.errors,
      ok: false,
    });
    const err = new Error(
      `Module verification failed for "${moduleId}": ${verification.errors.join("; ")}`
    );
    err.code = verification.code || "ERR_MODULE_VERIFICATION_FAILED";
    err.verification = verification;
    throw err;
  }

  const challengeId = crypto.randomBytes(12).toString("hex");
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const randBytes = crypto.randomBytes(4);
  let codeBody = "";
  for (const b of randBytes) {
    codeBody += alphabet[b % alphabet.length];
  }
  const confirmCode = `GDR-${codeBody}`;
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
  const authStatus = getModuleAuthStatus();

  activeChallenges.set(challengeId, {
    challengeId,
    moduleId,
    confirmCode,
    packageDigest: verification.packageDigest,
    expiresAtMs,
  });

  return {
    challengeId,
    moduleId,
    confirmCode,
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlSeconds: Math.round(CHALLENGE_TTL_MS / 1000),
    requiresPassphrase: authStatus.passphraseEnabled,
    verification,
    permissions: {
      uiSlots: manifest.integration?.uiSlots || [],
      httpRoutes: manifest.integration?.httpRoutes || [],
      mcpTools: manifest.integration?.mcpTools || [],
      hasStandaloneExtension: Boolean(manifest.integration?.extensionDir),
      securityBoundary: manifest.securityBoundary || {},
    },
  };
}

export function consumeInstallChallenge({
  challengeId,
  moduleId,
  confirmCode,
  passphrase = "",
  expectedDigest,
}) {
  pruneExpiredChallenges();
  if (!challengeId || !confirmCode) {
    const err = new Error(
      "Module installation requires explicit human verification (missing challengeId or confirmCode)"
    );
    err.code = "ERR_INSTALL_VERIFICATION_REQUIRED";
    throw err;
  }

  const ch = activeChallenges.get(challengeId);
  if (!ch || ch.moduleId !== moduleId) {
    appendModuleAuditLog({
      action: "install_verify_failed",
      moduleId,
      reason: "invalid_or_expired_challenge",
      ok: false,
    });
    const err = new Error("Install verification challenge is invalid or expired; please request a new challenge");
    err.code = "ERR_INSTALL_VERIFICATION_FAILED";
    throw err;
  }

  const normalizedInput = String(confirmCode).trim().toUpperCase();
  const a = Buffer.from(normalizedInput, "utf8");
  const b = Buffer.from(ch.confirmCode, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    appendModuleAuditLog({
      action: "install_verify_failed",
      moduleId,
      reason: "confirm_code_mismatch",
      ok: false,
    });
    const err = new Error("Verification confirmation code does not match");
    err.code = "ERR_INSTALL_VERIFICATION_FAILED";
    throw err;
  }

  if (expectedDigest && ch.packageDigest !== expectedDigest) {
    activeChallenges.delete(challengeId);
    const err = new Error("Module package digest changed after challenge creation");
    err.code = "ERR_MODULE_SIGNATURE_INVALID";
    throw err;
  }

  if (!verifyModuleInstallPassphrase(passphrase)) {
    appendModuleAuditLog({
      action: "install_verify_failed",
      moduleId,
      reason: "invalid_passphrase",
      ok: false,
    });
    const err = new Error("Module install passphrase is incorrect");
    err.code = "ERR_INSTALL_VERIFICATION_FAILED";
    throw err;
  }

  // Single-use: consume immediately upon verification success
  activeChallenges.delete(challengeId);
  return { verified: true, challengeId, packageDigest: ch.packageDigest };
}
