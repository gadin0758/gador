import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_MODES = new Set(["strict_tunnel", "direct_only", "custom"]);
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_BACKUP_RE = /^vpn-backup-[a-zA-Z0-9_-]{4,80}$/;

export function resolveVpnStoreDir() {
  if (process.env.GADOR_VPN_STORE_DIR) {
    return path.resolve(process.env.GADOR_VPN_STORE_DIR);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gador", "vpn");
}

function ensureDirs(storeDir) {
  const backupsDir = path.join(storeDir, "backups");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  return {
    storeDir,
    profilesFile: path.join(storeDir, "profiles.json"),
    backupsDir,
  };
}

function readProfilesDoc(profilesFile) {
  if (!fs.existsSync(profilesFile)) {
    return {
      version: 1,
      editableScope: "vpn_only",
      profiles: [],
      updatedAt: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
    return {
      version: 1,
      editableScope: "vpn_only",
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return {
      version: 1,
      editableScope: "vpn_only",
      profiles: [],
      updatedAt: null,
    };
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// Strictly sanitize input so ONLY VPN-related fields can ever be written.
function sanitizeVpnProfile(input, actor = "user") {
  if (!input || typeof input !== "object") {
    const err = new Error("VPN profile payload must be an object");
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const mode = String(input.mode || "strict_tunnel").trim();
  if (!ALLOWED_MODES.has(mode)) {
    const err = new Error(`Invalid VPN mode: ${mode}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const scope = String(input.scope || "browser").trim() || "browser";
  if (scope !== "browser" && !scope.startsWith("space:")) {
    const err = new Error(`Invalid VPN scope (expected 'browser' or 'space:<id>'): ${scope}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const endpoint = String(input.endpoint || "").trim();
  if (mode === "strict_tunnel" && !endpoint) {
    const err = new Error("strict_tunnel mode requires a tunnel endpoint (e.g. socks5://127.0.0.1:7890)");
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const rawId = input.id ? String(input.id).trim() : "";
  const id = rawId && SAFE_ID_RE.test(rawId)
    ? rawId
    : `vpn_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;

  const name = String(input.name || "").trim().slice(0, 64) || `${mode} (${scope})`;
  const dohServer = String(input.dohServer || "").trim().slice(0, 256);
  const bypassList = Array.isArray(input.bypassList)
    ? input.bypassList.map((s) => String(s).trim()).filter(Boolean).slice(0, 64)
    : [];
  const failClosed = input.failClosed === undefined ? true : Boolean(input.failClosed);
  const note = String(input.note || "").trim().slice(0, 200);

  return {
    id,
    name,
    scope,
    mode,
    endpoint,
    dohServer,
    bypassList,
    webrtcPolicy: "disable_non_proxied_udp",
    failClosed,
    note,
    updatedAt: new Date().toISOString(),
    updatedBy: actor === "ai" ? "ai" : "user",
  };
}

export function listVpnBackups(storeDir = resolveVpnStoreDir()) {
  const { backupsDir } = ensureDirs(storeDir);
  const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".json"));
  const items = [];
  for (const file of files) {
    const full = path.join(backupsDir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      items.push({
        backupId: parsed.backupId || file.replace(/\.json$/, ""),
        createdAt: parsed.createdAt || new Date(fs.statSync(full).mtimeMs).toISOString(),
        actor: parsed.actor || "user",
        reason: parsed.reason || "manual_backup",
        profileCount: Array.isArray(parsed.snapshot?.profiles) ? parsed.snapshot.profiles.length : 0,
        filePath: full,
      });
    } catch {
      // skip corrupted backup entry
    }
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return items;
}

export function getVpnStoreState(storeDir = resolveVpnStoreDir()) {
  const { profilesFile, backupsDir } = ensureDirs(storeDir);
  const doc = readProfilesDoc(profilesFile);
  const backups = listVpnBackups(storeDir);
  return {
    editableScope: "vpn_only",
    storeDir,
    profilesFile,
    backupsDir,
    profiles: doc.profiles,
    updatedAt: doc.updatedAt,
    backups,
  };
}

export function createVpnBackup({
  reason = "manual_backup",
  actor = "user",
  extraMeta = null,
  storeDir = resolveVpnStoreDir(),
} = {}) {
  const { profilesFile, backupsDir } = ensureDirs(storeDir);
  const doc = readProfilesDoc(profilesFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const backupId = `vpn-backup-${stamp}-${rand}`;
  const filePath = path.join(backupsDir, `${backupId}.json`);

  const record = {
    backupId,
    createdAt: new Date().toISOString(),
    actor: actor === "ai" ? "ai" : "user",
    reason: String(reason || "pre_modify_backup").trim().slice(0, 160),
    extraMeta: extraMeta && typeof extraMeta === "object" ? extraMeta : undefined,
    snapshot: doc,
  };
  writeJsonAtomic(filePath, record);

  return {
    backupId,
    createdAt: record.createdAt,
    actor: record.actor,
    reason: record.reason,
    profileCount: doc.profiles.length,
    filePath,
  };
}

export function upsertVpnProfile(
  profileInput,
  { actor = "user", backupReason = "", storeDir = resolveVpnStoreDir() } = {}
) {
  const reasonText = String(backupReason || "").trim();
  if (actor === "ai" && !reasonText) {
    const err = new Error(
      "AI 修改 VPN 档案前必须提供 backupReason 说明修改原因，以便强制留存备份。"
    );
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const sanitized = sanitizeVpnProfile(profileInput, actor);
  const { profilesFile } = ensureDirs(storeDir);

  // Mandatory pre-modify backup BEFORE writing any change
  const backup = createVpnBackup({
    reason: reasonText || `upsert_profile:${sanitized.name}`,
    actor,
    storeDir,
  });

  const doc = readProfilesDoc(profilesFile);
  const idx = doc.profiles.findIndex((p) => p.id === sanitized.id);
  if (idx >= 0) {
    doc.profiles[idx] = sanitized;
  } else {
    doc.profiles.unshift(sanitized);
  }
  doc.updatedAt = sanitized.updatedAt;
  writeJsonAtomic(profilesFile, doc);

  return {
    profile: sanitized,
    backup,
    profiles: doc.profiles,
  };
}

export function deleteVpnProfile(
  id,
  { actor = "user", backupReason = "", storeDir = resolveVpnStoreDir() } = {}
) {
  const targetId = String(id || "").trim();
  if (!SAFE_ID_RE.test(targetId)) {
    const err = new Error(`Invalid VPN profile id: ${targetId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const reasonText = String(backupReason || "").trim();
  if (actor === "ai" && !reasonText) {
    const err = new Error(
      "AI 删除 VPN 档案前必须提供 backupReason 说明原因，以便强制留存备份。"
    );
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const { profilesFile } = ensureDirs(storeDir);
  const doc = readProfilesDoc(profilesFile);
  const exists = doc.profiles.some((p) => p.id === targetId);
  if (!exists) {
    const err = new Error(`VPN profile not found: ${targetId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  // Mandatory pre-delete backup BEFORE removing
  const backup = createVpnBackup({
    reason: reasonText || `delete_profile:${targetId}`,
    actor,
    storeDir,
  });

  doc.profiles = doc.profiles.filter((p) => p.id !== targetId);
  doc.updatedAt = new Date().toISOString();
  writeJsonAtomic(profilesFile, doc);

  return {
    deletedId: targetId,
    backup,
    profiles: doc.profiles,
  };
}

export function restoreVpnBackup(
  backupId,
  { actor = "user", storeDir = resolveVpnStoreDir() } = {}
) {
  const safeId = String(backupId || "").trim();
  if (!SAFE_BACKUP_RE.test(safeId)) {
    const err = new Error(`Invalid backupId: ${safeId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const { profilesFile, backupsDir } = ensureDirs(storeDir);
  const filePath = path.join(backupsDir, `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    const err = new Error(`Backup not found: ${safeId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const snapshot = parsed.snapshot;
  if (!snapshot || !Array.isArray(snapshot.profiles)) {
    const err = new Error(`Corrupted backup snapshot: ${safeId}`);
    err.code = "ERR_INTERNAL";
    throw err;
  }

  // Always snapshot current state before restoring so nothing is ever lost
  const preRestoreBackup = createVpnBackup({
    reason: `before_restore:${safeId}`,
    actor,
    storeDir,
  });

  const restoredDoc = {
    version: 1,
    editableScope: "vpn_only",
    profiles: snapshot.profiles,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(profilesFile, restoredDoc);

  return {
    restoredBackupId: safeId,
    preRestoreBackup,
    profiles: restoredDoc.profiles,
  };
}

export function deleteVpnBackup(backupId, storeDir = resolveVpnStoreDir()) {
  const safeId = String(backupId || "").trim();
  if (!SAFE_BACKUP_RE.test(safeId)) {
    const err = new Error(`Invalid backupId: ${safeId}`);
    err.code = "ERR_INVALID_PARAMS";
    throw err;
  }
  const { backupsDir } = ensureDirs(storeDir);
  const filePath = path.join(backupsDir, `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    return { deleted: false, backupId: safeId };
  }
  fs.unlinkSync(filePath);
  return { deleted: true, backupId: safeId };
}

export function clearVpnBackups(storeDir = resolveVpnStoreDir()) {
  const { backupsDir } = ensureDirs(storeDir);
  const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".json"));
  let deletedCount = 0;
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(backupsDir, file));
      deletedCount++;
    } catch {
      // ignore individual unlink failures
    }
  }
  return { deletedCount };
}
