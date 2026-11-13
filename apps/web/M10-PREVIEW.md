# M10.7 Web 交接

目前狀態（第四輪）：前端接線、build、API 邊界檢查，以及桌面／窄版合成 UI 操作目視均通過。固定 dist 與 SHA 已交 PM。**真後端整合未驗，M10.7 整體仍進行中。** 下方前三輪為歷史範圍；第四輪內容優先。

僅合成資料 UI，未串接 API；不代表 M10.7 整項完成。

入口：登入頁與側欄的合成預覽連結，或 `/?preview=m10`。可直接開啟，不需登入。沿用既有 React/CSS tokens，無新增依賴。

- `src/PlatformPreview.tsx`：Module 搜尋、詳情、簽章與固定版本引用者；線性 Stage、參數與回傳綁定；可編輯目標的 Plan 確認/取消預覽；partial checkpoint 說明與繼續預覽。
- `src/platform-preview.css`：獨立樣式與窄版單欄配置。
- `src/main.tsx`、`src/App.tsx`：預覽路由與入口。

所有按鈕只更新 React 本頁狀態，不持久化、不排程、不執行、不驗證、不發佈。沒有模擬 API wire contract。情境選單提供待確認、執行中、partial、停止；重新整理重設。

## 實際檢查

2026-11-13：`npm --prefix apps/web run build` 通過（含 `tsc --noEmit`），`git diff --check -- apps/web` 通過。未執行 M1–M9 測試。

目視尚未完成：CUA 瀏覽器主機不可用，Chrome 原生視窗回報 `cgWindowNotFound`。待檢查桌面/窄版、搜尋空結果、三種 Module 切換、Plan 修改/確認/取消、partial 繼續與頁面無橫向溢出。

## 等待真 API 的接縫

1. Catalog：Workspace 範圍的列表/查詢、Module 版本、簽章、輸入回傳、Harness 驗證結果、引用者與依賴版本。
2. Use Case：revision 的 stages、固定 module version、參數與回傳綁定、內嵌步驟，以及 Server 產生的 spec。
3. Plan：讀取/修改/確認/取消與伺服器狀態；逐 Stage 的 run ID、進度、失敗原因。需接上重複點擊防護、請求錯誤與結果不明時重新讀取。
4. Partial：Run 的 partial、checkpoint revision、最後自我試跑結果、next step；繼續端點與 attempt 關聯，由 Server 決定恢復方式。
5. Compose/發佈：沿用真實驗證、摘要、revision 核對與原子人工發佈；目前按鈕停用。

接 API 時應以確認後契約建立 adapter，把此預覽的純 UI view model 替換為真實資料；不可將本檔合成型別直接視為服務契約。

## 第二輪：真 Catalog 與 partial Continue 接線

2026-11-13 依 PM t3d 指示新增；取代上文第 1、4 項「尚未接線」狀態，但不代表已完成真後端整合驗收。

- 真 Catalog 入口：登入後側欄「Module 模組庫」。`ModuleCatalog.tsx` 呼叫 `GET /api/workspaces/{id}/catalog`；展示已發佈模組、簽章、版本、引用者與驗證狀態。載入中／空清單／錯誤分開處理，沒有合成 fallback。
- `types.ts`／`api.ts`：解析 Catalog 與 `Run.authorPartial`；Continue 僅送 `{editingSessionId,revision}`，只接受 202 `{run,conversationId}`。mock adapter 不提供這兩項能力。
- `ConversationPanel.tsx`：部分完成卡顯示 nextStep、checkpoint 與正式驗證差異。revision 固定使用來源 `Run.authorPartial.appliedRevision ?? Run.draftRevision`，後者對應 Server `r.draft_revision`；絕不 fallback 到目前 `Draft.revision`。缺值、週期/測試不符、草稿不一致或有活躍 Run 時不可送出。
- 繼續只由明確點擊觸發，與訊息送出共用鎖。409 或不明結果先鎖住；使用者需重新讀取草稿／對話並確認後，才可再次明確點擊。草稿已變更則維持拒絕；不換 revision 自動重送。Worker 回收、context 與去重由 Server 最終裁決，不宣稱 UI 已驗證回收。
- `components.tsx`、`trail.tsx`、`activity.ts`：partial 不再顯示為一般「撰寫完成」或發出全程成功通知。
- Plan／Stage 與 `?preview=m10` 仍是明確合成預覽，與真 Catalog 分離。

