# Server 交付

Owner：Whippet Server Agent t31。最新交付：M7.2 編輯週期與驗收摘要（2026-11-12）；既有里程碑紀錄保留於下方。

## M7.2 Server 交付

**Server 實作與必要檢查完成，Web／Runtime 隔離整合待 PM 安排。** 以 `contracts/mvp-v7.md` 頂部固定決策為準，僅修改 `services/server/`；未安裝、執行 Git、讀印憑證、呼叫模型／瀏覽器、部署或重啟共享服務。

### Migration 與行為

- `008_editing_sessions.sql`：每 Test 最多一個 active／discarding 編輯週期；新增 drafts／Conversation／Run／Version 關聯與摘要欄位。舊草稿沒有正式版、腳本／設定異於正式版，或尚有活躍／未回收編輯任務才保留 active；相同且無活躍任務者封存 session／對話與 revision、移除目前 drafts 指標。孤立對話不自動變新草稿。
- 舊 Version.description／backgroundSummary／summaryRunId／editingSessionId 全為 null，不從目前 Test.description 捏造歷史。原腳本、設定、任務／attempt、author_payload 不改；新增 Run/session 關聯納入 immutable trigger。新週期 revision 採原 Test 的 MAX+1，不重用封存 revision。
- `editing_sessions.go`／`editing_http.go`：Test.activeEditingSession 純讀 descriptor；明確 start/resume，GET draft／conversation 不再初始化。Session 對話持久保存；放棄／發布關閉週期但保留歷史 revision、Run 及附件。
- `summaries.go`／`author.go`／`conversations.go`：沿用 kind author、FIFO、author.json 與 180000ms。可信輸入為 skillId=test-author／acceptance-summary、skillVersion="1"、allowedTools、editingSessionId、直接 contextRevision、sourceVersion／conversationSummary；不另傳 mode。公開 Run.authorMode 由保存的 skillId 推導。
- 新 user 訊息與已接受 edit 回覆遞增 contextRevision、清除舊摘要資格；腳本／設定未變時仍保留成功驗證。edit 可保存 8192-byte UTF-8 週期摘要。摘要模式允許 messages=[]，不補造 user；allowedTools=[]，固定完整腳本與合格 validationEvidence（runId／attemptId／revision／SHA256／timeout／真實 stats）。只從驗證後的 results.json 抽統計，不傳整報告或模型 key。
- summary 由 Web 冪等觸發；失敗獨立重試不排新 validation。輸出嚴格採 message／description／backgroundSummary／optional name，不接受 script／requestValidation。完成與發布核對 session、contextRevision、revision、成功驗證 attempt、腳本／設定及已接受摘要；仍要求人工 confirmed 與原報告門檻。確認發布時才更新候選名稱、保存不可變版本說明與背景、關閉週期；重送回原版本。
- discard 先進 discarding、取消本週期編輯任務，保留草稿直到 terminal **且** Manager heartbeat 確認 slot 回收；queued 未派送者可立即結束，不取消正式 Run。原 Engine Tick 在 Manager 離線也做有界 durable 收尾，與 ReleaseSlots 分開交易避免鎖序反轉。晚到／重送 result 在任何現存草稿讀取前核對 Session／attempt 與去重，不可復活新草稿或續排驗證。

### HTTP／JSON 差異

- `GET /api/tests/:id` 新增 `activeEditingSession:null|{id,status,draftRevision,updatedAt}`，一般模式可直接判斷，不呼叫會建草稿的舊行為。
- POST／GET `/api/tests/:id/editing-session`：POST {} 為 start（201）／resume（200）；GET 純讀 `{session:null|EditingSession}`。GET `/api/tests/:id/editing-sessions/:sessionId` 可查已結束週期。
- POST `/api/tests/:id/editing-sessions/:sessionId/discard {revision,confirmed:true}`：等待回收 202、完成 200，回 `{session}`；跨 Test 引用 404。
- PUT draft／POST messages／POST draft/validate 必帶 editingSessionId 與 revision。GET conversation 可指定 `?editingSessionId=...`，不指定只讀當前週期；Conversation／Draft／編輯 Run 回傳 editingSessionId，正式 Run 為 null。
- POST `/api/tests/:id/draft/summary {editingSessionId,revision,validationRunId}` 回 `{run}`，pending 重送 202 同 Run、已成功 200；失敗後明確重試才建立新摘要。
- POST publish 必帶 `{editingSessionId,revision,summaryRunId,confirmed:true}`。Version 新增 nullable description／backgroundSummary／summaryRunId／editingSessionId；新發布不可缺摘要。建 Test 的 name 可省略，暫用「未命名測試」。M7 明確覆蓋舊 M2／M3 的自動建立與永久 Test 對話。

### 實際檢查與產物

- 本 Agent：沿用本輪既有 Server／Gateway 檢查 PASS（0.511s／0.122s），沒有重跑無關全套。新增 M7 定向單元最後一次 `go test -mod=readonly ./internal/server -run '^TestM7' -count=1` **PASS 0.264s**，涵蓋摘要嚴格輸出、週期摘要大小、skill@1／空摘要訊息 wire、過期 context／session／revision／設定／attempt 防護與離線 discard sweep。
- 本 Agent：兩個 M7 integration-tag 案例編譯成功；未提供明確隔離 TEST_DATABASE_URL，故本機只作缺值 skip（0.307s），未連共享 DB，不以 skip 宣稱 DB 通過。
- **PM t36 獨立 DB 實跑證據：TestM7EditingLifecycle、TestM7LegacyMigration 全部 PASS、無 skip，0.521s。** 使用既有 postgres:16.11-bookworm 的獨立臨時 DB；log：`/private/tmp/whippet-m7-db-check.log`。容器已移除，共享 DB 未碰。本 Agent 沿用此證據、不重跑。
- DB 案例核對：純讀零新增、並行 start/resume 唯一、跨 Test 拒絕、真附件統計／空訊息摘要、失敗摘要重試不重驗、context 過期不可發布、發布冪等／不可變版本、新週期來源與 revision、不等待 Manager 的 queued 放棄、取消 terminal＋回收屏障、重啟後收尾與遲到結果不復活，以及 legacy 封存／保留／缺值與 immutable trigger。
- **正式 build PASS**：既有 Go 1.23.12、GOPROXY=off／GOSUMDB=off、GOOS=linux GOARCH=arm64 CGO_ENABLED=0、`go build -mod=readonly -trimpath`。binary：**`/private/tmp/whippet-server-m7`**（含 migration 008），`file` 確認 statically linked ELF aarch64；已回報 t36 可供隔離封裝，本 Agent 未部署。

