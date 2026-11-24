# Gador 浏览器完整使用说明文档

本手册面向最终用户与 AI Agent 集成者，完整介绍 **Gador** 的安装、启动形态、桌面界面功能、独立模块（VPN 与指纹防护）的单独安装与整合、外部 AI 接入以及常见问题排查。

---

## 1. 产品定位与核心特性

Gador 是基于 **Chromium 158** 洁净室内核构建的 Linux 优先 AI-Agent 原生浏览器，核心设计目标是**让人类日常浏览体验与 AI 自动化能力无缝共存，同时守住隐私与凭据安全底线**：

1. **双运行形态**：
   - **桌面无窗口守护模式（`--agent-daemon`，默认）**：静默常驻后台、不弹出任何窗口，所有 Agent 页面以非零视口（默认 `1280×800`）和前台调度优先级运行。
   - **原生桌面带窗模式（`gador --desktop`）**：单层原生 C++ Views 浏览器窗口，拥有独立配置目录 `~/.config/gador` 与 `CHROME_DESKTOP=gador.desktop`（绝不污染系统 Chromium）。
2. **双态隔离空间（AgentSpace）**：
   - `shared`：复用当前 Profile 登录态（如 Gmail / GitHub / 企业后台），但**绝不污染**用户个人历史记录或普通标签栏；桌面模式下以蓝紫标签光效与边缘光场标识 AI 托管中的网页，支持与普通标签页双向移交。
   - `private`：动态派生独立内存 `OTRProfile`，零个人 Cookie，支持独立隧道出口，关闭即彻底销毁。
3. **凭据与支付硬围栏 + 即时人工接管（`USER_ACTIVE`）**：
   - `chrome://password-manager`、`chrome://settings/payments`、`file://` 与 `Autofill.*` / `WebAuthn.*` / `FedCm.*` 对 AI 物理不可达（`ERR_DOMAIN_DENIED`）。
   - 页面聚焦密码框或触发支付/结账流程时，内核自动冻结 AI 写入与截图并强制切回 `USER_ACTIVE` 人工接管（`ERR_SENSITIVE_ACTION_REQUIRES_HUMAN`）。
4. **核心与扩展模块解耦**：
   - 核心浏览器只内置基础 AI 控制面、光效 UI、账户/搜索引擎与底层内核网络原语；
   - **独立 VPN 管理区域（`vpn`）** 与 **隐私与指纹防护区域（`privacy-shield`）** 被设计为独立可选模块，用户可按需通过 `gador-mod` 或设置页单独安装、整合、停用或卸载。

---

## 2. 安装与目录布局

### 2.1 本机安装

```bash
# 在仓库根目录执行增量打包与本机安装
npm run install:local
```

### 2.2 文件与数据路径

| 路径 | 权限 | 用途 |
| :--- | :--- | :--- |
| `~/.local/share/gador/` | `0755` | 完整安装目录（引擎二进制、`clients/`、内置模块目录 `modules/`） |
| `~/.local/bin/gador{,-ui,-mcp,-ctl,-mod}` | `0755` | 命令行软链接入口 |
| `~/.local/share/applications/gador.desktop` | `0644` | Linux 桌面启动器（应用菜单入口） |
| `~/.config/gador/` | `0700` | Gador 专属用户数据目录（与 `~/.config/chromium` 完全隔离） |
| `~/.config/gador/native-ui.json` | `0600` | 热更新原生界面与光效配置（改完即时生效，无需重新编译 C++） |
| `~/.config/gador/modules.json` | `0600` | 独立模块安装与启用状态注册表 |
| `~/.config/gador/installed-modules/<id>/` | `0700` | 用户通过验证后单独安装的模块运行目录（如 `vpn/`、`privacy-shield/`，浏览器升级不丢失） |
| `~/.config/gador/vpn/` | `0700` | VPN 模块档案（`profiles.json`）与修改前自动备份目录（`backups/`） |
| `~/.config/gador/privacy-shield.json` | `0600` | 隐私与指纹防护模块策略配置 |
| `$XDG_RUNTIME_DIR/gador/ctl.sock` | `0600` | 内核控制面 Unix Domain Socket（同 UID `SO_PEERCRED` 鉴权） |

---

## 3. 启动方式与桌面操作

### 3.1 命令行启动

```bash
# 1. 启动原生桌面浏览器（带窗口、光效扩展、本机设置桥与 AI 控制面）
gador --desktop

# 2. 启动无窗口守护模式（供外部 AI / MCP / CLI 后台静默调用）
gador

# 3. 单独启动控制面 HTTP 桥接服务（默认 127.0.0.1:43118）
gador-ui
```

### 3.2 原生界面与菜单功能

- **标签栏双布局**：支持在 **Zen 竖向侧边栏** 与 **顶部横向标签栏** 之间随时切换（通过工具栏切换按钮、标签右键菜单「切换至顶部横向标签栏 / Zen 竖向侧边栏」、或 `Gador 设置 → 外观与光场`）。
- **AI 托管双向移交**：
  - 标签右键菜单点击 **「交给 AI 托管」**，即可将当前普通网页原地移交给 AI 并亮起蓝紫光效；
  - 点击 **「从 AI 收回控制」** 或工具栏红色停止按钮，即可立即收回控制权且保持网页不关闭；
  - 点击 **「打开 AI 托管总览」** 可在 `chrome://settings/ai` 查看全部 AI 托管标签与普通日常标签。
