# Gador 完整接口文档（API Reference）

本文档是 Gador 全部控制面与集成接口的权威参考，覆盖：
1. **UDS 内核二进制 RPC 协议**（`clients/protocol/schema.json`）
2. **21 个内核 RPC 方法、7 类推送事件与 11 个标准错误码**
3. **MCP Server 接口（Tools / Resources / Prompts）**
4. **本机控制面 HTTP API（`127.0.0.1:43118`，含模块管理、VPN 模块与指纹防护模块）**
5. **CLI 命令接口（`gador-ctl` 与 `gador-mod`）**
6. **通用 Function-Calling SDK 接口**

> 协议契约单一真相源：[clients/protocol/schema.json](../clients/protocol/schema.json)。所有接口变更须同步遵循 [开发规范](development-guide.md) 中的 Skill-First 同步原则。

---

## 1. UDS 内核传输协议规范

| 属性 | 规格 |
| :--- | :--- |
| 传输层 | POSIX Unix Domain Socket (`AF_UNIX`, `SOCK_STREAM`) |
| 默认路径 | `$XDG_RUNTIME_DIR/gador/ctl.sock`（缺省回退 `/tmp/gador/ctl.sock`，可用 `AGENT_KERNEL_SOCKET` 或 `--agent-socket` 覆盖） |
| 文件权限 | 严格 `0600`（父目录 `0700`） |
| 对端鉴权 | Linux `SO_PEERCRED` 同 UID 校验，跨用户连接立即拒绝 |
| 帧格式 | `uint32_be` 载荷长度（4 字节大端无符号整数） + UTF-8 JSON 载荷 |
| 最大帧长度 | `64 MiB`（`67,108,864` 字节），超限连接直接断开 |

### 1.1 消息信封格式

- **请求（Client → Kernel）**：
  ```json
  { "id": 1, "method": "space.create", "params": { "name": "work", "authMode": "shared" } }
  ```
- **成功响应（Kernel → Client）**：
  ```json
  { "id": 1, "ok": true, "result": { "spaceId": "sp_1", "name": "work", "authMode": "shared", "controlState": "AGENT_RUNNING" } }
  ```
- **错误响应（Kernel → Client）**：
  ```json
  { "id": 1, "ok": false, "error": { "code": "ERR_HUMAN_IN_CONTROL", "message": "Space is under USER_ACTIVE control" } }
  ```
- **异步推送事件（Kernel → Client）**：
  ```json
  { "event": "dialog.opened", "params": { "pageId": "pg_1", "spaceId": "sp_1", "dialogType": "confirm", "message": "Proceed?" } }
  ```

---

## 2. UDS 内核 RPC 方法全表（21 个方法）

### 2.1 能力自检

#### `agent.capabilities`
查询内核协议版本、运行模式、支持的认证模式与网络策略。
- **参数**：`{}`
- **返回**：
  ```json
  {
    "protocolVersion": "0.1.0",
    "chromiumVersion": "158.0.8127.36",
    "runtimeMode": "daemon",
    "windowShownByDefault": false,
    "features": ["dual_auth_spaces", "hot_mount_view", "non_blocking_dialogs", "independent_vpn", "credential_guard"],
    "authModes": ["shared", "private"],
    "networkPolicies": ["strict_tunnel", "direct_only", "custom"]
  }
  ```

### 2.2 隔离空间管理（AgentSpace）

| 方法 | 参数 | 返回值 | 说明 |
| :--- | :--- | :--- | :--- |
| `space.create` | `{ name?: string, authMode: "shared"\|"private", viewport?: { width: number, height: number } }` | `{ spaceId, name, authMode, controlState }` | 创建共享态或零 Cookie 私有态隔离空间 |
| `space.list` | `{}` | `{ spaces: SpaceInfo[] }` | 列出全部活动 AgentSpace 及其控制状态 |
| `space.close` | `{ spaceId: string }` | `{ closed: boolean }` | 关闭空间并销毁全部归属页面（`private` 同时销毁 OTRProfile） |

