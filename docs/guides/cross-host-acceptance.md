# 跨主機執行與 TURN 驗收（VAL-3）

A3 以已發佈測試確認 Linux Server 能對 Mac Manager 派工，並透過正式網頁入口開啟同一筆 Run 的報告。A4 沿用該拓樸，使用 Mac Worker 的瀏覽器 session，在正式 LiveView 驗證 TURN 中繼畫面。分別記錄 A3 的 Run 及 A4 的 session。[A3／A4 驗收規格](../requirements/acceptance-reliability/spec.md)

## 驗收環境

| 位置 | 準備 |
| --- | --- |
| Linux／網路 A | Docker 上的 Web、Server、PostgreSQL，以及已授權的 HTTPS 入口。Web、Server 容器只將埠繫結到 Linux loopback。 |
| Mac／網路 B | Manager 使用 Mac 的本機 Docker daemon 建立 Worker。Mac 容器可連 Linux 的 HTTPS／WSS 入口，該入口終止 TLS。 |
| 觀看端 | 以 Chromium 或 Chrome 開啟正式網頁入口。驗 A4 時，觀看端與 Mac Worker 位於不同 NAT 網路，例如觀看端在網路 A、Mac 在網路 B。 |
| TURN | A4 另需已授權的 TURN 服務。觀看端與 Mac Docker 內的 Worker 均能抵達 TURN 的監聽端點與中繼位址／埠。使用可驗證媒體經 TURN 的隔離網路，避免可用的直連路徑優先被 ICE 選中。 |

以兩台主機的 OS／架構、Docker daemon 架構及網路代稱記錄拓樸。從同一份凍結來源準備 Web、Server、Manager 與 Worker，記錄完整 Git commit、來源摘要（如有）及各映像 ID。若採用同源建置入口，沿用其產物識別紀錄。下方指令以兩端同一 commit 的乾淨 checkout 與專用 Docker daemon 為例，建置會使用 Compose 定義的映像標籤。也可預載對應映像後直接啟動。Linux 另須備妥 Compose 指定的 `postgres:16.11-bookworm` 映像。兩端都使用已授權的 Docker context、建置來源和依賴。[WLA-4 建置指南](../../scripts/test/wla4-acceptance.md)

## Linux Server

從 checkout 根目錄操作。將已授權的實際值填入權限為 `0600` 的獨立設定檔，設定其絕對路徑為 `VAL3_SERVER_ENV`。以下為範例，保留獨立專案名稱、網路及資料卷。

~~~dotenv
WHIPPET_PROJECT_NAME=whippet-val3-server
WHIPPET_CONTROL_NETWORK=whippet-val3-control
WEB_PORT=18080
SERVER_PORT=18081
POSTGRES_PASSWORD=replace_with_random_hex
MANAGER_TOKEN=replace_with_shared_manager_token
WHIPPET_ADMIN_TOKEN=replace_with_distinct_admin_key
WHIPPET_PUBLIC_ORIGIN=https://whippet.example.test
WHIPPET_LIVE_ICE_SERVERS=[]
~~~

Server 和 Manager 的 `MANAGER_TOKEN` 必須一致。管理 key 使用另一組值，只交給驗收登入者。`WHIPPET_PUBLIC_ORIGIN` 為瀏覽器使用的完整 HTTPS origin，含非預設埠時一併填入，且無路徑或結尾斜線。

~~~sh
docker compose --env-file "$VAL3_SERVER_ENV" -f deploy/compose.server.yml config --quiet
docker compose --env-file "$VAL3_SERVER_ENV" -f deploy/compose.server.yml build server web
docker compose --env-file "$VAL3_SERVER_ENV" -f deploy/compose.server.yml up -d --no-build --pull never --wait
curl --fail --silent --show-error http://127.0.0.1:18081/readyz
~~~

