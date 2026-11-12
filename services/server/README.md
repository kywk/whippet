# Whippet Server

Go 單一服務，依 [`mvp-v1`](../../contracts/mvp-v1.md)～[`mvp-v8`](../../contracts/mvp-v8.md) 提供 HTTP API、PostgreSQL 佇列、Manager WebSocket gateway、持久對話、報告附件與即時監看。M1～M6 已有本機整合證據；M7 Server 編輯週期／摘要已通過相關 Go 與 PM 獨立 PostgreSQL 檢查，M7 整體 UI／真 AI 驗收尚未完成。M8 A 提供 Workspace 訪談、提案與機密保存接線；B Server 已恢復完整 runner、加入可信 scriptOrigin／獨立能力／TLS 單次角色 resolve，已通過定向 Go 與 PM 隔離 DB 檢查。PM 已在18087／18089隔離環境，以正常 API＋HTTPS provider fixture 完成提案確認、角色保存、真登入驗證、摘要、QA發布與正式Run；兩次Run均expected=1／unexpected=0且真resolve／回收已確認。fixture只替代提案／摘要模型輸出，真AI、UI／LiveView仍待驗，詳細證據與Run ID見 [DELIVERY.md](DELIVERY.md)。

M1 已於 2026-11-11 驗收完成。總指揮與 Muse 已確認真實成功 Run、斷言失敗 Run 及兩份 HTML report 正常；storage shim 修正後成功報告顯示 Passed 1／Failed 0，失敗報告顯示 Passed 0／Failed 1。完整 Run ID 與驗證來源見 [DELIVERY.md](DELIVERY.md)。

## 執行

需求：Go 1.23.12、可連線的 PostgreSQL，以及 Server 可寫入的附件目錄。依賴固定於 `go.mod`／`go.sum`：Gorilla WebSocket 1.5.3、lib/pq 1.10.9。完整本機 Compose 操作見 [M1 指南](../../docs/guides/local-m1.md)。

獨立開發時，在 `services/server/` 執行：

```sh
export DATABASE_URL='postgres://whippet:whippet@localhost:5432/whippet?sslmode=disable'
export MANAGER_TOKEN='replace-with-a-deployment-token'
export ARTIFACT_DIR='./data/artifacts'
export PORT='8080'

go mod download all
go run -mod=readonly ./cmd/server
```

啟動時先 Ping DB，再以 transaction 與 advisory lock 執行內嵌的 `migrations/*.sql`。`schema_migrations` 記錄已套用檔案；Server 重啟不重建種子或改寫既有 Run。資料庫帳號需有建立資料表的權限。DB 不可用時啟動失敗，由部署層安排重試。

| 環境變數 | 預設／用途 |
| --- | --- |
| `DATABASE_URL` | 必填，PostgreSQL connection URL |
| `MANAGER_TOKEN` | 必填，Manager WS 與附件上傳共用 bearer token |
| `ARTIFACT_DIR` | `./data/artifacts`；需持久化並由 Server OS 使用者獨占寫入 |
| `PORT` | `8080`；HTTP 或 TLS 共用此單一 listener |
| `TLS_CERT_FILE`、`TLS_KEY_FILE` | 選填，必須成對；部署提供 PEM 憑證鏈／私鑰檔案。缺一或載入失敗則啟動失敗，不降級 HTTP |
| `WHIPPET_SECRET_MASTER_KEY` | 選填；部署提供 base64 編碼的 32-byte AES-256 key。未配置或格式錯誤時一般資料 API 可用，但 secretsAvailable=false、機密寫入／撤銷回 503 secrets_unavailable；沒有明文替代儲存 |
| `WHIPPET_LIVE_ICE_SERVERS` | `[]`；專用 STUN／TURN RTCIceServer JSON 陣列，不使用 Manager／AI 憑證 |

`POST /api/dev-login` 回固定 `dev-admin`／`superadmin`，不建立 cookie 或 token；M1 的一般 API 共用固定開發身分。這個服務尚未提供真實登入與租戶隔離。SPA 透過相同 origin 的 `/api` 反向代理串接，沒有開放跨來源 CORS。

## Docker

建置 context 必須是本服務目錄：

```sh
docker build -t whippet-server:m1 services/server
```

上述命令從 repo 根目錄執行。Dockerfile 於 build stage 下載固定依賴，使用 `-mod=readonly` 產生靜態 binary，runtime 使用 distroless nonroot。掛載 `/data` 保存附件，並另行持久化 PostgreSQL。使用 bind mount 時需讓 UID/GID `65532:65532` 可寫入 `/data/artifacts`。本機 Compose 位於 [compose.server.yml](../../deploy/compose.server.yml)，預設 Server 對主機為 `127.0.0.1:18081`。

