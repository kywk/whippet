# M5 Workspace 設定與快照契約

延伸 v2／v3；單一預設 Workspace，不新增登入、RBAC 或任意設定框架。

## HTTP

- GET /api/workspaces/:id → WorkspaceSettingsResponse。
- PATCH /api/workspaces/:id body `{revision,sites?,defaultTestUrl?,timeoutMs?}` → 200 WorkspaceSettingsResponse。
- WorkspaceSettingsResponse：`{id,name,revision,sites:[{name,url}],defaultTestUrl,timeoutMs}`。
- revision 必填正整數；過期回 409。部分更新，sites 提供時整份替換；相同內容不遞增 revision、不使草稿失效。
- sites 最多 20 筆；名稱 trim 後必填、最多 100 字元；URL 為完整 HTTP(S)、最多 2048 字元，禁止 userinfo。defaultTestUrl 可空字串，非空沿用 URL 規則，不強制列於 sites。
- timeoutMs 為整數 1..3600000，預設 60000。name 本輪唯讀。未知欄位（含巢狀欄位）回 400，不接受 secrets、env、key。
- 錯誤沿用 `{error:{code,message}}`，不回傳憑證或原始敏感輸入。

## 快照與併發

Draft／Version／Run／dispatch payload 新增 `workspaceSettings:{revision,sites,defaultTestUrl,timeoutMs}`。Manager 原樣傳至 Worker input 頂層，author 同樣使用此固定快照。

- Workspace 實際變更時，單一交易遞增 Workspace revision，對現存草稿各建立新不可變 draft revision：腳本不變、設定換成新快照、清除 validation 資格。
- 尚無草稿者首次建立採目前 Workspace 設定與原已發佈腳本（無版本則空腳本）。
- 已發佈 Version、既有 Run（含 queued）、已排 author 輸入保持原快照。一般 Run 只取已發佈 Version。
- 舊 author 結果遇 baseRevision 衝突不覆寫、不續接驗證，保留既有 proposedScript／衝突呈現行為。
- 發佈交易核對目前 draft revision、腳本/hash、完整設定快照、timeout、成功驗證及報告；不得沿用設定變更前的成功驗證。
- author 續接 validation 使用套用後的同一草稿快照；author 總限時仍 180000，workspace timeout 僅供一般 run／validation。
- 草稿相關交易先取 Workspace share lock 再 Test／Draft；Workspace PATCH 先取 Workspace update lock 再依 Test 排序鎖，維持一致鎖序。
- 舊資料補空 sites／空 defaultTestUrl；既有 timeout 必須保留，只有缺值才用 60000。不改寫歷史腳本、版本或執行語義。

## Runtime 接線（第二批）

網站清單及預設 URL 作為 author 非機密上下文；defaultTestUrl 非空時接到 Playwright baseURL，讓相對 page.goto 可用，空字串則保留既有行為。實作前由 Runtime owner 確認現有 runner 接線位置；不得默默忽略設定或將 URL 當作自動導覽／外部指令。所有設定均來自任務快照，不於執行時重新讀取 Workspace。

## UI 與驗收

UI 呈現單一 Workspace 設定入口、網站清單、預設 URL、執行逾時；不提供 key 輸入。儲存前明示「變更設定後，現有草稿需重新驗證；已發佈版本維持原設定」。成功後刷新設定及當前草稿；若有未儲存腳本，不得靜默覆蓋本機編輯。409 提示重新載入，不自動覆寫。

最小驗證：儲存／重載設定、無效與未知欄位拒絕、過期 revision、無變更 PATCH、設定變更使舊驗證不能發佈、既有版本／排隊任務不變。Runtime 用固定輸入或 mock request capture 證明設定傳遞與 baseURL，整合只跑一條主要流程。
