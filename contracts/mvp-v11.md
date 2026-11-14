# M11：MCP 與外部 Agent 接縫

2026-11-14 獨立 PM t52 固定首波；Server t53、Runtime t54 提案已納入。承接 v10，不更動既有 Run 快照或 registry10.3。此文件定義介面，不代表 M11 整階段完成。進度以 implementation.md 為準。

## 啟用與管理邊界

- 官方 `github.com/modelcontextprotocol/go-sdk v1.3.1`，相容既有 Go1.23；只在 Server 新增此直接依賴及必要間接依賴，不升全工具鏈。
- `/mcp` 為 Streamable HTTP，首波 Stateless=true，JSON 回應；GET 可回405，不建立可跨 Token 重用的 MCP transport session。SDK處理協定協商，業務 browser session 與 MCP transport session 分開。
- MCP 為 opt-in：`WHIPPET_ADMIN_TOKEN` 未設定時，MCP及Agent Token管理回503 disabled；既有非MCP流程維持。設定後，所有非Manager `/api`（含dev-login、Token管理、publish）必須以 `X-Whippet-Admin-Token` constant-time核對；這些路徑一律拒絕 Authorization Bearer，即使同帶正確管理header。管理key不得等於Manager token。
- `/api/manager/*` 維持Manager專用認證；`/mcp` 僅接受Agent Bearer，不能接受管理key或Manager token。health/ready不受管理gate影響。Agent移除Bearer也不能繞過已啟用的管理gate。
- 管理key只由部署secret注入；Web未接線前，管理API只能透過受信任管理客戶端使用。後續Web輸入僅留記憶體，不寫localStorage/sessionStorage/URL/log。此為MVP管理gate，不宣稱完整帳號或RBAC。
- `/mcp` 每個HTTP請求及工具執行前都查DB驗Token與撤銷，不以長效cache授權。Origin缺席可接受；有值須精確等於已設定 `WHIPPET_PUBLIC_ORIGIN` 的scheme/host/port，缺配置、null、複數或格式錯誤拒403，不信任轉送Host推導allowlist。部署只透過HTTPS或loopback隔離測試。
- 每Token token bucket：每分鐘60次、burst10，超限429及Retry-After；未知Token不建立無界bucket。合法Token bucket需有界清理；速率上限不取代工具大小／期限限制。

## 管理瀏覽器相容接縫（首波補充，優先於僅header敘述）

原生報告連結與browser WebSocket不能附自訂header，因此啟用gate後提供最小管理session：`POST /api/dev-login`只有正確admin header能登入／續期，保留原user回應並設定opaque cookie（至少32-byte亂數、HttpOnly、SameSite=Strict、Path=/api，TLS或公開HTTPS時Secure），絕對期限8小時。Server只在有界記憶體存digest/expiry，重啟失效；不把管理key放cookie，session滿時拒新登入或只清已過期項。

後續非Manager `/api` 可使用正確admin header或有效session cookie，仍拒所有Bearer；以cookie授權的寫入必須Origin精確符合已設定WHIPPET_PUBLIC_ORIGIN，無配置拒絕。GET／WebSocket若帶Origin亦須核對。`POST /api/dev-logout`撤銷本session、清cookie，重送204，仍核Origin。`/mcp`不接受cookie當授權。Web登入成功清輸入key，後續依同源cookie取報告／開WS；登出清管理狀態與一次性Token，不讀HttpOnly cookie。

## Agent Token 與稽核 HTTP

管理gate通過後，沿Workspace權威關聯核對；未知欄位與錯誤型別拒絕。