`GET /healthz` 為程序存活檢查，`GET /readyz` 檢查 DB。映像內可執行 `/app/whippet-server healthcheck`，以 3 秒期限查詢本機 `/readyz`，供 distroless 的 Compose healthcheck 使用。兩個 TLS 路徑皆未設定時沿用 HTTP；皆有設定時使用原生 HTTPS/WSS（TLS 1.2 以上），同一 PORT 不另開明文健康檢查埠。healthcheck 自動改用 HTTPS，從配置的公開憑證鏈建立信任並驗證 SAN／hostname，不關閉驗證。憑證須有 DNS／IP SAN，檔案須讓 nonroot 程序可讀；入口代理到 Server 的 HTTPS 也須驗證正確 CA／名稱。代理需支援 WS upgrade 並允許超過 60 秒的連線。本輪未變更 Compose／共享部署。

## 種子與 HTTP

| 資源 | ID |
| --- | --- |
| 預設 Workspace | `00000000-0000-4000-8000-000000000001` |
| 成功 Test | `10000000-0000-4000-8000-000000000001` |
| 刻意斷言失敗 Test | `10000000-0000-4000-8000-000000000002` |
| 對應已發佈版本 | `20000000-0000-4000-8000-000000000001`／`20000000-0000-4000-8000-000000000002` |

兩份完整 TypeScript spec 都使用 `page.setContent`，不連線外網；每筆 Run 在建立時保存已發佈版本、腳本及 60000ms timeout 快照。失敗 Test 斷言不同的 heading，應由真實 Worker 回 `failed`。

| Method | Path | 回應 |
| --- | --- | --- |
| POST | `/api/dev-login` | 固定 `{user:{id,role}}` |
| GET | `/api/workspaces` | `{items:[Workspace]}` |
| GET | `/api/workspaces/:id` | Workspace 設定與 revision |
| PATCH | `/api/workspaces/:id` | 405 proposal_required；Allow: GET |
| GET | `/api/workspaces/:id/tests` | `{items:[Test]}` |
| GET | `/api/tests/:id` | Test |
| POST | `/api/tests/:id/runs` | 202 Run；依 scriptOrigin 核對適用能力及範圍 |
| GET | `/api/tests/:id/runs` | `{items:[Run]}`，新到舊 |
| GET | `/api/runs/:id` | Run |
| POST | `/api/runs/:id/cancel` | Run；queued 立即 cancelled，已派送者進入 cancelling |
| GET | `/api/runs/:id/artifacts` | `{items:[{name,size,contentType,url}]}`，當前 attempt 的已保存附件 |
| GET | `/api/runs/:id/artifacts/:name` | 已保存附件 |

錯誤使用 `{error:{code,message}}`；無效 UUID 為 400、不存在資源 404、狀態或 attempt 衝突 409。歷史 Run 的 `reportUrl` 在 `report.html` 已保存後出現。B 已恢復建立新的正式 Run；manual 不受 AI 網站政策限制，ai／legacy 缺有效確認範圍時回 409 scope_confirmation_required。

```sh
curl -X POST http://localhost:8080/api/dev-login
curl http://localhost:8080/api/workspaces
curl http://localhost:8080/api/workspaces/00000000-0000-4000-8000-000000000001/tests
curl -X POST http://localhost:8080/api/tests/10000000-0000-4000-8000-000000000001/runs
```

## M8 B：腳本來源、能力與登入

本段覆蓋 A 的暫態全面503。保留完整 Playwright／Node、evaluate／函式／迴圈，不建立 AST 子集或全通道網路代理。AI 的網站規則是瀏覽器工具與工作流防誤操作，不宣稱封鎖任意 Node 全部出站；Runtime 工具與證據遮蔽尚待 PM 全鏈驗收。

Draft／Version／Run 及 dispatch 頂層固定 `scriptOrigin:"ai"|"manual"|"legacy"`。Server 依可信寫入入口決定：人工 PUT 實際改 script bytes 才為 manual；AI 成功實際套用才為 ai；no-op／UI 切模式不增 revision、不洗來源。Start 複製正式版來源，設定／角色參照同步保留來源；validation／summary／發布／正式 Run 繼承快照並核對。舊資料及無腳本 Workspace author 為 legacy，不假造歷史作者。Web／author.json 不可自行指定 manual。

manual 的 validation／正式 Run 不要求 targets 確認；AI 工具即使修人工稿仍受已確認範圍限制。ai／legacy 使用已確認 Workspace 的防誤操作規則，legacy 不被推定為工程師授權。舊 Version 缺 context 時，新 legacy Run 可固定當前已確認背景，原 Version／Run 不改。新版 ai 快照要求的範圍若已撤回，明確拒絕，不靜默改成更大許可。request_validation 在 AI 結果實際套用後，依新 Draft 的來源及 context 重新核對，不能沿用原 manual 豁免；不合格時保存草稿與明確訊息，不排無效驗證。

