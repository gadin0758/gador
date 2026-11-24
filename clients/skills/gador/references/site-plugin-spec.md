# Site Plugin（站点语义插件）规范 v0.1

当某个高频网站尚未原生支持 **WebMCP** 时，可通过 `clients/site-plugins/<domain>/plugin.json` 为该站点补充一层声明式语义工具。插件加载器会自动把这些工具注册到 MCP Server 的工具列表以及 `agent.capabilities` 中，帮助任意 AI Agent 读懂并稳定操控该站点。

## 目录结构

```text
clients/site-plugins/
└── example.com/
    ├── plugin.json        # 工具清单、匹配域名、所需 authMode 与输入 Schema
    └── actions/           # 声明式步骤或受控脚本（仅使用稳定语义定位器，禁止硬编码像素坐标）
```

## 约束红线

1. **禁止硬编码凭证或私密 Token**：认证一律依托浏览器的 `authMode: "shared"` 持久化 Profile，或在无登录场景显式声明 `authMode: "private"`。
2. **禁止脆性像素坐标**：必须优先使用 ARIA Role/Name、稳定 `data-testid`、语义选择器或站点自带 WebMCP 工具。
3. **敏感动作显式标注**：涉及提交、删除、转账、权限变更的工具必须声明 `"requiresConfirmation": true`，触发人工接管或确认。
4. **必须附带 Fixture 回归用例**：每个站点插件应提供最小 HTML Fixture 验证定位器唯一性，确保页面改版时能第一时间发现失效。
