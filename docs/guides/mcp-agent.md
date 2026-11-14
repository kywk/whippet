# MCP Agent 接入（M11 開發中）

本頁對應 [v11 契約](../../contracts/mvp-v11.md)。目前已交付 Token、Catalog、匿名 browser session、外部接單及平台作者切片；普通 Test 已通過真 UI→MCP Agent→正式驗證。各功能的部署與驗證範圍如下，M11 整階段仍未完成。不得將此設定套用到既有19287驗收現場。

## 部署與管理

MCP採明確啟用：部署端提供獨立 `WHIPPET_ADMIN_TOKEN`，不得使用Manager token或Agent Token代替。未設定時，MCP與Token管理回503；原開發模式不代表可以安全對外開放MCP。

啟用後，管理客戶端所有 `/api` 請求以 `X-Whippet-Admin-Token` 傳管理key。Manager仍走原專用Bearer；外部Agent只走 `/mcp`，使用Workspace Agent Bearer。管理API拒絕任何Bearer，即使同時帶正確管理key。

使用HTTPS；本機隔離測試可用loopback HTTP。若客戶端會傳Origin，部署設定 `WHIPPET_PUBLIC_ORIGIN` 為精確scheme、host與port；不接受任意Origin或由轉送Host推導信任。管理key與Agent Token不可放在URL、瀏覽器持久儲存、一般log或版本控制。

## 建立與撤銷Token

管理API依序為：

1. `POST /api/workspaces/{workspaceId}/agent-tokens`，JSON `{ "name": "local-agent" }`。
2. 建立回應中的 `token` 僅顯示一次；用客戶端支援的秘密儲存方式保存，不貼到對話或命令歷史。
3. `GET /api/workspaces/{workspaceId}/agent-tokens` 只回metadata，無法取回原明文；遺失時撤銷舊Token並建立新的。
4. `DELETE /api/workspaces/{workspaceId}/agent-tokens/{tokenId}` 撤銷；撤銷提交後的新MCP請求立即拒絕。

每個Token固定屬於一個Workspace。不要把管理key交給外部Agent。管理UI輸入只保留在記憶體；登入成功清除輸入，以不含管理key的HttpOnly、SameSite Strict cookie維持最多8小時session，Server重啟即失效。原生報告與WebSocket使用同源cookie；部署須設定精確WHIPPET_PUBLIC_ORIGIN以通過寫入檢查。登出會撤銷session並清除一次性Token畫面。

## 外部客戶端

在支援Streamable HTTP的MCP客戶端設定Server URL為 `https://<部署主機>/mcp`，Authorization header為 `Bearer <Agent Token>`。這裡的角括號是說明占位，不能直接照貼；避免在會列印header的除錯模式下連線。

先執行initialize，再查tools/list與resources/list，以實際列出的能力為準。Catalog工具為：

| 工具 | 用途 | 參數 |
| --- | --- | --- |
| catalog_search | 搜尋該Workspace已發佈Module首頁 | `{query,limit}`，limit=1..20 |
| catalog_get | 讀取同Workspace已發佈Module固定版本 | `{moduleVersionId}` |

schema直接來自工具註冊表；catalog_search不接受cursor。首波尚未公開catalog_next_page，即使搜尋回nextCursor，也不能宣稱已取完整目錄。skill resources僅提供列出的封裝內容，不接受任意本機檔案路徑。

首波沒有publish、Plan確認或其他人工核准工具；後續AI寫入一律為草稿並記ai來源，不能取代真實驗證及人在UI發佈。

## 回應與錯誤

- 401：Token或管理認證缺少／失效；使用對應入口的認證，不自動改用管理key。
- 403：Origin不符、認證入口不符或權限拒絕；不要以移除守衛重試。
- 429：每Token每分鐘60次、burst10；依Retry-After等待。
- 503：MCP未啟用或服務尚未可用；不能將它解讀為空工具清單成功。

工具錯誤使用MCP isError與安全固定訊息。超限不截斷JSON。稽核只記Token/Workspace識別、工具名、固定結果及時間，不記參數、內容或Token明文。

## Wave 2 匿名瀏覽器租約

