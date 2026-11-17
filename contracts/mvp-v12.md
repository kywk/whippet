# M12.1 Wave1：Worker 引擎接縫

最新增量：Wave9 的有界 Stage 拆分與續接見文末；不改既有原始收據或 Run pins。

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

## M12.1 Wave9：有界 Stage 拆分與保留進度續接

2026-11-16。新增 migration 028、人工管理操作與設定 UI；沒有新增 Agent 工具或改 HTTP／WS envelope、runtime digest、Worker artifact、registry、skill 或模型依賴。需先套用 migration 028 的候選 Server；固定基準未部署。

### 人工拆分與交易

`POST /api/plans/{id}/stages/{stageId}/split` 只收 `{planRevision,confirmed:true,stages:[child1,child2]}`，回 `{plan:Plan}`。沿既有管理 gate；MCP 不提供此操作。JSON 上限 64KiB，未知／重複／null 必填欄位拒絕，子段只收既有 PlanStageInput，不能提交執行狀態、模型、runtime 或 budget。

僅支援 draft／confirmed Plan 中未嘗試、pending 的 create Stage。Plan／Use Case revision 與 context 必須一致；沒有執行中或未回收的相關 Run。confirmed Plan 的前段必須 ready 且原候選／正式驗證／revision／context／hash／回收仍有效；draft 的前段可以尚未執行。後段必須 pending。running／stopped／取消後 Plan、modify／reuse、已有 author 或 candidate、拆分子段均拒絕，不將失敗重試包裝為新拆分。

每次固定拆為兩個 create 子段，moduleKind 不變、ID／slug 唯一、總 Stage 數仍最多32；slug 不能占用同 Workspace 的既有 Module。最後一段保留原 Stage ID 與 bind，後段原 binding 不改。以完整 Plan 校驗 args／binding；原目標、完整原 Stage 描述與 args 留在不可變來源，語意是否等價仍須人工確認與原驗證門檻。

交易保留其他 Stage 的 status／Run／candidate／validation IDs，僅替換來源 Stage；增加 Plan revision 與 Use Case context revision，清除執行邊界及舊摘要。拆分本身不排 author、validation 或 publish。新子段仍走既有 confirm／throughStageId，逐段作者→自試候選→正式驗證→回收後才往下；整體仍須 Compose／正式驗證／人工整批發佈。

`plan_stage_splits` 保存原請求、來源、policy 與歷史結果；相同 Plan revision／stage／body 重送回原結果，不再建立子段。不同 body 或 stale CAS 回衝突。UI 在操作後重新 GET，目前狀態不由歷史 receipt 推斷；衝突保留輸入及原 CAS，不自動重送。

### 不增加額度的分配

拆分時固定 module-authoring 當時的首筆 skill policy／pins／runtime，將原模型請求／工具／作者時間總額均分；餘數依子段順序分配，單次 output cap 維持原值。原8／12／180000分成各4／6／90000，Module output仍16384。這是保留原上限的預先分配，不是增加新 Run 預算或依模型自報用量找回餘額。

代表 Worker 流程每段需3次請求執行 script／harness 暫存與完整 commit，因此本波限兩段；三段會讓一段僅剩2次請求，不能以提高原預算解決。若來源 policy 不足每段3次請求／3次工具，拒絕分配。沒有其他供應商計價或 SDK 額度推測。

派工先核對現有 skill／registry 與凍結 policy 一致，再套用子段 budget 及原 runtime；pins 漂移停止。`plan_stage_split_runs` 同交易保存每個子段唯一 Run 分配，不能更新、刪除或重複排入。未用完額度不移轉，失敗／取消不補回。拆分 Plan 禁止以整份 SavePlan／planner 覆寫清除分配，拆分子段的既有 retry 查詢回 `split_budget_reserved`。這個限制顯示於 UI；需要重規劃時先停止並明確開始新的編輯週期，不隱式建立續接鏈。

### 當前 Stage 背景與保真

各子 Run 保留完整來源 Stage DATA，並帶入當前 args、直接 binding、父 Stage 原 args 所引用的上游固定 Module 契約及緊鄰前段契約。上游契約仍只能來自同 Plan 已驗候選或已發佈固定版，不含其他 Module 原始碼／harness，不查最新版。父 binding 不能因拆成後段而失去其來源 version／candidate 引用。

沿用 Stage context15000字元、整份對話32000字元與最多12則限制；超限停止，不截斷原目標或擴大容量。分頁原稿工具、自試、scope、完整候選 parser、正式驗證與發佈規則不變。