Workspace 新增 `capabilities:{aiExploration,aiExecution,manualExecution,credentialLogin}`，各項為 `{available:boolean,reason:string|null}`。manualExecution 不因缺網站或 key 而停用；aiExploration 需有效確認的正式或當前候選範圍，aiExecution 需正式確認範圍，缺值 reason=scope_confirmation_required。credentialLogin 獨立核對 TLS／key／確認的 login origin／角色，回 protected_transport_required／secrets_unavailable／scope_confirmation_required／credentials_required。能力不是模型／Manager 即時健康保證；仍沿 FIFO。舊 executionAvailable 為 manualExecution OR aiExecution 的相容投影，true 時 unavailableReason=null，新版 Web 依來源選擇對應能力。

confirm-scope 後的新 Workspace author 固定該確認候選內容與角色到本次 workspaceContext；Server 內部保存 scope_proposal_id／authorization_revision，不另傳 policy 物件。新訊息使提案不可再套用，與同 scopeHash 的確認是否有效分開；stale/context_changed 且仍有效確認的角色不會憑空消失。取消／改變範圍會撤回 AI 工作，普通 manual 任務不因網站縮限被取消。Workspace author 有 browser 工具才可沿既有 LiveHub 監看；純訪談／summary 不可監看。

Manager 單次解析端點：`POST /api/manager/runs/:runId/attempts/:attemptId/credentials/resolve`，只接受 Manager bearer 與 **Server 實際 TLS**，連 loopback HTTP 也拒絕；不信任 forwarded header、不設長 lease。body 僅 `{roleId,secretRef,secretVersion}`，200 裸回 `{workspaceId,runId,attemptId,roleId,secretRef,secretVersion,loginOrigin,username,password}`，Cache-Control:no-store，值各1..4096 UTF-8 bytes。Server 核對目前 ready 控制 session、assigned 活躍 attempt／owner、固定 roleRefs、同 Workspace 當前未撤銷版本及已確認 login origin；角色未允許／跨 scope404、舊 attempt／撤銷409 credential_unavailable、缺 key503。

resolve 只供 Manager 可信登入 helper，不是一般帳密讀回。Manager 必須驗 CA/SAN、整組ID／origin且拒絕redirect；值不進 dispatch／input／journal／模型／env／argv／log。具體 stdio/loginAs IPC 由 Runtime 實作，不由 Server 建 broker 平台。manual 網站豁免不允許把平台憑證填到任意網站。Server 的 resolved_role_ids 只保存最多10個已交付角色ID；角色更新／撤銷使 active Draft 固定新 ref、產新 revision、清驗證摘要、保留來源，已使用該角色的任務取消／回收，未使用的人工任務保留。舊任務／Version 不能自動取新密碼；已使用的角色失效時舊證據不可發布。已交付值不能瞬間追回，清理與斷線偵測由 Manager／helper 完成，回收後才釋放 slot。

Migration 010 保護來源及確認綁定的不可變快照；A 已 terminal 的工作不復活。原 hash／revision／session／context／timeout／成功驗證／真 HTML-results／成功摘要／人工 confirmed 發布條件保留，新增來源與實際使用角色核對。登入後仍可觀察及監看；Runtime 須遮蔽敏感輸入與已知值，無法安全保存的個別附件須明示，不能用假報告或假成功換通過。

## Workspace 訪談、提案與快照（M8 A 基礎，B 覆蓋暫態限制）

GET 列表／詳情／Conversation 均純讀。新增 Workspace 為 draft／unconfirmed、revision=1，獨立保存一個設定 Conversation；舊資料為 needs_confirmation、settings=null，不把 M5 網站清單當成已確認範圍。頂層 sites/defaultTestUrl/timeoutMs 保留唯讀投影，canonical 設定只有 settings。舊 PATCH 一律 405 proposal_required，不保留修改名稱／timeout 的例外。

| Method | Path | 請求／權威回應 |
| --- | --- | --- |
| POST | `/api/workspaces` | `{name?}` → 201 裸 Workspace |
| GET | `/api/workspaces` | `{items:Workspace[]}` |
| GET | `/api/workspaces/:id` | 裸 Workspace：lifecycle/revision/authorizationRevision/scopeStatus/settings/conversationId/activeRunId/currentProposal/roles/secretsAvailable/executionAvailable/unavailableReason，含 M5 投影 |
| GET | `/api/workspaces/:id/conversation` | 裸 Conversation：id/workspaceId/ownerType/contextRevision/conversationSummary/messages/activeRunId |
| POST | `/api/workspaces/:id/messages` | `{content,revision,contextRevision}` → 202 `{run,conversationId}`；每 Workspace 最多一個活躍設定任務 |
| GET | `/api/workspaces/:id/proposals/:proposalId` | 裸 Proposal；跨 Workspace 404 |
| POST | `/api/workspaces/:id/proposals/:proposalId/confirm-scope` | `{baseRevision,confirmed:true}` → 裸 Proposal；確認不代表已探索 |
| POST | `/api/workspaces/:id/proposals/:proposalId/confirm` | 同上 → `{workspace,proposal}`；交易套用設定／許可、使舊草稿驗證及摘要失效 |
| POST | `/api/workspaces/:id/proposals/:proposalId/cancel` | 同上 → 裸 Proposal；保留現行設定及歷史 |
| PUT | `/api/workspaces/:id/roles/:roleId/credentials` | `{expectedSecretVersion,username,password}` → 裸角色參照 |
| DELETE | 同上 | `{expectedSecretVersion,confirmed:true}` → 裸角色參照；撤銷後保留版本 |

