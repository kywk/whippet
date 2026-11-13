# 架構與執行協定

## 邊界與部署

React SPA → Go Server → PostgreSQL／附件儲存。
Go Manager 主動透過 WSS 連 Server，並在同一 Docker 執行環境管理一次性 Node.js Worker。
Worker 內部包含 Agent runtime、Playwright 及瀏覽器；畫面傳輸與任務控制分開。

- Server：單一模組化服務，負責業務規則、任務持久化與狀態；MVP PostgreSQL 佇列即可。
- Manager：排程本機資源、啟停容器與回收；不跨主機控制遠端 Docker，也不直接連 Server DB。
- Worker：同一映像提供 author／validate／run 模式；author 負責一輪 Agent 工具互動，等待人類時結束。
- Manager／Server 獨立部署；Compose 分為 server 與 runner 配置，允許同機開發。
- Manager 可容器化並使用本機 Docker API。僅 Manager 持有管理能力，Worker 不掛入 Docker socket。
- Mac Docker 執行 Linux 容器；amd64／arm64 的 Worker 映像與依賴在初始化時選定並驗證實際目標。

## 資料模型

| 實體 | 主要欄位／約束 |
| --- | --- |
| Workspace | id、name、網站設定、非機密預設執行設定 |
| Test | id、workspace_id、name、description、published_version_id |
| Draft | test_id 唯一、current_revision、對話 session_id |
| DraftRevision | test_id、revision 唯一、檔案快照／雜湊、設定快照 |
| TestVersion | test_id、version、不可變檔案與設定、來源 revision、validation_run_id |
| Conversation／Message | workspace_id、test_id、role、content、tool result；持久化 |
| Run | id、kind、版本或 revision、設定快照、狀態、結果、manager_id、attempt_id、時間 |
| Artifact | run_id、相對儲存鍵、種類、大小與上傳狀態 |
| Manager | id、連線狀態、capacity、最後心跳；MVP 只允許一個啟用 |

MVP 身分可由後端固定 provider 提供；資源存取走共同授權函式，之後接真正使用者／membership。測試、對話與執行均透過 Workspace 範圍查詢。

## 草稿與發佈

草稿每次保存使用 expected_revision；不符時回 409，避免覆蓋他人的修改。保存產生不可變 revision。
驗證 Run 固定 revision、內容雜湊與執行設定。發佈在 DB transaction 中檢查當前 revision、驗證成功與報告已保存，建立 TestVersion 並更新 Test 指標。
發佈不刪除 revision 或對話。M7 起每次修改使用獨立編輯週期；同一 Test 最多一個活躍週期，發佈／放棄後封存，下次修改從目前正式版本開始。

## 最小 API 範圍

- POST /api/dev-login；GET /api/workspaces；GET/PATCH /api/workspaces/:id。
- GET/POST /api/workspaces/:id/tests；GET/PATCH /api/tests/:id。
- GET/PUT /api/tests/:id/draft；GET/POST /api/tests/:id/messages。
- POST /api/tests/:id/validate；POST /api/tests/:id/publish。
- POST /api/tests/:id/runs；GET /api/tests/:id/runs；GET /api/runs/:id；POST /api/runs/:id/cancel。
- Run 日誌、報告與附件端點；M1 前端以短輪詢更新；M3 對話沿用短輪詢，未來 AI 串流可採 Server SSE，與 Manager WSS 分開。
- /api/manager/connect 為 Manager WS 入口；任務附件上傳使用 HTTP 與 manager 身分驗證。

實際 request／response 放 contracts/；上列為起始範圍，不要求先建立完整 OpenAPI 平台。

## 任務狀態與去重

Run 狀態：queued → dispatched → running → collecting → succeeded／failed。
取消走 cancelling → cancelled；超時結果為 timed_out；結果無法確認為 interrupted。
Run 結果與本機 slot 是否已釋放是兩個狀態：即使 Run 已失敗，未確認容器回收就不能重用 slot。

