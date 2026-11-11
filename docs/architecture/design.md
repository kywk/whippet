# 架構與執行協定

## 邊界與部署

React SPA → Go Server → PostgreSQL／附件儲存。
Go Manager 主動透過 WSS 連 Server，並在同一 Docker 執行環境管理一次性 Node.js Worker。
Worker 內部包含 Agent runtime、Playwright 及瀏覽器；畫面傳輸與任務控制分開。

- Server：單一模組化服務，負責業務規則、任務持久化與狀態；MVP PostgreSQL 佇列即可。
- Manager：排程本機資源、啟停容器與回收；不跨主機控制遠端 Docker，也不直接連 Server DB。
- Worker：同一映像提供 author／validate／run 模式；author 負責一輪 Agent 工具互動，等待人類時結束。
- Manager／Server 獨立部署；Compose 分為 server 與 runner 配置，允許同機開發。
- Manager 可容器化並使用本機 Docker API。僅 Manager 持有管理能力，Worker 不掛入 Docker socket。
- Mac Docker 執行 Linux 容器；amd64／arm64 的 Worker 映像與依賴在初始化時選定並驗證實際目標。

## 資料模型

| 實體 | 主要欄位／約束 |
| --- | --- |
| Workspace | id、name、網站設定、非機密預設執行設定 |
| Test | id、workspace_id、name、description、published_version_id |
| Draft | test_id 唯一、current_revision、對話 session_id |
| DraftRevision | test_id、revision 唯一、檔案快照／雜湊、設定快照 |
| TestVersion | test_id、version、不可變檔案與設定、來源 revision、validation_run_id |
| Conversation／Message | workspace_id、test_id、role、content、tool result；持久化 |
| Run | id、kind、版本或 revision、設定快照、狀態、結果、manager_id、attempt_id、時間 |
| Artifact | run_id、相對儲存鍵、種類、大小與上傳狀態 |
| Manager | id、連線狀態、capacity、最後心跳；MVP 只允許一個啟用 |

MVP 身分可由後端固定 provider 提供；資源存取走共同授權函式，之後接真正使用者／membership。測試、對話與執行均透過 Workspace 範圍查詢。

## 草稿與發佈

草稿每次保存使用 expected_revision；不符時回 409，避免覆蓋他人的修改。保存產生不可變 revision。
驗證 Run 固定 revision、內容雜湊與執行設定。發佈在 DB transaction 中檢查當前 revision、驗證成功與報告已保存，建立 TestVersion 並更新 Test 指標。
發佈不刪除 revision 或對話；下次編輯延續同一個 Draft，來源可指向已發佈版本。

## 最小 API 範圍

- POST /api/dev-login；GET /api/workspaces；GET/PATCH /api/workspaces/:id。
- GET/POST /api/workspaces/:id/tests；GET/PATCH /api/tests/:id。
- GET/PUT /api/tests/:id/draft；GET/POST /api/tests/:id/messages。
- POST /api/tests/:id/validate；POST /api/tests/:id/publish。
- POST /api/tests/:id/runs；GET /api/tests/:id/runs；GET /api/runs/:id；POST /api/runs/:id/cancel。
- Run 日誌、報告與附件端點；M1 前端以短輪詢更新；M3 對話沿用短輪詢，未來 AI 串流可採 Server SSE，與 Manager WSS 分開。
- /api/manager/connect 為 Manager WS 入口；任務附件上傳使用 HTTP 與 manager 身分驗證。

實際 request／response 放 contracts/；上列為起始範圍，不要求先建立完整 OpenAPI 平台。

## 任務狀態與去重

Run 狀態：queued → dispatched → running → collecting → succeeded／failed。
取消走 cancelling → cancelled；超時結果為 timed_out；結果無法確認為 interrupted。
Run 結果與本機 slot 是否已釋放是兩個狀態：即使 Run 已失敗，未確認容器回收就不能重用 slot。

