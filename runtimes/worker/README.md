# Whippet Playwright Worker（M1）

最新 M8 A：新增 `workspace-author@1` 純訪談，沿用 `node dist/author/main.js`；交付見 [Manager DELIVERY](../../services/manager/DELIVERY.md)。這不代表 M8 受限網站執行已完成，舊版自由 spec 執行方式亦不代表新版網路授權。

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

legacy 技能來源為 [skills/playwright-authoring/SKILL.md](skills/playwright-authoring/SKILL.md)，共用 [recipe.md](skills/playwright-authoring/references/recipe.md)；M7 新任務的固定映射見下節。常駐內容包含：

- 先用 browser 工具的 selectorHints 探索；探索參數用 literal CSS／text=，生成的 spec 優先用穩定的 getByRole／getByLabel。
- listitem 文字通常不是 accessible name；提供 `getByRole('listitem').toHaveText(['alpha'])` 與 `filter({ hasText: 'alpha' })` recipe，依實際預期清單調整斷言。
- web-first `await expect`、auto-wait、完整 TypeScript import、獨立 page fixture／測試資料；保留測試意圖，避免硬 sleep、無關 timeout／retry、skip／only。
- 修復先讀 read_validation_report，只改相關步驟；候選只交 update_draft／request_validation，不在 author 執行、不自動發佈。關鍵步驟可用 testInfo.attach 附加 PNG；M6 失敗 trace／MD 支援下載，影片仍未支援。

[src/author/skill.ts](src/author/skill.ts) 以 `import.meta.url` 定位 package 根目錄的技能 Markdown，剝除 YAML frontmatter、快取正文；不依賴 cwd，也不讀環境或 key。每次 author 啟動工具迴圈時，會在第一次 fetch 前將正文加入 Responses `instructions`，後續回合使用同一份內容。檔案缺少或格式不合法就以固定 `skill_unavailable` 失敗，不帶著空技能繼續請求。

Dockerfile 已加入 `COPY skills ./skills`，使技能與 `dist/` 同層封裝。**只配送 dist 目錄不足以執行 author，必須一併保留 skills 目錄，或使用重建後的 Worker 映像。** 沒有新增 SDK、依賴、模型路由或檢索框架。