### 本波範圍與證據

已驗證：保留已完成候選前段→拆分→兩段各自驗證與暫停→Compose；驗證失敗停止；併發／重送／CAS／注入拒絕／不可變額度；兩正式 Worker 引擎各在4／6／90000內完成合成流程；真候選 API 的 UI 儲存／重讀與409保留編輯。模型與自試為合成，不能當作付費模型、真 Playwright 或階段全套驗收。見 [Wave9交接](../docs/tracking/handoff/m12-wave9-20261116.md)。

本波不實作自動語意拆解、失敗 Stage 的自動恢復、Module 跨 Run checkpoint、任意大候選分段編輯或一般長對話語意摘要。金額計價與跨獨立任務／Stage retry／整個 Plan／帳號的共用配額移至後續里程碑；M12 保留受控 continue 與拆分群組的原固定資源上限，既有獨立任務不被聲稱為全平台總額控制。

## M12.1 Wave10：有界結構化對話記憶（registry 13.0）

2026-11-17。新增 Worker 內部 `record_conversation_memory`，由同一次作者迴圈的模型在已讀凍結歷史中選取完整原句，分類為 `goal`、`constraint`、`decision`、`progress`、`evidence`。這是可核對來源的摘錄，不是自由改寫摘要，也沒有額外摘要模型請求或自動讀取。Server／Manager／Worker 必須一起打包新的 registry、四主 skill 的內容與 pins；歷史 Run 不重釘、不改 digest。沒有 DB migration、HTTP／WS／artifact 欄位變更，預設仍 builtin，固定基準未部署候選。

### 能力與輸入

只有完整 capability 快照、凍結 `history.maxSequence`、`read_conversation_history` 權限與可用 history client 同時存在時才開工具。適用 test-author、workspace-author、module-authoring、usecase-planner；摘要 skill、legacy 與 MCP 接單工具皆不開放。Server 不接受 caller 自行加入此權限；Manager 重新核對 registry 與 history gate。MCP 參考 Worker 維持原工具子集。

工具只接受 `{facts:[{category,sequence,offsetBytes,text}]}`，每次1–12項，未知／缺欄拒絕。`sequence` 是既有十進位字串，`offsetBytes` 是訊息原文的 UTF-8 byte 位置；每項原文非空且最多512 bytes。模型不能提交來源 role、hash、scope、revision 或證據權威。Worker 逐項對照本 Run 已成功讀取且未經遮蔽改寫的頁面，拒絕未讀、超出 pin、改寫、錯誤位移或僅截取否定句一部分的內容。摘錄必須從訊息起點或句界開始，並在句界或完整訊息結尾停止；這是句界與原文一致性檢查，不能證明所有語意都已涵蓋。

`goal`／`constraint`／`decision` 必須來自 user；assistant 的進度與證據引用仍標示 assistant，不能變成使用者確認或正式驗證。每次成功記錄合併既有事實，不允許後次呼叫刪除；同一事實重送不新增，單次重複與累計超過12項拒絕，原記憶保留。

### 保存與壓縮

Worker 以既有 `conversationSummary` 字串保存最多8192 UTF-8 bytes 的 JSON：`schemaVersion:1`、`kind:"whippet-conversation-memory"`、`dataOnly:true`、`validationEvidence:false`，以及實際 conversation／base revision／context revision／Stage、凍結 maxSequence、分類摘錄及來源頁。每個來源保留原 cursor、模型所見 `{items,nextCursor}` 原回應 SHA256、fragment 位置／長度、完整 user fragments 及 nextCursor。`coverage:"listed-pages-only"` 表示最後一次成功記錄時所列頁面；後來新讀的頁面不隱式更新已存摘要，需要原預算內再記錄。

當前 Run 的壓縮副本在舊 history 結果加入已核對的分類摘錄與該頁完整 user fragments，即使模型未選取某條限制也保留。當前訊息、scope、revision、Stage、證據與最新完整工具結果沿原保護規則；工具 call/result、provider reasoning 項目不刪除。所有引用仍具原 cursor／hash，讀回消耗原工具與 history 額度；最新完整結果若與舊引用的指標及 bytes 完全相同，無須重複預留未來讀取，其他不同引用仍各自計數。

