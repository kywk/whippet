# Runtime PNG 截圖與 M3 交付

更新：2026-11-11（Asia/Taipei）。Owner：Runtime Agent。

**PNG 管線已交付並部署；總指揮回報 4 個 Whippet 真實驗收案例的報告 9 張 PNG 全部通過，案例 01 revision 4 已修正過場並經目視確認。** M3 先前已完成同對話 read_validation_report 修復、revision 3 validation 成功、confirmed 發佈及 UI／key 隔離驗收。結果以總指揮的 [M3 整合紀錄](../../docs/tracking/devlog/m3-integration.md) 為準；本 Agent 不呼叫模型或重跑上述驗收。

## 本輪 PNG 交付（此節優先於下方 M3 基線紀錄）

- Worker `src/report-artifacts.ts` 將原生 `html/data/<sha1>.png` 複製為 `output/data/<sha1>.png`，全部成功後才輸出 report.html，不解析 HTML ZIP、不改寫報告。
- Runner 預設 screenshot only-on-failure，成功步驟用 spec 的 testInfo.attach 手動附加 PNG；trace／video 關閉且仍不支援附件上傳。
- Manager `screenshots.go`／`artifacts.go`／allowlist／journal 支援 `data/[0-9a-f]{40}.png`。10 MiB／張、最多 32 張／64 MiB 合計；只接受 regular file／directory，Root 限制路徑、拒絕 symlink／traversal，檢查 PNG header 與 SHA-1 內容。
- 上傳順序為全部 PNG → report.html → results.json → result。圖片收集不合法會 failed 且扣住 HTML；上傳失敗保留檔案／journal 補送，不宣稱成功。author 不接受 PNG。
- Server owner t31 已配合 POST／GET `.../artifacts/data/<hash>.png`、image/png 與必要報告存在檢查；PNG 不計入原本「兩份必要報告」數量，不改 Server terminal-and-absent 名額規則。
- skill 已改為 testInfo.attach 成功步驟 recipe，保留 trace／video 不支援的描述。README 已移除 screenshot off／未上傳／Docker 尚未驗證等過時說明。

交付供既有映像衍生 COPY：

| 產物 | 位置／說明 |
| --- | --- |
| Manager binary | `/private/tmp/whippet-manager-screenshots`，ELF Linux arm64、靜態連結，10,115,690 bytes。 |
| Worker 編譯輸出 | `runtimes/worker/dist/`，含最新 runner.js、report-artifacts.js。 |
| 技能資產 | `runtimes/worker/skills/`，須與 dist 一起 COPY 到既有 Worker 映像。 |

本 Agent 實際檢查：正式 npm build 通過；PNG 匯出測試 1 項、Manager 截圖測試 3 項、更新後 skill mock capture 1 項均通過。測試涵蓋原生相對路徑、先圖後報告、MIME／attempt、regular file／symlink、檔名／數量／大小限制與失敗扣住 HTML。未重跑既有 8 個 author mock／全量 E2E。

Linux binary 使用既有快取交叉編譯，exit=0：

```sh
GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
GOCACHE=/private/tmp/whippet-manager-go-cache \
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
go build -mod=readonly -trimpath -o /private/tmp/whippet-manager-screenshots ./cmd/manager
```

總指揮部署後首筆 Run `04152970-718a-4b66-a752-8555224d42c0` succeeded／published，真 Chromium HTML 報告 3 張 PNG 全載入且零 CSP／HTTP 錯誤；後續回報 4 案例／9 PNG 通過。這些是總指揮回報的整合證據，不是本 Agent 的 live 測試。案例 01 最終 Run `8cd30023-c743-4aa6-a6ee-12332692d865` 已通過、發佈且目視確認；本輪依使用者限制不執行 Git 操作。

## 產物與邊界