### 接續與限制

Web 須按新 session/schema 串接，成功驗證後冪等觸發摘要、失敗時明確重試，確認後發布；Runtime 按固定 skillId／skillVersion 與 allowedTools 執行。新／舊 author 輸入解碼相容不代表舊 Web HTTP body 可繼續寫入，新 HTTP 必須帶 sessionId。M7 不提供 Worker 遠端歷史 RPC；完整週期對話在 Server 可讀，Worker 使用有界摘要＋近期訊息，按需歷史工具延 M9。legacy 無 conversationSummary 回 null，首次只有近期訊息窗口，不宣稱已涵蓋完整舊對話，也不補造摘要；後續 edit 逐輪維護。M8 Workspace 範圍強制執行／機密機制未在本輪冒充完成。隔離整合與 M7 主流程由 PM／t33 接續，M1～M6 證據沿用。

## M6 失敗證據附件交付

**Server 模組、隔離 PostgreSQL 與 M5／M6 隔離全鏈整合通過；原共用服務未更新。** 依 `contracts/mvp-v6.md`，僅修改 `services/server/`，本 Agent 不部署、操作 Git、讀取憑證、安裝套件或呼叫模型。

### 產物與介面

- `model.go`／`artifacts.go`：普通 run／validation 新增嚴格 `data/<40位小寫SHA1>.zip`／`.md`，author 仍僅 author.json。ZIP 64 MiB／檔、MD 1 MiB／檔，兩者每 Run 合併 32 檔／128 MiB；PNG 原配額獨立不變。串流核對內容 SHA1 與檔名、沿用 SHA256 保存 key；ZIP 只檢查 PK0304／PK0506 基本 signature，不解壓或驗整包，MD 檢查 UTF-8。沿用既有路徑／symlink 防護。
- `007_failure_evidence.sql`：只擴充 artifacts 檔名 CHECK 至 hashed PNG／ZIP／MD，沒有任意副檔名／路徑或新設定框架。
- `postgres.go`：新 ZIP／MD 合併配額在原 Run row lock 下檢查，排除同名後核算重送；衝突內容／attempt 維持不可覆寫。原 PNG 計數 SQL 從廣泛 `data/%` 改為 PNG 專屬 regex，避免新證據占用 PNG 配額。
- `GET /api/runs/:id/artifacts` → `{items:[{name,size,contentType,url}]}`，依 name 排序，只列當前 attempt 已登記、符合 Run.kind 的白名單附件；已知無附件回 []、未知 Run 404，不列 storage key／檔案系統路徑／token。既有 POST／GET 單檔端點與 attempt／token 規則沿用。
- `http.go`：ZIP 回 `application/zip`、MD 回 `text/markdown; charset=utf-8`；兩者強制 `Content-Disposition: attachment; filename="<hash.ext>"`、nosniff 與 `sandbox; default-src 'none'`。HTML 原 CSP／storage shim／ETag 不動，不提供內嵌 trace viewer；成功與發布仍要求原報告條件，可選證據不能取代報告或改寫斷言結果。
- `evidence_test.go`／`evidence_postgres_test.go`：內容／路徑／kind／限制、下載標頭與列表 API；一個明確 TEST_DATABASE_URL 的 opt-in 隔離 schema 測試，涵蓋 migration 007、列表與配額／重送持久邊界。

### 實際檢查與交付

- 本 Agent：既有 Go 1.23.12，`GOPROXY=off GOSUMDB=off go test -mod=readonly ./internal/server ./internal/gateway -count=1` **通過**（Server 0.482s、Gateway 0.318s）。包含新附件 HTTP／檔案驗證、author 拒絕，以及既有 HTML CSP／shim、發布與佇列回歸。
- 本 Agent：`-tags=integration -run '^TestPostgresEvidenceArtifacts$'` 編譯成功；明確移除 TEST_DATABASE_URL 時 **skip**（0.077s），沒有自行連共用 DB。skip 不作真實 DB 驗收證據。
- **PM t35 真實隔離 DB 測試通過**：既有 `postgres:16.11-bookworm` 快取的獨立容器執行 `TestPostgresEvidenceArtifacts`，PASS（套件 0.636s、test 0.33s）。核對新檔名 CHECK、同 attempt 冪等／衝突不可覆寫、當前 attempt／其他 Run 列表隔離、空／未知 Run、ZIP／MD 合併 byte／count 配額與 PNG 獨立、必要報告門檻與原失敗結果保留。大配額使用隔離 schema 的 metadata fixture，不產生 128 MiB 假檔；內容驗證另走真實 LocalArtifacts。證據來源為 PM 回報；容器已停止移除，未碰共用 DB，不重跑。
- 本 Agent：一次離線 `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -mod=readonly -trimpath` **通過**；`file` 核對 statically linked ELF aarch64。binary：**`/private/tmp/whippet-server-m6-evidence`**，包含 migration 007，已通知 PM，可封裝整合；本 Agent 未部署。

### PM 回報：M5／M6 隔離全鏈最終 PASS

以下證據由 PM t35 回報，本 Agent 僅更新交付紀錄，沒有重跑：