- `POST /api/workspaces/{id}/agent-tokens`，body `{name:string}`（trim後非空，最多100 Unicode code points）；201 `{token:string,agentToken:AgentToken}`。密碼學亂數至少32 bytes；明文僅此次回應，Cache-Control:no-store，不記log或audit。不得先持久保存明文再刪除。
- `GET /api/workspaces/{id}/agent-tokens` → `{items:AgentToken[]}`，只metadata。
- `DELETE /api/workspaces/{id}/agent-tokens/{tokenId}` →204；同Workspace重複撤銷仍204，跨Workspace404，不回傳Token。
- `AgentToken={id,workspaceId,name,createdAt,revokedAt,lastUsedAt}`，nullable時間明示null；不含hash、prefix或任何明文片段。
- DB `agent_tokens` 保存id/workspace/name、SHA256 digest（unique）、created/revoked/last_used。撤銷已提交後的新請求一律拒絕；工具在提交副作用前須再次核撤銷。
- `GET /api/workspaces/{id}/agent-tool-audit?limit=...&before=...` → `{items,nextCursor}`，limit預設20、1..100；before為Server發行cursor，scope不可擴大。audit項目 `{id,tokenId,workspaceId,toolName,decision,occurredAt}`。
- 稽核只保存固定工具名或`unknown`、固定decision（`allowed|denied|rate_limited|failed`）、Token/Workspace ID與時間；不存參數、輸出、URL、錯誤文字、Token/hash。每個已驗證Token的tool call皆記；未知Token不寫原文。首波不自動刪歷史紀錄，以有界分頁讀取，保留策略另定。

## 首波 registry 與 skills

- 初期只公開已實作 `catalog_search`、`catalog_get`；schema、description、limits直接來自registry，無第二份工具schema。不列未接線browser/candidate/queue工具，不提供publish/confirm/retry等人工動作。
- tools/call先驗原始大小、完整JSON/schema與Workspace，再執行共享業務查詢；不能直接繞過HarnessPlatform的Run/attempt守衛，也不能以UI HTTP handler替代Agent授權。
- catalog_get只可取得Token所屬Workspace已發佈Module固定版本；跨Workspace統一拒絕，不洩露存在資訊。catalog_search沿同Workspace查詢；首波可能回nextCursor但尚未提供catalog_next_page，指南明列不能翻頁，不偽造完整結果。後切片需有Token／租約發行綁定才公開翻頁。
- MCP results提供結構化JSON及等價text；超限拒絕，不截斷JSON。安全固定錯誤，不回raw error或HTTP body。任何寫入後續都由Server標記ai來源，不能沿用manual寫入路徑。
- resources只列打包且明確允許的skill主檔／reference，URI為Server生成；不可任意檔案path、環境、機密、歷史對話或內部model設定。遵守既有主檔8KiB、reference及結果上限；同樣先驗Token。無需同時增加prompts第二份內容。

## Browser session wire（Runtime首波核心）

session是獨立租約，不冒充author Run。沿WSS Envelope protocolVersion=1、messageId/managerId；下列session訊息省略runId/attemptId。sessionId/leaseId/callId皆UUID。Server維護Token/Workspace所有權，Manager只接受現有可信控制連線；Worker永不取得Agent/Manager token或模型key。

- Server→Manager `session.open` payload `{sessionId,leaseId,workspaceId,workspaceContext,allowedTools,toolRegistryVersion,toolRegistrySha256,idleTimeoutMs:600000,maxLifetimeMs:1800000}`。
- Manager→Server `session.ready` payload `{sessionId,leaseId}`。
- Manager→Server `session.open_rejected` payload `{sessionId,leaseId,error}`，error固定 `capacity_full|invalid_request|session_unavailable`。只回語法有效UUID識別；非法識別frame直接拒絕，不反射raw內容。拒絕不建立lease、不占新slot，也不能對既有其他lease發closed。Server不得把明確拒絕當未知結果重送open。
- Server→Manager `session.call` payload `{sessionId,leaseId,callId,name,arguments}`。
- Manager→Server `session.reply` payload `{sessionId,leaseId,callId,result}` 或 `{sessionId,leaseId,callId,error}`，兩者互斥。error固定為 `session_unavailable|tool_unavailable|invalid_request|busy|unknown_result|cancelled|timeout`，不含自由文字。
- Server→Manager `session.close` payload `{sessionId,leaseId}`；Manager→Server `session.closed` payload `{sessionId,leaseId,reason,reclaimed}`；reason固定 `closed|idle_timeout|lifetime_timeout|cancelled|worker_failed|manager_restart`。reclaimed=true僅Docker確認移除後。
- Manager heartbeat/reconcile追加 `sessions:[{sessionId,leaseId,state}]`；state=`starting|ready|closing|reclaim_pending`。不得將未回收session從容量或對帳中移除。

