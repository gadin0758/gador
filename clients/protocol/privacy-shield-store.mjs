import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRIVACY_SHIELD_FLAG_KEYS = [
  "canvasFarbling",
  "webglFarbling",
  "audioFarbling",
  "clientRectsJitter",
  "hardwareNormalization",
  "webrtcLeakProtection",
  "gpcHeader",
  "hideAutomationHints",
];

export const PRIVACY_SHIELD_PRESETS = {
  off: {
    level: "off",
    canvasFarbling: false,
    webglFarbling: false,
    audioFarbling: false,
    clientRectsJitter: false,
    hardwareNormalization: false,
    webrtcLeakProtection: true,
    gpcHeader: false,
    hideAutomationHints: false,
  },
  standard: {
    level: "standard",
    canvasFarbling: true,
    webglFarbling: true,
    audioFarbling: true,
    clientRectsJitter: false,
    hardwareNormalization: true,
    webrtcLeakProtection: true,
    gpcHeader: true,
    hideAutomationHints: true,
  },
  strict: {
    level: "strict",
    canvasFarbling: true,
    webglFarbling: true,
    audioFarbling: true,
    clientRectsJitter: true,
    hardwareNormalization: true,
    webrtcLeakProtection: true,
    gpcHeader: true,
    hideAutomationHints: true,
  },
};

export function resolvePrivacyShieldConfigPath() {
  if (process.env.GADOR_PRIVACY_SHIELD_FILE) {
    return process.env.GADOR_PRIVACY_SHIELD_FILE;
  }
  const cfgDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "gador"
  );
  return path.join(cfgDir, "privacy-shield.json");
}

function normalizePrivacyShield(raw) {
  const base = { ...PRIVACY_SHIELD_PRESETS.standard };
  if (raw && typeof raw === "object") {
    if (raw.level && PRIVACY_SHIELD_PRESETS[raw.level]) {
      Object.assign(base, PRIVACY_SHIELD_PRESETS[raw.level]);
    }
    for (const key of PRIVACY_SHIELD_FLAG_KEYS) {
      if (typeof raw[key] === "boolean") {
        base[key] = raw[key];
      }
    }
    if (typeof raw.updatedAt === "string") base.updatedAt = raw.updatedAt;
    if (typeof raw.updatedBy === "string") base.updatedBy = raw.updatedBy;
  }
  const fingerprintOn = [
    base.canvasFarbling,
    base.webglFarbling,
    base.audioFarbling,
    base.clientRectsJitter,
    base.hardwareNormalization,
    base.gpcHeader,
    base.hideAutomationHints,
  ].some(Boolean);
  if (!fingerprintOn) {
    base.level = "off";
  } else if (base.clientRectsJitter) {
    base.level = "strict";
  } else {
    base.level = "standard";
  }
  return base;
}

export function getPrivacyShieldState() {
  const configFile = resolvePrivacyShieldConfigPath();
  let parsed = null;
  try {
    if (fs.existsSync(configFile)) {
      parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    }
  } catch {
    parsed = null;
  }
  const privacyShield = normalizePrivacyShield(parsed);
  return {
    configFile,
    editableByAi: true,
    presets: Object.keys(PRIVACY_SHIELD_PRESETS),
    privacyShield,
  };
}

export function updatePrivacyShield(patch = {}, { actor = "user" } = {}) {
  const configFile = resolvePrivacyShieldConfigPath();
  const current = getPrivacyShieldState().privacyShield;
  let next = { ...current };

  if (patch && typeof patch.level === "string") {
    if (!PRIVACY_SHIELD_PRESETS[patch.level]) {
      const err = new Error(
        `Unsupported privacy shield level: ${patch.level} (expected off | standard | strict)`
      );
      err.code = "ERR_INVALID_PARAMS";
      throw err;
    }
    next = { ...PRIVACY_SHIELD_PRESETS[patch.level] };
  }

  for (const key of PRIVACY_SHIELD_FLAG_KEYS) {
    if (typeof patch?.[key] === "boolean") {
      next[key] = patch[key];
    }
  }

  const normalized = normalizePrivacyShield({
    ...next,
    updatedAt: new Date().toISOString(),
    updatedBy: actor === "ai" ? "ai" : "user",
  });

  const cfgDir = path.dirname(configFile);
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2) + "\n", {
    mode: 0o600,
  });

  return {
    configFile,
    editableByAi: true,
    presets: Object.keys(PRIVACY_SHIELD_PRESETS),
    privacyShield: normalized,
  };
}

export function buildPrivacyAuditExpression() {
  return `(() => {
    const out = {
      url: location.href,
      origin: location.origin,
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: Array.isArray(navigator.languages) ? [...navigator.languages] : [],
        webdriver: navigator.webdriver,
        globalPrivacyControl: Boolean(navigator.globalPrivacyControl),
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        hasBatteryApi: typeof navigator.getBattery === "function",
        pluginsCount: navigator.plugins ? navigator.plugins.length : 0,
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio,
        screenWidth: window.screen?.width ?? null,
        screenHeight: window.screen?.height ?? null,
        colorDepth: window.screen?.colorDepth ?? null,
      },
      webgl: { supported: false },
      canvas: { supported: false },
      audio: { supported: typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined" },
      functionToStringNative: (() => {
        try {
          return Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL).includes("[native code]");
        } catch {
          return false;
        }
      })(),
    };

    try {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 40;
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#4f7cff";
        ctx.fillRect(0, 0, 160, 40);
        ctx.fillStyle = "#ffffff";
        ctx.font = "14px sans-serif";
        ctx.fillText("Gador Privacy Audit 1.0", 8, 24);
        const d1 = c.toDataURL();
        const d2 = c.toDataURL();
        let h = 2166136261;
        for (let i = 0; i < d1.length; i++) {
          h ^= d1.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        out.canvas = {
          supported: true,
          deterministicWithinOrigin: d1 === d2,
          hash: h.toString(16).padStart(8, "0"),
          length: d1.length,
        };
      }
    } catch (e) {
      out.canvas = { supported: false, error: String(e?.message || e) };
    }

    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (gl) {
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        out.webgl = {
          supported: true,
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      }
    } catch (e) {
      out.webgl = { supported: false, error: String(e?.message || e) };
    }

    return JSON.stringify(out);
  })()`;
}