### 2.3 页面管理与原生标签双向移交

| 方法 | 参数 | 返回值 | 说明 |
| :--- | :--- | :--- | :--- |
| `page.open` | `{ spaceId: string, url?: string, viewport?: { width, height } }` | `{ pageId, spaceId, url, viewport, viewAttached }` | 在指定空间打开网页（守护模式非零视口后台运行；桌面模式原生标签亮光运行） |
| `page.list` | `{ spaceId?: string }` | `{ pages: PageInfo[] }` | 列出 Agent 归属页面 |
| `page.close` | `{ pageId: string }` | `{ closed: boolean }` | 关闭 Agent 页面 |
| `page.attachView` | `{ pageId: string, interactive?: boolean }` | `{ pageId, viewAttached, controlState, mountCount }` | 零拷贝热挂载至可见窗口（`interactive=false` 仅观摩，`true` 进入人工接管） |
| `page.detachView` | `{ pageId: string }` | `{ pageId, viewAttached, controlState }` | 卸载回后台小按钮继续执行 |
| `page.listNativeTabs` | `{}` | `{ tabs: NativeTabInfo[] }` | 列出原生桌面标签总览，区分 `aiControlled` 与普通标签 |
| `page.attachActiveTab` | `{ spaceId?: string, tabIndex?: number }` | `{ pageId, spaceId, url }` | 将用户当前/指定普通网页原地移交给 AI 并点亮标签光效 |
| `page.detachTab` | `{ pageId?: string }` | `{ detached: boolean }` | 从 AI 收回原生标签，网页保持打开不关闭 |
| `page.focusTab` | `{ pageId?: string, tabIndex?: number }` | `{ focused: boolean }` | 激活并聚焦指定标签（无参时循环切换下一个 AI 标签） |

### 2.4 人机接管、JS 弹窗与受控 CDP

| 方法 | 参数 | 返回值 | 说明 |
| :--- | :--- | :--- | :--- |
| `takeover.request` | `{ spaceId: string, pageId?: string, reason: string }` | `{ spaceId, controlState: "USER_ACTIVE" }` | 切入人工接管，立即冻结该空间 AI 写入与截图 |
| `takeover.release` | `{ spaceId: string }` | `{ spaceId, controlState: "AGENT_RUNNING" }` | 交回控制权恢复 AI 执行 |
| `dialog.handle` | `{ pageId: string, accept: boolean, promptText?: string }` | `{ handled: boolean, dialogType: DialogType }` | 非阻塞处理 `alert`/`confirm`/`prompt`/`beforeunload`，跨连接存活 |
| `cdp.send` | `{ pageId: string, cdpMethod: string, cdpParams?: object, sessionId?: string }` | `object`（原生 CDP 结果） | 向已登记的 Agent `pageId` 发送受控 CDP；个人标签报 `ERR_TARGET_OUT_OF_SCOPE`；敏感域报 `ERR_DOMAIN_DENIED` |

### 2.5 内核级独立网络隧道原语

| 方法 | 参数 | 返回值 | 说明 |
| :--- | :--- | :--- | :--- |
| `network.setTunnel` | `{ scope?: "browser"\|"space:<id>", mode: RouteMode, endpoint?: string, dohServer?: string, bypassList?: string[], webrtcPolicy?: string, failClosed?: boolean }` | `{ scope, mode, osProxyDisabled, webrtcPolicy, failClosed, tunnelHealthy }` | 彻底屏蔽宿主机系统代理覆盖，强制 `disable_non_proxied_udp` 与 Fail-Closed 保护。`shared` 空间禁止独立绑定（仅 `private` 允许 `space:<id>`） |
| `network.getStatus` | `{ scope?: string }` | `{ routes: TunnelStatus[] }` | 查询全局或空间级隧道健康状态 |

### 2.6 原生界面热更新（仅限本机用户设置页调用）

