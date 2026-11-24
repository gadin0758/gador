// Gador Module Taxonomy, Exclusive Conflict Groups & Lifecycle Specification

export const MODULE_CATEGORIES = {
  network: {
    id: "network",
    label: "网络与隧道",
    description: "独立代理、VPN 隧道档案、DoH 解析与宿主机代理联动模块",
  },
  privacy: {
    id: "privacy",
    label: "隐私与指纹防护",
    description: "反指纹扰动、追踪拦截、请求头隐私信号（Sec-GPC）与环境体检模块",
  },
  identity: {
    id: "identity",
    label: "身份与会话容器",
    description: "多账号隔离容器、临时身份档案与会话切换辅助模块",
  },
  automation: {
    id: "automation",
    label: "AI 自动化与站点增强",
    description: "站点语义插件、DOM 感知辅助与受控工作流模块",
  },
  appearance: {
    id: "appearance",
    label: "外观与光场主题",
    description: "自定义光场色调预设、布局皮肤与界面交互扩展模块",
  },
  security: {
    id: "security",
    label: "安全审计与策略防护",
    description: "下载拦截、域名白名单、企业合规审计与凭据外泄防护模块",
  },
  productivity: {
    id: "productivity",
    label: "效率与工作区工具",
    description: "标签分组、稍后阅读、剪贴板/笔记联动与快捷命令模块",
  },
  content: {
    id: "content",
    label: "内容净化与阅读增强",
    description: "元素屏蔽、沉浸式阅读模式、页面翻译与排版字体增强模块",
  },
  developer: {
    id: "developer",
    label: "开发者与调试工具",
    description: "请求抓包检查、Header/Mock 注入、性能与无障碍诊断模块",
  },
  media: {
    id: "media",
    label: "音视频与媒体控制",
    description: "独立标签音量/倍速、画中画增强、字幕与媒体捕获控制模块",
  },
  data: {
    id: "data",
    label: "数据采集与同步导出",
    description: "结构化页面抽取、本地知识归档与加密配置同步导出模块",
  },
  search: {
    id: "search",
    label: "搜索与知识库检索",
    description: "自定义聚合搜索、本地文档/RAG 检索与问答增强模块",
  },
};

export const EXCLUSIVE_CONFLICT_GROUPS = {
  "network-egress": {
    id: "network-egress",
    label: "浏览器网络出口槽位",
    description: "同一时间仅允许一个网络出口/VPN 管理模块处于启用状态，避免路由规则互相覆盖",
  },
  "fingerprint-engine": {
    id: "fingerprint-engine",
    label: "反指纹与环境伪装引擎槽位",
    description: "同一时间仅允许一个 MAIN-world 反指纹模块启用，避免 Canvas/WebGL/Navigator 钩子互相冲突破坏页面",
  },
  "newtab-override": {
    id: "newtab-override",
    label: "新标签页覆盖槽位",
    description: "同一时间仅允许一个扩展接管 chrome://newtab",
  },
  "dns-resolver": {
    id: "dns-resolver",
    label: "独立 DNS / DoH 接管槽位",
    description: "同一时间仅允许一个模块接管独立 DNS/DoH 策略",
  },
  "cookie-policy": {
    id: "cookie-policy",
    label: "Cookie 策略接管槽位",
    description: "默认保留 Chromium 原生 Cookie 功能；若模块主动覆写/屏蔽原生 Cookie 策略，同一时间仅允许一个模块占用此槽位",
  },
  "content-blocker": {
    id: "content-blocker",
    label: "全站内容拦截规则槽位",
    description: "同一时间仅允许一个主内容净化/广告拦截引擎接管全站 DNR 规则，避免规则集互相冲突",
  },
  "search-provider": {
    id: "search-provider",
    label: "默认搜索增强槽位",
    description: "同一时间仅允许一个搜索增强模块接管默认搜索路由与联想建议",
  },
};

export const CRITICAL_SECURITY_GROUPS = new Set([
  "network-egress",
  "fingerprint-engine",
  "dns-resolver",
  "cookie-policy",
]);

