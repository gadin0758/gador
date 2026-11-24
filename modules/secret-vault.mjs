import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Gador Module Secret Vault (AES-256-GCM)
// Policy: Module source code and non-sensitive settings stay 100% readable plaintext.
// ONLY sensitive secrets (proxy passwords, auth tokens, API keys, private credentials)
// are encrypted at rest via this vault using AES-256-GCM with per-entry random 96-bit IVs.

function resolveConfigRoot() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "gador"
  );
}

export function resolveVaultMasterKeyPath() {
  if (process.env.GADOR_VAULT_KEY_FILE) {
    return process.env.GADOR_VAULT_KEY_FILE;
  }
  return path.join(resolveConfigRoot(), "keys", "vault-master.key");
}

export function resolveModuleVaultPath(moduleId) {
  const cleanId = String(moduleId || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(cleanId)) {
    const err = new Error(`Invalid moduleId for secret vault: ${moduleId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const dir =
    process.env.GADOR_VAULT_DIR || path.join(resolveConfigRoot(), "secrets");
  return path.join(dir, `${cleanId}.vault.enc.json`);
}

function getOrCreateMasterKey() {
  const keyPath = resolveVaultMasterKeyPath();
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, "utf8").trim();
    const buf = Buffer.from(hex, "hex");
    if (buf.length === 32) return buf;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

function deriveEntryKey(masterKey, moduleId, saltHex) {
  return crypto.scryptSync(
    masterKey,
    Buffer.from(`gador-vault-v1:${moduleId}:${saltHex}`, "utf8"),
    32
  );
}

function encryptSecretValue(plaintext, moduleId, masterKey) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iv = crypto.randomBytes(12);
  const key = deriveEntryKey(masterKey, moduleId, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`gador-vault-v1:${moduleId}`, "utf8"));
  const ct = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ct.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

function decryptSecretValue(record, moduleId, masterKey) {
  const key = deriveEntryKey(masterKey, moduleId, record.salt);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(record.iv, "base64")
  );
  decipher.setAAD(Buffer.from(`gador-vault-v1:${moduleId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

function readVaultFile(vaultPath, moduleId) {
  if (!fs.existsSync(vaultPath)) {
    return { version: 1, moduleId, encryption: "aes-256-gcm", secrets: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
  return {
    version: 1,
    moduleId,
    encryption: "aes-256-gcm",
    secrets: parsed && typeof parsed.secrets === "object" ? parsed.secrets : {},
  };
}

function writeVaultFile(vaultPath, doc) {
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    vaultPath,
    JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 }
  );
}

/**
 * Open a module-scoped secret vault.
 * Only sensitive fields (passwords, tokens, API keys) should be stored here;
 * module source code and non-sensitive settings remain readable plaintext.
 */
export function openModuleSecretVault(moduleId) {
  const vaultPath = resolveModuleVaultPath(moduleId);

  return {
    moduleId,
    vaultPath,
    listKeys() {
      const doc = readVaultFile(vaultPath, moduleId);
      return Object.entries(doc.secrets).map(([name, meta]) => ({
        name,
        alg: meta.alg,
        updatedAt: meta.updatedAt || null,
      }));
    },
    setSecret(name, plaintextValue) {
      const cleanName = String(name || "").trim();
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(cleanName)) {
        const err = new Error(`Invalid secret key name: ${name}`);
        err.code = "ERR_INVALID_PARAMS";
        throw err;
      }
      const masterKey = getOrCreateMasterKey();
      const doc = readVaultFile(vaultPath, moduleId);
      doc.secrets[cleanName] = encryptSecretValue(plaintextValue, moduleId, masterKey);
      writeVaultFile(vaultPath, doc);
      return { saved: true, name: cleanName, vaultPath };
    },
    getSecret(name) {
      const doc = readVaultFile(vaultPath, moduleId);
      const rec = doc.secrets[name];
      if (!rec) return null;
      const masterKey = getOrCreateMasterKey();
      return decryptSecretValue(rec, moduleId, masterKey);
    },
    deleteSecret(name) {
      const doc = readVaultFile(vaultPath, moduleId);
      if (!(name in doc.secrets)) return { deleted: false, name };
      delete doc.secrets[name];
      writeVaultFile(vaultPath, doc);
      return { deleted: true, name };
    },
  };
}
