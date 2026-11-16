# M12.1 Wave1：Worker 引擎接縫

狀態：2026-11-16 Wave1 已實作。本節固定 Runtime 內部接縫與後端設定；**沒有升級 HTTP／WS protocol_version、修改 Run dispatch 或放寬 v10 author.json**。Workspace／skill 的 engine、provider 快照屬 M12.2；受控continue的跨Run資源總額見下方Wave4，不能由Wave1推定完成。

## 後端選擇

| 環境設定 | 規則 |
| --- | --- |
| `WHIPPET_AI_ENGINE` | `builtin`（缺值預設）或 `vercel`；未知值拒絕，不 fallback |
| `WHIPPET_AI_PROVIDER` | `opencode`（預設）或 `openai-responses` |
| `WHIPPET_AI_BASE_URL`／`WHIPPET_AI_MODEL` | HTTPS base URL／單一模型ID；opencode沿用原預設，其他provider必填；不從SDK catalog或環境自動探索 |
| `OPENCODE_API_KEY` | 只供opencode使用 |
| `WHIPPET_AI_API_KEY` | 只供顯式openai-responses使用；缺值不借用OPENCODE_API_KEY |
| `WHIPPET_AI_CONTEXT_WINDOW_TOKENS` | 未知模型／非已核endpoint使用Vercel時必填；正整數1024..2097152。已知Muse profile只適用精確OpenCode Responses base URL，允許降低、不允許超過官方容量 |
| `WHIPPET_AI_CONTEXT_INPUT_TOKENS` | 保守輸入估算上限，缺值65536；正整數1024..context window，不代表模型實際tokenizer |

reasoning effort仍使用原設定與skill快照，模型／effort／output cap不由adapter改選。Manager只對author容器傳上述白名單名稱與既有AI設定，不把值寫入input.json／journal／docker arguments；一般run不繼承AI設定或key。沒有自動provider重試、模型切換或payg fallback。現有Server派工仍以原skill快照為權威，provider/model不匹配即拒絕；此Wave不提供UI切換。

## AgentEngine

- `beforeRequest(context)`維持原context陣列介面。
- 新增`prepareRequest(body)`，接收完整序列化Responses body，回傳完成noSecret／secrets.clean後的body。builtin支援此選填鉤子；正式Vercel adapter要求存在，由runAuthor提供。執行順序為SDK序列化→固定模型／工具／預算→context準備與安全壓縮→final guard→容量／bytes檢查→既有request傳輸。
- 工具只來自同一份registry。schema／單次限額與guard dispatch仍由Whippet驗證；無SDK內建fs、shell、eval、fetch工具。SDK使用dummy key，其fetch接縫委派既有request；實際key、TLS、session header、heartbeat與noSecret仍在既有傳輸內。
- builtin與Vercel共用output cap驗證、三回合Test／Planner與五回合Module收尾保留、partial文字規則。總模型／工具／時間額度不變；Vercel retries=0、工具依序執行、重複call ID零重做。
- SDK文字答案不能覆蓋`pendingWork()`。在既定總請求尚有餘額時，附上guard尚未完成的工作繼續；耗盡則partial。guard確認交付後立即結束。

## 容量與壓縮

- 已核實OpenCode公開metadata：Muse Spark 1.3 Contributor context=1048576、output capability=131072；**Run output仍為原8192，Module依原快照最多16384**。capability來源與SHA見本Wave安全證據。
- text-only估算為serialized input／instructions／tools的UTF-8 bytes，加512 framing allowance。另保留Run output與1024 safety tokens；可用input取模型剩餘容量與後端input cap的較小值。此為保守預檢，不宣稱精確token計數，也不支援原生image／file輸入的容量估算。
- 達80%門檻才嘗試壓縮。保留全部初始對話、目前草稿／Stage、原始限制、決策與證據；Wave8僅允許已凍結的原始script／harness改用可精確取回的引用。保留所有call/result ID／順序及provider reasoning；最新一份工具結果保留全文。
- Wave1只壓縮可由**當前提供工具**取回的`catalog_get(moduleVersionId)`成功結果及`read_skill_reference(skillId,referenceId)`。必須與回傳固定ID相符；原文仍在Server不可變版本／打包且hash固定的reference。summary保留身分、metadata、原文hash與精確read-back args，標明DATA與非驗證證據。Wave6另加入同Run凍結history頁及剩餘取回額度檢查，見下節。不得將draft／report／Plan／未知結果改成不可取回摘要；G5舊snapshot修剪照舊。
- 不執行隱藏取回、不消耗額外模型請求；模型若需原文，走既有工具及同一預算。壓縮後仍超界則停止；不提高上限或默刪受保護資料。

