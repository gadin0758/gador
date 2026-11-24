# Gador 开发、编码与验收规范（Development Guide）

本文档定义 Gador 仓库的工程边界、代码规范、Skill-First 同步纪律、构建打包流程与强制回归门禁。所有贡献者（人类与 AI Agent）均须严格遵守。

---

## 1. 核心原则与红线

1. **洁净室原创原则（Clean-Room）**：
   - 只借鉴业界成熟架构思路，**零代码抄袭**。所有 `kernel/`、`patches/`、`clients/`、`modules/`、`tests/` 代码均须洁净室原创实现。
2. **核心与扩展模块解耦原则**：
   - 核心内核与核心扩展仅保留基础浏览器控制面、光效 UI 与安全基线；
   - 高级可选项（如 `vpn` 管理面板与档案备份、`privacy-shield` 反指纹扩展与体检）必须落在 `modules/<id>/` 中，通过 `modules/registry.mjs` 接受用户显式安装、启停与卸载。
3. **安全与合规红线**：
   - 严禁削弱凭据与支付物理隔离（`SecurityGuard`、`ERR_DOMAIN_DENIED`、`ERR_SENSITIVE_ACTION_REQUIRES_HUMAN`）；
   - 严禁绕过 `SO_PEERCRED` / `0600` UDS 权限校验或放宽 `127.0.0.1:43118` 的跨站 Origin 守卫；
   - 严禁开发 CAPTCHA 自动破解、人机挑战绕过或权限控制绕过功能——遇到人机验证必须严格走 `takeover.request` 交由人类接管。

---

## 2. 仓库目录边界

| 目录 | 语言 / 技术栈 | 职责边界 |
| :--- | :--- | :--- |
| `kernel/core/` | 纯 C++20（零 Chromium 依赖） | UDS `0600` 服务端、长度前缀帧编解码、状态机、安全围栏与核心单测 |
| `kernel/` | Chromium C++ 集成层 | `AgentSpaceManager`、`AgentIpcServer`、`NetworkTunnelProvider` 与 Chromium `WebContents`/`Profile` 桥接 |
| `patches/` | Git Patch / Chromium 源码改动 | 对 `sources/chromium-158.0.8127.36/` 的最小化、可审计补丁 |
| `clients/protocol/` | Node.js ESM（零第三方依赖） | `schema.json`、UDS 客户端、`vpn-store.mjs`、`privacy-shield-store.mjs` |
| `clients/mcp-server/` | Node.js ESM | 标准 stdio MCP Server、Tools/Resources/Prompts 与 Site Plugins 加载器 |
| `clients/ui/` | Node.js ESM + TrustedTypes DOM | 本机控制面 HTTP 桥接与热更新 `chrome://settings` 融合脚本（`gador-settings-bridge.js`） |
| `clients/extension/` | MV3 扩展（最小权限） | 核心 AI 状态光效与四引擎新标签页（**不得**塞入可选模块的高权限脚本） |
| `clients/cli/` & `clients/plugin/` | Node.js ESM | `gador-ctl`、通用 SDK、Skill 安装脚本 |
| `clients/skills/gador/` | Markdown | 面向外部 AI Agent 的标准化 Skill 文档 |
| `modules/` | Node.js ESM + 独立 MV3 扩展 | 独立可安装模块目录（`registry.mjs`、`cli.mjs`、`vpn/`、`privacy-shield/`） |
| `tests/regression/` | `node:test` + C++20 unittest | P0/P1 高危门禁与端到端回归套件 |

---

## 3. Skill-First 同步规范（强制）

每当新增、修改或废弃任何控制面能力时，**必须在同一次提交中完成以下同步**，否则 `skill-sync.test.mjs` 会拦截合入：

1. **UDS 协议变更**（方法、枚举、错误码、事件）：
   - 更新 [clients/protocol/schema.json](../clients/protocol/schema.json)
   - 更新 `kernel/` 内核实现与 `agent.capabilities` 返回值
   - 更新 [clients/skills/gador/SKILL.md](../clients/skills/gador/SKILL.md)
   - 更新 [docs/api-reference.md](api-reference.md)
2. **MCP / HTTP / 模块接口变更**：
   - 更新 `clients/mcp-server/tools.mjs` / `server.mjs` 或 `modules/<id>/module.json`
   - 更新 [clients/skills/gador/SKILL.md](../clients/skills/gador/SKILL.md) 及 [clients/skills/gador/references/cli-and-mcp.md](../clients/skills/gador/references/cli-and-mcp.md)
   - 更新 [docs/api-reference.md](api-reference.md) 与对应模块 `README.md`
   - 在 `tests/regression/` 补充自动化回归断言

---

## 4. 各语言编码规范

### 4.1 C++20（`kernel/` 与 Chromium 集成代码）
- **零编译警告**：`kernel/core/` 使用 `-std=c++20 -Wall -Wextra -Werror` 编译，任何警告视同编译失败。
- **所有权与回调生命周期安全（血泪教训）**：
  - 在 `WebContentsObserver::WebContentsDestroyed()` 等会触发销毁自身观察者的回调中，**严禁将成员变量以 `const std::string&` 引用传入可能销毁 `this` 的函数**；必须先按值拷贝（如 `std::string page_id = page_id_;`）再回调，彻底杜绝 UAF（Use-After-Free）崩溃。
- **非阻塞治理**：JS 对话框、弹窗收编与人工接管冻结必须在 Browser 进程状态机中完成，禁止阻塞 Renderer 主线程或死锁 CDP 会话。
- **最小补丁原则**：涉及原生菜单或外观（如 `tab_menu_model.cc`、`app_menu_model.cc`、`settings_ui.cc`）的改动尽量收敛，高频样式迭代优先通过 `native-ui.json` 与 `gador-settings-bridge.js` 热更新实现，避免不必要的 Chromium 全量重编。

