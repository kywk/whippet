# 巡檢與 Feedback Desk

Whippet 以已發佈版本執行巡檢，保存每筆 Run 的終態。內網橋接程式拉取結果、在 Feedback Desk 建立團隊工單後，將工單關聯寫回 Whippet 的正式執行歷史。

## 設定

在 Server 以 `WHIPPET_INSPECTION_CONFIG` 指向受管的 JSON 檔。設定以 Workspace 與環境區分來源。每個來源綁定目標網站 origin、Feedback Desk origin、專案及已審查的測試版本。部署時產生兩個獨立的 32-byte 隨機值，轉為 base64url token，分別交給橋接與巡檢排程。設定檔只放各 token 的 SHA-256 小寫十六進位字串。變更設定後重新啟動 Server 套用。

```json
{
  "sources": [
    {
      "workspaceId": "10000000-0000-4000-8000-000000000001",
      "environment": "qa",
      "projectSlug": "sandbox-todomvc",
      "targetOrigin": "https://todo.qa.example",
      "feedbackDeskOrigin": "https://feedback.example",
      "bridgeTokenSha256": "<bridge token 的 SHA-256>",
      "scheduleTokenSha256": "<schedule token 的 SHA-256>",
      "tests": [
        {
          "testId": "20000000-0000-4000-8000-000000000001",
          "versionIds": ["30000000-0000-4000-8000-000000000001"],
          "checkKey": "todo.title",
          "testTitle": "Save a todo",
          "assertionTitle": "The todo title is visible"
        }
      ]
    }
  ]
}
```

將核准網站設為測試版本快照內唯一的目標 origin，並讓預設測試網址指向該網站。測試版本須已通過正常驗證與人工發佈。上列 `testTitle` 為 Playwright `test()` 標題，`assertionTitle` 為 `expect(locator, "The todo title is visible")` 的自訂訊息。使用包含單一 Playwright test 的已審查版本，讓該 test 實際造訪核准網站並執行具名斷言。新增核准版本時可保留先前版本 ID，以便尚未處理的終態繼續查回。

## 服務介面

服務請求以 `Authorization: Bearer <token>` 驗證。排程與橋接各用專用 token，測試草稿與驗證沿用 [Workspace Agent MCP](mcp-agent.md)。

下表的路徑以 `/api/inspections/workspaces/{workspaceId}/runs` 為基底。

| 操作 | 身分 | 路徑與內容 |
| --- | --- | --- |
| 排程巡檢 | 排程 | `POST` 基底路徑。送 `testId`、`versionId`、`environment`、`requestId`，回傳 `202` 及 `runId` |
| 拉取終態 | 橋接 | `GET ?after=<cursor>&limit=<1..100>`。回傳 `items`，非空頁附 `nextCursor` |
| 回查終態 | 橋接 | `GET /{runId}`。查回同一 Run 與當前 attempt 的終態 |
| 寫回關聯 | 橋接 | `POST /{runId}/links`。送 `attemptId`、`projectSlug`、`reportPublicId`，回傳這三個欄位及 `runId`、`workspaceId` |

每筆排程使用固定的 UUID `requestId`。相同排程重送回原 Run，修改參數回衝突。橋接處理完成一頁後保存 `nextCursor`，用於下一次 `after`。終態含 `workspaceId`、`testId`、`runId`、`versionId`、`environment`、`purpose`、`status`、`finishedAt` 與 `outcome`，已開始的 Run 另附 `startedAt` 與 `attemptId`。

`assertion_failed` 表示受隔離的執行已到達核准目標，且確認同一 attempt 的具名斷言失敗及已保存報告。此結果附 `checkKey`、`failureSignature` 及 `reportUrl`。橋接可使用該結果建立工單。其他結果包括 `passed`、`infrastructure`、`cancelled`、`timed_out` 與 `unverified`。橋接僅在自身處理紀錄保存這些結果，供團隊追蹤。

`reportUrl` 指向 Whippet 的人員登入端點。工單關聯從受管的 Feedback Desk origin 及工單識別組成，開啟時由 Feedback Desk 驗證工單存取權。相同關聯重送回原收據，嘗試更換已連結的工單時回衝突。
