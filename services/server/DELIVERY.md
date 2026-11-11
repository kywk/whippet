# Server 交付

時間：2026-11-11 17:19 Asia/Taipei。Owner：Whippet Server／本輪本機部署整合 Agent。

M1 已由總指揮與 Muse 驗收完成。Server 依賴、正式 build、四個服務映像與 Compose 串接已就緒，真實成功／失敗執行及報告呈現均已確認；服務保持運作，M2 待派。

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

## M2 已補與限制

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

本 Agent 等待 M2 派工；既有本機服務保持運作，沒有執行公開服務部署。
