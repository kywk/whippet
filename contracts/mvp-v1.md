# MVP v1 串接契約

首批實作共同基線；如需變更先通知總指揮。所有 JSON camelCase；ID 使用字串 UUID，時間 RFC3339。

HTTP /api：POST /dev-login 回 {user:{id:"dev-admin",role:"superadmin"}}；GET /workspaces 回 {items:[{id,name}]}。
GET /workspaces/:id/tests 回 {items:[{id,workspaceId,name,description,publishedVersionId}]}；GET /tests/:id 回同一 Test。
POST /tests/:id/runs 回 202 {id,testId,status,createdAt}；GET /tests/:id/runs 回 {items:[Run]}；GET /runs/:id 回 Run。
Run 包含 id,testId,status,createdAt,startedAt?,finishedAt?,error?,reportUrl?；status: queued/dispatched/running/collecting/succeeded/failed/cancelling/cancelled/timed_out/interrupted。
錯誤回 {error:{code,message}}。M1 種子 Workspace 與固定 Test 由 Server 建立，腳本用固定本地 HTML page.setContent，避免外網依賴。

Manager 連 /api/manager/connect，Authorization: Bearer 部署 token。envelope: {protocolVersion:1,messageId,type,managerId,runId?,attemptId?,payload}。
hello payload {capacity:1}；heartbeat {active:[{runId,attemptId}]}。
dispatch payload {kind:"run",script:string,timeoutMs:60000}，script 為完整 TypeScript spec。
ack payload {}；event payload {eventId,kind:"started"|"log",message?}；result payload {status:"succeeded"|"failed"|"timed_out"|"cancelled",error?}。
Server 在派送時分配 attemptId，同 attempt 重送不可重跑。M1 先串出單任務；M2 補完整對帳。
POST /api/manager/runs/:runId/artifacts/:name 使用相同 token，header X-Attempt-Id，raw body；name MVP 為 report.html 或 results.json；限制檔名且禁止 traversal。
上傳成功後才回 result；Server 提供 /api/runs/:id/artifacts/:name，Run.reportUrl 指到 report.html。

Worker：輸入 /work/input.json {runId,attemptId,script,timeoutMs}，輸出 /work/output/report.html、results.json 與 result.json {status,error?}；stdout NDJSON {kind,message?}。Manager mount 任務目錄到 /work，使用 WHIPPET_WORKER_IMAGE，程序結束後讀結果、上傳並移除容器。
Server env: DATABASE_URL, MANAGER_TOKEN, ARTIFACT_DIR, PORT（預設8080）。Manager env: SERVER_URL, MANAGER_TOKEN, MANAGER_ID, WORKER_IMAGE, WORK_DIR, MAX_WORKERS。