Manager接受open即固定硬期限，先原子journal最小識別／Workspace／期限／狀態，再保留共用slot；Run與未回收session總量不得超過MaxWorkers。ready不重設硬期限；idle自ready／最後已受理call完成計，心跳不續idle。啟動亦受30分鐘硬期限。重複相同sessionId/leaseId回目前狀態，不再開容器；同session異lease拒絕。

同lease只允許一筆in-flight call。核registry worker/browser、allowedTools、原始bytes／schema／timeout與scope，無候選／fs／shell／模型工具。同callId相同參數在存活程序內回原結果或busy，不重作副作用；異參數拒絕。參數hash與結果僅有界記憶體保存，不入journal；記錄淘汰後舊callId不得當新呼叫重新執行。重啟不恢復瀏覽器，原lease一律失效，先清本Manager標記的孤兒容器，回收確認前仍占slot。結果未知回unknown_result，不自動重送。

Worker input獨立 `{kind:"session",sessionId,leaseId,workspaceId,workspaceContext,allowedTools,toolRegistryVersion,toolRegistrySha256}`，不含script/author/model。容器明確用 `dist/session/main.js`；stdin `tool_call`、stdout `tool_result`攜帶相同lease/call識別，沿整幀鎖與既有大小邊界。期滿／取消先阻止新call、取消in-flight，再終止及回收，遲到reply不得恢復lease或提前放slot。

瀏覽器沿既有scope/noSecret/login(roleId)守衛。credential resolver與LiveView需新增lease權威綁定；首波注入hook可做隔離測試，但未接Server時browser_login必拒，不能回假submitted。roleId查詢僅走受控Worker→Manager→Server通道，session.call/reply不得承載憑證。未完成真viewer綁定前不宣稱LiveView整合。

## Wave 2：MCP browser lease（2026-11-14）

本波固定匿名browser端到端。registry升11.0，僅追加下列三個server工具；原browser工具schema與limits不變，新部署三端必須封裝同份原始bytes，既有19287與舊Run快照不替換。

- `browser_session_open({requestId:UUID})`：Token推導Workspace；同Token最多一個未回收lease。持久唯一鍵 `(token_id,request_id)`，同鍵重送回原lease當下狀態，原lease關閉後也不另開。若另一requestId已有active lease則拒；未有可用Manager或capacity則明確拒絕。送出前落地租約與發送意圖，不因網路未知重送open。
- `browser_session_status({sessionId:UUID,leaseId:UUID})`：純讀、核Token/Workspace/lease所有權；不得藉status更新idle或提升權限。
- `browser_session_close({sessionId:UUID,leaseId:UUID})`：冪等標closing並送close；不同Token或lease拒絕，已closed回原終態。
- 三者結果固定 `{sessionId,leaseId,state,reclaimed}`；state=`opening|ready|closing|reclaim_pending|closed`。open最多等待10秒，尚未ready回opening，不能宣稱可操作。未完成Docker回收時reclaimed=false；open_rejected證明未配置新資源時可closed/reclaimed=true。
- 公開原 `browser_navigate|browser_snapshot|browser_click|browser_fill`，參數完全沿registry。MCP `tools/call`必有 `params._meta.whippet={sessionId,leaseId,callId}`，三UUID精確驗型、未知內部欄位拒絕；SDK v1.3.1使用`req.Params.GetMeta()`取值。callId是客戶端邏輯操作重試鍵，不是JSON-RPC id。不得將租約欄位塞入工具arguments或默默綁另一session。browser_login未有可信resolver前不列工具；不提供shell/fs/eval/publish。
- MCP工具總集合本波為原Catalog兩項＋三個控制＋四個browser，無其他未接線能力。控制工具同樣來自registry，不加入builtin skill的allowedTools。

