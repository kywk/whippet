# t4t → t4s：單次 planner 與 draft 審閱

時間：2026-11-14 01:06 Asia/Taipei。hc get t4t 核 YOLO、parent=t4s、working；未派 agent。

## 結果與實際 IDs

- Workspace：f7918b78-2171-47cf-b000-407ca05f86d3，公開 revision/authRevision=2，active/confirmed，buyer configured，credentialLogin/aiExecution 可用。
- 固定 login seed：21457a77-f2f7-4f84-a24f-f63f0ce53497，公開 versions 已核。
- Use Case：7bb3430f-3acc-4eb6-ba72-556441acc145。
- Editing session：6947dc0f-9417-4b36-b0e9-c57c88f713bc。
- 唯一 planner Run：d97e63a7-57f4-4546-93d1-a22d7a241570，succeeded。
- Attempt：efb4d1f1-1ab7-4998-ab4b-e699eaf7f752。
- Plan：b7c83de2-5b1f-4531-b526-ba4d65682045；原始 r1 保留，依 PM 明確授權單次 PUT 後 r2/draft。
- Run slotReleased=true、cancelRequested=false；session pendingRunIds=[]、reclaimPending=false。完成 planner 後本環境 active/unreclaimed=0；修訂後 GET 再核 draft r2 與空 pending/無待回收。

## 證據與變更

- m10_shop_t4r_fixture.result.json：原建立 Use Case HTTP400 前的 exclusive intent，未覆寫；當時沒有 test/session/Run。
- m10_shop_t4t_recovery.receipt.json：HTTP400 分類與原 intent SHA、無資源/active/unreclaimed 的唯讀證據。原因為 usecase 傳 slug 違反 CreatePlatformTest 與 migration011。
- m10_shop_t4r_fixture.py：僅移除 Use Case slug，將 exclusive state 改為 m10_shop_t4t_recovery.result.json；三 Module slug 與原 proposal 保留。依 PM 修復授權只執行一次修正後流程，planner 總共一次。
- m10_shop_t4t_observations.jsonl：公開 Run/session 安全投影。
- m10_shop_t4t_public_plan.json：未修改的原始 AI Plan r1。
- m10_shop_t4t_review.json：原 r1 檢查、SHA 與當時待補項。
- m10_shop_t4t_plan_revision.request.json / m10_shop_t4t_plan_revision.diff：唯一手動 PUT intent 與 description diff。
- m10_shop_t4t_public_plan_r2.json：更新後 Plan。僅 order/verify description 新增獨立搜尋前置與 verify 當次商品表單 quantity2 建立新 UUID；逐 Stage 比對確認 args、斷言、意圖及其他欄位未變。

## Compose 的 binding 證據

唯讀原始碼 services/server/internal/server/plan.go:298–310：每個 Stage 不論 bind 是否存在，均生成 const _stageN = await test.step(...module({page,...args}))，並以 results[s.ID]=local 保存回傳值。binding 以 results[arg.StageID] 查前序，再逐 path 取值，不依賴 Bind 欄。
因此本 Plan 的 search 輸出落在 _stage1，order 的 productId/price 取得 _stage1["productId"]/_stage1["price"]；order 輸出落在 _stage2，verify orderId 取得 _stage2["orderId"]。這是現行確定性生成器的程式證據，未宣稱本次尚未執行的 Compose 或 Module validation 已通過；產品碼未改。

## 驗證與 PM 待審閱

AST、request content 長度、exclusive recovery path、四 Stage action 順序、固定 seed、三新 slug、正向 bindings、三份 loginAs/受保護頁前置皆 PASS。修訂後 GET 與保存 r2 相同，僅兩份 description 改動，仍 draft。
PM 最後核閱 r2 與 diff 後，confirm 屬下一個獨立授權步驟。本輪沒有 confirm、Module author、summary、publish、正式 E2E，也未部署、改 DB、讀憑證/env/raw logs、修改預算/skills 或 Git 操作。

## PM confirm 後唯讀觀察（2026-11-14 01:06 Asia/Taipei）

PM 單次 confirm 後，本 owner 僅 GET 與本環境 Run 安全投影。Plan 已 stopped/r4：login ready、search failed、order/verify pending。未執行 retry/summary/publish/再次 confirm。

- Search Module：64738e4b-c378-4c05-82ea-10dc20164e99。
- Author Run：89e442bb-4117-4063-98c3-b7ae1018a247，failed。
- Attempt：4f2e47c9-b9b6-434b-bb0c-c48ec9926f9b。
- Module editing session：b63a9953-1764-4a0a-981c-e7154b3f5452。
- slotReleased=True、cancelRequested=False；pendingRunIds=[]、reclaimPending=false。
- 沒有 validationRunId：正式 validation 未啟動，不宣稱驗證失敗或通過。
- 精確 attempt sidecar 經逐層 O_NOFOLLOW、regular file、≤4096 bytes、重複 key 拒絕、完整固定欄位與型別/enum 驗證。workerObserved=true、terminalClass=LIMIT、selfTestPassedCount=0、selfTestFailedCount=1、三個 checkpoint 旗標皆 false；Manager result present/valid=true、workerStatus=failed、authorArtifactPresent=false、parser/upload未執行、disposition=WORKER_FAILED。
- 分類：已觀測 Worker LIMIT 終止且無成功 checkpoint。自試失敗的具體原因 UNKNOWN，不能由固定計數推論登入、selector、模型供應商或哪一項預算耗盡；未讀 raw logs/journal/env，未更改 budget。
- GET search retry 權威資格：eligible=true、reason=null、planRevision=4、moduleRevision=1、moduleContextRevision=1、authorStatus=failed、validationRunId/status=null、reclaimed=true。這是當時快照，不代替後續 POST 的重新驗證；本 owner 未 POST。
- 證據：m10_shop_t4t_execution.latest.json（公開 Plan、Run 安全投影、session 回收、經驗證 sidecar、retry GET）；m10_shop_t4t_execution.jsonl 保留觀察；m10_shop_t4t_observe.py 僅 GET、DB READ ONLY 及 services/server 本機證據寫入。
- 待 PM：審閱失敗分類與 retry 權威來源，決定是否提出人工修復內容及獨立授權。現有證據不足以指定 selector 等具體修復，不自動重送或刷模型。