- M5：Workspace 設定的相對 URL 完成驗證、發布與正式 Run，結果 succeeded。
- M6：真實失敗 Run `86d6fe61-ebf4-4c67-b4a4-2898de9d1225` 保存並上傳 ZIP／MD／PNG；ZIP 12931 bytes、MD 1145 bytes，API 與平台 UI 下載內容 hash 一致。
- 使用本機既有 show-trace 根入口開啟真 ZIP，可見實際 `Set content`、`toHaveText` 與 error-context；原生 HTML 顯示 Failed 1／Passed 0，詳細內容正常。HTTP 錯誤、pageerror、CSP 錯誤均為 0。
- Viewer 先前失敗已確認為 PM 手拼 URL 錯誤，產品無須因此修改。附件／Viewer 證據目錄：`/private/tmp/whippet-m6-download-evidence`。
- 隔離服務、網路與 Viewer 已關閉；原共用服務未更新。PM 回報本輪尚未 commit／push，後續部署與提交由 PM 安排。

驗收範圍為上述本機隔離流程；影片與產品內嵌 trace viewer 仍不在支援範圍。本 Agent 待命，不重跑或部署。

## M5 Workspace 設定交付

**Server 模組與 M5 隔離全鏈整合通過，原共用服務未更新。** 依 PM 固定的 `contracts/mvp-v5.md`，僅修改 `services/server/`。本 Agent 未安裝套件、執行 Git、讀取 secrets 或部署／重啟共用服務。

### 產物與介面