- Server 是任務與結果的持久化來源，Manager 是本機容器與 slot 的來源。
- dispatch 使用唯一 run_id＋attempt_id；MVP 不自動重試執行，人類重試建立新的 Run。
- Manager 接收任務後先記錄在本機持久化 journal，再建立帶 run／attempt 標籤的容器；重複 dispatch 回覆既有狀態。
- Manager ACK 後才視為已接收；ACK 丟失時對帳或重送同一 attempt，不生成新 attempt。
- 同一 Run 只接受目前 attempt 的結果；終態回報可安全重送，重複事件以 event_id 去重。
- Manager 重啟掃描 journal 與標記容器，先對帳／清理，再接新任務。MVP 可中止殘存任務，不必實作程序接管。
- Server 重啟後從 DB 恢復排隊任務；離線 Manager 的任務等待對帳，不猜測已停止。

## Transport 介面

統一 envelope：protocol_version、message_id、type、manager_id、run_id／attempt_id（適用時）、payload。
MVP 訊息：hello、heartbeat、dispatch、ack、cancel、event、result、reconcile。
hello 宣告 capacity 與協定版本；reconcile 比對活躍任務、終態與尚未完成上傳的附件。
重連採有上限的退避與 jitter。未收到新指令時已在執行的 Worker 繼續，受本機 timeout 約束。

Transport 只負責收送與連線；業務任務處理共用 handler。未來 Polling、HTTP Push 接相同 envelope，本輪只保留介面與設計。

## Worker 執行契約

輸入：工作種類、run／attempt、腳本或草稿快照、URL／設定、timeout、模型設定引用。
輸出：逐行結構化事件、最終結果 manifest 與附件目錄。Agent API key 透過執行環境注入，不寫入腳本、對話、報告。
Manager 管理容器 CPU／記憶體限制、逾時與取消；停止寬限時間後強制終止容器，清理程序及暫存目錄。清理失敗則保留 slot、回報錯誤，其他可用 slot 可繼續。
Playwright 內部 workers 預設 1，避免與 Manager 併發上限相乘。
完成後由 Manager 透過 HTTP 上傳附件，確認 Server 保存後清本機檔；上傳失敗可補送，不重新執行測試。

## AI 編輯

工具介面採探索瀏覽器、讀／更新草稿、執行驗證、讀取報告。官方 Playwright 工具可接入，MVP 不需要多 Agent 自治框架。
模型 adapter 保留自訂 endpoint／model、串流及工具呼叫；OpenCode Go Muse 先預配原生 Responses（非強制 Chat Completions），編輯迴圈依 M3 契約實作；OpenAI-compatible 不保證所有供應商能力一致，先驗證實際選用的一個 endpoint。
每輪使用當前草稿、近期對話與必要工具結果；完整歷史持久化但不全量送模型。M3 每回合最多8次模型請求／12次工具呼叫／180秒。對話/author輸入輸出與衝突處理見 contracts/mvp-v3.md。
驗證要求走同一任務佇列，避免 Agent 另外啟動未計入容量的瀏覽器工作。串行續接任務時釋放前一 slot，避免占用 slot 等另一個任務而卡死。

## 即時畫面

Worker 擷取瀏覽器畫面 → 媒體傳輸元件 → 前端；Server／Manager 提供 session 與 signaling。
WebRTC 作主要方向，預留 TURN；受限環境可用 WSS 畫面轉送備援。控制連線可用不代表媒體連線可用。
先以可替換 LiveView 介面串出畫面；套件由執行 Agent 在功能實作時選擇，不設獨立長期研究階段。
只讀、不要求音訊／滑鼠鍵盤接管。無人觀看可停止串流；觀看中斷不影響測試。WebRTC 未完成時明列狀態，備援不能被回報成 WebRTC 已驗證。

## 最小部署防護與擴充