檢查：`node apps/web/scripts/check-m10-api.mjs`（無網路、合成 response）涵蓋 Catalog/引用者、partial 有無 checkpoint、非法 hash、Continue 精確 payload、202、拒絕非 202、409 不重送、端點不可用；build 含 TypeScript 與 diff check 通過。未重跑 M1–M9。

限制：真 Server 正在開發，未執行真 Continue 寫入、未完成端到端驗收。目視再次嘗試仍回報 browser access host unavailable，故目視保持待驗。既有 5187 只服務靜態 dist，沒有新增代理，也無法替代真 API 主機；真 Catalog／Continue 需由既有部署入口驗收。未重啟共享服務。


## 第三輪：真 Plan／Stage 與整批摘要／發佈

以 v10「Plan 控制面」「批次 acceptance-summary」「批次摘要唯讀 UI 接縫」為準，沒有新增自訂後端欄位或代理。後端仍實作中，PM 待固定版本部署後安排真整合。

### 入口與行為

- 側欄新增 Use Case；以 Test.kind=usecase 辨識。Use Case 編輯頁「驗證與發佈」使用真 `PlanPanel`，不掛載單 Test 的自動摘要／發佈卡。
- `GET /tests/{id}/plan?editingSessionId=...` 讀取 `{plan}`；Stage 逐項顯示順序、複用/修改/新建、狀態、固定來源版本、候選版本、參數、綁定、Run ID 與錯誤。
- 提供進階 Stage JSON 編輯，1–32 項、唯一 ID、前向引用限制、保留參數鍵檢查；PUT 僅送可編輯欄位。Plan revision 與草稿 revision 分開保存，初次 planRevision=0。開始編輯後捕捉 CAS 基底，背景讀取不替換本機編輯或偷偷換新 revision。
- confirm/cancel 只由明確操作送出，解析 `{plan}`；取消後明示回收尚待 Server，stopped 需修訂後重新確認。寫入皆有鎖與中止清理；409 或不明結果需明確重新讀取，不自動重送。
- GET `/plans/{id}/summary` 嚴格讀取 `{summary:null|PlanSummary}`；POST 同路徑接受 200/202 `{run}`。不讀取 EditingSession.summary 作為批次 fallback。
- 批次確認同時列完整 candidates（名稱、slug、類型、revision、versionId、testId、bundleHash）、整批說明與背景、batchHash、摘要 Run/Plan revision。
- 只有同 Plan/revision、成功非 stale、publishReady=true、摘要內容完整，且 Stage 的候選集合與摘要 candidates 完整一致，才開放人工確認。reuse 不列為新發佈候選。確認綁定當下完整 Plan/summary，任一變更即失效。POST publish 僅送 planRevision/confirmed/summaryRunId；Server 仍需交易重核。
- 尚未提供的 endpoint、錯誤 envelope、範圍不符、缺摘要、候選不符均不顯示假成功。原 `?preview=m10` 保留為隔離且明示的合成設計預覽，不作真控制面 fallback。

### 本輪檔案

- 新增 `src/PlanPanel.tsx`、`src/plan.ts`。
- 修改 `src/types.ts`、`src/api.ts`、`src/App.tsx`、`src/TestWorkspace.tsx`、`src/DraftEditor.tsx`、`src/platform-preview.css`。
- 擴充 `scripts/check-m10-api.mjs`；本交接檔亦在 apps/web 內。未寫根 scripts、docs、contracts 或根設定。

### 實際檢查與未驗項

- `npm --prefix apps/web run build` 通過，含 TypeScript。
- `node apps/web/scripts/check-m10-api.mjs` 通過；新增 Plan envelope/null/scope、PUT 白名單與 CAS、confirm/cancel payload、summary 200/202、批次摘要 stale/revision/publishReady/候選缺漏或重複拒絕、publish payload、409 不重送、Stage 編輯限制。全部使用明示合成回應，無真後端網路寫入。
- `git diff --check -- apps/web` 通過。
- **目視未驗；真 Plan／Stage、summary、publish 與 partial 後端流程未驗。** 本輪未嘗試真寫入，亦未重跑 M1–M9。M10.7 不標完成。
- 未安裝依賴、未新增代理、未重啟共享服務、未 commit/push。


