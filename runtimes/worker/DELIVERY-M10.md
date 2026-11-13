# M10 Runtime／Manager 交付

2026-11-13；owner 範圍為 runtimes/worker、services/manager。共同契約與追蹤由 PM 維護。本紀錄區分本機執行證據及 Server owner 回報，未部署共享服務。

## 已接線

- M10.1：AgentEngine/builtin、registry 分派、快照修剪、budget 守衛。完整 v10 test-author 預算耗盡輸出 partial；v9 保持 limit，舊接收端沒有新欄位。checkpoint/script 從最後自試通過候選閉包重建，遮蔽改 bytes 即丟棄，requestValidation=false。
- v10 history 走 generic tool_request/response → Manager /tools；v9 原通道保留。provider opaque call ID 映射穩定 transport UUID，核對 attempt/權限/scope，取消、遲到與重送不混用結果。
- M10.2：manifest/main/reference 原始 bytes hash、模型與預算快照、reference 按需載入。四個平台 skill 及 Playwright test.step/locator 指引已提供。
- M10.4：files[]、@lib、固定入口、檔案數/大小/路徑/來源守衛、Manager 傳遞與 Stage 失敗報告。
- M10.6：registry 10.1 八工具接線。Worker/Manager 支援嚴格巢狀 schema subset、UTF-8/JSON/depth/數量/UUID 限制與污染鍵拒絕，未宣告參數不因繼承屬性通過。provider 表示可移除 extension keywords，但守衛仍用原始權威 schema。
- module-authoring/usecase-planner 嚴格使用 author.platform，頂層/缺欄位/重複位置/一般 primary 帶欄位拒絕。只有實作工具可列 allowedTools；模型及輔助 skill 不能提升權限。
- Module 本體與 harness 一起真自試，只有最後通過的雙檔候選可成終稿；失敗不覆蓋，模型不能注入 metadata。遮蔽改 bytes 拒絕候選。Module 預算失敗不輸出 partial。
- Planner 只從最後成功 propose_plan 回覆取得 UUID candidateRef，canonical stages 先驗型；模型 final 只有 message/conversationSummary。確認、排程、發佈仍歸 Server/人工流程。
- author.json 只有權威 module-authoring Run 可達 25 MiB，其餘 13 MiB；Manager open/read/parser/sanitize/upload 全路徑依 Run 選限。raw script/harness 各 2 MiB。
- 26 MiB frame 僅三個指定 Module 內容工具；回覆以 pending requestId 查原工具，未知/取消 ID 不傳遞。其餘工具 14 MiB，credential/history 64 KiB。
- M10.5 batch summary：author.batch 僅 acceptance-summary，4 MiB、最多 32 去重排序 Module、模式/session null 規則、metadata 無 harness 正文、hash 與成功 evidence 驗型，完整轉送與注入 prompt。零工具、原 summary final/13 MiB 不變；不自行重算 Server batchHash 或授予發佈資格。

## 實際檢查

- Worker build PASS；author 測試 65/65 PASS、0 SKIP，log `/private/tmp/whippet-m106-author-tests.log`。最後 schema 繼承屬性修正另跑 schema 3/3 PASS。
- 新平台測試含 nested/null/unknown 欄位、候選/終稿注入、失敗後保留、預算不 partial、雙檔遮蔽失效、pending ID/frame 限制。
- 真 Playwright Module 本體+harness 自試：純計算成功一筆、錯誤回傳值失敗一筆，兩筆都走實際子程序及 @lib 寫檔/解析；不等於網站或真模型驗收。
- Manager build PASS；`Test(M105Batch|M106Nested|M106Module|M106Registry|M106Generic|V10Registry|M10PartialArtifact|M10HarnessFrame)` 11 頂層項 PASS，含 partial 15 拒絕子案例、25 MiB read/open/upload/parser 恰上限與 +1 拒絕、約 24 MiB escaping 候選、遮蔽及大型 Catalog 結果。
- `TestM106PlannerRealAuthorIPC` 非 SKIP PASS：真 Node → Manager → 隔離合成 TLS handler，4 model requests / 3 generic IPC / 3 success / 0 failure / 1 artifact upload；opaque ID 保留。
- Server owner t4b 回報真 Server/PG planner bridge 非 SKIP PASS：同上三工具 → artifact 上傳 → canonical candidateRef CAS 成 draft Plan。
- Server owner t4b 回報 Module bridge 非 SKIP PASS：3 model requests / 0 generic IPC / 2 tool success / 0 failure；雙檔純計算自試 → Manager parser/upload → Server metadata/CAS → 回收後唯一 validation。初始 fixture scope 與需瀏覽器的 harness 已修正，最終 PASS；未下載瀏覽器。
- M10.1 Server owner 回報真 Server/PG partial bridge 非 SKIP PASS：1 次模型請求耗盡 → Manager parser/upload → Server 保存 → 回收前 409 → heartbeat 回收 → 重送 continue 同 body 只一筆新 Run，source 關聯恰 1。
- M10.4 已另行明確啟用既有 Chrome smoke：手動 Module+UseCase 成功/刻意失敗各一，HTML/JSON 可辨識 Stage 2。證據目錄：`/private/var/folders/0n/ycjdyc553gx4ywrtpmtnwp2h0000gq/T/whippet-m10-bundle-pass-juQrTJ/output/` 及 `whippet-m10-bundle-fail-RDl5Wh/output/`。
- git diff --check PASS。使用已存在 Node/Go/Playwright，未下載依賴。

## Bridge handoff

