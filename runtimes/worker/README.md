# Whippet Playwright Worker（M1）

一次性 Node.js／TypeScript Worker，以真正的 Playwright Test Runner 執行完整 spec，輸出內建 HTML／JSON reporter 結果。映像及 `@playwright/test` 同為 **1.64.1**，依 [Playwright Docker 文件](https://playwright.dev/docs/docker) 保持版本一致；HTML／JSON 與自訂 NDJSON reporter 依 [官方 reporter 介面](https://playwright.dev/docs/test-reporters) 設定。

## 輸入與輸出

預設讀取 `/work/input.json`；僅供本機開發時可用 `WHIPPET_WORK_DIR` 改路徑。

```json
{
  "runId": "11111111-1111-4111-8111-111111111111",
  "attemptId": "22222222-2222-4222-8222-222222222222",
  "script": "import { test, expect } from '@playwright/test'; test('local page', async ({ page }) => { await page.setContent('<h1>Whippet</h1>'); await expect(page.getByRole('heading')).toHaveText('Whippet'); });",
  "timeoutMs": 60000
}
```

腳本須自行 import `test`／`expect`，使用 Chromium、workers=1、retries=0；`test.only` 會失敗。Run／attempt 必須為 UUID，腳本上限 2 MiB，timeout 為 1..3600000 毫秒。每次 mount 必須是新目錄且沒有 `output/`，避免使用舊報告。產生的 spec 與設定放在容器暫存目錄，並連結映像既有 node_modules，讓位於 bind mount 外的套件可正確解析。

| 路徑／串流 | 內容 |
| --- | --- |
| `/work/output/report.html` | 由內建 HTML reporter 產生的 `html/index.html` 原樣複製；不產生假報告。 |
| `/work/output/results.json` | Playwright 內建 JSON reporter 原始結果。 |
| `/work/output/result.json` | `{status:"succeeded"|"failed"|"timed_out"|"cancelled",error?}`，原子寫入。 |
| stdout | NDJSON `{kind:"log",message}`，包含測試開始、完成、輸出及錯誤；非結構化 CLI 訊息也會包裝。 |

只有 Playwright exit=0、實際至少一項測試通過、沒有失敗／中斷／全域錯誤，且 HTML 與 JSON 均就緒才會成功。缺依賴、瀏覽器啟動失敗、空測試、全部 skip、斷言失敗及缺報告都不會成功。Worker exit code 為 succeeded=0、failed=1、timed_out=124、cancelled=130；Manager 會再交叉檢查。

Playwright 的 global timeout 為 `timeoutMs`，外層 watchdog 額外留 10 秒寫報告；SIGTERM／SIGINT 會停止子程序群組，5 秒後仍未停止就 SIGKILL。最外層容器回收由 Manager 負責。程序被強制終止或磁碟故障時，可能無法產出完整檔案；Manager 依實際存在的證據處理。

## 建置與手動 smoke

Worker 依賴已安裝，正式型別檢查與 build 已通過。Docker 映像由總指揮代跑建置，本 Agent 不重複執行；映像結果以 [DELIVERY.md](../../services/manager/DELIVERY.md) 及總指揮回報為準。

```sh
docker build -t whippet-worker:m1 runtimes/worker
```

準備一個新工作目錄，將上方 JSON 存成 `input.json`，再執行：

```sh
docker run --rm --init \
  --mount "type=bind,source=$PWD/work-pass,target=/work" \
  --memory=1g --cpus=1 --pids-limit=256 --shm-size=256m \
  whippet-worker:m1
```

可用 [examples/pass.spec.ts](examples/pass.spec.ts) 與 [examples/fail.spec.ts](examples/fail.spec.ts) 分別填入 JSON 的 `script`，每次使用不同目錄及 attemptId。兩者只用 `page.setContent`，沒有外網依賴；後者的斷言刻意失敗，預期 exit=1、`result.status=failed`，仍有真實報告。接著由整合 owner 串 Server → Manager → Worker，確認兩份附件上傳後 Run 才進終態。

開發環境可依 lockfile 準備相依套件，再執行正式檢查；容器映像已包含瀏覽器，安裝 npm 套件時不另外下載瀏覽器：

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

已保留 `package-lock.json`（lockfileVersion 3），固定直接與間接相依套件；Dockerfile 使用 `npm ci --include=dev` 建置，再 prune 開發依賴。本次 `npm run typecheck`、`npm run build` 均已通過；沒有重跑 E2E，成功／失敗實測由 Muse 接手。`node_modules/`、`dist/` 是本機產物，已由本目錄 `.gitignore` 與 `.dockerignore` 排除。

## M1 限制

- v1 上傳契約只開放 `report.html`、`results.json`。預設關閉 screenshot／trace／video，讓固定 `page.setContent` spec 的 HTML 可單檔開啟。若腳本自行附加檔案或覆寫擷取設定，Playwright 會產生額外 data／trace；目前僅保留於本機輸出，未上傳，報告內對應下載連結不可用。要支援完整附件須先擴充契約。
- 基礎設施或語法故障可能沒有 HTML／JSON；只回 failed manifest，不補造成功或仿製 Playwright 報告。
- 尚未驗證 Docker、Chromium 實際啟動、Linux／Mac 映像架構及端到端成功／失敗流程。僅有結果判定單元測試與語法檢查不代表這些項目已通過。
- 尚無 author 模式、模型 adapter、瀏覽器探索工具、即時影像及公開多租戶隔離。
