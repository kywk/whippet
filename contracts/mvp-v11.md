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
