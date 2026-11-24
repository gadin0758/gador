# Gador 模块（插件）分类、方法规范、安全验证与开发手册

本文档是面向开发者与高级用户的 **Gador 模块开发与操作规范权威手册**，完整定义：
1. **安全准入与分级验证规范**（为什么普通设置页不直接暴露安装按钮；为什么涉及网络出口或指纹防护的高敏模块属于 `securityTier: "critical"`）
2. **源码明文 + 仅重要资料加密原则**（`openModuleSecretVault` AES-256-GCM）
3. **默认保留 Chromium 原生 Cookie 策略 + 取消/覆写原生 Cookie 的标准接口指南**
4. **模块驱动的用户自定义设置权限与创作者自制二级菜单规范（`settingsSchema` + `submenus`）**：仅当对应模块加入并启用后，按模块内实际功能动态开放自定义设置，并由创作者自由编排每个模块的二级菜单
5. **12 大模块种类、7 个标准生命周期方法、7 大互斥槽位与等待（⏳）/ 禁止（🚫）交互规范**
6. **模块对网页的全部可执行操作清单与代码示例**（加载期注入、网络头治理、DOM 交互、弹窗/标签移交、设置页 UI 与硬安全红线）
7. **从零制作、签名、验证、安装与排障的完整 6 步实操教程**

---

## 1. 安全准入边界与高敏模块重点验证（`securityTier: "critical"`）

### 1.1 普通扩展 vs. Gador 独立高权限模块
- **普通 Chromium 扩展**（常规浏览器扩展）：按浏览器常规机制自由安装，不受本模块验证门禁约束。
- **Gador 独立模块**（包括开发者自制的网络/指纹/安全/自动化等自定义模块）：
  - **禁止在普通浏览器设置页向用户直接展示「一键安装模块」按钮**——未加入对应模块时设置页保持精简，不暴露无关设置项，避免非授权人员误点或被诱导安装高权限模块；
  - 统一通过终端 `gador-mod` 完成签名校验与人工确认后加入，普通用户无法绕过验证流程静默安装。

### 1.2 网络安全高敏模块重点验证机制
凡涉及网络出口/代理路由（如 VPN 类模块）或浏览器环境/指纹防泄漏（如指纹防护类模块），以及所有占用 `network-egress` / `fingerprint-engine` / `dns-resolver` / `cookie-policy` 互斥槽位的自定义模块，系统均将其标记为 **`securityTier: "critical"`**（注：发行仓库本身不附带 VPN 或指纹模块包，如需此类能力请按本手册自行开发与签名），强制执行四重防线：

1. **Ed25519 数字签名 + 全文件 SHA-256 清单核验**：模块目录内每一个文件都必须与 `signature.json` 完全一致，发布者公钥必须位于信任密钥环（内置 `modules/trusted-keys.json` 或用户显式信任的 `~/.config/gador/trusted-module-keys.json`），禁止符号链接与多余未签名文件；
2. **人工两步验证 + 强烈建议启用本机安装密码锁**：安装时必须人工核对发布者、SHA-256 摘要并输入 120 秒单次有效确认码（或 CLI `--confirm-digest <hex>`）；执行 `gador-mod auth set-passphrase` 开启 `scrypt` 密码锁后，任何安装均须同步验密；
3. **源目录与安装目录物理隔离 + 原子暂存替换**：模块先复制至临时 `.staging` 目录并复核签名，通过后才原子切换至 `0700` 权限 `~/.config/gador/installed-modules/<id>/`；
4. **运行时零信任复核、双层加固轻量容器隔离与审计日志**：每次 `gador --desktop` 启动挂载扩展、`gador-mod enable`、`gador-mod doctor` 及启动模块容器前均重新校验已安装目录签名；模块后端逻辑运行于 **无守护进程的超轻量级 `bubblewrap (bwrap)` + Node `--permission` + `prlimit` 双层加固容器**（无模块时不启动、`0 bytes` 空闲占用、64 MiB 堆上限 + 128 MiB 进程树 RSS 看门狗、禁止子进程/`worker_threads`/原生插件、`/tmp` 硬限 4 MiB、单文件 8 MiB / 数据目录 16 MiB 配额且禁符号链接、独立 FD 3 + 128-bit 随机 Nonce 认证 IPC、模块单方面声明 `allowNetwork: true` 默认被宿主机拒绝、60 秒空闲自动整组回收）；所有操作写入 `0600` 权限 `~/.config/gador/module-audit.log`。

