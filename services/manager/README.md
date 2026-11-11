# Whippet Manager（M1／M2）

Go Manager 主動連線 Server，每個一次性 Docker Worker 執行一份完整 TypeScript spec，所有 run／validation 共用 MAX_WORKERS 上限。WS／HTTP 欄位依 [MVP v1](../../contracts/mvp-v1.md) 與 [M2 契約](../../contracts/mvp-v2.md)。本目錄只負責 runtime；FIFO 排隊、Server、種子測試及 Compose 由各自 owner 維護。

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

`runId`、`attemptId`、`messageId` 驗證 UUID 格式。腳本上限 2 MiB，`timeoutMs` 為 1..3600000。附件單檔上限 64 MiB；Server 必須允許相應大小。Manager 不向 Worker 注入部署 token，也不掛入 Docker socket。

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
6. 上傳可取得的 `report.html`、`results.json`，兩者都收到 HTTP 2xx 才保存終態並送 result。缺少報告、manifest 無效、非零退出碼等皆不會回報 succeeded；基礎設施故障可回傳 failed 且沒有報告。
7. 確認容器回收並持久化 `reclaimed=true` 才釋放本機名額、從 heartbeat.active 移除；Run result 仍等可用附件上傳成功才送。Server 維持「terminal 且 absent」才釋放排程名額。最後刪除任務暫存目錄，保留精簡 journal，供重複派送與重連重送終態。

上傳失敗每 3 秒補送，保留原始檔案，不重新執行測試；已回收的容器不再占本機執行名額，Server 排程名額仍等待終態。WS 斷線採 1..15 秒上限退避加 jitter；已執行 Worker 繼續受本機 timeout 控制。Server 必須允許同 attempt／附件名稱冪等補送，並以 attempt 身分去重終態。尚無 result receipt ACK，Manager 在每次重連重送已完成結果，使用相同 terminal `messageId`。

`cancel` envelope 帶匹配的 `runId`／`attemptId`、payload `{}`。Manager 先保存 `cancelRequested=true`，只停止該 attempt 的執行 context，再使用獨立生命週期繼續回收／上傳。回收失敗時保留名額，每 3 秒重試；取消在 collection 期間到達也會合併進最終 cancelled，不能被舊的成功結果覆寫。已完成的 attempt 維持原終態並冪等重送。若 cancel 先於遺失的 dispatch 到達，建立取消紀錄並回收相同名稱容器，之後的遲到 dispatch 不執行。

Manager 重啟會先處理未完成 journal，停止未確認回收的舊容器；有已保存的 collecting 結果就補送附件。尚未保存終態者回報 `failed` 並明示中斷；已保存取消要求者回 cancelled。不猜測成功，也不重跑。契約 result 尚無 `interrupted`；journal 損毀或同一 WORK_DIR 同時被其他程序占用時拒絕啟動。舊 M1 journal 可直接讀取，未記錄 reclaimed 時保守地再確認回收。

## 檢查與邊界

```sh
go test ./...
go build ./cmd/manager
```

測試以假的容器 driver 與記憶體 HTTP transport 驗證去重、回收前不釋放名額、附件順序及拒絕假成功。這些 fixture 不代表真實 Docker／Playwright 已驗證。實際檢查與環境限制見 [DELIVERY.md](DELIVERY.md)。

本次沿用 hello／heartbeat／terminal replay 與 journal 對帳，不新增獨立 reconcile envelope；尚無 journal 淘汰、即時影像或 AI 工具迴圈。任務腳本在容器內執行任意 Node.js 程式；本版用於可信任的 self-hosted 測試，不是公開多租戶沙箱。M2 的真實 Docker 排隊／取消／強制終止與 Server restart 由總指揮做代表整合驗證。
