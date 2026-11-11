# 本機 M1 操作指南

這份指南從 repo 根目錄操作本機 Docker daemon。Web 預設為 `127.0.0.1:18080`，Server 為 `127.0.0.1:18081`；PostgreSQL 僅供容器內使用。這是固定開發 Superadmin 的 M1 流程，沒有真實登入、AI 編輯、草稿發佈或即時監看。

M1 已於 2026-11-11 由總指揮與 Muse 驗收完成，服務保持運作。以下建置與啟動指令供首次設定或日後程式變動使用；目前環境無須為本次文件更新重新啟動或重跑測試。

## 1. 準備本機設定

需要 Docker CLI／daemon、Compose v2 以上及 `openssl`。Linux 與 Mac Docker 都使用 Linux 容器；映像預設依本機 Docker 架構建置，不強制 amd64。

```sh
sh deploy/init-local.sh
```

腳本建立 `deploy/.env`（權限 600）與 `deploy/.local/runner/`，產生各自隨機的 DB 密碼、Manager token，並偵測目前 Docker context 的 Unix socket；不顯示 secret、不覆寫既有 `.env`。若已有設定，直接保留；搬移 repo 或變更 Docker context 後，請調整 `.env` 內的 `WORK_DIR`／`DOCKER_SOCKET_PATH`。

主要設定：

| 變數 | 預設／說明 |
| --- | --- |
| `WEB_PORT`／`SERVER_PORT` | `18080`／`18081`；需要時改成其他未使用埠 |
| `POSTGRES_DB`／`POSTGRES_USER` | `whippet`／`whippet` |
| `POSTGRES_PASSWORD` | 初始化產生的 hex 密碼，會插入 Server 的 DB URL |
| `MANAGER_TOKEN` | Server 與 Manager 共用的隨機部署 token |
| `MANAGER_ID` | `local-runner`；重啟沿用，不可隨意更換 |
| `WORKER_IMAGE` | `whippet-worker:m1`；必須已存在於 Manager 使用的 daemon |
| `WORK_DIR` | repo 下 `deploy/.local/runner` 的實際絕對路徑 |
| `DOCKER_SOCKET_PATH` | 目前 Docker context 的本機 Unix socket |
| `WHIPPET_CONTROL_NETWORK` | `whippet-m1-control`，供本機兩組 Compose 共用 |
| `SERVER_URL` | 獨立 runner 配置使用的可達 HTTP(S) origin；本機 overlay 固定使用 `http://server:8080` |

Manager 持有 Docker 管理能力；Worker 不掛入 socket，也不取得部署 token。`WORK_DIR` 在主機與 Manager 容器內必須是**同一個絕對路徑**：Manager 建立 Worker bind mount 時，daemon 會從主機解析該路徑。本機 overlay 透過 Docker 網路 DNS 連 Server，不依賴 `host.docker.internal` 或 LAN 埠。

## 2. 檢查與建置

設定檢查不啟動容器；使用 `--quiet` 避免將展開後的 secret 輸出到終端：

```sh
docker compose --env-file deploy/.env -f deploy/compose.server.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml --profile build config --quiet
```

首次或程式變動後建置各服務：

```sh
docker compose --env-file deploy/.env -f deploy/compose.server.yml build server web
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build manager
```

