# WLA-4 本機黑箱驗收

使用同一份整合版原始碼建置 Web、Server、Manager 與 Worker。`w1` 驗訪客設定，需整合 WLA-1 的三端。`final` 另驗 WLA-2、WLA-3，應在這兩波整合後執行。驗收條件依 [v15 契約](../../contracts/mvp-v15.md)及 [A1–A6](../../docs/requirements/workspace-test-accounts/spec.md#驗收情境)。

## 準備

本機需有 Docker、Node、Go、OpenSSL、Python Playwright 及 Chromium。使用已有的 `postgres:16`（或透過 `--postgres-image` 指定本機映像）。`WLA_LINUX_GOARCH` 依 Docker 節點使用 `arm64` 或 `amd64`。以下從整合 checkout 根目錄執行，將建置與驗收產物放在暫存目錄。

~~~sh
WLA_BUILD=$(mktemp -d /tmp/whippet-wla4.XXXXXX)
WLA_TAG=$(basename "$WLA_BUILD" | tr '[:upper:]' '[:lower:]')
WLA_LINUX_GOARCH=arm64

(cd services/server && CGO_ENABLED=0 GOOS=linux GOARCH="$WLA_LINUX_GOARCH" \
  go build -o "$WLA_BUILD/server" ./cmd/server)
(cd services/manager && go build -o "$WLA_BUILD/manager" ./cmd/manager)
git archive HEAD apps/web | tar -x -C "$WLA_BUILD"
npm ci --prefix "$WLA_BUILD/apps/web"
npm run build --prefix "$WLA_BUILD/apps/web"

docker build -f runtimes/worker/Dockerfile -t "whippet-worker:$WLA_TAG" .
docker build --network=none -f scripts/test/wla4-worker.Dockerfile \
  --build-arg WORKER_IMAGE="whippet-worker:$WLA_TAG" -t "whippet-worker:$WLA_TAG-model" .
~~~

測試映像保留正式 Worker，僅用 preload 回應 `.invalid` 的 Responses 呼叫。Go Server 的意圖檢查走隔離網路內的 HTTPS 合成供應商。`adm4-local.py` 每次啟用獨立 PostgreSQL、loopback Web、TLS Server、Manager、Docker bridge 商店及工作目錄，離開時按該次資源名稱與 Manager label 清理。兩個登入目標用不同連接埠形成不同 origin，共用第三個登入 origin 與 `m10-shop` 帳密表單。

## 執行

每次 `--out` 必須是一個尚未存在的目錄。用現有 Chromium 時可加 `--browser-executable`。指令由可執行 Docker 的人員在合併版 checkout 執行。

~~~sh
python3 scripts/test/adm4-local.py \
  --wla w1 --server-in-docker --tls --server "$WLA_BUILD/server" \
  --web-root "$WLA_BUILD/apps/web" --manager "$WLA_BUILD/manager" \
  --worker-image "whippet-worker:$WLA_TAG-model" --out "$WLA_BUILD/w1"

python3 scripts/test/adm4-local.py \
  --wla final --server-in-docker --tls --server "$WLA_BUILD/server" \
  --web-root "$WLA_BUILD/apps/web" --manager "$WLA_BUILD/manager" \
  --worker-image "whippet-worker:$WLA_TAG-model" --out "$WLA_BUILD/final"
~~~

| 情境 | 實際檢查 |
| --- | --- |
| A1 訪客，兩波皆執行 | Web 建 Workspace、送訪談、重開原提案、使用逐站回覆按鈕並套用只測訪客。Server 拒絕未知與缺登入證據的提案，零帳號訪客套用成功。 |
| A2 多站 | 同一合成登入服務供兩個不同 origin 使用。第一站驗過後，第二站的已送出表單仍無法套用。修正成功條件並取得第二站證據後，從 Web 套用。 |
| A3 失敗與重試 | 第二因素提示、錯誤密碼、重開、修正後重試。結果轉送器暫存真 Manager 的成功 frame，等新提案完成失敗驗證後原樣放行，核對新提案仍受阻。 |
| A4 管理 | 管理員修改兩個同角色帳號的用途，QA 寫入遭拒。新任務觀察新用途，輪替一個帳號保留其他證據，草稿期間正式設定繼續有效。 |
| A5 各入口與隔離 | 內建、Vercel、Pi 各驗錯站拒絕、指定帳號及受保護頁面、回報缺項。MCP 互動與接單使用真瀏覽器租約並驗另區帳號拒絕。接單腳本經正式 Worker 驗證，一個帳號建立新訂單，另一帳號登入後讀取回 404。 |
| A6 舊角色 | 只在該次 PostgreSQL 預置 v8 設定與角色 ID，沿舊專用欄位保存測試帳密。以舊 `loginAs` 腳本在重開提案前後驗證，確認缺證據與過期版本遭拒，既有 Run 快照內容可重讀。 |

`wla4-acceptance.json` 記錄各通過項、Run／attempt 識別與失敗訊息，`runtime.json` 記錄測試映像 digest。`keys-scan.json` 掃描落地證據、ZIP 及 Playwright HTML 內嵌報告中的合成帳密標記。合成供應商另外在真模型傳輸接點拒收任何帶標記的模型請求。掃描涵蓋資料與檔案內容，LiveView 影格的視覺遮蔽須另實測。