| 範圍 | 變更 |
| --- | --- |
| Manager `protocol.go`、`author.go` | 接受 kind author、baseRevision／conversation／messages，白名單環境傳遞與固定進度格式。author timeout 最多 180000 ms；對話最近最多 12 則／總 32000 字元。 |
| Manager `manager.go`、`journal.go` | 持久化 kind 與必要快照；author 共用既有 MAX_WORKERS、ACK、取消 context、回收確認、heartbeat、重連及同 attempt 去重。舊 journal 的空 kind 視為普通 run。 |
| Manager `docker.go` | author 以同一映像的 `node dist/author/main.js` 啟動；run 保留原 CMD。只有 author create 使用 `--env NAME` 白名單，值不放在 argv。普通 run 的 Docker CLI 環境亦移除 AI 設定／key。 |
| Manager `artifacts.go` | author 成功只接受 author.json（2 MiB），不要求 Playwright 報告；普通 run 只接受原本兩份報告。author 失敗不補傳候選，錯誤固定遮蔽。 |
| Worker `src/author/types.ts` | author input／output、上下文界限、固定遮蔽錯誤。 |
| Worker `src/author/loop.ts` | 原生 Responses function calling、最多 8 requests／12 tools／180 秒；無 retry、payg fallback、previous_response_id 或持久模型狀態依賴。 |
| Worker `src/author/tools.ts` | 8 個必要工具（含 read_validation_report）、HTTP(S) 探索、文字 aria snapshot 與 bounded selector hints；無任意 shell／eval 工具。瀏覽器 subprocess 不繼承 AI key。 |
| Worker `src/author/main.ts` | 獨立入口、SIGTERM／timeout、最後寫 author.json／result.json；不執行模型生成的 spec。只印固定進度。 |
| Worker package／README、Manager README | 新增 npm author／test:author 入口與串接文件；沒有新增 SDK 或相依套件。 |
| `author_test.go`、`src/author/author.test.ts` | Manager kind／環境／附件／名額／取消測試及 Worker 工具續接、界限與遮蔽測試。 |

所有修改限於 `services/manager/`、`runtimes/worker/`。未安裝套件、未讀 `deploy/.env.ai`／任何真實 key、未讀全域 provider 設定、未呼叫模型、未執行 Git。本 Agent 不執行 Docker／live；總指揮負責部署。

## 固定介面