## partial與觀測

- 引擎內部新增`context_capacity`／`output_truncated`原因。Worker輸出仍使用既有`partial.reason=budget_exhausted`，message／nextStep如實說明容量或截斷，不能誤稱8次請求都已用完。
- checkpoint始終從Worker guard重建。截斷保留固定`INCOMPLETE_MAX_OUTPUT_TOKENS`分類，未執行半份args；有可信checkpoint才回partial，否則安全失敗。容量預檢可以在零HTTP時回未完成結果。保留guard原有的剩餘工作文字，不以引擎自報稿取代。
- Module／Planner／summary既有partial限制不變；沒有新增跨Run Module checkpoint，也沒有排入隱式continue或正式validation。
- Manager額外接受`author:context:compacted:N`，N僅1..12，不含內容、雜湊、路徑或機密；其他自由文字仍拒絕。取消沿用AbortSignal與Manager回收後才釋放slot，不宣稱能終止供應商遠端計費。

## M12.1 Wave6：雙引擎容量與凍結對話索引

2026-11-16，Worker內部策略擴充；不改HTTP／WS、tool registry、skill pins或runtime digest。

- `runAuthor`把既有runtime／後端設定的已知或顯式capacity傳給builtin；兩引擎採相同UTF-8保守估算、80%壓縮門檻、input cap及output／safety保留。最後整份機密guard之後再檢查容量。未知capacity的舊builtin profile仍走原bytes保護，不臆測模型能力；Vercel仍必須提供可驗證capacity。
- `read_conversation_history`成功結果必須符合原有六項／8KiB及UTF-8分頁驗證，且引擎持有本Run不可變`history.maxSequence`，才可替換較舊頁。初頁精確`"null"`轉成JSON null，其餘cursor保持原值；未提供history工具／pin、錯誤結果或非法分頁一律不壓縮。
- 替換內容是**凍結原文的索引**：maxSequence、各fragment的sequence／role／offsetBytes／lengthBytes／hasMoreContent、nextCursor、遮蔽後原回應SHA256及精確取回參數。標示DATA／非驗證證據，不把原對話提升為指令，也不宣稱已產生保留所有語意的摘要。
- 每次序列化都從引擎保留的原始結果重新評估；不改Server原文或永久丟棄Worker原資料。全部初始對話、saved snapshot中的目標／限制／決策／revision／Stage／證據、目前草稿、call/result配對、reasoning與最新一份工具結果保留全文。
- 所有可壓縮資料（含Catalog與skill reference）的不同取回引用數，不得超過本Run剩餘tool calls；history另受剩餘四次讀取額度限制，失敗讀取也計數。同一凍結引用重複出現只需保留一個取回額度。這是可取回條件，沒有額外保留或提高工具預算；是否重讀仍由模型在原預算內決定。
- 額度耗盡、交付階段不再提供取回工具或壓縮後仍超量時，保留原資料並以`context_capacity`停止；不得留下無法重讀的索引、隱藏取回或自動重送。可在零HTTP時輸出既有未完成結果，usage不虛報模型／工具用量。

本切片完成有界history壓縮→精確重讀的雙引擎合成驗證；不等同任意長對話語意摘要、超大Stage拆解續接或真模型成功率驗收。M12.1一般大任務、金額計價及正式比較仍待辦；預設builtin、模型／effort與8／12／180000／8192（Module原16384）不變。

## M12.1 Wave7：截斷收尾修復

2026-11-16修復builtin在`status=incomplete`且`incomplete_details.reason=max_output_tokens`時一律丟`invalid_response`的缺口。兩引擎現在共用固定回應分類；只有沒有provider error且Worker guard仍持有通過自試的checkpoint時，才回內部`output_truncated` partial。provider error、content_filter、未知incomplete或其他無效回應仍失敗；取消優先，不轉partial、不自動重試。