設定只接受 name/purpose/backgroundSummary/targets/dependencies/excludedOrigins/exclusions/loginRoles/defaultTestUrl/timeoutMs。未知欄位、任意 env/headers/key/cookie、衝突 origin 或超限輸入皆拒絕，不截斷／合併。targets/dependencies 各最多 20、roles 10、excludedOrigins 40；名稱 trim 後 1..200 UTF-8 bytes，說明最多 8192 bytes。origin 採完整 HTTP(S) scheme/ASCII host/port 正規化，禁止 userinfo、wildcard、query、fragment、非根路徑；允許與排除集合彼此不重疊、各自不重複。dependency purpose 只允許 login/api/cdn。defaultTestUrl 可空，非空的 origin 須屬 target；URL 最多 2048 Unicode 字元，timeout 為 1..3600000。正式 confirm 須至少一 target、非空 purpose/backgroundSummary；訪談可保留不完整提案，confirm-scope 也拒絕無 target。

proposal 由 Server 綁定 Workspace/baseRevision/contextRevision/Run/attempt，狀態為 pending/applied/cancelled/stale/superseded；模型不能直接套用設定或產生 secretRef／確認旗標。新 user 訊息使前一 pending 提案過期，舊 revision/context 或遲到結果不能覆蓋新內容。同一 applied confirm 或 cancelled cancel 冪等；實際設定 no-op 不增 revision、不使草稿失效。roleId 為 null 時由 Server 分配，非 null 必屬同 Workspace。

機密 API 只回 `{roleId,secretRef,secretVersion,configured}`，永不讀回帳密。expectedSecretVersion 必填非負整數，null／省略拒絕；首次 null 版本送 0，已有版本即使 configured=false 仍送該版本。交易內核對，過期 409；撤銷保留版本，後續保存遞增。密文使用 AES-256-GCM、獨立隨機 nonce 及 Workspace/role/ref/version AAD。機密不進一般訊息、Run、dispatch 或 journal。transport 必須是 Server 實際 TLS，或 Host 與 RemoteAddr 同時為 loopback；不信任 X-Forwarded-Proto 等任意 header，localhost→Nginx→bridge HTTP 仍會拒絕 protected_transport_required。

Run.workspaceId 必填，Workspace 訪談 testId/editingSessionId 為 null、authorMode=workspace，不建立假 Test。dispatch 平面欄位沿契約：workspaceId/testId/workspaceContext、script=""，author.skillId=workspace-author、skillVersion="1"、allowedTools=[]、sourceVersion=null；A 不傳 requiredPolicyVersion。context 固定為 `{schemaVersion:"1",workspaceId,settingsRevision,config,roleRefs}`，與 M5 workspaceSettings 一起保存不可變快照。設定套用替 active Draft 建立新 revision，原腳本不變，清除驗證／摘要；Version、既有 Run 不改。所有 Test／Run／附件／live 由 DB 導出真實 Workspace owner，舊 URL 不必新增 query；若提供 workspaceId，必須吻合，跨 scope 404。開發 Superadmin 身分仍沿用現況，未提供正式 RBAC。

A 當時使用全面503／離線三工具作暫態；B 已依上段恢復完整 runner、逐來源與確認範圍配置工具及單次 TLS resolve。A 已終止任務不復活，不再建舊強隔離提案的全網路 lease／proxy。M8 真實整合尚未驗收。

### 隔離 PostgreSQL 檢查

`TestM8BServerLifecycle` 僅使用明確提供的 TEST_DATABASE_URL，缺值 skip；在該隔離 DB 建立／清除隨機 schema，沒有 DATABASE_URL 或共用 DB fallback。請 PM 提供獨立 PostgreSQL 容器後，在 `services/server/` 執行：

```sh
env GOPROXY=off GOSUMDB=off TEST_DATABASE_URL='<隔離 PostgreSQL URL>' \
  go test -mod=readonly -tags=integration ./internal/server \
  -run '^TestM8BServerLifecycle$' -count=1 -v
```

