<img src="assets/icon.svg" width="64" height="64" alt="Gador">

# Gador

**AI-Agent 原生 Linux Chromium 浏览器**（基于 Chromium `158.0.8127.36` 洁净室内核构建）。

Gador 将日常桌面浏览与 AI 自动化控制面原生融合，提供**桌面无窗口守护模式（`--agent-daemon`）**、**物理隔离的双态 AgentSpace（`shared` / `private`）**、**密码/支付硬围栏与即时人工接管（`USER_ACTIVE`）**与**原生光效界面（Optical Lightfield）**。

---

## 核心文档索引

| 文档 | 内容说明 |
| :--- | :--- |
| [使用说明文档（User Guide）](docs/user-guide.md) | 安装、启动形态、桌面设置项、独立模块安装整合、AI 客户端接入与常见排障 |
| [完整接口文档（API Reference）](docs/api-reference.md) | UDS 0600 二进制协议、21 个内核 RPC、7 类事件、11 个错误码、MCP Server、本机 HTTP API、CLI 与 SDK 全量参考 |
| [模块设计与整合指南（Module Architecture）](docs/module-architecture.md) | `vpn` 与 `privacy-shield` 独立可插拔模块设计、清单规范、安装/卸载/热启停生命周期与扩展动态挂载机制 |
| [自定义模块开发与签名指南（Module Developer Guide）](docs/module-developer-guide.md) | 明文模块制作脚手架（`gador-mod init`）、仅敏感资料 AES-256-GCM 加密密库、自定义 Ed25519 密钥签发、信任管理与统一验证安装教程 |
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

### 2. 按需单独安装与整合可选模块

核心浏览器默认保持精简与最小权限面；**独立 VPN 管理区域（`vpn`）** 与 **隐私与指纹防护区域（`privacy-shield`）** 为独立模块，需由用户按需单独安装并整合：

```bash
# 查看可用模块与当前整合状态
gador-mod list

# 单独安装并整合 VPN 管理模块（档案库 + 强制备份 + 宿主机代理跟随 + Settings 面板）
gador-mod install vpn

# 单独安装并整合隐私与指纹防护模块（独立 MV3 反指纹扩展 + Sec-GPC + AI 环境体检）
gador-mod install privacy-shield

# 检查所有已安装模块的健康与整合状态
gador-mod doctor
```

> 也可直接在浏览器打开 `chrome://settings/gador-vpn` 或 `chrome://settings/privacy`，通过界面中的 **「安装并整合模块」** 按钮一键完成安装、启用、停用或卸载。

### 3. 运行高危回归门禁测试

```bash
# 仅运行 C++20 内核核心单测
npm run test:cpp

# 运行全量 P0/P1 回归门禁（含 Skill 同步、MCP、模块安装、真实引擎测试）
npm run test:gate

# 对运行中的真实 Gador 引擎 Socket 执行全量门禁
AGENT_KERNEL_SOCKET="$XDG_RUNTIME_DIR/gador/ctl.sock" npm run test:gate
```
