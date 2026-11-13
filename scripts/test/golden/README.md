# M10.8 黃金任務集 v1（黑箱，可真正執行）

- 定義：`m10-golden-v1.json`（14 題，7 類各 2 題：新建／修復／複用／拆解／越界／注入頁／預算耗盡）。題目定義保留；本輪未改題目內容、未改順序／prompt／JSON（G05/G06原prompt保留，僅live以fixtureContext補充，不默默替換，不宣稱原中文hint可搜），僅核對實際欄位（setup.kind/initialScript/budget）。唯讀，不得修改。
- 基準：`../m10-golden-baseline.cjs`（M10.8 manifest接縫＋final-seam四縫＋score-guard補丁＋live-review覆核；前任 8 點修正保留，30 項既有斷言保留，新增 5 項共 35；score-guard 新增 4 項共 39，保留前 35 意圖；live-review 新增分支僅修G08/G13/G14前置不符UNVERIFIED，保留39意圖，原14題JSON不改）。
  - TERMINAL 嚴格 v1：`succeeded/failed/cancelled/timed_out/interrupted`；`timeout/budget_exhausted/stopped/discarded` 非終態。`budget_exhausted` 為 `authorPartial.reason`，transport 仍 `succeeded`。
  - `task.budget.maxSteps` 僅題目定義，公開 API 無 perRun override，不宣稱已生效；production 以 19087 budget8/12/180s 為準，fixture19187 budget1 不得混算 production 基準。G13/G14 budget2未實施，production仍8/12/180，無論自然是否partial原budget2題整體不得PASS，預算前置不符UNVERIFIED（實際失敗仍FAIL）；實際production partial另記，不混19187。
  - live 目標守衛：僅 19087 為 production golden 基準；18087 舊 M9 禁止碰，18187 停用，19187 專用 budget1 partial UI fixture 不得當基準。預設 18087/18089 live 直接 `BLOCKED`，需 PM 明確 19087 參數。新增嚴格 URL 解析：UI/API 皆須為 `http://127.0.0.1:19087`（http 同源 nginx 代理，不用 CA），經 URL 解析驗 hostname／port／protocol，不能只檢字串端口或只一邊合規。
  - PM 最小 manifest v1（只代表預期與授權，不當實際 scope/pin 證據；PM 將供應新 QA 專屬 Workspace 與已發布 seed，非任意舊 ID）：`{schemaVersion:1,baselineId:string,apiBase:"http://127.0.0.1:19087",workspace:{id:UUID,settingsRevision:integer,authorizationRevision:integer},catalogSeeds:[{taskIds:["G05"或"G06"],testId:UUID,versionId:UUID,slug?:string,publishedName?:string}],ownership:{createdFor:"m10-golden-r102",workspaceId:UUID,seedTestIds:[UUID]},productionBudget:{maxModelRequests:8,maxToolCalls:12,maxDurationMs:180000}}`。loader 為 `validateGoldenManifest`（slug/publishedName可選字串，固定test/version不變），缺／錯即 live `BLOCKED` 零網路 mutation。實際manifest已提供slug；GET Catalog需校驗slug一致。
  - live 一律要求 manifest；先純 GET workspace 確認 id／active／confirmed／settings／authorization revision 與必要 capabilities，GET Catalog 核每 seed exact test／version＋slug一致且同 Workspace；缺任何前置 `BLOCKED`，不能自行 confirm／publish。實際每題直接使用 manifest Workspace，新建獨立 owned Test／session；不再 POST Workspace，不沿用 seed Test 作編輯。記錄 PM-owned seed 與本輪-created Tests 兩種 ownership，cleanup 僅本輪建立 session，不能 discard seed 或其他 Test，不刪 Workspace。
  - continue revision 必用 `authorPartial.appliedRevision ?? sourceRun.draftRevision/baseRevision`，絕不 `draftAfter/current` fallback；需等待回收＋poll 續跑＋同 body 重試同 Run；409 非未部署（過期/非 partial/未回收）。
  - 僅 404/501/405 算未部署 UNVERIFIED；401/403/409/500 為 HTTP failure；已失敗不被 `m10Missing` 蓋掉。
  - G12 需前後版本/附件可觀測證據，缺證據 UNVERIFIED 不能 PASS。
  - G05/G06 PM已授權kind=usecase走planner（普通test-author無Catalog，原test→usecase，routeOverride明記理由，其他12題路由不變）：`EXPECTED_TEST_KIND` G05/G06為usecase，`TASK_CAPABILITY`含plan（不含catalog）；live新建UseCase並GET本輪plan。發布summary改過seed名稱，原中文hint非現Catalog name：live以manifest該題seed slug/version對應獨立fixtureContext（保存originalPrompt/fixtureContext/submittedContent，content=原prompt＋清楚標記fixture context，不默默替換，不宣稱可搜）。評分須有本輪新Plan reuse Stage同moduleTestId/moduleVersionId精確匹配該題manifest seed且action===reuse（缺action/null/其他action皆拒；僅Catalog有值/assistant提及/錯version/Plan null皆不得成功，須本輪Plan exact不靠Catalog/assistant）；reusePlanEvidence與taskEndToEndAssertions分開記錄。G05/G06 planner僅寫Plan不改draft，same revision不因此FAIL（taskEndToEndAssertions未實作另判UNVERIFIED；HTTP失敗/run失敗/真正錯誤仍FAIL優先；其他12題規則不變）。G05/G06只產Plan不confirm/Compose/publish，原可執行draft未實現，整題不可PASS（無其他FAIL則UNVERIFIED；實際失敗仍FAIL優先）。G06缺角色安全阻擋非credentials驗證成功，空draft無密碼不算成功，明列loginVerification=NOT_PERFORMED。G07/G08 需 `Test kind=usecase`＋Plan 非 null＋stages；未部署不假造；禁止自動發布（無 publish／confirm-scope 呼叫，零POST workspaces/confirm/publish）。
  - fixture 參數須實際傳入 `runLiveOneTask`；`--fixture-manifest <path>` 傳入，形狀不符 live `BLOCKED`。
  - registry10.2：首搜僅 `{query,limit}`，翻頁用 `catalog_next_page {cursor,limit}` 分離；QA 不合成 cursor，只觀測 workspace-scoped `GET /api/workspaces/{id}/catalog`；closed Plan GET 可讀 done（只需 Plan 非 null＋stages，不要求 active draft）。
  - metrics tools 只認 `toolCalls/toolCallCount` 實際數，不用 `allowedTools/registryVersion/tools` 冒充。
  - assistant 須綁 `authorRunId`（runId/run_id 任一等於 authorRunId），不只找任意 assistant。
  - 預設 `--check-only`（無 mutation）：只驗定義（題數 14／類別／合成性／無秘密／無非 `.invalid` 外連＋實際欄位），不碰網路，不建立 workspace/test/session，不觸發 author run。
  - `--run-live --allow-mutation`（PM 指定後才跑）：直接使用 manifest Workspace→新建獨立 owned Test（G05/G06/G07/G08 明確 `kind=usecase`，其餘 `kind=test`，題目prompt/JSON不變；G05/G06以originalPrompt＋fixtureContext組成submittedContent，記錄routeOverride test→usecase）→`POST editing-session`→（必要時 `PUT draft` 初始稿，嚴格用 `task.initialScript`）→`POST messages`（帶 `editingSessionId＋revision`，G05/G06 content為原prompt＋fixture context）→輪詢 `GET /api/runs/:id` 至 v1 終態→讀 `GET conversation?editingSessionId=`／`GET draft`／`GET versions`→按可觀測斷言評分→需要時 `POST validate`／`GET /api/workspaces/{id}/catalog`（fixed version exact＋slug一致）／`GET plan`（G05/G06/G07/G08本輪Plan）／`POST /api/runs/{id}/continue`（等待回收＋poll 續跑＋同 body 冪等重試）→僅 discard 本輪自有 session（seed 不可 cleanup）。能力／題目不符如實 FAIL／UNVERIFIED，不調斷言換 PASS；budget 與 mode 不足仍可形成真實逐題結果，但不宣稱完成。零POST workspaces/confirm/publish。
  - 評分只認可觀測證據（run 終態、draft revision/script、validation succeeded、catalog/plan/continue HTTP 狀態、前後版本、綁定 assistant）；不把 assistant 文字自稱完成當成功；錯誤 HTTP 永不假 `PASS`；`token/tools/latency` 能取則記，否則明示 `unknown`。
  - `catalog` 用 workspace-scoped `GET /api/workspaces/{id}/catalog`（舊 `/api/catalog` 猜測已刪除）；`author` 沿 v7 `editing-session＋messages`；M10 `Plan/continue` 見 v10（continue body 僅 `{editingSessionId,revision}`）。M10 功能未部署（404/501/405）則該題 `UNVERIFIED`，但已存在 author 題仍應可執行。
  - 所有 mutation 預設禁用；`--run-live` 缺 `--allow-mutation` 即 `BLOCKED`。本輪只實作＋離線驗證，live 待 PM 指定。live 完整性仍未確認，不宣稱完成。