- `workspaces.go`／`workspaces_http.go`：GET／PATCH `/api/workspaces/:id`，回 `{id,name,revision,sites:[{name,url}],defaultTestUrl,timeoutMs}`。PATCH 部分更新、sites 整份替換、revision 樂觀鎖；過期 409，no-op 不遞增 revision 或失效草稿。名稱與 URL／timeout 採 v5 範圍；拒絕未知／巢狀欄位、null、userinfo、secrets／env／key，不回顯敏感輸入。
- `006_workspace_settings.sql`：Workspace 持久設定及 draft_revisions／test_versions／runs 的 `workspace_settings` 快照。舊資料保留每筆 timeout 與原腳本；author 設定 timeout 取 base draft，不把 180000ms author 總限時誤當測試 timeout。遷移在原啟動交易內完成，恢復原版本／revision immutable trigger，Run 保護函式新增設定快照欄位。
- Workspace PATCH 實際變更在單一交易新增所有現存草稿 revision、保留腳本、換新設定並清除 validation；新草稿採目前 Workspace 設定及已發佈腳本。草稿交易採 Workspace SHARE → Test／Draft，PATCH 採 Workspace UPDATE → 按 Test ID 排序鎖，與發布／author 套用互斥。
- Draft／Version／Run／dispatch 頂層新增完整 `workspaceSettings`。一般 Run 從已發佈版本複製；既有 queued、author 及其他 Run 不改。發布除原 M2 條件，另比較完整設定快照；舊 author 結果因 baseRevision 衝突不套用、不續驗證，保留 proposedScript。author metadata 保持 v3，總限時仍為 180000ms。
- `workspaces_test.go`、`drafts_test.go`：HTTP 欄位拒絕、URL／timeout 範圍、部分更新／no-op／過期 revision、發布完整設定比對及各任務 kind 的 dispatch 快照。
- `workspaces_postgres_test.go`：單一 opt-in 整合測試 `TestPostgresWorkspaceSettingsSnapshots`，僅使用明確 TEST_DATABASE_URL，各子案例新建隨機隔離 schema，缺變數 skip；沒有共用 DB 預設值。隔離容器與執行命令見本模組 [README](README.md#隔離-postgresql-驗證)。

### 實際檢查

- 本 Agent：`go test ./internal/server ./internal/gateway -count=1` **通過**（Server 0.844s、Gateway 0.760s），使用既有 Go 1.23.12、GOPROXY=off／GOSUMDB=off，無下載。
- 本 Agent：整合 build tag 編譯成功；明確移除 TEST_DATABASE_URL 後執行上述單一整合測試，兩子案例依規則 **skip**（0.388s），未連線本機／共用 DB。此結果只代表編譯與 skip 行為，不作 DB 驗收證據。
- **PM t35 真實 DB 驗收：兩子案例全部通過（0.441s）**。使用既有 `postgres:16.11-bookworm` 快取建立獨立容器：fresh 001→006 涵蓋設定保存、no-op 保留成功驗證、實際變更使舊驗證不可發布、正式版本／queued／author 快照不變與舊 author 衝突／去重；005 升級涵蓋 version 12345ms、draft 23456ms、Run 34567ms、author 180000ms／設定 23456ms 保留，以及設定／腳本 immutable trigger。證據來源為 PM 回報；臨時容器已停止移除，未碰共用 DB，本 Agent 不重跑。
- 本 Agent：一次 Linux arm64 `CGO_ENABLED=0 go build -mod=readonly -trimpath` **通過**；`file` 核對靜態 ELF aarch64。交付 binary：**`/private/tmp/whippet-server-m5-settings`**，包含 migration 006，由 PM 決定整合方式；尚未部署。
- **PM t35 最終隔離全鏈 PASS**：設定相對 URL 後，草稿驗證／發布／正式 Run succeeded；與 M6 附件整合一併完成。此為 PM 回報證據，本 Agent 沒有重跑，原共用服務未更新。

### 串接與限制

M5 相對 URL 的驗證／發布／正式執行已由 PM 在隔離流程確認，取代先前待 Web／Runtime 接線的狀態。Server 保留任務設定快照，不在執行時回讀 Workspace；本次回報未新增真實模型驗收，也未加入任意設定／secret 框架。原共用服務的更新與提交仍由 PM 安排。

## M4 Server 交付

最終 binary：**`/private/tmp/whippet-server-m4`**，Linux arm64、CGO_ENABLED=0、靜態連結，供總指揮封裝既有 image。僅修改 services/server，未安裝套件、執行 Git、讀取 env 檔案或部署服務。

- 獨立 `LiveHub` 與 viewer／media WS：`/api/runs/:id/live`、`/api/manager/runs/:id/live?attemptId=...&viewerId=...`。Viewer 嚴格同源 Origin；media 沿用 Manager bearer token，並核對 DB Run／attempt／assigned Manager、viewerId 與目前控制連線 epoch。
- 每 Run 一位 viewer，第二位 busy；ready 回 viewerId／iceServers。初始 webrtc，non-trickle offer／answer、mode／state 走獨立 live 通道；JPEG binary 上限 1 MiB，只保留最新一張，獨立 writer／2 秒寫入期限，沒有影格進入 Engine 或 Manager 控制 queue。
- Viewer 每 10 秒 JSON ping／pong、30 秒租約；media 亦支援 JSON ping／pong，但不延長 viewer 租約。viewer 斷線、租約到期、media 中斷、Manager 控制斷線／替換與 Run 終態均清理 live，送精確 viewerId 的 live.stop；不更動 Run 結果或重跑任務。
- `Engine` 新增有界短控制命令 queue，只串行寫 live.start／stop，保持原控制 writer；所有 LiveHub lifecycle callback 在 Engine mutex 釋放後執行。取消 queued Run 的終態也清理 live。媒體資料與影像例外不進原控制 handler。
- `WHIPPET_LIVE_ICE_SERVERS` 解析 JSON RTCIceServer 陣列，預設 []，提供 viewer 與 live.start；錯誤只回固定配置訊息，不印 credentials。主程式啟動 LiveHub lease/status sweep，新 live WS 不繼承原 HTTP 30 秒 request timeout。
- 不新增 DB migration 或 WebRTC 套件；Server 只轉 signaling／JPEG，真 video track 由 Runtime／瀏覽器實作。

**實際檢查**：`go test ./internal/server ./internal/gateway -count=1` 通過（0.429s／0.349s）；涵蓋 busy、錯誤 attempt／viewer／Manager epoch、viewer lease 與 media ping、最新 JPEG 覆蓋、舊 session 不會停止新 viewer、terminal 清理、控制綁定、ICE 錯誤不洩露 credentials、Origin 含 port、media token 與長連線 context。一次 GOPROXY=off／GOSUMDB=off 的 linux/arm64 靜態 build 通過，file 已核對 ELF aarch64。

**總指揮接續**：Nginx Upgrade／Connection 與 `$http_host` 由 Web owner 串接；若要 TURN，Compose 需轉入專用 WHIPPET_LIVE_ICE_SERVERS（不可挪用 Manager／AI key）。請用已備妥的 Runtime／Web 驗證真 WebRTC、切 JPEG、關閉 viewer 停擷取與 Run 繼續完成、原 PNG 報告。這裡不宣稱 Server 端整合／TURN 已實測。

## 原生報告 PNG 附件增補

**整合已驗證**：總指揮已部署新版 Server。驗收 Run `04152970-718a-4b66-a752-8555224d42c0` 通過並完成發布；Chromium 原生 HTML report 實際載入 3 張 PNG，naturalWidth=1280，image HTTP failures=0、requestfailed=0、CSP 錯誤=0。驗證來源為總指揮回報，本 Agent 沒有重複執行。

依總指揮轉交的 Runtime 最小介面完成，只修改 `services/server/`：

- POST `/api/manager/runs/:runId/artifacts/data/<40位小寫hex>.png` 與 GET `/api/runs/:runId/artifacts/data/<40位小寫hex>.png`。沿用部署 token／X-Attempt-Id 及目前 attempt 綁定；僅 run／validation 可上傳、讀取，author 禁止。
- `005_report_screenshots.sql` 擴充 DB 檔名 CHECK；只允許原生 `data/[0-9a-f]{40}.png`，拒絕大小寫變體、其他長度／副檔名與 traversal。LocalArtifacts 支援對應巢狀 data 目錄，逐層拒絕 symlink；上傳先用標準庫 PNG DecodeConfig 核對格式。
- 單張 10 MiB，每 Run 最多 32 張、PNG 合計 64 MiB。SaveArtifact 在原 Run row lock 下核對配額，排除同檔名後計算，讓相同內容重送不重占名額；附件內容仍以 SHA256 防止覆寫。
- HTTP 回傳 `image/png`、nosniff；report.html 路徑與 HTML 相對 `data/<hash>.png` 保持。storage shim 保留，CSP 只將 img-src 擴為 `'self' data: blob:`，script-src／connect-src／opaque sandbox 不放寬。報告 ETag 更新為 `-storage-png-v1`。
- 一般 Run succeeded 仍只核對 report.html／results.json 兩個名稱，不將 PNG 計入報告數量；M2 發布門檻不變。Runtime 依共同介面先傳圖，再傳報告及 result。

**實際檢查**：`go test ./internal/server -count=1` 通過（0.520s），包含 PNG 名稱／種類／大小與總額邊界、真實暫存 PNG 存取、POST／GET 相對路徑、錯誤格式拒絕、author 禁止及 report CSP／shim 保留。這是 HTTP／檔案／domain 檢查，不宣稱 opaque sandbox 的瀏覽器載圖已驗證。

最終交付 **`/private/tmp/whippet-server-screenshots`**，含 WS 修復與內嵌 migration 005。使用既有 Go 1.23.12 cache、GOPROXY=off／GOSUMDB=off、GOOS=linux／GOARCH=arm64／CGO_ENABLED=0 正式 build 通過；file 確認 statically linked ELF ARM aarch64。production go.mod/go.sum 沒有新增依賴，未安裝套件、讀取 env、執行 Git 或部署服務。

**交接完成**：總指揮已將此 binary 部署並與 Runtime PNG 管線完成整合，真實 Chromium 已確認原生報告相對 PNG 可見，無圖片請求／CSP 錯誤。原 WS 阻塞 Run 亦已復原成功。本 Agent 僅補記驗收結果後 idle，不重跑測試或操作現有服務。

## 長腳本 WebSocket 互通修正

本機驗收 Run `a17ae5b8-41c3-45ec-bc5f-25ba176c043d` 的 4319-byte 腳本因 Server／Manager frame 互通問題卡在 dispatched。本輪僅改 Server，沒有改 Run／attempt 或重建任務。

- 已核對本機 Gorilla 1.5.3：WriteJSON 使用 NextWriter／Encoder，超過 buffer 可能產生多個合法 continuation frames；x/net 0.56.0 JSON.Receive 則對單一 frame 直接解碼，不組合完整 message。較長完整 JSON frame 之後還可能留下空 continuation frame，使下一次 Receive 失敗。
- `peer.Send` 改為先 json.Marshal，再關閉輸出壓縮並呼叫伺服器端 WriteMessage(TextMessage) 單 frame fast path。4096-byte buffer 不調大，2 MiB script 契約保持；既有串行寫入、write deadline 與重連 attempt 去重保持。
- `internal/gateway/websocket_interop_test.go`（wsinterop tag）使用真實 HTTP Upgrade、Gorilla Server 與 x/net JSON.Receive，以 net.Pipe 傳送實際 WebSocket frames，不需要對外 listener。4500-byte ASCII、7000-byte Unicode、2 MiB 含跳脫字元／Unicode，並接續相同 attempt 重送與 heartbeat_ack，皆核對完整 envelope。
- 修正前以上三案例都實際重現 unexpected end of JSON input；修正後 **全部通過**，0.316s。僅使用現有 cache；x/net 透過 `/private/tmp/whippet-wsinterop.mod` 的 local replace 載入既有版本，以 Go 1.27.4 執行 tag 測試，production go.mod/go.sum 未改動。
- `GOPROXY=off GOSUMDB=off GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -mod=readonly -trimpath -o /private/tmp/whippet-server-m3-ws ./cmd/server` **通過**。file 確認為 statically linked ELF ARM aarch64；由總指揮使用既有 image COPY 此 binary 整合，沒有下載或安裝套件。

總指揮已部署並確認原 Run `a17ae5b8-41c3-45ec-bc5f-25ba176c043d` 恢復 running 後 succeeded，沒有建立新 Run。PNG 附件支援是後續獨立增補，不阻擋先交付此 WS binary。

## M3 本輪交付（2026-11-11）

### 必要修復 context 增補

author 輸入新增 optional `validation:{runId,status,error?}`。POST messages 在原 transaction 內，從目前 Draft.validationRunId 對應的同 Test validation Run 讀取固定摘要；error 最多 4000 Unicode 字元。摘要存入既有不可變 author_payload，再透過 AuthorInput／dispatch 送給 Runtime，不讀 HTML 或模型 key，沒有新增 migration。

無 validation 的舊 payload／journal 維持相容，一般 run／validation 的派送不變。新增定向測試涵蓋錯誤長度、序列化後固定快照、optional 欄位／舊快照解碼，以及 author dispatch 帶摘要：兩項測試 **通過**（0.334s）；一次正式 Go build **通過**。Runtime 的 `read_validation_report` 工具與同對話修復整合由總指揮接續。

範圍僅 `services/server/`，沿用 M2。未讀取 `.env`／模型 key、操作 Git、安裝套件、呼叫真實模型或操作 Docker。M2 的 Docker migration／API／UI／queue kill／cancel／reconnect 已由總指揮回報整合通過，紀錄於 `docs/tracking/devlog/m2-integration.md`；本輪不重跑該整合。

### 產物與行為

- `004_conversations_and_author.sql`：每個 Test 唯一 Conversation、持久 Message、同 Test 唯一未完成 author Run、不可變 author 輸入快照、author 回報狀態與附件 allowlist。assistant 訊息以 `(run_id,role)` 去重，沒有新增重複腳本快照表。
- `conversations.go`／`conversations_http.go`：GET conversation 首次建立空對話；POST messages 交易保存 user 訊息與 author Run，核對目前已存 revision、空訊息／16000 Unicode 字元上限與未完成 author。派送快照最多最近 12 則、總 32000 字元，保留完整本輪 user 訊息；完整歷史留在 DB。
- `model.go`／`engine.go`／`postgres.go`：author 走原 FIFO、attempt／journal 重送與取消流程。dispatch 使用 kind author、180000ms、草稿 script 與 author context；一般 run／validation 保持 kind run。Server 不讀取、保存或傳送模型 key。
- `author.go`：succeeded author 核對當前 attempt 的 author.json，驗證檔案大小、SHA256、JSON 與原始 conversation／baseRevision。在同一 transaction 內鎖定 Test／Draft／Run，保存 assistant、可套用 revision、續接 validation 與終態。
- 草稿仍為 baseRevision 時才套用變更並清除舊驗證；人工已修改時不覆蓋、不排驗證，保存候選稿及衝突說明。只提問、沒有 script 的成功結果保留原稿。
- requestValidation 重用 M2 的快照入列函式，固定結果 revision，只建立 queued validation，不占住 author Worker 等待子工作。M2 發布、同 revision 驗證成功、兩份報告與人工確認門檻維持原樣；author 不會自動發布。
- assistant 訊息回傳 baseRevision、appliedRevision?、proposedScript?、validationRunId?；任何生成 script 都保留 proposedScript，即使已套用。baseScript 從 baseRevision JOIN 既有 draft_revisions 取得，重新開啟仍可比較差異。
- author 取消／失敗不套用稿件，錯誤使用固定遮蔽文字。invalid/missing author.json 轉為 failed，不暴露解析或 provider body；原始回報狀態另行記錄，讓 normalized failed／cancelled 也可安全接受相同 result 重送。
- `artifacts.go`／`http.go`／`postgres.go`：author 僅可上傳／讀取 author.json、上限 2 MiB；run／validation 仍只可存取 report.html／results.json、64 MiB。author 成功不要求 Playwright 報告，一般任務成功的兩份報告檢查沒有放寬。
- `drafts.go`：抽出原有保存 revision／建立 validation 的 transaction 內部函式，供 author 重用，沒有改變 M2 optimistic lock 或發布規則。

### 實際檢查

使用既有 Go 1.23.12／模組快取與暫存 GOCACHE，`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`：

1. 修改 Go 檔案已執行 gofmt。
2. `go test ./internal/server -count=1` **通過**，0.391s；包含既有 M2 回歸與新增 author 必要單元測試。
3. 一次 `go build -mod=readonly -trimpath -o /private/tmp/whippet-server-m3 ./cmd/server` **通過**，exit 0。

新增測試：Unicode 訊息／context 預算、本輪訊息保留、成功套用與人工衝突、已套用候選稿仍可比較、無 script／空草稿驗證、取消與失敗錯誤遮蔽、重複結果在任何套用前返回、無效 JSON／附件種類及 2 MiB 限制、author 與 validation 派送格式、HTTP 202／400／409 與重新開啟後的 baseScript／proposedScript 欄位。

測試涵蓋 domain 規則、HTTP／Engine 與暫存檔案；DB 邊界使用替身，沒有宣稱 migration／PostgreSQL transaction／真實模型已驗證。實際 Docker 整合由總指揮執行。

### 總指揮串接

Server 已可 build，套用 migration 004 後可串：建立 conversation → 送訊息 → author 派送 → 上傳 author.json → result succeeded → 讀回 conversation／draft／validation Run。請一併檢查：

- 人工在 author 期間保存新 revision，結果只保留 proposedScript 與 baseScript，不覆蓋／排驗證。
- 重送相同 result，assistant 訊息、revision、validation Run 都只產生一次；normalized failed／cancelled 也可重送原狀態。
- 一般 run 不接受 author.json，author 不接受一般報告；取消／失敗不套用，失敗可用已保存對話重試。
- author.json 與原附件 volume 必須可讀；Server 需與新 Manager／Worker 的 author entrypoint、context payload 及回收後回報流程一起更新。Dispatch JSON 大小需預留草稿與最多 32000 Unicode 字元 context。

本 Agent 等待 Docker 整合回饋；沒有執行模型或跨服務 E2E。

## M2 歷史交付（2026-11-11，總指揮整合已通過）

範圍僅 `services/server/`，沿用 M1。沒有安裝套件、操作 Git、讀取 env 機密、啟動其他 Agent 或操作 Docker／現有服務；沒有進入 M3。Commit 由總指揮於整合測試通過後執行。

### 產物與行為

- `migrations/003_drafts_and_publication.sql`：唯一 Draft、不可變 revision、validation Run 來源、Version 驗證關聯；DB trigger 防止修改已發布版本、revision 與歷史 Run 腳本／設定快照。既有 M1 版本與 Run 保留。
- `model.go`：Draft／Version 與 v2 Run 欄位；Store 擴充建立 Test、草稿、驗證、發布、版本查詢。
- `drafts.go`：初次草稿 revision 1；Test row lock 串行化初始化與寫入，主鍵保證每個 Test 一份草稿。過期 revision 回 409，實際變更才遞增並清除驗證資格。
- `drafts.go`：validation 固定 revision、腳本、SHA256、timeout；與正式 Run 共用 FIFO。發布 transaction 鎖定目前草稿及驗證，核對同一 revision／內容／設定、succeeded、使用者確認、目前 attempt 的報告索引與可讀的實體非空檔案。缺報告或檔案大小不符拒絕發布。同一次驗證重複確認回原版本。
- `drafts_http.go`／`http.go`：依 v2 新增建立測試、GET／PUT Draft、validate、publish、versions；處理 invalid JSON、缺確認、過期 revision，維持統一錯誤格式。
- `postgres.go`：Run 增加 kind／draftRevision／versionId，正式執行仍只取已發布不可變版本。原取消、事件／結果去重及 SQL FIFO／slot 保留邏輯沿用。
- `engine.go`：正整數 capacity；每次連線先 heartbeat 對帳。active 可補回遺失 ACK，既有 attempt 不因重連重跑；取消未 ACK 的 attempt 時先重送相同 dispatch 再 cancel。
- `engine.go`：對帳與持久化成功後，經既有串行 Peer 寫入 `heartbeat_ack`，payload `{}`、省略 runId／attemptId；寫入失敗關閉連線並暫停派送，供 Runtime refresh read deadline。
- `cmd/server/main.go`：設定 Postgres.Artifacts，讓發布門檻在交易內讀取實體報告。
- `README.md`：更新 v2 HTTP、草稿 revision／發布門檻、heartbeat_ack 與取消重送規則。

### 實際驗證

使用既有配對的 Go 1.23.12、既有模組快取，設定 `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local` 與暫存 GOCACHE：

1. `go test ./internal/server -count=1` **通過**，0.437s。
2. `go build -mod=readonly -trimpath -o /private/tmp/whippet-server-m2 ./cmd/server` **通過**，exit 0。
3. 修改的 Go 檔案已執行 gofmt。

新增必要測試涵蓋：舊 revision 成功不可發布、過期 UI revision、其他 Test／非 validation Run、錯誤腳本／hash／timeout、失敗／尚未完成／取消驗證、缺報告、缺使用者確認；真實暫存檔案核對可讀性／非空／大小；HTTP 400／409；capacity=2 的 FIFO 與回收前保留名額；遺失 dispatch 後取消維持同 attempt；heartbeat_ack 格式與 ACK 失敗暫停。M1 的既有流程測試同步納入 heartbeat 對帳。

這些是 domain／HTTP／Engine 與真實暫存附件檢查，DB 邊界使用測試替身或直接驗證發布規則。**未宣稱 PostgreSQL migration／交易或跨服務 M2 smoke 已驗證**；依總指揮指示不等待本機 DB，也不擴大環境測試。

### 總指揮串接

Server 已可 build。請於 Docker 套用 migration 003，使用既有環境進行實際 API smoke：建立未發布 Test → GET 草稿 → 儲存 → validate → 報告就緒 → confirmed publish → 正式 Run；並核對修改後舊 revision 發布回 409、缺報告不可發布、版本與既有 Run 不被草稿改動。Runtime 的 heartbeat_ack／cancel 與多 Worker 可靠性情境一併整合。

M1 種子 Version 的 validationRunId 保留 null；新版本才有驗證來源。發布端必須掛入原附件 volume，否則即使 DB 有報告索引也會回 409。完整主流程與 migration smoke 通過後，再由總指揮標記 M2 完成與 commit。

## M1 歷史交付

M1 已由總指揮與 Muse 驗收完成。Server 依賴、正式 build、四個服務映像與 Compose 串接已就緒，真實成功／失敗執行及報告呈現均已確認。

本輪授權寫入 `services/server/`、`deploy/`、`docs/guides/` 與根目錄 `README.md`。Compose 啟動、修正版 Server 部署與瀏覽器 E2E 由總指揮／Muse 執行；本 Agent 未執行 Git、啟動其他 Agent 或修改共同契約／追蹤文件。本次只更新驗收文件，沒有重跑測試或操作服務。

## M1 驗收結果

驗證來源：總指揮回報 Muse 瀏覽器續測 **exit 0**（2026-11-11）。

| 情境 | Run ID | 實際狀態與報告 |
| --- | --- | --- |
| 真實成功 | `227c0395-8575-4dac-ae57-fad845b7a78b` | succeeded；HTML report 正常顯示 Passed 1／Failed 0 |
| 刻意斷言失敗 | `8d006958-875a-472f-a573-1ab0fa79eecf` | failed；HTML report 正常顯示 Passed 0／Failed 1 |

成功報告沿用既有 Run 續測，不需重跑 Playwright。storage shim 已解決白頁，並保留 opaque sandbox 與禁止外部連線的 CSP。M1 驗收不代表 M2 的完整取消／對帳／可靠性情境已完成。

## 報告白頁修正（2026-11-11）

真實成功 Run 的報告曾因 opaque sandbox 禁止 localStorage，導致 Playwright 初始化失敗。使用總指揮保存的 `/private/tmp/whippet-report-before.html`，確認原報告的 Settings 以 `localStorage[key]` 讀寫設定；此問題現已修正並通過 Muse 瀏覽器續測。

- `internal/server/report-storage.js`：在 storage getter 拋錯時，提供本頁專用的記憶體 storage；支援報告使用的屬性讀寫及基本 Storage 方法，local/session 各自獨立，重新整理不保留資料。
- `internal/server/report.go`／`http.go`：HTTP 回應在原 `<head>` 中、原 script 前注入 shim，保留 DOCTYPE 與原始附件，不變更已保存檔案／SHA256。回應 ETag 加上 `-storage-v1`，避免重用舊白頁表示。
- CSP 仍為 `sandbox allow-scripts`，沒有加入 `allow-same-origin`；`connect-src 'none'` 與原有隔離限制保持不變。沒有擴大外部連線權限。
- 針對本次缺陷新增 `report-storage.test.cjs`；先以會拋出 sandbox storage 錯誤的 getter 重現失敗，再加入 shim，兩項相容性檢查通過（Node vm，非瀏覽器 E2E）。
- Go 1.23.12 的 `go build -mod=readonly -trimpath -o /private/tmp/whippet-server-m1 ./cmd/server` 已通過，exit 0。
- **部署與續測完成**：總指揮已 rebuild／deploy 修正版 Server，Muse 已確認成功／失敗報告均正常顯示。本 Agent 沒有重複 Docker build、部署或 Playwright Test。

報告呈現的注入使用既有 64 MiB 附件上限約束記憶體緩衝；不引入新依賴或報告服務。

## 本輪整合增補

- 新增並保留 `services/server/go.sum`；下載固定版本的兩個 Go 模組，Dockerfile 改為複製 lockfile 並以 `-mod=readonly` build。
- 增加 `whippet-server healthcheck`，供 distroless 容器直接檢查 `/readyz`，不需要 shell／curl。
- `deploy/compose.server.yml`：PostgreSQL 16.11、Server、真實 API Web，DB 與 Server named volumes；Web／Server 預設只發布 `127.0.0.1:18080`／`127.0.0.1:18081`。
- `deploy/compose.runner.yml`：獨立 Manager、Docker socket、相同主機／容器絕對 WORK_DIR；Worker 為 build profile 的映像目標，沒有加入常駐啟動或 Manager depends_on。
- `deploy/compose.runner.local.yml`：同 daemon 時共用 `whippet-m1-control` 網路，Manager 直接以 `http://server:8080` 連線，沒有透過公開埠。
- `deploy/init-local.sh`、`.env.example`、`.gitignore`：產生隨機部署 token／DB 密碼、偵測本機 Unix Docker socket，建立權限 600 的 `.env` 與持久化 `deploy/.local/runner/`；既有設定不覆寫，secret 未輸出。
- 根目錄 README 與 `docs/guides/local-m1.md` 已提供精確 config／build／up／logs／down 指令、埠設定、持久化、獨立 runner 邊界及 Muse 驗收項目。

## 產物

| 路徑 | 內容 |
| --- | --- |
| `go.mod`、`Dockerfile`、`.dockerignore` | Go 1.23、固定依賴宣告、靜態 binary 與 nonroot 映像 |
| `cmd/server/main.go` | 環境設定、DB 連線、啟動 migration、HTTP／排程、關閉流程 |
| `migrations/001_initial.sql` | Workspace、Test／不可變版本、Run 佇列、Manager、事件、附件 schema |
| `migrations/002_seed.sql` | 一個預設 Workspace、成功／刻意斷言失敗兩個本地 HTML Test |
| `migrations/embed.go` | 內嵌 migration |
| `internal/server/postgres.go` | 交易 migration、列表詳情、Run 腳本快照、FIFO claim、結果／事件去重、名額回收 |
| `internal/server/http.go` | 契約全部 M1 HTTP API、取消、附件上傳／讀取、healthz／readyz |
| `internal/server/engine.go` | 單一 Manager session、attempt 保持、dispatch／cancel 重送、heartbeat 對帳接縫 |
| `internal/gateway/websocket.go` | bearer token 後的 WS upgrade、hello、訊息限制與逾時 |
| `internal/server/artifacts.go` | 64 MiB 上限、檔名／UUID 白名單、原子寫檔、SHA256 key、symlink／traversal 防護 |
| `internal/server/*_test.go` | 核心流程檢查與 opt-in PostgreSQL 整合測試 |
| `README.md` | 啟動方式、環境變數、API、種子 ID、Manager／附件串接規則 |

## 實際檢查

1. 所有 Go 原始碼已執行 `gofmt`；最後 `gofmt -l cmd/server internal migrations` 沒有輸出。
2. 使用本機既有的 `/Users/kywk/.local/share/mise/installs/go/1.23.12/bin/go`，並設定 `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOCACHE=/private/tmp/whippet-server-go123-cache`：
   - `go test ./internal/server` **通過**，0.414s，包含四個核心測試。
   - 調整未知 active 立即暫停派送、清理重送記錄與事件去重後，只重跑兩個受影響流程：`go test ./internal/server -run 'TestRunFlowWaitsForReclaimedSlot|TestReconnectPreservesAttemptAndCancellation' -count=1` **通過**，0.442s。
3. 核心檢查實際使用 HTTP handler、Engine 與暫存目錄中的真實附件；儲存層是測試替身，WS 是記錄訊息的 Peer。涵蓋建立 Run、FIFO、ACK、事件重送、拒絕舊 attempt、結果重送、報告端點／CSP、回收前保留名額、重連保持 attempt、取消、token 與路徑限制。
4. 初輪正式 build 曾受阻於缺少 Go 模組；本輪獲准下載後已解除，`go.sum` 現含兩個模組及其 go.mod 的四筆校驗碼。
5. 初次預設 `go test` 另遇環境問題：PATH 的 Go 為 1.27.4，但 GOROOT 指向 mise Go 1.23.12，產生 compiler version mismatch；改用既有、配對的絕對路徑後核心檢查通過，未修改全域環境。
6. 唯讀對照目前 Runtime 程式：hello／heartbeat、dispatch、事件、raw artifact upload、result 格式一致；Manager 先回收容器，再上傳／回報並從 active 移除。
7. **Server 正式 build 通過**：使用配對的 Go 1.23.12、`GOROOT` 與暫存 GOCACHE，執行 `GOPROXY=off go build -mod=readonly -trimpath -o /private/tmp/whippet-server-m1 ./cmd/server`，exit 0。
8. **本機設定與腳本通過**：實際執行 `sh deploy/init-local.sh`，建立 `.env` 與 WORK_DIR；確認 `.env` 權限 600。`sh -n deploy/init-local.sh` exit 0。
9. **Compose config 通過**：以下命令均 exit 0，沒有輸出展開後的 secret：
   - `docker compose --env-file deploy/.env -f deploy/compose.server.yml config --quiet`
   - `docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml --profile build config --quiet`
10. **Server／Web Docker build 通過**：`docker compose --env-file deploy/.env -f deploy/compose.server.yml build server web` exit 0。映像為 `whippet-server:m1`、`whippet-web:m1`；Web build 內實際通過 TypeScript `tsc --noEmit` 與 Vite production build。
11. **Manager／Worker 交接**：本輪早先已送出一次 Manager build（session 45988），後續依總指揮指示不重試；總指揮回報四個映像皆已完成。Worker build 由總指揮執行，本 Agent 沒有重建 Worker。
12. **M1 E2E 已驗收**：總指揮／Muse 完成真實成功、斷言失敗與修正版報告的瀏覽器續測，exit 0；具體 Run 與 Passed／Failed 計數見本文件驗收結果。

驗證分工：本 Agent 完成上述核心檢查與建置；總指揮／Muse 完成 Compose 啟動及 Server → Manager → Worker → 報告的實際主流程。獨立的 `postgres_integration_test.go` 仍未執行，完整取消／重連可靠性情境也尚未驗證；這些不與已通過的 M1 E2E 混稱。

## M1 交接時的 M2 限制（歷史紀錄，本輪變更見上方）

- 已補：固定 runId／attemptId 重送、ACK、eventId 持久化去重、同終態安全重送、拒絕終態變更與舊 attempt、queued／執行中取消入口。
- result 不直接釋放名額；終態且 heartbeat.active 已移除才放行下一筆。Manager 斷線不自動重派既有 Run。
- Server 支援 `POST /api/runs/:id/cancel` 與 WS `cancel`，但目前 Runtime 只處理 dispatch；執行中取消尚未端到端可用。queued 取消可直接完成。
- 尚無完整 reconcile／Server result receipt ACK。已 ACK／running 的 attempt 若失去結果，保留名額等待 Manager journal 補送；沒有自動判定 interrupted、強制釋放或重跑。
- 草稿、revision、驗證／發佈 API、對話與即時監看未納入本次範圍。
- 單一 Server／單一固定 Manager ID；不支援多 Server 排程協調或 Manager 管理介面。
- 檔案與 DB 無法共用 transaction；DB 登記失敗可能留下無引用檔案，尚無 GC。附件 volume 必須持久化並由 Server OS 使用者獨占寫入。
- 僅支援兩個 v1 附件名稱；真實登入、CORS、外部報告資產、trace／截圖端點未提供。

## 串接事項

1. **現有環境**：保留 `.env`、持久 WORK_DIR、DB／附件 volumes 與目前運作的服務；M1 已驗收，不重新 build、啟動或重跑測試。
2. **Web owner**：依契約直接使用 `/api`；種子 Workspace 為 `00000000-0000-4000-8000-000000000001`，成功／失敗 Test 分別為 `10000000-0000-4000-8000-000000000001`／`10000000-0000-4000-8000-000000000002`。輪詢 Run，`reportUrl` 出現後可開啟報告。
3. **Runtime owner**：每 10～20 秒發 heartbeat，閒置亦送 active:[]；容器回收後才移除 active。成功 result 前兩個附件均須上傳。請接入 `cancel`（payload:{}，既有 runId／attemptId）才能完成執行中取消；終態 journal 在重連時補送。
4. **契約 owner**：若保留 M2 取消入口，請將上述 HTTP cancel／WS cancel payload 補入共同契約；本 Agent 沒有跨範圍修改 contracts。
5. **M1 驗收**：成功／刻意失敗與 HTML report 均已確認完成；後續 M2 再驗證超額排隊、回收、取消與重連。
6. **總指揮**：唯一任務進度來源 `docs/tracking/implementation.md` 由總指揮維護；M1 已驗收，M2 尚待派工。本 Agent 不自行展開下一階段。

上述為 M1 當時交接；M2 本輪產物與待整合項目以本文件開頭為準。既有服務未由本 Agent 操作。