| 方法 | 参数 | 返回值 | 说明 |
| :--- | :--- | :--- | :--- |
| `ui.getAppearance` | `{}` | `{ theme, accentColor, layout, compact, showBookmarkBar, nativeUi }` | 读取当前 Chromium 158 原生主题、布局与 `~/.config/gador/native-ui.json` |
| `ui.setAppearance` | `{ theme?: "system"\|"light"\|"dark", accentColor?: string, layout?: "sidebar"\|"chrome", compact?: boolean, showBookmarkBar?: boolean, resetDefaults?: boolean, nativeUi?: object }` | `{ applied: boolean, nativeUi }` | 实时热更新原生主题、光效色调与标签栏布局，无需重新编译 C++ |

---

## 3. 内核推送事件、枚举与错误码

### 3.1 推送事件（7 类）
`page.created` · `page.closed` · `dialog.opened` · `dialog.closed` · `takeover.changed` · `network.tunnelStateChanged` · `cdp.event`

### 3.2 枚举定义
- `AuthMode`: `"shared"` | `"private"`
- `ControlState`: `"AGENT_RUNNING"` | `"USER_OBSERVING"` | `"USER_ACTIVE"`
- `RouteMode`: `"strict_tunnel"` | `"direct_only"` | `"custom"`
- `DialogType`: `"alert"` | `"confirm"` | `"prompt"` | `"beforeunload"`
- `RuntimeMode`: `"desktop"` | `"daemon"`

### 3.3 标准错误码（11 个）

| 错误码 | 触发场景 | Agent 标准处置 |
| :--- | :--- | :--- |
| `ERR_INVALID_PARAMS` | 参数格式非法、对 `shared` 空间绑定独立隧道、或调用未安装的独立模块写入接口 | 检查参数或提示用户安装对应模块（`gador-mod install <id>`） |
| `ERR_METHOD_NOT_FOUND` | 调用不存在的 RPC 方法 | 先调用 `agent.capabilities` 校验方法集 |
| `ERR_SPACE_NOT_FOUND` | 目标 `spaceId` 不存在或已关闭 | 重新创建空间或调用 `space.list` 刷新 |
| `ERR_PAGE_NOT_FOUND` | 目标 `pageId` 不存在或已关闭 | 调用 `page.list` 刷新 |
| `ERR_TARGET_OUT_OF_SCOPE` | 尝试访问用户个人标签页或非归属目标 | 立即停止越权访问，仅操作已登记 `pageId` |
| `ERR_HUMAN_IN_CONTROL` | 空间处于 `USER_ACTIVE` 人工操作中 | 暂停写入与重试，等待 `takeover.changed` 恢复后再重新快照 |
| `ERR_SENSITIVE_ACTION_REQUIRES_HUMAN` | 命中密码框、银行卡或支付结账围栏 | 内核已自动切入 `USER_ACTIVE`，交由人类亲自操作 |
| `ERR_DOMAIN_DENIED` | 访问 `chrome://password-manager`、`chrome://settings/payments`、`file://` 或 `Autofill.*`/`WebAuthn.*`/`FedCm.*` | 硬安全边界，禁止重试或绕过 |
| `ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED` | `strict_tunnel` + `failClosed` 下隧道断开 | 切勿假定回退直连，立即上报用户检查 VPN 状态 |
| `ERR_DIALOG_NOT_OPEN` | 无打开的 JS 对话框时调用 `dialog.handle` | 忽略或重新确认页面状态 |
| `ERR_INTERNAL` | 内核内部异常 | 记录上下文并上报 |

---

## 4. MCP Server 接口（`gador-mcp`）

`gador-mcp` 实现标准 MCP `2024-11-05` stdio 协议，暴露四大类工具、6 个只读资源与 4 个提示模板：

### 4.1 MCP Tools 分类清单

