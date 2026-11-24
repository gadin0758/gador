# Gador 浏览器完整使用说明文档

本手册面向最终用户与 AI Agent 集成者，完整介绍 **Gador** 的安装、启动形态、桌面界面功能、模块驱动的自定义设置权限、外部 AI 接入以及常见问题排查。

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
4. **核心与扩展模块解耦 + 按模块授予自定义设置权限**：
   - 核心浏览器只内置基础 AI 控制面、光效 UI、账户/搜索引擎与底层内核网络原语；
   - 默认不预置任何额外高权限功能开关；仅当用户按规范自行加入并启用经过签名的独立模块后，浏览器才会根据该模块内实际提供的功能清单，向用户动态开放对应的自定义设置权限。

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
| `~/.config/gador/installed-modules/<id>/` | `0700` | 用户通过签名验证后单独加入的模块运行目录（浏览器升级不丢失） |
| `~/.config/gador/module-settings/<id>.json` | `0600` | 已启用模块的自定义设置持久化文件（仅在对应模块加入后开放读写） |
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

- **标签栏双布局**：支持在 **竖向侧边栏** 与 **顶部横向标签栏** 之间随时切换（通过工具栏切换按钮、标签右键菜单「切换至顶部横向标签栏 / 竖向侧边栏」、或 `Gador 设置 → 外观与光场`）。
- **AI 托管双向移交**：
  - 标签右键菜单点击 **「交给 AI 托管」**，即可将当前普通网页原地移交给 AI 并亮起蓝紫光效；
  - 点击 **「从 AI 收回控制」** 或工具栏红色停止按钮，即可立即收回控制权且保持网页不关闭；
  - 点击 **「打开 AI 托管总览」** 可在 `chrome://settings/ai` 查看全部 AI 托管标签与普通日常标签。
- **账户与同步**：工具栏头像弹窗与 `Gador 设置 → 账户与同步` 实时识别当前已登录的 Google 账号列表，支持直接跳转管理或添加账号。
- **四引擎默认搜索**：支持在 `Gador 设置 → 搜索引擎` 或新标签页一键切换 **Google / Bing / 百度 / DuckDuckGo**，地址栏 Omnibox 与新标签页同步生效。

---

## 4. 模块驱动的自定义设置权限

Gador 核心浏览器默认保持精简，不向普通设置页暴露未安装模块的开关；**只有当您通过安全验证加入了对应的功能模块并处于启用状态时**，浏览器才会根据该模块内声明的功能（`settingsSchema`）向您开放对应的自定义设置权限：

- **默认无模块时**：设置页保持原生精简，不渲染多余自定义开关；对应模块设置接口返回 `ERR_MODULE_NOT_INSTALLED`，且 `bubblewrap` 轻量沙箱容器保持 `STOPPED_IDLE`（零内存占用）。
- **加入对应模块后**：通过 Ed25519 签名校验与人工确认安装启用后，浏览器设置页与命令行会**按该模块内实际提供的功能**动态生成自定义设置项与**由模块创作者设计的专属二级菜单**（支持开关、档位选择、数值/文本配置、沙箱动作按钮及互斥冲突拦截、一键恢复默认）。
- **停用或卸载模块后**：对应自定义设置权限立即收回，不再显示或允许修改（默认保留历史配置，加 `--purge` 时一并清理）。

### 4.1 管理已加入模块与自定义设置

```bash
# 查看已加入模块的状态、签名与容器隔离情况
gador-mod list
gador-mod doctor

# 查看当前已启用模块向您开放的全部自定义设置面板
gador-mod settings list

# 读取、修改或重置某个已启用模块的自定义设置（须该模块已加入且启用）
gador-mod settings <moduleId> get
gador-mod settings <moduleId> set <key> <value>
gador-mod settings <moduleId> reset

# 停用、重新启用或卸载已加入模块
gador-mod disable <moduleId>
gador-mod enable <moduleId>
gador-mod uninstall <moduleId> [--purge]
```

> 如需自行开发、签名并接入新的自定义模块（含为模块定义自定义设置项 `settingsSchema`），请参阅 [自定义模块开发与签名指南](module-developer-guide.md)。

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
```

---

## 6. 常见排障

1. **升级或加入新模块后未看到变化**：请完全关闭所有旧的 `gador` 桌面窗口后再重新运行 `gador --desktop`（`install-local.sh` 会自动重启旧的 `gador-ui` 桥接进程，但已运行的 Chromium 进程需要重启以加载新挂载的模块扩展）。
2. **修改某模块自定义设置返回 `ERR_MODULE_NOT_INSTALLED`**：说明对应模块尚未加入或当前处于停用状态；只有当对应模块安装并启用后，系统才会开放该模块的自定义设置权限。
3. **无窗口守护模式报 Wayland 图形错误**：在纯无头 CI/SSH 环境下启动守护进程请加 `--ozone-platform=headless --no-sandbox --disable-gpu`。
4. **隧道断开后网页全部无法访问**：检查当前是否处于 `strict_tunnel` + `failClosed: true` 模式；这是防 IP 泄漏的主动 Kill-Switch 保护，可通过 `gador-ctl network set --mode direct_only` 恢复直连。
