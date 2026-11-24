# `gador` 仓库开发与验收规范

## 1. 核心原则
- **只借鉴思路，零代码抄袭**：所有 `kernel/`、`patches/`、`clients/`、`tests/` 代码均须洁净室原创实现。
- **架构真相来源**：见 [docs/architecture.md](docs/architecture.md) 与协议契约 [clients/protocol/schema.json](clients/protocol/schema.json)。

## 2. Skill 就绪规范（Skill-First）
浏览器在开发每一项内核/协议能力时，必须同步维护面向 AI Agent 的 Skill 与自描述能力：
1. 新增或修改任何控制面方法、状态枚举或错误码，必须同步更新：
   - `clients/protocol/schema.json`
   - `kernel/` 内核的 `agent.capabilities` 返回值
   - `clients/skills/gador/SKILL.md`（以及必要时的 `references/`）
2. 每次改动必须通过 `tests/regression/skill-sync.test.mjs`，确保 Skill 文档与真实协议契约零漂移。

## 3. 高危指标强制回归门禁（Mandatory High-Risk QA Gate）
以下两类高危指标作为本项目的核心质量红线。**每次功能完成、以及浏览器可运行后的每一次构建改动，都必须执行 `npm run test:gate`（真实浏览器运行后传 `AGENT_KERNEL_SOCKET=<sock> npm run test:gate`）并全部通过：**

- **高危指标 A（P0：隔离空间、热挂载与交互稳定性）**
  - 脱离 `TabStripModel` 的隐藏 `WebContents` 非零视口与后台调度不降频；
  - 收起态小按钮 ↔ 展开态专属 Agent 空间 **50 次连续热挂载/卸载零崩溃**；
  - `shared`（共享登录、零个人历史污染）与 `private`（独立 OTR、零个人 Cookie）严格隔离，个人标签页越权访问 100% 拦截（`ERR_TARGET_OUT_OF_SCOPE`）；
  - `window.open` / `_blank` 弹窗 100% 收编在 AgentSpace 内不逃逸；
  - `alert` / `confirm` / `prompt` / `beforeunload` 不死锁 CDP、支持跨连接存活；
  - 主动人工接管（`USER_ACTIVE`）立即冻结 Agent 写入（`ERR_HUMAN_IN_CONTROL`），释放后无损恢复。

- **高危指标 B（P1：独立 VPN 通道防泄漏 + 跨 OOPIF 语义一致性）**
  - `NetworkTunnelProvider` 彻底切断宿主机系统代理覆盖（`osProxyDisabled == true`）；
  - 强制 `disable_non_proxied_udp` 防止 WebRTC 泄漏，支持独立 DoH / 远端 DNS 解析；
  - `strict_tunnel` + `failClosed` 在隧道断开时严格阻断出网（`ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED`），绝不静默回退系统直连；
  - `shared` 空间沿用浏览器统一出口避免双 IP 异常，`private` 空间支持独立出口；
  - 跨同源/跨域 OOPIF 与 Shadow DOM 的节点引用与交互解析无撞号、无丢失（Phase 2 接入真实内核后纳入必测）。