PM 已於 2026-11-12 用獨立 PostgreSQL 實跑 TestM8BServerLifecycle PASS 無 skip，0.704s（test0.41s）；容器已移除、共享 DB 未碰。log=/private/tmp/whippet-m8b-db-check-retry.log。首跑因已確認候選在探索後變 stale/context_changed，被舊 roleEligible 的 pending-only 判斷誤拒撤銷而失敗；已統一有效確認判斷，保留原撤銷／consumer取消斷言後重跑通過。案例涵蓋 migration010、人工無targets的驗證／摘要／發布／正式Run、AI改人工稿後的資格重判、確認候選／live／resolve重送、角色撤銷及無關人工任務、legacy與immutable。此為真 DB 加合成腳本／附件 fixture，不是模型／Playwright 全鏈證據。

本機定向 `go test -mod=readonly ./internal/server -run '^(TestM8B|TestPublicationRequiresCurrentValidatedRevisionAndReport|TestM7Summary)' -count=1` PASS；TLS listener／healthcheck 沿用 A 的既有合成憑證真驗證證據，本輪未重跑。歷史 M8 A 全面503案例只作該切片紀錄，不以它判定 B runner。詳細實際檢查與 Linux arm64 binary 見 DELIVERY。

## Manager 串接

連線 `ws://<server>:8080/api/manager/connect`，header `Authorization: Bearer <MANAGER_TOKEN>`。所有訊息使用 camelCase envelope；第一筆必須在 10 秒內送出：

```json
{"protocolVersion":1,"messageId":"<uuid>","type":"hello","managerId":"runner-1","payload":{"capacity":1}}
```

每 10～20 秒送一次 heartbeat，最長間隔 60 秒。`active` 必須是陣列，閒置時也要送 `[]`：

```json
{"protocolVersion":1,"messageId":"<uuid>","type":"heartbeat","managerId":"runner-1","payload":{"active":[{"runId":"<run-uuid>","attemptId":"<attempt-uuid>"}]}}
```

1. Server 以 PostgreSQL `queue_seq` FIFO claim 任務，先提交唯一 attempt，再送 dispatch。單一 Manager 的正整數 `capacity` 為全域名額上限；驗證與正式 Run 共用佇列。
2. dispatch payload 為 `{kind:"run",script:"<完整 spec>",timeoutMs:60000}`。Manager 先持久化 journal，再啟動 Worker，回 `ack`。未 ACK 的 dispatch 每 5 秒最多重送一次，保持相同 runId／attemptId；Manager 必須依 attempt 去重。
3. `event` payload 為 `{eventId,kind:"started"|"log",message?}`；同一 eventId 只保存一次。開始事件設為 running，附件上傳後設為 collecting。
4. Manager 上傳附件成功後送 `result`，payload 為 `{status:"succeeded"|"failed"|"timed_out"|"cancelled",error?}`。`succeeded` 必須已保存兩份附件；異常失敗／逾時／取消可缺附件，以便呈現實際錯誤。
5. 終態結果可重送，互相衝突的終態與舊 attempt 會被拒絕。result 只更新 Run；只有終態 attempt 已從後續 heartbeat.active 移除，Server 才釋放名額。Manager 必須在容器實際回收後才移除 active。

Manager ID 於首次 hello 寫入 DB，之後僅接受相同 ID；同 ID 新連線取代舊連線。每個新連線都先等待 heartbeat 對帳，成功後回 `heartbeat_ack`、payload `{}`，不帶 runId／attemptId，再允許派新工作。ACK 與 dispatch／cancel 使用相同串行寫入；ACK 寫入失敗會關閉連線並暫停派送。active 清單可補回遺失的 dispatch ACK；未知 active attempt 會中止連線。Server 重啟恢復 queued Run，既有 attempt 不自動重新排隊；已 ACK／running 但缺少結果的任務保留名額，等待 Manager journal 補送，不猜測已停止。

M2 取消增補：Server 送相同 envelope 的 `type:"cancel"`、既有 runId／attemptId、`payload:{}`；最多每 5 秒重送一次。Manager 必須去重、停止／回收容器，再回報結果與 heartbeat。queued 取消不派送。取消與完成同時發生時，接受 Manager 實際的最終結果，因此 `cancelling` 仍可能收到 `succeeded`。

若取消的 attempt 尚未 ACK，Server 對仍允許派送的任務先重送相同 attempt 的 dispatch，再送 cancel，讓 Manager 可辨識該 attempt 並回報結果；不建立新的 attempt。M8 A 已禁止的執行任務只送 cancel，不重送不安全 dispatch。

## M7 編輯週期與驗收摘要

`GET /api/tests/:id` 的 `activeEditingSession` 為 null 或 `{id,status,draftRevision,updatedAt}`，無建立副作用。一般模式使用它判斷草稿存在；**GET draft／conversation 不再自動建立資料**，無當前週期回 404。以下行為覆蓋 M2／M3 舊契約：

