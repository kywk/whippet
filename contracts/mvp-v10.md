# M10：Use Case、Module 與可替換引擎

2026-11-13 PM 固定；Server t4b／Runtime t4c 已確認文末裁定無剩餘阻礙。承接 v9；零新外部依賴。進度僅記於 implementation.md。

## 工具註冊表與載入

`contracts/tools/registry.json` 為單一來源，頂層 `{schemaVersion:1,version,tools}`；每項固定 `name,description,inputSchema,side,effect,limits`。`inputSchema` 轉成模型 API 的 `parameters`，不得維護第二份 schema。side=server|worker，effect=read|candidate|browser|queue；limits 為正整數 timeoutMs/maxInputBytes/maxOutputBytes，bytes 以 UTF-8 計。拒絕未知工具、未知參數、超限輸入；結構化結果超限回安全錯誤，不截斷 JSON。工具上限也受 Run 剩餘預算限制。

目前 registry 先固定既有十項工具；平台工具由 PM 在 M10.3/6 接線前追加，owner 不得自行修改共同檔。未實作工具不可列入 allowedTools。read_conversation_history 保留 v9 四頁限制；request_validation 的 worker side 是旗標，真正排程仍由 Server 收尾。

套件從明確設定 `WHIPPET_TOOL_REGISTRY_PATH` 載入；開發預設 repo 的 contracts/tools/registry.json，映像固定 /app/contracts/tools/registry.json。PM 負責映像打包。Server/Manager/Worker 核對 registry version 與 SHA-256 快照；不可因檔案缺失靜默換白名單。舊 v9 Run 沿舊流程，不要求新快照。

## Harness IPC

保留 v9 history 通道。新增 POST `/api/manager/runs/{runId}/attempts/{attemptId}/tools`，body `{callId,name,arguments}`；成功 `{runId,attemptId,callId,result}`。沿既有 HTTP error envelope。

stdout NDJSON `{kind:"tool_request",requestId,attemptId,name,arguments}`；stdin `{kind:"tool_response",requestId,attemptId,result}` 或 `{kind:"tool_response",requestId,attemptId,error:"tool_unavailable"}`。requestId UUID 即 HTTP callId，禁止兩組獨立識別碼。工具結果不寫 journal。共用 stdin demux 與整幀寫鎖；取消/逾時不收遲到結果。Manager 驗證 server side、allowedTools、上限及活躍 attempt，Worker 不持有 Manager token。

Server 由 Run 推導 scope，核對 epoch、活躍 attempt、Workspace、session/context/baseRevision，交易提交前再核對。寫入與 queue 以 `(run_id,attempt_id,call_id)` 和 request hash 持久去重；同 ID 異內容拒絕。不能以放寬 skill 字串白名單取代能力快照核對。

## Test、Module 與 Stage

Test.kind=`test|module|usecase`，缺省 test。Module slug 在 Workspace 唯一且建立後不可改，格式 `[a-z][a-z0-9-]{0,63}`。revision/version 保存 `module:{slug,moduleKind,exportName,signature,inputs,returns,preconditions,postconditions,harness}`；moduleKind=setup|step|page，inputs/returns 等說明採文字，script 是模組本體，harness 是獨立驗證入口。exportName 為合法且非保留字的 JS identifier。

有序 stages 採 tagged union：
- `{id,title,kind:"module",moduleTestId,moduleVersionId,args,bind?}`。
- `{id,title,kind:"inline",script}`。

args 為具名參數物件，每個值 `{kind:"literal",value:<JSON>}` 或 `{kind:"binding",stageId,path:string[]}`。Module 呼叫約定為 `exportName({page,...args})`，禁止 args 覆寫 page；只引用之前的 Stage 回傳值。id 唯一；bind 可省略，產碼使用 Server 生成的安全區域名稱，不直接拼接使用者 identifier/path。字串與 literal 以 JSON 序列化。inline 為明確腳本區塊，每 Stage 一個 test.step；其結果不提供後續 binding。禁止 Module 相依 Module 或跨 Workspace 引用。

version_dependencies(version_id,module_version_id) 是不可變集合，stages 保留順序。Run 入列即快照所有檔案與依賴；重派不查最新版。新 Module 與 Use Case 同交易發佈時先配置 version IDs，逐一核對 revision、validation、summary 後整批插入，任一步失敗回滾。

## Runner bundle