> 查看与验证容器隔离状态：
> ```bash
> gador-mod sandbox status            # 无模块启用时为 STOPPED_IDLE (0 容器)
> gador-mod sandbox probe <moduleId>  # 实测容器内隔离探针（$HOME 不可见、模块只读、断网、清环境变量）
> gador-mod sandbox exec <moduleId> healthCheck
> gador-mod sandbox stop [moduleId]
> ```

---

## 2. 明文源码原则与敏感资料加密（AES-256-GCM）

| 资料级别 | 存储形态 | 路径 | 说明 |
| :--- | :--- | :--- | :--- |
| **模块源码与清单** | **100% 可读明文** | `<moduleDir>/module.json`、`index.mjs`、`extension/*.js`、`README.md`、`signature.json` | 方便公开审计与二次开发，全部纳入 SHA-256 签名 |
| **普通配置偏好** | **明文 JSON（`0600`）** | `~/.config/gador/<moduleId>.json` | 开关状态、档位、非敏感规则等 |
| **重要敏感资料** | **AES-256-GCM 密文（`0600`）** | `~/.config/gador/secrets/<moduleId>.vault.enc.json` | 代理账号密码、API Key、认证 Token、私密请求头等 |

```js
import { openModuleSecretVault } from "~/.local/share/gador/modules/secret-vault.mjs";

const vault = openModuleSecretVault("my-module");
vault.setSecret("proxy_password", "s3cr3t-value"); // 仅密文落盘（scrypt + AES-256-GCM）
const pwd = vault.getSecret("proxy_password");     // 校验 AuthTag 后解密返回
const keys = vault.listKeys();                     // 仅列键名与算法，不泄露密文
vault.deleteSecret("proxy_password");
```

---

## 3. 默认保留 Chromium 原生 Cookie 功能与取消/覆写接口指南

### 3.1 默认行为承诺
- **默认情况**：Gador 始终使用 **Chromium 原生 Cookie 引擎与存储策略**（对应原生设置页 `chrome://settings/cookies`）。
- **加入模块后依旧保留**：加入任意自定义模块后，**绝不破坏或默认关闭 Chromium 自带的 Cookie 功能**（确保日常网站登录态、Google 账号同步与 `shared` 空间无缝可用）。

### 3.2 如果开发者/用户希望取消或覆写 Chromium 自带 Cookie 功能，请使用以下标准接口

| 目标场景 | 推荐标准接口 | 作用范围与说明 |
| :--- | :--- | :--- |
| **1. 单个 AI 任务彻底零 Cookie 隔离（不触碰用户个人 Cookie）** | UDS `space.create({ authMode: "private" })` 或 MCP `space_create(authMode="private")` | 派生独立内存 `OTRProfile`，零个人 Cookie，关闭空间即彻底销毁 |
| **2. 清除/删除受管页面的现有 Cookie** | `cdp.send(pageId, "Network.clearBrowserCookies", {})` 或 `cdp.send(pageId, "Network.deleteCookies", { name, domain })` | 仅作用于受管 Agent 空间，安全隔离用户个人标签页 |
| **3. 禁止特定受管页面脚本读写 `document.cookie`** | `cdp.send(pageId, "Emulation.setDocumentCookieDisabled", { disabled: true })`（若内核版本支持）或在模块 `MAIN` world 重定义 `Document.prototype.cookie` getter/setter | 仅阻断 JS 访问 `document.cookie`，不影响其他空间 |
| **4. 在网络层彻底取消浏览器自带的 Cookie 收发（模块级覆写）** | MV3 扩展 `chrome.declarativeNetRequest.updateDynamicRules` 移除请求头 `Cookie` 与响应头 `Set-Cookie` | 可按 `urlFilter` / `domains` / `resourceTypes` 精准屏蔽指定域名或全局 Cookie（需在 `module.json` 声明 `compatibility.exclusiveGroups: ["cookie-policy"]` 防止冲突） |
| **5. 人类手动调整全局第三方/全站 Cookie 策略** | 打开原生设置页 `chrome://settings/cookies`（隐私与安全 → 第三方 Cookie） | Chromium 原生持久偏好，与所有模块兼容 |