| Method | Path | 行為 |
| --- | --- | --- |
| POST | `/api/tests/:id/editing-session` | body {}；201 開始，200 接續同週期；discarding 回 409 |
| GET | `/api/tests/:id/editing-session` | 純讀 `{session:null|EditingSession}` |
| GET | `/api/tests/:id/editing-sessions/:sessionId` | 讀指定週期，包含已發布／已放棄 |
| POST | `/api/tests/:id/editing-sessions/:sessionId/discard` | `{revision,confirmed:true}`，202 等取消／回收，200 已放棄 |
| POST | `/api/tests/:id/draft/summary` | `{editingSessionId,revision,validationRunId}`，冪等 `{run}`，失敗可獨立重試 |

Session 帶來源版本、conversationId、contextRevision／conversationSummary、目前 draft／summary、pendingRunIds／reclaimPending。每個 Test 最多一個 active／discarding 週期；發布／放棄後關閉週期、移除目前草稿指標，保留歷史對話、revision、Run、附件。下一次 start 從目前正式版取腳本與版本背景，設定取目前 Workspace，revision 繼續遞增。

新 user 訊息與接受的 edit 回覆遞增 contextRevision、失效舊摘要；未改腳本／設定時保留驗證。Web 在真實驗證成功且報告就緒後觸發 summary，失敗時由使用者明確重試，不無限自動重試。摘要不能改腳本，只產 description／backgroundSummary／optional name；只有 QA confirmed publish 才保存到不可變版本及套用名稱。

author 任務仍共用原 FIFO／author.json，新增可信 skillId（test-author／acceptance-summary）、skillVersion="1"、allowedTools、editingSessionId、contextRevision、sourceVersion／conversationSummary；不傳重複 mode。summary 使用空工具集合，允許 messages=[]，完整 script 與 validationEvidence 必填。公開 Run.authorMode 由 skillId 推導。完整 wire 規格見 mvp-v7。

Migration 008 保留真實未發布或仍有活躍／未回收任務的舊草稿；與正式版一致且無活躍任務的舊指標會封存。舊 Version.description／backgroundSummary 為 null，UI 須明示舊版缺值，不能拿目前 Test.description 冒充歷史說明。Worker 遠端歷史工具延 M9，M7 只用持久週期摘要＋近期訊息。

放棄須等該週期 Run 全終態，且已派送 attempt 的 slot 由 Manager heartbeat 確認回收才完成；正式 Run 不取消。晚到／重送結果不會建立草稿、套用到新週期或續排驗證。服務重啟後由原 Engine Tick 繼續收尾，不需另一套排程。

## 草稿、驗證與發布（M7 覆蓋 M2）

| Method | Path | 請求／回應 |
| --- | --- | --- |
| POST | `/api/workspaces/:id/tests` | `{name?,description?}` → 201；無 name 暫用「未命名測試」 |
| GET | `/api/tests/:id/draft` | 純讀目前週期 Draft；無則 404 |
| PUT | `/api/tests/:id/draft` | `{editingSessionId,revision,script}` → Draft；過期回 409 |
| POST | `/api/tests/:id/draft/validate` | `{editingSessionId,revision}` → 202 validation；依實際來源／context核對 |
| POST | `/api/tests/:id/publish` | `{editingSessionId,revision,summaryRunId,confirmed:true}` → 201 Version；原真報告門檻及來源／角色核對，重送冪等 |
| GET | `/api/tests/:id/versions` | `{items:[Version]}`，新到舊 |

每個 Test 只有一筆 Draft。實際改動腳本才遞增 revision 並清除 validationRunId；相同內容儲存保留 revision，但仍核對 optimistic lock。腳本上限 2 MiB；空草稿可保存，不能驗證。每次 validate 固定腳本、SHA256 與 timeout 快照，並讓最新 validation Run 成為該草稿的發布依據。

發布在同一 DB transaction 內沿 Workspace／Test／Session／Draft 鎖序核對目前 revision、驗證內容雜湊／腳本／timeout／設定、succeeded、使用者確認，以及目前 attempt 的 report.html 索引與實體檔案可讀且大小相符；另需相同 session／contextRevision／validation attempt 的成功摘要。任一門檻不符不建立版本；缺確認回 400，驗證、摘要或報告不符回 409。同一發布確認重送回傳原版本，不重複產生版本。

發布版本、歷史 revision 與 Run 腳本／設定快照由 DB trigger 防止修改；草稿後續修改不影響已建立 Run。正式 Run 只執行已發布版本，未發布回 409。Run 增加 `kind`、`draftRevision?`、`versionId?`。M1 種子版本保留原資料，Version 的 `validationRunId` 為 null；M2 新發布版本會附對應 validation Run ID。

新增 migration 為 `003_drafts_and_publication.sql`；不修改已套用的 M1 migration。服務的 `Postgres.Artifacts` 必須設定附件儲存，才能在發布 transaction 中核對實體報告（正式入口已設定）。

目前沒有額外的 Server result ACK／完整 reconcile 訊息；Manager 斷線重連時需補送 journal 中尚未確認的終態。發送失敗不建立新 attempt，也不自動重跑測試。

