# M8 Workspace 對話與多工作區契約

2026-11-12 PM固定第一切片；下文HTTP/資料形狀為共同基線。尚未完成M8，執行隔離/登入測試仍是必要交付。

## 固定決策與實作分段（優先於下文提案背景）

### A：立即實作的垂直切片

多Workspace建立/列表/切換、獨立持久訪談、workspace-author@1非機密提案、明確確認/取消、已確認設定與背景快照、角色參照及AEAD保存。舊PATCH一律405 proposal_required。M7原契約保持，所有既有路徑的資源關聯與Workspace owner須核對，不做無關URL全面重寫。

- 機密傳輸由Server實際連線判斷：r.TLS或Host與RemoteAddr皆為loopback；不信任任意forwarded header。瀏覽器localhost→Nginx→bridge HTTP不符合直接loopback，應回protected_transport_required。Server新增可選TLS_CERT_FILE/TLS_KEY_FILE成對設定，缺一或無法載入時啟動失敗，不降級；未配置維持HTTP及上述機密拒絕。PM安排代理到Server的TLS憑證驗證與隔離測試；不能關閉驗證或把瀏覽器HTTPS當作後段安全證據。健康檢查需依實際listener選擇HTTPS並驗證可信CA，保持既有無TLS模式可用。
- credentials樂觀鎖固定：PUT/DELETE的expectedSecretVersion為必填非負整數，不接受null或省略。首次保存且role.secretVersion=null時送0；已有版本（即使configured=false／已撤銷）送Server回傳的secretVersion，不依configured推算或重設0。Server在交易內核對，過期409、不自動重送；成功後只使用權威回應更新參照狀態。GET的null仍表示未曾有版本，UI不可把請求用0顯示為已保存版本；撤銷後版本仍保留供後續樂觀鎖，不能重用舊版本號。
- origin集合一致性：正規化後，targets與dependencies互斥且各自不得重複；excludedOrigins不得與任一允許集合重疊，且自身不得重複。AI輸出、API及Worker輸入一律拒絕衝突，不靜默移除／截斷／合併；Web提示修正提案。下文「excludedOrigins優先拒絕」是B執行時最後防線，不代表A可保存矛盾設定；歷史或執行輸入若出現矛盾仍不得放行。
- A可保留離線test-author，allowedTools僅read_draft/read_validation_report/update_draft的子集；read_validation_report只讀Server已保存的有界摘要，不發網路請求。無browser工具時不建立browser/live，request_validation不在允許集合，任何越權工具呼叫拒絕。與workspace-author零工具及acceptance-summary唯讀分支分開，這不等於支援任意離線spec執行。安全執行尚未就緒時，正式run/validate/新publish明確503 security_unavailable；不能排入注定不可執行任務、回退舊bridge或把AI文字當通過。Web保留編輯與既有歷史讀取，依Server權威回應顯示限制，後續B解除時再恢復相應動作。
- A不傳requiredPolicyVersion，不將任何可選數字當授權；下文第7節此欄位留待B固定。未知安全/授權欄位應拒絕，不默默忽略。
- WorkspaceConfig共同界限：name及targets/dependencies/loginRoles內name為trim後1..200 UTF-8 bytes；purpose（Workspace及target）、backgroundSummary、exclusions最多8192 UTF-8 bytes，Workspace purpose及backgroundSummary確認套用時必須非空；dependency purpose僅login/api/cdn。targets/dependencies各最多20、loginRoles最多10、excludedOrigins最多40。每個origin/defaultTestUrl最多2048 Unicode字元，origin語法沿下文規則；defaultTestUrl可空。targets正式confirm時至少一個；訪談proposal可尚未完整但confirm/confirm-scope須拒絕無target，並回固定欄位錯誤。timeoutMs維持1..3600000整數。roleId為null（新角色）或同Workspace的UUID；Server保存proposal時分配UUID，Worker不得生成秘密引用。未知欄位拒絕，禁止以截斷文字或陣列讓輸入通過。
- HTTP包裝固定：GET /workspaces為 {items:Workspace[]}；POST /workspaces及GET /workspaces/:id為裸Workspace；GET conversation為裸Conversation；GET proposal、POST confirm-scope、POST cancel均為裸Proposal（scope確認狀態位於Proposal.scopeConfirmed等既有欄位）；POST confirm為 {workspace,proposal}；POST messages為 {run,conversationId}；credentials PUT/DELETE為下文角色參照物件。錯誤沿用 {error:{code,message}}，不得由Web同時猜多種包裝。
- Workspace新增欄位採下文形狀；為現有M5前端/快照保留頂層sites/defaultTestUrl/timeoutMs唯讀投影，canonical設定只有settings。舊資料lifecycle=needs_confirmation，settings=null，legacy五欄保留顯示；不得自動當確認scope。
- 新Run有workspaceId、testId可null；Workspace任務authorMode=workspace，不造Test/session。Workspace conversation單一持久對話，不新增workspaceSessionId，contextRevision沿M7概念。
- workspace-author input沿下文第7節平面欄位：頂層workspaceId/testId/workspaceContext，author.skillId=workspace-author、skillVersion="1"、editingSessionId=null、sourceVersion=null、baseRevision=Workspace revision。不新增owner物件、workspaceSnapshot或另一套context。script=""；messages沿既有界限；allowedTools在A必須[]，即使confirmed也不能開browser。
- workspaceContext固定 {schemaVersion:"1",workspaceId,settingsRevision,config:WorkspaceConfig|null,roleRefs:[{roleId,secretRef,secretVersion,configured}]}。尚未啟用的訪談config可null；現有legacy設定另由workspaceSettings投影提供。一般edit/summary收到context時作非機密背景，不把它當網路授權。
- workspace-author輸出嚴格 {message,proposal?:WorkspaceConfig,conversationSummary?}；conversationSummary最多8192 UTF-8 bytes。proposal不帶secretRef或確認狀態。新角色roleId可null，由Server分配；非null必屬同Workspace。Server驗base/context與Run/attempt，晚到結果不得覆蓋較新提案。此task不需Playwright報告，不啟動browser/live。
- 訪談allowedTools=[]仍可呼叫部署固定模型；這不代表具備網站探索能力。模型不得聲稱已造訪或測試網站。
- confirm-scope與confirm可正常保存使用者確認，但不等於executionAvailable。尚未有可用安全執行時executionAvailable=false、unavailableReason=security_unavailable。Web須明示「設定可保存，受限探索／執行尚未就緒」，不能呈現假探索成功。
- 專用帳密保存用既有Go標準庫AES256-GCM；key由部署提供，測試僅用合成key。A不啟用lease/resolve或登入，不將秘密值傳Manager/Worker。UI保存機密前必須有受保護transport（HTTPS或明確loopback本機環境），不得對任意遠端明文HTTP送值。API仍只回參照/是否設定，無明文讀回。
- 不強制所有舊URL新加workspaceId query；既有Test/Run等以DB關聯導出Workspace再經共同授權入口檢查。若前端提供workspaceId，必驗一致，跨scope404；workspace path與所有外來關聯ID必驗一致。回傳Run.workspaceId以利Web辨識；不以可填query取代未來RBAC。附件/live保留既有連結格式並查其真實owner。
- typed workspaceContext與現行許可分離。任務所需的範圍/角色未能滿足時明確阻擋；不能默默縮限仍宣稱完整執行。M8新版不得回退無限制bridge。18085的M7已建置預覽不因本輪改碼自動更新。
- A完成條件只代表Workspace資料/訪談/提案/機密保存接線通過，不代表M8完成。UI/API不得把security_unavailable當成空資料或測試失敗的成功替代。