Manager 使用部署 token；模型金鑰僅在後端執行環境；測試腳本不得取得主機管理 socket。報告以受控附件端點或隔離頁面呈現，避免執行內容混入管理介面。
產品採開源方向，Apache-2.0 為候選，實際 LICENSE 於初始化依選用依賴決定。本輪不複製外部專案程式碼。
本輪完成多 Workspace；未來沿既有邊界增加 RBAC、多 manager、替代模型、S3 儲存與新 transport；MVP 不為這些先建完整系統。


## M7–M9：對話工作區擴充（2026-11-12）

需求依 [AI 對話工作區規格](../requirements/ai-workspace.md)。以下覆蓋歷史每個 Test 僅一個永久 Conversation 的假設；舊 v1–v6 契約保留為歷史，相容遷移由新契約明定。

### 資料與狀態

- EditingSession：testId、sourceVersionId、conversationId、狀態 active／discarding／discarded／published；唯一約束保證每 Test 最多一個活躍週期。DraftRevision／author／validation 綁定週期與 revision。
- 放棄先封鎖新任務，取消既有任務；回收／終態確認後封存。結果交易必須同時核對 session 狀態、revision 與 attempt，不能僅比較 revision。
- 版本保存 description、backgroundSummary、來源編輯週期、驗證 Run 與摘要來源 revision。摘要任務唯讀腳本；發佈交易核對摘要及驗證指向相同腳本／設定快照。
- Conversation 可屬 Workspace 設定或 Test 編輯週期，採明確 owner 關聯；歷史查詢依 workspace_id 範圍授權。
- Workspace 設定對話產生 proposal，使用 expectedRevision 提交；建立中 Workspace 尚未啟用，僅允許訪談及經確認的範圍內探索。
- 舊正式版本、Run 與附件不變；既有草稿／對話需遷移歸屬，不可遺失或一律誤判為未發佈修改。無正式版本或草稿內容／設定異於正式版本者視為活躍草稿；其餘保留歷史，首次修改才建立新週期。

### 背景與任務路由

Server 決定 skillId／skillVersion、sessionId、允許工具、Workspace 背景及驗測設定快照；Manager 傳遞，Worker 按類型載入 skill。共用既有容量／取消／去重，不引入新排程服務。

背景組合：Workspace 摘要＋來源版本摘要＋當前完整腳本（測試類）＋當輪訊息＋近期對話＋必要驗證證據。完整歷史留 DB，提供受限按需讀取；摘要保留來源關聯。Workspace 類任務沒有 testId，需擴充 Run owner 與檢查，不以假 Test 承載。

M9 歷史工具依 [v9 契約](../../contracts/mvp-v9.md)：Server 在排入 author Run 前固定同 conversation 的 sequence 上限。只有 test-author／workspace-author 能按需讀取，每頁最多 6 個片段與 8192 UTF-8 bytes，每 attempt 最多 4 次、單次 15 秒；摘要任務與缺少 history 能力的舊 Run 不開工具。Manager 使用專用 HTTPS 端點核對活躍 attempt 與控制連線，Worker 只走獨立 history IPC，不持有 Manager token。credential／history 共用單一 stdin 分流與整 frame 寫入，資料及額度分離；失效 session／context、取消、終態拒讀。完整歷史不寫入一般 log，無新增持久配額表。

### 網站與機密邊界

2026-11-12 使用者最新裁定：AI探索/產稿/修復以已確認target與必要dependency為範圍，透過工具、瀏覽器導覽/redirect/popup/request與產稿指引盡量避免越界；不建任意Node的網路沙箱。工程師手動修改的Playwright腳本保留完整能力，不套用AI網站範圍限制。來源由Server依寫入路徑記錄並快照至revision/version/run，不相信模型自報來源。

不採AST白名單直譯、network=none＋全通道代理平台或協定降級。保留既有Playwright runner與報告，手動腳本仍使用獨立Worker與既有資源/逾時/回收限制。AI探索工具對任何來源腳本都受範圍檢查；人工來源不代表可取得模型key、Manager token或跨Workspace機密。