## 第四輪：本機 Playwright 目視與固定部署封包

依 PM 明確指示改用現有 Node Playwright 與快取 Chromium 1223（148.0.7778.96），不使用失效 browser host，不安裝依賴。既有獨立 5187 預覽維持原服務，無代理／共享服務重啟。

證據：`/private/tmp/whippet-m10-web-review/REVIEW.md`、`results.json`、`review.mjs` 與 desktop-/narrow- 開頭的 28 張最後截圖。API 畫面均明標黃色「合成 API 攔截／本機 UI 目視 · 非真後端驗收」；/api 全部攔截，沒有真後端寫入。

- 1440×1000、390×844：Module 列表/詳情/簽章/引用者/搜尋空結果/503；Plan 編輯/確認/停止/409；完整候選與批次摘要、發佈衝突、stale禁用；partial 409後明確重新讀取/確認再續接。
- 28 個截圖狀態均無 document 水平溢出；pageerror 與未處理 API 路徑皆 0；最終完整腳本 exit 0。partial 共4次明確點擊，均使用來源 revision=4，沒有換 revision 自動重送。
- 實際修正：Use Case 不再沿用單 Test 的自動摘要／四站進度；關閉抽屜不暴露畫面外操作；窄版分頁列完整保留關閉按鈕；合成 Plan 新建示例改成 Module。修改僅 `ConversationPanel.tsx`、`DraftEditor.tsx`、`activity.ts`、`PlatformPreview.tsx`、`styles.css`。
- 最後 build（含 tsc）、API 邊界腳本、diff check 通過。未重跑 M1–M9。

固定原樣 dist：`/private/tmp/whippet-m10-web-review/fixed-dist/`。
部署封包：`/private/tmp/whippet-m10-web-review/whippet-m10-web-dist.tar.gz`。
SHA-256：`da57ff8c2354fac99cdc8b96a57801801bf735fc7fa37708ae7484d7a38c370a`。
封包與逐檔清單：同目錄 `archive-SHA256SUMS`、`dist-SHA256SUMS`。

交 PM 部署；尚未驗證真模型、真後端 Plan/partial、Worker回收與原子發佈。M10.7整體不標完成，未 commit/push。

## 2026-11-13：真 API 回歸與 Module 手動入口

- 19087 seed-null 修正映像已實際目視：歷史首頁不再 INVALID_RESPONSE，Catalog 空狀態與 Workspace 設定正常。owned Module 成功／失敗 HTML 報告可開啟，失敗明細顯示 Stage 1 prepare 通過、Stage 2 verify intentional-mismatch；UseCase GET Plan 200 null 顯示空狀態。桌面 1440 與窄版 390 均無 pageerror、HTTP 錯誤或水平溢出。
- 真證據：`/private/tmp/whippet-m10-web-review/real-backend/2026-11-13T05-18-47-727Z`（20 張，無 API 攔截）。保留初始首頁 FAIL 於 `2026-11-13T05-12-02-366Z`。此輪選取 UseCase 時各 viewport 有一次冪等 editing-session POST，不能宣稱零 mutation；未執行 Run、摘要或發佈。
- 已定位初始編輯模式在 Test 尚未載入時誤判缺 session。修正等待 Test 回應、既有 pointer 用 GET、GET 失敗不自動 POST；新版真部署待 PM 驗證。
- 依 t4b 確認的既有 API 補新增 Module（slug/name/description），以及完整 metadata／harness／本體的手動編輯。slug 只採 Test 回應且不可改；完整 Module 一併 PUT，使用 session+revision CAS；409 禁止自動重送，須重新載入。UseCase 本體唯讀，走 Plan/Compose。
- 加入 Module create/parse/full-save/409 API 邊界。歷史 listVersions 僅接受明確 null；新 publish/batch 維持 string，不以寬鬆型別掩蓋缺欄位。
- 5187 合成攔截操作證據：`/private/tmp/whippet-m10-web-review/module-ui/`，建立／編輯／儲存／409／既有 session GET，desktop 1440×1000、narrow 390×844。畫面明標合成，不能當真後端寫入驗收。
- 限制：Module 新入口與 session 修正尚待新版部署後真 API 驗證；無真模型、Plan 執行／整批發佈、partial Continue 真流程驗收。M10.7 整體不標完成。

