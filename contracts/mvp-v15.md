# v15 Workspace 逐站登入與測試帳號

WLA-0 共用契約，供 WLA-1 至 WLA-4 實作與驗收。沿用 `/api`、`/mcp` 與 Manager `protocolVersion:1`。需求以[逐站登入規格](../docs/requirements/workspace-test-accounts/spec.md)為準，未列出的行為沿用 [v8 設定與登入](mvp-v8.md)、[v11 MCP](mvp-v11.md)、[v14 權限](mvp-v14.md)及[共用 Harness](../docs/requirements/usecase-agent-platform.md#agent-harness)。

## 實作入口

以 `85fd4b6` 核對。下表的 WLA 工作為後續接線。

| 入口 | 現有路徑與 WLA 接線 |
| --- | --- |
| 設定 Web／HTTP | Web 已呼叫 `messages`、`proposals/{proposalId}`、`confirm-scope`、`confirm`、`cancel` 及 `roles/{roleId}/credentials`。Server 以 `manageSettings` 授權，`ActWorkspaceProposal` 核對 base/context revision 與目前提案。WLA 在同一組提案入口顯示逐站進度並加入套用門檻。 [Web API](../apps/web/src/api.ts) · [Server 路由](../services/server/internal/server/http.go) · [提案交易](../services/server/internal/server/workspace_interviews.go) |
| 提案驗證 Worker | 既有 `validation` 需要 Test 草稿，`workspace-author` 則以 `author.json` 交候選。兩者共用 Run 佇列及 Docker 派工。WLA 增加 Workspace 所屬的驗證工作，走 Server → Manager → 真 Worker → Manager `result` → Server，使用既有 attempt 機密管道。 [派工與結果](../services/server/internal/server/engine.go) · [Run 資料層](../services/server/internal/server/postgres.go) · [容器入口](../services/manager/internal/manager/docker.go) · [結果收集](../services/manager/internal/manager/artifacts.go) · [帳密解析](../services/server/internal/server/credentials_resolve.go) |
| 內建、Vercel、Pi | 三種模型迴圈共用 Worker `runAuthor`、registry 與瀏覽器工具。WLA 共用同一份快照投影與工具實作。 [作者入口](../runtimes/worker/src/author/main.ts) · [Harness 迴圈](../runtimes/worker/src/author/loop.ts) |
| MCP 互動 | `browser_session_open` 依 Token Workspace 開正式設定的租約，瀏覽器工具以 `_meta.whippet` 帶租約與 call ID。WLA 由這份租約提供帳號目錄與登入。 [互動入口](../services/server/internal/server/mcp_browser.go) · [租約快照](../services/server/internal/server/browser_leases.go) · [Session Worker](../runtimes/worker/src/session/session.ts) |
| MCP 接單 | `task_claim` 回 `contextBundle`，`task_tool_call` 以 Run／attempt／lease dispatch 至該 claim 專屬的 browser session。WLA 沿 claim 的凍結快照授權。 [接單快照](../services/server/internal/server/external_author.go) · [工具派送](../services/server/internal/server/mcp_task.go) · [參考客戶端](../runtimes/agent-bridge/README.md) |
| 腳本自試與正式執行 | `whippet/login` 的 `loginAs` 透過 attempt socket 取用快照中的角色，可信 helper 送出表單。WLA 增加以指定帳號及目標站台登入的 helper。 [Runner](../runtimes/worker/src/runner.ts) · [登入 helper](../runtimes/worker/src/login/helper.ts) · [attempt 機密客戶端](../runtimes/worker/src/login/client.ts) |

## 提案與逐站狀態

`UUID`、origin 正規化、URL／文字上限沿用 v8。新欄位拒絕未知欄位、重複鍵及不符型別的值。新 `WorkspaceConfig` 在 `targets[]` 增加 `testScope`，並新增 `testAccounts`（最多 10 組）。以下 `Origin` 是正規化後的 scheme、host、port，站台以 `targets[].origin` 識別。

```ts
type TestScope = "unknown" | "guest" | "authenticated" | "both"

type TestAccount = {
  accountId: UUID | null
  name: string
  role: string
  purpose: string
  sites: SiteLogin[]
}
type SiteLogin = {
  targetOrigin: Origin
  loginMethod: "form" | "sso" | "mfa" | "other" | null
  entryUrl: string | null
  form: FormSelectors | null
  success: SuccessCheck | null
}
type FormSelectors = {
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  loginRejectedSelector?: string
  mfaSelector?: string
}
type SuccessCheck = { url: string, visibleSelector: string }
```

- 訪談將 QA 明確選定的訪客、登入後、兩者分別記為 `guest`、`authenticated`、`both`。新提案每站都帶 `testScope`，未答時記 `unknown`。套用前由管理員看過每站選擇並明確確認。既有設定在新提案套用前持續提供正式執行。
- `accountId` 由 Server 指派。`author.json.proposal` 以 `null` 新增帳號，沿用時須引用本 Workspace 已提供給訪談的 ID。已儲存的提案與設定一律回 UUID。同名或同角色可有多個帳號。`name`、`role` 用 v8 名稱上限，`purpose` 最多 8192 UTF-8 bytes。Workspace 訪談沿用 `author.json` 的 `{message,proposal?,conversationSummary?}`，同一輸出 parser 用於內建與 `task_submit`。`workspace-author` 的 `author.workspaceProposal` 固定為開始該輪時的 `{content,siteReadiness}` 或 `null`，供續談參考，使用者授權仍由 Server 核對。
- 每帳號的 `sites` 以 `targetOrigin` 去重，須對應提案 `targets`。登入入口須在該 target 或已核准且用途為 `login` 的 dependency。`success.url` 的 origin 須等於 `targetOrigin`。URL 使用 v8 HTTP(S) 格式，填寫非機密值。每個 selector 沿可信登入 helper 的非空與 1000 字元上限，以 locator 處理。`null` 供逐站釐清。只有 `form` 加上完整入口、表單選擇器及成功條件才可排驗證。已知的 SSO／MFA／其他方式顯示 `unsupported_login_method`。
- v8 網站確認與 `scopeHash` 沿用既有 targets／dependencies／exclusions 及舊 `loginRoles` 的規則。帳號的逐站登入設定由 Server 綁定 `loginConfigVersion`。同一帳號每個目標站有獨立版本。新增綁定、變更登入方式、入口、表單或斷言、移除後再加回、相關核准範圍失效，都配發新版本。版本用 UUID，名稱、角色、用途與其他未受影響的綁定可沿用原版本。

```ts
type SiteReadiness = {
  targetOrigin: Origin
  testScope: TestScope
  ready: boolean
  reason: "scope_choice_required" | "login_verification_required" | null
  accounts: SiteAccountVerification[]
}
type SiteAccountVerification = {
  accountId: UUID
  state: "pending" | "running" | "verified" | "failed"
  reason: VerificationReason | null
  runId: UUID | null
  verifiedAt: string | null
}
```

`Proposal.siteReadiness` 與 `Workspace.siteReadiness` 分別由 Server 依提案及正式設定計算。前者另回 `accountCredentials:[{accountId,configured,secretVersion}]`，`secretVersion:null` 表示尚未保存任何版本。進行中的排隊、派工及回報階段顯示 `running`，詳細 Run 狀態沿用既有欄位。`VerificationReason` 的待補原因為 `scope_confirmation_required`、`login_setup_required`、`credentials_required`、`unsupported_login_method`。`VerificationFailure` 為 `login_rejected`、`mfa_required`、`guest_accessible`、`login_not_verified`、`credential_unavailable`、`invalid_evidence`。`VerificationReason` 也包含這組失敗原因及 `timed_out`、`cancelled`、`interrupted`。只有 `verified` 帶 RFC 3339 UTC 的 `verifiedAt`。`runId` 為目前顯示結果的來源，尚未排驗證時為 `null`。

`guest` 的 `ready` 為 `true`。`unknown` 回 `scope_choice_required`。`authenticated`／`both` 至少須有一組帳號在本站 `verified`，否則回 `login_verification_required`。Worker 開始前若缺入口、表單或成功條件，該組帳號顯示 `login_setup_required`。沒有帳號時 `accounts:[]`。Web 以提案 GET 重新載入狀態及重開草稿。

## HTTP 與帳密版本

`P` 代表 `/api/workspaces/{id}/proposals/{proposalId}`。沿用 session、`Origin` 與 `manageSettings` 規則，含既有全站管理權。新增寫入須在交易內重驗權限與 Workspace 管理狀態。錯誤沿 `{error:{code,message}}`。

| HTTP | 請求與回應 |
| --- | --- |
| `GET P`、`POST P/confirm-scope` | 沿用裸 Proposal。`confirm-scope` 沿用 `{baseRevision,confirmed:true}`。未套用的登入驗證須先確認目前提案的網站範圍。 |
| `PUT P/test-accounts/{accountId}/credentials` | `{baseRevision,expectedSecretVersion,username,password}` → `200 {accountId,configured,secretVersion}`。只向該提案寫入機密。 |
| `DELETE P/test-accounts/{accountId}/credentials` | `{baseRevision,expectedSecretVersion,confirmed:true}` → 同一狀態物件。草稿刪除在該提案標記為未設定。 |
| `POST P/verify-login` | `{baseRevision,requestId,accountId,targetOrigin}` → `202 {run}`。`requestId` 為 UUID。Worker 每次只驗一個帳號與目標站。 |
| `POST P/confirm`、`POST P/cancel` | 沿用 `{baseRevision,confirmed:true}` 與原包裝。`confirm` 在同一交易重算每站資格並套用設定及機密版本。純訪客設定可直接確認。`cancel` 收回草稿工作與機密使用權。 |
| `PATCH /api/workspaces/{id}/test-accounts/{accountId}` | 已套用帳號的描述維護。`{revision,name,role,purpose}` → `200 Workspace`，沿設定 revision CAS。更新說明供之後的任務讀取，沿用既有驗證。入口、適用站台、成功條件及帳密透過提案流程更新。 |

- 草稿機密寫入採 v8 的受保護連線、`Cache-Control:no-store`、帳密各 4096 UTF-8 bytes 與 AEAD。`expectedSecretVersion` 必填，`0` 對應首次設定。草稿讀取從自身已保存版本開始，首次修改前可引用該帳號的正式版本。草稿新版本與正式指標分開，版本依帳號遞增且不可重用，刪除須保留版本並遮斷草稿的正式版本引用。草稿驗證成功後，套用交易以同一個版本升為正式，並重核草稿分支所依的正式版本及有效狀態。正式版本期間有其他輪替或撤銷時回 `409 conflict`。取消／失效的草稿機密須收回，只有保有授權的接續提案可承接。
- `verify-login` 在權限檢查後以 `(workspaceId,proposalId,requestId)` 去重。同一鍵與同一請求回原 Run，異參數回 `409 conflict`。新請求須屬目前 `pending` 提案，且 Workspace／對話 revision、`scopeConfirmed`、帳號綁定、完整表單及現行有效憑證都須符合。只接受 `authenticated`／`both` 的站台，`unknown` 回 `409 scope_choice_required`，`guest` 回 `409 conflict`。相同組合已有進行中 Run 也回 `409 conflict`。人工重試使用新 `requestId` 及新 Run，更新該提案該組的目前 Run。Run 取消沿 `POST /api/runs/{id}/cancel`，此 kind 的讀取與取消須核對 `manageSettings`。提案取消、取代及調整收回該提案綁定的工作與授權，正式執行依原有已確認設定繼續服務。回收確認後才釋放 Manager 容量。
- 無授權身分沿 `401 unauthorized`，已登入但無管理權回 `403 forbidden`，跨 Workspace 或不屬該提案的帳號／站台回 `404 not_found`。格式不符回 `400 invalid_request`，非受保護帳密傳輸回 `400 protected_transport_required`。舊提案／revision、舊憑證 CAS 回 `409 conflict`，未核准網站回 `409 scope_confirmation_required`。帳號缺前置資料時以 `409` 回對應的 `VerificationReason`。任一站未就緒時 `confirm` 回 `409 workspace_setup_incomplete`，前端重讀同一提案顯示缺項。儲存機密或執行能力不可用沿 `503 secrets_unavailable`／`security_unavailable`。封存沿 v14 錯誤。

## 提案驗證的派工與證據

新增 Run 與 `dispatch.payload` kind `workspace_login_verification`，`testId:null`、`script:""`、`scriptOrigin:"legacy"`，沿 FIFO、Manager 占位、取消、去重與 reconcile。Server 固定核准的提案範圍至 v1 `workspaceContext`，範圍用 v8 形狀，`roleRefs:[]`，並保存現行提案來源。平台固定的 Worker 程式依 `timeoutMs` 及下列 `loginVerification` 執行，只帶該次登入綁定。派工與 Worker input 沿現有 Run／attempt 傳遞方式。Manager 驗證 kind 與欄位後寫入 journal 及 `input.json`，Docker 啟動專用 Worker 入口。Server、Manager、Worker 同批支援後才啟用此 kind。非空 `script`、`files`、`author`、`modelCredential`、`moduleAbi`、`retest` 及 MCP 接單皆拒絕。

```ts
type LoginBinding = {
  accountId: UUID
  targetOrigin: Origin
  loginConfigVersion: UUID
  entryUrl: string
  form: FormSelectors
  success: SuccessCheck
  secretRef: UUID
  secretVersion: number
}
type LoginVerification = {
  proposalId: UUID
  baseRevision: number
  contextRevision: number
  scopeHash: string
  binding: LoginBinding
}
```

1. Server 在排入、派工、解密及接受證據時重核目前提案與授權。解密沿 `POST /api/manager/runs/{id}/attempts/{attemptId}/credentials/resolve`、Manager TLS 驗證與專用 stdin／stdout credential IPC。HTTP 與 IPC 的機密請求以 `accountId,targetOrigin` 取代 v8 的 `roleId`，保留 `secretRef,secretVersion` 與原 IPC 關聯欄位。成功回應同樣以 `accountId,targetOrigin` 取代 `roleId`，保留 `workspaceId,runId,attemptId,secretRef,secretVersion,loginOrigin,username,password`。Manager 與 Worker 必須核對完整身分、版本及 `loginOrigin`。Server 依此 Run 的提案綁定選機密，取消、撤銷及過期 attempt 拒絕解析。成功解析時，Server 保存該 attempt 已解析這組綁定的紀錄。
2. 真 Worker 以全新、無 cookies 或 storage state 的瀏覽器 context，先在 `success.url` 檢查訪客基線，再從核准 `entryUrl` 透過可信 helper 送出指定帳密，最後回到 `success.url` 驗證。訪客基線須實際觀察到受保護頁回 401／403、導向已核准的登入入口，或頁面正常載入且同一 `visibleSelector` 在有界等待後仍不可見。連線或載入失敗不算基線。登入後須成功載入設定 URL，主頁 origin 等於 `targetOrigin`，且 `visibleSelector` 可見。前後均套用既有網路範圍、登入表單目標檢查及機密遮蔽，登入 dependency 的導覽授權限該次登入。Worker 依可觀察訊號判斷 `login_rejected`／`mfa_required`，例如明確配置的 failure locator，遇到此訊號即回失敗。缺少可判別訊號時回 `login_not_verified` 或 `timed_out`。訪客已可見成功條件回 `guest_accessible`。
3. Worker 在 `result.json` 產生以下有界結構。Manager 查核實際容器結束狀態、主 origin 與證據形狀，沿 journal／reconcile 與既有 `result` envelope 轉送。此 kind 使用下列專用證據，普通 Test 的 HTML／JSON 報告門檻沿原規則。證據僅含固定結果、目標 origin 與既有 Run／attempt 關聯。

```ts
type VerificationResult =
  | { status: "succeeded", loginVerification: {
      observedOrigin: Origin,
      guest: "denied" | "login_redirect" | "selector_hidden",
      submitted: true,
      authenticated: "selector_visible"
    } }
  | { status: "failed", loginVerification: { reason: VerificationFailure } }
  | { status: "timed_out" | "cancelled" }
```

Server 以已指派 Manager 的 `runId`／`attemptId` 找到不可變派工快照，在交易內核對目前 Run、有效提案、權限及站台、帳號、`loginConfigVersion`、`secretVersion`，並查核同 attempt 的機密解析紀錄。接受後保存上述綁定與 Server 的 `verifiedAt`。內容相同的結果重送只沿用既有處置。舊 attempt、舊 Run、證據不全、僅送表單或收到終止後的回報皆不得寫入成功。明確重試後以該組最新 Run 判定提案。已接受的有效證據可由正式設定或同一訪談因 `context_changed` 直接接續的前案延續，前提是同組綁定、憑證版本及授權仍有效。新提案的驗證工作須綁新提案本身。正式套用時只採用存證且核對成功的紀錄。

## 授權目錄與腳本登入

WLA 帳號能力使用 `workspaceContext.schemaVersion:"2"`，保留 v8 `workspaceId`、`settingsRevision`、範圍 `config` 及舊角色 `roleRefs` 欄位，範圍 `config` 維持 v8 形狀。新增 `testAccounts`，內容為 `[{accountId,name,role,purpose,sites:[{targetOrigin,state}]}]`，`state` 為對外的逐站驗證狀態。Server 依任務／租約授權、核准站台及 `authenticated`／`both` 的選擇提供目錄。Server 到可信 Manager／Worker 另帶 `accountBindings:LoginBinding[]`，固定該次已驗證且可使用的正式綁定。供模型與 MCP 的 `workspaceContext` 投影移除 `accountBindings`，舊 `roleRefs` 的 `secretRef` 和 `secretVersion` 設為 `null`。名稱、角色、用途、網站及工具回傳都依 Harness 當作資料。

| 入口 | 目錄與工具 |
| --- | --- |
| 內建、Vercel、Pi | 使用同一 `runAuthor` 快照投影。依 `allowedTools` 提供可信的 Worker `browser_login_account`。 |
| MCP 互動 | `browser_session_open`／`browser_session_status` 的 ready 回應附 `testAccounts`，其餘狀態回空陣列。呼叫 `browser_login_account` 沿原 `_meta.whippet:{sessionId,leaseId,callId}`。以有效 Token、Workspace、正式設定及租約核對。 |
| MCP 接單 | 目錄隨 `task_claim.task.contextBundle.workspaceContext` 回傳，工具由該 claim 的 registry pins、`allowedTools` 與 `toolDefinitions` 決定。使用 `task_tool_call({runId,attemptId,leaseId,callId,name:"browser_login_account",arguments})` 導向同一 claim 的 browser session。 |
| 腳本 | `whippet/login` 增加 `loginAsAccount(page,accountId,targetOrigin)`，沿自試與正式執行的 attempt socket，從已核准快照選用表單。訪客案例從未登入的 context 開始，多身分案例各取不同 `accountId` 並隔離登入狀態。 |

`browser_login_account` 只接受 `{accountId:UUID,targetOrigin:Origin}`，成功回 `{submitted:true}`。沿 `browser_login` 的 Worker／browser 分類及 15 秒、輸入 16 KiB、輸出 128 KiB 上限。實作同步完成後才在共用 registry 新版本註冊，隨 task／lease 固定版本與 SHA。兩個新登入入口都以快照綁定取入口與選擇器。執行時再核對 Workspace、目標站、帳號、設定／憑證版本及當前 Run／lease 授權。同一帳號在另一站的驗證不能放行此站。無合適帳號時，Agent 從目錄指出缺少的角色或用途；直接呼叫未授權、錯站或已撤銷綁定時，工具回固定 `tool_unavailable`，MCP 沿 `isError:true` 與 `structuredContent.error`，腳本 helper 以 `credential_unavailable` 失敗。

Run Worker 以相同的 account 版 attempt resolver 核對該 Run 的 `accountBindings`。Session Worker 沿 v11 的 credential IPC，在 `credential_request` 使用 `accountId,targetOrigin` 取代 `roleId`，保留 session／lease／call／request 綁定。Manager 在既有 `/api/manager/browser-sessions/{sessionId}/leases/{leaseId}/credentials/resolve` 送 `{callId,accountId,targetOrigin}`，Server 核對租約、既有呼叫記錄與快照版本。成功回 `{sessionId,leaseId,workspaceId,callId,accountId,targetOrigin,loginOrigin,username,password}`。值只通過原受保護管道，沿 v8/v11 防止密碼、Token、cookie 及 storage state 流入模型、腳本、對話、監看、journal 或報告。`submitted` 僅供後續腳本斷言，設定提案的證據來源為專用 Worker 結果。

## v8 相容與範例

- 每組舊角色按 `(workspaceId,roleId)` 一對一映射到 `accountId = roleId`，沿用原加密參照及版本。名稱與角色說明初始取舊 `loginRoles[].name`。若原 `loginOrigin` 恰好是 target，可將它列為該帳號的候選站台，仍需補入口與成功條件。若原 origin 是共用登入 dependency，站台由 QA 明確指定。舊 `loginRoles` 由 Server 保留為角色引用，WLA 候選以 `testAccounts` 管理帳號，無權建立或重指向舊 alias。
- v8 Workspace 可沿原確認版繼續執行。重新提案時，缺 `testScope` 視為 `unknown`，缺逐站存證視為待驗證。已配置角色或歷史 Run 成功皆不足以補出 WLA 證據。v1 快照、歷史腳本與既有 `loginAs(page,roleId,...)`／`browser_login({roleId,...})` 沿原形狀讀取。兩個舊入口仍以快照中的原 UUID 與 login origin 核對同一帳號的現行授權與機密版本。撤銷、移除或過期時沿 v8／v11 拒絕。同名角色或新帳號不會成為舊角色的替代帳號。舊角色 credentials HTTP 沿 v8 供舊角色維護，輪替及撤銷須同時使受影響的 WLA 證據失效。WLA 草稿機密透過提案專用路徑管理。
- [JSON 範例](testdata/workspace-test-accounts.json)含訪客零帳號、共用登入服務的雙站部分通過、同角色雙帳號的快照及舊 roleId。請求、派工及結果片段使用合成識別碼與保留的 `.example` 網域，供 WLA-1 至 WLA-4 核對 wire 與門檻。
