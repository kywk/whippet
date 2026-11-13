# MCP Agent 接入（M11 開發中）

本頁對應 [v11 契約](../../contracts/mvp-v11.md)。目前首波正在實作 Token、唯讀 Catalog、skill resources 與 browser session 核心；不代表互動產稿、接單或階段驗收已完成。不得將此設定套用到既有19287驗收現場。

## 部署與管理

MCP採明確啟用：部署端提供獨立 `WHIPPET_ADMIN_TOKEN`，不得使用Manager token或Agent Token代替。未設定時，MCP與Token管理回503；原開發模式不代表可以安全對外開放MCP。

啟用後，管理客戶端所有 `/api` 請求以 `X-Whippet-Admin-Token` 傳管理key。Manager仍走原專用Bearer；外部Agent只走 `/mcp`，使用Workspace Agent Bearer。管理API拒絕任何Bearer，即使同時帶正確管理key。

使用HTTPS；本機隔離測試可用loopback HTTP。若客戶端會傳Origin，部署設定 `WHIPPET_PUBLIC_ORIGIN` 為精確scheme、host與port；不接受任意Origin或由轉送Host推導信任。管理key與Agent Token不可放在URL、瀏覽器持久儲存、一般log或版本控制。

## 建立與撤銷Token

管理API依序為：

1. `POST /api/workspaces/{workspaceId}/agent-tokens`，JSON `{ "name": "local-agent" }`。
2. 建立回應中的 `token` 僅顯示一次；用客戶端支援的秘密儲存方式保存，不貼到對話或命令歷史。
3. `GET /api/workspaces/{workspaceId}/agent-tokens` 只回metadata，無法取回原明文；遺失時撤銷舊Token並建立新的。
4. `DELETE /api/workspaces/{workspaceId}/agent-tokens/{tokenId}` 撤銷；撤銷提交後的新MCP請求立即拒絕。

每個Token固定屬於一個Workspace。不要把管理key交給外部Agent。管理UI輸入只保留在記憶體；登入成功清除輸入，以不含管理key的HttpOnly、SameSite Strict cookie維持最多8小時session，Server重啟即失效。原生報告與WebSocket使用同源cookie；部署須設定精確WHIPPET_PUBLIC_ORIGIN以通過寫入檢查。登出會撤銷session並清除一次性Token畫面。

## 外部客戶端

在支援Streamable HTTP的MCP客戶端設定Server URL為 `https://<部署主機>/mcp`，Authorization header為 `Bearer <Agent Token>`。這裡的角括號是說明占位，不能直接照貼；避免在會列印header的除錯模式下連線。

先執行initialize，再查tools/list與resources/list，以實際列出的能力為準。首波工具為：

| 工具 | 用途 | 參數 |
| --- | --- | --- |
| catalog_search | 搜尋該Workspace已發佈Module首頁 | `{query,limit}`，limit=1..20 |
| catalog_get | 讀取同Workspace已發佈Module固定版本 | `{moduleVersionId}` |

schema直接來自工具註冊表；catalog_search不接受cursor。首波尚未公開catalog_next_page，即使搜尋回nextCursor，也不能宣稱已取完整目錄。skill resources僅提供列出的封裝內容，不接受任意本機檔案路徑。

首波沒有publish、Plan確認或其他人工核准工具；後續AI寫入一律為草稿並記ai來源，不能取代真實驗證及人在UI發佈。

## 回應與錯誤

- 401：Token或管理認證缺少／失效；使用對應入口的認證，不自動改用管理key。
- 403：Origin不符、認證入口不符或權限拒絕；不要以移除守衛重試。
- 429：每Token每分鐘60次、burst10；依Retry-After等待。
- 503：MCP未啟用或服務尚未可用；不能將它解讀為空工具清單成功。

工具錯誤使用MCP isError與安全固定訊息。超限不截斷JSON。稽核只記Token/Workspace識別、工具名、固定結果及時間，不記參數、內容或Token明文。

## 尚未完成的整合

browser session採10分鐘閒置／30分鐘硬期限，共用Worker容量且回收後才釋放名額。首波Runtime核心的隔離測試不等於Server租用入口、登入或LiveView已接通；未有可信credential resolver時登入必須拒絕。

`authorEngine=external`、task_claim／心跳／task_submit、互動Module/Use Case寫入與外部Agent端到端仍待後續切片。不要提前開啟設定或以本頁示意宣稱可完成產稿。

官方協定參考：[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[本專案固定的Go SDK v1.3.1](https://github.com/modelcontextprotocol/go-sdk/tree/v1.3.1)。