| 分类 | 工具名 | 所属层 | 说明 |
| :--- | :--- | :--- | :--- |
| **内核原语** | `browser_capabilities`、`space_create`、`space_list`、`space_close`、`page_open`、`page_list`、`page_close`、`page_attach_view`、`page_detach_view`、`takeover_request`、`takeover_release`、`dialog_handle`、`cdp_send`、`network_set_tunnel`、`network_get_status` | 核心内核 | 与 UDS RPC 1:1 映射 |
| **高层网页自操作** | `browser_navigate`、`browser_snapshot`、`browser_get_links`、`browser_click`、`browser_type`、`browser_press_key`、`browser_scroll`、`browser_screenshot`、`browser_list_native_tabs`、`browser_attach_active_tab`、`browser_detach_tab` | 核心客户端 | 仅限网页链接操作，密码框自动脱敏与围栏拦截 |
| **模块发现** | `module_list` | 核心模块注册表 | 查询 `vpn`、`privacy-shield` 等可选模块的安装与启用状态 |
| **VPN 独立模块** | `vpn_get_profiles`、`vpn_backup_create`、`vpn_update_profile`、`vpn_delete_profile`、`vpn_restore_backup` | 可选模块 `vpn` | 仅开放 VPN 档案配置，修改/删除强制要求 `backupReason` 自动备份 |
| **指纹防护独立模块** | `privacy_shield_get`、`privacy_shield_set`、`privacy_audit_page` | 可选模块 `privacy-shield` | 读取/切换 `off`/`standard`/`strict` 档位（需先安装启用模块）；对受管页面执行只读环境体检 |
| **站点语义插件** | `site_<domain>_<action>`（自动从 `clients/site-plugins/` 加载） | 声明式插件 | 高稳定语义操作封装 |

### 4.2 MCP Resources（6 个）
- `gador://skill` — 返回 `SKILL.md` 全文（供 Agent 自我引导）
- `gador://spaces` — 实时 AgentSpace 列表
- `gador://pages` — 实时受管页面列表
- `gador://network` — 实时隧道路由状态
- `gador://vpn-profiles` — VPN 模块档案库与备份快照清单
- `gador://privacy-shield` — 隐私与指纹防护模块当前策略
- `gador://modules` — 可选模块安装与整合状态注册表

### 4.3 MCP Prompts（4 个）
- `start_shared_task(goal)` — 复用用户登录态的共享空间工作流
- `start_private_vpn_task(endpoint, goal)` — 零 Cookie 私有空间 + 严格 Fail-Closed VPN 工作流
- `request_human_takeover(spaceId, reason)` — CAPTCHA / 2FA 人工安全交接模板
- `debug_environment_privacy(pageId)` — 浏览器环境体检与 `off`/`standard`/`strict` 兼容性排查工作流

---

## 5. 本机控制面 HTTP API（`http://127.0.0.1:43118`）

由 `clients/ui/server.mjs` 提供，仅绑定回环地址 `127.0.0.1`，并实施严格 Origin 守卫（仅允许 `127.0.0.1`、`localhost`、`chrome-extension://`、`chrome://settings`，其他跨站 Origin 返回 `403`）。

