# Whippet Server

Go 單一服務，依 [`mvp-v1`](../../contracts/mvp-v1.md)、[`mvp-v2`](../../contracts/mvp-v2.md) 與 [`mvp-v3`](../../contracts/mvp-v3.md) 提供 HTTP API、PostgreSQL 佇列、Manager WebSocket gateway 與持久化附件。M2 已完成草稿／發布與可靠佇列整合；M3 Server 已加入持久對話、author 任務與結果套用，Docker／模型端到端驗收由總指揮執行。

M1 已於 2026-11-11 驗收完成。總指揮與 Muse 已確認真實成功 Run、斷言失敗 Run 及兩份 HTML report 正常；storage shim 修正後成功報告顯示 Passed 1／Failed 0，失敗報告顯示 Passed 0／Failed 1。完整 Run ID 與驗證來源見 [DELIVERY.md](DELIVERY.md)。

## 執行

需求：Go 1.23.12、可連線的 PostgreSQL，以及 Server 可寫入的附件目錄。依賴固定於 `go.mod`／`go.sum`：Gorilla WebSocket 1.5.3、lib/pq 1.10.9。完整本機 Compose 操作見 [M1 指南](../../docs/guides/local-m1.md)。

獨立開發時，在 `services/server/` 執行：

```sh
export DATABASE_URL='postgres://whippet:whippet@localhost:5432/whippet?sslmode=disable'
export MANAGER_TOKEN='replace-with-a-deployment-token'
export ARTIFACT_DIR='./data/artifacts'
export PORT='8080'

go mod download all
go run -mod=readonly ./cmd/server
```

啟動時先 Ping DB，再以 transaction 與 advisory lock 執行內嵌的 `migrations/*.sql`。`schema_migrations` 記錄已套用檔案；Server 重啟不重建種子或改寫既有 Run。資料庫帳號需有建立資料表的權限。DB 不可用時啟動失敗，由部署層安排重試。

| 環境變數 | 預設／用途 |
| --- | --- |
| `DATABASE_URL` | 必填，PostgreSQL connection URL |
| `MANAGER_TOKEN` | 必填，Manager WS 與附件上傳共用 bearer token |
| `ARTIFACT_DIR` | `./data/artifacts`；需持久化並由 Server OS 使用者獨占寫入 |
| `PORT` | `8080` |
| `WHIPPET_LIVE_ICE_SERVERS` | `[]`；專用 STUN／TURN RTCIceServer JSON 陣列，不使用 Manager／AI 憑證 |

`POST /api/dev-login` 回固定 `dev-admin`／`superadmin`，不建立 cookie 或 token；M1 的一般 API 共用固定開發身分。這個服務尚未提供真實登入與租戶隔離。SPA 透過相同 origin 的 `/api` 反向代理串接，沒有開放跨來源 CORS。

## Docker

建置 context 必須是本服務目錄：

```sh
docker build -t whippet-server:m1 services/server
```

上述命令從 repo 根目錄執行。Dockerfile 於 build stage 下載固定依賴，使用 `-mod=readonly` 產生靜態 binary，runtime 使用 distroless nonroot。掛載 `/data` 保存附件，並另行持久化 PostgreSQL。使用 bind mount 時需讓 UID/GID `65532:65532` 可寫入 `/data/artifacts`。本機 Compose 位於 [compose.server.yml](../../deploy/compose.server.yml)，預設 Server 對主機為 `127.0.0.1:18081`。

`GET /healthz` 為程序存活檢查，`GET /readyz` 檢查 DB。映像內可執行 `/app/whippet-server healthcheck`，以 3 秒期限查詢本機 `/readyz`，供 distroless 的 Compose healthcheck 使用。Server 不在程序內處理 TLS；遠端部署由入口代理終止 HTTPS/WSS，代理需支援 WS upgrade 並允許超過 60 秒的連線。

## 種子與 HTTP

| 資源 | ID |
| --- | --- |
| 預設 Workspace | `00000000-0000-4000-8000-000000000001` |
| 成功 Test | `10000000-0000-4000-8000-000000000001` |
| 刻意斷言失敗 Test | `10000000-0000-4000-8000-000000000002` |
| 對應已發佈版本 | `20000000-0000-4000-8000-000000000001`／`20000000-0000-4000-8000-000000000002` |

兩份完整 TypeScript spec 都使用 `page.setContent`，不連線外網；每筆 Run 在建立時保存已發佈版本、腳本及 60000ms timeout 快照。失敗 Test 斷言不同的 heading，應由真實 Worker 回 `failed`。