export function resolveModuleSecurityTier(manifest) {
  if (manifest?.securityTier === "critical") return "critical";
  if (manifest?.id === "vpn" || manifest?.id === "privacy-shield") return "critical";
  const groups = Array.isArray(manifest?.compatibility?.exclusiveGroups)
    ? manifest.compatibility.exclusiveGroups
    : [];
  if (groups.some((g) => CRITICAL_SECURITY_GROUPS.has(g))) return "critical";
  return "standard";
}

export const MODULE_LIFECYCLE_METHODS = [
  "checkCompatibility",
  "onInstall",
  "onEnable",
  "onDisable",
  "onUninstall",
  "getStatus",
  "healthCheck",
];

export const CUSTOM_SETTING_TYPES = ["boolean", "select", "number", "string"];

/**
 * Normalize `settingsSchema` declared inside a module's `module.json`.
 * Users gain custom-setting permissions ONLY for modules that are installed & enabled,
 * strictly scoped to the features and fields declared here.
 */
export function normalizeSettingsSchema(manifest) {
  const raw = Array.isArray(manifest?.settingsSchema)
    ? manifest.settingsSchema
    : [];
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const key = String(item.key || "").trim();
    if (!key || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || seen.has(key)) {
      continue;
    }
    const type = CUSTOM_SETTING_TYPES.includes(item.type) ? item.type : "boolean";
    const options =
      type === "select" && Array.isArray(item.options)
        ? item.options
            .map((opt) => {
              if (opt && typeof opt === "object") {
                const value = String(opt.value ?? "").trim();
                return value ? { value, label: String(opt.label || value) } : null;
              }
              const value = String(opt ?? "").trim();
              return value ? { value, label: value } : null;
            })
            .filter(Boolean)
        : [];
    if (type === "select" && options.length === 0) continue;

    let defVal = item.default;
    if (type === "boolean") defVal = Boolean(defVal);
    else if (type === "select") {
      defVal = options.some((o) => o.value === String(defVal))
        ? String(defVal)
        : options[0].value;
    } else if (type === "number") {
      defVal = Number.isFinite(Number(defVal)) ? Number(defVal) : 0;
    } else {
      defVal = typeof defVal === "string" ? defVal : "";
    }

    const mutuallyExclusiveWith = Array.isArray(item.mutuallyExclusiveWith)
      ? item.mutuallyExclusiveWith.map((s) => String(s).trim()).filter(Boolean)
      : [];

    seen.add(key);
    normalized.push({
      key,
      label: String(item.label || key),
      description: String(item.description || ""),
      feature: String(item.feature || "general"),
      slot: String(item.slot || "ai"),
      submenu: item.submenu ? String(item.submenu).trim() : "",
      type,
      default: defVal,
      options,
      min: Number.isFinite(Number(item.min)) ? Number(item.min) : null,
      max: Number.isFinite(Number(item.max)) ? Number(item.max) : null,
      maxLength:
        Number.isFinite(Number(item.maxLength)) && Number(item.maxLength) > 0
          ? Math.min(2048, Number(item.maxLength))
          : 512,
      mutuallyExclusiveWith,
    });
  }
  return normalized;
}

export const SUBMENU_ITEM_TYPES = ["setting", "action", "info"];

/**
 * Normalize creator-authored secondary menus (`submenus`) declared in a module's `module.json`.
 * Each module creator designs their own submenu tabs & items using strictly declarative JSON:
 *   - { type: "setting", key }                -> binds a field declared in this module's settingsSchema
 *   - { type: "action", id, label, method }   -> invokes an exported sandbox method inside bubblewrap
 *   - { type: "info", label, text }           -> read-only status/description row (TrustedTypes safe)
 */
