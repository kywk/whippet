# M10.8 黃金任務集 v1（黑箱，可真正執行）

- 定義：`m10-golden-v1.json`（14 題，7 類各 2 題：新建／修復／複用／拆解／越界／注入頁／預算耗盡）。題目定義保留；本輪未改題目內容，僅核對實際欄位（setup.kind/initialScript/budget）。
- 基準：`../m10-golden-baseline.cjs`（本輪已按 PM 8 點修正）。
  - TERMINAL 嚴格 v1：`succeeded/failed/cancelled/timed_out/interrupted`；`timeout/budget_exhausted/stopped/discarded` 非終態。`budget_exhausted` 為 `authorPartial.reason`，transport 仍 `succeeded`。
  - continue revision 必用 `authorPartial.appliedRevision ?? sourceRun.draftRevision/baseRevision`，絕不 `draftAfter/current` fallback；需等待回收＋poll 續跑＋同 body 重試同 Run；409 非未部署（過期/非 partial/未回收）。
  - 僅 404/501/405 算未部署 UNVERIFIED；401/403/409/500 為 HTTP failure；已失敗不被 `m10Missing` 蓋掉。
  - G12 需前後版本/附件可觀測證據，缺證據 UNVERIFIED 不能 PASS。
  - G05/G06 僅 `setContent` 不算 reuse，需同 Workspace 已發布 Module 固定版本＋versionId 綁定；G07/G08 需 `Test kind=usecase`＋Plan 非 null＋stages；未部署不假造；可接受 PM 預備且有 ownership 清單的 fixture，但不得借既有任意 ID；禁止自動發布產品資料。
  - metrics tools 只認 `toolCalls/toolCallCount` 實際數，不用 `allowedTools/registryVersion/tools` 冒充。
  - assistant 須綁 `authorRunId`（runId/run_id 任一等於 authorRunId），不只找任意 assistant。
  - 預設 `--check-only`（無 mutation）：只驗定義（題數 14／類別／合成性／無秘密／無非 `.invalid` 外連＋實際欄位），不碰網路，不建立 workspace/test/session，不觸發 author run。
  - `--run-live --allow-mutation`（PM 指定後才跑）：逐題真跑 public author/session 流程——新建自有 Workspace→新建自有 Test（G07/G08 明確 `kind=usecase`）→`POST editing-session`→（必要時 `PUT draft` 初始稿，嚴格用 `task.initialScript`）→`POST messages`（帶 `editingSessionId＋revision`）→輪詢 `GET /api/runs/:id` 至 v1 終態→讀 `GET conversation?editingSessionId=`／`GET draft`／`GET versions`→按可觀測斷言評分→需要時 `POST validate`／`GET /api/workspaces/{id}/catalog`／`GET plan`／`POST /api/runs/{id}/continue`（等待回收＋poll 續跑＋同 body 冪等重試）→僅 discard 自有 session。每次 run 必新建並記錄自有 IDs，不重用既有 ID（含 10000000-...），不 discard 他人資料。
  - 評分只認可觀測證據（run 終態、draft revision/script、validation succeeded、catalog/plan/continue HTTP 狀態、前後版本、綁定 assistant）；不把 assistant 文字自稱完成當成功；錯誤 HTTP 永不假 `PASS`；`token/tools/latency` 能取則記，否則明示 `unknown`。
  - `catalog` 用 workspace-scoped `GET /api/workspaces/{id}/catalog`（舊 `/api/catalog` 猜測已刪除）；`author` 沿 v7 `editing-session＋messages`；M10 `Plan/continue` 見 v10（continue body 僅 `{editingSessionId,revision}`）。M10 功能未部署（404/501/405）則該題 `UNVERIFIED`，但已存在 author 題仍應可執行。
  - 所有 mutation 預設禁用；`--run-live` 缺 `--allow-mutation` 即 `BLOCKED`。本輪只實作＋離線驗證，live 待 PM 指定。live 完整性仍未確認，不宣稱完成。
- 離線回放：`../m10-golden-offline.cjs`（fake server，零產品網路，零 mutation）。
  - 驗：TERMINAL、原 run revision、timed_out 停止 poll、錯誤 HTTP 不 PASS、null Plan/無 reuse/G12 缺證據不 PASS、cleanup 只 owned ID、metrics/assistant 綁定、定義實際欄位。
  - 僅回放腳本契約，不是 live 產品；不以 fake 結果當 builtin 基準。
- 證據（本輪修復 review2）：`/private/tmp/whippet-m10-golden-review2/`（`summary.json`、`baseline.json`、`runs.json`、`tasks-valid.json`、`tasks.json`、`offline-replay.json`）。不覆寫前任 `/private/tmp/whippet-m10-golden-evidence/` 亦不覆寫 `/private/tmp/whippet-m10-golden-repair/`。
- 邊界：只讀本檔、QA 腳本（baseline/offline）與 PM 固定契約 v1/v2/v7/v8/v10 相關 HTTP 段落；不讀產品原始碼／DB／journals／deploy／`.env.ai`／真憑證（CA 僅 TLS 驗證）；不安裝／部署／重啟／Git／子代理；只離線修正，禁止 live mutation。
- 連線：Web `http://localhost:18087` API `https://127.0.0.1:18089` CA `/private/tmp/whippet-m8-wave/tls/cert.pem`；fixture 18187 已停止，不自行重啟；不可從容器取 key。
- 真模型接線由 PM 處理；fixture 18187 僅為合成站敘述，不冒充 builtin；能力不存在記 `UNVERIFIED`，不假 `PASS`。不重跑 M1–M9。
- 前任 ID `10000000-0000-4000-8000-000000000001`：僅查前任 5 檔（baseline/probes/summary/tasks-valid/tasks.json）均無此 ID，明示 `unknown`（不推測自建或 fixture，discard 影響亦 `unknown`），不另做 mutation 查證；本輪 live 均新建自有 ID，cleanup 僅 owned 且防呆該 ID。

## 離線驗證（本輪，無 mutation，零產品網路）

```sh
node scripts/test/m10-golden-baseline.cjs --out /private/tmp/whippet-m10-golden-review2
node scripts/test/m10-golden-offline.cjs --out /private/tmp/whippet-m10-golden-review2
```

## PM live（待指定後，含 mutation）

```sh
node scripts/test/m10-golden-baseline.cjs --run-live --allow-mutation --out /private/tmp/whippet-m10-golden-review2
```

缺 `--allow-mutation` 會直接 `BLOCKED` 退出，不建立任何資料。live 完整性以實跑為準，未跑仍 `UNVERIFIED`，不宣稱完成。
