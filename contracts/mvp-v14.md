# v14 全站管理後台契約

ADM-0 實作基準，供 ADM-1 至 ADM-4 使用。需求以[後台規格](../docs/requirements/site-management/spec.md)為準。API 沿用 `/api`，Manager envelope 沿用 `protocolVersion:1`，MCP 沿用 `/mcp`。未列出的行為依 [v13](mvp-v13.md)、[Workspace 設定](mvp-v8.md)、[MCP](mvp-v11.md)及 [Agent runtime](mvp-v12.md#m122-wave2控制面-runtime-快照)。

## 實作基線

對照 `da7c203` 的入口與儲存資料，以下增量由 v14 定義。

| 現有實作 | v14 增量 |
| --- | --- |
| 平台 session 逐次讀 `platform_users`。`setSiteRole` 允許 `site_admin` 調整部分全站角色。成員 API 已讀寫 `workspace_memberships` 並重驗監看權限。 | 收緊原角色路由至 Super Admin。沿用成員 API，增加全站後台能力及帳號搜尋。 |
| `Workspace.lifecycle` 為 `draft`／`needs_confirmation`／`active`，直接 `PATCH /api/workspaces/{id}` 回 `405 proposal_required`。Run 已有 `workspace_id`。 | 增加獨立管理狀態與改名路由。封存檢查涵蓋同 Workspace 的所有 Run、接單與租約。 |
| Manager 以 `hello.capacity` 註冊，`heartbeat.active` 與 `sessions` 對帳。`managers.singleton` 僅允許一個 Manager。Run 與瀏覽器租約共用容量。 | 保留單 Manager 與既有身分，增加能力宣告、資源清單、派工範圍與配置工作。 |
| `/mcp` 以 Workspace Agent Token 授權。`last_used_at` 記錄 Bearer 使用。`external_author_claims` 每個 Token 至多一筆有效接單，`agent_browser_leases` 記錄瀏覽器占用。 | 依 Token 彙整互動與接單。增加接單開關、經驗證的接單能力，以及租約管理。 |
| `authorEngine=builtin\|external` 決定路由，`author.runtime.engine` 決定代管迴圈。Worker 使用部署金鑰。參考 MCP Worker 以本機金鑰支援 Vercel／Pi 的 `test-author`。 | 新增個別 Agent、探測、按主 skill 選用與代管 Key 隔離。既有路由與部署設定仍可服務未選用 Agent 的工作。 |

實作入口見 [Server 路由](../services/server/internal/server/http.go)、[角色交易](../services/server/internal/server/access.go)、[Workspace 建立](../services/server/internal/server/workspace_store.go)、[Manager 註冊與派工](../services/server/internal/server/engine.go)、[MCP 接單](../services/server/internal/server/external_author.go)、[瀏覽器租約](../services/server/internal/server/browser_leases.go)、[runtime 快照](../services/server/internal/server/agent_runtime.go)及[參考接單端](../runtimes/agent-bridge/README.md)。

## 共通格式與授權

- 新增 HTTP 路由以 UTF-8 JSON 收送。下文 `UUID` 使用 Server 既有 UUID 語法，回傳小寫。帳號 ID 與 `managerId` 沿用既有字串。時間為 UTC RFC 3339。新請求欄位皆必填，標示 `?` 才可省略，`null` 僅在型別允許時接受。新管理端 JSON 上限 16 KiB，拒絕未知欄位、重複鍵與多個 JSON 值。名稱 trim 後沿用 v8 的 1–200 UTF-8 bytes 規則。
- 新增管理清單共用 `limit=1..100`（預設 50）與選填 `after=<上頁 nextAfter>`。按回應物件 `id` 的 UTF-8 bytes 升冪，`after` 排除該 ID，回 `{items:[],nextAfter:null}` 或附下一頁用的最後一個 ID。下一頁沿用相同篩選。既有清單保留原包裝與分頁行為。
- 管理員使用 `POST /api/dev-login` 登入並沿用 `whippet_admin_session`。已設定管理 key 時只在登入送 `X-Whippet-Admin-Token`。Session 寫入請求帶符合 Server 設定的 `Origin`。既有部署 CLI 無 cookie 時可沿用管理 key 的 bootstrap 身分。Server 以目前角色、成員資格及持久化資源關聯授權，寫入及派工在交易內重驗，能力欄位供 Web 顯示。
- `/api/admin/ai/**` 全部要求 Super Admin。AI Manager 提案須由登入的人確認，再以該人的 session 送同一組 HTTP。Manager Bearer 專用於 `/api/manager/**`，Agent Bearer 專用於 `/mcp`。與 Workspace 路徑或資源關聯不符回 `404 not_found`。已登入但能力不足回 `403 forbidden`。

### 角色與能力

`GET /api/me` 與開發登入沿用 `{user:{id,name,role,permissions}}`。`role` 仍是 `superadmin`／`site_admin`／`none`。Site Manager 顯示為「Site Manager」，Workspace User 的成員值仍為 `qa`。

| `user.permissions` | Super Admin | Site Manager | Workspace Admin／User |
| --- | --- | --- | --- |
| `createWorkspace`、`manageUsers`（讀取帳號目錄） | true | true | false |
| `manageSuperAdmins`（v13 相容投影）、`manageSiteRoles` | true | false | false |
| `manageSiteWorkspaces`（全站 Workspace 入口、改名、封存及還原） | true | true | false |
| `manageAIResources`（全站 AI 入口及操作） | true | false | false |

Workspace 仍回 `permissions.{manageTests,manageSettings,manageMembers,manageWorkspaceAdmins,manageAgentTokens}`。Super Admin 及 Site Manager 原有的全站 Workspace、測試及設定操作適用。`manageAgentTokens` 僅 Super Admin。Workspace Admin 可在所屬 Workspace 指派／移除 `qa`，嘗試升任 `workspace_admin` 或改動現任 Workspace Admin 回 403。Workspace User 在成員範圍內使用 v13 測試、執行、歷史及監看能力。可寫狀態另依 Workspace 管理狀態檢查。

| HTTP | 請求與成功回應 |
| --- | --- |
| `GET /api/users?q=` | Super Admin、Site Manager。選填 `q` trim 後最多 100 UTF-8 bytes，對帳號 ID 或名稱做不分大小寫子字串比對。省略或空字串回全部，依 ID 排序。`200 {items:User[]}`。 |
| `PATCH /api/users/{userId}/role` | 僅 Super Admin，`{role:"superadmin"\|"site_admin"\|"none"}` → `200 {user}`。原路由一併收緊。交易連同操作者與目標角色鎖定名冊，任何並行異動後仍須至少有一位 `superadmin`，否則 `409 last_super_admin`。 |
| `GET /api/workspaces/{id}/members` | 沿用 v13。`200 {items:[{id,name,role}]}`，含可指派帳號，未加入者的 `role` 為 `none`。Web 以路徑中的 Workspace 及帳號名稱顯示關係。 |
| `PUT /api/workspaces/{id}/members/{userId}` | 沿用 `{role:"workspace_admin"\|"qa"\|"none"}` → `200 {member:{id,name,role}}`，`none` 刪除成員關係。提交後下一次 HTTP／報告附件讀取即套用，重查並關閉已失效的即時監看。全站角色仍保有其對應的全站權限。 |

## ADM-1 Workspace 管理

`Workspace` 在 v13 欄位外增加 `management`。`WorkspaceSummary` 為 `{id,name,lifecycle,management,permissions}`，沿用既有欄位型別。管理清單依 `management.state` 分類，其中 `active` 涵蓋設定中的 Workspace。

```ts
type WorkspaceManagement = {
  state: "active" | "archiving" | "archived"
  revision: number
  archiveMode: "drain" | "cancel" | null
  archiveStartedAt: string | null
  archivedAt: string | null
}
type ArchiveImpact = {
  queuedRuns: number
  activeRuns: number
  externalClaims: number
  browserLeases: number
  unreleasedRunSlots: number
  provisionJobs: number
}
type ManagedWorkspace = { workspace: WorkspaceSummary, impact: ArchiveImpact }
```

`activeRuns` 計算 `dispatched`、`running`、`collecting`、`cancelling` 的 Run。`externalClaims` 計算狀態仍為 `active` 的接單紀錄，包含等待期限處理者。`browserLeases` 計算尚未確認回收的租約，`unreleasedRunSlots` 計算已指派 Manager 且 `slot_released=false` 的 Run，包含終態尚待回收者。`provisionJobs` 計算尚未結案或尚未確認回收的代管探測。各計數是獨立指標，可能指向同一工作。

| HTTP | 請求與成功回應 |
| --- | --- |
| `GET /api/admin/workspaces?state=all` | Super Admin、Site Manager。`state=all\|active\|archiving\|archived`，預設 `all`。`200 {items:WorkspaceSummary[],nextAfter}`。 |
| `POST /api/workspaces` | 沿用 `{name?:string}` → `201 Workspace`。`{}` 或空名稱依舊使用「未命名工作區」。同一交易建立設定對話與 v13 預設成員，`lifecycle=draft`、`management.state=active`、管理 revision 為 1。 |
| `GET /api/workspaces`、`GET /api/workspaces/{id}` | 原本的可見範圍與回應。一般清單顯示 `active` 及 `archiving`，歷史連結或直接查詢仍可用於有權讀取的 `archived`。 |
| `GET /api/admin/workspaces/{id}` | 全站管理角色。`200 ManagedWorkspace`，在同一讀取快照提供封存預覽。 |
| `PATCH /api/admin/workspaces/{id}` | 全站管理角色。`{revision,name}` → `200 ManagedWorkspace`。保存獨立的管理名稱覆寫，投影到清單及詳情的頂層 `name`。未覆寫時沿用原名稱。v8 既有提案的 `settings.name`、範圍、登入角色、執行快照及設定 revision 照原流程處理。原 `PATCH /api/workspaces/{id}` 仍回 `405 proposal_required`。 |
| `POST /api/admin/workspaces/{id}/archive` | 全站管理角色。`{revision,mode:"drain"\|"cancel"}`。提交後 `202 ManagedWorkspace` 表示 `archiving`，已清空則 `200 ManagedWorkspace` 表示 `archived`。 |
| `POST /api/admin/workspaces/{id}/restore` | 全站管理角色。`{revision}` → `200 ManagedWorkspace`。`archived` 轉 `active`，清空三個封存欄位。`archiving` 回 `409 workspace_archiving`。 |

管理 revision 是正整數。改名、開始封存、改用取消、完成封存及還原各增加一次，單一交易直接封存時只增一次。同 revision 重複要求相同名稱、封存模式或已處於 active 的還原，回目前結果且 revision 不變。過期 revision 回 `409 stale_revision`，Web 重讀預覽。等待期間可用目前 revision 將 `drain` 升級為 `cancel`。`cancel` 改回 `drain` 或變更已完成的封存模式回 `409 conflict`。

### 封存交易

| 狀態 | 新工作與既有工作 |
| --- | --- |
| `active` | 既有 Workspace 設定、授權與容量規則適用。 |
| `archiving` | 停止新 Run、配置探測、Manager 派工、`task_claim` 領新單與任何新瀏覽器租約。交易內取消全部 `queued` Run，含作者、驗證、摘要、正式執行、Plan/Stage 後續與巡檢／部署重測佇列。原先已排隊但未送出的探測一併取消。 |
| `archived` | 歷史版本、報告、稽核、成員與設定可依目前權限查閱。新操作型寫入回 `409 workspace_archived`。 |

- 封存提交與各入口對同一 Workspace 共用交易鎖。入列、保留 Manager 名額、外部 claim、browser open（含 `task_tool_call` 延遲開啟）、探測排程都在寫入前查管理狀態。前置查詢和 Web 按鈕都無法取得名額。先取得並成功提交 attempt 者依既有工作處理，先提交封存者拒絕新工作。派工以 `queue_seq` 選第一個符合目前 Workspace、指派與能力的 Run，重驗失敗時繼續找下一筆。需要鎖多個 Workspace 時依 ID 排序，再鎖 Manager、Token 及工作紀錄；個別鎖的取得順序須涵蓋舊入口與交易內續接。
- `drain` 保留已提交的 attempt、租約、期限與快照，使其可依原授權完成。既有 `task_heartbeat`、`task_tool_call`、`task_submit` 或已建立租約的呼叫保有原權限，仍要重驗現行 Token、範圍、期限等。依原有 parser 與 revision 守衛套用草稿或提案結果。若結果要求新驗證、摘要或 Plan 下一步，保存現有證據，跳過新入列，於 `Run.progressEvents` 記錄 `workspace_archiving`。`task_submit` 的 `validationRunId` 回 `null`。原本將因此新增工作的 Plan 轉 `stopped`、`error="workspace_archiving"`，保留已完成證據；還原後可用既有 Plan 編輯與確認流程繼續。
- `cancel` 以既有 Run 取消與 `session.close` 路徑收斂。受管 Run 轉 `cancelling`，外部 claim 轉 `cancelled` 並關閉其瀏覽器，其他租約轉 `closing`。未 ACK 的受管 attempt 直接送 `cancel` 建立 tombstone，封存取消期間連離線／無網路任務也禁止再送 `dispatch`。回收確認前繼續計入占用。取消先提交時遲到結果無法再套用草稿、提案或入列。結果先提交時保留既有終態及報告，只等尚未完成的回收。
- Server 可在封存提交當下或後續對帳中完成 `archived`，前提是 `impact` 六項皆為 0。瀏覽器依現有 `session.closed` 的 `reclaimed:true` 或有根據的 open 拒絕回收。Run 依當前 Manager 對帳確認終態及名額釋放。斷線、回收失敗或尚無證據時維持 `archiving`，GET 仍顯示阻擋中的計數。Server 重啟後從資料庫接續，避免重送已取消的工作。
- `archiving` 及 `archived` 允許歷史讀取、依既有角色改名／調整成員、取消、關閉租約與撤銷憑證。新設定確認、測試／草稿編輯及發佈依管理狀態阻擋，已獲准的 drain 結果套用依上一列規則。還原後依目前成員、設定與可用資源授權新工作，保留先前的 Run 終態。

## ADM-2 AI 資源與調配

`GET /api/admin/ai/resources` → `200 {items:Resource[],nextAfter}`。`GET /api/admin/ai/resources/{resourceId}` → `200 Resource`。資源 ID 為 `manager:<managerId>` 或 `mcp:<tokenId>`，路徑使用一個 URL 編碼片段。Manager 重連沿用資源 ID，後續 Frame 由 Server 依目前 socket 世代查核。互動及接單共用 Token 時合併成同一項，UI 標示「依憑證彙整」。Agent 設定由 [`/agents`](#adm-3-agent-建立與選用) 查詢。一次性 Worker 由 `attempts` 的 `runId`＋`attemptId` 識別。

```ts
type Engine = "builtin" | "vercel" | "pi"
type Provider = "opencode" | "openai-responses"
type Skill = "test-author" | "workspace-author" | "acceptance-summary" | "module-authoring" | "usecase-planner"
type Resource = {
  id: string
  source: "manager" | "mcp"
  name: string
  agentId: UUID | null
  revision: number
  workspaceIds: UUID[] | null
  control: "enabled" | "paused" | "draining" | "removed" | "revoked"
  connection: "waiting_connection" | "online" | "offline"
  lastActivityAt: string | null
  interactiveAt: string | null
  claimAt: string | null
  capabilities: {
    modes: ("managed" | "mcp_interactive" | "mcp_claim")[]
    engines: Engine[] | null
    skills: Skill[] | null
  }
  capacity: {total: number | null, occupied: number, available: number | null}
  attempts: {runId: UUID, attemptId: UUID, workspaceId: UUID, agentId: UUID | null,
             status: RunStatus, leaseId: UUID | null}[]
  browserLeases: {sessionId: UUID, leaseId: UUID, workspaceId: UUID, runId: UUID | null,
                  state: "opening" | "ready" | "closing" | "reclaim_pending", deadlineAt: string}[]
  allowedActions: ResourceAction[]
}
```

`RunStatus` 沿用 v1 的 Run 狀態。Manager 的 `attempts` 顯示未釋放名額的 Run，`leaseId` 為 `null`。Token 的 `attempts` 顯示有效接單，`leaseId` 為接單租約。`browserLeases` 顯示未回收的瀏覽器租約，`runId=null` 表示獨立互動。相同瀏覽器可出現在 Manager 與 Token 的關聯中，占用只扣 Manager 一格。Manager `agentId=null`，`name=managerId`，`interactiveAt`、`claimAt` 為 `null`。Token `name` 沿用憑證名稱，`workspaceIds` 固定為一個 Workspace ID。

| 證據 | `connection`、能力與容量 |
| --- | --- |
| Manager WSS | 對帳成功且目前連線最近有效 heartbeat 在 60 秒內為 `online`。`lastActivityAt` 取該次 heartbeat。尚無有效 heartbeat 為 `waiting_connection`，已有有效紀錄但中斷或過期為 `offline`。`modes=["managed"]`。線上 `total` 用 `hello.capacity`，`occupied` 為未釋放 Run、未回收瀏覽器及已保留未回收探測之和。`available=max(0,total-occupied)`，另以新版 heartbeat 的 `freeSlots` 取較小值。停派、排空、移出的已知可用數均為 0。離線或缺 heartbeat 時 `total`、`available` 為 `null`。舊版 Manager 的 `engines`、`skills` 為 `null`。 |
| MCP Token | 只有核發時為 `waiting_connection`，有已授權活動且距今不超過 90 秒為 `online`，其餘為 `offline`。`lastActivityAt` 沿用最新已授權請求時間。`interactiveAt` 取最近成功互動工具時間，`claimAt` 取最近登錄、接單、有效續租或提交時間。依各自證據列入 `modes`。登錄內容提供 engine、skills，未登錄時兩欄為 `null`。之後只觀測到舊 `lastUsedAt` 的 Token，保留兩種模式未知，直到有對應事件。 |
| MCP 接單容量 | 登錄在 90 秒內有效時 `total=1`，`occupied` 為有效接單筆數，`available=1-occupied`。已暫停、Workspace 封存中／已封存、綁定的 Agent 尚未 ready 時，已知 `available=0`。缺登錄或已過期時 `total=null`、`available=null`。互動請求與瀏覽器租約不產生接單名額。Token 撤銷後為 `control=revoked`、`connection=offline`、`available=0`。 |

畫面顯示 `null` 為未知，分別加總已知 Manager slot 與已知 MCP 接單名額。Manager `workspaceIds=null` 表示依 v13 可服務所有管理狀態為 `active` 的 Workspace，陣列表示明確指派。若指派中沒有管理狀態為 `active` 的 Workspace，已知 `available=0`。派工、租約及配置均以同一容量池扣帳。

### 調配與租約操作

`POST /api/admin/ai/resources/{resourceId}/actions/{action}`。下表是 `ResourceAction` 的完整值集合。除 `reissue_access` 外，成功直接回 `Resource`。`allowedActions` 依來源和目前狀態計算。Server 仍在交易內驗來源、權限、版本及關聯。`revision` 只受調配、控制及憑證異動影響，首次為 1。操作後無狀態差異時沿用 revision。

| 來源／`action` | Body | 成功與效果 |
| --- | --- | --- |
| Manager `assign` | `{revision,workspaceIds:UUID[]\|null}` | `200`。陣列須為 1–100 個不同、管理狀態為 `active` 的 Workspace，Server 排序保存。`null` 採全站指派。只限制新名額；排空中回 `409 resource_busy`，已移出者重新指派後為 `paused`。 |
| Manager `pause_dispatch`／`resume_dispatch` | `{revision}` | `200`，在 `enabled`／`paused` 切換。原有 Run 訊息、租約續用、結果及回收繼續處理。新 Run 派工、新租約與新探測共用此閘門。`draining` 或 `removed` 回 `409 conflict`。 |
| Manager `drain_remove` | `{revision}` | `202` 表示 `draining`，停止新名額，等待已提交 attempt、租約及探測和回收。占用清空後 `removed` 且 `workspaceIds=[]`，可直接完成時回 `200`。這是移出可派工資源池，Manager 註冊與歷史識別仍可用於對帳。 |
| MCP `pause_claim`／`resume_claim` | `{revision}` | `200`。暫停只停止取得新接單 lease，同一領單已提交時可正常續租、使用原任務工具及提交。一般互動依原授權。 |
| MCP `cancel_run` | `{runId,attemptId,leaseId}` | `200`。三個 ID 必須為此 Token 及 Workspace 的同一接單。取消現行接單、阻止晚到提交，並關閉任務瀏覽器。重送同一終態接單回 200。 |
| MCP `close_browser` | `{sessionId,leaseId}` | 此 Token、Workspace 的租約轉 `closing`，回 `202`。已回收重送回 `200`。回收沿用 `session.close`／`session.closed`。 |
| MCP `revoke_access` | `{revision}` | `200`。沿用 Token 撤銷交易，同時停止關聯 Agent 的新領單，取消其使用該 Token 的排隊工作、失效接單與關閉相關瀏覽器。也適用既有 `DELETE /api/workspaces/{id}/agent-tokens/{tokenId}`，原回應為 204。 |
| MCP `reissue_access` | `{revision,workspaceId,requestId}` | `201 {resource,agent,token}`，其中 `resource` 是新 Token 的資源，`agent` 是 `Agent` 或 `null`。相同 `requestId` 安全重送回 `200 {resource,agent}`。詳見下段。 |

`allowedActions` 按上表順序列出此資源目前可用的操作。Manager 為 `enabled` 時列指派、暫停與排空，`paused` 時列指派、恢復與排空，`draining` 時列排空，`removed` 時列指派。有效 MCP Token 依控制狀態列暫停或恢復，有 active claim 或未回收瀏覽器時列相應取消／關閉，也列撤銷。接單與瀏覽器清空且尚無後繼的 Token 可列換發。已撤銷 Token 若仍有未回收租約，可以催收同一租約。

`reissue_access` 在目標 Workspace 為 `active` 且舊 Token 的接單及瀏覽器已清空時放行。尚有 active claim 或未回收 lease 回 `409 resource_busy`。同 Workspace 用於輪替，其他 Workspace 用於調配。單一交易核發新 Token、標記原 Token 撤銷且已有後繼，取消固定於舊 Token 的排隊工作。若原 Token 有 Agent，同 Workspace 保留 Agent ID 並重新驗證連線。跨 Workspace 複製同設定為新 Agent ID，舊 Agent 為 `disabled`，歷史資料及選用關聯仍指原 Agent。操作者可在目標 Workspace 選用 ready 的新 Agent。已撤銷且無後繼的 Token 可以重發，已有後繼者以新資源操作。明文採下文一次性回應及冪等規則。舊 `/mcp` Bearer 後續請求立即回 `401 unauthorized`。

調配與 claim／dispatch／open 使用同一組狀態鎖。在前者提交前已完成指派的 attempt 採原 Workspace 及租約。暫停或改派先提交時，該來源無法再領取不符條件的工作。Manager 資源選擇只影響新派工，Run 固定的 Workspace 與 Agent 選用保持有效。已提交的 Manager attempt 可重送相同 `attemptId`，也要遵守封存取消與撤銷狀態。重連透過原 journal 重播結果，結果遺失或回收待確認時保留占用。

### Manager WSS 增量

`GET /api/manager/connect`、Manager Bearer、v1 envelope、`dispatch`／`ack`／`cancel`／`event`／`result` 與 `session.*` 沿用現有協定。宣告 v14 能力的 Manager 使用 WSS，確認本機 Worker 支援下文探測與專用 Key IPC 後，附加以下 payload 欄位。

| 方向與 `type` | 新欄位及限制 |
| --- | --- |
| Manager → Server `hello` | `payload.admin` 選填 `{version:1,engines:Engine[],skills:Skill[],workerRevision:string}`。engines 與 skills 皆為非空、無重複的 enum 陣列。`workerRevision` 為已配置 Worker 映像內容識別，64 字元小寫 hex。`capacity` 仍為 1–64。 |
| Manager → Server `heartbeat` | 已宣告 `admin` 時附 `{freeSlots,activeProvisionIds:UUID[]}` 到 `payload.admin`。`freeSlots` 為 0..`capacity` 的整數，由本機 Run、session 及探測的未回收數算出。activeProvisionIds 只含未回收的探測，最多 `capacity` 筆且無重複。原 `active` 仍必填，`sessions` 沿原契約。心跳預設每 10 秒。 |
| Server → Manager `heartbeat_ack` | v14 宣告且 WSS 保護的連線收到 `{admin:{connectionNonce:string}}`，32 字元隨機小寫 hex，同一連線固定，重連換發。只用於下文 HTTPS Key 解析。舊 Manager 收 `{}`。 |

`admin` 的未知版本／格式錯誤、或新版 Manager 缺必要回報，依既有 gateway policy rejection 關閉 socket。Server 以目前已對帳的連線認定能力。v13 Manager 缺 `admin` 時仍可執行 v13 任務、取消和租約回收。Agent 探測及帶個別 Key 的 dispatch 只可送給宣告支援、能力吻合且有受保護解析通道的 Manager。

## ADM-3 Agent 建立與選用

```ts
type AgentStatus = "waiting_connection" | "verifying" | "ready" | "failed" | "disabled"
type AgentReason = "manager_unavailable" | "no_capacity" | "engine_mismatch" | "worker_changed"
  | "heartbeat_timeout" | "provider_auth_failed" | "provider_unavailable" | "probe_failed"
  | "probe_timed_out" | "cleanup_pending" | "key_missing" | "verification_required"
  | "token_revoked" | "workspace_archiving" | "workspace_archived"
type Agent = {
  id: UUID, workspaceId: UUID, name: string, revision: number
  mode: "managed" | "self_managed", engine: Engine, provider: Provider, model: string
  profileId: string | null, skills: Skill[]
  status: AgentStatus, reason: AgentReason | null
  modelKey: {configured: boolean, version: number | null} | null
  tokenId: UUID | null, probeId: UUID | null, verifiedAt: string | null
  createdAt: string, updatedAt: string
}
type NewAgent = {requestId: UUID, workspaceId: UUID, name: string, provider: Provider, model: string} & (
  {mode: "managed", engine: Engine, profileId: string, apiKey: string} |
  {mode: "self_managed", engine: "vercel" | "pi"}
)
```

`model` 沿用 v12 ID 語法及 128 字元上限。`apiKey` 為 1–4096 bytes 的 ASCII 可列印非空白字元，逐 byte 保存，僅供寫入。`modelKey` 只回版本及是否已配置。`skills` 是目前已驗證的能力（代管取探測時 Manager 宣告，自管取登錄）；尚無證據回 `[]`。`self_managed` 的 `profileId`、`modelKey` 為 `null`。`probeId` 是最近一次探測的識別（代管 `operationId` 或自管 `challengeId`），未建立時為 `null`。`verifiedAt` 只在現行配置及憑證世代已有驗證結果時有值。名稱僅用於顯示，Agent UUID 作為綁定識別。

| HTTP（皆在 `/api/admin/ai` 下） | 請求與成功回應 |
| --- | --- |
| `GET /options?workspaceId={id}` | `200 {managed:[{profileId,engine,provider,model,managerIds:string[],reason:AgentReason\|null}],selfManaged:[{engine,providers:Provider[],skills:Skill[]}]}`。代管使用 v12 有完整 provider/model 的部署 profile。符合該 Workspace、engine、能力與通道且允許派工的 Manager 列於 `managerIds`，依 ID 排序。清單空時回 `manager_unavailable`，清單有值但無名額回 `no_capacity`，其餘為 `null`。自管參考端宣告 Vercel／Pi、兩種 Provider 及 `test-author`。MCP 未啟用時 `selfManaged=[]`。 |
| `POST /agents/proposal` | `{workspaceId:UUID,instruction:string}` → `200 {proposal:{workspaceId,name,mode,engine,provider,model,profileId:string\|null}}`。自管的 `profileId` 為 `null`。顯示提案供人工修改及確認。 |
| `POST /agents` | `NewAgent` → `201 {agent,token?}`。代管 `profileId`、provider、model、engine 必須對應同一部署 profile。代管保存 Key 並啟動探測，自管核發 Agent 專用 Workspace Token 並回 `waiting_connection`。同一請求重送回 `200 {agent}`。 |
| `GET /agents?workspaceId={id}` | 選填 Workspace 篩選。`200 {items:Agent[],nextAfter}`。 |
| `GET /agents/{agentId}` | `200 Agent`，輪詢連線、探測狀態及原因。 |
| `POST /agents/{agentId}/retry` | `{revision}`。代管有可用名額時啟動一個新探測，回 `202 Agent`，無 Manager 或名額回 `200 Agent`，`status=failed` 且附原因。自管清除本世代登錄及探測通過狀態，回 `200 Agent`，`status=waiting_connection`。已有探測待結案／回收，或自管仍有有效接單時回 `409 resource_busy`。缺有效 Key 或 Token 回 `409 credential_unavailable`。 |
| `PUT /agents/{agentId}/model-key` | 代管 `{expectedSecretVersion,apiKey}` → `200 Agent`。以目前版本（從未配置送 `0`）樂觀鎖保存新 Key，前版立即撤銷。新世代 `status=failed`、`reason=verification_required`，以 `retry` 啟動驗證。 |
| `DELETE /agents/{agentId}/model-key` | 代管 `{expectedSecretVersion,confirmed:true}` → `200 Agent`。撤銷已配置的 Key，版本增加且 `configured=false`，`status=disabled`、`reason=key_missing`。與當前未配置版本相符的重送回同物件。自管模型 Key 在客戶端輪替或撤銷，輪替後可觸發 `retry` 並以同一有效 Token 重新驗證。 |
| `GET /workspaces/{id}/agent-routing` | `200 {workspaceId,revision,agents}`，`agents` 為 `{[skill in Skill]?:UUID}`，預設空物件及 revision 1。 |
| `PATCH /workspaces/{id}/agent-routing` | `{revision,skillId:Skill,agentId:UUID\|null}` → `200` 同上。只接受同 Workspace 已 ready 且支援該主 skill 的 Agent。`null` 移除該 skill 的選用。每次改變增加 routing revision。 |

- 建立、重試、換 Key 或指派 Agent 的 Workspace 須為 `active` 管理狀態。讀取及撤銷依封存政策。無支援的 mode／engine 或部署 profile 組合回 `422 unsupported_combination`；候選設定結構錯誤回 `400 invalid_request`。已配置但目前無 Manager 或容量時保存一筆 Agent，回 `failed/manager_unavailable` 或 `failed/no_capacity`，可從原 ID 重試。Key 儲存環境或 MCP 啟用條件不符時，建立請求回 503 且不建立資料。
- Agent 的 `revision` 從 1 起算，重試、Key 版本或 Token 綁定異動各增加一次，心跳及探測結果更新不增加。Agent 的設定與選用使用各自 revision。Key 由獨立單調遞增版本保護，首次建立為 1。輪替及撤銷在同一交易封鎖舊版解析、取消該 Agent 固定舊版的排隊工作與探測、對尚在執行的 attempt 發取消。已經使用的 Key 不再轉交給其他 attempt。
- 新 author Run 在入列交易依主 skill 選用 Agent，固定 `agentId` 與 `secretVersion`（代管）或 `tokenId`（自管）。代管執行路由仍是 `authorEngine=builtin`，沿用 v12 `author.runtime` 形狀並寫入該 Agent 建立時的完整非機密 profile 快照。自管路由為 `authorEngine=external`，只由指定且驗證通過的 Token 取得，contextBundle 沿 v11，客戶端使用通過驗證的本機模型設定。一般舊 Token 只領未固定 Token 的 v13 任務。專用 Token 只領固定到自己的任務。`Run` HTTP 增加可省略的 `agentId`（UUID），省略表示沿用 v13。
- 已選用但不可用的 Agent，入列回 `409 agent_not_ready`。已入列的 Run 等待適用的執行端，依取消或撤銷規則終止。未選用的主 skill 照 v13 解析 `authorEngine`、Workspace profile 與 skill override。受控繼續沿用來源 Run 的綁定、runtime 與預算，重新檢查現行憑證與權限。調配或更改選用後，新的獨立 Run 採用新選擇。正式執行及驗證沿原本無模型 Key 的路徑。

### AI Manager 自然語言提案

Super Admin 在建立表單選 Workspace，再以 `instruction` 描述配置。文字 trim 後為 1–1024 UTF-8 bytes。Server 以現行 `/options` 的非機密選項及該段文字呼叫既有 Responses 模型管道。一次請求至多一次模型呼叫、15 秒及 1,024 個輸出 tokens，工具清單為空，`store=false`。模型只能產出名稱和執行設定，Workspace 由 Server 綁定。Server 確認配置仍在支援範圍內，並在回應前重驗身分與 Workspace 狀態。

提案請求及回應均使用獨立的非機密欄位，Agent 的 Key 只由使用者在既有表單輸入。提案文字中辨識到憑證指定語法、常見 Key 格式或目前 Server 的授權憑證時，回 `422 sensitive_input`，並停止呼叫模型。Server 不保存提案文字或模型原文，只在稽核保留固定操作與錯誤分類。無法形成符合選項的配置回 `422 proposal_rejected`，模型未配置、錯誤或逾時回 `503 proposal_unavailable`。提案路由不建立 Agent、Token 或驗證工作。

例如輸入 `{"workspaceId":"11111111-1111-4111-8111-111111111111","instruction":"用 Pi 建立自管 Agent，模型 fixture-model，名稱是付款回歸"}`，回應為下列 JSON。Web 將配置帶回既有表單。Super Admin 可以修改名稱或設定，確認後才用同一 session 送 `POST /agents`，由建立交易重新驗證。

```json
{"proposal":{"workspaceId":"11111111-1111-4111-8111-111111111111","name":"付款回歸","mode":"self_managed","engine":"pi","provider":"openai-responses","model":"fixture-model","profileId":null}}
```

### 建立重送及秘密欄位

`POST /agents` 與 `reissue_access` 以 `(呼叫者種類及 ID, 操作, requestId)` 持久去重，bootstrap 與人員 session 有獨立識別。提交時同一交易保存目標 ID、正規化請求指紋及初始狀態／待處理動作。輸入指紋包含 path 目標、非機密欄位和代管 Key 的等值檢查；Key 使用 Server 從 Vault 主金鑰以獨立用途衍生的 HMAC-SHA256，不儲存明文或可離線猜測的未加鑰雜湊。相同請求先重查操作者及目標權限，再讀取原 ID 的目前狀態；不同內容回 `409 idempotency_conflict`。已成功提交的重送優先查憑據，包含 reissue 原有 revision 已增加的情況。失敗探測透過 `retry` 開新工作。

自管 Token 沿既有隨機值與雜湊保存。明文只在首次成功提交的 `201` 回應送出，即使該回應遺失，重送仍只回識別與狀態。後續以 `reissue_access` 換發。接入 URL 為部署公開基底 URL 加 `/mcp`（保留反向代理前綴）。Web 可在建立完成當下提供接入指引及一次性複製，Token 與自管模型 Key 由操作者分別設定到客戶端機密來源。

代管 Key 操作及 v14 Token 核發／換發沿 v8 `protectedCredentialTransport`（Server TLS 或實際雙端 loopback），Manager 解析一律要求 Server TLS。保存沿現有 Vault 的 AES-256-GCM，獨立資料列以 `(workspaceId,agentId,secretVersion)` 約束，AEAD 的附加驗證資料為 `whippet-agent-key-v1:<workspaceId>:<agentId>:<secretVersion>`。密文與 nonce 僅在 Server。代理記錄、模型對話及請求內容、草稿、日誌、報告、稽核、任務快照、journal、檔案、命令列與容器環境皆不得包含明文。含 Key／Token 的輸入與回應關閉 body 記錄並回 `Cache-Control: no-store`。供應商認證依既有 Responses transport 使用該 Agent 的 Key。key guard 涵蓋傳送給模型的內容及寫回平台的結果。

### 代管配置、探測與 Key 解析

每個代管 Agent 先由 Manager 保留一個同池 slot，執行一次性的模型探測。`test-author` 等主 skill 的實際 Run 仍由原入口排程。探測限 30 秒、1 次模型請求、0 個工具、最多 128 output tokens，無使用者或網站資料，輸出必須等於固定挑戰字串 `WHIPPET_PROBE:<operationId>`（允許去除前後空白）。指定的引擎、provider、model 與祕密世代皆要與建立時一致。provider HTTP 401／403 轉 `provider_auth_failed`，傳輸或其他 provider HTTP 錯誤轉 `provider_unavailable`，成功傳輸但無有效挑戰回應轉 `probe_failed`。對管理端只傳固定狀態與原因。

| WSS/frame | 精確增量 |
| --- | --- |
| Server → Manager `agent.provision` | envelope 無 `runId`／`attemptId`。`payload={operationId,agentId,workspaceId,secretVersion,runtime,deadlineAt}`。三個 ID 皆 UUID，`runtime` 為完整 v12 `author.runtime`。 |
| Server → Manager `agent.provision_cancel` | 同 envelope，`payload={operationId}`。封存取消、Key 撤銷或逾時使用此路徑。 |
| Manager → Server `agent.provision_result` | 同 envelope，`payload={operationId,status,code,reclaimed}`。status 為 `succeeded`／`failed`／`cancelled`／`timed_out`。`succeeded` 或 `cancelled` 的 `code=null`，`timed_out` 為 `probe_timed_out`，`failed` 為 `provider_auth_failed`／`provider_unavailable`／`probe_failed`／`key_missing`。`reclaimed` 為 boolean。 |
| Server → Manager `dispatch` | 只有代管 Agent 的作者任務在原 payload 頂層加 `modelCredential:{agentId,secretVersion}`。`runId`／`attemptId` 與原作者欄位照 v12。一般 Run、驗證、舊作者任務一律省略 `modelCredential`。 |

配置保留的 `operationId` 作為 journal 及回收對帳鍵。Server 提交 slot 與操作後才送出，與正常 Run 及租約共用 Manager 容量鎖。Manager 在啟動前持久化操作。重送相同操作回現況或重播結果。逾時或同 ID、不同內容不得啟動。Server 處理結果時核對原指派、現行 socket、`operationId` 及 Server 決定的終態。斷線且結果不明時，Server 在重連後要求回收同 ID 的配置，只接受有效回收證據，舊探測不再啟動。未回收或回收失敗維持占用、`verifying/cleanup_pending`。同一結果可以從 `reclaimed:false` 更新為 `true`，僅 `true` 釋放占用。`succeeded` 且目前驗證世代仍相同才轉 ready。錯 Key 設為 `failed` 並保留 Agent 設定供輪替。心跳過期停止新派工並顯示 `failed/heartbeat_timeout`。Manager 以相同 ID、Worker 內容和已驗證配置重連並對帳後可恢復。`workerRevision` 改變時顯示 `failed/worker_changed` 並重新探測。

`POST /api/manager/agent-keys/resolve` 使用 Manager Bearer 及 `X-Whippet-Manager-Session: <connectionNonce>`。`purpose` 決定以下完整 request schema，所有 ID 為 UUID 且 `secretVersion` 為正整數。

```ts
type KeyRequest = {agentId: UUID, secretVersion: number} & (
  {purpose: "run", runId: UUID, attemptId: UUID} |
  {purpose: "probe", operationId: UUID}
)
type KeyResolution = KeyRequest & {workspaceId: UUID, apiKey: string}
```

回 `200 KeyResolution` 及 `Cache-Control: no-store`。Server 比對目前 WSS 世代和 nonce、Manager／Workspace、活躍 attempt 或配置、固定 Agent 和 Key 世代、未撤銷、期限及封存模式。允許同一有效嘗試的解析請求重送，失效後回 `409 credential_unavailable`。Manager 核對整份回應識別，經該容器的私有 stdin IPC 傳入。指定 Key 的作者容器執行 `node dist/author/main.js --managed-model-key`，input 在原格式加非機密 `modelCredential:{agentId,secretVersion}`。探測容器執行 `node dist/author/probe.js --managed-model-key`，`/work/input.json` 使用原 `agent.provision` payload，結果 `/work/output/probe.json` 為 `{status,code}`（型別同配置結果），Manager 依容器回收證據附 `reclaimed`。兩種模式皆在呼叫模型前向 Manager 送一筆請求。

| IPC | 單行 NDJSON，最大 32 KiB（含序列化） |
| --- | --- |
| Worker stdout | `{kind:"model_key_request",requestId,agentId,secretVersion}` |
| Manager stdin | `{kind:"model_key_response",requestId,agentId,secretVersion,apiKey}` 或 `{kind:"model_key_response",requestId,code:"credential_unavailable"}` |

`requestId` 為 UUID，Manager 依 stdout 所屬容器綁定原 attempt／probe。單一請求等候上限 15 秒，最多接受一筆有效請求。Worker 用同一 stdin 分流，檢查識別與 Key 版本，錯誤或逾時停止。此模式禁止使用或繼承部署模型 Key；未選用 Agent 的任務依原方式載入部署設定。Worker 結束／取消時清理持有的 Key，對非模型程序與子程序隔離。

### 自管 MCP 連線與探測

保留既有 Streamable HTTP `initialize`、`tools/call`、工具 schema、registry 與 claim/submit 快照。在相同 `POST /mcp` 增加下列 JSON-RPC 控制 method，沿用既有 Agent Bearer、Origin、速率與請求大小限制。客戶端先正常初始化，後續附協商的 `MCP-Protocol-Version`。控制 method 要求單一有 `id` 的 JSON-RPC 請求，使用 `params`，成功回 `{jsonrpc:"2.0",id,result}`。這三個 method 只有接單客戶端呼叫，在 `tools/list` 之外。Server 將登錄及驗證狀態綁定 Token，避免共用 Token 重複算容量。

| `method` | `params` 與 `result` |
| --- | --- |
| `whippet/agent/register` | `{engine:Engine,provider:Provider,model,skillIds:Skill[]}` → `{registrationId,heartbeatIntervalMs:30000,expiresAt,challenge:{id,expiresAt}\|null}`。skillIds 需非空且各異，專用 Token 與對應 Agent 的 engine、provider、model 及方案宣告的 skills 一致。重送相同登錄在 90 秒有效期內沿用 ID 與挑戰。 |
| `whippet/agent/probe` | `{registrationId,challengeId,status:"passed"\|"provider_auth_failed"\|"provider_unavailable"\|"probe_failed"}` → `{status:AgentStatus,reason:AgentReason\|null}`。專用 Token 的挑戰在 30 秒內有效，成功／失敗只接受一次，相同結果重送回目前狀態，異內容回 `conflict`。 |
| `whippet/agent/heartbeat` | `{registrationId}` → `{expiresAt}`。每次有效回報續期至 `now+90s`，專用 Token 綁目前登錄，過期須重新登錄。與現有 `task_heartbeat` 續單分開。 |

自管專用 Token 初始 `waiting_connection`，登錄吻合轉 `verifying` 並回挑戰。客戶端以當地設定及同一引擎執行前述 1 次、0 工具的探測（用 `challengeId` 代替 `operationId`），核對輸出後只送狀態 enum。Server 依當前 Token、登錄及挑戰驗收回報。自管結果是客戶端的執行證據，Server 不持有或直接驗證其 provider Key。成功才可 claim 固定到該 Agent 的工作。引擎或設定不符為 `failed/engine_mismatch`，挑戰逾時為 `failed/probe_timed_out`，登錄逾時為 `failed/heartbeat_timeout`。管理端 `retry` 可清除失敗證據並核發下一次登錄的挑戰。挑戰結果失敗時重新登錄仍回原登錄及無待處理挑戰，直至 `retry` 或登錄過期。

登錄是新 claim 的能力閘門。暫停、登錄過期、重新指派設定時，已提交的有效接單仍依原租約與期限判定，可安全完成。撤銷、明確取消或現有 scope 檢查失敗使接單失效。獨立互動的授權與工具、瀏覽器租約規則沿 v11，歸屬單一 Workspace。舊 Agent Token 可原樣使用 MCP；選擇登錄時只提供活動與接單能力，回 `challenge:null`。Agent 專用 Token 在尚無 ready 證據時，`task_claim` 回 `agent_not_ready`。新版接單端依凍結任務預算呼叫 `task_heartbeat`／`task_tool_call`／`task_submit`，候選稿仍由 Server 共用 parser 驗證，後續驗證與人工發佈沿既有 Harness。

## 錯誤與稽核

HTTP 錯誤沿用 `{error:{code,message}}`。客戶端依 `code` 分支，`message` 使用可顯示的固定句子。Server 先查身分及操作權限，再查資源歸屬及狀態。既有 MCP Token 管理與稽核路由同樣先驗 Super Admin 權限，再回功能停用狀態。

| HTTP | `error.code` | 條件 |
| --- | --- | --- |
| 400 | `invalid_request`、`protected_transport_required` | JSON、query 或欄位不符契約。需要保護的 Key／Token 路徑缺少所需傳輸。 |
| 401 | `unauthorized` | session 無效，或 Manager／MCP Bearer 缺失、無效或已撤銷。 |
| 403 | `forbidden` | 角色、允許的身分類型或 Origin 檢查失敗。 |
| 404 | `not_found` | 資源不存在、Workspace 不可見，或指定關聯不符。 |
| 405 | `proposal_required` | 直接 `PATCH /api/workspaces/{id}`。沿用 `Allow: GET`。 |
| 409 | `stale_revision`、`conflict` | 新管理 revision／Key 版本與目前值不符，或狀態轉換不成立。 |
| 409 | `last_super_admin` | 會移除最後一位 Super Admin。 |
| 409 | `workspace_archiving`、`workspace_archived` | Workspace 狀態禁止操作。 |
| 409 | `action_unavailable`、`resource_busy` | 來源不支援該操作，或仍有接單、回收或探測。 |
| 409 | `agent_not_ready`、`credential_unavailable` | 所選 Agent 尚不可用，或憑證查核中的租約、attempt、世代、版本或期限已失效。 |
| 409 | `idempotency_conflict` | 同一 `requestId` 對應不同輸入。 |
| 422 | `unsupported_combination` | Agent 設定組合未列入可用方案，或 Agent 不支援該 skill。 |
| 422 | `proposal_rejected`、`sensitive_input` | 提案未形成合法配置，或提案文字疑含憑證。 |
| 503 | `proposal_unavailable` | 既有控制面模型未配置、呼叫失敗或逾時。 |
| 429、503 | `rate_limited`、`disabled`、`secrets_unavailable` | MCP 既有限流與停用，或設定機密儲存不可用。MCP 429 沿用 `Retry-After: 1`。 |

- MCP 工具失敗仍由 JSON-RPC `result.isError:true` 表示。v14 狀態阻擋回 `structuredContent:{error:code}` 與一筆 `content:[{type:"text",text:code}]`。新增 `claim_paused`、`agent_not_ready`、`workspace_archiving`、`workspace_archived`，保留原 `busy`、`unknown_result` 等碼。無符合資格的排隊工作仍回 `{task:null}`。暫停或 drain 時，相同 `requestId` 仍可查回已有效領取且未被取消的同一 attempt。封存完成後 `task_claim` 一律回 `workspace_archived`。已提交的相同 `submitId` 仍可依原 Token／歸屬查回收據。
- 新 MCP 控制 method 的格式錯誤回 JSON-RPC `error.code=-32602`、`data.code="invalid_request"`。有效請求的狀態衝突回 `-32000`，`data.code` 為 `conflict`、`agent_not_ready`、`workspace_archiving` 或 `workspace_archived`。錯誤 `message` 固定為 `agent control request failed`。已撤權先走 HTTP 401。新登錄、探測及登錄心跳在封存中／封存後拒絕，既有接單續租依封存模式判定。
- 管理稽核至少保存 `{actorKind,actorId,at,action,targetType,targetId,workspaceId,outcome,code,requestId}`。`actorKind=user|bootstrap|manager|agent_token|system`。`outcome=succeeded|accepted|denied|failed`。`workspaceId`、`code`、`requestId` 無適用值時為 `null`。對象及操作者使用既有 ID（含 Token ID），`action` 使用操作名稱。涵蓋全站角色、成員、Workspace 封存／還原、資源調配、Run 取消、租約關閉、Agent 建立／探測／Key 與 Token 異動。變更成功的稽核與變更同交易，異步結案用同一對象及操作識別，拒絕及失敗只留固定分類。冪等重送沿原操作憑據，互動工具稽核沿 v13 格式。稽核只包含識別、結果及時間。

## 舊版預設與遷移

| 資料或客戶端 | v14 預設／相容規則 |
| --- | --- |
| 舊 Workspace | `management={state:"active",revision:1,archiveMode:null,archiveStartedAt:null,archivedAt:null}`。管理名稱沿原名稱，既有 `lifecycle` 與設定／授權 revision 依原資料。 |
| 角色與 Web | 保留既有身分、角色值、成員及欄位。v14 Web 讀舊 Server 時新增平台權限缺欄視為 `false`，Workspace 缺 `management` 視為上列預設。舊 Web 沿原 JSON 包裝解析，Site Manager 呼叫舊角色寫入會收到 403。 |
| 舊 Manager | `workspaceIds=null,control="enabled",revision=1`。派工能力宣告未知時沿 v13 派工，適用新 Workspace／暫停閘門。缺回收證據照原 journal 對帳。新版 Manager 收到空 `heartbeat_ack` payload 時按 v13 處理該連線。 |
| 舊 MCP／Token | `control="enabled"`（若已撤銷則 `revoked`），資源 revision 1，Agent 關聯空值，未登錄容量未知。原 MCP 工具與瀏覽器操作照舊，`task_claim` 只能接 v13 未固定 Agent 的任務，仍經 Workspace、暫停及資源閘門。 |
| 舊 Run／Workspace runtime 選擇 | `agentId` 省略、Agent 選用表為空。原 `authorEngine`、profile、預算與路由維持資料原值。快照與收據保持原關聯。 |

Server 持久化 Workspace 管理狀態與 revision、Manager 指派／控制、Token 接單狀態與 Agent 關聯、Agent 非機密快照與個別 Key 版本、選用表、配置工作、冪等憑據及管理稽核。以唯一約束保護同 Token 後繼、同 Agent 當前有效 Key 世代、同 Workspace／主 skill 選用與配置工作 ID。Run 採附加的不可變 Agent 綁定及原 Workspace owner，既有 MCP lease、Manager slot 與 journal 仍為回收依據。

## 驗收範例

以下以全新隔離資料庫與四個 v13 開發帳號為起點。固定 ID、日期與 provider 回應可用於 Web mock、Server 測試與 Runtime fixture。HTTP 樣例使用部署的公開基底 URL（含代理前綴）。

### A1 角色、建立 Workspace 與撤權

此 Bash 範例可在 ADM-1 接線後執行。`BASE_URL` 預設為 `http://127.0.0.1:8080`。有代理前綴時設定 `PUBLIC_ORIGIN` 為不含路徑的公開 origin。`DEV_ADMIN_TOKEN` 用驗收部署的開發登入 key。

```bash
set -eu
base=${BASE_URL:-http://127.0.0.1:8080}
origin=${PUBLIC_ORIGIN:-$base}
fixture_dir=$(mktemp -d)
trap 'rm -f "$fixture_dir"/*.cookie "$fixture_dir/result.json"; rmdir "$fixture_dir"' EXIT

login() {
  curl -fsS -c "$fixture_dir/$1.cookie" -H "Origin: $origin" \
    -H "X-Whippet-Admin-Token: ${DEV_ADMIN_TOKEN:-}" -H 'Content-Type: application/json' \
    --data "{\"userId\":\"$1\"}" "$base/api/dev-login" >/dev/null
}

expect() {
  local want=$1 actor=$2 path=$3 got
  shift 3
  got=$(curl -sS -b "$fixture_dir/$actor.cookie" -H "Origin: $origin" \
    -H 'Content-Type: application/json' -o "$fixture_dir/result.json" -w '%{http_code}' \
    "$@" "$base$path")
  [[ "$got" == "$want" ]]
}

for actor in dev-admin dev-site-admin dev-workspace-admin dev-qa; do login "$actor"; done
expect 201 dev-site-admin /api/workspaces --data '{"name":"全站驗收 A"}'
a=$(jq -er '.id' "$fixture_dir/result.json")
expect 201 dev-site-admin /api/workspaces --data '{"name":"全站驗收 B"}'
b=$(jq -er '.id' "$fixture_dir/result.json")
expect 200 dev-site-admin '/api/users?q=dev-qa'
jq -e '.items | length == 1 and .[0].id == "dev-qa"' "$fixture_dir/result.json" >/dev/null
for workspace in "$a" "$b"; do
  expect 200 dev-site-admin "/api/workspaces/$workspace/members/dev-qa" -X PUT --data '{"role":"qa"}'
done
expect 403 dev-site-admin /api/users/dev-qa/role -X PATCH --data '{"role":"site_admin"}'
expect 403 dev-site-admin /api/admin/ai/resources
expect 409 dev-admin /api/users/dev-admin/role -X PATCH --data '{"role":"none"}'
jq -e '.error.code == "last_super_admin"' "$fixture_dir/result.json" >/dev/null
expect 403 dev-workspace-admin "/api/workspaces/$a/members/dev-qa" -X PUT --data '{"role":"workspace_admin"}'
expect 403 dev-qa /api/admin/workspaces
expect 200 dev-site-admin "/api/workspaces/$a/members/dev-qa" -X PUT --data '{"role":"none"}'
expect 404 dev-qa "/api/workspaces/$a"
expect 200 dev-qa "/api/workspaces/$b"
```

### A2 封存、回收與還原

預先在 Workspace 準備兩個 queued Run、一個執行中的受管 Run、一個尚未回收的獨立 MCP 瀏覽器租約與一份歷史報告。用 `GET /api/admin/workspaces/{id}` 讀影響預覽，`queuedRuns=2`、`activeRuns=1`、`browserLeases=1`、`unreleasedRunSlots=1`。

`POST /api/admin/workspaces/11111111-1111-4111-8111-111111111111/archive`，body `{"revision":1,"mode":"drain"}` → `202`。

```json
{
  "workspace": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "付款驗收",
    "lifecycle": "active",
    "management": {"state":"archiving","revision":2,"archiveMode":"drain","archiveStartedAt":"2026-11-26T06:10:00Z","archivedAt":null},
    "permissions": {"manageTests":true,"manageSettings":true,"manageMembers":true,"manageWorkspaceAdmins":true,"manageAgentTokens":false}
  },
  "impact": {"queuedRuns":0,"activeRuns":1,"externalClaims":0,"browserLeases":1,"unreleasedRunSlots":1,"provisionJobs":0}
}
```

對同 Workspace `POST /api/tests/{id}/runs` 回 `409`。

```json
{"error":{"code":"workspace_archiving","message":"工作區封存中，暫停接受新工作。"}}
```

等待情境下原 Run 可完成，租約續用後關閉。取消情境改送 `{"revision":2,"mode":"cancel"}`，驗證在回收前維持 `archiving`，並拒絕遲到結果寫入。輪詢詳情至 `state=archived`、各計數為 0。以回傳的當前 `revision` 送 `POST .../restore`，`GET /api/runs/{原歷史Run}/artifacts` 仍成功，新 Run 可進入佇列，原兩個 Run 仍為 `cancelled`。

### A3 WSS、資源、暫停與改派

同一 WSS 連線先後送下列兩筆 JSON（陣列中的每一項是一個 frame）。以同 `managerId` 重連且完成對帳後，資源清單只有一個 `manager:runner-a`。

```json
[
  {"protocolVersion":1,"messageId":"hello-1","type":"hello","managerId":"runner-a","payload":{"capacity":3,"admin":{"version":1,"engines":["builtin","vercel","pi"],"skills":["test-author"],"workerRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}},
  {"protocolVersion":1,"messageId":"heartbeat-1","type":"heartbeat","managerId":"runner-a","payload":{"active":[],"sessions":[],"admin":{"freeSlots":3,"activeProvisionIds":[]}}}
]
```

之後一筆受管 Run 及一筆獨立 MCP 瀏覽器租約均已占用 Manager，且同 Token 有一筆接單及兩種活動。`GET /api/admin/ai/resources` 的完整成功範例如下。

```json
{
  "items": [
    {
      "id":"manager:runner-a","source":"manager","name":"runner-a","agentId":null,"revision":1,
      "workspaceIds":null,"control":"enabled","connection":"online",
      "lastActivityAt":"2026-11-26T06:15:00Z","interactiveAt":null,"claimAt":null,
      "capabilities":{"modes":["managed"],"engines":["builtin","vercel","pi"],"skills":["test-author"]},
      "capacity":{"total":3,"occupied":2,"available":1},
      "attempts":[{"runId":"22222222-2222-4222-8222-222222222222","attemptId":"33333333-3333-4333-8333-333333333333","workspaceId":"11111111-1111-4111-8111-111111111111","agentId":null,"status":"running","leaseId":null}],
      "browserLeases":[{"sessionId":"44444444-4444-4444-8444-444444444444","leaseId":"55555555-5555-4555-8555-555555555555","workspaceId":"11111111-1111-4111-8111-111111111111","runId":null,"state":"ready","deadlineAt":"2026-11-26T06:40:00Z"}],
      "allowedActions":["assign","pause_dispatch","drain_remove"]
    },
    {
      "id":"mcp:66666666-6666-4666-8666-666666666666","source":"mcp","name":"外部驗收端","agentId":null,"revision":1,
      "workspaceIds":["11111111-1111-4111-8111-111111111111"],"control":"enabled","connection":"online",
      "lastActivityAt":"2026-11-26T06:15:02Z","interactiveAt":"2026-11-26T06:14:55Z","claimAt":"2026-11-26T06:15:02Z",
      "capabilities":{"modes":["mcp_interactive","mcp_claim"],"engines":["pi"],"skills":["test-author"]},
      "capacity":{"total":1,"occupied":1,"available":0},
      "attempts":[{"runId":"77777777-7777-4777-8777-777777777777","attemptId":"88888888-8888-4888-8888-888888888888","workspaceId":"11111111-1111-4111-8111-111111111111","agentId":null,"status":"running","leaseId":"99999999-9999-4999-8999-999999999999"}],
      "browserLeases":[{"sessionId":"44444444-4444-4444-8444-444444444444","leaseId":"55555555-5555-4555-8555-555555555555","workspaceId":"11111111-1111-4111-8111-111111111111","runId":null,"state":"ready","deadlineAt":"2026-11-26T06:40:00Z"}],
      "allowedActions":["pause_claim","cancel_run","close_browser","revoke_access"]
    }
  ],
  "nextAfter":null
}
```

- `POST /api/admin/ai/resources/manager%3Arunner-a/actions/assign`，body `{"revision":1,"workspaceIds":["00000000-0000-4000-8000-000000000002"]}`，第二個 Workspace 須已存在且管理狀態為 `active`。`200` 回 `revision=2`，原 `attempts[0].workspaceId` 及 `browserLeases[0].workspaceId` 保持原 ID。另一個對原 Workspace 的新派工須等待可用指派。
- `POST /api/admin/ai/resources/mcp%3A66666666-6666-4666-8666-666666666666/actions/pause_claim`，body `{"revision":1}` → `200`、`control=paused`。原 claim 繼續 heartbeat，新的 `task_claim` requestId 會收到下例。改派請求在既有接單或租約未清空時回 `409 resource_busy`。接單與暫停各自先提交的情境都應驗證，且查核 Run 與 claim 只各一筆。

```json
{"jsonrpc":"2.0","id":7,"result":{"isError":true,"structuredContent":{"error":"claim_paused"},"content":[{"type":"text","text":"claim_paused"}]}}
```

### A4 建立、重送與金鑰隔離

部署 profile `adm-fixture` 使用下例 `runtime` 的 provider、baseURL、model、reasoningEffort 及容量。Manager 宣告支援 `builtin`，兩個 Workspace 均可派新版 Worker。`POST /api/admin/ai/agents` 的合成請求及 `201` 回應如下（前者為陣列第一項）。

```json
[
  {"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","workspaceId":"11111111-1111-4111-8111-111111111111","name":"付款 Agent","mode":"managed","engine":"builtin","profileId":"adm-fixture","provider":"openai-responses","model":"fixture-model","apiKey":"fixture-wrong-key"},
  {"agent":{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","workspaceId":"11111111-1111-4111-8111-111111111111","name":"付款 Agent","revision":1,"mode":"managed","engine":"builtin","provider":"openai-responses","model":"fixture-model","profileId":"adm-fixture","skills":[],"status":"verifying","reason":null,"modelKey":{"configured":true,"version":1},"tokenId":null,"probeId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","verifiedAt":null,"createdAt":"2026-11-26T06:20:00Z","updatedAt":"2026-11-26T06:20:00Z"}}
]
```

Server 送同一個配置 ID 給 Manager。下例為完整配置 frame 及錯 Key 回報。

```json
[
  {"protocolVersion":1,"messageId":"provision-1","type":"agent.provision","managerId":"runner-a","payload":{
    "operationId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","agentId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","workspaceId":"11111111-1111-4111-8111-111111111111","secretVersion":1,"deadlineAt":"2026-11-26T06:20:30Z",
    "runtime":{"schemaVersion":1,"profileId":"adm-fixture","engine":"builtin","provider":"openai-responses","baseURL":"https://provider.example/v1","model":"fixture-model","reasoningEffort":"low","contextWindowTokens":32768,"contextInputTokens":16384,"sha256":"f1c7c028e2ef99c34ea000d3f3b271d56516a710182ce23e73f58c4388bea198"}
  }},
  {"protocolVersion":1,"messageId":"provision-result-1","type":"agent.provision_result","managerId":"runner-a","payload":{"operationId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","status":"failed","code":"provider_auth_failed","reclaimed":true}}
]
```

- 以同 body 重送建立時得到同一 Agent ID 與 `failed/provider_auth_failed`，Manager 只收到一筆邏輯配置。沿用該 `requestId` 但改 `apiKey` 則回 `409 idempotency_conflict`。此時對該 Agent 選用回 `409 agent_not_ready`。
- 以 `PUT /api/admin/ai/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/model-key` 送 `{"expectedSecretVersion":1,"apiKey":"fixture-key-a"}`，回 `modelKey.version=2`、`revision=2`。再 `POST .../retry` 送 `{"revision":2}`，接收探測成功結果並等回收，讀 Agent 得 `ready`。
- `PATCH /api/admin/ai/workspaces/11111111-1111-4111-8111-111111111111/agent-routing` 送 `{"revision":1,"skillId":"test-author","agentId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}`，回 `200`，`revision=2`，`agents.test-author` 為該 ID。送一輪一般測試對話，檢查 Run 綁定該 Agent。
- 第二個 Workspace 以另一 `requestId` 建立 Agent，使用同 profile 及 `fixture-key-b`，完成配置後選用。第一個 Agent 探測失敗或輪替時，第二個 Agent 可繼續正常執行。合成 provider 只在對應連線認證收到各自的 Key。任一 Agent 的解析請求改帶另一個 Agent ID 回 `404 not_found`。舊版本 Key 即使同 attempt 也回 `409 credential_unavailable`。對話、一般 API 回應、journal、報告與日誌均需掃描兩筆合成 Key。

### A5 MCP 回連與入口驗證

以 `POST /api/admin/ai/agents` 建立以下自管 Agent，`201` 回 `agent.status=waiting_connection` 及一次性 Token，重送省略 `token`。

```json
{"requestId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","workspaceId":"11111111-1111-4111-8111-111111111111","name":"自管付款 Agent","mode":"self_managed","engine":"pi","provider":"openai-responses","model":"fixture-model"}
```

以核發的 Token 初始化 `/mcp` 後，先登錄，再由客戶端完成合成探測。以下各物件依序為登錄請求、回應及探測回報。

```json
[
  {"jsonrpc":"2.0","id":2,"method":"whippet/agent/register","params":{"engine":"pi","provider":"openai-responses","model":"fixture-model","skillIds":["test-author"]}},
  {"jsonrpc":"2.0","id":2,"result":{"registrationId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","heartbeatIntervalMs":30000,"expiresAt":"2026-11-26T06:26:30Z","challenge":{"id":"ffffffff-ffff-4fff-8fff-ffffffffffff","expiresAt":"2026-11-26T06:25:30Z"}}},
  {"jsonrpc":"2.0","id":3,"method":"whippet/agent/probe","params":{"registrationId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","challengeId":"ffffffff-ffff-4fff-8fff-ffffffffffff","status":"passed"}}
]
```

Server 回 `result:{status:"ready",reason:null}`。選用這個 Agent 後送一般測試對話，以原 `task_claim({requestId})` 領取固定到該 Token 的 Run。沿 v11 用領取的 `runId`、`attemptId`、`leaseId` 呼叫心跳、工具與提交。用另一個 Workspace 的有效 Token 送同一組 `task_heartbeat`／`task_submit` 應得到 MCP `isError:true`。由 Super Admin 撤銷後，用舊 Token 送 `task_heartbeat` 應得 HTTP `401 unauthorized`。

| 正常入口 | 放行證據 | 拒絕或隔離證據 |
| --- | --- | --- |
| Web 對話 → 內建 Worker | 代管 `builtin` Agent 探測、實際作者 Run、正式驗證與人工發佈門檻 | Workspace 封存後新 Run 拒絕，撤銷後舊 Key 解析拒絕 |
| Web 對話 → Vercel adapter | `author.runtime.engine=vercel`，同一 Harness、自己的模型 Key | 跨 Agent／Workspace Key 解析與未授權工具拒絕 |
| Web 對話 → Pi adapter | `author.runtime.engine=pi`，同一 Harness、自己的模型 Key | 暫停／封存時無新派工，既有取消與回收可收斂 |
| MCP 互動 | `browser_session_open` → 授權範圍內呼叫 → `browser_session_close` → 確認回收 | 他 Workspace Token、已撤銷 Token 或已封存 Workspace 無法使用租約或開新租約 |
| MCP 接單 | 登錄 → 探測 → `task_claim` → heartbeat／工具 → `task_submit`，記錄候選與正式驗證 | 未驗證、暫停、跨 Workspace 或撤權拒絕，submit 重送只回原收據 |

ADM-4 每條記錄實際入口、Runtime、使用的 provider 或合成回應、工作與嘗試 ID、預期及實際狀態、證據位置及尚未驗證範圍。本文範例為 ADM-0 的預期輸入與輸出。