機密採A的AEAD/TLS/角色參照；任務限定登入工具不向模型回傳值。AI可讀登入後頁面內容、操作及監看，針對密碼/Token/cookie/已知敏感輸入遮蔽，不一律禁止登入後DOM或原生報告。真驗證結果與人工發佈門檻保持。憑證撤銷繼續生效；網站範圍撤銷不延伸成手動腳本出站限制。B機密任務傳遞由owner提出最小接縫後PM固定，不沿用已廢止的全代理租約平台需求。

### 契約交付界線

PM 在各波實作前固定 HTTP／dispatch／輸出與遷移規則；Server／Runtime owner 先回覆既有介面的最小差異。M7 固定編輯週期與摘要契約；M8 固定 Workspace proposal、機密參照與範圍政策；M9 整合技能路由與對話事件。尚未固定的 wire 欄位不由各 Agent 各自猜測。


## M10–M12：Use Case 與 Agent 平台化（2026-11-13）

需求依 [Use Case 與 Agent 平台化規格](../requirements/usecase-agent-platform.md)。wire 欄位由各階段的契約（v10／v11／v12）固定；本節只定義邊界。

### 分層

- **控制面（Server）**：決定 skill 組合、允許工具、預算、模型、Plan 狀態與來源記錄；負責 Stage 調度與發佈交易。不新增排程服務，沿用任務表。
- **守衛（Worker）**：驗證輸入、解析輸出、`secrets.clean`／`noSecret`、範圍守衛。不論用哪個引擎都不可外包。
- **工具註冊表**：`contracts/tools/registry.json` 是工具定義的單一來源，欄位包括 name、description、JSON Schema、`side`（server／worker）、`effect`（read／candidate／browser／queue）、單次上限。Go 與 TS 都從同一份檔案載入；內建引擎、MCP 與 adapter 共用。
- **引擎**：`AgentEngine.run({instructions, context, tools, budget, model, signal, beforeRequest, onEvent})`，回傳 `{finalText, partial?}`。M10 把現有迴圈包成 builtin engine；M12 才加入開源 adapter。

### 資料

- Test 新增 `kind`：test、module、usecase，沿用編輯週期、revision、version、摘要與發佈機制。
- Module 版本保存 slug、moduleKind、簽章、輸入與回傳說明、harness 腳本。slug 在 Workspace 內唯一。
- Use Case 的 revision 保存 stages JSON。發佈時寫入 `version_dependencies(version_id, module_version_id)`，引用版本固定且不可變。
- Plan 屬於 Use Case 的編輯週期，保存 stages、每個 Stage 的狀態、連結的 Module Test 與失敗原因；狀態：draft → confirmed → running → composed → done／stopped。
- 發佈交易同時核對 Use Case 與本次新 Module 版本的驗證、摘要與 revision；任一項不成立就整批回滾。

### 執行

- Runner 輸入由單一 `script` 擴充為 `files[]`（path、content、origin）。Runner 寫出檔案樹，用 tsconfig paths 對應 `@lib/*`；任一檔案 origin 不是 manual 就套用範圍守衛。舊的單一 `script` 輸入保持相容。
- Use Case spec 由 Server 以確定性模板產生（每個 Stage 對應一個 `test.step`，綁定值轉成區域常數），不交給 AI 產生。
- Server 端工具（catalog、module 與 usecase 草稿讀寫、plan、驗證要求）由 Server 實作。Worker 透過 M9 history IPC 泛化而成的「harness tool IPC」呼叫，Manager 核對活躍 attempt；Worker 不持有 Manager token。

### 引擎能力

- 預算來自 skill manifest 快照。剩最後 1 次模型請求或最後 2 次工具呼叫時，注入收尾指示；超過上限時輸出 `partial`，Server 保存自我試跑通過的候選結果並顯示「繼續」。
- 單一 Run 內只保留最新一份完整 snapshot，舊的壓縮成摘要。
- Skill 依 manifest 載入；`read_skill_reference` 只能讀已打包、已快照的 references。

