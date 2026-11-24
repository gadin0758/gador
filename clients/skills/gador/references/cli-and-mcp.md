# `gador` CLI、MCP 与通用 Agent 插件接入指南

## 1. 启动 `gador`（推荐桌面无窗口守护模式）

```bash
# 打包后默认无窗口后台常驻（不弹出任何窗口）
./dist/gador/bin/gador

# 需要桌面窗口时显式启动
./dist/gador/bin/gador --desktop
```

默认控制面 Socket：`$XDG_RUNTIME_DIR/gador/ctl.sock`（权限 `0600`，同 UID `SO_PEERCRED` 校验；可用 `AGENT_KERNEL_SOCKET` 覆盖）。

---

## 2. MCP Server 配置（Claude Code / Cursor / Codex / Antigravity / Windsurf）

在客户端 MCP 配置中加入：

```json
{
  "mcpServers": {
    "gador": {
      "command": "node",
      "args": ["/path/to/gador/clients/mcp-server/index.mjs"]
    }
  }
}
```

打包后可直接指向 `./dist/gador/bin/gador-mcp`。MCP Server 同时暴露：
- **Tools**：内核原语 + 高层网页自操作工具 + 模块发现工具（`module_list`）+ VPN 独立模块工具 + 隐私指纹防护独立模块工具（`privacy_shield_get`、`privacy_shield_set`、`privacy_audit_page`）+ 自动加载的 `clients/site-plugins/` 站点工具；
- **Resources**：`gador://skill`、`gador://spaces`、`gador://pages`、`gador://network`、`gador://vpn-profiles`、`gador://privacy-shield`、`gador://modules`；
- **Prompts**：`start_shared_task`、`start_private_vpn_task`、`request_human_takeover`、`debug_environment_privacy`。

---

## 3. Shell CLI（`gador-ctl`，适合无 MCP 的 Shell 型 Agent / 脚本）

```bash
# 自检内核能力与运行模式
node clients/cli/gador-ctl.mjs capabilities

# 创建共享登录空间并静默打开页面（默认 1280x800 非零视口）
node clients/cli/gador-ctl.mjs space create --auth shared --name work
node clients/cli/gador-ctl.mjs page open sp_1 https://github.com

# 创建私密零 Cookie 空间并绑定独立 Fail-Closed VPN 出口
node clients/cli/gador-ctl.mjs space create --auth private --name anon
node clients/cli/gador-ctl.mjs network set --scope space:sp_2 --mode strict_tunnel --endpoint socks5://127.0.0.1:10808 --fail-closed

# 按需热挂载视图 / 人工接管 / 交回
node clients/cli/gador-ctl.mjs page attach pg_1 --interactive
node clients/cli/gador-ctl.mjs takeover release sp_1
node clients/cli/gador-ctl.mjs page detach pg_1

# 隐私与指纹防护配置及受管页面环境体检（需先安装 privacy-shield 模块）
node clients/cli/gador-ctl.mjs privacy get
node clients/cli/gador-ctl.mjs privacy set --level strict
node clients/cli/gador-ctl.mjs privacy audit pg_1

# 独立可选模块安装与整合（gador-mod）
node modules/cli.mjs list
node modules/cli.mjs install vpn
node modules/cli.mjs install privacy-shield
node modules/cli.mjs doctor
```

---

## 4. 通用 Function-Calling SDK 插件（OpenAI / Gemini / Anthropic / 自己写的框架）

```js
import { createGadorPlugin } from "./clients/plugin/sdk.mjs";

const plugin = createGadorPlugin();
await plugin.connect();

const systemPrompt = plugin.getSystemSkillPrompt();
const openaiTools = plugin.toOpenAITools();       // OpenAI / Gemini / DeepSeek
const anthropicTools = plugin.toAnthropicTools(); // Anthropic Claude

const result = await plugin.executeTool("browser_capabilities", {});
await plugin.close();
```

---

## 5. 一键安装 Skill 到本地 Agent 目录

```bash
# 预览安装路径（不写入磁盘）
node clients/plugin/install.mjs --all --dry-run

# 安装到 ~/.agents/skills/gador、~/.claude/skills/gador、~/.codex/skills/gador
node clients/plugin/install.mjs --all
```