- **账户与同步**：工具栏头像弹窗与 `Gador 设置 → 账户与同步` 实时识别当前已登录的 Google 账号列表，支持直接跳转管理或添加账号。
- **四引擎默认搜索**：支持在 `Gador 设置 → 搜索引擎` 或新标签页一键切换 **Google / Bing / 百度 / DuckDuckGo**，地址栏 Omnibox 与新标签页同步生效。

---

## 4. 独立模块（VPN 与指纹防护）的验证安装与整合

Gador 将 **VPN 管理区域（`vpn`）** 与 **隐私与指纹防护区域（`privacy-shield`）** 设计为完全解耦的独立可选模块。**刚安装核心浏览器时，两个模块默认均未安装**；同时为防止他人或恶意脚本随意安装这两个高权限模块，**仅对这两个模块强制实施安装验证**（普通 Chromium 浏览器扩展不受影响，可按常规方式自由安装）：

- **Ed25519 数字签名 + 全文件 SHA-256 校验**：拒绝未签名、未知发布者或任意文件被篡改的模块包；
- **一次性人工验证确认码 + 可选本地安装密码锁**：禁止无验证的静默安装；可通过 `gador-mod auth set-passphrase` 为本机再加一层安装密码；
- **运行时完整性复核**：每次启动加载扩展前自动复核已安装模块签名，若磁盘文件被篡改立即拒绝挂载。

### 4.1 方式一：命令行验证安装（推荐）

```bash
# 1. 查看模块目录、Ed25519 签名摘要与当前状态
gador-mod list

# 2. 单独验证签名完整性
gador-mod verify vpn
gador-mod verify privacy-shield

# 3. 交互式验证并安装（终端将展示发布者、SHA-256 摘要并要求输入一次性确认码）
gador-mod install vpn
gador-mod install privacy-shield

# 4. （可选）为本机设置模块安装密码锁，后续安装模块均须同时验证密码
gador-mod auth set-passphrase

# 5. 检查模块签名与整合健康度
gador-mod doctor
```

### 4.2 方式二：在浏览器设置页两步验证安装

1. 打开 `chrome://settings/privacy`（左侧 **「隐私与安全」**）或左侧 **「网络与独立 VPN」**；
2. 点击 **「开始安全验证并安装 … 模块」**，系统自动校验 Ed25519 签名并生成 120 秒有效的一次性确认码；
3. 核对发布者密钥、文件数与 SHA-256 摘要后输入确认码（如已设置安装密码则同步输入密码），点击 **「验证并确认安装」**；
4. 安装 `privacy-shield` 后**重启一次 `gador --desktop`**，启动脚本会自动校验签名并挂载独立反指纹 MV3 扩展。

### 4.3 停用、重新启用与卸载

```bash
# 临时停用模块（保留安装文件与用户配置）
gador-mod disable vpn
gador-mod disable privacy-shield

# 重新启用已安装模块
gador-mod enable vpn
gador-mod enable privacy-shield

# 卸载模块（默认保留 ~/.config/gador/vpn 或 privacy-shield.json 历史配置）
gador-mod uninstall vpn
gador-mod uninstall privacy-shield

# 卸载并彻底清除配置文件
gador-mod uninstall privacy-shield --purge
```

---

## 5. 接入外部 AI Agent（MCP / Skill / CLI / SDK）

### 5.1 MCP Server（Claude Code / Codex / Cursor / Antigravity）

`npm run install:local` 已自动同步 Skill 至 `~/.agents/skills/gador`、`~/.claude/skills/gador`、`~/.codex/skills/gador`。手动配置 MCP 时填入：

```json
{
  "mcpServers": {
    "gador": {
      "command": "/home/<user>/.local/bin/gador-mcp",
      "args": []
    }
  }
}
```

当守护进程尚未启动时，`gador-mcp` 会自动拉起 `gador --agent-daemon` 并完成 UDS 握手。

### 5.2 Shell CLI 快速示例

```bash
# 1. 查询内核能力
gador-ctl capabilities

# 2. 创建共享空间并打开页面
gador-ctl space create --auth shared --name work
gador-ctl page open sp_1 https://example.com

# 3. 人工接管与释放
gador-ctl takeover request sp_1 --reason captcha
gador-ctl takeover release sp_1

# 4. 隐私与指纹防护模块（需先 gador-mod install privacy-shield）
gador-ctl privacy get
gador-ctl privacy set --level strict
gador-ctl privacy audit pg_1
```

---

## 6. 常见排障

1. **升级或安装新模块后未看到变化**：请完全关闭所有旧的 `gador` 桌面窗口后再重新运行 `gador --desktop`（`install-local.sh` 会自动重启旧的 `gador-ui` 桥接进程，但已运行的 Chromium 进程需要重启以加载新挂载的独立扩展）。
2. **`privacy_shield_set` 或 `POST /api/privacy-shield` 返回 `ERR_MODULE_NOT_INSTALLED`**：说明尚未安装或已停用 `privacy-shield` 模块，执行 `gador-mod install privacy-shield` 或 `gador-mod enable privacy-shield` 即可。
3. **无窗口守护模式报 Wayland 图形错误**：在纯无头 CI/SSH 环境下启动守护进程请加 `--ozone-platform=headless --no-sandbox --disable-gpu`。
4. **隧道断开后网页全部无法访问**：检查当前是否处于 `strict_tunnel` + `failClosed: true` 模式；这是防 IP 泄漏的主动 Kill-Switch 保护，可在 VPN 面板修复隧道节点或切回 `direct_only` / 跟随宿主机代理。