### 5.1 核心控制面路由

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/state` | 聚合返回 `capabilities`、`spaces`、`pages`、`routes`、`socketPath` |
| `POST /api/rpc` | 转发白名单内的 UDS RPC（`{ method, params }`） |
| `GET /api/events` | Server-Sent Events（SSE）实时内核事件流 |
| `GET /api/skill` | 返回 `SKILL.md` 内容、MCP 配置 JSON、本机已安装 Skill 路径与全部工具元数据 |
| `GET /api/search-engine` / `POST /api/search-engine` | 读写新标签页与设置页四引擎（`google` / `bing` / `baidu` / `duckduckgo`） |
| `POST /api/user/open-native` | 仅限人类本地设置页调用的原生页面/无痕窗口打开接口（严格 URL 白名单校验） |

### 5.2 独立模块生命周期、沙箱验证与动态自定义设置路由

| 方法与路径 | 请求体 | 说明 |
| :--- | :--- | :--- |
| `GET /api/modules` | — | 返回模块清单、安装状态、启用状态、`settingsSchema`、Ed25519 签名校验摘要与扩展路径 |
| `GET /api/modules/doctor` | — | 重新校验模块目录、已安装文件 Ed25519 签名 + SHA-256 完整性、扩展清单与轻量容器运行时状态 |
| `GET /api/custom-settings` | — | 汇总**所有当前已安装且启用**并声明了 `settingsSchema` 的模块自定义设置面板（无对应模块加入时返回空列表） |
| `GET /api/modules/:id/settings` | — | 查询指定已启用模块的自定义设置 Schema 与当前值（未加入或停用返回 `409 ERR_MODULE_NOT_INSTALLED`） |
| `POST /api/modules/:id/settings` | `{ values: { [key]: value } }` | 校验模块已启用 + `settingsSchema` 字段/类型/范围/互斥规则后保存用户自定义设置（冲突返回 `409 ERR_SETTING_CONFLICT`，非法字段返回 `400 ERR_INVALID_SETTING`） |
| `DELETE /api/modules/:id/settings` | — | 将已启用模块的自定义设置重置为 `settingsSchema` 默认值 |
| `GET /api/modules/sandbox` | — | 查询模块轻量容器（`bubblewrap`）状态（只读，无模块时保持 `STOPPED_IDLE` 且不启动容器） |
| `POST /api/modules/:id/sandbox-probe` | `{}` | 在已启用模块的轻量容器内执行安全隔离自检探针（验证 `$HOME` 不可见、代码只读、网络隔离、环境变量清空） |
| `POST /api/modules/:id/sandbox-exec` | `{ method, args? }` | 在已启用模块的轻量容器内执行模块生命周期或自定义方法（64 MiB 内存上限 + 5s 超时熔断） |
| `POST /api/modules/sandbox/stop` | `{ moduleId? }` | 立即停止指定或全部运行中的模块轻量容器 |
| `GET /api/modules/auth` | — | 查询是否开启本地模块安装密码锁及受信任发布者公钥列表 |
| `POST /api/modules/auth/passphrase` | `{ passphrase: string }` 或 `{ action: "clear", currentPassphrase }` | 设置或清除本机模块安装密码锁（`scrypt` 哈希存储于 `~/.config/gador/module-auth.json`） |
| `POST /api/modules/:id/install-challenge` | `{}` | 第 1 步：校验模块包 Ed25519 签名与全部文件 SHA-256，签发 120 秒单次有效 `{ challengeId, confirmCode, requiresPassphrase, verification, permissions }` |
| `POST /api/modules/:id/install` | `{ challengeId, confirmCode, passphrase?, enable? }` | 第 2 步：核验一次性确认码与可选密码后加入模块；**未经验证直接调用返回 HTTP `403`（`ERR_INSTALL_VERIFICATION_REQUIRED` / `ERR_INSTALL_VERIFICATION_FAILED` / `ERR_MODULE_SIGNATURE_INVALID`）** |
| `POST /api/modules/:id/toggle` | `{ enabled: boolean }` | 热启用或停用已加入模块（启用前自动复核签名完整性与互斥槽位） |
| `POST /api/modules/:id/uninstall` | `{ purge?: boolean }` | 卸载模块（`purge: true` 同时清除配置文件与 `module-settings/<id>.json`） |

### 5.3 VPN 模块路由（`/api/vpn/*`）

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/vpn/store` | 读取 VPN 档案库、备份目录、`moduleInstalled`/`moduleEnabled` 状态 |
| `POST /api/vpn/profiles` | 新建/更新 VPN 档案（强制先写备份；`applyNow: true` 同步下发至内核） |
| `DELETE /api/vpn/profiles/:id` | 删除指定 VPN 档案（删除前强制写备份） |
| `POST /api/vpn/backups` | 手动创建时间戳快照备份 |
| `POST /api/vpn/backups/:backupId/restore` | 从备份快照一键还原（还原前亦自动备份当前状态） |
| `DELETE /api/vpn/backups` / `DELETE /api/vpn/backups/:backupId` | 清空或删除单个备份快照 |
| `GET /api/vpn/host-proxy` | 探测宿主机代理（环境变量 / GNOME / KDE / 常见本机代理端口） |
| `POST /api/vpn/follow-host-proxy` | 开启/关闭宿主机代理自动跟随同步 |

### 5.4 隐私与指纹防护模块路由（`/api/privacy-shield`）

| 方法与路径 | 请求体 / 行为 | 说明 |
| :--- | :--- | :--- |
| `GET /api/privacy-shield` | — | 返回 `moduleInstalled`、`moduleEnabled`、`presets` 与当前 `privacyShield` 开关配置 |
| `POST /api/privacy-shield` | `{ level?: "off"\|"standard"\|"strict", canvasFarbling?, webglFarbling?, audioFarbling?, clientRectsJitter?, hardwareNormalization?, webrtcLeakProtection?, gpcHeader?, hideAutomationHints?, actor? }` | 更新档位或分项开关。**若 `privacy-shield` 模块未安装/未启用，返回 HTTP `409`（`ERR_MODULE_NOT_INSTALLED`）** |

---

## 6. CLI 与通用 SDK 接口

### 6.1 `gador-ctl` 内核控制命令行
```bash
gador-ctl capabilities
gador-ctl space create --auth <shared|private> [--name <name>] [--width <w>] [--height <h>]
gador-ctl space list | close <spaceId>
gador-ctl page open <spaceId> <url> [--width <w>] [--height <h>]
gador-ctl page list [spaceId] | close <pageId> | attach <pageId> [--interactive] | detach <pageId>
gador-ctl takeover request <spaceId> --reason <reason> [--page <pageId>]
gador-ctl takeover release <spaceId>
gador-ctl dialog handle <pageId> (--accept | --dismiss) [--prompt <text>]
gador-ctl cdp <pageId> <cdpMethod> [jsonParams]
gador-ctl network set --mode <strict_tunnel|direct_only|custom> [--scope <browser|space:id>] [--endpoint <url>] [--doh <url>] [--fail-closed]
gador-ctl network status [scope]
gador-ctl privacy get | set [--level <off|standard|strict>] | audit <pageId>
gador-ctl rpc <method> [jsonParams]
```

### 6.2 `gador-mod` 独立模块管理、验证与自定义设置命令行
```bash
gador-mod list [--json]
gador-mod status <moduleId> [--json]
gador-mod verify <moduleId|/path/to/module> [--json]
gador-mod install <moduleId|/path/to/module> [--confirm-digest <hex8+>] [--passphrase <pin>] [--disabled] [--json]
gador-mod enable <moduleId> [--json]
gador-mod disable <moduleId> [--json]
gador-mod uninstall <moduleId> [--purge] [--json]
gador-mod init <moduleId> [--dir <targetDir>] [--name <title>] [--category <cat>] [--exclusive-group <grp>] [--with-extension]
gador-mod spec [--json]
gador-mod settings list [--json]
gador-mod settings <moduleId> [get|set <key> <value>|reset] [--json]
gador-mod auth status | set-passphrase | clear-passphrase
gador-mod trust list | add <keyId> <public-key.pem> [--label <name>] | remove <keyId>
gador-mod keygen --out <dir> [--key-id <id>]
gador-mod sign <moduleDir> --key <private-key.pem> --key-id <id>
gador-mod sandbox status | probe <moduleId> | exec <moduleId> <method> [jsonArgs] | stop [moduleId]
gador-mod extensions
gador-mod doctor [--json]
```

### 6.3 通用 Function-Calling SDK（`clients/plugin/sdk.mjs`）
```js
import { createGadorPlugin } from "./clients/plugin/sdk.mjs";

const plugin = createGadorPlugin();
await plugin.connect();
const prompt = plugin.getSystemSkillPrompt();
const openaiTools = plugin.toOpenAITools();
const anthropicTools = plugin.toAnthropicTools();
const res = await plugin.executeTool("module_list", {});
await plugin.close();
```