### B：2026-11-12 使用者最新裁定（覆蓋A暫態及下文舊強隔離提案）

- 範圍是AI工作流防誤操作，不是限制工程師任意Playwright。AI探索/產稿/修復盡量限於Workspace target及必要dependency；工程師手動修改腳本不套用AI網站範圍限制。
- 不採AST子集、不禁止一般Playwright語法/自訂函式/迴圈/evaluate、不加HTTP1.1-only或禁WebSocket政策。保留既有runner，不建network=none/CONNECT/UDS全通道隔離平台。
- AI工具檢查navigate/redirect/popup及context request的origin，target作主要驗測站、dependency僅必要用途；未確認新origin回可理解的阻擋及範圍確認建議，AI不能自行加許可。產稿技能明示同規則；瀏覽器攔截及靜態檢查不能宣稱能控制任意Node全部出站。
#### B 來源、能力與確認快照：已固定，開始接線

Draft／Version／Run與dispatch/WorkerInput頂層皆新增scriptOrigin:"ai"|"manual"|"legacy"。Web請求與author.json不可指定來源。舊資料migration010填legacy、舊journal缺欄解碼legacy，不改歷史腳本/attempt、不重跑；Workspace author無測試腳本亦為legacy，但工具永遠受AI範圍約束。

- Start從正式Version複製來源，空新草稿legacy；resume保留。人工PUT draft實際script bytes變更才manual；AI成功套用實際script變更才ai。no-op/UI模式切換不增revision、不洗來源；設定/角色同步新增revision沿用來源。validation/summary/version/run依可信draft/version複製並在發佈核對。
- legacy表示來源未記錄，不給manual豁免；保留完整Playwright，按已確認Workspace的AI防誤操作規則處理。舊Version缺context時，可在新Run固定目前已確認context，保留舊Version與歷史Run不變。新版ai版本的必要範圍被撤銷須拒絕，不能默默擴到新範圍。manual執行不要求targets確認；機密使用仍驗role與loginOrigin。
- Workspace capabilities固定四項aiExploration/aiExecution/manualExecution/credentialLogin，各{available:boolean,reason:string|null}。舊executionAvailable=aiExecution.available OR manualExecution.available，true時unavailableReason=null；新版Web不以舊投影作唯一gate。
- manualExecution依完整runner可用性，不因缺targets/key而false。aiExploration需要工具已接妥及有效canonical或候選範圍；aiExecution需要runner AI防誤操作接妥與canonical確認。未確認reason=scope_confirmation_required，未實作=security_unavailable。具體draft/version仍須Server逐次核對快照，Workspace能力不是個別Run通行證。
- credentialLogin獨立檢查helper/TLS/key/已確認login origin/角色，reason按security_unavailable、protected_transport_required、secrets_unavailable、scope_confirmation_required、credentials_required回傳。能力不是Manager即時在線狀態，仍沿FIFO；role.configured須逐角色判斷。
- Web依該draft/version scriptOrigin選manualExecution或aiExecution（legacy用後者）；AI對話探索一律aiExploration。缺來源/能力時顯示未知，不猜manual。單純訪談/離線改稿不因aiExploration=false而封鎖。發布除原門檻外核對來源/摘要/實際使用角色，summary本身不授權發布。
- confirm-scope後新Workspace author可固定確認過的proposal.content到workspaceContext.config與對應角色，settingsRevision=baseRevision。Server內部保存scope_proposal_id/authorization_revision，非公開另一套policy。新訊息使proposal不再可套用，與同scopeHash探索許可是否有效分開；不擴scope可沿用仍有效確認，取消/範圍變更/撤銷則重新核對。
- test-author對任何來源稿件，只有Server有效確認範圍才加browser工具；離線工具仍可用。request_validation依實際draft來源執行資格授予，可用manualExecution不代表AI browser豁免。Workspace author有browser工具才可LiveTarget；訪談/summary不可監看。
- resolve成功登記runs.resolved_role_ids（有界最多10，僅角色ID）供撤銷取消；角色更新使active draft同步新參照/revision、清驗證摘要、保留來源。歷史Version/Run不偷換新帳密。網站縮限不取消無關manual任務，已使用撤銷角色的manual任務仍取消。回收後才釋放slot，不宣稱即時追回已交付值。
- Server以單一010_script_origin_and_login.sql處理來源CHECK/immutable、必要scope綁定與resolved_role_ids；保留原FIFO/attempt去重/真HTML-results/人工確認門檻，不復活A已終止工作。B恢復按真能力執行，移除A全面503，不建立新排程器。