整份incomplete output都不執行，即使其中有完整JSON工具前綴亦同。最後通過的候選、剩餘nextStep與證據引用從原guard取得，不採信模型或失敗修復稿；機密守衛使候選失效時，最終輸出不得附script／checkpoint。外部MCP參考客戶端沒有可信自試checkpoint，仍停止，不新增外部partial權限。

Worker wire仍沿用`partial.reason=budget_exhausted`與原usage receipt，message／nextStep明確說明截斷，模型／工具用量計入實際已送出的截斷請求及已執行的工具；不提高output cap或跨Run總額。legacy／Module／Planner／summary的原partial門檻不變，沒有自動continue／validation。未改registry／skill pins、HTTP／WS或runtime digest。

## M12.1 Wave8：凍結原稿引用（registry 12.0）

新增`read_author_snapshot`（worker/read）：精確required `{component:"script"|"harness",sha256:string,offsetBytes:integer|null}`，無未知欄位；sha256必須是本任務凍結原文的64位小寫hex，數字offset為0..2097152。每次1000ms、arguments最多16384 bytes、result沿原read_draft的13MiB上限；不新增HTTP／WS欄位、DB migration、runtime digest或模型／預算設定。

- 來源只限本Run排隊時的script_snapshot與author_payload的Module harness。Worker在進入模型前凍結已遮蔽資料，原provider key守衛仍先檢查整份來源。script仍受原2MiB上限，Module script／harness仍受原8KiB候選規則；這不是可變草稿或暫存候選的編輯介面。
- offsetBytes=0讀第一頁，後續使用回傳的nextOffsetBytes；每頁最多8192原文UTF-8 bytes，不切斷code point。null明確讀全文，僅在全文可放進context時使用。EOF位移可回空頁；超界、非UTF-8起點、錯hash／component／角色均拒絕，不改讀其他資料。沒有path、URL、任意檔案或模型設定參數。
- 回應精確為`{component,sha256,baseRevision,totalBytes,offsetBytes,content,nextOffsetBytes}`；SHA是整份凍結原文，offset／total／next以原文字節計。全文回應offset=0、next=null。新學到的機密會使受影響的凍結讀取停止，不換hash或回傳與原hash不符的遮蔽片段。
- 已釘選的test-author／module-authoring新增此工具，主manifest version仍1，以新manifestSha256／主skill SHA固定bytes。Server在新排隊快照納入工具，continue仍受來源AllowedTools上限限制；Manager與Worker拒絕legacy或其他主skill使用新權限。
- 已知capacity的雙引擎在80%門檻以上，僅對精確的第一份saved snapshot建立傳輸副本，可將大於2048 bytes的script／harness換成`{dataOnly:true,validationEvidence:false,snapshotRef:{component,sha256,totalBytes,baseRevision},retrieve:{tool,arguments},readPage:{tool,arguments}}`。retrieve以null讀全文，readPage從0分頁。原始資料仍在Server／Worker，目標、限制、對話、Stage args／Module契約、revision及證據保留全文。
- 每個不同取回引用佔用既有剩餘tool-call條件，與Catalog／history／reference共同計算；舊snapshot工具結果須與凍結來源逐欄相符才可縮成精確分頁引用，最新結果保留全文。工具不可用、額度不足或仍超容量時，以原資料預檢並停止，不留下無法取回的替代、隱藏取回或自動重送。每次序列化最多12份替換，沿用原安全progress範圍。
- 原稿讀取在交付保留區間仍可提供，以取得必要原始事實；其他探索規則不變。原8／12／180000／8192及Module16384不變，讀取也計工具用量，不新增額度。原稿引用不是驗證證據，不改候選自試、CAS、發佈或partial門檻。

MCP只經原task_tool_call呼叫此工具，沿Token／Workspace／Run／attempt／lease、速率、預算與callId規則；Server讀Run快照，不讀目前Draft。普通Test參考客戶端共用相同引用／分頁策略，仍使用操作者模型設定，不套用task.runtime，不承接其他skill或輸出可信partial。未新增公開互動MCP工具，保留19個控制／互動入口。