## 2026-11-13：新版部署後 owned 真 UI 定向驗證

PM 部署 image `2f9bf238a8f474ed1acdf3e8fef73ec13dde2beb4cce74812688963f694b0d0b` 至 19087 後，使用真同源 API、無攔截完成：

- UI 新建 `m10-web-fixture-1794547552297`，Test `34d6ad61-0cb8-4308-b893-9d29dd7d3147`，editing session `0fb78d53-cad8-4237-9b58-f2ff4a086b19`。
- 完整 body／metadata／harness 真保存 revision 2，重新登入選取後逐欄比對一致；390×844 窄版亦重開確認。
- 只對本輪 owned 草稿，以目前 revision 2 的完整 CAS PUT 更新至 revision 3；原 UI 使用舊 revision 保存得到預期 409，保留未儲存內容、禁用儲存。觀察 4 秒僅一次 PUT，沒有盲重送。使用者明確確認放棄並重新載入後讀到 revision 3，未覆寫外部更新。
- 既有 UseCase `52cf7b3c-1223-4b90-bc4d-cfc59fc22a6d` 左側選取與 Plan 空狀態，desktop／narrow 均只有 GET，零 POST／PUT；已驗證 session 載入競態修正。
- 8 張真畫面與請求狀態：`/private/tmp/whippet-m10-web-review/real-backend/owned-2026-11-13T05-25-52-297Z/`。腳本 `real-backend/owned-module.mjs`；results.json 記錄 IDs、狀態與斷言。無 pageerror、非預期 HTTP 錯誤或水平溢出，409 為指定測試的預期結果。
- 沒有呼叫模型、summary、publish、validate 或 continue；未碰 18087。保留 owned fixture revision 3 供 PM 追溯。沒有新產品程式變動，原固定 dist/SHA 不變，不需為此文件重建。
- 尚未驗證真 Plan 執行／Stage 產稿／整批發佈及 partial Continue；M10.7 整體維持進行中。

## 2026-11-13：owned UseCase 真 Plan draft 最小切片

- 僅 19087、無 API 攔截。新建 `m10-web-plan-fixture-1794547718681`，Test `99f1a379-3937-4211-995f-b8420f9778fe`；session `0d687f71-62c0-4848-89cb-7705aa797f3d`，草稿 revision 1；Plan `c77cdc38-8c2e-4e15-8ac7-88d33ced49d0`，最終 draft Plan revision 2。未改動 t4b UseCase。
- 初始 GET `{plan:null}`。32 個 action=create Stage 皆明標合成 Module 描述、只保存不執行；UI PUT200 得 Plan revision 1。桌面／窄版重開逐項核對順序、巢狀 literal、前一階段 binding path、bind 全部一致。
- 第 33 Stage 的 UI 本機檢查拒絕且未發 PUT；以同一 owned UseCase 直接送出 33 Stage 得 HTTP400 `invalid_request`，再次 GET 仍為 null；沒有以無效請求產生 Plan。
- 開啟 editor 鎖定 Plan r1 後，僅 owned Plan 外部 CAS PUT 更新至 r2；舊 UI 保存真409恰一次。輪詢4秒後仍保留本機 JSON、禁用儲存，無盲重送。明確重新載入不替換本機編輯 CAS；放棄本機編輯並再次修訂才讀到 r2 的完整內容。
- 最終證據（9張、desktop1440×1000/narrow390×844、無pageerror/非預期HTTP錯誤/溢出）：`/private/tmp/whippet-m10-web-review/real-backend/plan-2026-11-13T05-29-12-156Z/`。第一次建立UseCase及腳本selector失敗保留於 `plan-2026-11-13T05-28-38-681Z/`；測試定位由button修為實際tab後沿用同一owned Test，未重複建立。
- 未 POST confirm/summary/publish/continue/validate/messages。Plan UI 僅自動 GET 批次摘要（null），沒有排任務；32筆Module僅Plan描述，未建立Module或宣稱驗證／發佈。固定dist/SHA不變，本輪只追加此紀錄與tmp證據，無需重建。
- 真 Plan 執行／Stage產稿／批次發佈與 partial Continue 仍未驗，M10.7整體維持進行中。

