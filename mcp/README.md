# dify-mcp —— Dify 工作流技能 → MCP tools

把 Dify 裡的 workflow 暴露成 MCP 工具,讓任何支援 MCP 的 agent(Claude Code / Codex / Cursor / DSH 等)
都能「列出技能」和「跑技能」。

## 前置

1. 已生成技能卡與註冊表:`node tools/bootstrap-skillcards.mjs`(產生 `generated/skill-registry.json` + `registry/*.skillcard.json`)。
2. 要跑的 workflow 需「已發布」(控制台 App 內點發布,或由擴展執行時自動發布)。
3. 建一支 app key:Dify 控制台 → App → API 訪問 → 建立,得 `app-` 開頭的字串。

## 配置

```powershell
copy mcp\config.example.json mcp\config.json
# 編輯 mcp\config.json,把 appKeys 填上真實的 app key
```

```json
{
  "baseUrl": "http://localhost",
  "appKeys": {
    "<app_id>": "app-xxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

> `config.json` 已加入 `.gitignore`,不入庫。

## 跑

```powershell
node mcp/dify-mcp.mjs        # stdio JSON-RPC 伺服器,等 agent 連
```

## 工具

| 工具 | 參數 | 說明 |
|---|---|---|
| `list_skills` | (無) | 列出全部技能:名稱 / app id / 副作用 tier / 輸入 |
| `run_skill` | `skill`(名稱或 app id)、`inputs`(JSON 物件) | 跑一個工作流,回 outputs |

## 接進 agent

**Claude Code / Cursor / 任何 MCP client**:在 MCP 設定加入 stdio server:

```json
{
  "mcpServers": {
    "dify": {
      "command": "node",
      "args": ["D:\\difyIndify\\mcp\\dify-mcp.mjs"]
    }
  }
}
```

**DSH(本 harness)**:若支援 MCP,同上指向 `dify-mcp.mjs`;否則用 `mcp/test-client.mjs` 邏輯直接發 JSON-RPC 驗證。

## 本地冒煙測試

```powershell
@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_skills","arguments":{}}}'
) | node mcp/dify-mcp.mjs
```