registry12.0與兩份skill新bytes需由Server／Manager／Worker／參考客戶端使用一致打包版本；舊Run pins不回填、不換digest、不自動轉換。固定基準未部署。此切片通過雙引擎有界原稿／Module Stage與真MCP合成流程；任意大產物編輯、Stage拆解續接、語意摘要及金額總額仍未完成。

## M12.2 Wave2：控制面 runtime 快照

2026-11-16 後端切片已實作，UI於同日Wave3完成（見下節）。沿用 WSS envelope protocolVersion=1，author_payload／Worker input 新增選填 `runtime`；沒有修改 author.json、工具 registry 或 skill 套件。

### 設定入口與優先序

- Migration 026 新增 `workspaces.agent_runtime`，預設 `{"profileId":"builtin","skillProfiles":{}}`。與 M11 `authorEngine=builtin|external` 的接單路由分開；`runtime.engine=builtin|vercel` 是 Worker 內的模型迴圈。
- `GET /api/workspaces/{id}/agent-runtime` 回 `workspaceId`、Workspace `revision`、`selection` 與可選 `profiles`。公開 profile 描述包含 id／engine／provider／model／reasoningEffort，不含 endpoint 或金鑰。內建 builtin／vercel 的 provider／model／effort 空字串表示沿用主 skill。
- `PATCH` 同一路徑，只接受 `revision`、`profileId`、`skillProfiles` 三個欄位；完整取代選擇，未設定 skill 繼承 Workspace profile。只允許五個主 skill ID，禁止輔助 skill 覆寫、未知 ID、重複 JSON key、null map、任意 endpoint／model／key。沿用既有管理 gate 與 Workspace revision CAS；不同選擇才增加 revision，舊 revision 衝突，不影響網站授權 revision。

```json
{"revision":1,"profileId":"builtin","skillProfiles":{"test-author":"vercel"}}
```

優先序：來源 Run 的受控 continue 快照 → Workspace 對主 skill 的 profile 覆寫 → Workspace profile → migration 的 builtin 預設。主 skill 固定工具／預算／套件模型預設；自訂 profile 可明確覆寫有效 provider／model／effort，但不得覆寫工具或預算。Server 不用 `WHIPPET_AI_ENGINE` 默改 Workspace 預設。

### 後端 profile 白名單

保留 `builtin`、`vercel` 兩個 ID；兩者從主 skill 取 provider／model／effort，從 Server 的 `WHIPPET_AI_BASE_URL` 與 capacity 設定取非機密設定；缺值沿用既有 OpenCode endpoint／Muse capacity／65536 input cap。未知模型或 endpoint 使用 Vercel 必須明訂 capacity。builtin 未知 capacity 可為 0，以保留舊迴圈行為，不能據此宣稱有容量預檢。

Server 可用 `WHIPPET_AI_RUNTIME_PROFILES_JSON` 明訂最多 16 個額外 profile（JSON 最多 64KiB）。每項完整提供以下非機密欄位，不接受 secret／key reference 或任意擴充欄位；這個設定不傳進 Worker：

```json
[{"id":"alternate","engine":"vercel","provider":"openai-responses","baseURL":"https://provider.example/v1","model":"configured-model","reasoningEffort":"high","contextWindowTokens":131072,"contextInputTokens":32768}]
```

此為合成測試設定示例，未部署或切換實際模型。provider 僅支援 `opencode`／`openai-responses`，分別從 Worker 的 `OPENCODE_API_KEY`／`WHIPPET_AI_API_KEY` 固定機密設定取值，缺值停止且不互借。endpoint 必須 HTTPS、ASCII、有效 port，禁止 userinfo／query／fragment／尾斜線／`/responses` 後綴。window 1024..2097152，input 1024..window；精確 OpenCode Muse profile 不得超過已核 1048576。effort 限 low／medium／high／xhigh。對外 provider 的實際相容性須另做授權測試，合成成功不代表第二供應商真驗收。

### 不可變快照與執行

Server 在排隊交易內鎖定 Workspace 設定，將 `runtime` 寫入每筆新 author Run。欄位依下列順序組成 JSON，UTF-8、無空白、不做 HTML escape；`sha256` 是前九欄的 SHA256，小寫 hex。完整範例與三端 golden digest 見 [測資](testdata/agent-runtime.json)。