- B共同命名固定為scriptOrigin（ai/manual/legacy），不使用scriptSource。AI browser工具需Server提供已確認config的workspaceContext與相應allowedTools；Runtime仍驗config/targets與工具集合，不能單憑非空config開工具。新metadata與legacy遷移待Server提案一次補定。
- B單次機密解析：POST /api/manager/runs/:runId/attempts/:attemptId/credentials/resolve，body {roleId,secretRef,secretVersion}。成功200裸物件 {workspaceId,runId,attemptId,roleId,secretRef,secretVersion,loginOrigin,username,password}；username/password沿A各4096 UTF-8 bytes上限，非空。Cache-Control:no-store；無redirect；Manager不得記錄body。Manager身分/目前控制session、assigned Run/attempt仍活躍、不可變roleRefs/版本與同Workspace現行未撤銷資料、已確認login origin、TLS全部核對才解密；角色未允許/跨scope404、過期/終態/撤銷409、未配key503，錯誤只固定code/message。Manager回應核對整組ID及origin，不接受Worker指定新URL/ref。只需專用端點，不設長租約。
- B內部IPC採owner提案的interactive attach NDJSON：stdout credential_request以requestId UUID/attemptId/role refs關聯，由Manager攔截不作一般log；機密回覆只走stdin credential_response，同attempt單pending、15秒逾時、最多20次。每frame最大64KiB（涵蓋4096-byte值JSON escaping），解碼後仍各4096-byte限制；超限拒絕、不截斷。取消/結束/舊requestId/錯attempt拒收並清理；Docker stdout/stderr framing需正確拆解，任意spec stdout不可成為跨任務授權來源。
- 完整spec透過whippet/login的loginAs(page,roleId,usernameSelector,passwordSelector,submitSelector)可信shim，沿既有tsconfig paths；回submitted，由後續expect確認成功。父runner持stdin，Playwright子程序經每attempt唯一/tmp socket轉接，socket0600且父目錄0700；socket檔只為IPC，值不落檔/env/argv/journal。取消/終止清socket/記憶體，不共享跨attempt。helper按Server loginOrigin檢查目前登入頁/表單目標；source manual豁免網站測試範圍不代表可把平台憑證填到任意站。
- browser_login表單送出不等於登入成功，回報須區分已送出與經明確條件驗證成功；實際腳本亦需角色參照登入helper以接續真驗證。工程師完整Playwright可存取自身頁面session，不宣稱能對此提供Node秘密沙箱；平台跨Workspace機密與模型key仍隔離。
- Server紀錄腳本來源並傳給Worker；由人工保存路徑/AI套用路徑裁定，不接受模型指定manual。具體欄位與legacy遷移由PM對齊owner後固定；切換不改歷史快照。AI工具始終受範圍約束，即使輸入腳本為人工來源。
- 登入後AI可讀頁面內容、操作/監看；密碼/Token/cookie/storageState不進模型。專用登入工具以roleRef操作，機密傳遞沿A的Workspace/任務/TLS/AEAD邊界；只遮蔽敏感輸入/已知值，必要時省略個別附件，不能全面禁登入後DOM/影像或以精簡假報告取代原生真驗收。
- 工程師腳本豁免網站限制，不豁免資源owner、跨Workspace機密隔離、平台key隔離、超時/回收、revision/真報告/人工發布。
- A中的全面executionAvailable=false、run/validate/publish固定503與僅三工具是過渡狀態，B需按已實作能力解除。不能保留全面503當交付；新功能未就緒仍如實回報其具體限制。
- 下文舊提案的全通道強制隔離、任意Node阻擋、所有任務origin租約與登入後全證據省略已撤銷；資料結構/API/AEAD/TLS仍有效。不要據舊段落實作proxy/lease平台。B剩餘wire先一次對齊，避免自行發明。