Manager `TestM106PlatformServerBridge` 使用既有 WHIPPET_M10_BRIDGE_URL/CA/TOKEN/INPUT/RESULT/WORKER_ENTRY。TOKEN 必須 synthetic- 開頭，CA 為測試公用 CA；不讀取正式金鑰。新增 WHIPPET_M106_BRIDGE_CALLS 指向合成 JSON 陣列 `[{name,arguments}]`，依序執行已授權平台工具，最後產生 message。預算至少 calls+1 次模型請求。

Manager 真正 collect/parser/upload 後才寫安全 handoff：runId、attemptId、result、artifactUploaded、partial、checkpoint。Server fixture 再套用 terminal、回收與驗證 CAS。失敗僅輸出白名單 safeCode 及呼叫計數，不輸出 payload/token。

## 限制

- 所有模型 bridge 都是合成 Responses，沒有完成 M10.6 真模型「搜尋並複用」或 M10.Z 驗收；不可用本紀錄宣稱整個階段完成。
- batch summary Server 交易/批次發佈驗證由 t4b/PM 接續，Runtime 不裁定版本資格。新 primary 的 Server enqueue 啟用由 PM 統一決定。
- skill-creator quick_validate.py 因本機缺 yaml 未執行，依限制未安裝；專案 loader/hash/size/reference 測試已驗實體套件。
- 未 commit/push、部署、重啟共享服務、安裝依賴、讀取正式憑證、執行禁用腳本或重跑 M1–M9 全套；未新增代理、未修改共同契約/根設定/docs。

## M10.5 batch summary bridge 補充

Manager `TestM105BatchSummaryRealAuthorIPC` 非 SKIP PASS：真 Node → 合成 TLS Responses（只回原 summary final）→ Manager parser → 實際 HTTPS author.json upload，1 model request / 0 generic IPC / 0 tool success / 0 tool failure / 1 upload。模型請求的 tools 為空；從 Saved draft snapshot 解析出的 batch 與權威輸入完整深度比對，包含 hash/module/evidence；不輸出 payload。

Server owner 可呼叫 `TestM105BatchSummaryServerBridge`，環境沿既有 WHIPPET_M10_BRIDGE_URL/CA/TOKEN/INPUT/RESULT/WORKER_ENTRY，不需要 WHIPPET_M106_BRIDGE_CALLS 或任何真模型設定。input 必須是完整 acceptance-summary + author.batch、allowedTools=[]、maxToolCalls=0。安全 handoff 沿通用 result，另有 batchPromptChecked=true；Server fixture 再驗持久化及 batch CAS。此本地 PASS 不代表 Server/PG 批次發佈整合已通過。

### Server owner 最終三端回報

t4b 回報 `TestM105BatchSummaryServerBridge` 已接真 TLS Server／PG 非 SKIP PASS：完整 batch prompt、1 model request／0 IPC／0 tool／1 author artifact upload，後續 Server 收尾 CAS、reclaim 與原子 publish 均 PASS。此項取代上段「Server/PG 批次發佈整合尚待」狀態。

Module bridge 亦由 t4b 補到真 dist/runner.js 正式雙檔 pure-compute assertion，產生 HTML／results JSON 並真上傳，PG succeeded／reclaimed PASS；不再只有 validation 入列證據。模型仍為合成 Responses，未連真模型；純計算驗證不代表真網站流程驗收。

## 獨立 Module summary 補充

Worker `author/module-summary.ts` 與 Manager `author_module_summary.go` 已接 `author.moduleSummary`：summary-only、與 batch/platform 互斥、拒絕 null/unknown、完整 metadata schema、bodyHash 對 input.script、harnessHash 對 module.harness，這個明確分支的 validationEvidence.scriptHash 對 harnessHash。舊 Test summary 仍對 input.script hash。零工具、原 summary final／13 MiB artifact 不變。

prompt 注入完整 Module metadata/body/harness/evidence，作為資料；接受原始兩檔各 2 MiB、escaping 後 input 超過 13 MiB 的合法輸入（envelope 64 MiB），拒絕任一 raw +1。moduleSummary JSON 上限 13 MiB，發布資格仍歸 Server。

Worker build＋module-summary/batch 定向 5/5 PASS。Manager `TestM10ModuleSummaryStrictHashesAndForwarding`、`TestM10ModuleSummaryRawAndEscapedLimits` 與受影響 batch／既有 author snapshot/final 測試 PASS。本地 `TestM10ModuleSummaryRealAuthorIPC` 及 batch bridge 非 SKIP PASS，各 1 model request／0 IPC／0 tool／1 upload；Module bridge 深度比對完整 moduleSummary、body 和 evidence。

Server 整合入口為 Manager `TestM10ModuleSummaryServerBridge`，沿既有 BRIDGE env，不需要 scripted CALLS。通用 result handoff 新增 moduleSummaryPromptChecked=true。已交 t4b 接真 Server/PG 獨立 summary/publish；在收到結果前不宣稱該三端門檻通過。合成模型，不含真模型或部署。

獨立 Module 三端結果已由 t4b 回報：`TestM10ModuleSummaryServerBridge` 真 Server／PG 非 SKIP PASS，moduleSummaryPromptChecked=true，1 model request／0 IPC／0 tool，真 artifact upload、Server CAS、reclaim、standalone publish、Catalog 固定版本及重送同版本全部通過。此結果取代上段待三端驗證狀態。這筆模型與 validation reports 為合成 fixture；不得誤稱這筆獨立摘要流程已完成真模型或真網站正式驗證。