每次記錄、壓縮使用與輸出前都重新套用既有機密守衛，新增辨識的秘密不能透過衍生摘要重現。遮蔽後 bytes 已變的歷史頁不作為記憶來源，避免錯誤宣稱原文 byte 位移／hash；既有歷史讀取功能仍可使用。若完整 user fragments 或記憶超量，拒絕記錄／停止容量流程，不裁掉限制來通過。

### 預算、信任與範圍

記錄工具照原工具執行入口扣額，包括失敗嘗試。history 每 attempt 最多4次、原每頁6片段／8192 bytes、總8模型／12工具／180000ms與單次 output 上限不變；受控 continue 或拆分 Run 仍用其已減少的分配，沒有額外呼叫、重試或補額。取消不回傳摘要 artifact 或執行後續候選。

下次 Run 只收到既有背景 DATA 字串；目前 scope／revision／Stage 與正式證據優先。既有摘要字串不自動匯入本 Run 的已核對來源集合，若要再次建立來源摘錄需明確重讀。此切片不涵蓋任意長對話全量語意、跨 Run 自動合併、任意大候選編輯或 Module checkpoint。一般 Test 的真 Server／Postgres→Worker→保存→下輪原文讀回、兩引擎合成模型流程與拒絕案例見 [Wave10交接](../docs/tracking/handoff/m12-wave10-20261117.md)。

## M12.1 Wave11：獨立 Module checkpoint／人工續接（registry 14.0）

2026-11-17。本節覆蓋 v10「Module 不提供 partial」的**獨立 Module**例外；Plan Stage 維持原規則。沿用 migration027 的不可變共用額度表、既有 `author_partial` 與 continue 管理端點，沒有新 migration 或自動續接。Server／Manager／Worker／Web 及打包 registry／skill pins 須同步升級；舊接收端會拒絕新欄位，不移除 partial／hash 降級。固定基準未部署。

### 明確保存完整候選

`commit_module_candidate` 新增選填 `nextStep:string`，非空、最多2048 UTF-8 bytes；未知欄位／null／空白仍拒絕，整份輸入8192 bytes、metadata4096 JSON bytes不變。供應商表示沿既有 non-strict schema，Worker 仍以原本完整 schema 驗證。只有完整能力快照、`module-authoring`、`platform.planId=null`、`stageId=null` 且可使用 commit 工具的 Run 能提供 nextStep；Plan Stage 提供時在自試前拒絕。

兩份完整暫存仍各最多8192 bytes、attempt-local；commit 組裝本體／metadata／harness，通過原 schema、slug、scope、機密守衛與自我試跑後，才以守衛閉包保存候選。有 nextStep 時完成鉤子直接結束本輪，保存未完成候選並等待人工續接，不額外要求模型產生 final 或排正式驗證。省略 nextStep 的成功 commit 沿原完成流程，仍只在具權限時要求回收後正式驗證。

新增 Module artifact 形狀（既有 message／script／module／conversationSummary 上限不變，總量仍25MiB）：

```json
{
  "message":"候選已保存，仍有剩餘工作",
  "script":"完整 Module 本體",
  "module":{"slug":"...","moduleKind":"step","exportName":"run","signature":"...","inputs":"...","returns":"...","preconditions":"...","postconditions":"...","harness":"完整驗證腳本"},
  "requestValidation":false,
  "partial":{
    "reason":"checkpoint_saved",
    "nextStep":"完成剩餘斷言",
    "checkpoint":{"scriptHash":"64位lowercase SHA256","moduleHash":"64位lowercase SHA256","selfTestPassed":true},
    "usage":{"modelRequests":3,"toolCalls":3,"durationMs":1}
  }
}
```

`scriptHash` 是本體原始 UTF-8 SHA256。`moduleHash` 覆蓋依序 slug、moduleKind、exportName、signature、inputs、returns、preconditions、postconditions、harness：每個原字串編成 `十進位UTF-8 byte長度:原文` 後無間隔串接，再 SHA256。這避免 Node／Go 的 JSON key 順序、HTML 與 U+2028 escaping 差異；不是正式驗證的 bundleHash。普通 Test checkpoint 不接受 moduleHash，Module checkpoint 則必須具備；Module partial 只接受 checkpoint_saved，沒有無候選或模型自報 proof 的形狀。

Manager／Server 獨立核對完整 schema、重複／null／未知欄位、權威 slug、兩個 hash、requestValidation=false 及必備用量 receipt。只有內部 Worker 的自試守衛產生 checkpoint；MCP 在提交前檢查與套用交易均拒絕此 envelope，普通外部 Module 提交保持原流程。機密遮蔽改變候選或 nextStep、取消或自試未通過時，不交付 checkpoint。截斷的工具參數不執行，只有暫存片段仍屬未驗資料。