**MV3 网络层取消指定站点 Cookie 的明文示例**：
```js
// 在自定义模块的 extension/background.js 中按需注册（须声明 exclusiveGroups: ["cookie-policy"]）
await chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [88001],
  addRules: [
    {
      id: 88001,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Cookie", operation: "remove" }],
        responseHeaders: [{ header: "Set-Cookie", operation: "remove" }],
      },
      condition: {
        urlFilter: "||tracker.example.com^",
        resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "image"],
      },
    },
  ],
});
```

---

## 3.5 模块驱动的用户自定义设置权限规范（`settingsSchema`）

Gador 赋予用户自定义模块设置的权限，但严格遵守 **「有对应模块加入才开放、严格按模块内实际功能添加」** 的授权原则：

1. **前置权限门禁**：
   - 仅当目标模块已通过 Ed25519 签名验证安装并处于 `enabled: true` 状态时，用户才能查看与修改该模块的自定义设置；
   - 未加入或已停用对应模块时，`GET /api/custom-settings` 不暴露该模块面板，`GET/POST/DELETE /api/modules/:id/settings` 与 `gador-mod settings <id>` 均返回 `409 ERR_MODULE_NOT_INSTALLED`。
2. **按模块内功能声明 `settingsSchema`**：
   - 在模块 `module.json` 中声明 `settingsSchema` 数组，每一项对应模块内的一个真实功能配置：
     - 支持类型：`boolean`（开关）、`select`（分段/枚举选项）、`number`（带 `min`/`max` 范围校验）、`string`（带 `maxLength` 长度限制）；
     - 支持声明 `feature`（归属功能名）、`slot`（呈现位置，默认 `"ai"`）与 `mutuallyExclusiveWith`（模块内互斥开关列表，同时开启时返回 `409 ERR_SETTING_CONFLICT` 并在设置页显示 `🚫 冲突禁止`）；
   - 严禁写入 `settingsSchema` 中未声明的任意键（返回 `400 ERR_INVALID_SETTING`）；敏感凭据请使用第 2 节的 `openModuleSecretVault`，不要放在明文设置项中。
3. **动态呈现与持久化**：
   - 用户修改后的非敏感配置持久化于 `0600` 权限的 `~/.config/gador/module-settings/<moduleId>.json`；
   - 设置页自动按 `settingsSchema` 生成交互卡片（带 `⏳` 同步等待与 `🚫` 互斥锁定状态，且提供一键「恢复默认」）。

**`module.json` 中声明 `settingsSchema` 的完整示例**：
```json
"settingsSchema": [
  {
    "key": "strictMode",
    "label": "严格过滤模式",
    "description": "启用更严格的规则匹配策略",
    "feature": "filter-engine",
    "slot": "ai",
    "type": "boolean",
    "default": false,
    "mutuallyExclusiveWith": ["compatMode"]
  },
  {
    "key": "compatMode",
    "label": "兼容直通模式",
    "description": "优先保障站点兼容性（与严格过滤模式互斥）",
    "feature": "filter-engine",
    "slot": "ai",
    "type": "boolean",
    "default": true,
    "mutuallyExclusiveWith": ["strictMode"]
  },
  {
    "key": "logLevel",
    "label": "审计日志级别",
    "feature": "audit",
    "slot": "ai",
    "type": "select",
    "default": "info",
    "options": [
      { "value": "warn", "label": "仅警告" },
      { "value": "info", "label": "标准" },
      { "value": "debug", "label": "详细" }
    ]
  },
  {
    "key": "maxRetries",
    "label": "最大重试次数",
    "feature": "scheduler",
    "slot": "ai",
    "type": "number",
    "default": 3,
    "min": 0,
    "max": 10
  }
]
```

**已启用模块的自定义设置读写方式**：
```bash
# 查看当前所有已启用模块向用户开放的自定义设置面板
gador-mod settings list

# 读取、修改、重置指定已启用模块的自定义设置
gador-mod settings my-custom-mod get
gador-mod settings my-custom-mod set logLevel debug
gador-mod settings my-custom-mod reset
```

---

## 3.6 模块创作者自制二级菜单规范（`submenus`）

每个模块除了声明 `settingsSchema` 外，**每个模块的二级菜单均由模块创作者自己在 `module.json` 的 `submenus` 数组中自由设计与编排**，浏览器设置页在对应模块加入且启用后会自动解析并渲染创作者定制的二级菜单切换栏与内容（全声明式渲染，100% 满足 TrustedTypes CSP、零 XSS 风险）：