export function normalizeModuleSubmenus(manifest, settingsSchema = null) {
  const schema = Array.isArray(settingsSchema)
    ? settingsSchema
    : normalizeSettingsSchema(manifest);
  const validSettingKeys = new Set(schema.map((f) => f.key));
  const rawList = Array.isArray(manifest?.submenus) ? manifest.submenus : [];
  const seenIds = new Set();
  const menus = [];

  for (let idx = 0; idx < rawList.length && menus.length < 12; idx++) {
    const raw = rawList[idx];
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const items = [];
    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    const seenSettingInMenu = new Set();

    for (const item of rawItems) {
      if (items.length >= 32) break;
      if (!item || typeof item !== "object") continue;
      const type = String(item.type || "").trim();
      if (!SUBMENU_ITEM_TYPES.includes(type)) continue;

      if (type === "setting") {
        const key = String(item.key || "").trim();
        if (!key || !validSettingKeys.has(key) || seenSettingInMenu.has(key)) continue;
        seenSettingInMenu.add(key);
        items.push({ type: "setting", key });
      } else if (type === "action") {
        const method = String(item.method || "").trim();
        if (!method || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(method)) continue;
        const actionId = String(item.id || method).trim();
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(actionId)) continue;
        items.push({
          type: "action",
          id: actionId,
          label: String(item.label || actionId),
          description: String(item.description || ""),
          method,
          args:
            item.args && typeof item.args === "object" && !Array.isArray(item.args)
              ? item.args
              : {},
          danger: Boolean(item.danger),
        });
      } else if (type === "info") {
        items.push({
          type: "info",
          label: String(item.label || ""),
          text: String(item.text || ""),
        });
      }
    }

    // Also attach any settingsSchema fields explicitly assigned to `submenu: id` that weren't listed in items
    for (const field of schema) {
      if (items.length >= 32) break;
      if (field.submenu === id && !seenSettingInMenu.has(field.key)) {
        seenSettingInMenu.add(field.key);
        items.push({ type: "setting", key: field.key });
      }
    }

    menus.push({
      id,
      label: String(raw.label || id),
      description: String(raw.description || ""),
      icon: String(raw.icon || "sliders").slice(0, 32),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : idx + 1,
      items,
    });
  }

  menus.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return menus;
}

export function getDefaultCustomSettings(schema) {
  const out = {};
  for (const field of schema || []) {
    out[field.key] = field.default;
  }
  return out;
}

/**
 * Validate a patch against a module's declared `settingsSchema`.
 * Rejects undeclared keys, invalid types/ranges, and mutually exclusive boolean settings.
 */
