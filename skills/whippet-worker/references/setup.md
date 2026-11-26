# Whippet MCP 接入設定

## 向管理員取得資料

1. 完整 MCP URL。一般部署使用 `/mcp`，有反向代理前綴時使用完整路徑，例如 `/whippet/mcp`。遠端使用 HTTPS，若部署使用私有 CA，請依客戶端設定信任管理員提供的 CA。
2. 由 Super Admin 在目標 Workspace 的「外部 Agent 存取」建立專用 Agent Token，明文只顯示一次。從秘密儲存把它注入啟動客戶端的程序環境 `WHIPPET_AGENT_TOKEN`。設定檔只記錄變數名，憑證留在秘密儲存。
3. Workspace 管理者在「正式設定與能力」的「AI 撰寫引擎」選擇「外部 Agent」。此選擇套用於之後新建立的 Run。由有權限的使用者在 Whippet 建立一筆外部作者任務，瀏覽器工具需有該 Workspace 已確認的驗測範圍。

## 設定 MCP 客戶端

把管理員提供的完整 URL 設為 `WHIPPET_MCP_URL`。使用同一組環境變數啟動客戶端及連線查核。Whippet 使用 MCP Streamable HTTP，授權為 `Authorization: Bearer` 加上 Workspace Agent Token。選擇下列其中一種設定。

在 Bash 或 Zsh 終端可用下列方式暫時設定。將範例 URL 換成實際端點，並在提示時輸入 Token，輸入內容不會顯示。

```sh
export WHIPPET_MCP_URL='https://whippet.example/whippet/mcp'
printf 'Workspace Agent Token: '
read -rs WHIPPET_AGENT_TOKEN
printf '\n'
export WHIPPET_AGENT_TOKEN
```

### Codex

```sh
codex mcp add whippet-worker --url "$WHIPPET_MCP_URL" --bearer-token-env-var WHIPPET_AGENT_TOKEN
```

從同一個環境重開 Codex 工作階段，以 `/mcp` 查看工具。若同名項目已存在，先核對 `codex mcp get whippet-worker`，再依需要更新自己的設定。 [Codex MCP 文件](https://developers.openai.com/codex/mcp)

### Claude Code

把下列項目合併到工作目錄的 `.mcp.json`，保留 `${…}` 供 Claude Code 展開。重開工作階段後，依提示信任此專案的 MCP 設定，以 `/mcp` 查看連線。 [Claude Code MCP 文件](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)

```json
{
  "mcpServers": {
    "whippet-worker": {
      "type": "http",
      "url": "${WHIPPET_MCP_URL}",
      "headers": { "Authorization": "Bearer ${WHIPPET_AGENT_TOKEN}" }
    }
  }
}
```

### OpenCode v2

把下列項目合併到 `opencode.json` 或 `opencode.jsonc`。確認 OpenCode 的背景服務也已取得這兩個環境變數，從專案目錄執行 `opencode mcp list` 查看連線。若初次啟動時清單為空，等服務初始化後再查。`codemode: false` 讓接單工具直接顯示。 [OpenCode MCP 文件](https://opencode.ai/docs/mcp-servers/)

```json
{
  "mcp": {
    "servers": {
      "whippet-worker": {
        "type": "remote",
        "url": "{env:WHIPPET_MCP_URL}",
        "headers": { "Authorization": "Bearer {env:WHIPPET_AGENT_TOKEN}" },
        "oauth": false,
        "codemode": false
      }
    }
  }
}
```

其他客戶端以完整 URL、Streamable HTTP 及由秘密儲存注入的 Bearer header 設定，並確認可呼叫 tools 及讀取 resources。 [MCP Streamable HTTP 規格](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## 連線查核與接單

從已安裝 Skill 的 `SKILL.md` 所在目錄執行（Node.js 22 以上）。若使用私有 CA，可在啟動 Node.js 前把 `NODE_EXTRA_CA_CERTS` 設為受信任的 PEM 檔案路徑。

```sh
node scripts/mcp.mjs check
```

`ready` 表示已用 Agent Token 完成 MCP 初始化，且找到四個接單工具及 skill 資源。這項查核只列出工具和資源。HTTP 401 請核對 Token 與所在程序的環境，403 請管理員核對 Origin 或存取設定，429 依 `Retry-After` 等候。若回傳 HTTP 503 `MCP is disabled`，由部署管理者設定獨立的 `WHIPPET_ADMIN_TOKEN` 以啟用 MCP 與 Web 管理認證，再由 Super Admin 建立 Workspace Agent Token。

接著可對 Agent 說「使用 `whippet-worker`，從已設定的 Workspace 接一筆外部撰稿任務。」接單採主動領取，每次處理一筆。瀏覽器操作與正式 Playwright 驗證由 Whippet 的 Manager 和執行 Worker 提供。

### 核對任務技能

以 MCP `resources/read` 取得 `contextBundle.skillUri` 與 `contextBundle.externalReferenceUri`，用各 resource 的原始 `text` 計算 SHA-256。若客戶端僅提供工具或已格式化的 resource 內容，從 Skill 目錄執行下列命令。將兩組 URI 與雜湊換成當次 claim 回傳的值，再使用已通過核對的 Markdown。

```sh
node scripts/mcp.mjs read-skill "$SKILL_URI" "$SKILL_SHA256" \
  "$EXTERNAL_REFERENCE_URI" "$EXTERNAL_REFERENCE_SHA256"
```

若要以 Vercel 或 Pi 自動維持心跳、處理普通 Test 的 `test-author` 任務並保存可重送的提交，可使用 Whippet 的 [參考 MCP Worker](https://github.com/kywk/whippet/blob/main/runtimes/agent-bridge/README.md)。只在專供普通 Test 的 Workspace 使用參考 Worker，因為佇列可同時包含其他技能的任務。