- 離線回放：`../m10-golden-offline.cjs`（fake server，零產品網路，零 mutation；不呼叫產品 API／模型，不以 stub-fake 當 builtin；實際live函式fake HTTP回放行為驗證，不用純字串contains替代）。
  - 保留既有 30 項重要斷言：TERMINAL、原 run revision、timed_out 停止 poll、錯誤 HTTP 不 PASS、null Plan/無 reuse/G12 缺證據不 PASS、cleanup 只 owned ID、metrics/assistant 綁定、定義實際欄位、port 守衛、budget 定義限定、fixture 形狀、registry 分離。
  - 新增 manifest 接縫 7 項：T17 manifest 缺失零 mutation、T18 兩 URL 嚴格拒絕、T19 scope／seed mismatch 零 mutation、T20 使用指定 workspace 新 Test 且零 POST workspaces、T21 seed 不能 cleanup、T22 fixed version 不匹配不得 PASS、T23 budget 不假套用。
  - 新增 final-seam 5 項（共 35）：T24 live fake回放G05/G06 usecase＋messages含原prompt+context＋GET本輪plan零禁POST（score-guard已改為same revision語義，fake planner不人為增加draft revision）、T25 slug可選＋slug一致＋fixtureContext獨立、T26 Catalog有值但Plan缺/錯version不能reuse、T27 exact Plan only reuse true但UNVERIFIED＋G06空稿非credentials＋FAIL優先、T28 G13/14自然partial仍budget2未驗不得PASS。
  - 新增 score-guard 4 項（共 39，保留前 35 意圖）：T29 same revision exact reuse→UNVERIFIED且reuse true（真評分）、T30 missing/null/modify→reuse false且不可PASS（真評分）、T31 same revision但run failed仍FAIL（真評分）、T32 fake live回放same revision exact reuse→UNVERIFIED且reuse true（真函式，不只字串檢查）。
  - 新增 live-review 3 項（共 42，保留前 39 意圖，僅離線覆核r102真證據，不新跑模型）：T33 G08 planner-only same revision→UNVERIFIED非產稿錯誤（真評分；author failed仍FAIL，G07/G10不可改PASS）、T34 G13/14 budget2前置不符 same revision→UNVERIFIED（真評分；succeeded無partial＋production8/12/180未套budget2；author failed仍FAIL）、T35 G13真正HTTP/continue失敗仍FAIL不批次抹fail（真評分）。
  - 僅回放腳本契約，不是 live 產品；不以 fake 結果當 builtin 基準。