### 長對話與大任務的容量策略（2026-11-14）

單次輸出上限、輸入context容量與整體任務預算是三個不同邊界。G6將單次輸出上限納入skill不可變快照；Module本輪授權16384，其餘缺值8192。不得在失敗後由模型自行提高上限、換模型或無限重試。這個設定提高可用輸出額度，尚不能證明已排除截斷或大任務能力已完成。

目前對話入口保留最近最多12則／32000 Unicode code points；builtin Run內只會將舊browser snapshot縮成摘要，其他provider output／工具項目仍會累積；request bytes上限只是傳輸保護，不是model context token容量估算。既有history工具支援有界按需讀取；test-author具有自試通過checkpoint與partial續接，Module依v10仍於預算耗盡時停Stage，不具同等partial。不能將這些局部能力宣稱為通用長對話compaction。

後續M12引擎整合的設計與驗收要求（待實作）：

- 輸入依模型能力與已保留輸出額度做容量預檢；在接近門檻前壓縮舊工具結果／對話。保留原始資料於權威儲存，以有界讀取工具取回；摘要固定保留目標、限制、已確認決策、目前revision／Stage與證據引用，不能把摘要當驗證證據。工具call/result配對及provider要求的reasoning項目須維持合法。
- 大任務先拆成可驗證Stage；各Run只有當前Stage所需資料。完成狀態與固定版本存在Server，不依賴同一模型對話永遠保持完整。跨Run續接要檢查scope／revision／context／回收狀態並保存總嘗試與成本界限，不能用拆Run繞過整體限制。
- 大產物需設計有界候選編輯／分段提交及候選引用；組裝後仍須完整schema、hash、範圍與正式驗證，不把截斷JSON拼接後直接執行。M10有界切片已固定registry10.3並進入整合驗證：script／harness各自最多8KiB，attempt-local暫存後由commit完整自試，只有通過候選可套用；這不是跨Run續接，工具arguments仍保留於後續context。舊完整候選工具保持相容；成功final已由Worker守衛重建候選，毋須模型再產全文。優化重點是候選工具參數與重讀草稿，需另定契約，不能僅調高artifact bytes上限當作實作。
- 輸出截斷保留固定失敗分類；已有可信checkpoint時走受控續接，沒有則停止並提出縮小工作單位的修復。Module checkpoint擴充需另訂v10後續契約與驗收，不接受provider半份工具args。允許的恢復次數與總預算由控制面決定，不自動倍增maxOutputTokens。
- 驗收包含：長對話在固定上限下完成、超大Stage可拆解續接、壓縮後限制／證據引用不遺失、截斷不執行半份工具呼叫、取消／過期／重送不重複副作用。能力未通過前明列限制，不宣稱能處理任意大小任務。

### MCP（M11）

- Go Server 使用官方 MCP Go SDK 提供 Streamable HTTP 端點。Agent Token 雜湊保存，綁定單一 Workspace，可撤銷、有速率限制，並寫入稽核紀錄。
- Server 端工具直接呼叫同一套 handler；Worker 端工具（browser_*、login）透過租用 session 代理：Server → Manager WSS → Worker `session` 模式容器 IPC。session 佔用一個容量名額，閒置或逾時就回收。
- 接單模式以 attempt 租約承載：claim、心跳、工具呼叫、submit 都必須核對 attempt 與租約；逾時就讓 attempt 失敗；取消會讓後續呼叫一律失效。

### Adapter（M12）

- 開源引擎只負責迴圈、供應商、重試與 compaction，工具一律來自註冊表。依賴版本鎖定在 Worker 的 lockfile，並更新 tech-stack。
- `runtimes/agent-bridge/` 是參考外部 Worker，以 MCP 接單模式連線，不能直接存取 DB 或 Manager。
