# M7 編輯週期與驗收摘要契約

2026-11-12 PM 固定供 t30／t31／t32 實作；功能尚未完成。本契約覆蓋 v2／v3 的隱式草稿建立與永久 Test 對話；M8 範圍與機密功能另定。以下「建議」指實作接縫，wire schema 以本節固定項目及下文 HTTP 為準。

## 固定決策（優先於下文提案背景）

- 沿用 kind=author；公開 Run.authorMode 為 edit／summary，由可信 skillId 對應，不在 dispatch 再傳重複 mode。
- author 固定新增 skillId（test-author／acceptance-summary）、skillVersion（字串 1）、allowedTools、editingSessionId、contextRevision（非負整數）、sourceVersion（null 或 {id,description:null|string,backgroundSummary:null|string}）、conversationSummary（null|string）。既有 conversationId、baseRevision、messages、validation 保留；script／workspaceSettings 沿用頂層。M7 不捏造尚不存在的 Workspace 背景／scope 欄位。
- contextRevision 由 Server 管理：新 user 訊息與已接受的 edit 回覆遞增；摘要卡片／摘要保存不遞增。完成及發布均核對固定值。
- test-author allowedTools 只可為既有八工具的子集；Worker 同時限制宣告與執行。acceptance-summary 必須空陣列，不啟動瀏覽器。
- acceptance-summary 的 messages 可為空陣列（人工草稿已驗證且沒有對話時）；仍必須具有完整腳本與合格 validationEvidence。test-author／legacy 維持至少一則 user 訊息，不補造對話。摘要不能因缺對話省略description/backgroundSummary或驗證綁定。
- Manager journal 可保存本契約的固定非機密 author 輸入，供恢復與schema選擇；沿用既有輸入大小上限與回收政策，不保存模型key或登入機密。恢復沿用原attempt／結果，不因讀取journal重跑任務。M8機密僅可保存參照，實際傳遞另定。
- summary author.validationEvidence 固定為 {runId,attemptId,draftRevision,scriptHash,timeoutMs,status:"succeeded",reportsReady:true,stats:{expected,unexpected,flaky,skipped,duration}}；scriptHash 為 SHA256，timeoutMs 是驗證逾時。Server 從已驗證附件抽取統計，不讓 Worker抓報告 URL。Worker 校驗 revision/hash；Server 保留權威交易核對。
- test-author 的 author.json 沿用 {message,script?,requestValidation}，可附 conversationSummary（UTF-8 最多8192 bytes）。摘要輸出固定 {message,description,backgroundSummary,name?}，上限分別沿既有 message、16384 bytes、8192 bytes、200 bytes；不接受 script/requestValidation 或其他欄位。綁定只取 Server 已保存輸入，不要求 artifact 冗餘回填可信欄位。
- 摘要由 Web 在成功驗證且報告就緒後呼叫冪等 summary endpoint，重開編輯也補檢查；不新增第二套 Server 自動排程。失敗須顯示明確重試，禁止輪詢時無限自動重試。
- Version 的 description/backgroundSummary 舊資料為 null，新發布必填；可選 name 在QA確認發布時才更新Test名稱。
- 遷移修正：不可把所有現存 drafts 一律當未發佈修改。無正式版、腳本／設定異於正式版，或有無法安全封存的活躍編輯任務者建立 legacy active session；與正式版一致且無活躍任務者封存既有對話／revision，移除活躍指標。無可靠歸屬者保留資料，不捏造摘要。
- M7 使用有界週期摘要＋近期訊息；完整歷史在Server可讀。Worker按需遠端歷史工具延至M9補齊，M7不得宣稱已完成；不給Worker Manager token、不臨時建立通用RPC。新編輯回覆需維護conversationSummary以延續已知背景；首次legacy缺摘要列明限制，不假造。
- 下文所有舊 skillVersion 字串（test-edit-v1／acceptance-summary-v1）由上述 skillId＋skillVersion取代；validationEvidence形狀以上述為準。不新增context物件或另一套mode。

## 1. 現況與可重用處

