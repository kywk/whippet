# Runtime M1 交付

更新：2026-11-11 17:01（Asia/Taipei）。Owner：runtime 實作 Agent。

狀態：Manager／Worker 程式與設定文件已交付；本輪已安裝 Worker 依賴、保留 lockfile，正式 TypeScript 型別檢查與 build 均通過。Worker Docker build 由總指揮代跑，本 Agent 不重試；單純 E2E 由 Muse 接手。**M1 的真實 Docker／Playwright 端到端驗收尚未完成**，不應將本文件或單元測試標記為整個 M1 完成。所有修改限於 `services/manager/`、`runtimes/worker/`；未修改共同契約、進度文件或其他 Agent 的檔案。

## 產物

| 路徑 | 行為 |
| --- | --- |
| `services/manager/cmd/manager/main.go` | Go 服務入口、環境設定、SIGTERM／SIGINT 關閉。 |
| `services/manager/internal/manager/config.go`、`protocol.go` | camelCase v1 envelope、UUID／輸入範圍檢查、WORKER_IMAGE／WHIPPET_WORKER_IMAGE 別名。 |
| `services/manager/internal/manager/manager.go` | 主動 WS、hello／heartbeat／ACK／event／result、重連、單名額接收與終態重送。 |
| `services/manager/internal/manager/journal.go` | ACK 前持久化、同 attempt 去重、工作目錄程序鎖、重啟時保留結果或中止舊任務。 |
| `services/manager/internal/manager/docker.go` | Docker CLI create／attach／inspect／rm，資源上限、watchdog、回收失敗保留名額。 |
| `services/manager/internal/manager/artifacts.go` | 讀取 Worker manifest、交叉檢查成功證據、受限附件讀取、帶 token／attempt 的 raw HTTP 上傳與補送。 |
| `services/manager/go.mod`、`go.sum` | Go >=1.25，固定 `golang.org/x/net v0.56.0`；使用本機既有模組快取，未下載。 |
| `runtimes/worker/src/runner.ts`、`reporter.ts`、`result.ts` | 真正啟動 Playwright Test Runner、內建 HTML／JSON reporter、NDJSON、timeout／signal 處理及保守成功判定。 |
| `runtimes/worker/examples/*.spec.ts` | `page.setContent` 成功例與刻意斷言失敗例，供整合 smoke 使用。 |
| `runtimes/worker/package-lock.json`、`.gitignore` | npm lockfileVersion 3，固定完整相依樹；排除本機 node_modules／dist／smoke 產物。 |
| 兩目錄的 `Dockerfile`、`.dockerignore`、`README.md` | 映像建置方式、完整設定、相同絕對路徑 bind mount、串接步驟與限制。 |

Worker 映像與套件固定 Playwright 1.64.1。Manager 使用 `--pull=never`，執行時不自動下載映像。只有實際 Playwright 程序、至少一項通過測試、報告及 JSON 統計一致時才回 succeeded；缺少套件／瀏覽器／報告均不會產生假成功或仿製 HTML 報告。

## 實際檢查

1. 已讀 `AGENTS.md`、相關四份 `.agent-rules`、`contracts/mvp-v1.md`、M1 實作／分工計畫及 runtime 架構。
2. `gofmt -w cmd internal` 完成。
3. 以下 Manager 模組檢查通過，包含 Go 編譯及 3 項測試：

   ```sh
   GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
   GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
   GOCACHE=/private/tmp/whippet-manager-go-cache \
   go test -mod=readonly ./...
   ```

   結果：`cmd/manager [no test files]`；`internal/manager ok`。覆蓋重複 dispatch／重載 journal 不重跑、回收前不釋放名額或上傳、完成前附件均已保存、缺報告／斷言失敗不能成功、watchdog 狀態及附件符號連結限制。容器 driver 與 HTTP transport 為測試替身，不宣稱為 Docker 或 Playwright 實測。

4. 使用既有 Node v22.23.4 的 `stripTypeScriptTypes`，對四份 `src/*.ts` 做語法處理，輸出至 `/private/tmp/whippet-worker-check`；四份均成功。再執行 `node --test /private/tmp/whippet-worker-check/result.test.js`，**2 項通過**，檢查成功所需證據及失敗／逾時／取消不會成為成功。這是語法檢查與結果判定測試，**不是 tsc 型別檢查**。

5. 本輪在獲准準備依賴後，於 `runtimes/worker` 執行：

   ```sh
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --ignore-scripts --no-audit --no-fund --cache /private/tmp/whippet-npm-cache --fetch-retries=0 --fetch-timeout=20000
   npm run typecheck
   npm run build
   npm ls --depth=0
   ```

   安裝成功（6 packages），保留 `package-lock.json`；`tsc -p tsconfig.json --noEmit` 與 `tsc -p tsconfig.json` 均 exit=0。確認 `@playwright/test@1.64.1`、`@types/node@22.10.2`、`typescript@5.7.3`。沒有編譯錯誤需修改 runtime 原始碼。`dist/` 已由本機正式 tsc 產生；Dockerfile 會在映像內獨立依 lockfile 執行 `npm ci` 與 build。

6. Dockerfile 已改為 `COPY package.json package-lock.json tsconfig.json ./` 與 `npm ci --include=dev --ignore-scripts --no-audit --no-fund`，再執行 build／prune。沒有重跑單純 E2E 或本輪未變更的 Manager 測試。

## 環境限制與未驗證項目