### 4.2 Node.js ESM（`clients/`、`modules/`、`tests/`）
- **零外部运行时依赖**：所有 `clients/` 与 `modules/` 代码只使用 Node.js 标准库（`node:fs`、`node:http`、`node:net`、`node:path`、`node:os`、`node:child_process`），保持打包极速且无供应链风险。
- **敏感文件权限**：所有用户配置、Socket、备份与模块注册表目录创建时显式指定 `mode: 0o700`，JSON 文件写入指定 `mode: 0o600`。
- **可测试环境变量覆盖**：涉及 `~/.config/gador` 或 `~/.local/share/gador` 的存储模块必须支持环境变量覆盖（如 `GADOR_VPN_STORE_DIR`、`GADOR_PRIVACY_SHIELD_FILE`、`GADOR_MODULES_FILE`、`GADOR_MODULES_DIR`），确保回归测试绝不污染开发者真实配置。

### 4.3 WebUI 与扩展前端（`gador-settings-bridge.js`、`extension/`）
- **严格 TrustedTypes 合规**：Chromium `chrome://settings` 启用严格 TrustedTypes CSP，**严禁使用 `innerHTML`、`outerHTML`、`insertAdjacentHTML` 或 `eval`**；所有 DOM 节点一律使用 `document.createElement` + `textContent` 构建。
- **Shadow DOM 统一样式**：改造原生设置页元素时采用递归 `shadowRoot` 注入带标记（`data-gador-native-theme="1"`）的 `<style>`，去重节点使用 `data-gador-deduped="1"` 隐藏而不粗暴 `remove()`，避免破坏 Polymer/Lit 内部数据绑定。
- **零页面痕迹（反指纹扩展）**：`MAIN` world 内容脚本不得向 `window`、`document` 或 `sessionStorage` 挂载可枚举或可探测的私有标记键，包装后的原生函数必须维护 `Function.prototype.toString` 返回 `[native code]`。

---

## 5. 构建、打包与迭代工作流

```bash
# 1. 仅修改 JS/MJS/扩展/模块/文档时：零 C++ 编译，秒级打包安装
npm run install:local

# 2. 修改了 Chromium C++ 源码（sources/chromium-158.0.8127.36/）时：增量编译再安装
ninja -C sources/chromium-158.0.8127.36/out/AgentDev chrome && npm run install:local

# 3. 单独检查 JS 语法
node --check modules/registry.mjs modules/cli.mjs clients/ui/server.mjs
```

---

## 6. 强制回归门禁（Mandatory High-Risk QA Gate）

每次功能完成或构建改动后，**必须执行以下门禁并全部通过（0 失败）**：

```bash
# A. 本地全量门禁（C++20 核心单测 + 协议/MCP/CLI/UI/模块/Skill 同步）
npm run test:gate

# B. 真实已安装 Engine 158 端到端门禁（无头或桌面 Socket）
TMPDIR=/tmp ~/.local/share/gador/lib/gador-engine/gador-bin \
  --agent-daemon --ozone-platform=headless --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/gador-gate-prof --agent-socket=/tmp/gador-gate.sock &
AGENT_KERNEL_SOCKET=/tmp/gador-gate.sock npm run test:gate
```

### 6.1 门禁必验清单
- **高危指标 A（P0）**：UDS `0600` 权限、非零视口与后台不降频、50 次连续热挂载/卸载零崩溃、`shared`/`private` 双态隔离与 `ERR_TARGET_OUT_OF_SCOPE`、弹窗 100% 收编、非阻塞 JS 对话框跨连接存活、`USER_ACTIVE` 立即冻结与恢复、密码/支付硬隔离。
- **高危指标 B（P1）**：`osProxyDisabled == true`、`disable_non_proxied_udp`、`strict_tunnel` + `failClosed` 断网阻断（`ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED`）、`shared` 统一出口与 `private` 独立出口。
- **模块解耦与验证门禁（仅限 `vpn` 与 `privacy-shield` 两个独立模块，不影响常规浏览器扩展）**：默认未安装状态下可选模块门禁生效；未经验证直接安装返回 `403 ERR_INSTALL_VERIFICATION_REQUIRED`；Ed25519 签名与全文件 SHA-256 校验通过后须完成一次性确认码（及可选安装密码）方可安装；修改 `modules/vpn/` 或 `modules/privacy-shield/` 内任何文件后，**必须使用 `gador-mod sign` 重新签名并通过 `gador-mod verify`**；磁盘文件被篡改时 `doctor` 立即告警且拒绝挂载扩展。
- **UI 视觉自检**：凡改动 `chrome://settings` 或原生窗口界面，必须对真实已安装浏览器截图并人工/视觉核查排版、对齐、无重叠、无 Chromium 残留文案后再交付。

---

## 7. 提交与 Code Review 清单

提交前自查以下 6 项：
- [ ] `git status` / `git diff` 无临时文件、日志、密钥或意外修改；
- [ ] C++ 改动通过 `ninja` 零错误编译，且 `npm run test:cpp` 零警告通过；
- [ ] 协议/MCP/模块改动已同步 `schema.json`、`SKILL.md`、`docs/api-reference.md` 并通过 `skill-sync.test.mjs`；
- [ ] 可选模块改动未向核心扩展 `clients/extension/manifest.json` 引入多余权限；
- [ ] `AGENT_KERNEL_SOCKET=<sock> npm run test:gate` 100% PASS；
- [ ] 如涉及桌面安装包，已执行 `npm run install:local` 并验证 `gador-mod doctor` 正常。