```text
schemaVersion=1, profileId, engine, provider, baseURL, model,
reasoningEffort, contextWindowTokens, contextInputTokens, sha256
```

三端拒絕畸形欄位／hash 漂移；Manager 額外拒絕重複欄位與 null，原樣轉送非機密快照。hash 是完整性檢查，不是簽章或授權。Worker 先校驗既有 skill bundle，再用 runtime 決定有效設定；`author.model` 保留原打包預設供套件完整性驗證，不再是有 runtime 時的執行設定。

排隊後變更 Workspace、profile 宣告或非機密模型環境設定，不重建派工／重播的 runtime。Worker 在解析環境前套用 runtime，畸形的後續模型／effort／engine／capacity 環境值也不能覆寫快照。enable 與金鑰仍取目前後端，保留停用與輪替能力；金鑰不進 input、journal、profile、產物或模型 context，final guard 也檢查未選中供應商的 key。

Test partial 的「繼續」沿用來源 runtime，保持既有回收、scope／revision／context CAS 與重送冪等；新建獨立 Run／Stage retry 依當時設定建立新快照。原 runtime／預算不回寫。Wave2沒有實作continuation鏈總額；Wave4已補受控continue的共用資源額度，規則見下節。

### 相容性與驗證範圍

缺少 runtime 的歷史 Run 沿用 Wave1 的後端環境與主 skill 模型匹配規則，不回填歷史資料。帶 runtime 必須同時具有完整 v10 capability snapshot；舊 Manager／Worker 會拒絕未知欄位，部署須協同更新三端，不能依 envelope version=1 推定可混用。此候選沒有部署到兩個固定基準。

Wave2只驗證 CAS→快照→派工／受控 continue，以及兩引擎的合成 Responses 接縫；沒有新增付費模型 Run、重跑黃金全套或修改歷史 raw。UI設定由Wave3完成，受控continue資源總額由Wave4完成；金額計價、一般長對話／超大Stage、第二 provider 真測及 M12.3／M12.4／M12.Z 仍待辦。

## M12.2 Wave3：Workspace runtime 設定 UI

入口為「Workspace 設定 → 正式設定與能力 → Agent runtime 設定」。沿用登入管理gate與既有API client，GET載入公開profile／revision／selection，PATCH只送`revision`、`profileId`、`skillProfiles`。主skill的繼承選項會移除對應map項目；覆寫只接受後端提供的profile ID，沒有endpoint、金鑰、自訂model／effort／capacity欄位。內建profile的空白provider／model／effort顯示「沿用主skill」，每個skill顯示有效profile與模型迴圈。

409時保留未儲存選擇並GET最新設定，顯示目前設定供比對，使用者可採用目前設定或保留選擇繼續編輯；後者仍須另按儲存，沒有自動PATCH。其他儲存錯誤也先重讀確認，不直接重送；最新讀取失敗時阻擋兩個決策與儲存，提供重新載入。錯誤聚焦到提示區，避免表單底部操作後看不到回饋。

已保存但不在目前白名單中的profile仍原樣顯示為「目前不可用」，保留disabled選項並阻擋儲存，直到使用者明確修正所有失效選擇；不靜默fallback。UI明訂此設定與M11接單模式不同，僅影響新任務，既有Run與受控繼續沿用原runtime。未擴張預算，也未改動authorEngine路由。

## M12.1 Wave4：受控 continue 鏈的共用資源額度

Migration 027新增`author_chain_budgets`，新`test-author` Run排隊時在同一交易保存根Run ID、ordinal=1、maxRuns=3、首筆budget及spentBefore=0。每筆分配不可更新／刪除，`(root_run_id,ordinal)`唯一；不回填歷史Run。這是`POST /api/runs/{id}/continue`的鏈界限，不是Workspace／帳號／Plan所有獨立任務的金額配額。

整鏈最多三筆Run（含首筆），模型請求、工具執行與作者迴圈毫秒總量共用首筆budget，**不是每筆重給8／12／180000，更不是放大三倍**。每次模型輸出上限仍不高於首筆有效上限（缺值8192），runtime仍沿來源快照。僅減少新Run的budget與timeout，不回寫原快照、變更skill／registry或提高既定額度。

