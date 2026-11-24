<img src="assets/icon.svg" width="64" height="64" alt="Gador">

# Gador

**AI-Agent 原生 Linux Chromium 浏览器**（基于 Chromium `158.0.8127.36` 洁净室内核构建）。

Gador 将日常桌面浏览与 AI 自动化控制面原生融合，提供**桌面无窗口守护模式（`--agent-daemon`）**、**物理隔离的双态 AgentSpace（`shared` / `private`）**、**密码/支付硬围栏与即时人工接管（`USER_ACTIVE`）**与**原生光效界面（Optical Lightfield）**。

---

## 核心文档索引

| 文档 | 内容说明 |
| :--- | :--- |
| [使用说明文档（User Guide）](docs/user-guide.md) | 安装、启动形态、桌面设置项、模块驱动的自定义设置权限、AI 客户端接入与常见排障 |
| [完整接口文档（API Reference）](docs/api-reference.md) | UDS 0600 二进制协议、21 个内核 RPC、7 类事件、11 个错误码、MCP Server、本机 HTTP API、CLI 与 SDK 全量参考 |
| [模块设计与整合指南（Module Architecture）](docs/module-architecture.md) | 独立可插拔模块架构、清单规范、互斥槽位、轻量 `bubblewrap` 沙箱与按模块动态授权自定义设置机制 |
| [自定义模块开发与签名指南（Module Developer Guide）](docs/module-developer-guide.md) | 明文模块制作脚手架（`gador-mod init`）、自定义设置权限声明（`settingsSchema`）、仅敏感资料 AES-256-GCM 加密密库、自定义 Ed25519 密钥签发与统一验证教程 |
| [开发规范（Development Guide）](docs/development-guide.md) | 洁净室开发原则、Skill-First 同步规范、C++20/Node/TrustedTypes 编码红线、增量构建打包与高危回归门禁 |
| [架构蓝图（Architecture）](docs/architecture.md) | 底层 Chromium 内核架构与 P0/P1 核心设计真相来源 |
| [Agent Skill 操作规范（SKILL.md）](clients/skills/gador/SKILL.md) | 面向外部 AI Agent 的标准化接入指南与自描述能力契约 |

---

## 快速开始

### 1. 安装核心浏览器与工具链

```bash
# 打包并安装核心浏览器至 ~/.local/share/gador，创建 ~/.local/bin/gador* 命令
npm run install:local
```

安装完成后提供以下命令：
- `gador` — 默认以桌面无窗口守护模式（`--agent-daemon`）常驻后台
- `gador --desktop` — 启动原生桌面浏览器（单层原生 UI + AI 光效 + 4 引擎新标签页）
- `gador-ui` — 独立启动本机控制面桥接服务（`http://127.0.0.1:43118`）
- `gador-mcp` — 标准 stdio MCP Server（自动接入 Claude Code / Codex / Cursor / Antigravity）
- `gador-ctl` — 零依赖内核命令行控制工具
- `gador-mod` — 独立可选模块安装与整合管理器

### 2. 自定义模块与按需开放的自定义设置权限

核心浏览器默认保持精简与最小权限面，不预置额外高权限功能开关。用户可按 [自定义模块开发与签名指南](docs/module-developer-guide.md) 自行开发或导入经 Ed25519 签名验证的模块；**仅当对应模块加入并启用后**，浏览器设置页与 `gador-mod settings` 才会依据该模块 `module.json` 中声明的功能清单（`settingsSchema`）向用户动态开放对应的自定义设置权限：

```bash
# 查看当前模块状态与规范
gador-mod list
gador-mod spec

# 查询已启用模块向用户开放的自定义设置面板与当前值
gador-mod settings list
gador-mod settings <moduleId> get
gador-mod settings <moduleId> set <key> <value>

# 检查所有已安装模块的签名、沙箱与整合健康度
gador-mod doctor
```

### 3. 运行高危回归门禁测试

```bash
# 仅运行 C++20 内核核心单测
npm run test:cpp

# 运行全量 P0/P1 回归门禁（含 Skill 同步、MCP、模块安装、真实引擎测试）
npm run test:gate

# 对运行中的真实 Gador 引擎 Socket 执行全量门禁
AGENT_KERNEL_SOCKET="$XDG_RUNTIME_DIR/gador/ctl.sock" npm run test:gate
```
