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
