# ADM-4 整合驗收

使用合併版的正式 Web、Server、Manager 與 Runtime owner 備妥的 Worker 映像。A1–A5 的請求格式、狀態與錯誤碼依 v14。[v14 契約](../../contracts/mvp-v14.md)

## 啟動

在暫存目錄建置 Server、Manager 與 Web。將 Server／Manager 執行檔以及含 `dist`、`node_modules` 的正式 Web 建置交給 `adm4-local.py`。建立 `$ADM_EVIDENCE` 作為父目錄，每個 `--out` 使用新的子目錄。程式每次啟動獨立 PostgreSQL、連接埠、Manager ID 與 journal，結束時清理該次的容器和服務。安裝 Python Playwright，以 `--browser-executable` 指定本機 Chrome，或使用 Playwright 的 Chromium。

~~~sh
python scripts/test/adm4-local.py \
  --server "$ADM_SERVER" --web-root "$ADM_WEB_ROOT" --out "$ADM_EVIDENCE/a1" --tls

python scripts/test/adm4-local.py \
  --server "$ADM_SERVER" --web-root "$ADM_WEB_ROOT" --out "$ADM_EVIDENCE/a2" \
  --live-a2 --tls --manager "$ADM_MANAGER" --worker-image whippet-worker:adm-runtime-local-20261126
~~~

A2 與 A3 在獨立資料庫預置已發佈的測試腳本與 Workspace 範圍。Run、報告、租約與資源回收從正式入口產生。A3 導覽的合成測試頁在獨立 Docker 容器。

A3 與代管作者驗收需要與 Docker 架構相符的 Linux Server 執行檔。以 `CGO_ENABLED=0 GOOS=linux go build` 建置 `services/server/cmd/server`。Docker 內的 HTTPS 分類服務僅處理驗收提示詞，信任的憑證只掛載到本次隔離環境。代管 Worker 使用 Runtime 提供的合成供應商回應，執行實際容器、探測、Key 傳遞和作者工作。[Runtime 合成回應](../../runtimes/worker/testdata/adm14/provider.mjs)

~~~sh
python scripts/test/adm4-local.py \
  --server "$ADM_SERVER_LINUX" --server-in-docker --web-root "$ADM_WEB_ROOT" \
  --out "$ADM_EVIDENCE/a3" --live-a3 --tls --fixture-profiles \
  --manager "$ADM_MANAGER" --worker-image whippet-worker:adm-runtime-local-20261126

for adm_case in full boundary revoked proposal; do
  python scripts/test/adm4-local.py \
    --server "$ADM_SERVER_LINUX" --server-in-docker --web-root "$ADM_WEB_ROOT" \
    --out "$ADM_EVIDENCE/ai-$adm_case" --live-ai --managed-case "$adm_case" --tls --fixture-profiles \
    --manager "$ADM_MANAGER" --worker-image whippet-worker:adm14-synthetic-provider-20261126
done
~~~

`full` 驗證真 Web 的建立、輪替和三種代管作者及正式驗證。`boundary` 保持真 Manager 與 Worker，使用獨立 HTTPS 轉送器在同一有效 attempt 查核 Key、工具和取消閘門。`revoked` 可單獨重驗已選用 Agent 撤銷模型 Key 後的 Web 入列錯誤碼。`proposal` 驗證代管及自管設定預填、人工確認、憑證過濾、供應商失敗和提案返回前的 Workspace 狀態檢查。[自管接單腳本](adm5-mcp-claim.mjs)

## 驗收情境

| 情境 | 實際入口與成功條件 |
| --- | --- |
| A1 角色與撤權 | 從正式 Web 以四種身分登入。Site Manager 建立兩個 Workspace、調整成員並撤權，QA 隨即失去其中一個 Workspace 的直接存取。確認 Site Manager 呼叫舊全站角色 API 或 AI 管理 API 回 `403`，唯一 Super Admin 降權回 `409 last_super_admin`。 |
| A2 封存與回收 | 先產生真實 HTML 報告。以一筆執行中 Run、兩筆排隊 Run 和一個互動租約開始封存，分別驗證等待和取消。確認新 Run、領單與租約遭拒，封存要等名額及租約回收，還原後可執行新 Run 且原報告可讀。 |
| A3 資源與調配 | 在 AI Manager 同時看到受管 Manager、MCP 互動與接單活動，使用同 Manager ID 和 journal 重連後核對資源數量。讓管理端暫停或改派與 Manager 派工／MCP claim 競爭，核對回應、Workspace、同一 Run 的 attempt 與租約。 |
| A4 建立與 Key | 由 Super Admin 在 AI Manager 建立兩個各自使用合成 Key 的 Agent。錯誤 Key 顯示 `provider_auth_failed`，輪替並重試後為 `ready`，另一個 Agent 可繼續執行。相同建立請求重送保留 Agent 和配置 ID，沿用請求 ID 改 Key 回 `409`。在同一有效 attempt 驗證跨 Agent 解析回 `404 not_found`、舊版本回 `409 credential_unavailable`。掃描一般 API、對話、日誌、journal 與報告中的合成 Key。 |
| A5 入口與隔離 | 以 Builtin、Vercel、Pi 的真 Worker 執行作者工作。合成供應商回覆文字。用同次 Web 草稿另存的離線腳本驗證正式 Playwright 報告，確認缺少人工確認或有效摘要時拒絕發佈。驗證未授權 Vercel 工具及撤銷 Key 遭拒、Pi 在 Manager 暫停時排隊且封存取消可回收。A3 涵蓋同 Workspace 瀏覽器操作、跨 Workspace 拒絕與回收。自管 Bridge 腳本涵蓋登錄、探測、接單、工具、提交與正式驗證。 |

## 證據

主報告為 `adm1-ui-smoke.json`、`adm4-a2-live.json`、`adm4-a3-live.json` 與各模式的 `adm4-ai-*.json`。`runtime.json` 記錄 Worker digest，`run-attempts.json`、`managed-bindings.json` 與 `managed-provisions.json` 記錄工作和配置識別，`keys-scan.json` 列出掃描檔案與命中結果。[v14 證據欄位](../../contracts/mvp-v14.md#a5-mcp-回連與入口驗證)