## 1. 可落地的基本決定

- 多 Workspace 的切換只是選擇資源／請求 scope，不寫全域「目前 Workspace」。GET 列表／詳情純讀；建立只產生未啟用的 Workspace 與獨立設定 Conversation。
- 一份現行已確認設定、一個設定 Conversation、一份目前 proposal，保留 proposal／訊息／Run 歷史；proposal 結果不能直接改設定或放寬許可。
- **舊 PATCH /api/workspaces/:id 一律 405，code=proposal_required，Allow: GET。** 包含 name／timeout 都不保留寫入例外；新版 M5 表單只讀。設定修改統一經 proposal＋QA confirm，避免第二條可繞過確認的路徑。
- 任務資料快照不可變，但不是永久通行證：開始／領取執行授權、取得帳密、發布，以及執行中續租均核對現行許可。撤銷後不能用舊快照繼續取得許可或機密。
- 網站探索／登入／驗證／正式腳本在網路強制隔離未就緒時 fail-closed；不能以 browser route、prompt 或 capability 字樣代替全通道隔離。純訪談／唯讀摘要不假造可探索能力。

## 2. 最小公開資料形狀

Workspace GET／列表：

```ts
{
  id, name,
  lifecycle: "draft" | "needs_confirmation" | "active",
  revision: number,                    // 設定樂觀鎖；新建從1開始
  authorizationRevision: number,       // 現行許可／機密撤銷世代
  scopeStatus: "unconfirmed" | "confirmed" | "revoking",
  settings: WorkspaceConfig | null,     // 現行設定，不是待審提案
  conversationId, activeRunId: string|null,
  currentProposal: Proposal|null,
  roles: [{roleId,secretRef:string|null,secretVersion:number|null,configured:boolean}],
  secretsAvailable: boolean,            // 環境key缺失／格式錯誤時false
  executionAvailable: boolean, unavailableReason: string|null
}
```

WorkspaceConfig 僅有界、非機密資料，拒絕未知／任意 env、headers、key、cookie 欄位：

```ts
{
  name, purpose, backgroundSummary,
  targets: [{name, purpose, origin}],
  dependencies: [{name, purpose:"login"|"api"|"cdn", origin}],
  excludedOrigins: string[], exclusions: string,
  loginRoles: [{roleId, name, loginMethod:"form", loginOrigin}],
  defaultTestUrl, timeoutMs
}
```

origin 按完整 scheme／host／port 正規化，比較結構，不用字串前綴；只接受 HTTP(S)、無 userinfo／query／fragment／非根路徑／wildcard。主機小寫、標準 port 正規化；MVP 可限定 ASCII DNS 名稱／IP，避免 Go／Node IDNA 差異。target／dependency 分開且不可重複歸類；excludedOrigins 優先拒絕。defaultTestUrl 的 origin 必須屬 target。文字 exclusions 為背景，不宣稱能以自然語言強制隔離。

