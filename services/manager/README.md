# Whippet Manager（M1／M2／M3）

Go Manager 主動連線 Server，以一次性 Docker Worker 執行 TypeScript spec 或 author 工具迴圈；run／validation／author 共用 MAX_WORKERS 上限。WS／HTTP 欄位依 [MVP v1](../../contracts/mvp-v1.md)、[M2](../../contracts/mvp-v2.md) 與 [M3 契約](../../contracts/mvp-v3.md)。本目錄只負責 runtime；FIFO 排隊、Server、種子測試及 Compose 由各自 owner 維護。

## 設定

| 環境變數 | 用途 |
| --- | --- |
| `SERVER_URL` | 必填，Server 的 HTTP(S) origin，例如 `http://localhost:8080`；不加 `/api`。HTTPS 自動使用 WSS。 |
| `MANAGER_TOKEN` | 必填，與 Server 相同的部署 token；用於 WS 與 raw artifact POST。 |
| `MANAGER_ID` | 必填，穩定且唯一的節點識別；重啟沿用原值。 |
| `WORKER_IMAGE` | 必填，例如 `whippet-worker:m1`；亦支援契約別名 `WHIPPET_WORKER_IMAGE`，兩者不可不同。 |
| `WORK_DIR` | 預設 `./work`，存放 journal 與任務目錄。須持久化，Docker daemon 必須能以相同絕對路徑存取。 |
| `MAX_WORKERS` | 介於 `1`–`64` 的整數，預設 `1`；超出範圍在啟動時拒絕。hello capacity 與本機實際接收上限使用同一值，與 Server gateway 一致；整合範例設 `2`。 |
| `DOCKER_HOST` 等 | 交由 Docker CLI 讀取；只使用本機 Docker daemon，勿設為遠端主機。 |

`runId`、`attemptId`、`messageId` 驗證 UUID 格式。腳本上限 2 MiB，`timeoutMs` 為 1..3600000。報告單檔上限 64 MiB；PNG 每張 10 MiB、每 run 最多 32 張／合計 64 MiB。Server 必須允許相應大小。Manager 不向 Worker 注入部署 token，也不掛入 Docker socket。

## 建置與啟動

下列為整合時的操作方式。Worker 依賴與正式 TypeScript build 已完成，lockfile 已保留；Dockerfile 使用 `npm ci`。Worker 映像由總指揮代跑建置，詳細狀態見 [DELIVERY.md](DELIVERY.md)。本 Agent 不重試相同 Docker build。

從 repo 根目錄建置，build context 各限於服務目錄：

```sh
docker build -t whippet-worker:m1 runtimes/worker
docker build -t whippet-manager:m1 services/manager
```

Manager 需要 Docker CLI、daemon 權限及可信任的 Server CA。原生執行範例（Go >=1.25）：

```sh
cd services/manager
SERVER_URL=http://localhost:8080 \
MANAGER_TOKEN=replace-with-deployment-token \
MANAGER_ID=local-runner-1 \
WORKER_IMAGE=whippet-worker:m1 \
WORK_DIR="$PWD/work" \
MAX_WORKERS=1 \
go run ./cmd/manager
```

容器化執行時，Manager 與主機的工作目錄要掛到**相同絕對路徑**。Docker daemon 解析 bind source 時使用主機路徑，因此只使用 named volume 或改成不同容器內路徑會讓 Worker 讀不到 `input.json`。

```sh
mkdir -p "$PWD/.whippet-work"
docker run --rm --name whippet-manager \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$PWD/.whippet-work,target=$PWD/.whippet-work" \
  -e SERVER_URL=http://host.docker.internal:8080 \
  -e MANAGER_TOKEN=replace-with-deployment-token \
  -e MANAGER_ID=local-runner-1 \
  -e WORKER_IMAGE=whippet-worker:m1 \
  -e "WORK_DIR=$PWD/.whippet-work" \
  -e MAX_WORKERS=1 \
  whippet-manager:m1
```

Linux 如需 `host.docker.internal`，加 `--add-host host.docker.internal:host-gateway`；也可由整合 owner 在 Compose 中設定 Server 可達位址。Mac 的工作目錄須允許 Docker Desktop／OrbStack 分享；socket source 依實際 Docker 環境調整。Worker 映像必須預先存在，Manager 使用 `docker create --pull=never`，不自動下載。