registry11.0 另公開 `browser_session_open({requestId})`、`browser_session_status({sessionId,leaseId})`、`browser_session_close({sessionId,leaseId})` 與原 schema 的 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill`。所有識別為 UUID；open 的 requestId 重送會回原租約，關閉後也不重新開啟。

browser 工具呼叫須在 JSON-RPC `params._meta.whippet` 放 `{sessionId,leaseId,callId}`，不得加入工具 arguments；客戶端需支援傳送這項 metadata。相同 callId/參數只回原結果，忙碌回 busy，結果遺失回 unknown_result，不能自動產生新 callId 重做副作用。本機 stdio bridge 可為唯一 ready lease 補 metadata；接單工具以明示識別的 task_tool_call 使用瀏覽器，已於 Wave3 真 Agent 流程驗證。

兩路隔離 QA 已通過租約異常與真 Docker 全鏈；真 browser 測試使用獨立 schema 的已確認 scope fixture，不代表 Workspace 設定 UI 已驗。close 只有 status.reclaimed=true 才代表已釋容量；heartbeat 未列出 session 不算回收證據。

## 尚未完成的整合

browser session採10分鐘閒置／30分鐘硬期限，共用Worker容量且回收後才釋放名額。Server匿名租約入口與真Docker已接通；Wave7已接可信登入與LiveView；未配置TLS/有效role/lease時登入仍拒絕，真跨端驗收待集中確認。

外部接單已支援下列作者。互動 Module/Use Case 建稿與驗證工具已完成 Wave6 核心檢查；登入與 LiveView 已完成 Wave7 核心檢查，尚未完成整階段驗收。

官方協定參考：[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[本專案固定的Go SDK v1.3.1](https://github.com/modelcontextprotocol/go-sdk/tree/v1.3.1)。

## macOS 本機安裝（獨立環境）

`deploy/install-local-mcp.py --server-binary <已驗證的原生Server> --manager-binary <原生Manager>` 建立全新安裝；已有同名服務、DB或Codex設定時拒絕覆寫。Worker映像先以本repo建置為 `whippet-worker:m11-final`。安裝使用 `~/.local/share/whippet-mcp`、loopback Server19587、Postgres19589與獨立 `whippet-mcp-local-db` volume，不使用19287現場。launchd使用者服務為 `io.whippet.mcp.local.server` 與 `io.whippet.mcp.local.manager`，需本機Docker可用。

Codex MCP名稱為 `whippet`，以 stdio bridge 連到本機 `/mcp`；啟動新的Codex對話載入設定。新Workspace起初沒有確認scope，只可讀已接線Catalog與封裝resources；不能把工具列出等同已授權browser操作，也不能跳過Workspace確認。

本次執行環境的Keychain新增回-25308（不允許互動），因此安裝改用專用 `secrets/` 目錄0700及每帳號檔0600。bridge只接受本人擁有的regular、單一硬連結檔案，拒絕符號連結與寬鬆權限；Codex設定只存非秘密路徑，不存Token。Keychain模式仍可供允許互動的環境使用。憑證不得貼進終端輸出、對話或Git；備份此安裝時須把憑證視為秘密處理。

本機Server/Manager輸出送至 `/dev/null`；以 `/readyz`、launchd狀態與定向MCP驗收確認，不蒐集原始請求日誌。停止時可對兩個獨立plist執行 `launchctl bootout gui/$(id -u) <plist路徑>`，停止 `whippet-mcp-local-db`；保留volume、artifacts與work，不以刪資料當停止方式。

## Wave3 外部接單（普通 Test）

管理者在 Workspace「正式設定與能力」選外部 Agent；設定影響新 Run；Wave3 僅普通 Test，Wave4 擴充驗收摘要，Wave5 擴充 Module／Use Case planner（含 Stage 原 skill）／Workspace 訪談。既有 Run 快照不變。底層管理API是 `PATCH /api/workspaces/{id}/author-engine`，以revision CAS保存。Run.authorEngine是建立時快照。

Agent依序使用task_claim（requestId冪等）、task_heartbeat、task_tool_call及task_submit。task_tool_call把runId/attemptId/leaseId/callId放在控制工具本身的arguments，nested工具的arguments維持原registry schema。只用contextBundle實際allowedTools。短租120秒，硬期限沿原skill budget（普通test-author目前180秒）；heartbeat不能延長硬期限。先讀 `whippet://skill/test-author/references/external-mcp`。