建議上限沿現有值：targets／dependencies 各20、roles10、name200 bytes、backgroundSummary8192 bytes、URL2048字元、timeout 1..3600000ms。其他說明採有界文字，不引入可擴充 JSON 設定框架。

Proposal：

```ts
{
  id, workspaceId, conversationId, sourceRunId,
  baseRevision, contextRevision,
  status:"pending"|"applied"|"cancelled"|"stale"|"superseded",
  content: WorkspaceConfig,
  scopeHash, scopeConfirmed: boolean,
  invalidationReason: string|null,
  appliedRevision: number|null, createdAt
}
```

id／狀態／scopeConfirmed／secretRef 的來源關聯全由 Server 決定；AI 只能交候選內容。設定 Conversation 回 `{id,workspaceId,ownerType:"workspace",contextRevision,conversationSummary,messages,activeRunId}`，與 Test 編輯週期分開。一般訊息沒有帳密值；角色只回 ref／configured，永不回 username/password。

## 3. HTTP：保留少量明確動作

| 介面 | body／權威回應 |
| --- | --- |
| POST /api/workspaces | `{name?}` → 201 Workspace，draft／unconfirmed；不探索、不啟用 |
| GET /api/workspaces；GET /api/workspaces/:id | 純讀列表／Workspace，供切換與重開 |
| GET /api/workspaces/:id/conversation | 純讀設定 Conversation 與完整已存歷史 |
| POST /api/workspaces/:id/messages | `{content,revision,contextRevision}` → 202 `{run,conversationId}`，Workspace author入原FIFO；最多一個未結束設定author |
| GET /api/workspaces/:id/proposals/:proposalId | 純讀該 Workspace 的 Proposal；跨Workspace404 |
| POST /api/workspaces/:id/proposals/:proposalId/confirm-scope | `{baseRevision,confirmed:true}` → Proposal＋scope確認狀態；僅授予該提案範圍內的設定探索，不啟用測試或覆寫現行設定 |
| POST /api/workspaces/:id/proposals/:proposalId/confirm | `{baseRevision,confirmed:true}` → `{workspace,proposal}`；QA 已檢視範圍／角色，原子套用設定及許可，revision+1／active |
| POST /api/workspaces/:id/proposals/:proposalId/cancel | `{baseRevision,confirmed:true}` → Proposal權威狀態；取消暫時探索許可、保留現行設定／歷史 |
| PUT /api/workspaces/:id/roles/:roleId/credentials | 專用body `{expectedSecretVersion,username,password}` → `{roleId,secretRef,secretVersion,configured:true}`；不寫一般訊息 |
| DELETE /api/workspaces/:id/roles/:roleId/credentials | `{expectedSecretVersion,confirmed:true}` → `{roleId,secretRef,configured:false}`；撤銷後立即拒發新機密授權 |

取消 Run 沿用原 run/cancel；retry 訪談需明確重送 messages，不在輪詢無限重試。confirm／cancel 同一 proposal 的同一已完成動作冪等，不能把舊 applied proposal 再套用回舊 revision；過期409及 invalidationReason，不能只由 Web 判斷可存。未知欄位400、缺 key／隔離能力503，固定錯誤碼不回顯敏感 body。

### 一致的範圍確認

首次 author 只訪談，allowedTools 不含探索／登入；先產 proposal，由使用者按 confirm-scope 才可探索。scope確認綁 workspaceId、scopeHash、目前 proposal/context，不由訊息中的「同意」字串觸發。後續 proposal 只在**完全相同且仍有效的已確認 scopeHash**時可沿用確認；新增 target／dependency／權限用途一律重新確認。

confirm-scope 是暫時的 Workspace-author 探索許可，不是設定發布。正式 confirm 本身亦包含明確範圍確認，可直接接受尚未探索的提案；套用後才允許 Test 的新執行。cancel撤回該提案暫時探索權；supersede只有完全相同且有效的scopeHash可轉接，其餘額外探索權撤回；已啟用設定不因取消候選稿被覆寫。修改 active Workspace 時，舊現行許可先保持，新增範圍只在該次明確確認後取得，不讓 AI 擴權。

Role IDs 由 Server 在保存候選角色時建立／對應；credentials API 只接受本 Workspace 現行設定或目前提案所屬角色，AI 不得自行指定別的 Workspace ref。Proposal只保存角色定義，當前ref／configured由Workspace.roles提供，避免保存帳密時偷偷改不可變提案；任務建立時才固定已獲准的ref/version。保存帳密不是允許瀏覽任意 loginOrigin：仍須 QA 確認的範圍與 login 用途。修改角色 metadata 經 proposal；專用 credentials API 只更新／撤銷密文及參照版本，不寫 origin／許可。

## 4. Run owner、設定快照與現行撤銷

