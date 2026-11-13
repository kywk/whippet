# M10 隔離公開 API fixture

Owner：t4b。只連 `http://127.0.0.1:19087/api`；不使用舊 18087、DB、Manager 私有 API 或憑證。

`python3 services/server/m10_manual_fixture.py create` 建立兩個 Module、儲存純計算 body/harness、各排一次正式 validation，最後建立 UseCase 編輯週期；不摘要、不發布、不確認 Plan。結果檔存在時拒絕重建。`inspect` 僅查既有 Run 與產物。完整 body 與 owner IDs 在 `m10_manual_fixture.result.json`。

## 最小 HTTP 順序

所有 JSON 寫入皆帶 `Content-Type: application/json`。ID 使用前一步回應，不手工指定。

1. `POST /workspaces/{workspaceId}/tests`：`{"kind":"module","slug":"唯一小寫slug","name":"名稱","description":"描述"}`。回傳 Test。
2. `POST /tests/{testId}/editing-session`：`{}`。取 `session.id`；`GET /tests/{testId}/draft` 取得 revision。
3. `PUT /tests/{testId}/draft`：`{editingSessionId,revision,script,module}`。module 必填 slug/moduleKind/exportName/signature/inputs/returns/preconditions/postconditions/harness，精確範例見結果檔 saveRequest。回傳更新後 revision；兩檔來源為 manual。
4. `POST /tests/{testId}/draft/validate`：`{editingSessionId,revision}`，202 Run；查 `GET /runs/{runId}`、`GET /runs/{runId}/artifacts`，報告取 `/runs/{runId}/artifacts/results.json` 或 report.html。
5. **模型配置完成、成功 validation 已回收後才執行**：`POST /tests/{testId}/draft/summary`：`{editingSessionId,revision,validationRunId}`。回傳 `{run}`；等成功與回收。這是獨立 Module 摘要，不能借 Plan 摘要。
6. **人工核對摘要並取得發布授權後才執行**：`POST /tests/{testId}/publish`：`{editingSessionId,revision,summaryRunId,confirmed:true}`。回傳 immutable Version；Catalog 才可看到它。修改 body、harness、metadata 後必須重新驗證與摘要。
7. UseCase：`POST /workspaces/{workspaceId}/tests`：`{"kind":"usecase","name":"名稱"}`（不帶 slug），開 editing-session，再 `GET /tests/{id}/plan?editingSessionId={sessionId}`。未建 Plan 回 `{ "plan": null }`。
8. 有正式 Module Version 後，`PUT /tests/{id}/plan`：`{editingSessionId,revision,planRevision:0,stages:[{id:"prepare",title:"Prepare",action:"reuse",moduleTestId,moduleVersionId,args:{},bind:"prepared"}]}`。後續修訂使用回傳 Plan revision，不能重用 0。
9. `POST /plans/{planId}/confirm`：`{planRevision,confirmed:true}`，會 Compose 並安排 validation。新空 Catalog 不可杜撰 version ID，也不能用 create/modify 代替手動流程以免排模型任務。
10. UseCase 驗證成功與回收後，走 Plan 專屬 `POST /plans/{id}/summary`：`{planRevision,validationRunId}`，`GET /plans/{id}/summary` 核對 stale/publishReady 與完整清單，再依授權 `POST /plans/{id}/publish`：`{planRevision,summaryRunId,confirmed:true}`。

## 本輪實際證據

- Catalog 200/items=[]；新 UseCase Plan 200/plan=null；不存在 Test 的 Plan 404/not_found。
- 成功 Module `4144fee0-7ace-47e2-a03c-00636cd61e25`，Run `1861abfd-1fdd-4a46-8456-11bc2ba97a89`：succeeded，expected=1/skipped=0/unexpected=0。
- 故意失敗 Module `ecd4bb35-ebfa-41e9-ad29-b89d86a1aa16`，Run `0ec31292-7923-46aa-bb33-cf88ce803e25`：failed，expected=0/skipped=0/unexpected=1；Stage 1 通過，Stage 2 expected intentional-mismatch/received alpha。
- 兩 Run 都有 report.html/results.json；使用純計算，沒有外部站台或瀏覽器 page fixture，不需要改 Workspace scope。
- UseCase `52cf7b3c-1223-4b90-bc4d-cfc59fc22a6d`，session `ee2e77a5-2c24-4358-918e-1f9952034e21`；尚未建立 Plan、摘要或發布。

## UI 與限制

目前 App 建立入口支援 test/usecase，沒有手動 Module 建立入口；Web saveDraft 只送 script，沒有 module metadata/harness 編輯參數。Server 公開 API 已完成上述 Module 儲存與正式驗證。此為 UI 能力差距，沒有因此修改 Server 介面。

PM 回報首頁歷史版本 INVALID_RESPONSE，由 Web owner 定位中；本文件不宣稱首頁通過。尚未連真模型、未驗證公開 API 摘要／發布或 UseCase reuse 全鏈。未變更 Server runtime 程式或既有固定 release 包。