## 附件

```http
POST /api/manager/runs/:runId/artifacts/report.html
Authorization: Bearer <MANAGER_TOKEN>
X-Attempt-Id: <attemptId>
Content-Type: application/octet-stream

<raw body>
```

一般 run／validation 接受下列附件；author 僅接受 `author.json`（2 MiB）。上傳與讀取皆核對 Run.kind，不能跨種類存取。檔名與 UUID 採白名單，路徑逐層拒絕 symlink；檔案先寫暫存、同步並原子 rename，再登記 DB。key 為 `run/attempt/sha256/name`，同內容上傳可重送，衝突內容回 409，不覆寫已登記附件。終態後拒絕再上傳。

| 名稱 | 單檔上限 | 每 Run 配額 | 下載 Content-Type |
| --- | --- | --- | --- |
| `report.html` | 64 MiB | 原規則 | `text/html; charset=utf-8` |
| `results.json` | 64 MiB | 原規則 | `application/json` |
| `data/<40位小寫hex>.png` | 10 MiB | PNG 最多 32 檔／64 MiB | `image/png` |
| `data/<40位小寫SHA1>.zip` | 64 MiB | ZIP＋MD 合併最多 32 檔／128 MiB | `application/zip` |
| `data/<40位小寫SHA1>.md` | 1 MiB | 同上，與 PNG 獨立 | `text/markdown; charset=utf-8` |

ZIP／MD 需 migration `007_failure_evidence.sql`。Server 核對檔名 SHA1、ZIP 基本 PK0304／PK0506 signature 與 Markdown UTF-8；ZIP 不解壓、不驗整包、不執行。兩類下載強制 `Content-Disposition: attachment; filename="<hash.ext>"`、nosniff 與 `sandbox; default-src 'none'`，不在管理頁渲染 Markdown。影片、任意副檔名與 root-level `trace.zip`／`error-context.md` 不接受。

GET `/api/runs/:id/artifacts` 回 `{items:[{name,size,contentType,url}]}`，依 name 排序，只列當前 attempt 已登記且符合 kind 的附件。已知 Run 無附件回空陣列，未知 Run 回 404；不回 storage key、token 或主機路徑。ZIP／MD 下載連結應放在平台頁面、HTML 報告 sandbox 外；trace 下載後以本機既有 Playwright Trace Viewer 開啟。M6 真實 Worker 產生／Manager 上傳與瀏覽器下載驗收由 PM 接續，這裡不宣稱已完成端到端驗證。

PNG 沿用同一組上傳／下載端點，name 可為 `data/<hash>.png`。report.html 保持原路徑，內部相對圖片網址不改寫；PNG 回應為 image/png。請先上傳 PNG 再上傳報告／送 result。Server 在 Run row lock 下核對 PNG 配額，重送同檔名不重占名額；成功檢查只計 report.html／results.json，PNG 不影響兩份報告門檻。此功能需 migration `005_report_screenshots.sql`。

`report.html` 保留原生報告與相對 PNG 路徑。回應設定 CSP sandbox，允許 inline scripts／styles，以及同源、data/blob 圖片；connect-src 維持 none，script-src 不開放外部來源，避免報告腳本操作 SPA。Server 在原報告 script 前注入記憶體 storage shim，讓 Playwright 設定可在 opaque sandbox 中讀寫 localStorage／sessionStorage；資料只留在本頁，重新整理即清空，不加入 allow-same-origin。注入只改變 HTTP 呈現，保存的附件與 SHA256 不變；回應 ETag 使用 `-storage-png-v1` 後綴。M6 不提供 HTML 內嵌 trace viewer，也不為原生 trace 按鈕或 Copy prompt 放寬 script／connect／download 限制。

Manager WebSocket 輸出先 Marshal 完整 JSON，再用 Gorilla 未壓縮的 server WriteMessage 單 frame 路徑，支援 x/net JSON.Receive。4096-byte buffer 與 2 MiB script 契約不變；跨函式庫長 payload 回歸測試位於 `internal/gateway/websocket_interop_test.go`（wsinterop tag，需現有 x/net 0.56.0 與配對 Go >=1.25，獨立暫存 modfile，不新增 production 依賴）。

## M3 對話與 author

| Method | Path | 請求／回應 |
| --- | --- | --- |
| GET | `/api/tests/:id/conversation` | 純讀當前週期；可帶 `?editingSessionId=...`，回完整訊息與 activeRunId? |
| POST | `/api/tests/:id/messages` | `{editingSessionId,content,revision}` → 202 `{run,conversationId}` |

每個 EditingSession 一個 Conversation，每 Test 同時最多一個未完成 author Run（含 summary）。空編輯訊息或超過 16000 Unicode 字元回 400，過期 revision 或已有 author 回 409。user 訊息與 author Run 在同一交易保存；Run 固定當下草稿腳本／revision，取週期摘要與最近最多 12 則、總 32000 字元作 dispatch 快照，保留完整本輪 user 訊息。完整週期歷史不受模型 context 裁切影響。