- 證據（score-guard，不覆寫舊）：`/private/tmp/whippet-m10-golden-score-guard/`（`summary.json`、`baseline.json`、`runs.json`、`tasks-valid.json`、`tasks.json`、`offline-replay.json`）。不覆寫前任 `/private/tmp/whippet-m10-golden-evidence/`、`/private/tmp/whippet-m10-golden-repair/`、`review2`、`/private/tmp/whippet-m10-golden-preflight-r102/`、`/private/tmp/whippet-m10-golden-manifest-r102/`、`/private/tmp/whippet-m10-golden-final-seam/`。
- 離線覆核新證據（parent t3d，唯讀r102不覆寫，不產品網路/API/模型/live）：`/tmp/whippet-m10-golden-live-review/`（`REVIEW.md`、`reviewed-verdicts.json`＋`baseline-check.json`、`offline-replay.json`最小離線測）。原14題JSON不改；raw 7PASS/5FAIL/2UNVERIFIED不改。
- 邊界：只讀寫本檔、QA 腳本（baseline/offline）與 PM 固定契約 v1/v2/v7/v8/v10 相關 HTTP 段落；不讀產品原始碼／DB／journals／deploy／`.env.ai`／真憑證；不安裝／部署／重啟／Git／子代理；禁碰 18087／18187／19187；只離線修正，禁止 live mutation；不跑 env／printenv 探查。
- 連線：預設 Web `http://localhost:18087` API `https://127.0.0.1:18089` 僅為舊相容值，live 禁用；production 嚴格僅認 UI／API 皆 `http://127.0.0.1:19087`（經 URL 解析，不用 CA，經同源 nginx 代理，本輪 NOT_RUN）；fixture 19187 已知為專用 budget1，不當基準；18087 禁止碰，18187 停用，不自行重啟；不可從容器取 key。
- PM 前置需求（live 前必齊，否則 `BLOCKED` 零 mutation）：19087 精確 UI／API（皆 `http://127.0.0.1:19087`）＋模型接線（PM 處理）＋全新 QA 專屬 manifest v1（workspace＋catalogSeeds＋ownership＋productionBudget）。本輪 live 仍 `NOT_RUN`，不宣稱可 live。
- 精確啟動參數（待 PM 補 19087＋manifest 後執行，含 mutation；本輪僅離線，不執行）：
  ```sh
  WHIPPET_UI_URL=http://127.0.0.1:19087 WHIPPET_API_URL=http://127.0.0.1:19087 /opt/homebrew/bin/node scripts/test/m10-golden-baseline.cjs --run-live --allow-mutation --fixture-manifest /private/tmp/whippet-m10-golden-owned-fixture/manifest.json --out /private/tmp/whippet-m10-golden-score-guard
  ```
  雙 `http://127.0.0.1:19087`（UI/API皆嚴格19087，經URL解析）；manifest上路徑 `/private/tmp/whippet-m10-golden-owned-fixture/manifest.json`；新live證據目錄 `/private/tmp/whippet-m10-golden-score-guard`（不覆蓋舊，含 final-seam）。缺 `--allow-mutation` 直接 `BLOCKED`；UI／API 任一非嚴格 19087 直接 `BLOCKED`；manifest 缺／錯直接 `BLOCKED` 零 mutation；前置 GET（workspace／catalog）缺任一直接 `BLOCKED`，不 confirm／publish。