Server保存lease的Token/Workspace/Manager、epoch、registry與scope快照、deadline、狀態及回收證據；`agent_browser_calls`以lease/callId與canonical工具名/arguments hash持久去重，發送前先寫tombstone。重送同body在記憶體有結果時回原結果，in-flight回busy；不同body拒絕，已發送但無結果／重啟後回unknown_result，不重送副作用。結果與參數內容不存journal/audit，記憶體遵守首波256 calls／2MiB快取；上限不能靠淘汰舊callId後重新執行繞過。

open交易與Run Claim鎖同Manager row，capacity計算未釋放Run＋未回收lease；Manager也保留共用容量守衛。Workspace必須active／scope confirmed；Server由權威設定產生workspaceContext，租約四項browser能力與registry hash固定，不接受客戶端Workspace或scope。每個call先重驗Token未撤銷、所有權、Workspace scope版本與期限；失效標closing並收斂，不延續舊授權。

撤銷Token同交易將其lease標closing，阻止後續工具；close由Engine送，回收完成才釋名額。Engine維持單一WSS writer及目前Manager epoch驗證，session.*分流在Run/attempt要求之前。Gateway沿有界訊息與工具128KiB結果上限，不放寬credential/history frame。

失聯／Server重啟將未回收lease標reclaim_pending，失效pending calls，只重送close，不重送open/call。heartbeat.sessions只作對帳，不以缺席推定回收；unknown／stale租約要求close。Manager同lease已回收tombstone重送原closed(true)；未知識別須核精確deterministic容器不存在或標籤吻合且移除成功才closed(true)，異lease現存record拒絕，不動其他容器。所有closed／reply必綁當前可信Manager連線與租約，遲到成功不能復活lease。Manager總期限仍為兜底回收，不因heartbeat續租。

本波驗收為隔離真MCP→Server→Manager→Docker Worker：open、navigate/snapshot/click/fill、同callId不重作、close後回收與容量恢復；另以定向測試驗跨Token/Workspace、撤銷、斷線未知結果與重啟收斂。login、session LiveView、互動產稿、claim/submit留後波，不以匿名browser成功代替它們。

## 後續接單與互動寫入邊界（未公開）

`authorEngine=builtin|external`、claim/heartbeat/submit須另固定精確wire後才公開；首波不能開external設定或宣告已支援接單。後續必綁Token/Workspace/Run/attempt/lease、同一context/skill/allowedTools/budget快照，取消／逾時失效，submit以同parser/CAS及持久冪等收斂；不採信外部自報selfTestPassed。不將session browser結果當正式validation或發佈資格。

M11.0完整完成仍須固定上述後續接縫；本文件首波已授權Server與Runtime在各自owner範圍實作，不等待其他階段。M10.Z缺口保留，不建立tag、不merge/push。

## 首波驗證

Server：隔離HTTP/DB驗初始化、精確工具列舉、跨Workspace拒絕、撤銷即拒、限流、Origin、管理gate與Bearer不能轉UI/Manager、稽核無敏感內容。Runtime：隔離IPC與容量驗重送不重click、閒置／硬期限、取消遲到結果、回收失敗不放slot、重啟孤兒清理與未知結果不重試。新功能先有失敗案例再實作；不弱化既有斷言、不重跑M1–M9。