新增公開 Run.workspaceId 必填，testId 改 null|string。Workspace 設定任務：kind=author、authorMode=workspace、testId=null、editingSessionId=null；一般測試與編輯保留真實 testId。**不建立假 Test 或假 EditingSession。**

沿用不可變 workspaceSettings（M5五欄相容投影），另保存 typed workspaceContext 快照：schemaVersion、workspaceId、settingsRevision、name／purpose／backgroundSummary、target／dependency／excluded origins、角色ref/version。兩者由同一已確認設定建立；canonical來源只有一份，不維護兩套可獨立寫入設定。DraftRevision／Version／Run 保存完整背景與 scope 的相同 contextHash，驗證／摘要／發布皆比對，不只比timeout。

- 接受 proposal 實際變更時，沿用 M5/M7 交易替 active draft 新增 revision，保存新背景／設定，清 validation／summary；不改 discarding／歷史版本／既有 Run 快照。
- execution authorization 是現行資料，與快照分開。任務要求的所有 origin／用途／角色版本必須仍在現行有效許可中；交集缺任何必要項目就明確拒絕，不靜默縮水後繼續。dependency 只支援其用途，不可被工具當作任意驗測 target；登入可經專用工具前往已許可 login origin。
- 新任務與實際啟動前都查許可。確認縮限／取消暫時許可／撤銷secret時，authorizationRevision遞增、阻止新lease，既有受影響任務走原cancel／回收，Runtime必須撤回現行網路許可及敏感暫存。
- active連線的撤銷生效時點要以 Runtime阻擋／停止回覆或授權到期為準；未確認前 scopeStatus=revoking，不宣稱瞬間全數停止。Server不能僅更新DB欄位就聲稱阻斷既有TCP。
- Runtime未具備所需的完整出站限制時，探索／登入／validation／正式執行回security_unavailable，不派放行任務。Manager版本／capability只作協定核對，不能取代隔離驗收。

## 5. 機密：AEAD保存＋獨立短效傳遞

Server使用Go標準庫 crypto/aes、cipher.NewGCM、crypto/rand。專用環境變數建議 `WHIPPET_SECRET_MASTER_KEY`（base64編碼32-byte key），**部署者提供；本提案不產生、不讀取真key**。每次加密使用隨機nonce；AEAD associated data 綁 workspaceId／roleId／secretRef／secretVersion／schemaVersion。DB只存nonce／ciphertext／metadata，master key不入DB、一般設定、log或模型。暫不建KMS或輪替平台。

key未配置／格式不對時，服務可讀非機密資源，但 secretsAvailable=false；保存、解密／分發明確503 secrets_unavailable，不自動生成key或退回明文。GET只回ref／version／configured；configured表示存在未撤銷密文，不代表目前key可用。

任務通道建議沿既有Manager認證，新增**專用Manager HTTP**，不在普通dispatch或journal放授權token／機密：

1. Claim提交同一attempt後，Manager `POST /api/manager/runs/:runId/attempts/:attemptId/lease`；Server驗Manager／目前控制session、Workspace owner、Run狀態、當前許可與所需角色，回記憶體內短效 `{leaseId,expiresAt,authorizationRevision,policy,roleRefs}`。
2. Manager `POST .../credentials/resolve {leaseId,roleId,secretRef,secretVersion}`；Server再查當前未撤銷狀態，只解開此任務獲准角色，經受保護通道回傳值給可信登入broker。Worker／生成spec不拿Manager token。
3. 建議lease TTL30秒／每10秒續租；值不入input.json、一般dispatch、journal、模型、tool返回、log、命令列或持久volume。具體可信helper IPC由t32裁定，不把登入密文放入腳本能讀的/work。
4. Manager／Worker重啟時只從非機密Run/attempt/ref重新申領；不為恢復而重跑測試，不從journal恢復值。終態／取消／失聯／到期清理broker記憶體及暫存；續租或撤銷檢查失敗即停止，無離線cache放行。

專用通道須HTTPS或等效受驗證私密連線；缺保護通道則不分發機密，不另發明加密傳輸協定。UI專用欄位只存在必要的表單記憶體，不進localStorage／一般對話；API停用body／Authorization紀錄，只回固定狀態。role版本變更／撤銷不能讓舊快照自動取得新帳密。

登入、畫面／DOM、工具錯誤、stdout、PNG／MD／trace／HTML都可能含機密；Server本身不能宣稱已清除內容。Runtime／Manager須在來源限制與輸出前處理；無法保證安全的證據省略並回明確原因。**若因此沒有合格真HTML/results，保持M7報告門檻、禁止發布，不造假報告換通過。** 登入期間亦不能把敏感live frame送給Viewer。

## 6. 最小DB遷移及scope檢查