| 實際檔案 | 目前行為／缺口 |
| --- | --- |
| internal/server/drafts.go:96、130 | lockDraft 找不到草稿就從正式版／空腳本建立 revision 1；GET draft、寫稿、驗證、發布及 author 結果都會進此函式。不能直接拿它做狀態查詢或放棄後結果處理。 |
| internal/server/conversations.go:15、25、111 | Conversation 目前每 Test 唯一；GET 會建立對話。author 只有 baseRevision、最近 12 則／32000 字元與 validation 摘要，尚無編輯週期或來源版本背景。 |
| internal/server/author.go:110 | completeAuthor 在檢查重複 result 前就呼叫會建草稿的 lockDraft。新增放棄後，這個順序會有復活風險。現有取消正規化與結果去重可重用。 |
| migrations/003、004、006 | draft_revisions 以 (test_id,revision) 唯一且不可變；Run 固定腳本／設定／author_payload；Conversation.test_id 有 UNIQUE；Version 沒有 description／backgroundSummary。 |
| internal/server/postgres.go | 正式 Run 從已發布 Version 快照入列；Cancel queued 立即終止，其餘 cancelling；只有 terminal 且 heartbeat active 已不含該 attempt 才 slot_released。這些語義保留。 |
| internal/server/engine.go | 已有 FIFO、cancel、結果去重與 heartbeat 對帳，不新增另一套排程器。 |
| internal/server/workspaces.go | 設定變更會替所有現存草稿新增 revision、清 validation。M7 須限定 active session，另清除摘要資格。 |

## 2. EditingSession：一個 Test 同時最多一個未結束編輯週期

新增小型 editing_sessions 表，狀態 `active | discarding | discarded | published`，保存 id、test_id、source_version_id、conversation_id、created_at／closed_at、published_version_id，以及目前週期的 conversationSummary／摘要涵蓋位置。partial UNIQUE(test_id) WHERE state IN (active,discarding)。Session 的 test_id／source_version_id 建立後不變。

- drafts 維持「每 Test 一個目前指標」，新增 editing_session_id；Script 與 workspaceSettings 繼續用原 draft_revisions，不另存一套腳本表。
- 新週期從目前正式版取**完整腳本、版本 description／backgroundSummary**；新草稿設定沿 M5 取目前 Workspace 快照。未發布 Test 則空腳本，來源版本為 null。
- resume 取同 session、目前完整草稿、週期摘要與訊息，不重新套用正式版或覆寫既有草稿。
- draft revision 在同 Test **永不重用**：新週期用 MAX(draft_revisions.revision)+1；不能刪指標後又回到 1。舊 Run／訊息的 revision 外鍵與 baseScript JOIN 繼續有效。
- 發布成功關閉 session 為 published，保存 publishedVersionId，移除目前 drafts 指標；下次修改才明確建立新週期。
- 放棄只移除目前指標、關閉週期；保留不可變 revisions、Run、對話及歷史附件。未發布 Test 本體保留。

### 無副作用存在查詢：併入既有 Test 詳情

`GET /api/tests/:id` 新增：

```json
{
  "activeEditingSession": null
}
```

存在時為 `{id,status,draftRevision,updatedAt}`；status 僅 active／discarding。採讀取 JOIN，不建草稿、不建對話、不觸發任務。一般模式用這個欄位判斷「修改／繼續修改」與草稿列，**不呼叫 GET draft 探測存在**。

## 3. start／resume／get／discard HTTP

沿用 camelCase 與 `{error:{code,message}}`。所有 sessionId 都須核對屬於 URL 的 Test／其 Workspace；跨 Test 引用回 404。

| 介面 | 回應與規則 |
| --- | --- |
| POST /api/tests/:id/editing-session，body {} | 無活躍週期：201 `{session:EditingSession}`；已有 active：200 同一 session（即 resume），不建立 revision／Run；discarding：409。一個 endpoint 合併 start/resume。 |
| GET /api/tests/:id/editing-session | 200 `{session:EditingSession|null}`，未知 Test 404。純讀取。 |
| GET /api/tests/:id/editing-sessions/:sessionId | 200 `{session:EditingSession}`，供放棄進度／已結束週期查詢；不存在或不屬於 Test 回 404，純讀取。 |
| POST /api/tests/:id/editing-sessions/:sessionId/discard，body {revision,confirmed:true} | active 須核對 revision；若可立即結束回 200，等待取消／回收回 202。重複 discarding／discarded 請求冪等；不得放棄 published session。 |

建議 EditingSession 最小形狀：

