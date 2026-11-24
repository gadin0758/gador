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
