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
| `/work/output/data/<sha1>.png` | HTML reporter 的 PNG 附件，保留原始相對引用；Manager 先上傳圖片再上傳報告。 |
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

## M3 author 工具迴圈

### 實際載入的 Playwright authoring skill

技能來源為 [skills/playwright-authoring/SKILL.md](skills/playwright-authoring/SKILL.md)，常駐核心內容包含：

- 先用 browser 工具的 selectorHints 探索；探索參數用 literal CSS／text=，生成的 spec 優先用穩定的 getByRole／getByLabel。
- listitem 文字通常不是 accessible name；提供 `getByRole('listitem').toHaveText(['alpha'])` 與 `filter({ hasText: 'alpha' })` recipe，依實際預期清單調整斷言。
- web-first `await expect`、auto-wait、完整 TypeScript import、獨立 page fixture／測試資料；保留測試意圖，避免硬 sleep、無關 timeout／retry、skip／only。
- 修復先讀 read_validation_report，只改相關步驟；候選只交 update_draft／request_validation，不在 author 執行、不自動發佈。關鍵步驟可用 testInfo.attach 附加 PNG，trace／video 附件仍未支援。

[src/author/skill.ts](src/author/skill.ts) 以 `import.meta.url` 定位 package 根目錄的技能 Markdown，剝除 YAML frontmatter、快取正文；不依賴 cwd，也不讀環境或 key。每次 author 啟動工具迴圈時，會在第一次 fetch 前將正文加入 Responses `instructions`，後續回合使用同一份內容。檔案缺少或格式不合法就以固定 `skill_unavailable` 失敗，不帶著空技能繼續請求。

Dockerfile 已加入 `COPY skills ./skills`，使技能與 `dist/` 同層封裝。**只配送 dist 目錄不足以執行 author，必須一併保留 skills 目錄，或使用重建後的 Worker 映像。** 沒有新增 SDK、依賴、模型路由或檢索框架。