- **二级菜单结构**：单个模块最多支持 12 个二级菜单（按 `order` 升序排列），每个二级菜单最多包含 32 个条目；
- **支持 3 类菜单项（`items[].type`）**：
  1. `setting`：`{ "type": "setting", "key": "<settingsSchema中的key>" }` — 绑定该模块自身声明的自定义设置项（自动具备范围校验、`⏳` 等待与 `🚫` 互斥禁止态；也可直接在 `settingsSchema` 项中写 `"submenu": "<menuId>"` 自动归入对应二级菜单，越权引用不存在的键会被自动过滤）；
  2. `action`：`{ "type": "action", "id": "runCheck", "label": "执行自检", "method": "healthCheck", "description": "...", "args": {}, "danger": false }` — 绑定该模块 `index.mjs` 导出的方法，用户点击后通过 `/api/modules/:id/sandbox-exec` 在 `bubblewrap` 轻量隔离容器内安全执行；
  3. `info`：`{ "type": "info", "label": "运行说明", "text": "..." }` — 创作者自定义的只读状态或说明提示行。

**创作者自定义二级菜单完整示例（`module.json`）**：
```json
"submenus": [
  {
    "id": "filter-menu",
    "label": "规则模式",
    "description": "控制过滤策略与兼容性开关",
    "order": 1,
    "items": [
      { "type": "setting", "key": "strictMode" },
      { "type": "setting", "key": "compatMode" }
    ]
  },
  {
    "id": "audit-menu",
    "label": "审计与自检",
    "description": "日志级别、重试参数与容器内健康检查",
    "order": 2,
    "items": [
      { "type": "setting", "key": "logLevel" },
      { "type": "setting", "key": "maxRetries" },
      { "type": "info", "label": "安全说明", "text": "所有动作均在 bubblewrap 轻量命名空间容器内执行" },
      { "type": "action", "id": "runHealth", "label": "运行沙箱自检", "method": "healthCheck" }
    ]
  }
]
```

> 使用 `gador-mod init <moduleId>` 生成新模块脚手架时，已默认附带 `general` 与 `diagnostics` 两个创作者可编辑的二级菜单示例。

---

## 4. 模块种类、标准方法、互斥冲突与等待/禁止标识规范

可通过 `gador-mod spec` 实时查看机器可读的完整规范 JSON（源码：[modules/schema.mjs](../modules/schema.mjs)）。

### 4.1 十二大标准模块种类（`category`）

| `category` | 中文名称 | 适用范围 |
| :--- | :--- | :--- |
| `network` | 网络与隧道 | 自定义代理、隧道档案、DoH 解析与宿主机代理联动模块（如网络出口类模块） |
| `privacy` | 隐私与指纹防护 | 自定义反指纹扰动、追踪拦截、`Sec-GPC` 与环境体检模块（如隐私防护类模块） |
| `identity` | 身份与会话容器 | 多账号容器、临时会话配置、角色环境切换 |
| `automation` | AI 自动化与站点增强 | 站点语义插件、DOM 感知辅助、受控工作流工具 |
| `appearance` | 外观与光场主题 | 自定义光场预设、侧边栏皮肤、布局增强 |
| `security` | 安全审计与策略防护 | 下载拦截、合规审计、脚本/Cookie 策略管控 |
| `productivity` | 效率与工作区工具 | 标签分组、稍后阅读、剪贴板/笔记联动与快捷命令模块 |
| `content` | 内容净化与阅读增强 | 元素屏蔽、沉浸式阅读模式、页面翻译与排版字体增强模块 |
| `developer` | 开发者与调试工具 | 请求抓包检查、Header/Mock 注入、性能与无障碍诊断模块 |
| `media` | 音视频与媒体控制 | 独立标签音量/倍速、画中画增强、字幕与媒体捕获控制模块 |
| `data` | 数据采集与同步导出 | 结构化页面抽取、本地知识归档与加密配置同步导出模块 |
| `search` | 搜索与知识库检索 | 自定义聚合搜索、本地文档/RAG 检索与问答增强模块 |

### 4.2 标准生命周期方法（`index.mjs` 导出规范）