- 沿用 [M3 契約](../../contracts/mvp-v3.md)，沒有要求新增 artifact schema。input 加 kind／author；journal 保存 kind，不含 AI 設定或 key。
- Manager 專用環境白名單為 `WHIPPET_AI_ENABLED`、`WHIPPET_AI_BASE_URL`、`WHIPPET_AI_MODEL`、`WHIPPET_AI_REASONING_EFFORT`、`OPENCODE_API_KEY`，只給 author 容器。一般 run／validation 不注入。部署 overlay 由總指揮維護。
- 模型 endpoint／model／User-Agent 沿用既有 Responses 設定，`x-opencode-session=conversationId`；reasoning 使用 `config.reasoningEffort`（預設 xhigh），沒有硬編碼破壞替換設定。
- 函式為原生 `type:function` schema，工具回覆為 `type:function_call_output`，以 call_id 配對；完整保留 reasoning／function_call 等 output items。採 `store:false`、`include:["reasoning.encrypted_content"]`，不使用 previous_response_id。依 [官方 function calling](https://developers.openai.com/api/docs/guides/function-calling) 與 [stateless reasoning](https://developers.openai.com/api/docs/guides/reasoning)；Go provider 的 live 相容性仍以總指揮驗收為準，不自動降級格式或切換端點。
- `read_draft` 讀目前候選、`update_draft` 只替換記憶體候選；`request_validation` 只回旗標。成功輸出 `{message,script?,requestValidation}`，由 Server 回收後交易套用／衝突保留／另排 validation。author 不執行生成 spec、不等待 validation，也不自動發佈。
- 既有 run／validation 的報告成功門檻未削弱。author 成功只檢查 author.json；普通 run 不得上傳該檔。Server 依 kind 保存／讀取附件，由 Server owner 實作。
- 進度沿用 log event，只轉送 `author:model:<序號>:<started|succeeded|failed>`、`author:tool:<序號>:<固定名稱>:<succeeded|failed>`。不包含工具參數、DOM、provider body、模型原文或 key；其他 author stderr 全部遮蔽。

## 最新 selector 修正

總指揮回報第一次真實 author：navigate 成功，但 aria snapshot 缺乏 CSS 資訊，fill／click 各猜錯一次並額外讀 snapshot，導致第 8 次 request 更新候選後達 limit；草稿未套用，符合失敗保護。

已針對此根因修正，**沒有增加 8 requests／12 tools 預算**：

- navigate／click／snapshot 回傳最多 30 個 input／button／link／textarea／select 的 selectorHints：tag、id、name、type、文字及可用 CSS selector；不讀 input value。
- 優先產生唯一 id／name selector，否則固定程式產生完整 nth-of-type CSS 路徑。DOM 擷取程式固定，沒有模型可提供程式的 eval 工具。
- schema 明確要求 literal CSS／text= selector，禁止傳入 page.getByRole(...) 這種 JS 表達式。
- 指示 navigate／click 已回 snapshot／hints，避免無謂再讀 snapshot 消耗模型回合。

此修正後只執行必要正式 build，**exit=0**；未自行重試模型。Manager 未因 selector 修正變動，最新修正只需重建 Worker。總指揮尚未回報修正後 live 結果。

總指揮後續回報：selector 修正後 author **6 requests／5 tools 全成功**，但產生的 spec 使用不正確的 listitem accessible-name 斷言，獨立 validation 真實失敗；沒有弱化發佈門檻。為支援同對話修復，依更新後 M3 契約新增：

- `author.validation?:{runId,status,error?}`，Manager 轉傳、Worker 驗證；error 最多 4000 字元，沒有快照可照常執行。
- `read_validation_report` 只回這份快照，無值回 `{status:"none"}`；不讀任意 report、不執行 spec、不同步等待 validation。
- system 提醒修復時讀取摘要，仍把摘要當資料；進度白名單加入該固定工具名稱。8 requests／12 tools／180 秒上限不變。
- 正式 build 通過；受影響 Worker mock **3 passed**（stateless 續接、輸入邊界、optional validation 修復），Manager `TestM3AuthorOptionalValidationSnapshot` 通過（0.322s）。沒有重跑全套或自行呼叫模型。

**這個 validation snapshot 修正同時改動 Manager 與 Worker，兩個映像皆須重建**。總指揮接續目前 test 的同對話修復，不必重跑第一輪生成。修復後 live 驗證結果尚待回報。

## 實際檢查

1. Worker `npm run build`：正式 TypeScript 編譯／型別檢查通過；加入 selector hints 後再 build 一次亦通過，最後一次 exit=0。
2. Worker `npm run test:author`：**6 passed、0 failed、exit=0**（selector 修正前，工具續接與界限核心未改動）：
   - 8 個 mock response 走完 read／navigate／snapshot／fill／click／update／validation／final，候選只回傳、不執行。
   - stateless encrypted reasoning 與 call_id 回傳、相同 conversation session、reasoning effort 使用設定值。
   - 8 requests／12 tools 上限、缺 key／停用、401／429 不重試、secret echo／raw error 遮蔽。
   - 整輪 timeout／取消、非 HTTP(S) 與未知 eval 工具拒絕、可只回提問而無候選稿。
3. Manager `gofmt -w internal/manager` 完成；M3 focused race 檢查 **4 項測試通過、exit=0**：

   ```sh
   GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
   GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
   GOCACHE=/private/tmp/whippet-manager-go-cache \
   go test -race -mod=readonly ./internal/manager -run '^TestM3' -count=1
   ```

   結果：`ok whippet/services/manager/internal/manager 1.606s`。涵蓋 author 白名單與獨立入口、普通 run 不注入 key、input／journal 無 AI 設定、kind 對應附件、author 共用名額／取消回收／去重，以及固定進度白名單。
4. 加入 author kind 後，既有 `TestManagerDispatchDedupAndCollectionOrdering` focused 檢查通過（0.380s）；沒有重跑 repo 全量、M1／M2 E2E 或無關 AI probe 測試。

以上均使用合成假 key／fetch／容器 driver；不是本 Agent 的真實模型或 Chromium 驗收。

## 總指揮接續

1. 最新 validation snapshot 修正需重建 Manager／Worker，請更新兩個映像後續接目前 test 的修復；不重跑第一輪。
2. 使用合成站 `http://host.docker.internal:18082`，不新增 Worker network 設計。驗收 navigate→fill→click→update_draft→request_validation，從固定進度確認動作。
3. 核對 author.json 上傳後的 baseRevision 交易套用／衝突、冪等 result，以及回收後才建立普通 validation。確認 validation 容器沒有 key。
4. 真實完成同對話修改→驗證成功→人工發佈→重開對話；未完成前不將 M3 標為完成。

等待總指揮整合結果，提交由總指揮負責。

PNG 以外附件仍有限制：額外失敗範例的自動截圖可見，但 `error-context.md` 未上傳且讀取會遭 CSP 阻擋。完整檢查與限制見 [本機驗收指南](../../docs/guides/whippet-acceptance.md)。