## 2026-11-13：發布後 GET storm 修正（合成回歸）

- 真發布原證據保留於 `/private/tmp/whippet-m10-web-review/live-next/2026-11-13T07-11-10-011Z`：publish200僅一次，接著Test/versions各1903次GET，UI卡載入。後續版本/Catalog只讀核對通過不掩蓋此UI缺陷。
- 以 `scripts/check-publish-settle.mjs` 在獨立5187攔截合成API重現真React路徑，畫面明標合成。4秒測量窗口中，修前desktop 8882次／narrow9292次Test+versions GET，後2秒仍4712／4694次，publish各一次。證據 `publish-storm/red-valid-fixture/`；初版fixture缺Workspace欄位的測試建立錯誤另留 `publish-storm/red/`，不算產品重現。
- 根因：App傳給TestWorkspace的inline onModeChange在每次render改變identity；session published effect依賴它並retry Test/versions，onTestUpdated回寫父層後再render，形成循環。只把callback綁定穩定selected Test ID，用useCallback保持identity；不更改輪詢上限、publish/session API或CAS語意。
- 修後同一4秒窗口：desktop/narrow成功均4次GET，後2秒新增0；概覽模式穩定、無載入骨架。409/503各自只POST一次，零Test/versions重抓、不開新session、不要求摘要，保留編輯模式且發布禁用。六情境PASS、無pageerror/水平溢出。綠燈與截圖：`/private/tmp/whippet-m10-web-review/publish-storm/green/`。
- 驗證：`npm --prefix apps/web run build`（含tsc）PASS；`node apps/web/scripts/check-m10-api.mjs` PASS；`REVIEW_OUT=<tmp> node apps/web/scripts/check-publish-settle.mjs` PASS。回歸只用已存在worker Playwright與Chromium，可用CHROMIUM_EXECUTABLE指定路徑，不安裝依賴。
- 變更僅 `src/App.tsx`、新增 `scripts/check-publish-settle.mjs` 與本紀錄。新版固定dist另交PM；尚待部署後驗證，不重做已成功真發布。本輪無真fixture寫入。
- Server新image38700cb5f0e4e1bd815dc7977219c22cf473a228c7a81ad4481c6a3cd721eb16部署後，依PM授權單次公開GET原closed session Plan HTTP200，實讀a4c96e46-b57f-4bdb-9d8f-150f4b8c9af7 done/r4，兩Stage ready。證據 `/private/tmp/whippet-m10-web-review/live-next/plan-done-public-get.json`，原GET409證據保留；不以發布200推論done。
- partial尚未真驗，M10.7整體維持進行中。

### 失敗 Stage 人工修復（2026-11-13，合成驗證）

依 contracts/mvp-v10.md 固定 retry wire 新增 `StageRetryForm.tsx`，failed create/modify Stage 可查詢資格；原 Module/session、author/validation 狀態、回收證據及三 CAS 明列。人工修復指示必填、最多 16000 Unicode code points、保留原文；文字或資格快照改變清除獨立確認。未知／缺欄／source null／未回收／非 eligible 不可提交。409 與不確定結果鎖住，須明確重新載入、重新人工確認；不自動重送或替換 CAS。

POST 回應可能是冪等歷史 Plan，故成功後另 GET 現況，不把歷史 running 回應當正在執行。仍走整批候選驗證／摘要／發布，不獨立發布 Module。

檢查：`npm run build --prefix apps/web`、`node apps/web/scripts/check-m10-api.mjs` 通過。`check-stage-retry.mjs` 使用既有 5187 預覽、完全攔截合成 API、畫面明標非真驗收；桌面／窄版各驗歷史 receipt、409、503、content/snapshot 清確認、source null/reclaimed=false、未知 reason、網路中斷。無 pageerror／水平溢出，寫入案例各一次，禁用案例零次；歷史 receipt 另保存 response 與 GET 現況。未呼叫真 API／模型／部署。

證據 `/private/tmp/whippet-m10-web-review/stage-retry/{latest,extra,history-receipts}/`；固定包 `fixed-release/whippet-stage-retry-dist.tar.gz` SHA256 `0d8d1c968f7154ad97771f534bf4ad54a44bc0a71e58626ff25f1d9e68e0cd95`。保留舊包，真重試待 PM 授權，M10.7 未自行標整體完成。
