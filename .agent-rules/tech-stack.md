# 技術堆疊

[主規範](../AGENTS.md)

- Server 與 Manager：Go。Server 採單一模組化服務；Manager 獨立部署。
- Worker：Node.js／TypeScript，執行 Playwright 與 Agent 工具迴圈。
- 前端：React／TypeScript SPA，靜態部署。MVP 使用簡單表單與列表，先完成流程。
- 資料庫：PostgreSQL，同時保存 MVP 任務佇列；暫不引入 Redis。
- 附件：Server 持久化目錄，透過儲存介面讀寫；遠端 Manager 透過 HTTP 上傳。
- 模型：OpenAI-compatible adapter；保留 Chat Completions 與 Responses 接縫；目前先預配 OpenCode Go Muse 的原生 Responses API，設定 base URL、model、reasoning effort 與 API key。完整 Agent 工具迴圈另依 M3 實作。
- 部署：Server 為 Linux Docker；執行節點為 Linux 或 Mac 上的 Docker。執行節點可與 Server 同機或分離。
- 瀏覽器：MVP 先 Chromium；腳本採 TypeScript。Mac Docker 支援不代表原生 macOS Safari 支援。
- 版本在初始化時選擇並固定於工具設定、lockfile 與映像標籤；本文件不重複維護版本清單。
- 尚未定案：具體 Go router、前端元件庫、串流實作套件。由對應 owner 選擇最小可用方案。

## M11 MCP（2026-11-14）

Server 使用官方 `github.com/modelcontextprotocol/go-sdk v1.3.1`（Go1.23相容）提供Streamable HTTP；允許此直接依賴及必要間接依賴，精確版本以services/server/go.mod/go.sum鎖定。不升既有Go工具鏈。首波採stateless transport與v11管理gate，MCP browser session另有業務租約，不能混為同一生命週期。