官方核對來源：[Locators／filter](https://playwright.dev/docs/locators)、[Assertions](https://playwright.dev/docs/test-assertions)、[Best Practices／隔離與穩定定位](https://playwright.dev/docs/best-practices)。來源 URL 也記錄在技能 frontmatter；不將來源 metadata 重複加入每次模型請求。

本輪正式 `npm run build` 通過；下列最小測試 **1 passed、0 failed**，以合成假 key 與單次 fetch mock 捕捉真正組裝的 request body。測試切換到 `dist/author` cwd，確認技能正文只注入一次，且正確 listitem recipe、getByRole／getByLabel、web-first、隔離及修復規則確實進入 instructions；沒有真實模型呼叫。

```sh
node --test --test-name-pattern='packaged Playwright authoring skill' dist/author/author.test.js
```

技能正文 2855 bytes、核心指示 598 bytes，合計約 3455 字元；以英文內容字元／4 粗估約 **864 tokens**，未新增 tokenizer，也不宣稱精確 token 數。此測試證明內容確實載入與送入請求，不能保證模型每次都遵循或量化節省時間；真實案例驗收由總指揮獨立負責。

Manager 派送 `kind:"author"` 時，使用獨立入口 `node dist/author/main.js`。輸入在既有 run／attempt／script／timeout 外，包含 `author:{conversationId,baseRevision,messages,validation?}`；空草稿可用，對話最多最近 12 則／總 32000 字元。validation 是 optional `{runId,status,error?}` 最新草稿驗證快照，error 最多 4000 字元。

Responses 使用既有 Go base URL／model／User-Agent、設定中的 reasoning effort（預設 xhigh），session 固定為 conversationId。原生 function schema 為 `{type:"function",name,parameters,strict:true}`；以 `function_call.call_id` 配對 `function_call_output`。採 stateless transcript、`store:false`、`include:["reasoning.encrypted_content"]`，保留返回的 reasoning／function call 項目，不使用 previous_response_id。格式依 [官方 OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) 與 [stateless reasoning](https://developers.openai.com/api/docs/guides/reasoning)；Go provider 的實際相容性由總指揮 live 驗收。

固定工具只有 `read_draft`、`read_validation_report`、`update_draft(script)`、`browser_navigate(url)`、`browser_snapshot`、`browser_click(selector)`、`browser_fill(selector,value)`、`request_validation`。修復時 read_validation_report 只讀輸入提供的 runId／status／error 摘要，無快照回 `{status:"none"}`；不抓任意報告檔、不執行或同步等待 validation。最多 8 次模型請求、12 次工具執行、180 秒；超限／取消／HTTP 失敗不重試、不改端點。模型與網頁內容皆視為資料，不能覆寫使用者測試目標。

瀏覽器僅允許 HTTP(S) 導航。navigate／click 已回傳 aria snapshot 與最多 30 個 selectorHints（input／button／link／textarea／select 的 id、name、type、文字與可用 CSS selector），**不必在每個動作後另外 snapshot**。fill／click 應直接使用提示的 literal CSS selector 或 `text=`，不可傳入 `page.getByRole(...)` 等 JavaScript 表達式。Selector hints 由固定 DOM 擷取程式產生，不讀 input value，不提供模型任意 eval／shell 工具。

`update_draft` 只修改本輪記憶體候選；`request_validation` 只設定旗標，不執行或等待 spec。成功寫 `/work/output/author.json {message,script?,requestValidation}` 及 result.json，不產生 Playwright 報告；失敗不保存候選附件。Server 在 author 結束並回收後，才核對 baseRevision、套用草稿並按旗標另排 keyless validation；不自動發佈。

AI key 只在 author 程序環境，瀏覽器 subprocess 另用不含 key 的環境白名單。author 只輸出固定序號／名稱／成功或失敗的 NDJSON 進度，不印參數、DOM、模型原文或 provider raw error。若 provider 回應或工具資料含已知 key，會停止並遮蔽，不存入附件。

```sh
npm run build
npm run test:author
```

## 獨立 AI check／probe（預設停用）

已加入 OpenCode Go Muse 原生 Responses 的最小設定／請求組裝，以及 `npm run ai:check`、`npm run ai:probe -- --live --session=<conversation-id>`。check 完全離線；probe 只有明確 enabled、key 與 live 參數齊備才發送一次合成 coding 請求。一般 Playwright runner 不載入 AI 模組或接收 AI key。

設定、獨立 opt-in Compose 與訂閱／Contributor 政策見 [OpenCode Go 指南](../../docs/guides/opencode-go.md)。check／probe 仍是獨立指令；M3 author 使用上方獨立任務入口，Server／Web 串接由各 owner 負責。

## PNG 報告附件與目前範圍

- Runner 設為 `screenshot: "only-on-failure"`；成功的關鍵步驟在 spec 中手動 `await testInfo.attach('step-name', { body: await page.screenshot({ type: 'png' }), contentType: 'image/png' })`，並在測試 callback 接收 `testInfo`。PNG 補充斷言證據，不等於自動視覺比對。
- HTML reporter 的 `html/data/<40位小寫SHA-1>.png` 複製到 `output/data/`，全部完成後才輸出 report.html；HTML 原生 `data/` 相對引用不改寫。Manager 先上傳 PNG，再上傳 report.html／results.json，全部成功才送終態。Server 提供 `.../artifacts/data/<hash>.png`，因此報告與圖片須一起保存。
- 每張 PNG 最多 10 MiB、每 run 最多 32 張／合計 64 MiB。Worker／Manager 檢查受限名稱、regular file、大小與內容 hash，Manager 另驗 PNG header；拒絕 symlink／traversal。PNG 收集失敗時不發布會斷圖的 HTML。
- **PNG 已支援；trace／video 與其他附件格式仍未支援。** 不要啟用它們或宣稱對應下載連結可用。
- 基礎設施或語法故障可能沒有 HTML／JSON；只回 failed manifest，不補造成功或仿製 Playwright 報告。
- 總指揮已完成真實 Docker／Chromium 的 **4 個 Whippet 驗收案例與報告 9 張 PNG**，圖片正常載入、零 CSP／HTTP 錯誤。案例 01 已調整至 Workspace 顯示後擷取，revision 4 重新通過並目視確認。M1／M2／M3 的成功、失敗、取消、對話修復／驗證／確認發佈與 UI 驗收沿用總指揮既有紀錄；本次不重跑。
- Linux arm64 Manager binary 與 Worker dist 已交由總指揮從既有映像衍生部署，未宣稱所有 OS／CPU 組合已驗證。尚無即時影像與公開多租戶隔離。

PNG 以外附件仍有限制：額外失敗範例的自動截圖可見，但 `error-context.md` 未上傳且讀取會遭 CSP 阻擋。完整檢查與限制見 [本機驗收指南](../../docs/guides/whippet-acceptance.md)。