在已授權的 HTTPS 反向代理保留原始 Host、路徑及 WebSocket Upgrade。`/` 代理至 Web，`/api/` 代理至 Server，涵蓋 Manager 控制、媒體 WSS 及報告上傳。`/mcp` 提供 A4 開啟瀏覽器 session。以下是 Linux 主機上 Nginx `http` 區塊內的範例，依實際 origin、TLS 憑證、loopback 埠和核准的網路入口調整，再以 `nginx -t` 檢查。`/api/` 的上傳上限涵蓋 64 MiB 的執行附件。此範例關閉該站的存取日誌，以免記錄報告的短效授權路徑。[Nginx WebSocket 代理](https://nginx.org/en/docs/http/websocket.html)

~~~nginx
map $http_upgrade $val3_connection {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name whippet.example.test;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/private-key.pem;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_set_header Host $http_host;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:18081;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $val3_connection;
        proxy_read_timeout 120s;
        proxy_buffering off;
        client_max_body_size 64m;
    }

    location = /mcp {
        proxy_pass http://127.0.0.1:18081;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_buffering off;
    }
}
~~~

記下已啟動的 Web、Server 映像 ID。

~~~sh
for val3_service in web server; do
    val3_container=$(docker compose --env-file "$VAL3_SERVER_ENV" -f deploy/compose.server.yml ps -q "$val3_service")
    docker inspect --format "$val3_service {{.Image}}" "$val3_container"
done
~~~

## Mac Manager／Worker

設定 `VAL3_RUNNER_ENV` 指向 Mac 上另一份權限為 `0600` 的設定檔。`SERVER_URL` 使用 HTTPS origin。跨主機啟動只使用 `compose.runner.yml`，以及需要時的私有 CA 覆寫檔。`WORK_DIR` 須為已建立、可由 Mac Docker 分享的絕對路徑。以 `docker context inspect --format '{{.Endpoints.docker.Host}}'` 核對 Mac 本機 Unix socket，將去掉 `unix://` 的路徑填入 `DOCKER_SOCKET_PATH`。

~~~dotenv
WHIPPET_RUNNER_PROJECT_NAME=whippet-val3-runner
SERVER_URL=https://whippet.example.test
MANAGER_TOKEN=replace_with_shared_manager_token
MANAGER_ID=val3-mac
MAX_WORKERS=1
WORKER_IMAGE=whippet-worker:val3-example
WORK_DIR=/absolute/mac/path/whippet-val3-runner
DOCKER_SOCKET_PATH=/absolute/mac/path/docker.sock
~~~

HTTPS 憑證須受觀看端及 Manager 信任。若用私有 CA，在 Mac 另存下方 Compose 覆寫檔，將 `VAL3_CA_FILE` 設為公開 CA PEM 的絕對路徑，在 runner 的 `config` 與 `up` 指令加上 `-f <覆寫檔>`。Mac 主機使用 `curl` 檢查 HTTPS 時可加 `--cacert <公開 CA PEM>`。

~~~yaml
services:
  manager:
    environment:
      SERVER_CA_FILE: /run/whippet/server-ca.pem
    volumes:
      - type: bind
        source: ${VAL3_CA_FILE:?Set the public CA PEM path}
        target: /run/whippet/server-ca.pem
        read_only: true
        bind:
          create_host_path: false
~~~

在 Mac 將 `VAL3_ORIGIN` 設為正式 HTTPS origin，再從 checkout 根目錄執行。Worker 映像需位於同一個 Docker daemon，由 Manager 建立容器。以 `VAL3_WORKER_IMAGE` 指定設定檔中的映像名稱，驗收期間保留該標籤與映像的對應。

~~~sh
curl --fail --silent --show-error "$VAL3_ORIGIN/" -o /dev/null
docker compose --env-file "$VAL3_RUNNER_ENV" -f deploy/compose.runner.yml --profile build config --quiet
docker compose --env-file "$VAL3_RUNNER_ENV" -f deploy/compose.runner.yml build manager worker
docker compose --env-file "$VAL3_RUNNER_ENV" -f deploy/compose.runner.yml up -d --no-build --pull never manager
docker compose --env-file "$VAL3_RUNNER_ENV" -f deploy/compose.runner.yml logs --since 5m manager | grep -F 'Manager connected'