官方核對來源：[Locators／filter](https://playwright.dev/docs/locators)、[Assertions](https://playwright.dev/docs/test-assertions)、[Best Practices／隔離與穩定定位](https://playwright.dev/docs/best-practices)。來源 URL 也記錄在技能 frontmatter；不將來源 metadata 重複加入每次模型請求。

本輪正式 `npm run build` 通過；下列最小測試 **1 passed、0 failed**，以合成假 key 與單次 fetch mock 捕捉真正組裝的 request body。測試切換到 `dist/author` cwd，確認技能正文只注入一次，且正確 listitem recipe、getByRole／getByLabel、web-first、隔離及修復規則確實進入 instructions；沒有真實模型呼叫。

```sh
node --test --test-name-pattern='packaged Playwright authoring skill' dist/author/author.test.js
```

M7 已將任務 skill 與共用 recipe 分開，每個載入檔案上限 4096 bytes；沒有新增 tokenizer 或宣稱精確 token 數。request capture 證明內容確實載入，不能保證模型每次遵循或量化節省時間；真實案例驗收由 PM 負責。

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

## M7 測試編輯與唯讀驗收摘要

固定 `kind:"author"`／既有入口，依契約的 `author.skillId` 選 `test-author` 或 `acceptance-summary`，skillVersion 都為字串 `1`。程式只映射 package 內的兩份 SKILL.md 與共用 recipe；不從輸入讀任意路徑、不建立外掛框架。新 payload 還需 allowedTools、editingSessionId、contextRevision、nullable sourceVersion／conversationSummary；script、workspaceSettings 沿頂層。沒有 mode／context 物件。

test-author 保留原工具，但同時收窄模型宣告與實際執行到 allowedTools。最終回 JSON message／optional conversationSummary，候選 script 與 requestValidation 仍只來自工具狀態；conversationSummary 最多 8192 UTF-8 bytes。legacy 沒有新欄位時仍走原 author；未知／半套 skill pin 拒絕，不靜默降級。

acceptance-summary 必須 allowedTools=[]，可 messages=[]；完整 script 與合格 validationEvidence 仍必填。校驗 succeeded／reportsReady、revision／SHA256／實際 stats；完全不建立 browser／observer，也不抓報告 URL、執行 spec 或提供工具。單次模型 request 的輸出嚴格為 `{message,description,backgroundSummary,name?}`，description 16384 bytes、backgroundSummary 8192 bytes、name 200 bytes；拒絕 script／requestValidation／額外 metadata。綁定只取 Server 保存 input，輸出成功不等於 Playwright 成功，也不自動發佈。

來源版本、週期摘要、Workspace 與完整稿一併作為固定 DATA 提供，不能覆寫系統規則；沒有來源摘要時維持缺值。遠端歷史工具延 M9，範圍／機密機制另屬 M8。沿用原模型 adapter、reasoningEffort、conversationId session、key 白名單、180000 ms 及名額回收。

必要檢查 `npm run build`、`node --test dist/author/author.test.js dist/author/m7.test.js` 已通過（13 項 mock）。技能官方 quick_validate 腳本缺 PyYAML 而未執行成功，未安裝；已人工檢視並以 request capture 證明載入。完整結果與 Manager 資產見 [DELIVERY](../../services/manager/DELIVERY.md)；未做真模型／瀏覽器或整合驗收。

## 獨立 AI check／probe（預設停用）

已加入 OpenCode Go Muse 原生 Responses 的最小設定／請求組裝，以及 `npm run ai:check`、`npm run ai:probe -- --live --session=<conversation-id>`。check 完全離線；probe 只有明確 enabled、key 與 live 參數齊備才發送一次合成 coding 請求。一般 Playwright runner 不載入 AI 模組或接收 AI key。

設定、獨立 opt-in Compose 與訂閱／Contributor 政策見 [OpenCode Go 指南](../../docs/guides/opencode-go.md)。check／probe 仍是獨立指令；M3 author 使用上方獨立任務入口，Server／Web 串接由各 owner 負責。

## PNG 報告附件與目前範圍

- Runner 設為 `screenshot: "only-on-failure"`；成功的關鍵步驟在 spec 中手動 `await testInfo.attach('step-name', { body: await page.screenshot({ type: 'png' }), contentType: 'image/png' })`，並在測試 callback 接收 `testInfo`。PNG 補充斷言證據，不等於自動視覺比對。
- HTML reporter 的 `html/data/<40位小寫SHA-1>.png` 複製到 `output/data/`，全部完成後才輸出 report.html；HTML 原生 `data/` 相對引用不改寫。Manager 先上傳 PNG，再上傳 report.html／results.json，全部成功才送終態。Server 提供 `.../artifacts/data/<hash>.png`，因此報告與圖片須一起保存。
- 每張 PNG 最多 10 MiB、每 run 最多 32 張／合計 64 MiB。Worker／Manager 檢查受限名稱、regular file、大小與內容 hash，Manager 另驗 PNG header；拒絕 symlink／traversal。PNG 收集失敗時不發布會斷圖的 HTML。
- **PNG 已支援；M6 失敗 trace ZIP／error-context MD 支援有界匯出下載，影片與其他附件格式仍未支援。** 沒有內嵌 trace viewer。
- 基礎設施或語法故障可能沒有 HTML／JSON；只回 failed manifest，不補造成功或仿製 Playwright 報告。
- 總指揮已完成真實 Docker／Chromium 的 **4 個 Whippet 驗收案例與報告 9 張 PNG**，圖片正常載入、零 CSP／HTTP 錯誤。案例 01 已調整至 Workspace 顯示後擷取，revision 4 重新通過並目視確認。M1／M2／M3 的成功、失敗、取消、對話修復／驗證／確認發佈與 UI 驗收沿用總指揮既有紀錄；本次不重跑。
- Linux arm64 Manager binary 與 Worker dist 已交由總指揮從既有映像衍生部署，未宣稱所有 OS／CPU 組合已驗證。M4 即時影像進度見下節；尚無公開多租戶隔離。

PNG 以外附件仍有限制：額外失敗範例的自動截圖可見，但 `error-context.md` 未上傳且讀取會遭 CSP 阻擋。完整檢查與限制見 [本機驗收指南](../../docs/guides/whippet-acceptance.md)。

## M4 唯讀即時畫面

沿用 [M4 契約](../../contracts/mvp-v4.md)，不新增套件。Runner 保留完整 spec，以任務專用 tsconfig paths 將 `@playwright/test` 導向產生的 CJS fixture bridge；bridge 從 `playwright/test` 載入原始 API，包住 worker browser fixture。`src/live/observer.ts` 觀察既有 context／page／popup，選擇最近建立且尚未關閉的 page；不自行建立被測頁面。author 在現有 exploration browser 掛同一 observer。API-only 測試未使用 browser 時不強制啟動它。

Manager 經 `/work/live/control.json` 原子更新 `{viewerId,mode,expiresAt,iceServers,answer?}`，expiresAt 為 Unix 毫秒。Worker 每 250 ms 檢查；沒有有效租約時不擷取、不開 helper。原子 state.json 含 viewerId／state／transport／offer；最新 JPEG 為 `<viewerId>.jpg`，限制 1 MiB，沒有歷史影格佇列。這些都是暫存媒體資料，不是報告附件，不寫入 input、journal 或 log。

擷取使用既有 `page.screencast.start({onFrame,size:{width:1280,height:720},quality:55,fps:3})`。WebRTC 模式另開無金鑰 Chromium helper，將 JPEG 畫入 canvas，以 `canvas.captureStream(3)` 的 video track 送入 RTCPeerConnection；track 設 `contentHint="text"` 保留網頁細字，**不是 DataChannel 傳圖**。offer／answer 使用 non-trickle ICE，最多等待 gathering 8 秒；ICE 設定由 Server 傳入，預設空陣列。JPEG 模式關閉 helper、保留畫面擷取。viewer 離線、租約到期、Run 結束時停止影像；媒體例外只回固定 unavailable，不改測試結果。

helper subprocess 只接收 PATH／HOME／TMPDIR／LANG／DISPLAY／PLAYWRIGHT_BROWSERS_PATH，不繼承 AI key 或 Manager token。原始 provider／頁面內容／SDP／ICE credentials 不列印。helper 不導航到被測網站，也不執行生成的 spec。操作／清理設有短期限，監看失敗不阻塞測試。

跨 Docker 診斷：總指揮已驗證 Docker viewer 整條 UI 真 video、手動 JPEG 更新、關閉監看後 Run 繼續；Mac native 先前只能自動切 JPEG。原 helper offer 實際只有一筆 UDP host `.local` mDNS candidate，沒有 numeric host。因此僅對 ephemeral helper 加入 `--disable-features=WebRtcHideLocalIpsWithMdns`，不調整被測 browser 或觀看端設定；正式 build 已通過，旗標後的實際候選與 Mac native 真 video 待總指揮驗收。這不保證一般 NAT／跨網可達，也不取代 TURN。

正式 `npm run build` 與離線租約／環境白名單 mock 通過。總指揮代跑既有映像的 Docker default bridge loopback：**2/2 通過，真 RTP video framesDecoded=3、jpegCaptured=true**，約 2.7 秒；network=none 沒有可用 ICE candidate 的失敗屬測試配置，沒有改稱成功。完整 fixture→Manager→UI、切備援及離線回收仍交總指揮整合。最小容器檢查入口：

```sh
WHIPPET_LIVE_BROWSER_TEST=1 node --test dist/live/live.test.js
```

限制：直接使用非 bridge 匯入、自行 `chromium.launch()`／外部 connect 的獨立 browser process 不保證被觀察；目前不提供換頁 UI、音訊或鍵鼠控制。每 Run 一位 viewer。helper 增加一個 Chromium，維持既有 1 GiB／1 CPU／256 PID 限額。M4 Mac 原生真 video／JPEG／停止後 Run 完成已通過；跨網與真實 TURN 尚未驗證。即時 video 不等於支援影片報告附件；M6 trace／MD 見下節，既有 PNG 管線維持原樣。

官方 API 依據：[Screencast](https://playwright.dev/docs/api/class-screencast)、[fixtures](https://playwright.dev/docs/test-fixtures)、[tsconfig paths](https://playwright.dev/docs/test-typescript#tsconfig-path-mapping)、[canvas.captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)。

M5 畫質診斷以真實登入頁的 1:1 crop 與 RTP stats 確認：原始 JPEG／canvas 1280×720，未加 hint 的 VP8 降成 320×180；只設 text 後維持 1280×720，video edge MAE 50.62→16.50，接近 JPEG 16.16。因此未盲調 bitrate／尺寸／JPEG quality。viewer 現有 CSS 於 1440／1280 viewport、DPR 1 分別顯示 960×540／800×450；根因是編碼端縮小後被放大。完整證據、診斷入口與待 PM 執行的一次 browser regression 見 [DELIVERY](../../services/manager/DELIVERY.md)。

## M5 Workspace 設定快照

run／author input 可帶頂層 `workspaceSettings:{revision,sites:[{name,url}],defaultTestUrl,timeoutMs}`，只來自任務固定快照，不呼叫 Workspace API 取新值。sites 最多 20 筆，name 1..100 字元；URL 完整 HTTP(S)、最多 2048 字元且無 userinfo；timeoutMs 1..3600000。未知欄位拒絕，不接受 env／key。舊 input 可省略整個欄位。

runner 的 Playwright project `use.baseURL` 只使用非空 defaultTestUrl，供相對 `page.goto` 解析，不自動導航。空值／缺欄位維持既有行為；真正執行 timeout 仍取頂層 timeoutMs。author 將固定快照放進 Saved draft snapshot 資料上下文，明示不能當指令或自動導覽；其預算仍最多 180000，不被 Workspace 一般 run timeout 延長。對話／草稿／發佈規則仍由 Server 負責。

最小離線檢查：`npm run build`、`node --test dist/workspace.test.js`、`node --test --test-name-pattern='^M5 Workspace' dist/author/author.test.js`。真 runner 固定 fixture 與 RTP regression 的單容器命令見 DELIVERY；它不依賴模型或共用 DB，也不會建立 Server Run。

## M6 失敗 trace／Markdown 下載證據

runner 以 trace retain-on-failure、retries 0、video off 執行，HTML noCopyPrompt=true，避免 Copy prompt 在報告 sandbox fetch Markdown。原生 HTML data/<40位SHA1>.zip/.md 與 PNG 一起匯出；HTML 缺失時只掃本次 test-results 的 trace.zip／error-context.md（最多深度 4、2048 entries），以內容定名與去重，沒有檔案就不產生證據或假報告。

ZIP 每檔 64 MiB，MD 1 MiB，兩者最多 32 檔／128 MiB，與 PNG 配額獨立。只接受 regular file；檢查 SHA1、ZIP PK0304／PK0506（拒絕0708）、MD UTF-8，拒絕 symlink／traversal。無效或超限的可選證據只記固定略過原因，不改原斷言結果。ZIP 不解壓、不執行；author 仍只回 author.json。

Manager 先上傳證據／報告才送 result，沿 journal 冪等補送；明確的 ZIP／MD HTTP413 可略過並持久化，其餘必要報告／PNG／認證／attempt 衝突／網路錯誤仍沿原規則。平台下載入口由 Server／Web 提供；trace 下載後以本機 Playwright show-trace 開啟，沒有內嵌 trace viewer，不放寬 HTML CSP。

最小 unit、固定真失敗 `examples/fail.spec.ts`／成功 `examples/pass.spec.ts` 與 PM 隔離容器精確命令見 [DELIVERY](../../services/manager/DELIVERY.md)。硬殺前未 flush 的證據無法保證保留；缺少可選附件不等於測試成功，必要報告門檻維持。

## M10 bundle 與本機驗證

Runner 可接收 `files:[{path,content,origin}]`：恰一個 `tests/test.spec.ts`，其餘為 `lib/<slug>.ts`；`@lib/*` 對應 `lib/*`。最多 64 檔、單檔 2 MiB、內容合計 8 MiB，input JSON 上限 64 MiB。與 `script` 同時提供時必須等於入口內容；無 files 時保留舊版 script 行為。

任一檔案 origin=ai 時，整個 bundle 以 AI 來源執行並要求已確認的 Workspace scope；頂層 scriptOrigin=manual 不能覆寫這項判定。路徑逃逸、重複檔案、symlink 寫入均拒絕。Server 固定版本及發佈資格，Worker 不重新計算 bundle 發佈 hash。

原生 HTML／JSON 報告保留 `test.step`；自訂 log 會標示失敗的 Stage。M10 bundle smoke 使用合成頁面，成功／刻意失敗各一次：

```sh
WHIPPET_M10_BROWSER_TEST=1 node --test --test-name-pattern='M10 real' dist/bundle.test.js
```

若只使用本機已安裝瀏覽器，可設定 `WHIPPET_M10_BROWSER_EXECUTABLE_PATH` 為其絕對執行檔路徑；測試透過後端 `WHIPPET_BROWSER_EXECUTABLE_PATH` 傳入獨立 Playwright 啟動設定，不使用個人 profile。部署映像預設仍使用其內建 Chromium。
