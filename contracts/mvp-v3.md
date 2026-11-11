# M3 對話與 AI Worker 契約

延伸 v1/v2；保留 M2 的驗證及明確發佈門檻。每個 Test 一個持久 Conversation，等待人類期間沒有常駐 Worker。

## HTTP

- GET /api/tests/:id/conversation → Conversation {id,testId,messages:Message[],activeRunId?}，首次可建立空對話。
- Message {id,role:"user"|"assistant",content,createdAt,runId?,baseRevision?,baseScript?,appliedRevision?,proposedScript?,validationRunId?}。
- POST /api/tests/:id/messages {content,revision} → 202 {run:Run,conversationId}；revision 必須等於已儲存草稿，空訊息/超過16000字元回400，有未完成author回409。交易保存user訊息與author Run快照。
- assistant baseScript 從 baseRevision 的不可變草稿取得；proposedScript 有產生腳本時即使已套用也回傳，支援重開後前後對照。
- Run.kind 新增 "author"；沿用 GET run、history、cancel 與全域FIFO。
- 對話輪詢：前端在 author queued/running/collecting 時以既有間隔更新；終態後刷新 conversation、draft、history。不需本輪加SSE。
- 失敗/取消顯示Run狀態，可送新訊息重試；已儲存對話與草稿不丟失。

## Dispatch 與 Worker

新增 dispatch payload {kind:"author",script,timeoutMs:180000,author:{conversationId,baseRevision,messages:[{role,content}],validation?:{runId,status,error?}}}。
script 是當下草稿完整快照；messages 取最近12則，最多總32000字元（至少保留本輪使用者訊息）。完整歷史仍保存在DB。validation為目前草稿最近驗證Run的狀態/錯誤快照（error最多4000字元），供下一輪修復讀取。
Worker input 同上加runId/attemptId。Manager保存kind及必要輸入以沿用journal回收/不重跑。
- kind run 仍執行現有 runner；author 使用同映像的獨立 author entrypoint，只有 author 注入AI設定與key。
- AI設定從Manager專用環境讀取並白名單傳給author容器，不寫入input/journal/log；一般run/validation不可取得key。
- author工具迴圈使用原生Responses function calling，穩定x-opencode-session=conversationId，xhigh。最多8次模型請求/12次工具執行，總180秒；錯誤不自動換端點。
- 最小工具：read_draft、read_validation_report、update_draft(script)、browser_navigate(url)、browser_snapshot、browser_click(selector)、browser_fill(selector,value)、request_validation。
- 瀏覽器工具由同一author容器內Playwright執行，計入同一名額；不提供任意shell/eval工具，不在持有key的author程序內執行模型生成spec。
- request_validation只記錄續接要求，author結束回收後由Server建立一般validation任務；不可占住slot等待另一任務。
- 模型生成腳本只修改草稿，永不自動發佈。update_draft保存本輪候選腳本，最終assistant文字允許只提問而無腳本。

## 結果與持久化

author輸出 output/author.json {message:string,script?:string,requestValidation:boolean} 及既有 result.json {status,error?}；author成功不需Playwright報告。
Manager只對author收集/upload author.json（最大2MiB），沿用token/attempt驗證的 /api/manager/runs/:runId/artifacts/author.json；普通run不得接受author.json。Server artifact allowlist與讀取權限依kind檢查。
Server收到author succeeded時，在交易中讀取並核對author.json、當前attempt及輸入baseRevision：
- 草稿仍為baseRevision且script有變更：沿用SaveDraft規則新增revision，保存assistant訊息/appliedRevision，清除舊驗證資格。
- 草稿已被人工修改：不覆蓋，保存proposedScript與衝突說明，讓QA自行檢視／套用；不自動驗證。
- requestValidation且可套用/草稿未衝突：建立固定結果revision的validation，訊息記validationRunId；同author重複result不可產生重複訊息、revision或驗證任務。
- 無script時保留原稿；失敗/取消不得套用候選稿。author result錯誤採固定遮蔽訊息，不回傳provider原始body。
Server author成功檢查和validation成功的兩份報告檢查分開；不得削弱M2發佈條件。

## 前端

新增對話面板與歷史訊息，使用已儲存revision送出；本機有未存編輯時阻止送出並提示先儲存。顯示author狀態/取消/錯誤、產生腳本前後對照與套用結果、續接驗證報告；沿用M2儲存、驗證與確認發佈操作。重新開啟可續接同對話。

## 本輪驗收

以合成網站/本地HTML完成真實模型：產生→同一對話修改→驗證成功→人工確認發佈→重開讀取對話。其餘錯誤/衝突/去重使用mock測試。Contributor流量只送合成測試資料，不傳本機專案程式碼或機密。

## M3 增補：PNG 截圖證據

普通 run／validation 除 HTML／JSON，新增 `data/<40位小寫十六進位hash>.png` 附件；author 仍只允許 author.json。沿用 Manager 上傳 token／X-Attempt-Id 與原 artifact 端點，Manager 先上傳圖片再上傳報告，完成後才送 result。PNG 單張上限 10 MiB，每個 Run 最多 32 張、合計 64 MiB。拒絕其他副檔名與任意路徑。

Worker 保存 Playwright HTML reporter 的相對 `data/` 引用，Server 以 `image/png` 提供附件。HTML 報告維持 sandbox，僅允許同源圖片及原本的 data／blob 圖片，不開放任意 script／connect。成功步驟由 spec 使用 `testInfo.attach` 明確附加 PNG，失敗時由 Playwright `only-on-failure` 自動截圖；trace／video 本輪仍關閉。