val3_container=$(docker compose --env-file "$VAL3_RUNNER_ENV" -f deploy/compose.runner.yml ps -q manager)
docker inspect --format 'manager {{.Image}}' "$val3_container"
docker image inspect --format 'worker {{.Id}}' "$VAL3_WORKER_IMAGE"
~~~

## A3 跨主機正式執行

1. 在 Mac 先開始收集 Worker 結束事件。將 `VAL3_MANAGER_ID` 設成 runner 的 `MANAGER_ID`，看到該 Run 的 `die` 事件後按 Ctrl+C。輸出依序為 Unix 時間、Run ID、attempt ID、退出碼及映像名稱。[Docker events 指令](https://docs.docker.com/reference/cli/docker/system/events/)

   ~~~sh
   docker events --filter type=container --filter event=die \
       --filter "label=whippet.manager.id=$VAL3_MANAGER_ID" \
       --format '{{.Time}} {{index .Actor.Attributes "whippet.run.id"}} {{index .Actor.Attributes "whippet.attempt.id"}} {{index .Actor.Attributes "exitCode"}} {{index .Actor.Attributes "image"}}'
   ~~~

2. 從 HTTPS 網頁以有測試權限的身分登入，選擇一個可執行、預期成功且已發佈的合成測試。全新資料庫可使用預設 Workspace 的「固定頁面：成功範例」v1。種子測試的來源為舊版腳本，使用前先在 Workspace 設定確認並套用已授權的訪客站台範圍。按「執行正式版本」，從「正式執行歷史」該列的 Run ID 提示或這次送出的 `POST /api/tests/{id}/runs` 回應取得完整 ID。[內建測試](../../services/server/migrations/002_seed.sql) · [訪客站台確認流程](../requirements/workspace-test-accounts/spec.md#訪談與逐站設定)
3. Run 成功後，從同一列按「開啟報告」，確認 Playwright 頁面載入及該測試通過（內建範例為 1 passed）。在 Linux 上以完整 Run ID 設定 `VAL3_RUN_ID`，查詢 Server 的接單時間及 attempt。`acknowledged_at` 由 Manager ACK 或該次 started 事件填入。

   ~~~sh
   docker compose --env-file "$VAL3_SERVER_ENV" -f deploy/compose.server.yml exec -T postgres \
       sh -c 'exec psql -X -q --csv -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
       sh -v run_id="$VAL3_RUN_ID" <<'SQL'
   BEGIN READ ONLY;
   SET LOCAL TIME ZONE 'Asia/Taipei';
   SELECT r.id AS run_id, r.manager_id, r.attempt_id, r.kind, r.version_id, v.version,
          r.status, r.acknowledged_at, r.started_at, r.finished_at
   FROM runs r JOIN test_versions v ON v.id = r.version_id
   WHERE r.id = :'run_id'::uuid;
   COMMIT;
   SQL
   ~~~

通過條件為 Server 顯示指定 Mac Manager 已接單、`kind=run` 且狀態為 `succeeded`，Mac 的 `die` 事件有相同 Run／attempt 且退出碼為 0，並可從該 Run 開啟通過的報告。

## A4 TURN 監看

目前正式 Run 的隔離 Worker 走 JPEG 監看。A4 使用正式的 Workspace 瀏覽器 session，由同一台 Mac Manager 啟動 Worker。依 MCP 指南備妥已套用訪客站台範圍的 Workspace、該 Workspace 的測試 Agent Token 及支援租約 metadata 的授權 MCP 客戶端。[Worker 網路隔離設計](../architecture/design.md#網站與機密邊界) · [MCP 瀏覽器租約](mcp-agent.md#wave-2-匿名瀏覽器租約)

1. 在 Linux 的 `VAL3_SERVER_ENV` 設定已授權的 TURN URI 與專用媒體帳密。範例使用 UDP，依實際服務更換 URI、協定及埠。重新執行 Linux 的 `up` 指令並確認 `/readyz`，待 Mac Manager 重新連線，再登入 Web。

   ~~~dotenv
   WHIPPET_LIVE_ICE_SERVERS='[{"urls":["turn:turn.example.test:3478?transport=udp"],"username":"replace_with_media_user","credential":"replace_with_media_password"}]'
   ~~~

2. 將 45 秒計數案例的 `const html` 模板字串內容另存為 `val3-clock.html`，放到已授權的訪客測試站。確認該 origin 已套用至 Workspace，且 Mac Worker Chromium 可開啟。[45 秒監看案例](../../scripts/test/fixtures/m4-live.spec.ts)
3. 在同一個觀看瀏覽器並排開啟正式 Web 與 `chrome://webrtc-internals`，保持 Web 頁可見。用授權的 MCP 客戶端呼叫 `browser_session_open({requestId})`（新 UUID），需要時以 `browser_session_status({sessionId,leaseId})` 等到 `state=ready`。在 Web 的「Workspace 設定」→「正式設定與能力」找到「瀏覽器 session」，對同一個 session 按「開始監看」。再呼叫 `browser_navigate({url})` 打開計數頁，在 `params._meta.whippet` 送同一個 `sessionId`、`leaseId` 與新的 `callId`。核對「唯讀監看」顯示同一 session 及「監看中：WebRTC」。[瀏覽器 session 監看](mcp-agent.md#wave7-登入與監看) · [Chromium 的 WebRTC 診斷操作](https://webrtc.org/support/bug-reporting)
4. 從 `webrtc-internals` 選擇本次開始監看時由該頁建立、目前連線中的 PeerConnection。在 `Stats Tables` 展開 `kind=video` 的 `inbound-rtp`，經 `transportId` 找到所用 transport，再沿 `selectedCandidatePairId` 找該配對。從配對的 `localCandidateId` 與 `remoteCandidateId` 查各自的 `candidateType`。在同一連線、同一視訊串流至少取兩次相隔數秒的樣本，每次記錄時間、選中配對及兩端類型、`framesReceived`、`framesDecoded` 和畫面計數。[Chrome 統計表實作](https://github.com/chromium/chromium/blob/main/content/browser/webrtc/resources/webrtc_internals.js) · [WebRTC 統計欄位](https://www.w3.org/TR/webrtc-stats/)
5. 結束取樣後關閉監看，再呼叫 `browser_session_close({sessionId,leaseId})` 結束本次租約。以 `browser_session_status` 確認 `reclaimed=true`。

通過條件為採樣區間的選中配對至少一端為 `relay`，相同視訊串流的接收及解碼影格數均增加，且可見畫面持續更新。若取樣期間重連、切換配對或掉到 JPEG，重新取得一段連續觀測。只有蒐集到 relay 候選、選中直連、或只看到 JPEG 時，記錄實際現象及缺少的中繼證據。A3 的結果可獨立確認。

## 證據紀錄

| 欄位 | 填寫內容 |
| --- | --- |
| 共用 | 驗收時間與時區、完整 Git commit／來源摘要、Web／Server／Manager／Worker 映像 ID、主機與網路代稱、瀏覽器版本。 |
| A3 | 通過／失敗／未執行及原因、已發佈測試版本、Run／attempt ID、Manager 代稱、接單時間、Worker 結束時間與退出碼、同筆 UI 報告開啟結果。 |
| A4 | 通過／失敗／未執行及原因、A3 Run ID 與本次 session／lease 識別、TURN 協定、取樣起訖、選中配對代稱、兩端候選類型、接收及解碼影格起訖與增量、畫面更新結果。 |
| 重跑及缺項 | 本指南的操作段落、使用的版本／設定差異、去識別化證據連結。缺 Linux 或 Mac 跨網路拓樸時記於 A3 與 A4，缺 TURN 或觀看端統計時記於 A4。 |

分享證據時保留驗收 Run／attempt ID 供核對，將內部主機、網路位址與配對 ID 換成代稱。報告證據使用當次 Run 的開啟結果與裁切過的畫面。原始 WebRTC dump、SDP、完整報告授權 URL、設定檔、Cookie 與各種憑證留在驗收環境內。