| Method | Path | 回應 |
| --- | --- | --- |
| POST | `/api/dev-login` | 固定 `{user:{id,role}}` |
| GET | `/api/workspaces` | `{items:[Workspace]}` |
| GET | `/api/workspaces/:id/tests` | `{items:[Test]}` |
| GET | `/api/tests/:id` | Test |
| POST | `/api/tests/:id/runs` | `202` Run |
| GET | `/api/tests/:id/runs` | `{items:[Run]}`，新到舊 |
| GET | `/api/runs/:id` | Run |
| POST | `/api/runs/:id/cancel` | Run；queued 立即 cancelled，已派送者進入 cancelling |
| GET | `/api/runs/:id/artifacts/:name` | 已保存附件 |

錯誤使用 `{error:{code,message}}`；無效 UUID 為 400、不存在資源 404、狀態或 attempt 衝突 409。Run 的 `reportUrl` 在 `report.html` 已保存後出現。再次 POST 建立 Run 會產生新 Run；HTTP 建立請求尚無 idempotency key。

```sh
curl -X POST http://localhost:8080/api/dev-login
curl http://localhost:8080/api/workspaces
curl http://localhost:8080/api/workspaces/00000000-0000-4000-8000-000000000001/tests
curl -X POST http://localhost:8080/api/tests/10000000-0000-4000-8000-000000000001/runs
```

## Manager 串接

連線 `ws://<server>:8080/api/manager/connect`，header `Authorization: Bearer <MANAGER_TOKEN>`。所有訊息使用 camelCase envelope；第一筆必須在 10 秒內送出：

```json
{"protocolVersion":1,"messageId":"<uuid>","type":"hello","managerId":"runner-1","payload":{"capacity":1}}
```

每 10～20 秒送一次 heartbeat，最長間隔 60 秒。`active` 必須是陣列，閒置時也要送 `[]`：

```json
{"protocolVersion":1,"messageId":"<uuid>","type":"heartbeat","managerId":"runner-1","payload":{"active":[{"runId":"<run-uuid>","attemptId":"<attempt-uuid>"}]}}
```

1. Server 以 PostgreSQL `queue_seq` FIFO claim 任務，先提交唯一 attempt，再送 dispatch。單一 Manager 的正整數 `capacity` 為全域名額上限；驗證與正式 Run 共用佇列。
2. dispatch payload 為 `{kind:"run",script:"<完整 spec>",timeoutMs:60000}`。Manager 先持久化 journal，再啟動 Worker，回 `ack`。未 ACK 的 dispatch 每 5 秒最多重送一次，保持相同 runId／attemptId；Manager 必須依 attempt 去重。
3. `event` payload 為 `{eventId,kind:"started"|"log",message?}`；同一 eventId 只保存一次。開始事件設為 running，附件上傳後設為 collecting。
4. Manager 上傳附件成功後送 `result`，payload 為 `{status:"succeeded"|"failed"|"timed_out"|"cancelled",error?}`。`succeeded` 必須已保存兩份附件；異常失敗／逾時／取消可缺附件，以便呈現實際錯誤。
5. 終態結果可重送，互相衝突的終態與舊 attempt 會被拒絕。result 只更新 Run；只有終態 attempt 已從後續 heartbeat.active 移除，Server 才釋放名額。Manager 必須在容器實際回收後才移除 active。

Manager ID 於首次 hello 寫入 DB，之後僅接受相同 ID；同 ID 新連線取代舊連線。每個新連線都先等待 heartbeat 對帳，成功後回 `heartbeat_ack`、payload `{}`，不帶 runId／attemptId，再允許派新工作。ACK 與 dispatch／cancel 使用相同串行寫入；ACK 寫入失敗會關閉連線並暫停派送。active 清單可補回遺失的 dispatch ACK；未知 active attempt 會中止連線。Server 重啟恢復 queued Run，既有 attempt 不自動重新排隊；已 ACK／running 但缺少結果的任務保留名額，等待 Manager journal 補送，不猜測已停止。

M2 取消增補：Server 送相同 envelope 的 `type:"cancel"`、既有 runId／attemptId、`payload:{}`；最多每 5 秒重送一次。Manager 必須去重、停止／回收容器，再回報結果與 heartbeat。queued 取消不派送。取消與完成同時發生時，接受 Manager 實際的最終結果，因此 `cancelling` 仍可能收到 `succeeded`。

若取消的 attempt 尚未 ACK，Server 會先重送相同 attempt 的 dispatch，再送 cancel，讓 Manager 可辨識該 attempt 並回報結果；不建立新的 attempt。

## M2 草稿、驗證與發布