## 任務生命週期

1. 連 `/api/manager/connect`，帶 `Authorization: Bearer ...`，先送 `hello {capacity:MAX_WORKERS}`，每 10 秒送 heartbeat。Server 回 `heartbeat_ack {}`；35 秒未讀到 Server 訊息就關閉連線並重連，執行中的 Worker 不受影響。
2. 收到 dispatch 後，先持久化 journal 才 ACK。相同 attempt 只 ACK／重送既有結果，不重新啟動 Worker；名額忙碌時不 ACK 新 attempt。
3. 寫入 `WORK_DIR/runs/<attemptId>/input.json`，建立帶 run／attempt／manager labels 的容器，將該任務目錄 mount 至 `/work`。
4. 每個容器限制 1 CPU、1 GiB 記憶體、256 PID、256 MiB shm；Playwright 內部 workers=1。stdout／stderr 轉為 WS `event`。
5. Worker 結束後檢查 Docker exit／OOM 狀態，先嘗試 `docker stop` 留 5 秒給 SIGTERM，再強制移除容器，確認回收後才讀輸出。Manager watchdog 為 `timeoutMs + 30 秒`；逾時殺掉 attach 程序後仍會移除真正的容器。OOM、意外退出與停止／回收失敗均不能成為成功。
6. 普通 run／validation 先上傳 `data/<40位小寫hex>.png`，再上傳 `report.html`、`results.json`；全部收到 HTTP 2xx 才保存終態並送 result。檔名、數量、大小、regular file、PNG header／SHA-1 均檢查，拒絕 symlink／traversal；圖片收集失敗時扣住 HTML，避免斷圖。缺少報告、manifest 無效、非零退出碼等皆不會回報 succeeded；基礎設施故障可回傳 failed 且沒有報告。
7. 確認容器回收並持久化 `reclaimed=true` 才釋放本機名額、從 heartbeat.active 移除；Run result 仍等可用附件上傳成功才送。Server 維持「terminal 且 absent」才釋放排程名額。最後刪除任務暫存目錄，保留精簡 journal，供重複派送與重連重送終態。

上傳失敗每 3 秒補送，保留原始檔案，不重新執行測試；已回收的容器不再占本機執行名額，Server 排程名額仍等待終態。WS 斷線採 1..15 秒上限退避加 jitter；已執行 Worker 繼續受本機 timeout 控制。Server 必須允許同 attempt／附件名稱冪等補送，並以 attempt 身分去重終態。尚無 result receipt ACK，Manager 在每次重連重送已完成結果，使用相同 terminal `messageId`。

`cancel` envelope 帶匹配的 `runId`／`attemptId`、payload `{}`。Manager 先保存 `cancelRequested=true`，只停止該 attempt 的執行 context，再使用獨立生命週期繼續回收／上傳。回收失敗時保留名額，每 3 秒重試；取消在 collection 期間到達也會合併進最終 cancelled，不能被舊的成功結果覆寫。已完成的 attempt 維持原終態並冪等重送。若 cancel 先於遺失的 dispatch 到達，建立取消紀錄並回收相同名稱容器，之後的遲到 dispatch 不執行。

Manager 重啟會先處理未完成 journal，停止未確認回收的舊容器；有已保存的 collecting 結果就補送附件。尚未保存終態者回報 `failed` 並明示中斷；已保存取消要求者回 cancelled。不猜測成功，也不重跑。契約 result 尚無 `interrupted`；journal 損毀或同一 WORK_DIR 同時被其他程序占用時拒絕啟動。舊 M1 journal 可直接讀取，未記錄 reclaimed 時保守地再確認回收。

## M3 author 任務

`kind:"author"` 允許空草稿，附 `author:{conversationId,baseRevision,messages,validation?}`；messages 最近最多 12 則、總 32000 字元，timeout 最多 180000 ms。optional validation 是 `{runId,status,error?}` 快照，error 最多 4000 字元；沒有快照也可執行。journal 保存 kind，input 保存草稿／對話／驗證摘要快照；兩者不加入任何 AI 環境設定或 key。author 仍沿用同一套 ACK、名額、cancel、回收、重連與補傳。