### 保存、回收與受控續接

Server 原子寫入完整 Module 草稿的新 revision、清除舊正式驗證／摘要、更新 context revision，並保存 authorPartial 的 appliedRevision、兩個 hash、nextStep、用量及完成後 context。Run transport status 為 succeeded；不建立 Module 正式驗證要求或 Plan candidate，不代表整體需求完成或可直接發佈。重送相同完成結果不再次套用候選。

人工仍使用 `POST /api/runs/{id}/continue`、body `{editingSessionId,revision}`。僅內部 builtin 接單模式、成功且具上述 partial、同一活躍週期、已回收的獨立 Module Run 可續接。當前 revision／context、conversation、完整本體／module hash 必須吻合；新 Run 的 scope／設定、authorization revision／proposal、skills、registry、model、runtime 與原快照相同，工具只能取原權限與目前裁決交集。Workspace 後續切換 builtin／external 偏好不能重新路由此鏈，SDK 引擎仍沿原 runtime。漂移或過期拒絕，不重釘原 Run。

沿用原最多三筆 Run（含首筆）、模型8／工具12／作者時間180000ms共用總量；Module單次output仍16384。用量由傳輸／工具入口計數，失敗嘗試同樣扣抵，作者時間至少1ms。每子 Run 只取得原上限扣掉先前用量的餘額，不重新給額度。公開 Module 路線需三次請求／工具完成本體、harness與commit；剩餘不足3模型或3工具時不排必然無法完成的子 Run，回409 continuation_budget_exhausted。時間／模型／總嘗試耗盡亦同；缺可信 policy／用量則拒絕，不重建歷史額度。最多三筆是上限，並不保證原額度足夠執行三輪。

同 source／session／revision 的並行或重送只建立一份子 Run 與分配；相同請求可讀回原 receipt，不因後續已進展再扣額。不同 body、取消、未回收、revision／context／授權或原文不符均拒絕；交易拒絕不留下新 Run／訊息或推進 context。MCP 沒有 continue／發佈入口。UI 以「已保存候選」區分預算耗盡，沿原人工按鈕、409保留／重讀與不自動重送流程。

### 已驗範圍與限制

雙引擎各以3模型／3工具保存，再於5／9的餘額內各3模型／3工具完成後排正式驗證；真 Node Worker artifact 經 Manager 接收端、Server與Postgres保存／續接。另有實際 Playwright 成功與刻意斷言失敗自試，以及真候選API／ConversationPanel人工續接。模型回應全部為合成，未跑付費provider或黃金全套；正式驗證的排程門檻已驗，這些自試不替代發佈所需的正式證據。

本波不提供 Plan Stage partial／失敗 Stage 恢復、取消或程序崩潰時的隱式保存、跨 attempt 暫存、任意大候選分段編輯或放大配額。沒有通過完整 commit 的工作仍停止；需在原額度耗盡前明確保存可驗證候選。精確結果及後續見 [Wave11交接](../docs/tracking/handoff/m12-wave11-20261117.md)。

## M12.1 Wave12：有界 Module 編輯與不可變候選引用（registry 15.0）

`module-authoring` 預設加上兩個 Worker 本機工具，不經 Server IPC／MCP，也不新增檔案、網路或執行權限。新工具與 skill／registry 原樣固定 hash；模型、effort、8模型／12工具／180000ms／16384 output及原本每個script／harness 2MiB上限不變。

- `read_module_candidate_part({part,stagingRevision,offsetBytes})`：part為script／harness，stagingRevision為整數或null（本次呼叫的當前版本），offsetBytes為UTF-8 byte位移或null。每頁最多8192 bytes，邊界對齊UTF-8；null位移只容許整份不超過8192 bytes。回傳精確版本、完整部分的SHA256／bytes、內容與下一位移，永遠dataOnly=true／validationEvidence=false。數字版本在本Run內不可變；compaction將null正規化成實際數字版本，精確讀回仍需預留原工具額度。
- `edit_module_candidate({stagingRevision,scriptSha256,harnessSha256,edits,metadata,nextStep?})`：以初始凍結原稿或已接受候選為基底，雙hash與CAS相符才套用。至多16個不重疊、合法UTF-8邊界的編輯，每筆為part／offsetBytes／deleteBytes／insert；所有insert合計最多8192 bytes，完整工具JSON亦最多8192 bytes。metadata仍需完整八欄；不得刪除斷言規避失敗。Worker組裝完整候選並經原scope、Module ABI、自試、機密與完成守衛；不是把patch當正式證據。

