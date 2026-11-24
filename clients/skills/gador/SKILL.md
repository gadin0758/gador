---
name: gador
description: Control the gador Chromium kernel over its 0600 Unix Domain Socket or MCP Server. Use when automating web tasks in isolated AgentSpaces while sharing or isolating login state, managing human takeover, or routing through independent VPN tunnels.
---

# `gador` Agent 操作指南

本浏览器为 AI Agent 提供了**物理独立于用户个人标签栏的专属 AgentSpace**，并原生支持双态登录环境、随时人工可见/可主动接管、非阻塞 JS 弹窗治理以及不受宿主机系统网络影响的独立 VPN 接口。

## 1. 首次接入：先自检能力

在执行任何浏览器任务前，先查询 `agent.capabilities`（或 MCP 等价工具）确认当前内核版本、运行形态、支持的认证模式、网络策略及已加载的站点插件：

- `agent.capabilities` → 获取 `protocolVersion`、`runtimeMode`（`desktop` 或 `daemon`）、`windowShownByDefault`、`authModes`、`networkPolicies`、`features`。
- **桌面无窗口守护模式（`runtimeMode: "daemon"`）**：通过 `--agent-daemon`（或 `AGENT_KERNEL_DAEMON=1`）启动时，浏览器静默常驻后台且**不向用户显示任何窗口**（`windowShownByDefault: false`），所有页面在后台隐藏态以非零视口与前台调度优先级执行；仅当用户主动展开或遇到 2FA/验证码需要人工接管时才可按需热挂载。常规桌面带窗启动为 `runtimeMode: "desktop"`。

## 2. 选择正确的空间认证模式（`space.create`）

| 场景 | `authMode` | 行为与边界 |
| :--- | :--- | :--- |
| 需要复用用户已登录账号（如 GitHub、企业后台、已登录 SaaS） | `"shared"` | 单进程实时共享持久化登录态与 Cookie；**绝不写入用户个人历史记录或标签栏** |
| 私密页面、匿名调研、临时测试、独立出口需求 | `"private"` | 派生独立内存 `OTRProfile`，**零个人登录态**，关闭即彻底销毁 |

常用空间接口：`space.create`、`space.list`、`space.close`。

## 3. 页面管理与感知优先级

创建与管理页面（桌面带窗模式下直接以原生标签页运行并以标签光效标识，守护模式下在后台运行）：
- `page.open`（桌面模式直接打开原生标签页并点亮标签光效；无窗守护模式确保非零视口，默认 `1280x800`）
- `page.list`、`page.close`
- `page.attachView` / `page.detachView`（配合视图热挂载/卸载）
- 原生标签双向移交与总览接口：`page.listNativeTabs`（总览区分 AI 标签与普通标签）、`page.attachActiveTab`（将用户已有网页直接交给 AI 接管并点亮标签光效）、`page.detachTab`（从 AI 收回标签且保持网页打开）、`page.focusTab`（聚焦指定或下一个 AI 原生标签）

**感知与操控推荐顺序（省 Token、高稳定）：**
1. **优先 WebMCP / 高层网页链接 MCP 工具**：若通过 `gador-mcp` 接入（无守护进程时自动拉起），可直接调用仅限网页链接的自操作工具 `browser_navigate`、`browser_snapshot`、`browser_get_links`、`browser_click`、`browser_type`、`browser_press_key`、`browser_scroll`、`browser_screenshot`；
2. **其次 Site Plugins / 原生紧凑快照**：使用稳定语义定位器或快照 `@ref`（跨同源/跨域 OOPIF 统一编号，默认不开启 `Runtime.enable`）；
3. **底层受控 CDP**：仅在必要时通过 `cdp.send` 对已登记的 `pageId` 发送指令（个人浏览器标签页物理不可达，越权访问会返回 `ERR_TARGET_OUT_OF_SCOPE`）；
4. **按需截图**：仅在 Canvas / 视觉校验场景截屏。

## 4. 弹窗治理与人机协作规则（非常重要）

### JS 对话框（`alert` / `confirm` / `prompt` / `beforeunload`）
- 监听 `dialog.opened` 事件，并通过 `dialog.handle`（传入 `accept` 与可选 `promptText`）处理；
- 对话框不会改变空间所有权，且跨连接存活；若未打开对话框会返回 `ERR_DIALOG_NOT_OPEN`。