```ts
{
  id, testId, workspaceId,
  status: "active" | "discarding" | "discarded" | "published",
  sourceVersionId: string | null,
  sourceVersion: { id, description: string|null, backgroundSummary: string|null } | null,
  conversationId: string,
  conversationSummary: string | null,
  draft: Draft | null,
  summary: {
    runId, status, revision, validationRunId,
    description?: string, backgroundSummary?: string, name?: string,
    validForCurrentDraft: boolean
  } | null,
  pendingRunIds: string[], reclaimPending: boolean,
  publishedVersionId: string | null,
  createdAt, closedAt: string | null
}
```

closed session 的 draft 為 null；目前指標移除不影響歷史 revision。Web 不從 AI 文字推導 Run 或摘要通過；讀取上列 Server 狀態。歷史版本列表的「草稿」是 activeEditingSession 的 UI 列，不建立假 Version。

### 舊介面最少調整（須由 M7 契約明示覆蓋 M2 的隱式建立）

- GET draft 改純讀取：無 active／discarding session 回 404，不自動建立；GET conversation 亦不建資料。建資料只允許明確 start。
- PUT draft `{editingSessionId,revision,script}`；POST messages `{editingSessionId,revision,content}`；POST draft/validate `{editingSessionId,revision}`。URL 保留，Server 同時檢查 active session 與 optimistic revision。
- GET conversation 增 `?editingSessionId=...`，回傳 conversation.editingSessionId；省略時只讀 active session，無則 404。完整訊息仍持久保存並可由此介面取得，不能混入前一週期。
- Draft／Run 新增 editingSessionId；Run 的正式 kind run 為 null，author／validation 綁週期。歷史正式執行與編輯任務仍用既有 Run 查詢，Web 依 kind／session 分流，不新增兩套 Run 表。
- 建 Test 可省略 name，Server 暫用「未命名測試」；不在新建前要求完整表單。候選名稱可在對話收斂，摘要可回 name，QA 發布時才套用；不因此開新一套命名任務。

## 4. Conversation scope 與 Runtime 的最小增補

Conversation 改為**每 EditingSession 唯一**；移除原 conversations.test_id UNIQUE，新增 session 唯一約束／同 Test 關聯。messages 表及 (run_id,role) 去重保留。

繼續使用 dispatch.kind=author、author.json、180000ms 與既有 author journal／模型憑證注入；不增第三套 Worker entrypoint。公開 Run 加 `authorMode?: "edit"|"summary"`，Server 從固定 author_payload 取得，不相信 Worker 回報任務類型。

在原 author 內增補：

```ts
{
  mode: "edit" | "summary",
  editingSessionId,
  conversationId, baseRevision, messages, validation?, // 既有欄位
  skillVersion: "test-edit-v1" | "acceptance-summary-v1",
  allowedTools: string[],
  sourceVersion: {id,description:string|null,backgroundSummary:string|null}|null,
  conversationSummary: string|null,
  validationEvidence?: {
    runId, status:"succeeded", reportUrl,
    stats:{expected,unexpected,flaky,skipped,duration}
  }
}
```

- 完整 script、timeoutMs、workspaceSettings 仍在 dispatch 頂層；每輪都由任務固定快照提供，不讓 Worker 即時回讀較新的 Workspace。M7 只傳既有非機密設定，不宣稱 M8 的 scope／secret 機制已存在。
- edit 沿用原工具與結果 `{message,script?,requestValidation}`，可增 optional conversationSummary（最多 8 KiB）作週期上下文；Server 驗證 session／baseRevision 後保存，記錄已涵蓋訊息位置。下一輪送已存摘要及尚需的近期訊息，既有最近 12 則／總 32000 字元上限保留。
- summary 禁止 script 寫入、request_validation、瀏覽探索，建議 allowedTools=[]，只根據固定輸入產出結果。Runtime 必須實際限制工具集合，不能只寫 prompt。
- 資料／網頁文字／摘要均為不可信上下文，不是系統指令；Server 才決定 skill／工具與發布資格。
- **現有介面差異需 PM／t32 明定**：Worker 現無 Server 歷史讀取回呼，也不應取得 Manager token。本提案先沿用 session-scoped GET conversation 保留完整歷史供 Web 按需取用；不可宣稱只送 last12 就已實作 Worker 的無限遠端歷史檢索。若 M7 必須新增 Worker 歷史工具，由 t32 一次提出最小需求給 PM 固定，不在此自行建立 token／通用 RPC 框架。