Worker為受控test-author partial新增可選的可信欄位：

```json
{"usage":{"modelRequests":3,"toolCalls":12,"durationMs":250}}
```

此欄位位於`author.json.partial`內，由`runAuthor`守衛建立。模型請求在傳輸邊界扣抵（含合法的收尾請求），工具在執行入口扣抵（含失敗的嘗試），不信任引擎事件、引擎自報序號或模型輸出的usage。作者迴圈以單調時鐘記錄至少1毫秒；排隊、人工等待與容器啟動不列入此迴圈時間。每筆仍受既有Worker／Manager逾時與回收規則約束。

Server及Manager各自拒絕null、重複／未知／缺欄、負數、非整數與超過本Run分配的receipt；Server在套用候選前驗證。模型、MCP外部作者與UI不能提交可信receipt。歷史無receipt的partial仍可讀取／保存；若新鏈中某筆缺receipt，保守扣完該筆全部分配。沒有鏈policy的歷史Run不補造額度，明確拒絕新續接。

續接沿既有test鎖、source鎖、目前草稿revision／context／scope及已回收檢查。相同source／session／revision先回既有Run，不重複扣抵；不同body仍409。第一次建立子Run時，依不可變的spentBefore加上來源receipt計算餘額，再與目前skill上限取較小值，原子保存子Run、其鏈分配、對話與唯一source關聯。總嘗試、模型或迴圈時間耗盡回409 `continuation_budget_exhausted`；缺乏可信policy／用量則回409 `continuation_usage_unavailable`。拒絕不能新增Run、訊息或推進context CAS。工具餘額可為0，後續Run不能重新取得工具名額。

本波只提供固定runtime／每次輸出上限下的請求、工具與迴圈時間界限，不計算供應商帳單金額、實際token價格或取消後遠端計費，也不將新獨立任務／Stage retry併為同一鏈。新的partial欄位需Server／Manager／Worker一起升級；舊接收端會拒絕，沒有移除receipt的降級fallback。兩個固定基準未部署本候選。

## M12.3 Wave5：普通 Test MCP 參考 Worker

`runtimes/agent-bridge`是repo內可執行的單次接單客戶端，共用Worker鎖定的Vercel adapter及打包registry／skills，不新增MCP工具、Server schema或WS欄位。只支援`test-author`；其他主skill明確停止。模型工具只能是claim.allowedTools與本地pin一致的可接線子集，所有呼叫由客戶端固定runId／attemptId／leaseId並配新UUID callId，經原`task_tool_call`送出；MCP控制工具、DB／Manager、fs／shell及發佈均不暴露給模型。

主skill、manifest、registry及external reference均校驗pin；主檔與reference從MCP讀取後另核SHA。操作者明訂的provider／model／effort／HTTPS模型入口與key用既有固定機密欄位載入，不由task.runtime或頁面更換。此客戶端明確選Vercel，不修改平台builtin預設或M11 authorEngine路由。

每個journal最多一筆任務。claim前原子保存requestId，submit前保存完整`{runId,attemptId,leaseId,submitId,output}`並fsync；同journal禁止並行。submit回應不明／busy後，操作者重啟同state只重送同一ID及內容，不重新領單或執行模型／工具。工作階段被中斷則停止於claimed，不自動重跑；不明工具結果不換callId或自動重試。已完成journal只回保存結果，不代表最新Server或正式驗證狀態。

執行依claim固定budget及原硬期限，30秒心跳；控制與工具MCP請求起點至少間隔1秒，以符合原burst10／每秒補1限流。429保留原狀態並回`rate_limited`，沒有隱式重送。HTTP僅literal loopback，其餘HTTPS；不跟redirect或自動切Server。Token、目前及未選中provider key禁止出現在模型body、MCP參數、回應資料或候選；journal 0600、父目錄0700，token同樣驗本人／regular／單硬連結與權限。

final僅接受既有普通Test輸出欄位，拒絕partial、自報proof／validated、未知或重複key。提交仍是未自試AI候選，requestValidation僅請求獨立正式Run，無發佈路徑。本波真MCP＋暫存DB流程使用合成模型回應，沒有新增付費模型呼叫、正式驗證或黃金比較；完整真模型／Docker／其他skill驗收不由本節推定完成。