- 原始 Go 執行環境的 `GOROOT` 指向 mise Go 1.23.12，但 `go` 執行檔是 Homebrew 1.27.4，第一次檢查因 toolchain 不一致失敗。只在檢查指令指定正確 GOROOT 後通過；沒有改動全域環境或安裝工具。
- 最初的本機 WS 測試因沙箱禁止 bind TCP 埠而失敗；已改用不開埠的 orchestration 測試。**WS 握手／斷線重連尚未做 socket 實測**。
- 先前唯讀 Docker 映像查詢遇到 socket 權限限制而略過。本輪已提出 `docker build -t whippet-worker:m1 runtimes/worker`，但請求中止，未取得建置結果；依總指揮最新指示由其代跑，不重試或另外查詢 Docker。
- npm 第一次在沙箱內因 registry DNS 限制失敗，獲准後完成安裝；沒有使用其他專案套件代替依賴，也沒有下載 Chromium 到本機。Docker 基底映像內的瀏覽器由總指揮建置時準備。
- **尚未實測**：真正 Chromium 成功與斷言失敗、HTML 開啟、Docker OOM／強制回收、跨主機附件傳輸、Linux／Mac CPU 架構及完整 Server → Manager → Worker 流程。
- 本輪只安裝已授權的 Worker 專案依賴；未執行 Git、未啟動其他 Agent、未重跑 repo 全量測試。

## 串接事項

1. 整合 owner 依兩份 README 建置映像，令 Manager 與主機的 `WORK_DIR` 使用相同絕對路徑 bind mount；保留 journal，穩定沿用 `MANAGER_ID`。M1 `MAX_WORKERS=1`。
2. Server owner 對齊 `/api/manager/connect` 的 Bearer token、camelCase envelope、UUID run／attempt／message ID、dispatch timeout，以及 raw artifact POST 的 `X-Attempt-Id`。不需要本輪改契約。
3. Server 上傳成功應回 2xx，同 attempt／檔名應可冪等補送。Manager 全部上傳完成才送 terminal result；沒有可用報告的基礎設施失敗仍可回 failed。`Run.reportUrl` 由 Server 指向其公開 `report.html` 附件端點。
4. WS 沒有 terminal receipt ACK；Server 必須容忍重連／重複 dispatch 時，以相同 messageId 重送的 result。Manager 在回收／上傳期間仍將 attempt 列在 heartbeat.active。
5. 使用 `examples/pass.spec.ts`、`examples/fail.spec.ts` 各完成一次真正端到端驗收；後者預期 failed 且有實際 Playwright 報告。成功案例要實際開啟 HTML，不能只檢查 manifest。
6. Worker npm 依賴、lockfile、Dockerfile `npm ci`、正式型別檢查與 build 均已完成；Docker build 結果由總指揮補充，E2E 交 Muse。
7. 總指揮更新 `docs/tracking/implementation.md`；runtime Agent 沒有修改該共享進度檔。

## Compose owner：映像與 bind mount

| 設定 | M1 值／注意事項 |
| --- | --- |
| Worker tag／build context | `whippet-worker:m1`；repo 根目錄執行 `docker build -t whippet-worker:m1 runtimes/worker`。由總指揮代跑，目前本 Agent 尚無結果。 |
| Worker base／npm | `mcr.microsoft.com/playwright:v1.64.1-noble` 與 `@playwright/test@1.64.1` 一致；使用已保存 lockfile 的 `npm ci`，映像內 build 後移除開發依賴。 |
| Manager tag／build context | 建議 `whippet-manager:m1`；context `services/manager`，Dockerfile 是該目錄內的 `Dockerfile`。本 Agent 本輪未建置此映像。 |
| Manager env | `SERVER_URL=http://server:8080`（依 Compose service 名稱）、共同 `MANAGER_TOKEN`、固定 `MANAGER_ID`、`WORKER_IMAGE=whippet-worker:m1`、`MAX_WORKERS=1`。 |
| `WORK_DIR` | **必須是絕對主機路徑，且在 Manager 容器內使用相同絕對路徑。** 例如 host `/Users/kywk/whippet-work` → Manager `/Users/kywk/whippet-work`，env 同值。 |
| 工作目錄 volume | bind `${WORK_DIR}:${WORK_DIR}`；不可只掛 named volume 到任意容器內路徑，因 Docker daemon 解析 Worker mount source 時使用主機路徑。先建立主機目錄；Mac 需允許 Docker 分享該路徑。 |
| Docker socket | 只掛給 Manager，例如 `/var/run/docker.sock:/var/run/docker.sock`；Mac／OrbStack source 依實際環境調整。Worker 不掛 socket。 |
| Worker service | 不必常駐啟動 Compose Worker。Manager 會自行 create 一個任務容器，mount `${WORK_DIR}/runs/<attemptId>` → Worker `/work`。 |
| 映像可見性 | 必須在 Manager 控制的**同一 Docker daemon** 已有 `whippet-worker:m1`；Manager 使用 `--pull=never`。 |

目前固定 smoke 使用 `page.setContent`，不依賴 Worker 與 Server 位於同一 Compose network。後續若測試使用 Compose 內網網址，需另行協調 Worker network；本輪不新增此功能。

## 後續範圍

- M2：Server cancel 指令、完整 reconcile、失聯偵測、併發 >1、journal 保留政策。重啟且終態尚未保存時，M1 以 failed 說明中斷；v1 result 沒有 interrupted，後續由契約 owner 協調。
- M1 附件只有兩個名稱，因此預設關閉 screenshot／trace／video。腳本自行附加的檔案目前不會上傳，HTML 對應下載連結不可用；完整附件支援需擴充契約。
- 上傳或容器回收失敗會保留原任務並重試，不偷偷重跑；需要修復 token、Server 或 Docker 權限後才能恢復 M1 名額。已上傳的任務目錄若刪除失敗會記錄警告；不阻止已確認容器回收後釋放名額。
- AI／author、WebRTC／畫面串流及公開多租戶沙箱不在本次實作內。

互動工作階段保留，等待後續串接或修正指示。