author 與其他 Run 共用 FIFO、取消與回收名額規則。dispatch 為 `{kind:"author",script,timeoutMs:180000,author:{conversationId,baseRevision,messages:[{role,content}],validation?}}`；validation 是送出時目前草稿驗證 Run 的固定 `{runId,status,error?}` 摘要，error 最多 4000 Unicode 字元，供 Runtime 的 `read_validation_report` 工具使用，不讀 HTML。無摘要的舊 payload 仍相容。Server 不讀取或轉送模型 key，一般 run／validation 仍送 `kind:"run"`。

Manager 上傳 `author.json {message,script?,requestValidation}` 後回 succeeded。Server 核對 attempt、檔案大小／SHA256／JSON 及輸入快照，在同一 transaction 內：

- baseRevision 未改動時，沿用 M2 規則保存候選腳本；真正變更才產生 revision，並清除舊驗證資格。
- baseRevision 已被人工修改時，不覆蓋草稿、不排驗證，保存候選稿與衝突說明。
- 無 script 時保留原稿；requestValidation 只在無衝突且非空草稿時建立固定結果 revision 的 validation Run，不占住 author Worker 等待。
- assistant 訊息保留 baseRevision、變更時的 appliedRevision、任何已生成的 proposedScript，以及續接的 validationRunId。baseScript 由既有 draft_revisions 關聯取得，重新開啟仍可比較前後差異。

author 終態、assistant 訊息、revision 與續接驗證一起提交；重複 result 先辨識原始回報狀態再返回，不重複套用或排工作。取消／失敗不套用候選稿，provider 錯誤採固定遮蔽訊息；無效 author.json 會成為 failed，保留已存對話與草稿。author 成功只需 author.json；M2 validation／發布的兩份報告與人工確認門檻維持不變，不會自動發布。

新增 migration 為 `004_conversations_and_author.sql`。需要原有 ARTIFACT_DIR volume 才能完成 author 結果核對；本階段 Server 沒有新增 AI 環境變數。

## M4 唯讀即時監看

Viewer 使用同源 `GET /api/runs/:id/live` WS，依目前 Run／attempt 綁定，最多一位觀看者。Manager 使用 bearer token 連獨立 `/api/manager/runs/:id/live?attemptId=...&viewerId=...`。Server 轉送 non-trickle WebRTC offer／answer／mode／state，不處理 RTP；JPEG 備援用完整 binary message，上限 1 MiB，只保留最新影格。

Viewer 與 media 都支援 JSON ping／pong；viewer 每 10 秒 ping、30 秒租約，media ping 不延長 viewer。離線、到期或終態停止 live，透過控制 WS 送綁定 viewerId 的 live.start／stop；影格與 live 錯誤不進任務控制 handler，不改 Run 結果。ICE 設定只使用 WHIPPET_LIVE_ICE_SERVERS，不記錄 credentials。

代理需支援 WebSocket upgrade 並保留含埠號的 Host（Nginx `$http_host`）以通過 Origin 檢查。Server 已豁免 live WS 的 HTTP 30 秒 request deadline，連線改由 live lease 與獨立寫入期限控制。實際 WebRTC／JPEG／TURN 驗收狀態見 DELIVERY。

## 檢查

無外部模組的核心檢查可離線執行，包含 HTTP → 假儲存層 → dispatch／result → 真實附件檔案，並覆蓋 FIFO、名額回收、重連、取消與 traversal：

```sh
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test ./internal/server
```

依賴可用時，先建置整個服務，再以測試用 DB 執行一次資料層整合檢查：

```sh
go build -o /tmp/whippet-server ./cmd/server
TEST_DATABASE_URL='postgres://whippet:whippet@localhost:5432/whippet_test?sslmode=disable' \
  go test -tags=integration ./internal/server -run TestPostgresQueueAndAttemptInvariants -count=1
```

整合測試會在指定 DB 建立獨立隨機 schema，結束時刪除該 schema；不使用既有應用資料表。需要 schema 建立權限。

M6 單一資料層測試為 `TestPostgresEvidenceArtifacts`，同樣只接受明確的隔離 TEST_DATABASE_URL，缺少時 skip。可沿用上方「隔離 PostgreSQL 驗證」的獨立容器命令，把 `-run` 改為 `'^TestPostgresEvidenceArtifacts$'`；它包含 migration 007、列表隔離、合併配額／PNG 獨立、重送與原報告門檻檢查。PM 已用獨立 `postgres:16.11-bookworm` 容器執行通過，無需為此交付重跑。

上述命令供後續開發按改動執行；本次 M1 驗收已完成，不需重跑。實際檢查與仍未涵蓋的 M2 項目見 [DELIVERY.md](DELIVERY.md)。