- Server 是任務與結果的持久化來源，Manager 是本機容器與 slot 的來源。
- dispatch 使用唯一 run_id＋attempt_id；MVP 不自動重試執行，人類重試建立新的 Run。
- Manager 接收任務後先記錄在本機持久化 journal，再建立帶 run／attempt 標籤的容器；重複 dispatch 回覆既有狀態。
- Manager ACK 後才視為已接收；ACK 丟失時對帳或重送同一 attempt，不生成新 attempt。
- 同一 Run 只接受目前 attempt 的結果；終態回報可安全重送，重複事件以 event_id 去重。
- Manager 重啟掃描 journal 與標記容器，先對帳／清理，再接新任務。MVP 可中止殘存任務，不必實作程序接管。
- Server 重啟後從 DB 恢復排隊任務；離線 Manager 的任務等待對帳，不猜測已停止。

## Transport 介面

統一 envelope：protocol_version、message_id、type、manager_id、run_id／attempt_id（適用時）、payload。
MVP 訊息：hello、heartbeat、dispatch、ack、cancel、event、result、reconcile。
hello 宣告 capacity 與協定版本；reconcile 比對活躍任務、終態與尚未完成上傳的附件。
重連採有上限的退避與 jitter。未收到新指令時已在執行的 Worker 繼續，受本機 timeout 約束。

Transport 只負責收送與連線；業務任務處理共用 handler。未來 Polling、HTTP Push 接相同 envelope，本輪只保留介面與設計。

## Worker 執行契約

輸入：工作種類、run／attempt、腳本或草稿快照、URL／設定、timeout、模型設定引用。
輸出：逐行結構化事件、最終結果 manifest 與附件目錄。Agent API key 透過執行環境注入，不寫入腳本、對話、報告。
Manager 管理容器 CPU／記憶體限制、逾時與取消；停止寬限時間後強制終止容器，清理程序及暫存目錄。清理失敗則保留 slot、回報錯誤，其他可用 slot 可繼續。
Playwright 內部 workers 預設 1，避免與 Manager 併發上限相乘。
完成後由 Manager 透過 HTTP 上傳附件，確認 Server 保存後清本機檔；上傳失敗可補送，不重新執行測試。

## AI 編輯

工具介面採探索瀏覽器、讀／更新草稿、執行驗證、讀取報告。官方 Playwright 工具可接入，MVP 不需要多 Agent 自治框架。
模型 adapter 保留自訂 endpoint／model、串流及工具呼叫；OpenCode Go Muse 先預配原生 Responses（非強制 Chat Completions），編輯迴圈依 M3 契約實作；OpenAI-compatible 不保證所有供應商能力一致，先驗證實際選用的一個 endpoint。
每輪使用當前草稿、近期對話與必要工具結果；完整歷史持久化但不全量送模型。M3 每回合最多8次模型請求／12次工具呼叫／180秒。對話/author輸入輸出與衝突處理見 contracts/mvp-v3.md。
驗證要求走同一任務佇列，避免 Agent 另外啟動未計入容量的瀏覽器工作。串行續接任務時釋放前一 slot，避免占用 slot 等另一個任務而卡死。

## 即時畫面

Worker 擷取瀏覽器畫面 → 媒體傳輸元件 → 前端；Server／Manager 提供 session 與 signaling。
WebRTC 作主要方向，預留 TURN；受限環境可用 WSS 畫面轉送備援。控制連線可用不代表媒體連線可用。
先以可替換 LiveView 介面串出畫面；套件由執行 Agent 在功能實作時選擇，不設獨立長期研究階段。
只讀、不要求音訊／滑鼠鍵盤接管。無人觀看可停止串流；觀看中斷不影響測試。WebRTC 未完成時明列狀態，備援不能被回報成 WebRTC 已驗證。

## 最小部署防護與擴充

Manager 使用部署 token；模型金鑰僅在後端執行環境；測試腳本不得取得主機管理 socket。報告以受控附件端點或隔離頁面呈現，避免執行內容混入管理介面。
產品採開源方向，Apache-2.0 為候選，實際 LICENSE 於初始化依選用依賴決定。本輪不複製外部專案程式碼。
未來沿既有邊界增加 RBAC、多 workspace、多 manager、替代模型、S3 儲存與新 transport；MVP 不為這些先建完整系統。