| 方法 | 签名 | 说明 |
| :--- | :--- | :--- |
| `manifest` | `Object` | 导出解析后的 `module.json` |
| `checkCompatibility` | `async (context) => { ok, warnings?, errors? }` | 安装或启用前的自定义环境/互斥预检 |
| `onInstall` | `async (context) => { ok }` | 首次验证安装后初始化明文配置与加密密库 |
| `onEnable` | `async (context) => { ok }` | 模块启用时注册规则或恢复任务 |
| `onDisable` | `async (context) => { ok }` | 模块停用时清理动态规则、停止轮询 |
| `onUninstall` | `async (context) => { ok }` | 卸载时释放资源（默认保留用户数据，除非 `purge: true`） |
| `getStatus` | `() => { id, version, ready, ... }` | 返回实时运行状态供设置页与 `gador-mod status` 展示 |
| `healthCheck` | `async () => { healthy, details? }` | 供 `gador-mod doctor` 与监控巡检调用 |

### 4.3 七大互斥槽位（`exclusiveGroups`）与冲突硬拦截

相互冲突、无法同时使用的模块与功能**严禁同时开启**。在 `module.json` 中通过 `compatibility` 声明：

```json
"compatibility": {
  "exclusiveGroups": ["fingerprint-engine"],
  "conflictsWith": ["other-incompatible-id"],
  "requires": [],
  "mutuallyExclusiveFeatures": [
    {
      "group": "shield-master-level",
      "items": ["level_off", "per_feature_farbling"],
      "reason": "总档位关闭时禁止单独启用分项指纹扰动"
    }
  ]
}
```

| 互斥槽位 ID | 含义 | 说明 |
| :--- | :--- | :--- |
| `network-egress` | 浏览器网络出口槽位 | 同一时间仅允许 1 个网络出口/代理路由管理模块启用 |
| `fingerprint-engine` | 反指纹与环境伪装槽位 | 同一时间仅允许 1 个 `MAIN` world 反指纹模块启用 |
| `cookie-policy` | Cookie 策略接管槽位 | 同一时间仅允许 1 个覆写/屏蔽原生 Cookie 的模块启用 |
| `dns-resolver` | 独立 DNS / DoH 槽位 | 同一时间仅允许 1 个模块接管独立 DNS/DoH 解析 |
| `newtab-override` | 新标签页覆盖槽位 | 同一时间仅允许 1 个模块覆盖 `chrome://newtab` |
| `content-blocker` | 全站内容拦截规则槽位 | 同一时间仅允许 1 个主内容净化/广告拦截模块接管全站 DNR 规则 |
| `search-provider` | 默认搜索增强槽位 | 同一时间仅允许 1 个搜索增强模块接管默认搜索路由与联想建议 |

当尝试安装启用或开启与已启用模块冲突的模块时：
- 内核/注册表立即拒绝并返回 `ERR_MODULE_CONFLICT`（HTTP `409 Conflict`），附带 `conflictState.blockedBy` 明确指出冲突模块与槽位；
- 若需预先安装但不启用，可使用 `gador-mod install <path> --disabled`，待停用冲突模块后再 `gador-mod enable`。

### 4.4 等待（⏳）与禁止（🚫）UI / CLI 标识规范
所有模块在设置页与控制台实现交互控件时，**必须遵守统一状态视觉规范**：
- **⏳ 等待标识（`.gd-pill.waiting` + `disabled`）**：凡触发异步写入、签名复核、内核路由热更新或扩展同步操作，必须立即把按钮与状态胶囊切为 **「⏳ 正在处理/同步，请等待…」** 并锁定按钮防并发重入，待服务端返回后再解除锁定。
- **🚫 禁止/冲突标识（`.gd-pill.forbidden` + `.is-blocked` + `disabled`）**：
  - 模块级：存在互斥冲突或缺少前置依赖时，开关与启用按钮必须置灰禁用并展示 **「🚫 冲突禁止：与 <冲突模块> 互斥」**；
  - 功能级示例（已内置）：
    - VPN 区域：**「跟随宿主机代理」** 与 **「手动严格独立隧道」** 互斥——开启一方时另一方立即锁定并显示 **`🚫 冲突禁止`**；
    - 指纹区域：**「总档位关闭 (`off`)」** 与 **「7 项分项指纹开关」** 互斥——总档位关闭时全部 7 个分项开关立即锁定并显示 **`🚫 禁止单独开启`**。

---

## 5. 模块对网页的全部可执行操作全清单（开发实战）

Gador 为模块开放了 **5 大层面的受控网页操作能力**，同时由内核 `SecurityGuard` 强制守住安全红线：

