# `gador` 标准 Agent 工作流手册

## 工作流 A：静默复用用户登录态执行任务（`shared`）

1. 调用 `agent.capabilities`，确认 `runtimeMode`（通常为 `"daemon"`，`windowShownByDefault: false`）。
2. 调用 `space.create({ name: "task", authMode: "shared" })`。
3. 优先检查目标站点是否有内置 Site Plugin（如 `site_github_com_open_repo`）或页面原生 WebMCP 工具。
4. 否则调用 `page.open` 打开页面；全程不打扰用户个人标签栏、不写个人历史记录。
5. 若遇到 CAPTCHA / 2FA / 支付确认，调用 `takeover.request` 并暂停等待用户接管，收到释放后重新读取页面状态继续。
6. 任务结束调用 `space.close` 回收页面。

## 工作流 B：零 Cookie 隔离 + 独立 Fail-Closed VPN 出口（`private`）

1. 调用 `space.create({ name: "isolated", authMode: "private" })` 派生独立内存 `OTRProfile`。
2. 调用 `network.setTunnel({ scope: "space:<spaceId>", mode: "strict_tunnel", endpoint: "socks5://...", dohServer: "https://...", failClosed: true })`。
3. 核验返回值满足 `osProxyDisabled === true`、`webrtcPolicy === "disable_non_proxied_udp"`、`tunnelHealthy === true`。
4. 若运行期间收到 `ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED`，**立即停止重试并上报用户**（内核已阻断出网，绝不静默回退宿主机直连）。
5. 任务结束调用 `space.close`，内存 OTR Profile 与临时 Cookie 自动销毁。

## 工作流 C：安全处理阻塞弹窗与人工接管

- **JS 对话框**：监听 `dialog.opened` 事件（断线重连后会自动重放未关闭弹窗），调用 `dialog.handle({ pageId, accept, promptText })` 处理，切勿忽视导致页面逻辑停滞。
- **收到 `ERR_HUMAN_IN_CONTROL`**：说明用户正主动展开 `AgentSpaceWindow` 操作页面，**必须停止一切写入/导航调用并等待**，直到用户交回控制权（`AGENT_RUNNING`）。