export function validateModuleCustomSettings(schema, currentValues, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const err = new Error("Custom settings patch must be a JSON object.");
    err.code = "ERR_INVALID_SETTING";
    throw err;
  }
  const byKey = new Map((schema || []).map((f) => [f.key, f]));
  const nextValues = { ...getDefaultCustomSettings(schema), ...(currentValues || {}) };
  const changedKeys = [];

  for (const [key, rawVal] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) {
      const err = new Error(
        `Setting "${key}" is not declared in this module's settingsSchema.`
      );
      err.code = "ERR_INVALID_SETTING";
      throw err;
    }
    let coerced;
    if (field.type === "boolean") {
      if (typeof rawVal !== "boolean") {
        const err = new Error(`Setting "${key}" requires a boolean value.`);
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      coerced = rawVal;
    } else if (field.type === "select") {
      const sv = String(rawVal ?? "");
      if (!field.options.some((o) => o.value === sv)) {
        const err = new Error(
          `Setting "${key}" must be one of: ${field.options.map((o) => o.value).join(", ")}.`
        );
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      coerced = sv;
    } else if (field.type === "number") {
      const nv = Number(rawVal);
      if (!Number.isFinite(nv)) {
        const err = new Error(`Setting "${key}" requires a finite number.`);
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      if (field.min !== null && nv < field.min) {
        const err = new Error(`Setting "${key}" must be >= ${field.min}.`);
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      if (field.max !== null && nv > field.max) {
        const err = new Error(`Setting "${key}" must be <= ${field.max}.`);
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      coerced = nv;
    } else {
      if (typeof rawVal !== "string") {
        const err = new Error(`Setting "${key}" requires a string value.`);
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      if (rawVal.length > field.maxLength) {
        const err = new Error(
          `Setting "${key}" exceeds max length (${field.maxLength}).`
        );
        err.code = "ERR_INVALID_SETTING";
        throw err;
      }
      coerced = rawVal;
    }
    nextValues[key] = coerced;
    changedKeys.push(key);
  }

  // Enforce setting-level mutual exclusion (e.g., two incompatible boolean modes)
  for (const field of schema || []) {
    if (field.type !== "boolean" || nextValues[field.key] !== true) continue;
    for (const conflictKey of field.mutuallyExclusiveWith || []) {
      const other = byKey.get(conflictKey);
      if (other && other.type === "boolean" && nextValues[conflictKey] === true) {
        const err = new Error(
          `Custom setting "${field.label}" (${field.key}) conflicts with "${other.label}" (${conflictKey}); disable one before enabling the other.`
        );
        err.code = "ERR_SETTING_CONFLICT";
        err.conflictKeys = [field.key, conflictKey];
        throw err;
      }
    }
  }

  return { values: nextValues, changedKeys };
}

export function normalizeCompatibility(manifest) {
  const compat = manifest?.compatibility && typeof manifest.compatibility === "object"
    ? manifest.compatibility
    : {};
  const exclusiveGroups = Array.isArray(compat.exclusiveGroups)
    ? compat.exclusiveGroups.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const conflictsWith = Array.isArray(compat.conflictsWith)
    ? compat.conflictsWith.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const requires = Array.isArray(compat.requires)
    ? compat.requires.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const mutuallyExclusiveFeatures = Array.isArray(compat.mutuallyExclusiveFeatures)
    ? compat.mutuallyExclusiveFeatures
    : [];
  return {
    exclusiveGroups,
    conflictsWith,
    requires,
    mutuallyExclusiveFeatures,
  };
}

/**
 * Evaluate whether enabling `targetModule` conflicts with any currently enabled modules
 * or misses any required dependency modules.
 */
export function evaluateModuleConflicts(targetModule, allModules) {
  const targetCompat = normalizeCompatibility(targetModule.manifest);
  const blockedBy = [];
  const missingDependencies = [];

  for (const reqId of targetCompat.requires) {
    const dep = allModules.find((m) => m.id === reqId);
    if (!dep || !dep.installed || !dep.enabled) {
      missingDependencies.push({
        moduleId: reqId,
        reason: `依赖模块 "${reqId}" 尚未安装或未启用`,
      });
    }
  }

  for (const other of allModules) {
    if (other.id === targetModule.id) continue;
    if (!other.installed || !other.enabled) continue;
    const otherCompat = normalizeCompatibility(other.manifest);

    // 1. Explicit bidirectional conflictsWith check
    if (
      targetCompat.conflictsWith.includes(other.id) ||
      otherCompat.conflictsWith.includes(targetModule.id)
    ) {
      blockedBy.push({
        moduleId: other.id,
        moduleName: other.name || other.id,
        type: "explicit_conflict",
        group: null,
        reason: `与已启用的模块「${other.name || other.id}」显式互斥，无法同时开启`,
      });
      continue;
    }

    // 2. Shared exclusiveGroups check
    for (const grp of targetCompat.exclusiveGroups) {
      if (otherCompat.exclusiveGroups.includes(grp)) {
        const grpMeta = EXCLUSIVE_CONFLICT_GROUPS[grp];
        blockedBy.push({
          moduleId: other.id,
          moduleName: other.name || other.id,
          type: "exclusive_group",
          group: grp,
          groupLabel: grpMeta?.label || grp,
          reason: `与已启用的模块「${other.name || other.id}」共同占用互斥槽位「${grpMeta?.label || grp}」，需先停用对方`,
        });
      }
    }
  }

  return {
    canEnable: blockedBy.length === 0 && missingDependencies.length === 0,
    blocked: blockedBy.length > 0 || missingDependencies.length > 0,
    blockedBy,
    missingDependencies,
    exclusiveGroups: targetCompat.exclusiveGroups,
    conflictsWith: targetCompat.conflictsWith,
    requires: targetCompat.requires,
    mutuallyExclusiveFeatures: targetCompat.mutuallyExclusiveFeatures,
  };
}