Manager 從專用程序環境白名單讀取 `WHIPPET_AI_ENABLED`、`WHIPPET_AI_BASE_URL`、`WHIPPET_AI_MODEL`、`WHIPPET_AI_REASONING_EFFORT`、`OPENCODE_API_KEY`，只傳入 author 容器。Docker create 使用 `--env NAME`，值只存在 CLI 環境，不放在 argv；一般 run 不帶這些 env，也不繼承 key。實際部署 overlay 由總指揮維護，本 Agent 不讀 env 檔案。

author 使用同一 Worker 映像，覆寫 command 為 `node dist/author/main.js`；一般 run 保留 `dist/runner.js`。author 成功只上傳 `author.json`（最多 2 MiB），不要求 Playwright HTML／JSON。Server 依 kind 檢查附件後套用候選稿／保存訊息，`requestValidation` 由 Server 在 author 回收後另排一般 validation。author 程序不執行模型生成的 spec，也不自動發佈。

author 原始 stderr、模型與工具內容不轉成事件。Manager 只接受固定白名單的 `author:model:<1..8>:<started|succeeded|failed>` 與 `author:tool:<1..12>:<固定工具名>:<succeeded|failed>` 進度；不包含參數、DOM 或 key。進度沿用現有 best-effort log event，終態與去重仍以 journal 為準。

## 檢查與邊界

```sh
go test ./...
go build ./cmd/manager
```

測試以假的容器 driver 與記憶體 HTTP transport 驗證去重、回收前不釋放名額、附件順序及拒絕假成功。這些 fixture 不代表真實 Docker／Playwright 已驗證。實際檢查與環境限制見 [DELIVERY.md](DELIVERY.md)。

本次沿用 hello／heartbeat／terminal replay 與 journal 對帳，不新增獨立 reconcile envelope；尚無 journal 淘汰或公開多租戶沙箱。一般測試 spec 在無 AI key 的容器中執行 Node.js；author 只提供固定工具。M3 的真實模型／瀏覽器／Server 套用與續接驗證由總指揮整合，實際狀態見 DELIVERY。

## M4 獨立媒體 bridge

控制 WS 接受 `live.start`／`live.stop` envelope，payload `{viewerId,iceServers?}`；只接受目前執行中的 run／attempt。相同 viewer start 去重；新 viewer 等舊 session 停止後接手，舊 viewer 的 stop 不會取消後來的 session。媒體不寫 journal，也不派送或重跑任務。

Manager 主動開啟 `/api/manager/runs/:runId/live?attemptId=...&viewerId=...` 的獨立 WS，Bearer token 只在 Manager 的 HTTP header。經此通道傳 offer／answer／mode／state 與 JPEG binary，不占用控制 WS。每 10 秒送 ping、Server 回 pong；35 秒 read deadline，3 秒 write deadline。媒體中斷不自動重跑，清除租約讓 viewer 重連；不印 raw error、SDP 或 ICE credentials。

每任務 `/work/live` 是內部檔案接縫：control.json 以原子 rename 寫入，5 秒續租、有效 30 秒；Worker 狀態與最新 frame 每 100 ms 讀取。檔案讀取用 os.Root、regular file／大小限制，state 最大 192 KiB、SDP 最大 128 KiB、JPEG 最大 1 MiB；只接受目前 viewer／mode，過時狀態不轉送。JPEG 只保留最新一張，慢連線不累積佇列。WS 中斷、live.stop 或 Worker 結束會撤銷租約；影像狀態不改 Run result 或名額回收規則。

Worker／helper 不接收 Manager token，不開 Worker 公開埠。TURN 設定由 Server 的 `WHIPPET_LIVE_ICE_SERVERS` 傳入，不在 Manager 新增憑證設定。完整流程見 [Worker README](../../runtimes/worker/README.md) 與 [M4 契約](../../contracts/mvp-v4.md)。本輪 Go build／Linux arm64 交叉編譯通過，TestLive focused race 由總指揮代跑通過；UI／跨網整合狀態見 DELIVERY。