- workspaces新增 lifecycle、已確認typed設定、authorizationRevision／scope確認資料；舊M5設定保留只讀，全部標 needs_confirmation，不能將sites自動當已確認origin許可。新建從draft/unconfirmed開始。
- conversations新增 workspace_id／owner_type，test_id可null，workspace設定類唯一；保留M7 editingSession關聯／歷史。messages沿用，獨立設定對話contextRevision／摘要。
- workspace_proposals保存不可變候選內容、baseRevision／contextRevision／scopeHash、來源Run及權威狀態／失效原因／appliedRevision；不保存帳密。
- workspace_roles／workspace_secrets保存Workspace關聯、角色metadata、secretRef／version、nonce／ciphertext、revoked_at。只有已授權ref可成任務快照；ciphertext更新產生新版本，不改歷史版本。
- runs新增必填workspace_id（現有從真Test回填）、test_id nullable與正確owner CHECK；Test/Session/Version/Conversation/role的跨表外鍵及查詢同時綁Workspace。原Test活躍author唯一約束保留，另加Workspace設定author活躍唯一約束。
- DraftRevision／Version／Run新增nullable workspace_context快照欄位及immutable保護。舊無scope快照不補造許可；補確認後，新草稿採新快照重新驗證／發布才走M8執行。歷史Run／附件仍可讀；舊版本缺授權不能默默改用新許可執行。
- lease只保存hash／Workspace／Run／attempt／Manager epoch／到期／撤銷metadata，不存plaintext或可直接重放的token。nonce與短效token只以標準庫隨機數產生，不是自建master key。

現有大部分URL沒有Workspace path。推薦最小一致scope：帶Workspace path者直接由path取scope；其餘 Test／session／Version／Run／cancel／artifact列表／下載／live URL必帶 `?workspaceId=...`，Server以SQL關聯核對，不依瀏覽器切換狀態。Server回傳reportUrl／artifact.url包含scope，下載／WS不用自訂header。缺scope400、跨scope404；舊無scope別名不可繞過。Superadmin仍可刻意切換Workspace，這不是宣稱已做RBAC。

Manager HTTP／control／media以可信Run/attempt owner檢查，不使用使用者可任意填的scope；LiveTarget須從runs.workspace_id取owner，不能只INNER JOIN tests而漏掉Workspace類Run。Workspace訪談無瀏覽器時明確不提供live。所有外來version／session／proposal／roleRef都檢查同Workspace，不只先查存在。

鎖序延續Workspace→Test/設定Conversation→Session/Draft→Run；原Claim持Manager/Run鎖時不再反向取得Workspace鎖。實際授權／解密在Claim commit後獨立交易核對，撤銷可拒絕已claim但尚未啟動的attempt；不重設FIFO或回收協定。

## 7. Worker wire與需要共同裁定的三項

dispatch／Worker頂層增 workspaceId、testId:null|string、workspaceContext與非機密requiredPolicyVersion；原workspaceSettings保留投影、無機密值或lease token。設定任務 script=""、kind=author；author 使用 `skillId:"workspace-author",skillVersion:"1",editingSessionId:null,baseRevision:<Workspace revision>,contextRevision,conversationId,conversationSummary,messages,allowedTools`。sourceVersion=null；allowedTools由Server依未確認／已確認範圍決定，不由模型回填。

workspace-author輸出 `{message,proposal?:<typed候選設定>,conversationSummary?}`，沒有confirmed／許可／secret值；Server給proposal ID、驗同Workspace refs與base/context，取消／遲到結果不能套用或擴權。普通edit／summary沿M7，補workspaceContext；Run.authorMode由skillId推導為workspace／edit／summary。Manager journal只存有界固定非機密輸入及refs供同attempt recovery。

只需PM與t32一次固定：

1. **網路執行介面**：強制出站機制／deploy必要接縫、可驗證的policy版本與ready條件、target/dependency用途、全部通道（redirect/popup/subresource/Node API/raw TCP/UDP/WebSocket）及既有連線撤銷時點；沒有實作就blocked，不用prompt／單一route保證。
2. **短效機密broker**：上述Manager lease/resolve與可信helper IPC、HTTPS接線、30/10秒時限、重啟／取消清理；未完成就credentials不可用，不把值或token放一般dispatch/journal。
3. **安全證據**：登入工具只回狀態／ref，敏感畫面／工具結果／附件的禁止或清除規則，以及仍能滿足M7真報告門檻的方式；不能安全保留則省略、禁止發布並明示，不另開內嵌viewer或削弱門檻。

最小驗證：兩Workspace的資源／proposal／role／lease隔離；舊PATCH拒絕；過期／取消／scope未確認不啟用；AEAD AAD跨Workspace失敗、未配key不可用（只用測試key）；租約重送／撤銷／同attempt recovery不重跑；秘密不進普通持久資料；Runtime用合成網站／帳密做受影響網路與證據檢查。DB只用明確隔離TEST_DATABASE_URL；不碰18080／18085。M7未完成的全鏈驗收仍另列，這份提案不補稱完成。