### 5.1 页面加载期注入（MV3 `content_scripts`，`document_start`）
适用于 `privacy`、`appearance`、`security` 等需要在网页脚本运行前介入的模块：
- **`world: "MAIN"`（页面主世界）**：
  - 规范化 `navigator` 只读属性（`hardwareConcurrency`、`deviceMemory`、`globalPrivacyControl`、`webdriver`、`getBattery`）；
  - 拦截并确定性微扰图形与音频 API（`CanvasRenderingContext2D.prototype.getImageData`、`HTMLCanvasElement.prototype.toDataURL/toBlob`、`WebGLRenderingContext/WebGL2RenderingContext.prototype.getParameter/readPixels`、`AudioBuffer.prototype.getChannelData`）；
  - 几何边界与字体测量微扰（`Element.prototype.getBoundingClientRect`）；
  - 通过 `WeakMap` 维护 `Function.prototype.toString` 返回 `[native code]`，且**禁止**向 `window` 或 `sessionStorage` 写入任何私有痕迹键。
- **`world: "ISOLATED"`（扩展隔离世界）**：
  - 监听 `chrome.storage.local` / `chrome.storage.onChanged`，通过 `window.dispatchEvent(new CustomEvent(...))` 将最新配置热推送给 `MAIN` world；
  - 注入只读悬浮状态条/光效层（使用 Shadow DOM 避免污染目标网页 CSS）。

### 5.2 网络层与请求头操作（MV3 `declarativeNetRequest` + 内核 `network.*`）
- **请求头/响应头改写与过滤**：通过 `chrome.declarativeNetRequest.updateDynamicRules` 注入（如 `Sec-GPC: 1`）、修改或删除请求/响应头，或按域名/资源类型阻断追踪请求；
- **独立隧道与防泄漏控制**（UDS `network.setTunnel` / `network.getStatus`）：
  - `scope: "browser"`（全局出口）或 `scope: "space:<privateSpaceId>"`（仅 `private` 空间独立出口）；
  - `mode`: `"strict_tunnel"` | `"direct_only"` | `"custom"`，支持 `endpoint`、`dohServer`、`bypassList`、`failClosed: true` 与强制 `webrtcPolicy: "disable_non_proxied_udp"`。

### 5.3 页面 DOM 感知、环境体检与受控交互（UDS / MCP / 受控 CDP，仅限已登记 `pageId`）
| 能力类别 | 可调用接口 | 用途与说明 |
| :--- | :--- | :--- |
| **导航与生命周期** | `page.open`、`page.close`、`cdp.send("Page.navigate" \| "Page.reload")`、`browser_navigate` | 打开或跳转网页，守护模式默认 `1280×800` 非零视口且不降频 |
| **语义快照与链接** | `browser_snapshot`、`browser_get_links` | 获取标题、URL、可见文本与可交互元素选择器（密码框自动脱敏） |
| **只读环境体检** | `privacy_audit_page` / `cdp.send("Runtime.evaluate")` | 采集 `navigator`、`viewport`、`webgl`、`canvas`、`audio`、`functionToStringNative` |
| **鼠标/键盘/滚动** | `browser_click`、`browser_type`、`browser_press_key`、`browser_scroll`、`cdp.send("Input.*")` | 向受管页面派发真实输入事件（聚焦密码框自动触发人工接管围栏） |
| **页面截图** | `browser_screenshot` / `cdp.send("Page.captureScreenshot")` | 仅在 `AGENT_RUNNING` 时可用；`USER_ACTIVE` 人工接管期间禁止截屏 |

### 5.4 弹窗治理、原生标签双向移交与人机协作
- **JS 对话框非阻塞处理**：订阅 `dialog.opened`，调用 `dialog.handle({ pageId, accept, promptText })` 处理 `alert` / `confirm` / `prompt` / `beforeunload`，跨连接存活且不死锁 CDP；
- **原生标签双向移交**：`page.listNativeTabs`（总览）、`page.attachActiveTab`（普通网页原地移交给 AI 并亮光）、`page.detachTab`（收回网页不关闭）、`page.focusTab`（切换聚焦）；
- **视图热挂载与人工接管**：`page.attachView` / `page.detachView`（零拷贝热挂载/收起）；`takeover.request` / `takeover.release`（遇到验证码/2FA/支付确认立即交由人类）。