| Method | Path | 請求／回應 |
| --- | --- | --- |
| POST | `/api/workspaces/:id/tests` | `{name,description?}` → 201 未發布 Test |
| GET | `/api/tests/:id/draft` | Draft；初次為 revision 1，從已發布腳本或空腳本建立 |
| PUT | `/api/tests/:id/draft` | `{revision,script}` → Draft；過期 revision 回 409 |
| POST | `/api/tests/:id/draft/validate` | `{revision}` → 202 validation Run |
| POST | `/api/tests/:id/publish` | `{revision,confirmed:true}` → 201 Version |
| GET | `/api/tests/:id/versions` | `{items:[Version]}`，新到舊 |

每個 Test 只有一筆 Draft。實際改動腳本才遞增 revision 並清除 validationRunId；相同內容儲存保留 revision，但仍核對 optimistic lock。腳本上限 2 MiB；空草稿可保存，不能驗證。每次 validate 固定腳本、SHA256 與 timeout 快照，並讓最新 validation Run 成為該草稿的發布依據。

發布在同一 DB transaction 內鎖定 Test／Draft／validation Run，核對目前 revision、驗證內容雜湊／腳本／timeout、succeeded、使用者確認，以及目前 attempt 的 report.html 索引與實體檔案可讀且大小相符。任一門檻不符不建立版本；缺確認回 400，驗證或報告不符回 409。同一次 validation 重複確認回傳原版本，不重複產生版本。

發布版本、歷史 revision 與 Run 腳本／設定快照由 DB trigger 防止修改；草稿後續修改不影響已建立 Run。正式 Run 只執行已發布版本，未發布回 409。Run 增加 `kind`、`draftRevision?`、`versionId?`。M1 種子版本保留原資料，Version 的 `validationRunId` 為 null；M2 新發布版本會附對應 validation Run ID。

新增 migration 為 `003_drafts_and_publication.sql`；不修改已套用的 M1 migration。服務的 `Postgres.Artifacts` 必須設定附件儲存，才能在發布 transaction 中核對實體報告（正式入口已設定）。

目前沒有額外的 Server result ACK／完整 reconcile 訊息；Manager 斷線重連時需補送 journal 中尚未確認的終態。發送失敗不建立新 attempt，也不自動重跑測試。

## 附件

```http
POST /api/manager/runs/:runId/artifacts/report.html
Authorization: Bearer <MANAGER_TOKEN>
X-Attempt-Id: <attemptId>
Content-Type: application/octet-stream

<raw body>
```

一般 run／validation 接受 `report.html`／`results.json`（各 64 MiB），另支援原生 HTML 的 `data/<40位小寫hex>.png`（每張 10 MiB、每 Run 最多 32 張且合計 64 MiB）。author 僅接受 `author.json`，上限 2 MiB。上傳與讀取皆核對 Run.kind，不能跨種類存取附件。檔名與 UUID 採白名單，PNG 上傳核對格式，路徑逐層拒絕 symlink；檔案先寫暫存、同步並原子 rename，再登記 DB。key 為 `run/attempt/sha256/name`，同內容上傳可重送，衝突內容回 409，不覆寫已登記報告。終態後拒絕再上傳。

PNG 沿用同一組上傳／下載端點，name 可為 `data/<hash>.png`。report.html 保持原路徑，內部相對圖片網址不改寫；PNG 回應為 image/png。請先上傳 PNG 再上傳報告／送 result。Server 在 Run row lock 下核對 PNG 配額，重送同檔名不重占名額；成功檢查只計 report.html／results.json，PNG 不影響兩份報告門檻。此功能需 migration `005_report_screenshots.sql`。

`report.html` 保留原生報告與相對 PNG 路徑。回應設定 CSP sandbox，允許 inline scripts／styles，以及同源、data/blob 圖片；connect-src 維持 none，script-src 不開放外部來源，避免報告腳本操作 SPA。Server 在原報告 script 前注入記憶體 storage shim，讓 Playwright 設定可在 opaque sandbox 中讀寫 localStorage／sessionStorage；資料只留在本頁，重新整理即清空，不加入 allow-same-origin。注入只改變 HTTP 呈現，保存的附件與 SHA256 不變；回應 ETag 使用 `-storage-png-v1` 後綴。trace.zip、影片與其他附件類型尚未提供。

Manager WebSocket 輸出先 Marshal 完整 JSON，再用 Gorilla 未壓縮的 server WriteMessage 單 frame 路徑，支援 x/net JSON.Receive。4096-byte buffer 與 2 MiB script 契約不變；跨函式庫長 payload 回歸測試位於 `internal/gateway/websocket_interop_test.go`（wsinterop tag，需現有 x/net 0.56.0 與配對 Go >=1.25，獨立暫存 modfile，不新增 production 依賴）。

## M3 對話與 author

| Method | Path | 請求／回應 |
| --- | --- | --- |
| GET | `/api/tests/:id/conversation` | 首次建立空 Conversation；回傳完整已保存訊息與 activeRunId? |
| POST | `/api/tests/:id/messages` | `{content,revision}` → 202 `{run,conversationId}` |

