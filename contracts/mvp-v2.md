# M2 草稿、發佈與排程契約

沿用 v1；本文件新增部分優先。JSON camelCase，錯誤沿用 {error:{code,message}}。

## 草稿與版本 HTTP

- POST /api/workspaces/:id/tests {name,description?} → 201 Test，新測試未發佈。
- GET /api/tests/:id/draft → Draft；初次從已發佈腳本建立，無版本則空腳本。
- PUT /api/tests/:id/draft {revision,script} → Draft；revision 為 optimistic lock，過期回 409；實際修改時遞增，清除驗證資格。
- Draft {testId,revision,script,updatedAt,validationRunId?,validationStatus?,reportUrl?}。
- POST /api/tests/:id/draft/validate {revision} → 202 Run；固定當下腳本與 revision，修改草稿不改既有執行。
- POST /api/tests/:id/publish {revision,confirmed:true} → 201 Version。交易中核對目前 revision、對應驗證 succeeded、report.html 已存在與使用者確認；不滿足回 409 或 400。已發佈版本不可修改。
- GET /api/tests/:id/versions → {items:[Version]}；Version {id,testId,revision,script,createdAt,validationRunId}。
- POST /api/tests/:id/runs 只跑目前已發佈版本；未發佈回 409。
- Run 擴充 draftRevision?、versionId?、kind:"run"|"validation"。歷史 Run 腳本與設定快照不可因編輯而改變。
- POST /api/runs/:id/cancel → Run；queued 直接 cancelled，其餘進入 cancelling；終態呼叫可冪等回傳。

## Manager 與 Worker

沿用 dispatch kind:"run"（validation 同樣執行固定腳本），不把 AI 納入本次。
Server 按 FIFO 與 Manager hello capacity 派送；MAX_WORKERS 正整數控制實際上限。
新增 envelope type:"cancel"，帶 runId、attemptId，payload {}。Manager 只取消匹配 attempt。
Worker timeout 與 cancel 皆先停止／移除容器，確認回收後才回 result 並釋放名額；容器自行退出亦須回收。
heartbeat active 列出尚未完成回收的 attempt。Server 成功處理後回 type:"heartbeat_ack"、payload:{}（不帶 runId/attemptId）；Manager 以 35 秒讀取逾時偵測半開連線並重連。斷線不立即重派；重連以既有 journal／active 對帳，同 attempt 不重跑。
必要介面調整由總指揮協調，不私自更改另一 owner 檔案。