本輪未安裝、Git、讀印真憑證、部署／重啟、模型呼叫或跑測試；只寫本暫存檔，等t36固定v8再單獨實作services/server。

## M8 B 敏感監看修正：暫停與協商識別

本節修正登入監看整合發現的缺口；優先於未包含敏感暫停的舊媒體行為。

- Worker 在填入登入值前完成媒體暫停。暫停須與 tick、frame callback／檔案寫入序列化或以 generation 失效化，確保 pause 完成後不再發布先前影格；敏感期間新增 viewer 亦收到 `state=waiting, reason=sensitive_input`。Manager 保留此固定 reason，Server 轉送。
- Web 收到此狀態即清除舊 video/peer、JPEG object URL 與未完成協商；顯示敏感輸入暫停，不讓舊影像留在畫面，不因暫停觸發 fallback 或錯誤重連。Run 不因此取消；恢復仍以真正收到可播放的新影格為準。
- 每個新 WebRTC offer 由 Worker 產生 UUID `offerId`，Manager／Server 的 offer 原樣攜帶。Web answer 原樣 echo `offerId`。Manager control 用 `answerOfferId` 關聯答案；Worker 只接受當前 offer 的答案。
- Server／Manager／Web／Worker 在同一 viewer 的 pause、mode 切換及新 offer 之間拒絕不匹配或晚到的 answer／舊協商 callback。pause 清除目前協商，resume 用新 offerId，不把舊 control.answer 套到新 helper。
- 相容性：舊無 offerId 的非敏感初次路徑可保留；一旦該 viewer 使用有 ID 協商，不能以缺 ID 降級或混用，敏感恢復必須使用新識別。各層錯誤保留原有界限，不擴充平台。
- 最小驗證：reason 透傳及已串流時清屏、中途 viewer 的敏感狀態、pause/frame 競態、舊 answer 不可套新 offer；最後以合成慢速登入觀察暫停前真影格→敏感期間清屏／停止→登入後新協商真影格。僅文字狀態或晚期累積 frames>0 不足以判通過。

### 敏感階段的明確恢復訊號

恢復事件固定為 `state=waiting, reason=sensitive_input_complete, transport=<目前模式>`。Manager 必須保留此 reason，並確保 JPEG 模式下先送恢復事件，再送第一張新影格；Worker/Manager 不可依賴可能被輪詢漏掉的瞬間檔案狀態。Web 只對當前 viewer、目前 JPEG 模式的此事件解除敏感鎖；普通 waiting/connecting/streaming 不表示恢復，敏感期間舊 frame/offer 不接受。WebRTC 仍以敏感後全新有效 UUID offer 才開始恢復協商，不能用此文字事件跳過 offerId 核對。所有模式都須由真正新影格才回到 streaming。

Server 對轉送的 state 事件填入當前 LiveSession 的 `viewerId`（不採上游自報身分）。Web 僅接受 `sensitive_input_complete` 的 viewerId 與該連線 `ready.viewerId` 完全一致才解除 JPEG 敏感鎖；缺值或錯值不得解鎖。對舊 pause 事件缺 viewerId 可先清畫面以保守相容，明確不符 viewer 的事件丟棄。敏感鎖不因普通 state、ready、切換模式或播放操作自行解除。

WebRTC 的恢復也必須以當前 viewer 的 `waiting/sensitive_input_complete/transport=webrtc` **先於新 offer**，Worker／Manager 須確保可觀察且有序，Server 保持順序。Web 在 complete 前將所有到達 offer（即使 UUID 未見）丟棄並記為 stale；正確 complete 僅使其進入「等待新 offer」子狀態，畫面仍 paused。complete 後全新且非 stale 的 UUID offer 才能建立新 peer，收到真影格才 streaming。此規則補足前述「新 offer 恢復」的必要前置，不新增 wire 欄位。

Server viewer 的實際 WebSocket 寫出順序亦須遵守上述屏障；若文字 Messages 與二進位 Frames 使用不同佇列，不得靠不具順序保證的 select 讓新影格早於 complete，或讓暫停前已排隊影格在 pause 後輸出。驗證需涵蓋雙佇列同時 ready 的實際 writer 順序，不能只以 Manager 的送出順序代替。

`state`（含 complete）可攜帶尚未附 SDP 的 pending `offerId` 作關聯資料；此欄位不表示 offer 已送出或接受，不得因此將 ID 加入 offer 去重／已接受集合。只有實際 `type=offer` 訊息適用前述 offer 接受與 stale 規則；合法 complete state 及其後實際 offer 可以攜帶相同 ID。