- 真模型接線由 PM 處理；fixture 18187 僅為合成站敘述，不冒充 builtin；能力不存在記 `UNVERIFIED`，不假 `PASS`。不重跑 M1–M9。
- 前任 ID `10000000-0000-4000-8000-000000000001`：僅查前任 5 檔（baseline/probes/summary/tasks-valid/tasks.json）均無此 ID，明示 `unknown`（不推測自建或 fixture，discard 影響亦 `unknown`），不另做 mutation 查證；本輪 live 均使用 manifest 指定 workspace 且新建獨立 owned Test，cleanup 僅 owned 且防呆該 ID，seed 不可 cleanup，不刪 Workspace。

## 離線驗證（score-guard，無 mutation，零產品網路）

```sh
/opt/homebrew/bin/node scripts/test/m10-golden-baseline.cjs --out /private/tmp/whippet-m10-golden-score-guard
/opt/homebrew/bin/node scripts/test/m10-golden-offline.cjs --out /private/tmp/whippet-m10-golden-score-guard
```

## PM live（待 PM 補 19087 參數＋manifest v1 後，含 mutation；本輪 NOT_RUN）

```sh
WHIPPET_UI_URL=http://127.0.0.1:19087 WHIPPET_API_URL=http://127.0.0.1:19087 /opt/homebrew/bin/node scripts/test/m10-golden-baseline.cjs --run-live --allow-mutation --fixture-manifest /private/tmp/whippet-m10-golden-owned-fixture/manifest.json --out /private/tmp/whippet-m10-golden-score-guard
```

缺 `--allow-mutation` 會直接 `BLOCKED` 退出，不建立任何資料。manifest 缺／錯、`UI/API` 非嚴格 19087、前置 GET 缺任一，皆 `BLOCKED` 零 mutation，不 confirm／publish。live 完整性以實跑為準，未跑仍 `UNVERIFIED`，不宣稱完成。