新增 `files:[{path,content,origin:"manual"|"ai"}]`；入口 `tests/test.spec.ts`，Module `lib/<slug>.ts`，以 @lib/* 對應 lib/*。只接受這兩類相對路徑，拒絕重複、絕對路徑、反斜線、..、符號連結；最多 64 檔，單檔 2 MiB、合計 8 MiB。有 files 時以 bundle 為準；同時有 script 必須等於入口內容，否則拒絕。缺 files 保留舊 script。

來源由 Server 寫入路徑決定，不信任模型自報；任一非 manual 來源令整個 Run 套用 AI 範圍。新增不可變 files_snapshot 與 bundle_hash；驗證、摘要、發佈比對完整 files/stages/module metadata/依賴及原有 context/revision。bundle hash 由 Server 對固定順序結構序列化並 SHA-256，Worker 不另行推算發佈資格。

## Partial

author.json 沿舊欄位，加 `partial?:{reason:"budget_exhausted",nextStep:string,checkpoint?:{scriptHash:string,selfTestPassed:true}}`。有 checkpoint 時 script 必須等於最後自我試跑通過候選；無 checkpoint 不得套用新 script。requestValidation 強制 false。Server 保存 partial metadata，Run transport status 維持 succeeded；自試不等於正式驗證，不能直接發佈。summary/workspace parser 不誤套此格式。

繼續建立新 Run 並核對 session/context/baseRevision；過期只能保留 proposal。timeout/cancel 沿原語意，不冒充預算耗盡。接收端 parser 與 Manager 先相容，Worker 才輸出新格式；M10.1 內部 callback 不等於此鏈路完成。

## Skill manifest

固定 `{id,version,defaultTools,budget:{maxModelRequests,maxToolCalls,maxDurationMs},model:{provider,model,reasoningEffort},references:[{id,path,sha256}]}`。主檔 UTF-8 <=8192 bytes，reference 只讀打包的相對檔案，拒絕路徑逃逸。Server 選主 skill 與輔助 skill，工具聯集再與 Workspace/Run 權限交集；預算與模型由主 skill 決定，輔助 skill 不提升權限/預算。Server 可降低預算。

Run author 新增 skills 快照（id/version/sha256/referenceHashes）、budget、model、toolRegistryVersion/toolRegistrySha256；舊 skillId/skillVersion 保留主 skill。模型金鑰不在快照。read_skill_reference 只接受 skillId/referenceId，不接受任意 path；詳細 schema 隨 M10.2 固定後加入 registry。beforeRequest 每次呼叫都執行既有機密遮蔽，所有引擎共用守衛。

## 門檻

owner 確認契約無衝突才完成 M10.0。各子項只跑 implementation.md 最小驗證；M10.Z 全部通過才建立 phase1-verified，不以文件或內部單測代替真模型整合。

## Owner 核對後裁定（2026-11-13，優先於上述候選文字）

- Registry/manifest/主檔/reference 的 hash 一律原始檔案 bytes SHA-256 lowercase hex，不重新序列化。registry 開發路徑由模組位置定位 repo，不依 cwd。PM 以 repo root build context 打包至 /app/contracts/tools/registry.json；既有 Worker WORKDIR 不需更動。Server/Manager/Worker 映像包同一份檔案並設定絕對路徑，套件 Dockerfile 修改交各 owner、compose context 由 PM 修改。
- limits 計算 arguments/result 各自 JSON 序列化 UTF-8 bytes，不含 transport envelope。read_draft/update_draft 對應大內容方向採 13 MiB JSON 上限，script raw 仍 2 MiB；browser 結果 128 KiB。不得提高 credential/history 的既有 64 KiB frame；新增 tool frame 上限 14 MiB（含 NDJSON 換行），HTTP tools body 同上。超限安全拒絕且不記錄原內容。
- provider function_call.call_id 是 opaque ID，不是傳輸 UUID。Worker 為每個邏輯工具呼叫產生 requestId UUID 並保存映射；同一呼叫重送沿用 UUID，結果仍對回原 provider ID。
- v10 Worker input 與對應 Manager assignment 傳輸 envelope 上限 64 MiB，計序列化 JSON UTF-8 bytes；files raw 合計仍 8 MiB。輸入必須恰有一個 tests/test.spec.ts；其餘只允許 lib/<slug>.ts，slug 使用上述規則。不得順便放寬舊 credential/history 限制。單一 bundle 同 slug/moduleTestId 只能引用同一 moduleVersionId，同版合併、異版拒絕。
- bind 僅展示別名；binding 一律 stageId，無 bind 仍可引用。path=[] 是整個回傳值，非空路徑以 bracket JSON string keys 產碼。
- 候選 Module version ID 必須在 Compose/驗證入列前預配，持久綁定 moduleTestId、revision 與 bundleHash；發佈沿用同 ID。revision 變動即作廢候選與驗證，不重用舊 ID。預配不等於發佈、不出現在已發佈 Catalog。
- bundle hash payload 固定 `{schemaVersion:1,files,stages,module,dependencies}`；files 按 path、dependencies 按 moduleVersionId 排序，stages 原順序；缺省 module=null、stages=[]、dependencies=[]。dependencies 每項固定 `{moduleTestId,moduleVersionId}`。Server Go encoding/json 固定結構/map key 排序為唯一算法；不轉換內容換行。context/revision 另沿原有門檻核對。
- partial 的 scriptHash 是最終 script 原始 UTF-8 SHA-256 lowercase 64 hex，Server 重算。有 checkpoint 必附 script；無 checkpoint 禁止 script。nextStep 非空且 <=8192 bytes。checkpoint 由 Worker 守衛產生，不採信模型。遮蔽若更動自試通過的 script，必須重新驗證或丟棄 checkpoint/script，不能宣稱 selfTestPassed。
- partial 僅適用 test-author/legacy author，不適用 workspace/summary。Run.authorPartial 保存 `{reason,nextStep,checkpoint?,appliedRevision?}`；套用 checkpoint 後記錄 appliedRevision，繼續核對該 revision 以及 session/context，未套用時核對原 baseRevision。
- skills 快照每項 `{id,version,sha256,manifestSha256,referenceHashes:Record<referenceId,sha256>}`；sha256 指 SKILL.md。skills[0] 為主 skill，其餘按 id 排序。WHIPPET_SKILLS_PATH 指向套件根，各 id 目錄含 SKILL.md、manifest.json、references/；reference path 相對該 skill 目錄。映像絕對路徑由 owner 回報既有佈局後 PM 配置。Worker 必須比對快照與本機 bytes，不符明確失敗，不以新版替代。author.budget/model 使用 manifest 的同名結構，model 不包含 key。僅全部新增快照欄位缺席才走 v9；部分缺席或 hash 不符不得降級。
- candidate 工具僅改 attempt-scoped candidate，不直接遞增正式草稿 revision；author 收尾以 CAS 一次套用。工具每次先驗活躍 attempt/權限，再查 dedupe；跨 attempt 不重用結果。Plan 排程與候選 Module 的具體工具 schema 在接線前由 PM 追加，不自行發明工具欄位。

### M10.2 reference 工具固定

M10 的 model.provider 固定為 `opencode`，代表既有後端 Responses provider；model.model 必須等於後端已配置 model。此代號不允許選擇任意 endpoint，也不含金鑰。多 provider 路由留待 M12，Server 與 Worker 不自行使用其他別名。

read_skill_reference 的 schema/limits 見 registry，結果 `{skillId,referenceId,content}`，完整 JSON 超限安全拒絕，不截斷。WHIPPET_SKILLS_PATH 映像固定 `/opt/whippet/worker/skills`，本機套件為 runtimes/worker/skills。Server 映像亦打包同一 skill 目錄供快照裁決。註冊不代表所有 Run 自動授權，仍以快照 allowedTools 為準。

### Partial 繼續 API（PM 固定）

`POST /api/runs/{id}/continue`，body 僅 `{editingSessionId:string,revision:integer}`，拒絕未知欄位。沿既有 UI 使用者授權、Workspace/test/session 所有權與 CSRF/同源規則，不提供給 MCP/Agent Token。僅成功終態且有 authorPartial 的 test-author Run 可繼續；Worker 已回收、原 attempt 已釋放才可排下一筆。

成功 202 `{run:<Run>,conversationId:string}`（AuthorSubmission）。第一次呼叫以交易 CAS 核對目前 active editingSessionId、context_revision 與原 Run 完成後保存值，revision 比對 authorPartial.appliedRevision（無套用則原 baseRevision），不信任 caller 的 context。過期、非 partial 或未回收回 409；無權限沿現有 API 拒絕/隱藏規則。沿原對話與 test，將 nextStep 作為續接資料，不能擴大工具/網站權限；新 Run 由 Server 重新裁決完整快照。

保存 source_run_id 唯一關聯，並發與重複點擊只建立一筆 Run。同原請求重送先核對目前授權及原 source 所有權，再回同一 AuthorSubmission，不因新 Run 已推進而建立第二筆；同 source 但不同 session/revision body 回 409。原交易失敗不得留下半筆 source 關聯。Run 查詢提供 authorPartial，Web 只在符合條件時顯示「繼續」，409 顯示需重新載入/確認草稿，不能自動以新 revision 重送。

## M10.5 Plan 控制面（PM 固定）

Plan 屬於單一 Use Case editing session，固定 `{id,testId,editingSessionId,revision,baseRevision,contextRevision,status,stages,validationRunId?,error?}`。Plan.revision 是獨立 CAS 計數，初次建立請求 planRevision=0；已存在則必須匹配目前 revision。最多32個 Stage，id唯一，每項 title 非空。Plan status 為 draft→confirmed→running→composed→done；失敗或取消為 stopped。done 只在原子發佈交易成功後設定。stopped 不隱性重跑，必須由使用者修訂並重新確認。

Plan Stage 固定 `{id,title,action,status,moduleTestId?,moduleVersionId?,module?,draftRevision?,candidateVersionId?,authorRunId?,validationRunId?,error?,args,bind?}`；action=reuse|modify|create，status=pending|authoring|validating|ready|failed。args/bind 沿前述 Stage 規則。module 在 create 時為 `{slug,moduleKind,description}`，不等於完整 Module metadata；modify/reuse 必須指定固定 moduleVersionId 且由 Server 推導 moduleTestId，若 caller 同時提供 testId 必須相符。modify 為原 Module 開新 editing session，已有活躍 session 衝突時停止並回報，不強制接管；不得改已發佈版本。create 的 slug 依 Workspace 唯一規則，衝突不覆蓋。

reuse 僅接受同 Workspace 已發佈固定版本；新/改 Module 的 candidateVersionId 在驗證前分配，綁定 revision/bundleHash；任何修改使候選失效。Stage 依序執行，上一項 ready 才進下一項；author/validation 失敗即停。取消時標 stopped，active Run 走既有取消與回收流程，不提前釋放名額；遲到結果不得推進 stopped Plan。所有 Stage ready 後 Server 確定性 Compose，每 Stage 一個 test.step，固定候選ID，再排 Use Case 真實驗證。MVP Plan 僅規劃 Module Stage，手動 Use Case 的 inline Stage 仍依前述資料契約，不自行添加第四種 Plan action。

### UI API

全部沿既有 UI 所有權/Workspace/session 授權，未知欄位拒絕；衝突與過期409。

- GET `/api/tests/{id}/plan?editingSessionId=...` → 200 `{plan:null|Plan}`。
- PUT `/api/tests/{id}/plan` body `{editingSessionId,revision,planRevision,stages}` → 200 `{plan:Plan}`；revision 是目前草稿 revision；僅 draft/stopped 可改，stages 僅接受使用者可編輯欄位 id/title/action/moduleTestId?/moduleVersionId?/module?/args/bind?，所有執行狀態/Run ID 由 Server 生成。
- POST `/api/plans/{id}/confirm` body `{planRevision,confirmed:true}` → 200 `{plan:Plan}`；交易 CAS 並排第一個需要處理的 Stage。只允許 UI 人工確認，不提供 Agent tool。
- POST `/api/plans/{id}/cancel` body `{planRevision}` → 200 `{plan:Plan}`；原子停止並取消 active Run，回收另行等待。
- POST `/api/plans/{id}/publish` body `{planRevision,confirmed:true,summaryRunId}` → 200 `{usecaseVersion,moduleVersions}`。僅 UI；核對全部 revision/context/bundle hash/validation/summary及候選ID，任一失效整批回滾。確認頁必須列出批次 Module 清單；Use Case summary 必須涵蓋整包候選清單，不能以單份 script summary 冒充。

相同確認請求重送不得重排 Stage；相同發佈請求重送回原批次結果，不建立第二組版本。異 revision 拒絕。以 Plan revision/操作及已持久化結果保證冪等，不把網路重試當新編輯。

### M10.6 工具接縫（待 Runtime 核對後加入 registry）

範圍固定為 catalog_search、catalog_get、read_module_draft、read_usecase_draft、read_plan、propose_plan、update_module_candidate、request_module_validation。scope 全由 Run 推導，不接受 Workspace/session 自選。

- catalog_search：`{query,limit,cursor}`；query<=1024 UTF-8 bytes、limit為1..20整數、cursor為string|null；結果 `{items:[{testId,versionId,name,module}],nextCursor}`，最多128KiB，cursor不得擴scope。
- catalog_get：`{moduleVersionId}`；結果 `{testId,versionId,script,module,scriptOrigin}`，固定版本及同Workspace。
- read_module_draft/read_usecase_draft/read_plan：參數 `{}`，只讀目前Run綁定對象；結果依序為 `{testId,editingSessionId,revision,script,module}`、`{testId,editingSessionId,revision,stages,script}`、`{plan:null|Plan}`。
- propose_plan：`{stages}`（與PUT可編輯Stage欄位一致），結果 `{candidate:true}`；server/candidate，attempt-scoped，author收尾CAS才保存draft Plan，不能確認/排程/發佈。
- update_module_candidate：`{script,module}`（完整metadata），worker/candidate，以 Module本體+harness 自試才回 `{candidate:true,selfTestPassed:true}`；自試失敗不能覆蓋最後通過候選。script與harness各raw<=2MiB，相關工具 input/output JSON上限25MiB、tool frame上限26MiB。此大frame只適用Module內容工具，credential/history原限制不變；v10 input envelope仍64MiB。
- request_module_validation：`{}` → `{requested:true}`；worker/queue僅旗標，Server收尾且Worker回收後才排正式驗證。

新增 author output 只依明確主skill解析：module-authoring 為舊 message/script/requestValidation 加完整 module；usecase-planner 為 `{message,planCandidate:{stages}}`，不可帶script/module/requestValidation。Module metadata及Plan只能來自已核對candidate，模型終稿不可跳過自試/範圍/CAS。module-authoring context 加 planId/stageId 與 Module metadata，planner context 綁定 Use Case editing session。partial 仍只適用 test-author；Module預算失敗停Stage，不冒充partial。主要skill白名單擴充需Server/Manager/Worker同步，未實作前不公開能力。usecase-healer/catalog-reuse維持輔助skill。

### Author artifact 總量與守衛（partial 接收端裁定）

`author.json` 完整 UTF-8 JSON bytes 上限固定 13 MiB，涵蓋 Worker final序列化、Manager讀取/驗證/上傳與Server上傳/讀取/parser；script raw UTF-8仍<=2MiB。僅 author.json 使用此上限，不連帶放寬其他artifact、credential/history或IPC。summary/workspace不得因此接受partial，其既有內容欄位上限保留。超限在解析/套用前拒絕。

checkpoint由Worker自試守衛閉包保管最後通過候選與hash，最終從閉包重建，不採信EnginePartial提供的script/hash/selfTestPassed。若機密遮蔽改變候選任何byte，丟棄checkpoint及script，仍可回傳無checkpoint partial（或重新自試後建立新checkpoint）。不能對遮蔽後script直接重算hash就冒稱已驗證。Manager與Server均獨立核對完整JSON、raw script大小、lowercase SHA、reason/nextStep、requestValidation=false、有無checkpoint對script的限制、主skill與update_draft能力；拒絕null與未知欄位。超量/錯hash/權限不足不得寫入草稿。

### M10.6 三端接線裁定（registry 10.1）

本節取代前述有衝突的候選形狀。八項工具完整 inputSchema 已加入 registry；註冊不代表實作或授權完成。只有 handler/parser/manifest/快照一致才加入 allowedTools。validator 必須支援目前 schema 所用 object/array/required/additionalProperties/propertyNames/oneOf/const/enum/type/minimum/maximum/maxItems/minItems/maxProperties/pattern/format(uuid)；`x-maxUtf8Bytes` 計字串原始UTF-8 bytes，`x-maxJsonBytes` 計JSON UTF-8 bytes，`x-maxDepth` 根值深度0，每層容器加1。literal 僅JSON值、有限數值、禁止prototype污染鍵；args.page及保留prototype鍵拒絕。這些自訂上限由守衛執行，不能只相信provider schema驗證。模型API如不支援部分schema約束，僅傳相容表示，權威schema與守衛驗證仍同一來源且不可省略。

Module文字欄位上限見schema，raw script/harness各2MiB。只有 Run 主skill=module-authoring 的 author.json 可達25MiB；其餘13MiB不變。所有接收與上傳路徑先由權威Run識別主skill再選上限，不信artifact自報skill，不放寬summary/workspace。Module final schema `{message,script,module,requestValidation,conversationSummary?}`，沒有partial；message/conversationSummary沿既有上限。Worker從自試守衛閉包重建script/module，模型僅提供message/conversationSummary，不能把模型終稿的module當候選；遮蔽改變本體或harness任何byte就丟棄候選或重新自試。預算失敗停Stage，不套用未通過稿。

26MiB IPC frame僅供 catalog_get、read_module_draft、update_module_candidate（worker本地工具不因此產生不必要IPC）；其餘工具14MiB上限，credential/history沿原64KiB。工具結果還受各自registry JSON上限。response沒有name時，由pending requestId→tool name映射選上限；未知/已取消ID拒絕，不能讓response自選大frame。串流讀取在取得requestId前硬上限26MiB，識別後施加更低上限，禁止以此放寬舊kind。

propose_plan 的成功結果改為 `{candidate:true,candidateRef:string,stages:[...]}`，其中stages是Server正規化後的已驗證可編輯Stage，候選記錄綁定run/attempt/session/baseRevision/context與內容hash，不能確認或排程。planner final固定 `{message,planCandidate:{candidateRef},conversationSummary?}`，取代舊的直接stages輸出。Worker僅從工具成功回覆的guard閉包取ref；Server收尾再核ref所有權/活躍attempt/CAS並讀保存的canonical stages，不採信模型ref或stages。工具重送沿callId去重，candidateRef保持相同；一次attempt可提出多個候選，只有最後成功者可成為終稿，失敗提案不覆蓋最後成功者。

AuthorInput新增 `platform?:{planId:string|null,stageId:string|null,module:Module|null}`。module-authoring必須有platform與module；Plan調度時planId/stageId皆非null且與Server Stage綁定；獨立Module編輯時兩者皆null，test.kind必為module。usecase-planner必須有platform，module=null、stageId=null，planId可null（尚未建立Plan），test.kind必為usecase。其他primary禁止platform。Module metadata/Plan context由Server快照，Manager/Worker嚴格檢查，不允許模型指定其他目標。create初稿的module可以是有效空harness/文字欄位，但不構成通過候選；update_module_candidate必須經真自試。

request_module_validation只記旗標；Server在自試候選CAS收尾且Worker回收後排驗證。module-authoring/usecase-planner主skill必須三端同步白名單及final parser才啟用；catalog-reuse/usecase-healer仍為輔助skill。新registry hash在每次enqueue載入，既有v10.0快照Run遇套件漂移明確失敗，不靜默改用10.1；部署前清空活躍Run或保留舊包，禁止在共享環境直接替換活躍Run依賴。

### platform 精確 JSON 路徑（PM 消除型別命名歧義）

assignment 與 Worker input 一律使用 `author.platform`，與 `author.skillId`、`author.skills`、`author.budget` 同層；**不存在頂層 platform**。本文 AuthorInput 指 author payload，不是整個 WorkerInput。Manager 轉送不得搬移欄位。

Module 範例（僅示意路徑，其他既定必要快照欄位仍須存在）：
```json
{"author":{"skillId":"module-authoring","platform":{"planId":null,"stageId":null,"module":{"slug":"login","moduleKind":"step","exportName":"login","signature":"","inputs":"","returns":"","preconditions":"","postconditions":"","harness":""}}}}
```
planner 為 `author.platform={planId:null|string,stageId:null,module:null}`。新 primary 缺少 author.platform、僅給頂層 platform、兩處同時提供或一般primary帶platform均拒絕；不得做頂層到巢狀的靜默fallback。舊Run沒有此欄位仍依前述legacy規則處理。

## M10.5 批次 acceptance-summary（PM 固定）

沿用主skill `acceptance-summary`、allowedTools=[]、maxToolCalls=0，final嚴格維持 `{message,description,backgroundSummary,name?}`，不新增module陣列、不接受script/partial/planCandidate。description<=16384、backgroundSummary<=8192、name<=200 UTF-8 bytes，message沿原上限。artifact總量仍13MiB。模型只產整批摘要，不裁定驗證成功或版本資格。

精確新增路徑為 **`author.batch`**（非頂層、非author.platform），只允許acceptance-summary；一般單Test摘要省略batch，其他primary出現batch拒絕。batch=null拒絕。結構：
```text
{
 schemaVersion:1, planId:UUID, planRevision:integer>=1,
 batchHash:lowercase-SHA256,
 usecase:{testId:UUID,editingSessionId:UUID,revision:integer>=1,
   contextRevision:integer>=0,bundleHash:lowercase-SHA256,
   validationEvidence:<既有ValidationEvidence>},
 modules:[{
   testId:UUID,versionId:UUID,mode:"reuse"|"candidate",
   editingSessionId:UUID|null,revision:integer>=1,contextRevision:integer>=0,
   bundleHash:lowercase-SHA256,
   name:string,description:string|null,
   module:{slug,moduleKind,exportName,signature,inputs,returns,preconditions,postconditions},
   harnessHash:lowercase-SHA256,
   validationEvidence:<既有ValidationEvidence>
 }]
}
```

modules是Use Case引用的去重Module集合，最多32項，按versionId排序，同Module單版本；mode=candidate包含本批create/modify候選且editingSessionId非null；reuse指已發佈固定版本，editingSessionId=null，revision/context及驗證證據來自該版本不可變快照，不取目前草稿。module欄位沿registry文字限額，但不重複傳harness正文；harnessHash綁定實際驗證harness。name<=200、description為null或<=16384 bytes。整個author.batch序列化JSON<=4MiB；一般Worker input仍<=64MiB。未知欄位拒絕。

batchHash由Server以Go encoding/json固定結構序列化 `{schemaVersion,planId,planRevision,usecase,modules}`（不含batchHash本身）後SHA256；modules已排序。Worker/Manager驗形狀/界限並完整轉送，不另推導發佈權限。Server在建摘要Run的同一交易保存batch，驗證所有candidate與UseCase目前revision/context/bundle、reportsReady、成功驗證及Worker回收，檢查重用版本不可變；不足即拒絕，不把未驗候選送去摘要。主Run的既有validationEvidence對應usecase.validationEvidence；所有來源為已核對資料，不是指令。模型摘要必須說明UseCase流程、複用/新改Module、驗證涵蓋與限制，不得宣稱未測行為。

UI新增 POST `/api/plans/{id}/summary` body `{planRevision,validationRunId}` → 202 `{run:Run}`；相同batch已有進行中摘要返回同Run，已有有效成功摘要回200原Run。僅composed且所有驗證成功可請求；不重排validation。摘要完成時再核對Plan revision/候選revision/context/bundle及batchHash，過期不套用。摘要不改Plan revision，也不把Plan標done。

POST plan publish 的summaryRunId必屬同Plan與相同batchHash/planRevision，且摘要成功；交易內再次重建核對batch，鎖住所有候選與UseCase revision後一起發佈。candidate Module版本保存共同summaryRunId/batchHash作為此批次摘要依據；整批摘要可供每個候選追溯，不假稱模型逐一產生獨立Module摘要。人工確認UI須同時顯示完整candidate清單及整批摘要，不能只確認UseCase名稱。任一候選失效/取消/更動/缺驗證/摘要過期都整批回滾，reuse版本不重發佈。獨立Module發布仍需自身Module harness驗證與獨立summary流程，不能借用其他批次摘要。

### 批次摘要唯讀 UI 接縫

GET `/api/plans/{id}/summary` → 200 `{summary:null|PlanSummary}`，沿Plan所有權/Workspace授權；無摘要時null，不從EditingSession.summary fallback。PlanSummary固定：
```text
{runId:UUID,planId:UUID,planRevision:integer,batchHash:lowercase-SHA256,
 status:<既有Run status>,stale:boolean,publishReady:boolean,
 message:string|null,description:string|null,backgroundSummary:string|null,name:string|null,
 candidates:[{testId:UUID,versionId:UUID,name:string,slug:string,moduleKind:"setup"|"step"|"page",revision:integer,bundleHash:lowercase-SHA256}]}
```
回傳此Plan最近一筆摘要Run的持久化綁定及內容；尚未成功時文字為null。candidates僅該batch mode=candidate的完整清單，依versionId排序，reuse不偽裝新增發佈項。stale由Server重核Plan revision/context/候選revision/bundle/hash決定，失配為true；缺完整快照不得回可發佈。publishReady只在成功、非stale、完整候選驗證/摘要/回收門檻成立且Plan仍composed時為true。Web必須同時檢查回傳planId與目前Plan一致、planRevision相同且publishReady=true才開放確認；POST publish仍交易內再次檢核，不信UI布林值。過期摘要可顯示但明確標記不可發佈，不將舊summaryRunId自動換成新版。

## 獨立 Module acceptance-summary（PM 固定）

精確新增 `author.moduleSummary={schemaVersion:1,module:<完整Module含harness>,bundleHash:<lowercase SHA256>,bodyHash:<lowercase SHA256>,harnessHash:<lowercase SHA256>}`。僅kind=author且主skill=acceptance-summary、目標Test.kind=module的獨立摘要可帶；與author.batch/author.platform互斥，null/未知欄位拒絕。無此欄位的舊單Test摘要沿原格式，不以猜測腳本內容啟用分支。

Worker input頂層script仍是Module本體，Worker/Manager核對bodyHash等於script原始UTF-8 SHA256、harnessHash等於module.harness原始UTF-8 SHA256；完整Module metadata沿registry schema。僅此分支的author.validationEvidence.scriptHash必須等於harnessHash，因正式validation實際入口為harness，不能以本體hash替代已執行腳本。validationEvidence其他欄位沿真實正式驗證Run（成功、report ready、revision/attempt等）；Server另以bundleHash核對body+harness+metadata，防止只驗harness未綁本體。

moduleSummary完整JSON<=13MiB；body/harness raw各<=2MiB，Worker input envelope<=64MiB。allowedTools=[]、maxToolCalls=0；summary prompt包含metadata、本體、harness與已核對evidence，均當資料而非指令。final仍嚴格為既有 `{message,description,backgroundSummary,name?}`，author.json上限13MiB，不接受Module本體/partial或任意新欄位。

沿既有draft summary與人工publish API，不新增發佈捷徑。Server enqueue/摘要收尾/人工發佈三時點核對同revision/context/bundleHash、正式validation成功及回收；metadata/body/harness任一修改皆使舊驗證及摘要失效。獨立Module不得借用author.batch摘要或其他Module的summaryRunId；版本metadata與本體/harness固定保存，已發佈版本不可變且僅成功發佈後Catalog可見。版本預配為Server內部實作，不由模型決定。

### Catalog 搜尋游標使用說明（2026-11-13）

`catalog_search` 首頁必須傳 `cursor: null`，不可用空字串代替。後續頁只可原樣使用同一 Workspace、同一 query 前次回應的 `nextCursor`；不得自行製造或修改游標，更換 query 時必須重設為 null。`nextCursor: null` 表示沒有下一頁。這是既有游標語意的明確說明，schema、授權、範圍綁定與無效游標拒絕規則不變。registry description 更新須重新計算原始 bytes SHA 並供新 Run 快照使用；既有 Run 不可替換快照。

### Catalog 搜尋參數錯誤回饋（2026-11-13）

既有 `tool_response.error` 字串新增固定值 `catalog_search_invalid_request`，不改 envelope。僅當 pending 工具為 `catalog_search`、既有可信 TLS/attempt/request 綁定通過、HTTP 狀態為 400、回應符合既有 `Cache-Control: no-store` 要求，且在既有大小限制內驗證 JSON error envelope 的 `error.code` 精確為 `invalid_request` 時，Manager 才可映射此值。不得傳遞原始 body、message、參數、游標或 endpoint。其餘狀況維持原有不透明錯誤；不得由 HTTP 400 單獨推論此值。

Worker 僅可在對應 pending `catalog_search` 回覆識別此值，其他工具、未知或格式錯誤回覆仍按原失敗路徑處理。此值僅表示搜尋參數遭拒，不代表已知是游標錯誤。模型可見固定回饋應要求檢查 query/limit/cursor，並重述：首次 cursor 使用 JSON null、翻頁僅原樣使用相同 query/Workspace 的 nextCursor、更換 query 重設 null、nextCursor=null 停止翻頁。允許模型在既有預算內自行修正參數重試，不自動代換參數、不增加預算、不擴權、不放寬 schema 或 Server 游標檢查。成功提案與收尾守衛仍須原有工具成功證據。

### Catalog provider strict 映射（2026-11-13）

`catalog_search` 傳給模型的 function tool，在移除僅供本機使用的 `x-*` 擴充後使用 `strict: true`，保留原 object、required、nullable cursor 與 `additionalProperties: false` 結構。本機仍以完整 registry schema 驗證 UTF-8 bytes、limit 與其他限制；Server 游標語意不變。不將字串 null 或其他錯誤游標自動轉為 JSON null。不擴及其他包含動態 keys/oneOf 的工具。後端若拒絕 strict，按既有 provider failure 處理，不靜默降級或增加預算；支援程度與驗收效果須由實跑證明。

### Registry 10.2：Catalog 首頁與翻頁分離（2026-11-13，覆蓋前述搜尋 cursor 規則）

- `catalog_search` 僅接受 `{query:string,limit:integer}`，limit=1..20；兩欄必填，禁止其他欄位（包含 cursor）。固定搜尋首頁，不是將錯誤 cursor 轉為 null。provider strict 映射僅對此 closed/required 兩欄 schema 啟用；本機原始 schema 守衛不變。
- 新增 `catalog_next_page`：`{cursor:string,limit:integer}`，cursor 非空且最多1024 UTF-8 bytes，limit=1..20；兩欄必填，禁止其他欄位。沿用 server/read、15秒、輸入16KiB／輸出128KiB。結果與首頁相同 `{items,nextCursor}`。
- 翻頁 query／after 由 cursor 解析，Workspace 必須比對權威 Run。cursor 還必須精確匹配同 Run、同 attempt 先前成功 `catalog_search` 或 `catalog_next_page` 的 `platform_tool_calls.result.nextCursor`（非 null）。不得僅憑 base64 格式宣稱為 Server 核發。先核 active attempt／scope／epoch／權限，再做發行匹配及既有去重；舊、跨 attempt／Run、未發行或改造游標拒絕。合法已發行游標可重讀，結果仍受原預算與 callId 去重規則約束。
- 兩工具共用既有 MaxToolCalls，不新增預算、HTTP endpoint、frame 上限或 migration。`catalog_next_page` 的模型 strict 使用原通用映射，不自動擴及搜尋專用 strict 規則。
- `catalog_search_invalid_request` 映射仍僅限首頁搜尋；固定修正提示改為檢查 query／limit，不再要求首頁填 cursor。翻頁錯誤維持既有不透明回覆，不自動重新首頁、不轉換游標。
- Planner manifest 明確加入翻頁工具；skills／registry 新原始 bytes 必須由三端一致封裝並釘選。既有 Run 快照不得更換。單 registry 部署須先排空，或取消並等待舊 Run 回收後切換；不提供雙版 fallback。

10.2 發行匹配儲存裁定：沿用 `platform_tool_calls`，不新增 `tool_name` 欄或 migration。以同 Run／attempt 的非 null 頂層 `result.nextCursor` 精確匹配；此成立的必要條件是該表僅 `catalog_search`／`catalog_next_page` 由 Server 產生的成功結果含頂層 nextCursor，其他工具結果及模型內容不得注入此欄。history 使用獨立表，不作發行來源。實作須以定向測試守住此來源條件，未來若新增同名輸出須先更新發行來源設計。`minLength` 以 Unicode code point（Go rune）數計算，與 `x-maxUtf8Bytes` 上限獨立驗證。

### 發布後 Plan 唯讀查詢（2026-11-13）

既有 `GET /api/tests/{id}/plan?editingSessionId=...` 維持 `{plan:null|Plan}` 回應。先核對 Test 為 usecase、session 屬於同 Test／Workspace及既有存取權限。active session 沿既有 reconcile 路徑；closed session 僅 SELECT 同 test/session 的既有 Plan，可讀取歷史 done 狀態，不要求目前 Draft、不 refresh／建立 session／修改任何狀態。closed GET 不可取得另一 Test／Workspace 的 Plan。PUT、confirm、cancel、publish 的 active/CAS/所有權門檻完全不變；公開版本成功不代替 Plan 狀態實讀證據。

### 失敗 Stage 人工修復與重試（2026-11-13）

此段新增明確人工操作，補足 stopped Plan 的原 Stage 修復；不代表自動重試，也不要求先獨立發布 Module。原 PUT 修訂／confirm 路徑保持，不能以重新 confirm 舊操作當作 retry。

- `GET /api/plans/{id}/stages/{stageId}/retry` → 200 `{retry:{eligible:boolean,reason:null|string,planRevision:number,source:null|{moduleTestId:string,editingSessionId:string,moduleRevision:number,moduleContextRevision:number,authorRunId:string,authorStatus:string,validationRunId:string|null,validationStatus:string|null,reclaimed:boolean}}}`。先核既有權限及資源歸屬，Stage 不存在回404；此 GET 純讀、不 reconcile、不建立 session、不入列。eligible=true 時 reason=null、source完整且reclaimed=true。不可用 reason 固定為 `plan_not_stopped`、`stage_not_retryable`、`cancelled`、`source_unavailable`、`session_closed`、`reclaim_pending`、`snapshot_mismatch`、`prior_stage_invalid`、`scope_unavailable`；無法安全取得來源時 source=null。這是當下資格快照，POST 必須再次核對，不是授權憑證。
- `POST /api/plans/{id}/stages/{stageId}/retry` body 必填 `{planRevision:int>=1,moduleRevision:int>=1,moduleContextRevision:int>=0,confirmed:true,content:string}` → 200 `{plan:Plan}`。禁止未知欄位／null／省略 CAS；不接受客戶端指定 Module、session、sourceRun ID。content 沿 validateUserMessage：合法 UTF-8、無 NUL、trim 後非空、最多16000 Unicode code points；保留原字串，不默默 trim。只供人工 UI，不新增 Agent tool。
- 首版僅收 stopped Plan 中 failed 的 create/modify Stage：前序全ready、後序全pending。author失敗只收failed/timed_out；validation失敗須source author succeeded、immutable candidate／validation關係完整且validation failed/timed_out。取消／cancelling／interrupted、dispatch無sourceRun、Compose失敗均不涵蓋。核取消世代／歷史，不能只由 stopped+failed 推斷資格。
- Server 從原 Run 的 author.platform.planId/stageId、Test／Workspace／session關係推導來源，原 Module session必須仍active。Module request兩CAS須同時匹配當前值及失敗鏈權威快照（失敗author的baseRevision/contextRevision；失敗validation的immutable candidate revision/contextRevision）。UseCase當前revision/context須匹配Plan baseRevision/contextRevision。任一人工或其他author異動皆409，不能傳新CAS偷偷採納。相關author/validation及同session無active/pending且slot已釋放；回收前409。
- 重核前序reuse固定版本／Workspace，及前序candidate的session/revision/context/bundleHash、成功validation與回收；保留其候選ID及Run，不重做。失效409，整筆不得入列。
- 單一交易內保留原Module session／稿，追加人工修復訊息，Module context+1，依現行prepareAuthor權限與最新skills/registry/model快照建立fresh module-authoring Run，author.platform仍綁原Plan/Stage，預算不加。只將此Stage改authoring/newAuthorRun，清當前validation/candidate引用及error；舊Run、immutable candidate與validation request保留。Plan轉running/revision+1，其他Stage不變。舊author收尾與舊validation scheduler都須核當前Stage.AuthorRunID/sourceRun及Stage狀態，遲到結果不能復活歷史工作。
- migration019新增不可變 `plan_stage_retries`，PK `(plan_id,request_plan_revision)`，保存stage_id、canonical完整request（content原字串）、source_author_run_id、nullable source_validation_run_id、new_author_run_id、result JSON與FK。同原revision相同stage/body回原結果／同Run；不同stage/body409。先核權限與資源歸屬再查冪等；命中不重跑已改變的CAS／active門檻。取消後重送只回歷史結果，不復活。拒絕不留成功紀錄；紀錄、入列及Plan更新同交易。
- Web僅根據GET資格開放failed Stage修復表單，顯示原Module/session、來源Run與回收狀態，必填修復指示及獨立人工確認。固定三個CAS；文字／快照改變清確認，缺欄／未知／回收中禁用。409或不確定提交結果鎖住，不自動取得新CAS重送；明確reload後重新人工確認。不得使用UseCase blocked狀態代替Module回收證據，不得以獨立Module發布繞過批次發布。

取消歷史補充：既有Run取消後可能被failed終態覆蓋，不能以目前status或缺少run_events推論從未取消。migration019另增nullable `runs.cancel_requested`：既有cancelling/cancelled回填true，其餘既有Run保留NULL（歷史未知）；新Run預設false。資料庫trigger遇cancelling/cancelled永久鎖true，不允許true重設或既有NULL在非取消轉移被改成false。retry來源author及validation必須明確false；true回資格reason=cancelled，NULL回source_unavailable並拒絕POST。Plan取消世代檢查仍保留。此限制意味升級前的失敗Stage可能不可原地retry，不得人工修改旗標繞過；以升級後新Run驗證新功能，舊失敗證據保留。公開Run terminal wire不變。

### M10.9 自試安全診斷 v2（2026-11-14）

僅限既有 `WHIPPET_M109_DIAGNOSTICS=1` 的 opt-in 診斷，預設關閉，不變更公開 Run API、預算、skill、Run 結果或驗收門檻。診斷 sidecar schemaVersion=2 在原 Worker 固定摘要增加 `lastSelfTestFailureClass`；Manager 嚴格驗型並保留 v1 讀取相容，v1 無此資訊必須視為 UNKNOWN，不回填舊 Run。

固定值為 `INVALID_SPEC`、`GUARD`、`TIMEOUT`、`CANCELLED`、`TEST_FAILED`、`UNKNOWN`。僅可由實際可信程式分支／reporter 結構產生；無可證 producer 的類別回 UNKNOWN，不以自由文字 regex、錯誤名稱或 exit code 猜測。TEST_FAILED 只代表 reporter 記錄測試 failed，不代表已定位 assertion 根因；INVALID_SPEC 只代表現有前置檢查拒絕，不冒稱編譯失敗。欄位只記最後一次自試失敗，與整個 Run 的 terminalClass 獨立；未觀測為 UNKNOWN。

不得加入自由文字、selector、URL、ID、content、hash 或原始 error。既有大小上限、exclusive/no-follow、單次輸出及診斷失敗不影響 Run 語意維持；先完成離線分支與敏感 sentinel 驗證，再由 PM 切換已排空的 19287。此次已回收 Run 不可據新診斷推論歷史原因。

封裝裁定：Worker 的 v2 診斷訊息包含 `schemaVersion:2` 與七個摘要欄位；v1 訊息維持原六欄、無版本欄。Manager sidecar 使用外層 schemaVersion，worker 子物件不重複版本欄，v1 六欄／v2 七欄均精確驗型。尚未觀測 Worker 的新 sidecar 為 v2 且類別 UNKNOWN；收到舊 payload 則保留 v1，不假造新資訊。

2026-11-14 離線修補裁定：terminalClass 增加固定 `INVALID_RESPONSE`，僅映射可信 `AuthorError(invalid_response)`；它是通用拒絕碼，不宣稱模型專屬原因，也不可取代已記錄的 FINAL_SHAPE／FINAL_JSON_PARSE 等較精確分類。main 的可信 cancelled 碼可映射 CANCELLED；原生未知例外仍 UNKNOWN。`lastSelfTestFailureClass` 白名單不變。此修補尚未封包／部署，不回填現場 retry2 的 UNKNOWN。

### M10.9 模型請求安全分類 v3（2026-11-14）

沿原M109開關新增worker `modelRequestFailureStage`，固定UNKNOWN/FETCH_REJECTED/HTTP_NON_OK/BODY_JSON_REJECTED/RESPONSE_GUARD_REJECTED/INCOMPLETE_MAX_OUTPUT_TOKENS/INCOMPLETE_CONTENT_FILTER/INCOMPLETE_UNKNOWN/ENVELOPE_INVALID。僅真fetch/body/response guard及engine原envelope拒絕分支記錄，原樣throw、不改Run結果；observer例外吞掉、first-specific、UNKNOWN不覆蓋具體值，gate off不掛callback。signal已abort時不把bounded取消誤分類fetch/body失敗。

incomplete類別僅限status精確incomplete；incomplete_details必須為非null非array object，reason精確max_output_tokens或content_filter才映射，其他INCOMPLETE_UNKNOWN；非incomplete忽略reason。只輸出固定enum，不輸出原值、HTTP數字、URL、錯誤文字、內容或機密。這是回應觀測，不是歷史根因推論，8192輸出上限與其他預算不變。

Worker payload v3為version＋八摘要欄（共九）；sidecar外層version3、worker八欄不重複version。Manager/reader嚴格支援v1/v2/v3，未知欄位/混版/null/duplicate/未知enum拒絕。舊版與未觀測投影UNKNOWN、保留原值不回填。既有2048-byte payload／4KiB sidecar與exclusive/no-follow不變；Manager/Worker須同批切換，不單換Worker。


### G6 單次輸出預算（2026-11-14 使用者明確授權）

budget 新增可選 `maxOutputTokens`，manifest／author 快照使用同一欄位。原三欄或新四欄精確驗型；值為 1..16384 整數，拒絕 null、布林、字串、小數、越界與未知欄位。只有缺欄時 effective 值為8192，既有快照保持缺欄，不回填歷史。

高於8192只允許主skill module-authoring，manifest與新快照都須明示；有效快照值不得超過有效主manifest值，兩側各自先處理缺值再比較。輔助skill不能提高預算。本次module主manifest明示16384，其他skill不變；模型／推理強度／請求8次／工具12次／180000ms不變。這是使用者授權的G6政策修訂，取代先前本輪「8192與預算不變」限制；retry本身不能自行增加預算。

新retry取最新合法manifest快照，舊Run payload與證據不可修改。manifest.version仍1，以manifestSha256綁定bytes修訂；hash不符仍fail closed，不得以8192 fallback繞過pin。Server／Manager／Worker同步支援後才啟用新manifest，切換前排空工作並保留舊包。本次不增API／DB migration／診斷schema，不加入自動升額或模型重試。


### 有界 Module 候選切片（registry 10.3）

新增worker/candidate工具 `stage_module_candidate_part`：精確required `{part:"script"|"harness",content:string,stagingRevision:integer>=0}`，無未知欄位。content非空、raw UTF-8最多8192 bytes，input JSON<=65536、output<=2048、工具1000ms且受Run剩餘deadline。stagingRevision是attempt-local CAS，初0，每成功接受一段加1；不等於DB revision。結果 `{staged:true,revision,part,contentHash}`，hash為該content原始UTF-8 SHA256。只保留兩段最新內容，尚非自試或可套用草稿；拒絕過期revision、機密、超限／非法型別時不改狀態。

新增 `commit_module_candidate`：精確required `{stagingRevision:integer>=1,metadata:{slug,moduleKind,exportName,signature,inputs,returns,preconditions,postconditions}}`。metadata沿原Module schema但不含harness，完整metadata JSON<=4096、commit input<=8192、output<=131072。兩段均須在本attempt成功暫存，revision須相符；commit不遞增stagingRevision。Worker以兩段＋metadata組完整候選，沿原validateModule、權威slug、機密與scope守衛、真verifyDraft；工具120000ms仍受整個Run 180000ms剩餘deadline。成功才替換moduleCheckpoint；失敗／取消不得覆蓋上一份通過候選。結果沿 `{candidate,selfTestPassed,error?}`；request_module_validation保持獨立。

舊update_module_candidate留在registry供舊快照／完整schema驗型；新module manifest改提供stage＋commit。Server／Manager／Worker候選能力與final守衛接受commit作為update的等價授權，但仍限主module-authoring與原scope、自試、hash、revision／context、完整artifact驗證。stage本身不具final候選提交權。只接受明確新registry/manifest快照；舊pin仍不得降級或替換。

本切片無DB staging／migration、跨Run partial或自動續接；結束／新Run清空暫存，半份工具args從不執行。預算8模型／12工具／180秒／16384保持。超過每段大小要拆Module，不自動增加上限。每段是否通過不代表M10或正式validation通過。

### M109 timeout觀測接線

沿既有default-off M109 gate掛既有AuthorObservation。Manager僅在author且gate on轉送 `author:observe:<1..8>:<event>`；event精確限observation.ts既有17個enum，未知／前後綴／自由文字拒絕。沿原log event／attempt驗證保存，不改sidecar v3或公開Run wire；Server安全投影只收固定grammar與時間。歷史未記錄的headers/body位置仍UNKNOWN，不回填。非成功HTTP body.cancel也受原Run signal約束；此清理修補獨立驗證，不宣稱是retry4原因。