每個 Test 一個 Conversation，同時最多一個未完成 author Run。空訊息或超過 16000 Unicode 字元回 400，過期 revision 或已有 author 回 409。user 訊息與 author Run 在同一交易保存；Run 固定當下草稿腳本／revision，並取最近最多 12 則、總 32000 字元的對話作為 dispatch 快照，保留完整本輪 user 訊息。完整歷史不受模型 context 裁切影響。

author 與其他 Run 共用 FIFO、取消與回收名額規則。dispatch 為 `{kind:"author",script,timeoutMs:180000,author:{conversationId,baseRevision,messages:[{role,content}],validation?}}`；validation 是送出時目前草稿驗證 Run 的固定 `{runId,status,error?}` 摘要，error 最多 4000 Unicode 字元，供 Runtime 的 `read_validation_report` 工具使用，不讀 HTML。無摘要的舊 payload 仍相容。Server 不讀取或轉送模型 key，一般 run／validation 仍送 `kind:"run"`。

Manager 上傳 `author.json {message,script?,requestValidation}` 後回 succeeded。Server 核對 attempt、檔案大小／SHA256／JSON 及輸入快照，在同一 transaction 內：

- baseRevision 未改動時，沿用 M2 規則保存候選腳本；真正變更才產生 revision，並清除舊驗證資格。
- baseRevision 已被人工修改時，不覆蓋草稿、不排驗證，保存候選稿與衝突說明。
- 無 script 時保留原稿；requestValidation 只在無衝突且非空草稿時建立固定結果 revision 的 validation Run，不占住 author Worker 等待。
- assistant 訊息保留 baseRevision、變更時的 appliedRevision、任何已生成的 proposedScript，以及續接的 validationRunId。baseScript 由既有 draft_revisions 關聯取得，重新開啟仍可比較前後差異。

author 終態、assistant 訊息、revision 與續接驗證一起提交；重複 result 先辨識原始回報狀態再返回，不重複套用或排工作。取消／失敗不套用候選稿，provider 錯誤採固定遮蔽訊息；無效 author.json 會成為 failed，保留已存對話與草稿。author 成功只需 author.json；M2 validation／發布的兩份報告與人工確認門檻維持不變，不會自動發布。

新增 migration 為 `004_conversations_and_author.sql`。需要原有 ARTIFACT_DIR volume 才能完成 author 結果核對；本階段 Server 沒有新增 AI 環境變數。

## M4 唯讀即時監看

Viewer 使用同源 `GET /api/runs/:id/live` WS，依目前 Run／attempt 綁定，最多一位觀看者。Manager 使用 bearer token 連獨立 `/api/manager/runs/:id/live?attemptId=...&viewerId=...`。Server 轉送 non-trickle WebRTC offer／answer／mode／state，不處理 RTP；JPEG 備援用完整 binary message，上限 1 MiB，只保留最新影格。

Viewer 與 media 都支援 JSON ping／pong；viewer 每 10 秒 ping、30 秒租約，media ping 不延長 viewer。離線、到期或終態停止 live，透過控制 WS 送綁定 viewerId 的 live.start／stop；影格與 live 錯誤不進任務控制 handler，不改 Run 結果。ICE 設定只使用 WHIPPET_LIVE_ICE_SERVERS，不記錄 credentials。

代理需支援 WebSocket upgrade 並保留含埠號的 Host（Nginx `$http_host`）以通過 Origin 檢查。Server 已豁免 live WS 的 HTTP 30 秒 request deadline，連線改由 live lease 與獨立寫入期限控制。實際 WebRTC／JPEG／TURN 驗收狀態見 DELIVERY。

## 檢查

無外部模組的核心檢查可離線執行，包含 HTTP → 假儲存層 → dispatch／result → 真實附件檔案，並覆蓋 FIFO、名額回收、重連、取消與 traversal：

```sh
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test ./internal/server
```

依賴可用時，先建置整個服務，再以測試用 DB 執行一次資料層整合檢查：

```sh
go build -o /tmp/whippet-server ./cmd/server
TEST_DATABASE_URL='postgres://whippet:whippet@localhost:5432/whippet_test?sslmode=disable' \
  go test -tags=integration ./internal/server -run TestPostgresQueueAndAttemptInvariants -count=1
```

整合測試會在指定 DB 建立獨立隨機 schema，結束時刪除該 schema；不使用既有應用資料表。需要 schema 建立權限。

上述命令供後續開發按改動執行；本次 M1 驗收已完成，不需重跑。實際檢查與仍未涵蓋的 M2 項目見 [DELIVERY.md](DELIVERY.md)。