## 5. 驗收摘要任務與發布

新增 `POST /api/tests/:id/draft/summary {editingSessionId,revision,validationRunId}` → 202 `{run:Run}`。相同綁定已有 queued／active job 時回同一 Run；已有合格成功摘要可回 200 原 Run。失敗／取消後可新建摘要 Run，**不重新排 validation**。仍共用 FIFO 與原每 Test 一個未結束 author 的約束。

最少觸發方式：Web 讀到真實 validation succeeded 後呼叫此 endpoint（resume 後若成功驗證未有摘要也呼叫），顯示實際排隊／執行卡片；這使 validation 完成交易不用混入模型或另一套自動排程。endpoint 自身須冪等，不靠 Web 防重。摘要失敗只提供重試摘要動作，不改驗證 Run 結果。

入列時交易核對 active session、目前 revision、script／hash、workspaceSettings／timeout、指定 validationRunId 等於目前草稿驗證且 succeeded、實體 HTML／results.json 證據可讀。Server 讀取該 attempt 已保存 results.json 的有限摘要，核對 artifact size／SHA256，固定實際 stats；不傳整份 HTML／ZIP／trace／任意原始結果給模型。

summary 模式 author.json 建議：

```json
{
  "message": "驗證後摘要已產生，請確認報告與說明。",
  "description": "目的、前置條件、步驟、檢查項目與限制。",
  "backgroundSummary": "提供下一個編輯週期的非機密背景。",
  "name": "可選的候選測試名稱"
}
```

summary 結果嚴格拒絕 script／requestValidation 等不屬於此 mode 的欄位。description、backgroundSummary 必填非空／UTF-8（建議上限各 16 KiB／8 KiB），name 可選且沿用 200 bytes。Skill 定義段落內容，QA 審閱其語意；AI 結果不能證明測試通過。

Server 在 drafts 保存當前 summary_run_id／description／background_summary（候選 name 可同存），不新增一套腳本快照。固定輸入另綁 sessionId、revision、validationRunId、scriptHash、完整設定與**輸入對話的最高 sequence**；完成、發布都要比對。新 user 訊息或一般 edit 回覆令舊摘要失效，但腳本／設定未改時不必重驗。摘要卡片不另寫入會改變此 sequence 的一般聊天訊息，避免摘要自己使自己失效。

`POST publish` 擴為 `{editingSessionId,revision,summaryRunId,confirmed:true}`。同一交易：

1. 保留 M2／M5 的目前 revision、固定腳本／hash、設定／timeout、validation succeeded、報告實體與 QA confirmed 門檻。
2. summary Run 必須是此 session 的 summary mode、succeeded，且上述全部輸入綁定及目前對話位置一致，輸出仍是該已接受摘要。
3. 複製 description／backgroundSummary／summaryRunId／editingSessionId 到不可變 Version；可將 Test.description 同步為目前正式說明的相容投影，但**歷史 Version 不讀取或繼承它**。
4. 更新正式版本指標並關閉 session／移除目前草稿指標。重複同 session/revision/summaryRunId 的 confirmed publish 回原 Version，不建立重複版本。

Version 新增 `description:string|null`、`backgroundSummary:string|null`、`summaryRunId:string|null`、`editingSessionId:string|null`；新發布不可缺摘要，既有正式版可繼續執行。

## 6. discard、取消回收與晚到結果