### 人工接管（`USER_ACTIVE`）与密码/支付强制隔离
用户随时可以展开专属 Agent 空间**主动查看（`USER_OBSERVING`）或直接点击介入操作（`USER_ACTIVE`）**；同时内核对**密码存储、付款方式与敏感操作**实施强制硬拦截：
- **密码与付款存储物理不可达**：Agent 空间绝不挂载 `PasswordManager` / `Autofill` 密码与银行卡自动填充客户端，内核严格拦截 `chrome://password-manager`、`chrome://settings/payments`、`chrome://settings/passwords`、`file://` 等内部/本地存储地址，以及 `Autofill.*`、`WebAuthn.*`、`FedCm.*`、`DOM.setFileInputFiles` 等敏感 CDP 域（返回 `ERR_DOMAIN_DENIED`）；
- **涉及密码输入或支付流程强制交由人工**：一旦内核检测到密码输入框聚焦（Blink `TEXT_INPUT_TYPE_PASSWORD`）、支付/结账/改密页面或脚本试图操作密码/银行卡/凭证字段，内核会**自动将空间切换为 `USER_ACTIVE` 人工接管状态**并拦截 Agent 操作（返回 `ERR_SENSITIVE_ACTION_REQUIRES_HUMAN`），冻结所有写入与截图，必须由用户亲自完成后交还控制权；
- 当 Agent 遇到验证码（CAPTCHA）、2FA / 硬件密钥 / 短信验证、支付确认、敏感硬件权限时，也**必须主动请求人工接管**，禁止尝试绕过。

接口与状态流转：
- `takeover.request` → 进入 `USER_ACTIVE`（写操作与截屏会被内核拒绝并返回 `ERR_HUMAN_IN_CONTROL`，此时应暂停等待，不要死循环重试）；
- 用户完成操作并交回，或调用 `takeover.release` → 恢复 `AGENT_RUNNING`，**恢复后务必重新抓取页面最新状态再继续**。

## 5. 独立 VPN 与防系统网络干扰（仅限 VPN 开放 AI 修改 + 修改前强制备份）

当任务需要受控网络出口、避免宿主机代理/系统网络波动影响时，使用：
- `network.setTunnel`：支持 `mode` 为 `"strict_tunnel"`、`"direct_only"`、`"custom"`；内核会自动禁用 OS 系统代理同步，并强制 WebRTC 策略 `disable_non_proxied_udp`。
- `network.getStatus`：查询当前 `browser` 全局或 `space:<spaceId>` 隧道健康状态。

**VPN 开放接口与强制备份规则（极其重要）：**
- **独立模块安装前提与安全验证**：VPN 档案管理面板、宿主机代理跟随与 `vpn_*` 档案工具封装在独立可选模块 `vpn`（`modules/vpn/`）中，需由人类用户通过 Ed25519 签名校验 + 人工验证确认（`gador-mod install vpn` 或 `Gador 设置`）后单独安装整合；AI 无权静默安装/卸载模块，仅可通过只读 `module_list` / `gador://modules` 查询状态（普通浏览器扩展不受此限制；内核底层 `network.setTunnel` / `network.getStatus` 原语始终可用）；
- **严格限定修改范围**：在所有浏览器配置中，**只有 VPN 相关档案与隧道策略**允许 AI 修改；其他常规设置、Google 账户、密码库、付款方式与本地文件均严格禁止修改；
- **每次修改前必须先备份**：调用 `vpn_update_profile` / `vpn_delete_profile` 时必须传入 `backupReason`，工具层会在写入前**硬强制**先在 `~/.config/gador/vpn/backups/` 生成时间戳快照备份，并可在独立 VPN 页面内随时一键还原或快捷删除；
- 开放的 VPN 档案与备份 MCP 工具：`vpn_get_profiles`、`vpn_backup_create`、`vpn_update_profile`、`vpn_delete_profile`、`vpn_restore_backup`（资源 `gador://vpn-profiles`）；模块状态查询：`module_list`（资源 `gador://modules`）。
- 原生外观与热更新配置控制面（仅限本机用户设置页调用）：`ui.getAppearance`、`ui.setAppearance`（实时驱动原生 Chromium 158 主题、主题色、竖向/横向标签栏、书签栏与 `~/.config/gador/native-ui.json` 热更新，无需重新编译 C++）。

**关键约束**：
- `shared` 空间统一继承 `browser` 级隧道，避免同账号在个人/Agent 间出现双 IP 异常；
- 只有 `private` 空间允许单独绑定 `space:<spaceId>` 独立出口；
- 在 `strict_tunnel` + `failClosed: true` 下，若隧道断开，请求会明确返回 `ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED`，**切勿假定已回退直连**，应上报用户检查 VPN 状态。

## 6. 隐私与指纹防护及 AI 环境自检调试规范（独立可选模块）

Gador 将 **隐私与指纹防护** 设计为独立可插拔模块 `privacy-shield`（`modules/privacy-shield/`，含独立 MV3 扩展），**核心浏览器默认不预装也不注入全站指纹脚本**；需由用户单独通过 `gador-mod install privacy-shield` 或 `chrome://settings/privacy` 安装并整合后生效（配置持久化于 `~/.config/gador/privacy-shield.json`）。AI 在调整档位前应先调用 `module_list` 或 `privacy_shield_get` 检查 `moduleInstalled` / `moduleEnabled` 状态：