送出前先在客戶端記憶體保留完整submit request，再以同一submitId與同一output提交完整message/script/requestValidation/conversationSummary；busy可待回收後原樣重試，unknown_result不能用新callId重做副作用。直接提交只是尚未自試的AI候選；requestValidation=true讓平台另外排正式keyless Playwright Run。submit成功不等於驗證通過，需由UI看目前revision驗證成功與報告。發佈仍由人在UI操作。

本機bridge另會替獨立browser session的原四工具補入ready lease metadata；已有顯式metadata不覆寫，close或未知結果清除隱式綁定。接單主線仍用task_tool_call明示身份。

2026-11-14實測：真網頁送單，全新Codex透過MCP探索／產稿／提交，revision2來源ai，正式validation為succeeded且expected=1/unexpected=0/flaky=0/skipped=0，報告可開啟。QA沒有代寫腳本或攔API。驗收摘要仍走builtin，本次附帶summary Run failed，未驗發佈，不能據此宣稱整個M11已完成。


## Wave4–5 外部平台作者

程式碼已完成三類驗收摘要（普通 Test／Module／Plan batch）與 Module、Use Case planner、Workspace 訪談接單，核心必要測試通過。本機19587已同步至含Module ABI修補的版本；全新Terra QA實測19工具可見、Catalog與Module main/harness/external資源可讀。

| 作者 | 外部提交 | 成功的意義 |
| --- | --- | --- |
| acceptance-summary | message、description、backgroundSummary、可選name | 原驗證證據與revision/batchHash仍有效；不新增驗證或發佈資格 |
| module-authoring | message、完整script、module八項metadata加harness、requestValidation | 未自試AI草稿；獨立正式harness validation才產生驗證證據 |
| usecase-planner | message、planCandidate.candidateRef | ref須先由同Run/attempt的propose_plan發行；Plan仍待人工確認 |
| workspace-author | message、可選proposal/conversationSummary | 待人工確認的Workspace提案；不能自動擴大網站scope |

各作者先讀claim指定的skill與external-mcp reference，只呼叫實際allowedTools；不能用外部自報selfTestPassed/partial/proof取代平台證據。摘要allowedTools為空。Workspace scope未確認時可文字訪談，browser仍拒絕。所有新寫入沿原CAS與重複提交守衛，MCP不提供確認或發佈。


## Wave6 互動模式

registry11.2 新增 draft_create、draft_get、author_start、validation_request、validation_report。先 draft_create 建立 Module（含slug）或 Use Case，再 draft_get 取得編輯session與revision/contextRevision；author_start以CAS建立並直接領取本Token的外部任務，不改Workspace引擎，回應task供原task工具繼續產稿。Module submit是未自試候選；Use Case先propose_plan再submit同attempt的candidateRef。

validation_request只能排正式驗證；Use Case未人工確認回awaiting_human_plan_confirmation，確認後重新讀目前revision再續請。同requestId等待時不留永久完成紀錄，真正排程後同鍵同body回原結果。validation_report返回綁定目前Test/revision/Run的狀態、統計與安全錯誤數，不回原始log。所有寫入ai，scope/Token/CAS及人工發佈門檻不變。

Wave6必要真MCP/隔離PG檢查已通過；使用合成validation artifact，不等於本次真Docker或完整UI驗收。本機已更新；此段核心測試仍只代表合成狀態機證據。


## Wave7 登入與監看

browser_login沿原schema只傳roleId與三個selector；username/password只經Manager可信HTTPS resolver與Worker私有IPC，成功回submitted不表示網站已登入。Manager連線自簽Server時設定SERVER_CA_FILE指向公開CA，控制WSS、credential與live連線均驗證憑證，不能關TLS驗證。

管理者在Workspace設定「瀏覽器 session」清單只會看到當下有效opening/ready租約，ready可開始監看。關閉監看或離頁只停媒體，不關browser；租約逾時、撤銷、scope/epoch失效則終止監看。敏感輸入期間沿原遮蔽/暫停，viewer心跳不延長browser期限。使用同源管理cookie與精確Origin，不在URL放Token。

本機19587已部署19工具並經全新對話實際唯讀驗收。原Workspace仍未確認scope，沒有繞過人工授權；本機HTTP入口不提供可信HTTPS登入resolver，browser_login需另行配置TLS與有效scope/role。真TLS登入與LiveView已在隔離環境驗證，不能等同本機HTTP服務已具備該設定。