- 第一次 discard 在 Workspace → Test → Session／Draft 的鎖序下核對目標／revision，先設 discarding，禁止該週期再寫稿、排驗證／摘要、發布。只取消此 session 的 author／summary／validation，不取消正式 Run。
- 原 Cancel 語義不變：queued cancelled；已派送者 cancelling，透過原 cancel envelope 停止／回收。保留草稿及對話直到確認完成。DB／請求失敗不刪草稿，重試同 sessionId 冪等；Manager 離線則顯示待回收，不謊稱成功。
- 完成放棄必須該週期任務全 terminal，且已派送者 slot_released=true（Manager heartbeat 確認回收）；從未派送者不必等 heartbeat。**不能只看 cancelled／succeeded。**
- 回收後才在交易中標 discarded、移除符合 sessionId 的 drafts 指標。伺服器重啟可繼續收尾。建議沿用 Engine Tick 做少量 discarding 檢查；必須在「Manager 不在線即 return」之前執行，讓無任務的放棄也能完成，不另建排程系統。
- ReleaseSlots 目前先鎖 Manager／Run；不能在同交易尾端再鎖 Test／Session。收尾在 commit 後另開正常鎖序的交易，避免和 author 完成的 Test→Run 鎖形成反轉。
- completeAuthor／summary 必須先確認既有 Run／attempt、重複回報與 session，再載入**已存在**的草稿，不能呼叫可初始化的 helper。只有 active、目前 draft.sessionId 相同、revision／context 綁定有效才可套用或續驗證。
- discarding／discarded／published session 的晚到 succeeded 不寫草稿／摘要、不續排任務。沿用取消正規化與 author_reported_status 記錄原始回報，允許相同 result 重送被正常接受；不讓 Manager 因已處理的舊結果無限重連，也不讓新 session 接收舊結果。
- 舊 revision、Session ID、conversation ID、attempt 都檢查；不能只靠其中一個。舊 session 的附件及 Run 結果保留為歷史證據，不能因新編輯週期建立而改綁。

## 7. 舊資料遷移與缺值語義

- 下一號 migration 從現有 drafts 建立一個 legacy active EditingSession，綁定原 conversation（若沒有就建空對話）、目前 revision 與舊 editing Run；不重編訊息、不重排任務。非正式歷史 Run 可歸入該 legacy 週期，正式 Run.sessionId 保持 null。
- 現有但沒有 draft 的空／孤立 conversation 保留原資料，不憑存在就替 Test 建草稿；新週期建立自己的 conversation。無可靠週期歸屬的舊資料不捏造來源版本／摘要。
- 舊 author_payload 缺 mode／session 欄位仍視為 legacy edit；Server 以遷移後 DB run.sessionId 核對，不改舊 payload 內容或原本同 attempt 任務。新 Run 才保存完整 M7 輸入。
- 所有舊 Version 的新增 description／backgroundSummary／summaryRunId／sessionId 預設 **null**；不能拿目前 Test.description 回填成歷史版本說明，也不產生假 AI 摘要。Web 明示「此版本尚無版本說明／背景摘要（舊資料）」；Test 舊說明若要保留呈現，需另標「舊 Test 層說明」，不當作 Version 欄位。
- 現有 revisions、scripts、timeout、Workspace 快照、Run／attempt、發布指標不改；immutable trigger 仍生效。只對新增關聯欄位做必要原子遷移，完成後保護新 Run/session 關聯。M7 新發布一律走新摘要門檻，legacy Version 的繼續執行不是新發布豁免。

## 8. Web／Runtime 必需差異與最小檢查

| Owner | 必需變更 |
| --- | --- |
| Web | 用 Test.activeEditingSession 純讀判斷；明確 start/resume；各寫入帶 sessionId；依 session 分開對話與編輯 Run；summary 真狀態與重試／發布卡片；discard 等待回收；舊 Version nullable 說明明示缺值。 |
| Runtime／Manager | 原 author metadata 新 mode/session/source/summary/skillVersion/allowedTools，journal 原樣保留；summary mode 只產 description／backgroundSummary，不開寫稿工具；保持取消、回收、180000ms、author.json 上傳與去重。 |
| Server | session 及關聯 migration、純讀／明確開始、summary 入列／結果／發布交易、discard durable 收尾；沿用現有 DB/FIFO/WS/附件，不建立完整設定或 workflow 框架。 |

必要檢查只覆蓋新增語義：純讀不增加資料；start/resume 並行唯一；legacy 保留／版本缺值；不同 session／舊 revision／錯摘要／舊成功驗證不能發布；summary retry 不排新 validation；重複結果不重套用；discard 與 result／heartbeat 交錯、重啟、Manager 離線；舊結果不能復活新草稿；正式 Run 與附件保留。實作後做相關 Go 測試／build與一個明確 TEST_DATABASE_URL 的隔離資料層流程；Web／Runtime 由各 owner 驗證，PM／t33 只跑一條 M7 主流程，不重跑 M1～M6。