官方依據：[Go SDK v1.3.1](https://github.com/modelcontextprotocol/go-sdk/tree/v1.3.1)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## Wave 3：網頁對話 → 外部 test-author → 正式驗證

本切片固定普通 Test 的 test-author；module/usecase/planner、credential login、session LiveView 不因本切片通過而列完成。

管理端 `PATCH /api/workspaces/{id}/author-engine` body `{revision:integer,authorEngine:"builtin"|"external"}`，沿管理gate與Workspace revision CAS，成功回完整WorkspaceDetail並增加revision；不經網站設定proposal，不修改網站scope。WorkspaceDetail與Run增加authorEngine；舊資料缺省builtin，Run建立時固定且不因後續設定變更而改寫。非test-author仍使用builtin（UI須明說此切片範圍），Manager Claim不得領external author。

新增registry11.1 MCP控制工具（所有額外欄位拒絕）：
- `task_claim({requestId:UUID})` → `{task:null|{testId:null|UUID,runId,attemptId,leaseId,state,expiresAt,deadlineAt,contextBundle}}`。由Token決定Workspace，同Token至多一active claim；requestId持久去重，重送回原claim狀態，不重開已終止任務；無可領任務回task:null（不留下禁止之後領單的空tombstone）。contextBundle含原AuthorInput/Workspace/草稿/skill與registry快照，加明確external adapter輸出說明；不含任何模型/網站憑證。允許工具以可接線子集回傳，不能列出未接的Worker-local update_draft。
- `task_heartbeat({runId,attemptId,leaseId})` → `{state,expiresAt,deadlineAt}`。短租120秒、每次續到now+120秒，永不超原AuthorInput budget硬期限（最長30分鐘）；只限原Token與仍有效Workspace/context/attempt。
- `task_tool_call({runId,attemptId,leaseId,callId:UUID,name:string,arguments:object})` → 原工具結果。至少接read_draft、read_validation_report、read_conversation_history與匿名四項browser；每個nested name必在claim實際allowedTools且按原registry inputSchema/limits驗。browser按claim綁定現有session，lazy open；占Manager slot，close確認回收才釋放。相同callId/body只回同結果；busy/unknown_result可辨且不重做。無法同步ready回busy，不能假成功。身份明示於此控制工具args，原browser arguments不改。
- `task_submit({runId,attemptId,leaseId,submitId:UUID,output:object})` → `{state,appliedRevision:integer|null,validationRunId:UUID|null}`。output沿既有author.json `{message,script?,requestValidation,conversationSummary?}`，共用decodeAuthorOutput與既有test-author完成核心；外部一律拒partial、自報selfTest/validated/proof、重複JSON key與未知欄位。同submitId+canonical output hash持久冪等，異內容拒絕；Token/Workspace/attempt/lease/context/期限/取消均重驗。人工改稿後沿原CAS保留人工稿、不啟舊revision驗證。提交候選只成scriptOrigin=ai草稿，requestValidation只排獨立keyless正式Run；不宣稱自試成功。外部claim本身不消耗Docker slot，綁定browser清理後才允許正式validation佔位執行。

claim/context指令必說明external adapter採直接提交完整候選而非Worker-local update_draft：候選尚未自試，成功以獨立正式validation證據為準。禁止外部拿Manager身分或上傳偽造artifact。submit須共用既有完成parser/CAS/validation排程，不能另造旁路草稿寫入。

取消、租約逾時、Token撤銷、Server重啟失效會讓claim終止且關閉綁定browser；遲到heartbeat/tool/submit拒絕，不復活、不重作副作用。Run/UI沿queued=接單中、running=作業中與既有terminal狀態，不新增平行UI假狀態。每次已驗Token控制呼叫沿既有安全稽核；不存參數/內容於audit。

本機bridge可在成功open/status後記唯一ready session並為原四browser工具補 `_meta.whippet` 三UUID；明示metadata不覆寫，close/terminal清除綁定，未知結果不自動重送。接單以task_tool_call身份args為主，不依賴此bridge隱式session。

驗收：真網頁選external、建立Test並送需求；全新Codex只經MCP claim/工具/submit產生腳本；網頁觀測AI草稿與獨立正式validation succeeded。另真HTTP異常驗取消/逾時/撤銷/跨Token與Workspace、競爭claim、submit冪等/CAS。合成站與scope初始化限新隔離環境，不攔截產品API、不讓QA代模型產稿。

## Wave4：外部驗收摘要

不新增MCP工具、控制schema或registry版本。Workspace authorEngine=external時，後續新acceptance-summary（普通Test、Module、Plan batch）也固定external；module-authoring/usecase-planner/workspace-author本體仍待後波。舊Run引擎快照不變。

claim沿原AuthorInput/ValidationEvidence/ModuleSummary/Batch、Workspace與budget政策快照；allowedTools=[]，不允許browser或其他nested工具。skillUri=`whippet://skill/acceptance-summary/main`，externalReferenceUri=`whippet://skill/acceptance-summary/references/external-mcp`，僅提供已打包且SHA pin的內容，不暴露憑證或模型key。原非秘密policy/model快照不因adapter任意改寫，不用它啟動外部模型。

task_submit.output按權威Run skillId判別；摘要精確`{message,description,backgroundSummary,name?}`，使用decodeSummaryOutput與duplicate/未知欄位守衛，拒script/requestValidation/partial/自報proof。完成共用原交易與summaryBindingMatches/validationProof、Module harness與回收、Plan buildPlanBatch/batchHash CAS，不能因從MCP提交而跳過任一守衛。成功仍回`{state:"submitted",appliedRevision:null,validationRunId:null}`；摘要不能產造驗證或發佈資格。原submit冪等/取消/撤銷/期限守衛沿用。

Web沿既有摘要API與Run.authorEngine/EditingSession.summary狀態，設定文案明列普通Test編修與三種驗收摘要支援external，Module/UseCase/Workspace訪談本體尚未支援。必要驗證：各摘要分支有可信驗證fixture時成功、失效證據/CAS/重複提交不越權；本wave不重跑完整UI/真模型，最後集中完整驗收。


## Wave5：外部平台作者

沿 registry11.1 與原 task 四控制工具，無新增 top-level MCP 工具。新 module-authoring、usecase-planner、workspace-author Run 依 Workspace authorEngine 固定快照；Plan Stage 的既有 author skill 也依相同規則，沒有另造 usecase-author 格式。普通 Test 與摘要維持前波行為。Manager 不領 external。互動 MCP create/edit/validate/report 留下一波。

claim 沿原 AuthorInput 與 SHA pin 的 skill/main、references/external-mcp。實際 allowedTools 是原快照與已接線工具交集：Module read_module_draft/read_validation_report/read_conversation_history；Planner read_usecase_draft/read_plan/catalog_search/catalog_get/propose_plan/read_conversation_history；Workspace read_conversation_history。匿名四項 browser 僅原快照允許且 scope 有效才可呼叫；catalog_next_page 僅原快照允許且有同 attempt 發行證據才可用。Worker-local stage/commit/update/request validation 不列可呼叫工具，browser_login 留後波。scope 未確認的 Workspace 訪談仍可文字接單，不因此獲得 browser 授權。

submit 按權威 skillId 分派，嚴格拒未知/重複欄位、partial、自報 selfTest/proof：Module `{message,script,module,requestValidation,conversationSummary?}`，module 沿原八項 metadata 加 harness（共九鍵）schema，完整候選標 ai 且未自試；共用原 Module 完成交易與正式 harness validation 排程。Planner `{message,planCandidate:{candidateRef},conversationSummary?}`，ref 必須由同 Run/attempt 經 task_tool_call(propose_plan) 的原 preparePlanStages/CAS 發行，完成只接受最後 canonical candidate；不能直接提交 stages 或偽造 ref。Workspace `{message,proposal?,conversationSummary?}`，沿原 normalizeConfig/proposal/CAS，proposal 只待人工 scope 確認。

HarnessPlatform 共用 schema/budget/scope/platform_tool_calls/candidateRef 核心，但權威明確區分 Manager epoch 與 external Token/claim lease，不假冒 Manager。workspace-author 的 test_id=NULL、無 editing_session 路徑需保持獨立權威與完成交易，不偽造 Test。所有分支保留原取消/撤銷/短租/硬期限/submit 冪等與 revision CAS；原狀態結果形狀不變，appliedRevision/validationRunId 無適用值則 null。人工 Plan/scope 確認及 publish 永不由 MCP 代做。

必要驗證限本波三種作者正向、候選/ref 權威、schema/proof 拒絕、CAS/冪等與無人工確認旁路。合成 validation 僅證明狀態機，真 Docker/UI/模型集中最後完整驗收。


## Wave6：互動 MCP 草稿與正式驗證

registry11.2 僅追加五項 server 控制工具，原工具 schema 不改；原 skill allowedTools 不自動增加控制工具。Workspace 由 Token 推導，active/confirmed scope 與原 AI scope 守衛不可略過。所有寫入保存 ai 來源與 Token 稽核，不經 manual handler；無 delete/confirm/publish。

- draft_create({requestId,kind:module|usecase,name,description,slug?}) → {testId,editingSessionId,revision,contextRevision}。Module 必有合法 slug，Use Case 禁 slug；原子建立 Test 與編輯中 AI 草稿。
- draft_get({testId}) → 有界 {test,draft,editingSession,plan,validation}；nullable 欄位明示 null，僅 Token Workspace，不回機密/ref/未遮蔽自由log，無適用Plan回null。
- author_start({requestId,testId,editingSessionId,revision,contextRevision,instruction}) → 原 task_claim 的 {task:{runId,attemptId,leaseId,state,expiresAt,deadlineAt,contextBundle}}。同交易建立 external author Run 並定向綁呼叫 Token；不改 Workspace authorEngine、不領別人的 queued Run。沿原訊息/快照、skill/parser/CAS；Agent後續使用原 task_tool_call/task_submit 真產稿。
- validation_request({requestId,testId,editingSessionId,revision}) → {state,runId:null|UUID}。Module 走原獨立 harness validation；Use Case 走原 Compose/validation 資格，未人工確認回 state=awaiting_human_plan_confirmation、runId=null，不自動confirm。成功排程 state=queued（已完成的重送也回原結果）。
- validation_report({testId,revision,runId}) → 有界正式驗證狀態與既有安全報告資料；必核同 Test/revision/Workspace，未完成不能冒充成功；不回原始 log/憑證。精確結果沿現有正式報告結構，由 Server owner 定義安全投影。

requestId 以 Token/tool/requestId 與 canonical body hash 持久去重；同鍵同body回原結果，異body拒絕，成功寫入與tombstone同交易。未確認Plan的無副作用等待結果不可永久阻止人工確認後同鍵續請；只有已排程結果才固定為完成。author_start 同 Token active claim 衝突回 busy，不建立孤兒任務。每個寫入交易重驗 Token/Workspace、原 revision/context CAS；原 task lease/短租/取消/撤銷與不知道結果不重作規則保留。UI 人工修改不能被 Agent 舊稿覆寫。

核心驗證以真 MCP/隔離 PG 驗 create→get→author_start→task工具/submit→validation_request/report、Use Case 人工確認邊界、跨Workspace/撤銷、冪等/CAS。合成報告只算狀態機；真 Module/UseCase Agent+Docker+UI集中最後驗收。


## Wave7：session 可信登入與 LiveView

沿 registry11.2，公開原 browser_login schema（獨立session及task_tool_call的原snapshot交集），不增控制工具、不改原arguments。session.open allowedTools可包含browser_login；只傳roleId/selector與安全submitted結果，WSS session.call/reply絕不傳username/password/secretRef/version。

Worker stdout新增 credential_request={kind,sessionId,leaseId,callId,requestId,roleId}；Manager只在同lease ready、未到期、active call是browser_login且roleId相同受理，經HTTPS POST /api/manager/browser-sessions/{sessionId}/leases/{leaseId}/credentials/resolve，body僅{roleId}。Server重驗目前可信Manager epoch、lease/Token未撤銷、Workspace scope與授權版本、角色快照與現行secret版本。成功回{sessionId,leaseId,workspaceId,roleId,loginOrigin,username,password}，Cache-Control:no-store；Manager禁redirect，驗TLS/大小/完整形狀/身份，僅經同容器stdin credential_response（同session/lease/callId/requestId）交值，失敗固定enum。secretRef/version不出此介面，不入Agent/WSS/journal/log。Worker IPC單reader分流tool_call與credential_response、整幀寫鎖，避免登入阻塞自身回覆。

Live控制新增session.live.start={sessionId,leaseId,viewerId,iceServers}、session.live.stop={sessionId,leaseId,viewerId}，Envelope不填runId/attemptId。viewer GET /api/browser-sessions/{sessionId}/leases/{leaseId}/live走管理cookie、精確單一Origin=WHIPPET_PUBLIC_ORIGIN、同源WS/WSS，拒Agent Bearer；media GET /api/manager/browser-sessions/{sessionId}/leases/{leaseId}/live?viewerId=...走原ManagerAuth與可信epoch。viewerId非秘密授權替代，兩端attach均重驗lease權威。共用既有signaling/單viewer/WebRTC+JPEG、Manager pump與Worker LiveObserver，不偽造Run。

GET /api/workspaces/{id}/browser-sessions → {items:[{sessionId,leaseId,state,createdAt,deadlineAt}]}，管理gate下僅列同Workspace未回收opening/ready、Token未撤銷、active/confirmed scope與授權版本一致、deadline未到、Manager在線且epoch相符，createdAt新到舊且容量有界。UI只在ready顯示監看，短ID、不露Token/角色秘密/URL。LiveViewer接獨立session wsURL，不造Run/attempt。

每session最多一viewer，沿原30秒viewer ping lease；viewer ping不延長browser idle/30分鐘硬期限，離開viewer只停媒體、不關browser。close/revoke/scope變更/逾期/Manager epoch失效即關viewer/media，Sweep兜底。Runtime沿KnownSecrets與submitLogin敏感輸入暫停/快照遮蔽，遲到credential/media不得復活；Docker確認移除後才reclaimed=true並清自己live暫存，保留journal與既有artifact。

核心檢查：可信TLS resolver成功/撤銷與錯lease拒、Worker登入submitted與秘密遮蔽、live identity/敏感暫停/close回收、Web入口build。真Docker/TLS/Agent/UI集中於本波提交後完整M11驗收。


集中驗收修補：ExternalTask.testId 必由同 Run/attempt/Workspace 的 runs.test_id 提供，Workspace 作者明示 null，讓外部接單者可讀正式驗證報告而不靠管理API。module-authoring/usecase-planner/workspace-author 的 main 與 external-mcp reference 必在實際 resources/list/read 安全allowlist，不能只在claim回不可讀URI；manifest與其餘未審reference仍拒絕。Manager session Live診斷只在自有WorkDir/diagnostics保存固定stage/error/時間與租約識別，不保存raw錯誤/URL/header/畫面/秘密；用於定位媒體失敗，不當成影格成功證據。

ExternalTask.contextBundle.toolDefinitions 必包含該claim allowedTools的原registry定義（含inputSchema/description/limits），順序沿allowedTools；與Run的registry版本/SHA一致才可回傳，摘要為空陣列。task_tool_call是通用入口，不能只給名稱而要求外部Agent猜nested參數，也不將未允許工具加入回應。