Worker 在 `build` profile 內，僅作映像建置目標。若 `whippet-worker:m1` 尚不存在，再執行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build worker
```

已存在的 Worker 映像直接沿用。不要用 `--profile build up` 啟動 Worker；每個實際任務都由 Manager 建立新容器，掛入新的 `/work/input.json`，執行後回收。

Server 使用 `go.mod`／`go.sum` 與 `-mod=readonly` 建置；Web 的 Dockerfile 由 Web owner 維護，預設 `VITE_USE_MOCK=false`、API 基底 `/api`。各服務 build context 均限制於自己的服務目錄。

## 3. 啟動本機服務

```sh
docker compose --env-file deploy/.env -f deploy/compose.server.yml up -d --no-build --wait
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml up -d --no-build manager
```

順序為 PostgreSQL healthy → Server 完成 migrations 且 `/readyz` 通過 → Web 啟動。Manager 另啟動於共用 control network，使用相同 token。單一 Manager、`MAX_WORKERS=1`；第二筆 Run 會排隊。

檢視狀態與日誌：

```sh
docker compose --env-file deploy/.env -f deploy/compose.server.yml ps
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml ps
docker compose --env-file deploy/.env -f deploy/compose.server.yml logs --tail=100 server web
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml logs --tail=100 manager
curl --fail http://localhost:18081/readyz
```

Web 使用 Nginx 將 `/api` 代理至 `server:8080`；瀏覽器不需要 credentialed CORS。Manager 直接連 Server 的 `/api/manager/connect`，不經 Web 代理 WS。

## 4. 已完成的 M1 驗收

以 **http://localhost:18080** 操作：

1. 點擊開發登入，進入預設 Workspace。
2. 選擇「固定頁面：成功範例」，執行後依序看到排隊／執行／收集，最後顯示通過，開啟真實 Playwright HTML report。
3. 選擇「固定頁面：斷言失敗範例」，確認最終顯示失敗與斷言錯誤，仍能開啟已取得的報告。

固定種子 ID：Workspace 為 `00000000-0000-4000-8000-000000000001`；成功／失敗 Test 分別為 `10000000-0000-4000-8000-000000000001`、`10000000-0000-4000-8000-000000000002`。兩者皆使用 `page.setContent`，不呼叫外部網站。

上述成功／失敗主流程已由總指揮指定 Muse 實測。storage shim 修正後，Muse 續測 exit 0：既有成功 Run 的報告正常顯示 Passed 1／Failed 0；失敗 Run 的實際狀態為 failed，報告正常顯示 Passed 0／Failed 1。M1 已驗收，不需重新執行這些測試。Run ID 與實際證據見 [DELIVERY.md](../../services/server/DELIVERY.md)，整體狀態以 [implementation.md](../tracking/implementation.md) 為準。

超額排隊、強制終止、取消與斷線對帳的完整可靠性驗證留待 M2；本次驗收結果不代表已覆蓋這些情境。

## 5. 持久化與停止

| 資料 | 位置 |
| --- | --- |
| Workspace／Test／Run／事件／附件索引 | Server Compose 的 `postgres_data` named volume |
| report.html／results.json | Server Compose 的 `server_data` named volume，容器內 `/data/artifacts` |
| attempt journal、未完成上傳與工作目錄 | 主機 `WORK_DIR`，預設 `deploy/.local/runner/` |
| token、DB 密碼與埠設定 | 本機 `deploy/.env` |

停止時先停 Manager，再停 Server；一般 `down` 保留資料 volumes 與 journal：

```sh
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml down
docker compose --env-file deploy/.env -f deploy/compose.server.yml down
```

需要保留歷史結果時，不要加 `-v`，也不要刪除 `.env`／WORK_DIR。Server DB 與 Manager journal 應一起保留；Server 不會在斷線時猜測舊 Worker 已停止或自動重跑。

## 6. 獨立 runner 配置

`compose.runner.yml` 可單獨用於另一台執行主機；`compose.runner.local.yml` 只用於同一 Docker daemon。另一台主機請設定該主機實際的 Unix socket、絕對 WORK_DIR、已建置的 Worker 映像，以及能透過私有網路到達的 `SERVER_URL`，並沿用 Server token 與穩定 Manager ID。接著使用：

```sh
docker compose --env-file deploy/.env -f deploy/compose.runner.yml up -d --no-build manager
```

本指南的 Server 預設只發布 loopback，不能直接從其他主機存取。跨主機入口、HTTPS/WSS 與私有網路需另行設定；本次沒有部署公開入口或驗證跨主機連線。Mac 工作目錄也必須在 Docker Desktop／OrbStack 可分享範圍內。

## 常見阻塞

- **Socket permission denied／不是 socket**：確認 `DOCKER_SOCKET_PATH` 對應目前 Docker context，daemon 已啟動；本機腳本會在首次初始化時偵測。Compose 不會自動建立缺少的 socket 或 WORK_DIR。
- **Manager 無法讀取 input.json**：確認主機與 Manager 的 WORK_DIR 絕對路徑完全一致，Mac 已允許分享該目錄。
- **Worker image 不存在**：Manager 使用 `--pull=never`；在相同 daemon 事先準備 `WORKER_IMAGE`。
- **401 或 Manager hello rejected**：檢查 Server／Manager token 相同，且 DB 與 runner 仍使用原來的 Manager ID。不要藉由清空 journal 強制重跑結果未知的任務。
- **Run 終態但下一筆仍排隊**：Server 等待 heartbeat 確認容器已回收；正常最多約 10 秒更新。Manager 若仍在回收或上傳，會保留名額。
- **埠已占用**：修改 `.env` 的 WEB_PORT／SERVER_PORT；瀏覽器與 curl 使用修改後的值。本機 Manager 的容器內連線仍為 `http://server:8080`。
- **DB 密碼變更後連線失敗**：PostgreSQL 的 POSTGRES_PASSWORD 僅在空 volume 初始化時套用；既有資料庫不會因變更 `.env` 自動改密碼。
- **報告缺少下載附件／取消無反應**：M1 僅上傳 report.html 與 results.json；完整 trace／截圖、Runtime cancel 指令仍待後續串接。
- **舊版報告因 localStorage 顯示白頁**：此問題已修正並經 Muse 瀏覽器續測通過；舊環境更新 Server 映像後，直接重新開啟原 Run 的報告即可，不必重跑測試。Server 在 sandbox 內提供僅存於本頁的記憶體 storage，報告設定在重新整理後重置，隔離與禁止外部連線的 CSP 維持不變。