### 防护能力与三档预设

| 档位 (`level`) | 启用项 | 适用场景 |
| :--- | :--- | :--- |
| `"off"` | 关闭指纹扰动（保留内核 WebRTC 防泄漏基线） | 排查强图形/Canvas/布局敏感站点兼容性 |
| `"standard"`（默认） | `canvasFarbling`、`webglFarbling`、`audioFarbling`、`hardwareNormalization`、`hideAutomationHints`、`gpcHeader`、`webrtcLeakProtection` | 日常防跨站指纹追踪，同源会话内确定性稳定且不影响正常渲染 |
| `"strict"` | 包含 `"standard"` 全部能力，并额外开启 `clientRectsJitter`（DOMRect 亚像素微扰） | 高隐私调研与防字体/布局几何指纹采集 |

### 开放给 AI 的环境检查与防护调试接口

- **MCP 工具**：
  - `privacy_shield_get`：读取当前防护档位、各分项布尔开关及内核网络/WebRTC 路由状态；
  - `privacy_shield_set`：切换 `level`（`"off"` / `"standard"` / `"strict"`）或单独开关 `canvasFarbling` / `webglFarbling` / `audioFarbling` / `clientRectsJitter` / `hardwareNormalization` / `webrtcLeakProtection` / `gpcHeader` / `hideAutomationHints`（对新加载页面生效）；
  - `privacy_audit_page`：对指定受管 `pageId` 执行只读环境体检，结构化返回 `navigator`（`webdriver`、`globalPrivacyControl`、`hardwareConcurrency`、`deviceMemory`、`languages`、`hasBatteryApi`）、`viewport`、`webgl`（Vendor/Renderer）、`canvas`（同源确定性哈希）、`audio`、`functionToStringNative` 与当前网络路由状态。
- **MCP 资源与 Prompt**：资源 `gador://privacy-shield`；引导模板 `debug_environment_privacy`。
- **CLI 与本机控制面 HTTP**：
  - CLI：`gador-ctl privacy get`、`gador-ctl privacy set --level <off|standard|strict>`、`gador-ctl privacy audit <pageId>`；
  - 本机 HTTP（`127.0.0.1:43118`）：`GET /api/privacy-shield`、`POST /api/privacy-shield`。

### AI 环境调试标准流程与安全红线

1. **先体检再调参**：需要排查网页环境检测或渲染差异时，先调用 `privacy_shield_get` 与 `privacy_audit_page`，对比 `configuredShield` 与 `pageSignals`；
2. **最小变更与复原**：若怀疑某项指纹扰动（如 `clientRectsJitter` 或 `webglFarbling`）影响目标站点绘图/布局，可临时通过 `privacy_shield_set` 切至 `"standard"` 或关闭单项并刷新页面复测，调试结束后恢复用户原档位；
3. **严格安全边界**：本接口仅用于合法的浏览器隐私防追踪、最小化指纹暴露与站点兼容性调试；**严禁**用于绕过 CAPTCHA、人机挑战、2FA 或访问控制——遇到验证码或人机验证时必须立即调用 `takeover.request` 交由人类完成。

## 7. 标准错误码速查

- `ERR_INVALID_PARAMS`：参数非法（如对 `shared` 空间设置独立隧道）
- `ERR_METHOD_NOT_FOUND`：方法不存在
- `ERR_SPACE_NOT_FOUND` / `ERR_PAGE_NOT_FOUND`：空间或页面已关闭
- `ERR_TARGET_OUT_OF_SCOPE`：试图访问非 Agent 空间的个人标签页
- `ERR_HUMAN_IN_CONTROL`：当前处于 `USER_ACTIVE` 人工操作中，暂停写入等待交回
- `ERR_SENSITIVE_ACTION_REQUIRES_HUMAN`：触发密码/银行卡/支付安全围栏，内核已自动强制交由人工接管（`USER_ACTIVE`）
- `ERR_DOMAIN_DENIED`：命中内部存储/敏感 CDP/本地域名安全黑名单（如 `chrome://password-manager`、`chrome://settings/payments`、`file://`、`Autofill.*`）
- `ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED`：VPN 断开触发 Fail-Closed 保护
- `ERR_DIALOG_NOT_OPEN`：当前无待处理的 JS 对话框
- `ERR_INTERNAL`：内核内部异常

> 扩展参考文档：
> - CLI、MCP Server 与通用 SDK 插件接入：[references/cli-and-mcp.md](references/cli-and-mcp.md)
> - 标准任务工作流手册：[references/workflows.md](references/workflows.md)
> - 站点语义插件编写规范：[references/site-plugin-spec.md](references/site-plugin-spec.md)