初始savedSnapshot新增moduleCandidateRef（版本0、雙hash與bytes），可減少重傳完整原稿。最多保留版本0–12，隨Run結束丟棄；沒有跨attempt暫存、Server任意讀取或自動合併。metadata／slug／機密／CAS等拒絕不推進版本；合法編輯即使自試失敗仍保留為**未驗**本機版本，回傳candidateRef供原額度內修復，最後通過候選仍由原guard閉包持有。機密新分類後，引用／讀回同樣拒絕，不回傳不相符的遮蔽內容與原文hash。

成功編輯直接完成（或依Wave11的獨立Module nextStep明確保存partial），不需要額外模型收尾或legacy雙staging。Server只對同時固定edit／read／commit能力的獨立Module，允許餘額1模型／1工具的continue；沒有新能力的legacy路線仍至少3／3。這是實際呼叫數降低，不重設用量、不補額。真Server→Worker→Manager parser→保存／回收→continue以實際7模型／7工具的首Run測試，次Run只分配1模型／5工具，使用1／1完成；正式驗證仍僅於完成並回收後排程一次。

本波不開放Plan Stage nextStep；任意大候選或任意大小patch亦不在此有界介面內。精確結果與保留的中間失敗見[Wave12交接](../docs/tracking/handoff/m12-wave12-20261117.md)。

## M12.1 Wave13：Plan Stage checkpoint／人工續接（registry 16.0）

`module-authoring` 的 `edit_module_candidate`／`commit_module_candidate` 選填nextStep現在可用於已綁定Plan Stage；完整候選、Module hash、實際receipt及原自試／機密／取消守衛沿Wave11／12，不接受provider半份args或MCP自報partial。Stage的partial同樣requestValidation=false，不產生plan_module_candidates或module_validation_requests。

Server只在成功Run**實際回收後**，把Plan設為stopped、保留Stage.status=authoring、記下applied draft revision並顯示等待人工續接；沒有自動模型重試。原Stage失敗或無可信候選仍維持失敗停止。

人工呼叫 `POST /api/plans/{id}/stages/{stageId}/continue`：

```json
{"planRevision":6,"sourceRunId":"來源UUID","moduleRevision":2,"confirmed":true}
```

只接受這四個非null欄位；4096-byte JSON上限，重複／未知欄位拒絕。Server於原子交易核對：Workspace權限；Plan CAS、原UseCase編輯週期／revision／context、checkpoint暫停原因；Stage綁定／source／完整候選雙hash／Module編輯週期與context；成功、無cancel且已回收；沒有其他執行中或未回收任務。所有前段仍ready且原正式證據有效，後段仍pending。取消已暫停Plan後不得續接。

migration029記錄不可變的根Run Plan綁定（完整ready前段、後段、目前Stage輸入／Module ID／decomposition、父基底與context、執行邊界）與續接request／result。新Run重用來源runtime、skill／registry pins、model、scope／設定與授權revision／proposal、內部執行路由及原工具上限；任何漂移回滾。nextStep只追加DATA，保留原Stage及父拆分契約，超過原12則／32000字元即拒絕，不截掉原目標。

沿migration027共用鏈：最多三筆Run（含首筆），子Run只取原剩餘模型／工具／時間，output上限不變。未拆分Stage維持原8／12／180000／16384；兩段拆分各4／6／90000／16384，包含其所有continue，不重新進applyStageSplit、不新增或修改plan_stage_split_runs根分配。全平台金額／跨獨立重試或全Plan總額依原範圍延後，這裡不宣稱涵蓋。

成功只更新當前Stage.authorRunId與Plan revision／running；前段／後段／邊界保持。相同source及完整request並行或重送只產生一個子Run，回傳已保存的Plan receipt；不同body拒絕，UI再GET取得現況，不把舊receipt當最新狀態。最後完成的Module才走原正式驗證；Stage及整批發佈門檻不變。

PlanPanel顯示候選nextStep與人工續接按鈕，409／未知寫入結果須重新載入，不自動更新CAS或重送；可明確停止已暫停Plan。沒有取消／崩潰時的隱式checkpoint或任意大小產物。[Wave13交接](../docs/tracking/handoff/m12-wave13-20261117.md)記錄真Worker／Manager／PG／Chrome／UI結果與限制。