### 5.5 浏览器设置页 UI 扩展规范
- 在 `chrome://settings` 注入界面时，**严禁使用 `innerHTML` / `outerHTML` / `eval`**（TrustedTypes CSP 硬限制），一律使用 `document.createElement` + `textContent`；
- 严格遵循第 4.4 节 **⏳ 等待** 与 **🚫 禁止/冲突** 状态标识规范。

### 5.6 硬安全红线（所有模块与 AI 绝对禁止的操作）
- 严禁访问用户个人普通标签页（越权一律返回 `ERR_TARGET_OUT_OF_SCOPE`）；
- 严禁访问 `chrome://password-manager`、`chrome://settings/passwords`、`chrome://settings/payments`、`file://` 及 `Autofill.*`、`WebAuthn.*`、`FedCm.*`、`DOM.setFileInputFiles`（返回 `ERR_DOMAIN_DENIED`）；
- 严禁试图读取/自动填写密码框或银行卡字段（触发 `ERR_SENSITIVE_ACTION_REQUIRES_HUMAN` 自动切入 `USER_ACTIVE`）；
- 严禁开发 CAPTCHA 自动破解、人机挑战绕过或权限控制绕过功能。

---

## 6. 从零制作、签名与验证安装实操步骤（6 步）

```bash
# 第 1 步：生成带完整生命周期与互斥槽位的明文模块脚手架
gador-mod init my-fp-mod \
  --dir ./my-fp-mod \
  --name "自定义隐私模块" \
  --category privacy \
  --exclusive-group fingerprint-engine \
  --with-extension

# 第 2 步：按明文源码 + openModuleSecretVault 编写逻辑（如需取消原生 Cookie 请按第 3.2 节接口实现）

# 第 3 步：首次生成您自己的 Ed25519 发布者密钥对（私钥 0600，绝不放进模块目录）
gador-mod keygen --out ~/.config/gador/my-keys --key-id my-dev-v1

# 第 4 步：将发布者公钥加入本机信任列表
gador-mod trust add my-dev-v1 ~/.config/gador/my-keys/my-dev-v1.public.pem --label "My Publisher"

# 第 5 步：对模块内全部明文文件计算 SHA-256 并签发 signature.json
gador-mod sign ./my-fp-mod --key ~/.config/gador/my-keys/my-dev-v1.private.pem --key-id my-dev-v1
gador-mod verify ./my-fp-mod

# 第 6 步：通过统一安全验证流程加入整合（若与已启用的同槽位模块冲突，需先停用对方或加 --disabled）
gador-mod install ./my-fp-mod
gador-mod settings my-fp-mod get
gador-mod doctor
```

---

## 7. 常见错误码速查

| 错误码 | HTTP 状态 | 含义与处理 |
| :--- | :--- | :--- |
| `ERR_MODULE_UNSIGNED` | `403` | 缺少 `signature.json`；执行 `gador-mod sign` 签名 |
| `ERR_MODULE_UNTRUSTED_KEY` | `403` | `keyId` 不在信任密钥环；核实发布者后执行 `gador-mod trust add` |
| `ERR_MODULE_SIGNATURE_INVALID` | `403` | 文件被篡改、多余未签名文件或签名无效；禁止加载，需重新校验/重签 |
| `ERR_INSTALL_VERIFICATION_REQUIRED` | `403` | 缺少人工确认码或 `--confirm-digest`；拒绝静默安装 |
| `ERR_INSTALL_VERIFICATION_FAILED` | `403` | 确认码错误、挑战超时（120s）或本机安装密码错误 |
| `ERR_MODULE_CONFLICT` | `409` | 与已启用模块共享 `exclusiveGroups`、显式 `conflictsWith` 或缺少 `requires` 依赖；需先停用冲突模块 |
| `ERR_MODULE_NOT_INSTALLED` | `409` | 模块尚未安装或当前已停用（此时不开放其自定义设置权限） |
| `ERR_MODULE_NO_CUSTOM_SETTINGS` | `404` | 该模块未在 `module.json` 中声明任何 `settingsSchema` 自定义设置项 |
| `ERR_INVALID_SETTING` | `400` | 写入了未声明的设置键、类型不匹配或超出 `min`/`max`/`options` 范围 |
| `ERR_SETTING_CONFLICT` | `409` | 同时开启了该模块 `settingsSchema` 中声明为 `mutuallyExclusiveWith` 的互斥设置项 |
