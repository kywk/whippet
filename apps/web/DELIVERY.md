# Web M1–M8 交付紀錄

最新日期：2026-11-12（Asia/Taipei）。Owner：Web Agent（t30）。所有新增與修改均位於 `apps/web/`；未執行 Git、未啟動其他 Agent。進度主檔、整合與 commit 由總指揮彙整。M1 整合時由總指揮完成依賴安裝並保留 lockfile；後續沿用既有依賴。下方 M1–M6 保留原階段證據；M7 對編輯週期、草稿建立及發布門檻的覆蓋，以最新契約及本節為準。

## M8 敏感輸入暫停與 offerId 競態修正

2026-11-12，PM t36 明確派修產品缺口。僅修改 `src/live.ts`、`src/LiveView.tsx`，新增 `scripts/check-live-sensitive.mjs`，以及本紀錄；秘密保存 guard、QA／發布及其他頁面未修改。

- 收到當前控制通道的 `state=waiting,reason=sensitive_input` 時，無論原本是否 streaming 都立即進敏感鎖：abort 協商、關閉 peer、停止 tracks、清除 video srcObject／src 並 `load()` 重設解碼器、取消 video frame callback 與播放事件、移除 JPEG src／onload／onerror 並 revoke 舊 objectURL。同步隱藏兩種 media，React paused 狀態也維持 hidden，不只蓋一層文字。
- 顯示 `敏感輸入暫停`，停止 fallback、舊協商觸發的 retry 與模式切換；保留控制 WS／ping 等候恢復。一般 waiting／connecting／streaming、ready、播放按鈕或模式切換不解鎖；敏感期「重新連線」停用，仍可停止或關閉監看。
- pause 缺 viewerId 仍清圖以 fail-closed 相容；有明確錯 viewerId 的事件丟棄。JPEG 只有收到 `state=waiting,reason=sensitive_input_complete,transport=jpeg` 且 viewerId 精確等於 ready.viewerId 才解除敏感鎖，先顯示等待，再由之後新 JPEG 解碼成功標 streaming。舊／排隊 image callback 因 epoch／URL 不符不能復活畫面。
- WebRTC 的正確 viewer complete/webrtc 只開啟等待新 offer 階段，仍保持 paused，不解鎖／不啟 fallback。complete 前的實際 offer（即使新 UUID）都丟棄並記 stale；complete 後只有全新有效 UUID 的實際 offer 才建立新 peer，且仍需真可播放影格才標 streaming。
- complete 若帶 pending offerId，只保存獨立的恢復關聯／epoch；**不寫實際 offer 的去重集合**。因此先收到 complete(ID、尚無 SDP)，後續同 ID 的合法 type=offer 不會被誤拒。已用過的恢復 epoch 不能解開下一次敏感暫停；有關聯 ID 時只採匹配的新 offer，不讓另一個在途 ID 取代。
- answer echo 此次 offerId 及當前 viewerId。每個 setRemoteDescription／createAnswer／setLocalDescription／ICE await 後，都檢查 peer、媒體 epoch、WS generation、協商 controller、active offer、mode 與敏感狀態。舊協商成功／失敗不能把 answer 送給新 offer、改新 peer，或在暫停後觸發 JPEG fallback。
- 無 ID 只相容非敏感初次 legacy offer；見過 ID、切換模式或經敏感暫停後不可降級。舊 ID、mode 期間收到的實際 offer、非法 UUID／SDP 及錯 viewer 不採用。ID 歷史保留於同 Run 的 LiveView，controller 重新建立不會恢復無 ID 降級；沒有新增 UI wire。

### 實際檢查與固定產物

- **定向 client state-machine PASS**：`node scripts/check-live-sensitive.mjs`，14/14 情境、127 assertions、退出碼 0。使用既有 TypeScript、可控制的 WS／RTC／media／時計替身，不連網、不用真秘密、不安裝。覆蓋 streaming 中清畫面／tracks／callbacks、JPEG revoke 及舊 decode 回呼、正確／缺失／錯誤 viewer、普通狀態不能解鎖、complete pending ID 不消耗實際 offer、前後順序／stale 恢復 epoch、四個協商 await、舊 answer／reject、mode 邊界、無 ID 降級與歷史保留、敏感期不 fallback／重連，以及非敏感正常 fallback 和 close 清理。
- **最終 build PASS**：`npm run build`（`tsc --noEmit`＋Vite 7.1.9），退出碼 0，50 modules；CSS 23.49 kB、JS 321.21 kB（gzip 97.18 kB）。新產物在 `apps/web/dist/`，JS 為 `assets/index-CwSWSYQ9.js`；之後僅補交付紀錄，未無變動重建或跑全站。
- 固定檔 SHA256：`dist/index.html`＝`2d026e5e4792dabc855ed000ee479c0198c9397fa61c3ca9ee4132365286f394`；`dist/assets/index-CwSWSYQ9.js`＝`560d23aa39994064ab9f3b1517fe6168f73013ab12d8e24273fa77046bf2415d`。
- 唯讀核對目前 Server：state 由 LiveSession 填 viewerId，offer／answer 透傳 offerId；complete 不提前建立／消耗 offer。Runtime／Manager 要保證 complete 先於新 offer／JPEG，Server writer 的 Messages／Frames barrier 及舊 frame 丟棄由各 owner 負責。raw JPEG 沒有獨立 frame epoch，Web 不能自行猜測來源年代，仍依賴這個已固定的端到端順序，不加私有 wire 或假通過。
- **尚未跑修正後真瀏覽器／真串流／三模組整合**。client 替身測試不等於 GPU/compositor 或實際 Server→Manager→Worker 順序驗收；PM 需納入三個 owner 的新固定產物後再驗敏感期空白、恢復真影格與 JPEG。未部署、Git、讀 env／憑證、改秘密保存 guard／QA 或重跑無關 mock／全站。

黑箱入口沿用 region `唯讀監看`、status `監看連線狀態`／`[data-testid="live-status"]`，暫停可見文字改為 `敏感輸入暫停`。暫停時 `[data-testid="live-video"]`／`[data-testid="live-jpeg"]` 都 hidden，video.srcObject=null、img 無 src；`重新連線`／模式／播放操作不能解除。正確 complete 後 JPEG 先等待新圖；WebRTC 仍 paused 等新 UUID offer，收到 offer 先 waiting、真 frame 才 `監看中：WebRTC`。原生停止／關閉仍可用且不取消 Run。

## M8 前次全鏈 wave：真 UI 旅程與 Workspace author 監看入口

2026-11-12，PM t36。依最新派工交付 `/private/tmp/whippet-m8-wave-web.md`：一條面向 QA 的 Workspace 訪談／範圍確認／角色保存／真探索→AI Test→真驗證報告／摘要／QA 發布→正式 Run／監看旅程，含精確 locator、每步真 API／權威狀態、必要前置及獨立工程師前置分支。這份旅程尚未實跑，不把 18086 A 預覽當 B 證據。

唯讀核對發現實際阻塞：`WorkspaceConversation` 沒有監看入口，但 Server `postgres_live.go` 已支援 Workspace owner、null testId 且具 browser allowedTools 的 author。已在 `src/WorkspaceConversation.tsx` 接上既有 `LiveView`，僅在 aiExploration=true 及已知活躍 Workspace Run 時提供 `開始監看 Workspace Run <UUID>`。是否有 browser／active attempt 仍以此 Run 的 Server LiveTarget 為準，不以能力旗標或 WS ready 假報串流成功；純訪談可明確回不可監看。

選定 Run 不追 latest，未點擊不建立 viewer；返回測試頁／切 Workspace／探索能力撤回時清理活躍連線。Run 終態保留面板供確認。其他三項能力不代替 aiExploration，也不因此阻擋工程師正式 Run 的既有監看。另修正 B 訊息文案，已確認範圍／工具許可內可探索，不再沿 A 文案宣稱完全不會探索；共用 `src/LiveView.tsx` 文案改以 Run 描述，適用 Workspace／測試任務。沒有改播放器真 video／JPEG 成功條件、fallback、敏感輸入遮蔽、HTTP／WS 契約或其他模組。

**最終實際檢查：** `npm run build` PASS（`tsc --noEmit`＋Vite，退出碼 0），50 modules，CSS 23.49 kB、JS 318.20 kB（gzip 96.24 kB），JS 產物 `index-CUGENJtH.js`。入口接線與終態生命週期修正後取得最後證據，沒有無變動重建、重跑 mock／全套 UI、讀憑證、部署／重啟共享服務、Git 或安裝。PM 的 B 固定 Web 產物需納入本輪修正；新版 Workspace LiveView、真 API／模型與這條完整旅程仍待 PM 環境及指定 QA 黑箱驗收。

## M8 B 前次來源與分能力接線（模組檢查通過，整合待驗）

日期：2026-11-12。依 PM t36 固定的 v8「B 來源、能力與確認快照」接線，只改 `apps/web/`。本輪完成 Web 欄位解析、動作判斷與顯示，不表示 M8 B 真登入／執行／監看全鏈或 M7 尚缺整合已驗收。18086 未由本 Agent 部署、重啟或當作 B 新版證據。

### 權威來源及動作判斷

- Draft／Version／Run parser 接 `scriptOrigin=ai/manual/legacy`，只採 Server 回傳；缺值保留 unknown，非法列舉拒絕。顯示「工程師手動修改」、「AI 修改」、「來源未記錄（不視為人工）」或「來源未知（API 尚未提供）」，legacy 不默認人工來源。
- Workspace 接四項 `capabilities.{aiExploration,aiExecution,manualExecution,credentialLogin}`，各含 available／nullable reason。缺整組、單項或必要值時顯示未知，不從舊 OR 旗標、設定是否已確認、是否有密文、AI 文字或本機入口推算允許。舊 executionAvailable／unavailableReason 只解析為相容資料，已不參與 UI 執行 gate。
- 手動來源選 manualExecution；ai 與 legacy 選 aiExecution；來源未知不選任何執行能力。草稿 validate／publish 使用目前草稿的權威來源；正式 Run 使用目前發佈 Version 的來源。檢視另一個歷史版本不會改變正式執行的能力判斷。
- 相應能力 available=true 時恢復動作，但仍保留已發布指標、revision／設定衝突、未存內容、真 validation／HTML 報告、有效摘要與 QA 勾選等原門檻。handler 也檢查資格；不是只換按鈕樣式。來源改變或對應可用狀態改變會清除原 QA 確認。Workspace 能力不是個別 Run 通行證，最終快照／角色一致性由 Server 逐次核對。
- 工程師入口與本機操作模式不寫來源。PUT 草稿、訊息、validate、summary、publish 請求都不增加 scriptOrigin；原樣儲存回應仍沿 Server 原來源／revision，實際變更後也只顯示 Server 接受的來源。設定／角色同步同樣沿 Server 回應，不因新增 revision 自行改為人工。
- 已保存來源與本機尚未儲存的手動／候選操作分開提示。一般模式腳本仍唯讀；草稿、各歷史 Version 及 Run 快照均顯示來源，避免把 AI 撰寫 Run 的輸入快照誤當成已接受輸出。

### AI 探索與角色登入分開顯示

- Workspace 能力區逐項顯示 AI 探索、AI 腳本執行、工程師腳本執行及角色登入的真狀態／原因。測試對話及提案範圍確認區一律顯示 aiExploration，人工來源不會讓 AI 工具繞過此能力。
- aiExploration 不可用或未知不封鎖純訪談／離線改稿；沒有把 scope 確認、訊息送出或摘要完成當成已探索、通過測試或可發布。沒有新增私有登入 schema、Manager 解析端點或憑證傳遞協定。
- credentialLogin 與帳密保存分開。專用表單仍依 secretsAvailable、保護傳輸及真角色版本保存；不能因 helper 尚未就緒而假稱不能保存，也不能因 credentialLogin=true 就把每個 role 當成 configured。逐角色 ref／version／configured 仍由 API 回傳，實際登入許可另由 Server 核對。
- 沒有加入 AST 子集、network=none／代理平台、HTTP 協定降級或登入後全面禁 DOM／影像。既有 LiveView 媒體成功條件與敏感值專用流程沒有修改，未削弱 M7 真報告／人工發布條件。

### 檔案與實際檢查

新增 `src/capabilities.ts`。修改 `src/types.ts`、`src/api.ts`、`src/App.tsx`、`src/TestWorkspace.tsx`、`src/DraftEditor.tsx`、`src/ConversationPanel.tsx`、`src/WorkspaceSettings.tsx`、`src/WorkspaceProposal.tsx`、`src/WorkspaceCredentials.tsx`、`src/RunHistory.tsx`、`src/TestActions.tsx`、`src/styles.css`、`scripts/check-workspace-api.mjs`、本紀錄。後端／Runtime、契約／docs、部署、依賴／lockfile、LiveView／live.ts 及摘要生成元件均未修改。

- **最終 build PASS**：`npm run build`（`tsc --noEmit`＋Vite `7.1.9`），退出碼 0；50 modules，HTML 0.55 kB、CSS 23.49 kB、JS 317.45 kB（gzip 96.27 kB）。通過後僅補交付紀錄，不追加無變動重建。
- **定向 API／能力檢查 PASS**：`node scripts/check-workspace-api.mjs`，48 checks、退出碼 0，全為合成 fetch／純函式，沒有連網或真秘密。新增檢查涵蓋 OR=true 但 manual 可執行／ai 與 legacy 不可、AI 探索不替代 AI 執行、來源／能力／reason 缺值不放行、partial 能力獨立保留、非法來源拒絕、Draft／Version／Run 來源解析，以及 no-op／真變更的合成 Server 回應被保留且請求不帶來源。這些不代替 Server 真資料庫的來源交易測試。
- 唯讀核對 Server `model.go`、`execution_gate.go`、`drafts.go`：目前新增 JSON 欄位命名及四項 `{available,reason}` 與固定契約相符；來源由 Server 寫入路徑／快照決定。未假定 Server 已部署，沒有未決欄位差異。
- 未安裝、Git、讀 env／真憑證、呼叫模型、部署／重啟共享服務、啟動其他 Agent、跑瀏覽器或無關全套測試。新版真 API／瀏覽器與 Runtime 整合仍交由 PM 固定產物環境驗收；本輪沒有補稱來源遷移、角色登入或真站操作通過。

### B 黑箱可見標籤

| 對象 | 標籤／scope | 預期 |
| --- | --- | --- |
| 四項能力 | region `Workspace 能力狀態` | 分開顯示 `AI 探索`／`AI 腳本執行`／`工程師腳本執行`／`角色登入`，狀態為可用、尚未就緒或未知 |
| 正式版本 | region `測試一般模式` 內 `目前正式版本來源：…`、`正式版本執行：…` | button `執行正式版本` 依目前發布版，選歷史版不洗 gate |
| 草稿來源 | region `對話編輯工作區` 內 `已儲存腳本來源：…` | 與 `本機操作：…尚未儲存` 分開；進階入口切換不改來源 |
| 草稿能力 | `此草稿對應執行能力：…` | manual 用 manualExecution；ai／legacy 用 aiExecution；unknown 暫停 validate／publish |
| AI 續編 | region `AI 測試對話` 內 `AI 探索工具：…` | 不能因人工來源放寬 AI 工具，未知／false 時仍可離線訪談 |
| 歷史 Version | `[data-version-id="<UUID>"]` 內 `版本腳本來源：…` | legacy 明示不視為人工，唯讀檢視不改歷史來源 |
| Run 快照 | 正式／編輯 Run region，table `[data-run-id="<UUID>"]` | 顯示 Server 快照來源；歷史結果不依目前草稿重算 |
| 登入與保存 | region `專用登入資料` 內 `角色登入：…` | 登入能力／保存傳輸／逐角色 configured 各自判斷，不假登入成功 |

## M8 B 前次介面準備：工程師手動入口與 AI 續編（固定 wire 前）

日期：2026-11-12。依 PM t36 最新派工及 `requirements/ai-workspace.md`／`design.md`／`contracts/mvp-v8.md` 頂部 B 裁定，僅整理不依賴新 API 的編輯介面。工程師腳本不套 AI 網站範圍限制；保留完整 Playwright／Node，以及原 revision、真報告與 QA 發布條件。沒有沿用舊全代理／network=none／AST 子集方案，也沒有把本輪準備宣稱為 B 執行功能完成。

- 編輯模式的 AI 對話標題旁加入「工程師手動修改」，直接展開「工程師手動修改（進階）」並將焦點移到腳本。一般模式正式／歷史腳本仍唯讀，沒有在一般模式增加寫入入口。
- 手動區加入「回到 AI 續編」：只回到既有對話輸入，不自動保存、放棄或送出內容。AI 續編繼續使用已保存 revision；本機未存腳本仍阻擋送訊息，原 revision／設定衝突保護不變。
- 只記錄本頁 UI 操作方式（手動修改／帶入 AI 候選），明示尚未儲存；已保存來源明示「目前 API 尚未提供」。開啟／切回入口不改變已存來源或取得執行許可。沒有新增 `scriptOrigin` 或其他私有 wire 欄位，也不把本機 manual 字樣當權威來源。
- AI 續編提示：無論原稿來源，AI 探索工具仍以 Workspace 已確認網站與必要相依服務為範圍。手動區保留完整腳本輸入，不新增語法／AST／協定限制。
- 原 `executionAvailable` 是讀 Server 的動態值，並非永久寫死 false；尚未固定分能力欄位前沒有猜測 fallback。PM 已確認將一次固定 AI 探索／AI 執行／工程師執行的個別能力，以及 Draft／Version／Run 的 ai／manual／legacy 權威來源；固定後再接線，legacy 不自行當成 manual。
- 專用帳密流程、LiveView 及 Runtime 敏感輸入遮蔽邊界沒有修改；沒有把登入後 DOM／影像一律停用。18086 A 預覽維持原產物，沒有部署。

本輪修改：`src/DraftEditor.tsx`、`src/ConversationPanel.tsx`、`src/WorkspaceSettings.tsx`、本紀錄。未改 API／型別／後端／Runtime／契約／部署。

**實際檢查：** `npm run typecheck`（`tsc --noEmit`）PASS、退出碼 0；直接檢視入口、焦點跳轉與原導覽防護的程式路徑。本輪沒有重建 Vite／全站、重跑 API smoke、啟動瀏覽器、安裝、Git、讀真憑證或重啟服務。前一節 A 的 build 證據只證明 A 當時產物，不當成本輪新畫面或 B 的真 API／UI 驗收。介面目視及分能力／來源接線仍待後續整合。

黑箱標籤：編輯模式可見 button `工程師手動修改` → details `工程師手動修改（進階）` → textbox `Playwright TypeScript 腳本`；button `回到 AI 續編` 導向 textbox `測試需求或修改訊息`。保留 button `儲存草稿`／`送出訊息`；來源提示清楚分開「已儲存腳本來源：目前 API 尚未提供。」與「本機操作：…，尚未儲存。」。一般模式 textbox `正式版本腳本（唯讀）`／`歷史版本腳本（唯讀）` 仍 readOnly。

## M8.2 前次 A 接線交付（模組檢查通過，真實整合待驗）

日期：2026-11-12。PM：t36；Web owner：t30，只修改 `apps/web/`。依 `contracts/mvp-v8.md` 頂部 A／B 裁定、固定 HTTP 包裝、共同界限與 credentials 版本規則接線。**本節只交付 Web 的 A 實作與模組證據；M8 未完成，B 的受限探索／登入／安全證據仍待完成，M7 整體 UI／真 AI 全鏈驗收也仍待補。** 沒有將 18085 當作新版 M8 或將本機 build 當作整合成功。

### 目前可操作的接線

- 真 `POST /workspaces {name?}` 建立 draft／unconfirmed 工作區，再載入專屬設定對話。名稱可留空交 Server 命名；非空輸入先檢查 trim 後最多 200 UTF-8 bytes，不截斷。建立結果未確認時保留輸入並提示先查真列表，沒有假建立成功。
- 真 `GET /workspaces` 列表／切換與建立回應合併，所有 Workspace 狀態來自 API。設定對話用自己的 GET／POST messages，送設定 revision 與 contextRevision，不用假 Test／EditingSession，不混入測試對話。
- Workspace 訊息由 Server 持久保存，重開／重新登入／切換後可 GET 恢復。送出後追蹤真 `Run.workspaceId`、nullable testId 與 authorMode=workspace；讀取回應不符合 owner 時拒絕。每 2 秒只對已知 Run 做短輪詢，終態再重載真對話／設定／提案；可取消任務，不提供 Workspace 訪談的瀏覽器監看或測試報告。失敗要使用者明確再送訊息，不自動重跑 POST。
- 待審提案與「目前正式設定（唯讀）」分開；完整列出名稱、驗測目的、背景、target／dependency 用途及 origin、排除項、角色、預設 URL／timeout。提案 pending／applied／cancelled／stale／superseded、scopeConfirmed、invalidationReason、appliedRevision 都讀 Server，不從 AI 文字判定確認完成。
- 操作送固定的 proposalId／baseRevision／confirmed:true。QA 勾選已檢視範圍／角色後才可確認範圍或套用；scope 確認只顯示確認已保存，明示**不代表已探索或啟用設定**。正式套用以真 `{workspace,proposal}` 更新；取消先明確確認，現行設定不被候選稿取代。409／未知結果不自動重送，要求重載最新權威狀態。
- 套用前明示現有草稿須重新驗證、歷史版本／Run 快照不改；缺 target、驗測目的或背景時阻擋正式套用並提示透過對話補齊。候選內容不由前端截斷、合併或移除 origin；Server 拒絕欄位／集合衝突時顯示錯誤及修正提示，不放寬範圍。
- `executionAvailable=false` 明示「設定可保存，受限探索／執行尚未就緒。」並顯示真 unavailableReason；scopeStatus=revoking 不宣稱既有連線已全停止。正式 Run、草稿 validate 與新 publish 停用，且動作 handler 亦檢查。仍可離線對話讀稿／改稿及讀歷史；摘要完成不表示可發佈。Server 的 `503 security_unavailable` 沿錯誤路徑顯示，不當成空資料、成功測試或假排程，不自動重試寫入。
- 舊設定只讀 canonical settings；settings=null 時獨立呈現 legacy sites／URL／timeout，明示尚無已確認設定，不推定 scope。沒有 M5 可寫表單或 PATCH 呼叫入口；舊 API 宣告暫留，Server 的 405 proposal_required 為最終權威。

### 專用登入資料與傳輸

- `Workspace.roles` 是唯一可操作角色參照；角色名稱／login origin 只從正式設定或提案讀取，不讓使用者／AI 自填別的 Workspace secret ref。專用表單只收 username/password，PUT body 不包含一般訊息、設定或任意欄位；GET 只顯示 ref／version／configured，不讀回帳密。
- expectedSecretVersion 必為非負整數。GET secretVersion=null 時首次請求送 0，但畫面仍顯示「尚無」保存版本；已有版本即使 configured=false 也送原版本，不因撤銷重設 0。版本過期 409 不自動重送，重載角色後才能明確重試。
- UI 與 API 方法兩層檢查 HTTPS 或明確 localhost／127.0.0.1／[::1] loopback；任意遠端明文 HTTP 不接受輸入／保存。不信任主機名稱前綴或 userinfo。敏感 fetch 設 `redirect:error`、`cache:no-store`，不跟隨重新導向轉送秘密 body。
- 帳密只留必要表單記憶體與專用 request body，不進一般對話、URL、localStorage／sessionStorage、console、模型、腳本或提案。成功立即清空；離開 Workspace 畫面會卸載機密表單並清空，未存帳密先確認；一般未送訊息則可保持掛載。回應錯誤使用固定安全文案，不把可能回顯 body 的錯誤 message 插入 DOM。
- `secretsAvailable=false` 阻擋保存，configured=true 只表示已有密文，不等於目前可解密或登入。撤銷要確認並送回目前版本，收到權威回應後重載 refs；不宣稱已完成 B 的租約、登入或既有連線回收。
- **部署接縫（已回報且 PM 確認）**：Server 現行 `protectedCredentialTransport` 只信 r.TLS，或 Host 與 RemoteAddr 都為 loopback。瀏覽器 localhost→Nginx→bridge Server 不保證通過；Web 預檢不是 Server 授權。API 若回 protected_transport_required，顯示需部署者提供受保護入口，沒有信任任意 forwarded header 或放寬 remoteaddr。TLS／healthcheck 由 Server owner 與 PM 處理，本輪沒有自行部署。

### 產物、實際檢查與剩餘限制

新增 `src/WorkspaceProposal.tsx`、`src/WorkspaceCredentials.tsx`、`scripts/check-workspace-api.mjs`。修改 `src/WorkspaceConversation.tsx`、`src/WorkspaceSettings.tsx`、`src/App.tsx`、`src/types.ts`、`src/api.ts`、`src/components.tsx`、`src/TestWorkspace.tsx`、`src/DraftEditor.tsx`、`src/mock.ts`、`src/styles.css`、本紀錄。沒有改 `LiveView`／`live.ts`／摘要生成元件、後端／Runtime、契約／docs、Docker／Nginx 或依賴／lockfile。新增 publish 能力門檻保留 M7 原有真驗證／報告／摘要／QA 門檻，沒有弱化。

- **最後程式版本 build PASS**：`npm run build`＝`tsc --noEmit`＋Vite `7.1.9`，退出碼 0；49 modules，HTML 0.55 kB、CSS 23.27 kB、JS 312.84 kB（gzip 94.84 kB）。原建置後 PM 新增安全能力下 publish 限制，完成這項受影響修改後取得此最終建置證據；通過後不做無變動重建。
- **定向 API 邊界檢查 PASS**：`node scripts/check-workspace-api.mjs`，29 項合成檢查、退出碼 0。沿用已宣告 TypeScript 工具，stub fetch、不連網、不使用真憑證。檢查固定單一回應包裝、Workspace Run owner／null testId、缺必要欄位拒絕、POST body、credential HTTPS／loopback 與假 loopback 拒絕、0／既有版本、null 版本拒絕、不跟隨 redirect／no-store、錯誤不回顯合成秘密、409 只送一次。加入敏感 redirect 保護後更新相應檢查；未重跑無關全套。
- 唯讀核對 Server `workspace_http.go`、`workspace_store.go`、`workspace_interviews.go`、`workspace_config.go` 的包裝／欄位／scope 與 credential 交易。發現首次 expectedSecretVersion 差異後已由 PM 固定 0 規則，Web 同步；目前無未決 wire shape 差異。
- opt-in mock 對新建／持久設定對話／proposal／credentials 明確回 MOCK_WORKSPACE_UNAVAILABLE，不假保存或假確認；沒有真 API 失敗自動切 mock。mock 靜態舊 Workspace 亦標 needs_confirmation／executionAvailable=false。
- **尚未執行新版真 API／PostgreSQL／瀏覽器／真模型 A 整合**：本輪證據是模組 build 與合成 API 邊界，不是 UI 操作或 AEAD／多 Workspace 真實隔離驗收。待 PM 以新版 Server／Runtime 的隔離環境接續，受保護 credential 入口也待部署安排。18080／18085 未被更新或當成本輪驗收來源。
- 未安裝、Git、讀印 env／真憑證、部署、重啟共享服務、啟動其他 Agent 或呼叫模型。B 的受控網站探索／帳密登入／lease／可信 IPC／安全證據仍未由本模組宣稱完成；M8 不因 A 接線或停用執行而結案。

### A 黑箱標籤／locator

| 對象 | Accessible 名稱／屬性 | 驗收重點 |
| --- | --- | --- |
| 真建立 | button `建立 Workspace` → textbox `Workspace 名稱（選填）` → button `建立並開始訪談` | 真 POST，draft，不探索／不啟用；未知結果保留輸入 |
| 列表切換 | combobox `Workspace` | 真 GET 列表及建立結果；切換有未存防護 |
| 持久工作區 | button `Workspace 設定`；region `Workspace 對話：<名稱>` | 設定訪談與 Test 對話分開，重開 GET 恢復 |
| 重載 | button `重新載入設定對話` | 純讀權威 Workspace／Conversation；409 後先重載 |
| 訊息 | list `已儲存的 Workspace 訊息`；textbox `Workspace 需求或修改訊息`；button `送出 Workspace 訊息` | 帶 revision/contextRevision；不附專用帳密 |
| 真任務 | `設定訪談狀態`、`訪談完成`；button `取消 Run <UUID>` | Workspace owner、null testId、無監看／假報告 |
| 提案 | region `設定提案（待審內容）`；`data-proposal-id=<UUID>` | 真狀態、完整內容、base revision／失效原因，與正式設定分開 |
| QA | checkbox `我已檢視目標、相依範圍、角色與設定提案` | 未勾選不可 scope／apply；未完整提案不能正式套用 |
| 範圍確認 | button `確認提案範圍` | 真 scopeConfirmed；訊息明示不代表已探索 |
| 套用／取消 | button `確認並套用提案`／`取消提案` | 套用真回應；取消另需原生確認，正式設定不被候選稿取代 |
| 正式設定 | details `查看目前正式設定（唯讀）`；region `目前正式設定（唯讀）` | settings 為 canonical，null 時只顯示舊資料並標範圍未確認 |
| 能力未就緒 | status `設定可保存，受限探索／執行尚未就緒。` | 正式 Run／validate／publish disabled；摘要不是可發布證明 |
| 角色參照 | region `專用登入資料`；combobox `登入角色` | 只操作真角色 ID，顯示 ref/version/configured，不能讀回明文 |
| 專用保存 | textbox `登入帳號`、密碼 label `登入密碼`、button `保存登入資料` | 僅保護傳輸可啟用；預檢通過仍可被 Server 拒絕 |
| 撤銷 | button `撤銷登入資料` | 原生確認、版本不重設 0、沒有自動重送 |
| 返回 | button `返回測試工作台` | 一般未送文字保留；未存帳密確認後清空；進行中的寫入完成前 disabled |

## M8.2 前次首切片（v8 固定前）：Workspace 對話工作區結構

日期：2026-11-12。PM：t36；Owner：Web t30，僅 `apps/web/`。依最新派工與 Workspace 規格準備 UI；本輪尚無固定 `contracts/mvp-v8.md`，沒有發明 HTTP／模型輸出／secret wire schema。M7 現況雖已由 PM 提交 `bc5f86d`，**M7 整體 UI／真 AI 全鏈驗收仍未完成**；本切片不改寫該狀態，也不代表 M8 功能完成。

### 本切片產物

- 新增 `src/WorkspaceConversation.tsx`：獨立建立／修改工作區，與 Test 腳本對話分開。包含 Workspace 名稱、網站用途與驗測目標、非機密背景／排除事項、分開的目標網站與必要相依服務備忘、一般訊息輸入、提案確認卡片與未開放的專用機密區。
- 上述輸入只是本頁 React 記憶體備忘，不是已保存設定、不會送入模型／HTTP／URL／localStorage／console。可新增／移除網站備忘及確認清除本頁內容。目標與相依服務明確分組，填寫 origin 不視為探索授權。
- 「送出 Workspace 訊息」、「確認初始目標並探索」、「確認並套用提案」、「取消提案」及「新增登入資料」全部停用。明示服務尚未串接，尚未送出、建立或保存；沒有假訊息、假 Run、假提案、假確認、假成功或假範圍限制。
- 機密區沒有可輸入秘密值的 input。一般訊息／背景／網址欄位說明不可填帳密、token 或 key；尚未實作 secret 保存／取得，也不收集真憑證。
- 依 PM 本回合裁定，`src/WorkspaceSettings.tsx` 由 M5 寫入表單改為唯讀的「目前設定摘要」。只沿用既有 GET 設定快照，明示「既有設定／新版範圍尚未確認」，不將舊 sites 推論成 target/dependency 或已授權 scope。移除舊表單的可操作寫入路徑；不以 PATCH 繞過提案確認。API 層的舊 PATCH 宣告暫留，待 v8 裁定相容／拒絕策略，UI 沒有呼叫入口。
- `src/App.tsx` 加入「建立 Workspace」及既有「Workspace 設定」轉接。Workspace 與測試工作台一次只顯示一種對話；進 Workspace 前沿用 Test 的未存腳本／未送訊息／進行中操作確認，接受離開後卸載測試工作台，原有監看依既有卸載流程清理，沒有修改 LiveView／summary。
- Workspace 本頁內容在「返回測試工作台」後仍保持掛載但隱藏，重開同一工作區可取回未送出備忘；beforeunload 保護持續有效。換 Workspace、切換建立／修改目標、返回登入／首頁時，對將遺失的內容提示確認。只以記憶體記住各 Workspace 上次選定 Test，返回測試工作台時重新讀取 Server 保存資料；接受離開確認的 Test 本機未存編輯不宣稱已保存。
- `src/styles.css` 沿用既有色彩、字級與控制項，Workspace 區使用訪談／提案兩欄，窄螢幕合併單欄。沒有重設全站或新增依賴。

修改檔案：新增 `src/WorkspaceConversation.tsx`；修改 `src/App.tsx`、`src/WorkspaceSettings.tsx`、`src/styles.css`、本紀錄。未修改契約／docs／後端／Runtime、M7 編輯與摘要元件、LiveView、Docker／Nginx 或依賴／lockfile。

### 實際檢查與待接線

- **必要 Web build 一次 PASS**：`npm run build`，完整 `tsc --noEmit`＋Vite `7.1.9`，退出碼 `0`；47 modules，HTML 0.55 kB、CSS 22.61 kB、JS 290.48 kB（gzip 88.97 kB）。通過後僅補文件，未無變動重建、未跑無關全套測試。
- 直接檢視本切片 source，並以 `rg` 確認 Workspace 元件與 App 沒有 `updateWorkspaceSettings` UI 呼叫、直接 fetch、新 API 字串、localStorage／sessionStorage、console 或 password input。這是靜態檢查，不等於瀏覽器或資料外洩測試通過。
- 本輪未安裝套件、Git、讀印 env／真憑證、呼叫模型、啟動瀏覽器、部署或重啟 `18080`／`18085`。新版 UI 目視、切換／離開確認與黑箱操作尚未實跑；不得以舊部署或本機建置取代整合驗收。
- 已透過 `hc send t36` 回報 UI 需用欄位：Workspace lifecycle／目前 revision、設定對話 ID／訊息／active Run、目標與相依 origin／用途／確認狀態、proposal ID／base revision／真狀態／內容／失效原因、非機密登入角色與 secret ref／是否設定、確認／取消／重試的權威結果。這是 UI 所需語意，不是自行固定 wire schema。
- 待 PM 固定 v8 後：串接持久對話／建立與修改、目標確認、真探索 Run 狀態、proposal revision 衝突與明確確認、secret 專用保存與僅參照顯示、多 Workspace 授權隔離。現有唯讀 GET 未具備的新欄位一律顯示尚未提供，不以備忘或舊設定補造。

### 首切片黑箱標籤

| 對象 | Accessible 名稱／可見文字 | 目前可觀察行為 |
| --- | --- | --- |
| 工作區切換 | combobox `Workspace` | 真列表；切換前保護會遺失的未送出內容 |
| 建立入口 | button `建立 Workspace` | 開本頁備忘，沒有建立請求或成功通知 |
| 修改入口 | button `Workspace 設定` | 轉接獨立對話，不開舊可寫表單 |
| 設定工作區 | region `建立 Workspace`／`修改 Workspace：<名稱>`；`#workspace-conversation` | 與 Test 對話分開顯示 |
| 返回 | button `返回測試工作台` | 保留 Workspace 本頁文字，重新讀取已保存 Test |
| 未接線狀態 | status 文字 `尚未串接 Workspace 對話服務。…` | 不會標示 AI／儲存／探索完成 |
| 本頁目標與背景 | textbox `Workspace 名稱`、`網站用途與驗測目標`、`非機密背景與排除事項` | 本頁記憶體，不是已保存資料 |
| 網站分組 | details `預計目標網站與必要相依服務`；button `加入目標網站備忘`／`加入相依服務備忘` | 分開記錄名稱／origin／用途，不授權探索 |
| 一般訊息 | textbox `Workspace 需求或修改訊息` | 可保留未送出文字，送出按鈕 disabled |
| 提案區 | region `設定提案` | 真提案尚未取得；探索／套用／取消均 disabled |
| 專用機密區 | region `專用機密輸入`；button `新增登入資料` | disabled，沒有秘密值輸入欄位 |
| 舊設定 | region `目前設定摘要`；button `重新載入設定摘要` | 僅真 GET，明示舊資料／範圍未確認，沒有儲存按鈕 |
| 清除備忘 | button `清除本頁未送出內容` | 確認後只清本頁，現有設定不變 |

## M7 前次交付：一般／編輯模式與明確編輯週期（模組建置，整合待驗）

Owner：Web；PM：t36。依 `docs/requirements/ai-workspace.md`、實作計畫 M7 與 `contracts/mvp-v7.md` 頂部固定決策實作，載入 impeccable 與 React best practices 技能。沿用既有 React／Vite 依賴；未安裝套件、Git、讀取 env／憑證、呼叫模型、部署或重啟任何服務，未擴張 M8。沒有把 `18080` 的舊部署當作新版驗收。

### 產物與行為

- 一般模式依序呈現測試標題、所選版本說明、最近一次正式執行、正式執行歷史、歷史版本與所選版本唯讀腳本。正式歷史只納入 kind=run（沿用缺 kind 的 legacy 正式 Run），排除 author／validation。歷史版本選取只改唯讀檢視，正式執行仍使用 Server 的目前發布版本。
- 未發布 Test 顯示正式說明／腳本／執行空狀態並停用正式執行。版本說明與背景只讀取各 Version 自己的 nullable 欄位；舊版本顯示「此版本尚無版本說明（舊資料）。」／「此版本尚無背景摘要（舊資料）。」，不以 Test.description 冒充歷史版本資料。
- 「新增測試」直接以空輸入建立 Test，再明確 start 編輯週期；不要求先填名稱表單。Server 的「未命名測試」及候選摘要名稱是真實資料，前端不自行套用候選名稱。
- 一般模式以 Test.activeEditingSession 純讀欄位決定修改／繼續修改／查看放棄進度，不呼叫 GET draft 或 conversation 探測是否存在。欄位尚未取得時顯示未知，不當成不存在。草稿只是一列 UI，不建立假 Version。
- 進入編輯模式明確 POST start／resume；同一週期接續完整草稿及對話。所有儲存、訊息、驗證、摘要與發布請求帶 editingSessionId。對話 GET 帶 session query，parser 核對回應 session；草稿 GET 亦核對 session，避免前一週期內容混入。
- 右側編輯模式以對話為主要工作區，整合來源版本／本次對話背景、目前週期 author／validation／summary 紀錄、驗證報告、原有監看與取消、腳本前後對照、手動腳本摺疊區及發布確認。摘要任務顯示「驗收摘要」，不假裝聊天回覆，也不提供沒有瀏覽器的摘要監看入口。
- 返回一般模式會保留已掛載編輯器的本機腳本與未送出訊息；切 Test／離開時沿用導覽及 beforeunload 防護。切換模式會卸載監看連線，保留 Run 選定語義。一般模式不展示草稿編輯器。
- 保留 revision 衝突及 Workspace 設定同步的未儲存內容保護：較舊 revision 回應不回退目前編輯器，外部更新不靜默覆蓋本機文字；資格失效時阻擋訊息／驗證／發布，要求檢視與重載。單純 metadata 更新不取代本機未儲存腳本。
- 只有目前草稿真實 validation succeeded 且 reportUrl 就緒後才呼叫冪等摘要 API；重開 active session 也檢查。自動請求以 session、Server contextRevision、revision、validationRunId 及摘要 Run 防重；因此相同腳本但新對話仍能重新建立摘要。失敗／取消／逾時／中斷或未知 POST 結果顯示明確重試，不以輪詢無限重送，也不重跑成功 validation。
- 摘要使用 Server 的 Run 狀態、validForCurrentDraft、綁定 revision／validationRunId 及非空 description／backgroundSummary；不從 AI 文字推定成功。送出新訊息立即清除本機發布確認，待權威 session 更新後才重新判斷。描述／背景以純文字顯示，不解析 HTML。
- 發布需目前驗證、報告及有效摘要全部合格，且沒有未存腳本、未送訊息或進行中操作，再由使用者勾選 QA 確認；送出 revision、sessionId、summaryRunId、confirmed:true。收到真實 Version 才切回一般模式並刷新 Test／Version；不自行關閉尚未確認成功的週期。
- 刪除草稿先讀取目標週期及 revision，再用原生確認對話框說明影響並要求確認。POST 後以純讀 session 端點確認實際狀態；discarding 保留草稿／本機內容、停用寫入，輪詢僅 GET 進度並顯示 pendingRunIds／reclaimPending。只有 Server 回 discarded 才卸載編輯器；Run terminal 或取消成功本身不視為回收完成。失敗保留草稿與可重試入口，正式 Run／Version／附件不受影響。
- opt-in mock 對 M7 start/session／summary 明確回不可用錯誤；沒有假刪除、假摘要、真 API 失敗自動切 mock 或假完成狀態。預設仍是真 API。

新增：`src/TestWorkspace.tsx`、`src/RunHistory.tsx`、`src/AcceptanceSummary.tsx`、`src/DiscardSessionDialog.tsx`。

修改：`src/App.tsx`、`src/DraftEditor.tsx`、`src/ConversationPanel.tsx`、`src/TestActions.tsx`、`src/types.ts`、`src/api.ts`、`src/components.tsx`、`src/mock.ts`、`src/styles.css`、本紀錄。沒有修改 Server、Runtime、契約、docs、依賴／lockfile、Dockerfile、Nginx 或既有 LiveView 的媒體成功條件。

### M7 實際檢查、串接與限制

- **最後程式版本 build PASS**：`npm run build`，`tsc --noEmit`＋Vite `7.1.9`，退出碼 `0`；46 個模組，HTML 0.55 kB、CSS 20.18 kB、JS 287.20 kB（gzip 88.18 kB）。只檢查受影響 Web；通過後僅補交付文件，沒有無變動重建或全套 E2E。
- 已完整讀取 M7 契約，並唯讀比對 `services/server/internal/server/editing_http.go`、`editing_sessions.go`、`summaries.go` 的 session／discard／summary 回應與交易門檻；目前 wire shape 相符。Server 額外回傳的 contextRevision 只讀取，不由 Web 編造或送出。
- 已檢視既有基線截圖 `/private/tmp/whippet-m5-settings-evidence/m5-unsaved-retained.png` 與 `/private/tmp/whippet-m6-download-evidence/m6-evidence.png`，據此拆分原長頁的操作層級。這些是舊 UI 證據，不是 M7 新畫面的瀏覽器驗收；本輪未自行啟動預覽服務。
- **PM t36 回報**：M7 真隔離 PostgreSQL lifecycle／legacy 兩案 PASS、無 skip，Runtime dist＋skills 與 manager-m7 已固定。此為 PM 提供的後端／Runtime 整合進度，Web 未重跑，不能取代新版 UI 的驗收。
- **待新版隔離 API＋瀏覽器整合**：新增→對話／人工腳本→驗證報告→摘要→QA 發布→正式執行；resume/reload 週期隔離；摘要失敗只重試摘要；同腳本新對話令摘要失效；active 任務 discard 等 heartbeat 回收；一般／編輯切換與未存保護；桌面／窄螢幕、鍵盤與對話框焦點。交由 PM／指定黑箱驗收執行，未宣稱這些已由本輪瀏覽器跑過。
- 若新版 API 尚未部署或回舊 schema，會顯示讀取／週期錯誤並停用不合格發布，不作相容假成功。GET activeEditingSession 缺值保持未知；Version 新欄位缺值保持 null 舊資料語義。
- M7 沿用有界週期摘要＋近期訊息；完整歷史仍由 session-scoped Web GET 保留。Worker 按需遠端歷史工具屬 M9，未宣稱完成。M8 Workspace 機密／scope、API key UI 亦未新增。

### M7 黑箱標籤／locator

一般模式與編輯模式都可能仍掛載，請以可見 region 為 scope；不要從舊 18080 驗收。表格標題含動態筆數時使用名稱前綴。

| 對象 | Accessible 名稱／可見文字或屬性 | 驗收重點 |
| --- | --- | --- |
| 建立 | button `新增測試` | 不先開名稱表單，建立後進編輯；未知結果先查列表 |
| 一般模式 | region `測試一般模式`；`[data-mode="general"]` | 一般模式可見，草稿編輯區隱藏 |
| 進入／接續 | button `修改腳本`／`繼續修改` | 明確 start／resume；未知 pointer 時為 `開啟編輯工作區` |
| 開始失敗後重試 | button `開始或接續修改` | 不以錯誤當成已成功建立週期 |
| 正式執行 | button `執行正式版本` | 未發布 disabled；不執行所選歷史版本 |
| 正式結果與歷史 | region `最近一次正式執行`；region 名稱前綴 `正式執行歷史` | 排除 author／validation；列有 `data-run-id` |
| 版本說明 | heading `版本說明`；details `查看版本背景摘要` | 只顯示所選 Version 的獨立欄位及舊資料缺值 |
| 版本列表 | region 名稱前綴 `歷史版本`；`[data-version-id="<id>"]` | 草稿列來自 activeEditingSession，不是假 Version |
| 選版本 | button `檢視版本 <完整版本 UUID>` | aria-pressed 表示選定；`回到目前正式版本` 還原 |
| 唯讀腳本 | textbox `正式版本腳本（唯讀）`／`歷史版本腳本（唯讀）` | readonly，不可手動改版本快照 |
| 編輯模式 | region `測試編輯模式`；`[data-mode="editing"]` | `返回一般模式` 保留本機編輯，關閉監看連線 |
| 對話工作區 | region `對話編輯工作區`；list `已儲存的對話訊息` | 訊息限定目前 session，重開可接續 |
| 對話輸入 | textbox `測試需求或修改訊息`；button `送出訊息` | 使用已存 revision；未存腳本／衝突阻擋送出 |
| 背景與腳本 | details `本次編輯的版本背景`／`腳本預覽與手動編輯` | 純文字摘要；原候選前後對照入口保留 |
| 手動腳本與驗證 | textbox `Playwright TypeScript 腳本`；button `儲存草稿`／`驗證此 revision` | 保留 revision 衝突、未存及設定同步保護 |
| 編輯 Run 紀錄 | region `最近編輯結果`；region 名稱前綴 `AI 與草稿驗證紀錄` | 僅目前 session；summary 類別為 `驗收摘要` |
| 驗證報告 | link `查看草稿驗證報告`；button `重新整理驗證狀態` | 真實驗證與有效 reportUrl 才有發布資格 |
| 摘要 | region `驗收摘要`；button `產生驗收摘要`／`重試驗收摘要` | 真 Run 狀態；失敗不自動無限 POST，也不重驗 |
| 摘要內容 | `版本說明`、`候選名稱：…`、details `查看背景摘要` | 候選名稱尚未套用；過期／不完整不能發布 |
| QA 發布 | checkbox `我已檢視驗證報告與驗收摘要，確認發佈 revision N`；button `確認發佈 revision N` | 符合驗證＋摘要門檻後才可勾選與發布 |
| 刪除入口 | button `刪除草稿` | 先 scope 可見模式／版本草稿列；沒有 active 週期不假造 |
| 放棄確認 | dialog `確認放棄本次修改？`；button `確認放棄草稿`／`保留草稿` | 確認後才 POST；本機未存內容影響明示 |
| 回收進度 | region `編輯週期狀態`；button `重新載入週期`／`查看放棄進度` | `正在放棄草稿，等待任務停止與資源回收。`；需回收時顯示 `等待執行節點確認回收，尚未完成放棄。` |
| 舊入口延續 | `開始監看`、`取消 Run <UUID>`、`下載失敗證據` | 以 formal/editing 父 region 與 `data-run-id` 區分；摘要無監看 |

## M6 前次交付：失敗證據下載

Owner：Web；PM：t35。依 `contracts/mvp-v6.md` 實作，只修改 `apps/web/`；未安裝套件、未部署／重啟服務、未 Git、未讀取憑證／env、未呼叫模型。Server API 由 t31 並行實作，本輪未以 mock 或靜態檔假造真實下載成功。

**最終隔離整合 PASS（PM t35 回報，Web Agent 未重跑）**：失敗 Run `86d6fe61-ebf4-4c67-b4a4-2898de9d1225` 產出真實 ZIP `12,931 B` 與 MD `1,145 B`，API 與 UI 下載的檔案 hash 一致。本機 `show-trace` 根入口載入真實 `Set content`／`toHaveText`／error-context；HTML 報告顯示 Failed 1／Passed 0，詳細內容正常，HTTP 錯誤／pageerror／CSP 錯誤皆為 0。證據位於 `/private/tmp/whippet-m6-download-evidence`。PM 說明先前 Viewer 失敗是手拼 URL 錯誤，非產品問題，未因此修改產品。隔離服務、網路與 Viewer 已關閉；原服務未更新，未 commit／push。

### 產物與行為

- 新增 `src/RunArtifacts.tsx`，在最近一次 Run 結果與各歷史列提供「下載失敗證據」。普通 run／validation 可展開，author 不顯示此入口；即使缺少 HTML 報告也仍可查詢已保存證據。
- 只在使用者展開時呼叫 `GET /api/runs/:id/artifacts`；收合會卸載內容並取消尚未完成的讀取，重新展開或手動重新載入才再次查詢。沒有新增輪詢；Run 狀態改變不會自動重抓清單。最新 Run 換成另一筆時，該區入口會重新收合，不延續上一筆的展開意圖。
- 新增 `RunArtifact {name,size,contentType,url}` 型別與 API parser；大小必須為非負安全整數，回應錯誤、非 JSON、格式錯誤與已知 Run 空列表明確區分，不將空附件當測試通過。
- 只顯示符合 `^data/[0-9a-f]{40}\.(zip|md)$` 的檔名，列出 ZIP／Markdown 類型、檔案大小與名稱。PNG／HTML／JSON 或非白名單名稱不出現在本清單。
- 下載 URL 沿用 `resolveReportUrl` 的相對／絕對 HTTP(S) 檢查；ZIP 必須對應 `application/zip`，MD 必須對應 `text/markdown`（容許 charset 參數）。不符時顯示「下載連結無效」或「附件類型不符，無法下載」，不提供可點擊下載連結。
- 使用 API 提供的受檢查 URL 直接建立原生 `<a download>`，檔名取合法 hash basename。連結位於平台 React DOM，沒有放入 HTML 報告 sandbox；不 fetch 附件內容、不建內容 Blob、不解壓、不讀入 Markdown 文字／HTML／管理 DOM，也沒有新增 viewer 或影片。
- 明示：「Trace ZIP 請下載後，使用本機 Playwright Trace Viewer 開啟。Markdown 也會下載為檔案。」沒有宣稱報告內的 trace 按鈕可用，沒有修改 HTML 報告或 CSP。
- explicit mock 對已存在的 mock Run 回空陣列（本來就沒有 ZIP／MD）；不存在 Run 回 404。沒有假下載連結、fake evidence 或真 API 失敗自動切 mock。

修改檔案：新增 `src/RunArtifacts.tsx`；修改 `src/types.ts`、`src/api.ts`、`src/App.tsx`、`src/mock.ts`、`src/styles.css`、本紀錄。沒有修改 LiveView、Workspace 設定、依賴／lockfile、Nginx／部署、docs／contracts 或其他 owner 的程式。

### M6 實際檢查與串接限制

- **必要 build 一次 PASS**：`npm run build`，完整 `tsc --noEmit`＋Vite `7.1.9`，退出碼 `0`。42 個模組；HTML 0.55 kB、CSS 16.74 kB、JS 267.29 kB（gzip 82.79 kB）。通過後未重跑。
- 真實 API／UI ZIP、MD 下載及本機 Trace Viewer 的最終隔離整合已由 PM t35 回報 PASS，細項與證據見本節頂部。Web Agent 未重跑或自行讀取實際附件內容；不將此結果擴大為未列項目的全面驗證。
- Server 回 `{items:[]}` 時，畫面顯示未取得證據；404、連線／格式錯誤顯示失敗與重試。若尚在上傳，使用者完成後手動「重新載入附件」，不自動輪詢。
- 前端的 `download` 是瀏覽器下載提示；實際 `Content-Disposition: attachment`、ZIP／MD MIME、nosniff 與既有 sandbox CSP 仍由 Server 保證。前端沒有放寬 CSP 或為 report 加下載例外。
- ZIP／MD 是可選證據，清單／下載狀態不會改變 Run 斷言結果、發布或成功所需 HTML 報告門檻。

### M6 黑箱標籤／locator

| 對象 | Accessible 名稱／可見文字 | 預期 |
| --- | --- | --- |
| 結果區入口 | region `最近一次執行` 內 button `下載失敗證據` | 展開後才讀取該 Run 的附件 |
| 歷史入口 | region `執行紀錄`／指定 Run table row 內 button `下載失敗證據` | 僅查指定歷史 Run，不追 latest |
| 展開狀態 | 入口 button 的 `aria-expanded` | true 展開、false 收合；收合取消尚未完成的 GET |
| 附件區 | region `Run <完整 UUID> 的失敗證據附件` | 含標題「失敗證據附件」及完整 Run ID；若結果與歷史同筆皆展開，需先 scope 父區域 |
| 載入 | status 文字 `正在載入失敗證據附件…` | 不與空清單混淆 |
| 空清單 | `未取得 ZIP／Markdown 失敗證據；請以此 Run 的執行狀態與報告判讀結果。` | 不顯示下載、不代表 Run 通過 |
| 讀取失敗 | alert 與 button `重試載入附件` | 錯誤可辨，不假裝成空列表 |
| 清單 | list `ZIP 與 Markdown 下載清單` | 只顯示合法 ZIP／MD，附 B／KiB／MiB 大小 |
| ZIP 連結 | 可見文字 `下載 ZIP`；accessible name `下載 <40位hash>.zip` | 原生下載 URL，filename 為 hash.zip |
| MD 連結 | 可見文字 `下載 MD`；accessible name `下載 <40位hash>.md` | 原生下載 URL，filename 為 hash.md |
| 無效連結／類型 | `下載連結無效`／`附件類型不符，無法下載` | 不產生可點擊連結 |
| 手動更新 | button `重新載入附件` | 明確 GET 一次，不新增排程 |
| Trace 說明 | `Trace ZIP 請下載後，使用本機 Playwright Trace Viewer 開啟。` | 平台只提供下載，不宣稱內嵌 trace 功能 |

整合只需沿用一條真實失敗 Run：結果區展開清單，確認 ZIP／MD 類型及大小 → 在平台入口下載兩者 → 使用既有本機 Playwright Trace Viewer 開啟 ZIP → 歷史列可取得相同 Run 的附件。空／404／讀取失敗以受控回應驗證；確認未展開時與等待期間沒有附件輪詢，不為此另跑完整測試矩陣或修改 report CSP。

## M5 前次交付：單一 Workspace 設定

Owner：Web；PM：t35。依 PM 固定的 `contracts/mvp-v5.md` 實作，僅修改 `apps/web/`。未部署／重啟共用服務、未安裝套件、未讀印 secrets／env、未呼叫模型、未 Git，未修改 docs／contracts。2026-11-11 PM 回報 Server 真實 PostgreSQL 快照整合 PASS；這不是前端瀏覽器驗收結果。

**設定 UI 驗收紀錄（PM t35 回報，Web Agent 未重跑）**：PM 已使用 Mac 原生 Chromium，在隔離服務 `18085` 執行最終 `m5-settings-ui`，退出碼 `0`。設定儲存／重載、跨 PATCH 保留未儲存腳本全文與按鈕阻擋、no-op／409／400，以及 restore 全部 PASS。腳本保存於 `scripts/test/m5-settings-ui.cjs`，截圖證據位於 `/private/tmp/whippet-m5-settings-evidence`。PM 已移除隔離服務，原服務未修改。此階段只證明設定 UI 通過；後續設定快照／baseURL 主流程驗收以下段最終整合結果為準。

**後續最終隔離功能整合 PASS（PM t35 回報，Web Agent 未重跑）**：M5 Workspace 設定的相對 URL 已完成驗證、人工確認發佈與正式 Run，結果 `succeeded`，原先待驗的設定／baseURL 主流程已有實際整合成功證據。此結果與上方 M6 真實附件下載／Trace Viewer 流程一併由 PM 驗收；隔離資源已關閉，原服務未更新，未 commit／push。

### 產物與串接

- 新增獨立 `src/WorkspaceSettings.tsx`：單一 Workspace 設定入口、網站名稱／完整 URL 清單、選填預設測試 URL、唯一數值設定 `timeoutMs`，Workspace name 唯讀。沒有 API key、任意 JSON／env、RBAC 或多 Workspace 管理介面。
- `GET /api/workspaces/:id` 載入真實 `WorkspaceSettingsResponse`；`PATCH /api/workspaces/:id` 只傳 `{revision,sites,defaultTestUrl,timeoutMs}`，sites 子項只傳 `{name,url}`。沒有臆測欄位、假成功或自動 mock fallback。
- 依契約檢查最多 20 個網站、名稱 trim 後必填／最多 100 字元、完整 HTTP(S) URL 最多 2,048 字元且禁止 userinfo、defaultTestUrl 可空且不必出現在 sites、timeout 為 1..3,600,000 整數毫秒。網址錯誤訊息不回顯原始敏感輸入。
- 儲存前明示：**變更設定後，現有草稿需重新驗證；已發佈版本維持原設定。既有執行（含排隊中）也保留建立時的設定。** 只有 PATCH 成功回應才更新表單、顯示成功與通知草稿同步；若 Server revision 未變，顯示設定內容未變更。
- 409 保留本機表單輸入、停用儲存、不自動重送；「重新載入設定」在有未存內容時，需明確選擇放棄或保留。未知網路結果提示先重新讀取確認，避免把未確認的請求當作成功。
- 設定區與現有測試編輯器同時掛載；開啟／儲存設定不會卸載草稿、對話或監看。PATCH 成功用權威回應更新設定，並 GET 當前草稿；若最初載入草稿與 PATCH 重疊，也會補同步。
- 同步中即阻擋驗證、發佈與 author 送出。新草稿可安全套用時更新 revision／設定快照並清除舊驗證確認；若有未儲存腳本或草稿請求，保留本機文字、顯示衝突，要求檢視並重載。較早 author、GET、save／validation 回應不得回退已知 draft revision 或重新綁定舊驗證資格。
- 型別及 parser 支援 Draft／Version／Run 的 `workspaceSettings` 固定快照；草稿顯示設定版本與逾時，歷史版本顯示其原固定設定。前端不改寫既有 Version 或 Run。
- 未儲存設定／請求有離開與 beforeunload 防護，獨立於草稿防護。切換 Test 保留開啟的設定區，不因設定未存而額外打斷 Test 操作；離開整個 Workspace／返回登入才合併檢查。

本輪修改：`src/App.tsx`、`src/api.ts`、`src/types.ts`、`src/DraftEditor.tsx`、`src/TestActions.tsx`、`src/mock.ts`、`src/styles.css`、本紀錄；新增 `src/WorkspaceSettings.tsx`。沒有修改 `src/live.ts`、`src/LiveView.tsx`、Nginx、Vite、依賴或 lockfile。opt-in mock 對 M5 明確回 `MOCK_SETTINGS_UNAVAILABLE`，不假造設定讀取／儲存成功；M5 使用真實 Server API。

### M5 實際檢查與限制

- **最後程式版本 build PASS**：`npm run build`（完整 `tsc --noEmit`＋Vite `7.1.9`），退出碼 `0`，41 個模組；HTML 0.55 kB、CSS 15.75 kB、JS 264.19 kB（gzip 81.81 kB）。實作與後續競態防護調整共建置三次，均成功；沒有在程式未變時重跑，PM 已指示沿用最後證據。
- **實際瀏覽器設定 UI 與相對 URL → 驗證 → 發佈 → 正式 Run 主流程均 PASS，來源為 PM t35 回報**，細項與證據位置見本節頂部。Web Agent 未部署、未修改共用服務設定、未重跑 smoke 或全量 UI 測試；僅記錄已提供的驗收範圍。
- 舊資料若未回傳選填 `workspaceSettings`，前端仍可顯示原有流程；有快照時須完整符合契約。新 Workspace Settings response 的 revision 必須是正整數，timeout 必須有效；不以預設值靜默蓋掉 Server 的舊 timeout。
- Server 必須在實際 PATCH 變更時建立各草稿的新 revision 並清除驗證資格；前端只同步與保護編輯器，不代替交易規則。無變更 PATCH 不應使草稿失效，Server 為最終權威。

### M5 黑箱可見標籤／定位

| 對象 | Accessible 名稱／可見文字 | 驗收重點 |
| --- | --- | --- |
| 入口 | button `Workspace 設定` | 展開頁首設定區，不卸載 Test 詳情 |
| 設定區 | region `Workspace 設定` | 顯示既有 Workspace name 與 revision；name 沒有編輯欄位 |
| 新增網站 | button `新增網站` | 新增名稱／URL 一列，上限 20 筆 |
| 網站名稱 | label `網站名稱 1`（之後依序編號） | trim、必填、100 字元限制 |
| 網站 URL | label `網站 URL 1` | 完整 HTTP(S)、不接受帳密 userinfo |
| 移除網站 | button `移除網站 1`（accessible name） | 刪除指定本機表單列，儲存時整份替換清單 |
| 預設 URL | label `預設測試 URL（選填）` | 可空，不要求列在網站清單 |
| 逾時 | label `執行逾時（毫秒）` | 整數 1..3,600,000，保留載入時的實值 |
| 影響提示 | `變更設定後，現有草稿需重新驗證；已發佈版本維持原設定。` | 在儲存前可見 |
| 儲存 | button `儲存 Workspace 設定` | 有修改才可按；顯示 `儲存中…`；只在成功後顯示已儲存 revision |
| 重載 | button `重新載入設定` | GET persisted 值；409 後用以取得最新 revision |
| 捨棄確認 | button `放棄編輯並重新載入設定`、`保留目前編輯` | dirty 時不可無提示覆寫 |
| 衝突 | `設定 revision 已過期（409），不會自動覆寫。` | 輸入保留、儲存停用，不自動 retry |
| 關閉 | button `關閉設定` | 未存時確認捨棄；請求中停用 |
| 草稿同步 | `正在同步 Workspace 設定與草稿，暫時不可驗證或發佈。` | 同步前不得沿用舊資格 |
| 草稿快照 | `草稿設定版本 N · 執行逾時 … 毫秒` | 設定變更後 revision／timeout 更新，腳本無變更 |
| 版本快照 | `版本固定設定 N · 執行逾時 … 毫秒` | 已發佈 Version 維持原 snapshot |
| 本機保護 | `Workspace 設定已變更，本機未儲存的腳本已保留。` | dirty 腳本不被 PATCH 後的 GET 靜默覆蓋 |

隔離環境單一 smoke 可用既有已驗證草稿與已發佈版本：先在腳本加入未存註解 → 開啟 Workspace 設定、使用隔離環境提供的 HTTP(S) 網址修改與儲存 → 確認新設定可重載、本機腳本文字保留且舊驗證不能發佈 → 明確重載最新草稿，確認腳本仍為原已存內容、設定版本更新、需重新驗證 → 歷史 Version 保留原設定。409 以兩個表單讀同 revision 後依序 PATCH 觀察；未知欄位／無變更 PATCH／既有 queued 快照由 Server 已有測試與 PM 統一驗收，避免另改目前共用服務。

### Live video 細字模糊：本輪唯讀查核

- 查核 `src/styles.css` 的 `.workspace-layout`、`.test-browser`、`.detail-panel`、`.live-panel` 與 `.live-media`：媒體元素 `width/height:100%`、`object-fit:contain`，未見針對 video／img 的 filter、transform 或 zoom；容器 16:9、最小高度 180。沒有足夠證據把細字模糊歸因於 CSS bug，故未盲目修改影像樣式／播放成功條件。
- **靜態推算，非瀏覽器實測**：100% zoom、viewport 1440px 時，依 padding／sidebar／border 推算 media 內容寬約 960px；1280px 時約 800px。若來源是 1280px，水平縮放分別約 75%／62.5%，來源 16px 字約成 12／10 CSS px。DPR 2 時輸出 device pixels 又不同，必須與實際來源／編碼尺寸一起判讀。
- 本機 browser access host 回報 unavailable，無法讀取既有 viewer 的 `videoWidth/videoHeight`、`clientWidth/clientHeight`、實際顯示矩形與 `devicePixelRatio`；未建立真實影像模糊的可重現量測，不宣稱已確定原因或修好。CUA 僅執行可用面盤點，沒有操作現有頁面。
- 已以 `hc send t35` 回報來源查核與推算；PM 已收到並指派 t32 在獨立容器加入 viewer 真實尺寸與 DPR。需比對 `object-fit:contain` 的實際內容尺寸，而非只看容器寬；若來源／編碼不足，不能靠 CSS 銳化聲稱恢復遺失細節。
- 等 t32 實測後再判斷是否需要前端局部修正。本輪沒有重啟／部署、沒有碰目前服務設定，也沒有修改 LiveView／編碼。

## M4 前次交付：唯讀監看

依 `contracts/mvp-v4.md` 實作；只修改 `apps/web/`，含 owner 範圍內的 Nginx 與 Vite 設定。

- 新增 `src/LiveView.tsx`（唯讀面板）與 `src/live.ts`（原生 WebSocket／RTCPeerConnection controller）；修改 `src/App.tsx`、`src/styles.css`、`vite.config.ts`、`nginx.conf.template`。沒有新套件或依賴／lockfile 變更。
- 最近一次執行摘要與各活躍 Run 歷史列提供「開始監看」。選定的是明確 Run ID，不追隨 latest；新 author／validation／正式 Run 不會偷換監看目標。同一頁最多一個面板，重新選取會清理前一 session。面板位於最近執行摘要後、歷史列表前。
- **真 WebRTC**：Runtime 提供 offer；前端依 ready 的 ICE servers 建立 peer、接收 video track、回覆 answer。等待 ICE gathering complete 或最多 8 秒，再送 localDescription.sdp；不傳 trickle candidate。只有 video 有非零尺寸、可播放資料、未暫停且 track live，並以實際 video-frame callback（不支援時用播放事件）確認，才顯示「監看中：WebRTC」。Server streaming、WS open、SDP 成功、peer connected 都不單獨當成功。
- **JPEG 備援**：ready 後 20 秒沒有可播放 video、peer failed 或 WebRTC 協商失敗時切 JPEG，亦可手動切換與重新嘗試 WebRTC。binary message 只接受完整 JPEG，大小上限 1 MiB；只保留最新 Blob URL，替換與清理時 revoke。圖片實際 decode/load、naturalWidth 非零後才顯示「監看中：JPEG 備援」，不稱為 WebRTC 成功。
- **等待與重連**：queued／dispatched 尚無作用中的 attempt，以及 no-attempt／not-ready 類錯誤，每 3 秒安全重試監看連線；不重跑測試。一般斷線或 30 秒無 pong，以 2／4／8 秒退避、最多三次自動重連，之後可手動重新連線。busy 不自動搶佔，顯示已有其他觀看者；單 viewer 的最終約束由 Server 執行。
- **生命週期**：每 10 秒 ping。停止、關閉面板、改選 Run／Test、返回登入、卸載與頁面隱藏／pagehide 都會關閉 WS／peer、停止接收 track、釋放 Blob URL 及計時器。頁面恢復可見時，仍有觀看意圖才重新連線；明確停止不會自行恢復。
- **終態保留**：Run 終態或 Server ended 後清理影像資源，面板仍保留 Run ID 與「監看已結束」，直到使用者關閉。不因終態立即消失。停止監看與斷線都不呼叫取消 Run、不修改執行結果。

### M4 Server／Runtime 串接

| 項目 | 前端行為／需求 |
| --- | --- |
| Viewer endpoint | 同源 `GET /api/runs/:runId/live` WebSocket upgrade；HTTP 用 ws、HTTPS 用 wss，沿用瀏覽器使用者 cookie，沒有 Manager token |
| `ready` | 接收 `{viewerId,iceServers:[]}`；ICE credentials 僅交原生 peer，不印 log |
| `offer`／`answer` | 收 `{type:'offer',sdp}`，non-trickle 回 `{type:'answer',sdp}`；Runtime 是 offer 方 |
| 模式 | `{type:'mode',mode:'jpeg'|'webrtc'}`；初始 webrtc，重連沿用使用者目前模式 |
| 狀態 | 接收 waiting／connecting／streaming／unavailable／ended 與 reason；streaming 仍等本機媒體確認 |
| 租約 | 每 10 秒 `{type:'ping'}`，以 pong 更新期限；30 秒無回應重新連線 |
| binary | 一個 WS message 一張 JPEG；非 JPEG／過大畫面不標成功 |
| 錯誤 | `{type:'error',code,message}`；busy 結束本連線並提示稍後重試，queued／無 attempt 維持等待 |
| 停止 | 關閉 viewer WS，由 Server 依該 viewerId 送 live.stop／租約回收；不另外發送未定義的 stop 訊息 |

**Nginx 已更新**：加入 Upgrade／Connection map、HTTP/1.1、60 秒讀寫期限、停用 proxy buffering。`Host` 使用 `$http_host`，並轉送 `X-Forwarded-Host $http_host`，保留 `localhost:18080` 這類原始埠號，讓 Server 同源 Origin 檢查成立。Vite `/api` proxy 啟用 `ws: true`、`changeOrigin: false`，同樣保留原始 Host。M4 要求同源；若 API base 為其他 origin，前端會明確拒絕建立監看連線，請使用代理。

### M4 實際檢查與未驗證項目

- **正式 build 一次通過**：`npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` production build，退出碼 `0`。40 個模組；HTML 0.55 kB、CSS 14.66 kB、JS 252.37 kB（gzip 78.80 kB）。通過後未重跑。
- 本輪未跑真實媒體、UI smoke、Docker build 或 Nginx `-t`；沒有宣稱 WebRTC／JPEG／TURN 實測通過。Docker 與整合黑箱驗收由總指揮／指定 Muse 統一執行，沿用唯讀的 `scripts/test/fixtures/m4-live.spec.ts` 45 秒變動畫面；本 Agent 未修改該 fixture。
- 無 viewer 不擷取／不開 helper 的最終保證仍由 Server／Manager／Worker 的 stop、viewerId 去重與租約實作負責。前端提供確實關閉連線與資源清理，不能單憑 DOM 關閉推定 Runtime 已回收。
- TURN 未提供時只可驗證設定接線；實際 NAT／TURN 成功仍待實測。現有 PNG／HTML 報告與 Run API 行為未更動。
- 明確關閉／停止後不保留最後一張畫面的資源；終態面板保留的是 Run 與結束狀態，不將凍結影格假裝成即時畫面。

### M4 黑箱 accessible 標籤／locator

| 對象 | Accessible 名稱／穩定定位 | 預期 |
| --- | --- | --- |
| 最近執行啟動 | button `開始監看`（exact） | 使用摘要當下的 Run ID，啟動一個面板 |
| 歷史列啟動 | button `開始監看 Run <完整 UUID>` | 指定某筆 Run，不跟隨 latest |
| 面板 | region `唯讀監看` | 面板顯示固定的完整 Run ID；終態仍保留 |
| 連線狀態 | status `監看連線狀態`；`data-testid="live-status"` | 可見文字反映等待／連線／傳輸／結束 |
| WebRTC video | aria-label `WebRTC 唯讀監看畫面`；`data-testid="live-video"` | 原生 video，autoplay／muted／playsInline；應確認 videoWidth、videoHeight、readyState 與未暫停 |
| JPEG img | img `JPEG 備援唯讀監看畫面`；`data-testid="live-jpeg"` | 原生 img；應確認 naturalWidth > 0，不能只看元素存在 |
| 手動備援 | button `切換 JPEG 備援` | 關閉 peer，等待 JPEG 真正可顯示 |
| 回主路徑 | button `嘗試 WebRTC` | 同 viewer 重新協商、重新套用 20 秒可播放期限 |
| 自動播放被擋 | button `播放監看畫面`（條件出現） | 使用者手勢重試播放；未播出前不標成功 |
| 重連 | button `重新連線` | 建立新 viewer session，舊資源先清理；Run 終態停用 |
| 停止 | button `停止監看` | 關閉影像資源，Run 繼續；可再重新連線 |
| 關面板 | button `關閉監看面板` | 明確卸載與清理，移除面板 |

可見狀態包括 `等待監看畫面`、`監看連線中`、`監看重新連線中`、`監看中：WebRTC`、`監看中：JPEG 備援`、`監看已暫停`、`已停止監看`、`監看已結束`、`目前無法監看`、`監看連線失敗`。不要把「等待監看畫面」或 Server streaming 當作媒體成功。

建議在同一條 45 秒 fixture 黑箱流程：執行 → 開始監看 → 確認真 video 可播放及 WebRTC 狀態 → 切換 JPEG，確認 img decode 與備援狀態 → 停止監看，確認測試仍執行並最終產生原報告。另可不提前停止，確認終態面板保留「監看已結束」。queued 開啟需等候／重試；背景頁面會主動暫停，測試時須使監看頁可見。此為待驗收定位說明，本 Agent 未執行 smoke。

## M3 前次交付

依 `contracts/mvp-v3.md` 實作持久對話，保留 M1／M2 的正式執行、草稿、驗證與明確確認發佈流程。使用 `vercel-react-best-practices`，以獨立對話元件承接流程；沒有 SSE、複雜 diff 套件或額外依賴。

- **持久對話讀取**：每次選擇 Test 或重新登入後，GET 該 Test 的 Conversation。訊息以純文字顯示角色、時間、內容及 revision；重新整理對話不清除既有訊息或尚未送出的輸入。
- **送出**：POST `{content,revision}`，revision 固定為目前已儲存草稿。空白／超過 16,000 字元、有本機未存腳本、草稿操作或衝突尚未完成、尚有 active author 時，阻擋送出。訊息只在 202 回應後清空；409／連線結果不明時保留文字並重新讀取對話／紀錄，不自動重送 POST。
- **任務狀態與取消**：支援 `Run.kind=author`，回復 Conversation 的 `activeRunId` 並接續既有 Run 輪詢。author 活躍時每 2 秒更新對話；與 Run 共用取消 API，顯示排隊、執行、取消中、失敗、已取消等狀態。失敗與取消後同步完成即可送新訊息，不丟棄 Server 已存訊息與草稿。
- **author 成功不等於測試通過**：成功顯示「撰寫完成」，歷史類型顯示「AI 撰寫」，不要求 author Playwright report，也不因 author 成功放行發佈。正式執行與 validation 維持原本測試狀態／報告呈現。
- **腳本前後對照**：優先讀取 Server `Message.baseScript` 與 `proposedScript`，顯示兩個可捲動的唯讀 code 區。依總指揮後續指示，即使已自動套用草稿，Server 仍回 `proposedScript`；因此重開訊息仍可看原稿與結果稿。`baseRevision`／`appliedRevision` 同時標示套用結果。
- **相容與缺資料處理**：舊訊息缺少選填快照時，使用本分頁已取得的精確 revision 腳本作 fallback；仍無資料就明確顯示無法還原，不拿目前腳本冒充舊版本。沒有腳本的 assistant 回覆顯示「此回覆未提供腳本變更，草稿保持原樣」。
- **候選未套用**：有 `proposedScript`、沒有 `appliedRevision` 時，標示候選尚未套用。只有對應 author Run 已成功，才允許「將候選腳本帶入編輯器」；只改本機文字，需人工檢視、儲存、驗證及確認發佈。帶入前若有未存內容需明確確認；失敗／取消 Run 不允許套用。
- **終態同步**：author 結束後並行刷新 Conversation 與 Draft，再刷新 Run 歷史，接續顯示 Message 的 `validationRunId` 狀態／報告。若當時本機仍有未存編輯或草稿請求，不覆蓋本機文字，改為衝突提示與重新載入選擇。同步失敗會阻止下一輪送出，直到重試同步成功。
- **M2 門檻維持**：AI 只會更新草稿；validation 必須對應目前 revision、成功且報告存在，沒有本機未儲存內容，才可勾選並送出 `{revision,confirmed:true}`。模型回覆、author succeeded 或候選帶入均不會自動發佈。

新增 `src/ConversationPanel.tsx`；修改 `src/types.ts`、`src/api.ts`、`src/components.tsx`、`src/DraftEditor.tsx`、`src/App.tsx`、`src/mock.ts`、`src/styles.css`。沒有修改 owner 外檔案、契約、依賴、lockfile 或 Docker 設定。

### M3 API 與 Server 串接事項

| 操作／欄位 | 串接行為 |
| --- | --- |
| `GET /api/tests/:id/conversation` | 嚴格解析 Conversation 與 messages；初次需回空陣列 `[]` |
| `POST /api/tests/:id/messages {content,revision}` | 接收 `{run,conversationId}`，加入既有 Run 狀態追蹤 |
| `Run.kind=author` | 沿用歷史、GET Run、全域佇列及取消契約 |
| `Message.baseScript?` | 優先作為原始腳本快照，支援空字串 |
| `Message.proposedScript?` | 優先作為候選／已套用結果稿，即使 appliedRevision 存在也保留 |
| `Message.appliedRevision?` | 區分已套用與待人工處理的候選 |
| `Message.validationRunId?` | 對應續接 validation 的狀態、錯誤與報告 |

`baseScript` 與已套用訊息保留 `proposedScript` 是總指揮在本輪明確協調的補充，前端已支援；未私自編輯契約。Server 必須提供不可變的原始快照，並在 author 終態交易完成後，讓 Conversation／Draft／Run 查詢反映套用與續接 validation 結果。原始 provider 錯誤由 Server 遮蔽，前端不取得模型設定或憑證。

### M3 實際檢查

- **正式 build 一次通過**：`npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` production build，退出碼 `0`。共 38 個模組；HTML 0.55 kB、CSS 13.94 kB、JS 238.99 kB（gzip 74.25 kB）。通過後未重跑。
- 本輪未呼叫模型、未跑 UI smoke、未安裝依賴、未讀 env、未 Git。Docker 與真實模型串接由總指揮統一處理，黑箱 UI 交指定 Muse；未宣稱完成 M3 E2E。
- 既有 opt-in mock 保留 M1／M2 功能。mock 的 M3 會顯示空對話，送出時明確回報 `MOCK_AUTHOR_UNAVAILABLE`，不假造 AI 成功或呼叫模型；M3 真實流程必須使用 Server API。
- 尚未送出的訊息僅在目前頁面記憶體；已送出訊息以 Server 持久化內容為準。沒有儲存瀏覽器記憶體、假串流或自動重跑的承諾。

### M3 Muse 黑箱 UI 標籤

| 區塊 | 可見標籤／按鈕 | 驗收重點 |
| --- | --- | --- |
| 對話面板 | `AI 測試對話`、`重新整理對話` | 同一 Test 可重讀既有訊息，不因刷新丟失歷史 |
| 歷史訊息 | `你`、`AI 助手`、`基於 revision N` | 角色、時間、文字與已存 revision 正確 |
| 訊息輸入 | `測試需求或修改訊息` | 多行輸入；顯示使用 revision 與 `16,000` 字元上限 |
| 訊息操作 | `送出訊息`、`送出中…`、`AI 任務進行中` | 防止連點；active author 未結束時不可再送 |
| 未存草稿阻擋 | `有未儲存的腳本編輯，請先儲存草稿再送出訊息。` | 手動編輯 TypeScript 後，送出按鈕 disabled，文字仍保留 |
| author 狀態 | `AI 撰寫狀態`、`撰寫完成`、`取消執行` | 撰寫完成不能當測試通過；取消進入取消中／已取消 |
| 同步 | `正在同步對話、草稿與驗證紀錄…` | 終態刷新後，草稿與歷史可接續操作 |
| 套用結果 | `已套用至草稿 revision N`、`候選腳本尚未套用，不會覆蓋目前草稿。` | 區分自動套用與 revision 衝突候選；都不代表發佈 |
| 對照 | `查看腳本前後對照`、`變更前 · revision N` | 展開原始腳本與結果稿，重新登入仍能使用 Server 快照 |
| 對照結果 | `變更後 · revision N`、`候選腳本 · 未套用` | code 區為唯讀；窄畫面改上下排列 |
| 候選處理 | `將候選腳本帶入編輯器` | 僅帶入本機，接續 `儲存草稿`、`驗證此 revision`，不直接提交或發佈 |
| 續接驗證 | `續接驗證`、`查看續接驗證報告`、`重新整理驗證紀錄` | 與 validation Run 關聯，觀察通過／失敗與報告 |
| 人工發佈 | `我已檢視驗證報告，確認發佈 revision N`、`確認發佈 revision N` | 沿用 M2 明確勾選與發佈，不因 AI 完成自動跳過 |
| 回復對話 | `返回登入` → `以開發管理員登入` → 選相同 Test | 重新讀到相同使用者／助手訊息及前後對照 |

Muse 可在單一真實模型流程中依序操作：新增合成測試 → 用對話產生純 `page.setContent` 腳本 → 等待撰寫完成並檢視前後對照 → 手動改腳本，確認未存時不能送訊息，再儲存 → 在同一對話要求修改並續接驗證 → 查看 validation 成功與報告 → 人工確認發佈 → 返回登入後重新選同 Test，確認對話與腳本對照仍在。取消、錯誤、409 與去重依契約使用受控 mock，不另增加真實模型呼叫；本 Agent 未執行此流程。

供黑箱測試輸入的合成需求可用：「請建立 Playwright TypeScript 測試，只使用 page.setContent 顯示標題 Whippet M3 與一個按鈕，驗證標題與按鈕可見，不連外；完成後請求驗證。」同一對話第二則可用：「沿用相同本地 HTML，將標題改為 Whippet M3 修改版，更新預期文字並請求驗證。」不要提供本機程式碼、env 或機密。

## M2 前次交付

依 `contracts/mvp-v2.md` 完成，保留既有 M1 登入、列表、正式執行、短輪詢與報告流程。M2 階段未實作 AI；後續 M3 以上方最新交付為準。沒有變更共用契約或其他 owner 的檔案。

- **新增測試**：Workspace 列表提供建立表單，POST 名稱與選填描述；直接選取新測試，進入空白草稿。未發佈測試不能執行正式版本。
- **草稿**：GET 初始草稿、編輯 TypeScript、以 `{revision,script}` PUT 儲存；畫面區分已儲存與未儲存內容。切換測試／Workspace、返回登入、重新整理或離開頁面前，對尚未儲存草稿或進行中的草稿請求提示確認。
- **409 衝突**：不自動覆寫或重送，保留本機編輯內容。顯示 revision／驗證資格過期提示；可先複製內容，再明確確認捨棄並載入最新草稿。未知網路結果不當成儲存／發佈成功。
- **草稿驗證**：只能驗證已儲存 revision；POST `{revision}` 建立 validation Run，與正式 Run 一起短輪詢。完成後 GET 草稿同步權威驗證資格，保留使用者在等待期間輸入的文字；舊 revision 的成功不能開放目前草稿發佈。
- **明確確認發佈**：目前 revision 驗證 `succeeded`、草稿有合法報告 URL、無未儲存內容且無衝突時，才開放確認勾選。使用者勾選後，再按確認發佈按鈕，送 `{revision,confirmed:true}`。最終交易門檻仍由 Server 核對；成功後更新目前版本與版本歷史。
- **歷史版本與報告**：GET versions，顯示 revision、建立時間、版本 ID、目前版本標示與唯讀腳本。以 Version 的 `validationRunId` 對應執行報告；若歷史列表未含該 Run，可按鈕載入，不為每個版本立即發送額外請求。
- **取消**：活躍 Run 的歷史列可取消；queued 回 cancelled、其餘依 Server 回應顯示 cancelling，繼續輪詢至終態。取消操作同時適用正式與驗證 Run；較早送出的 GET 不會覆蓋取消回應。
- **mock 相容**：明確 opt-in 的 mock 同步支援 M2 草稿、revision、驗證／發佈、唯讀版本與取消；維持明顯示範標示。腳本內 `MOCK_FAIL` 是 mock 專用失敗標記，並非執行 Playwright；正式 API 完全不使用此判斷。

新增檔案為 `src/DraftEditor.tsx`（草稿與發佈流程）、`src/TestActions.tsx`（新增測試、取消、歷史版本）、`src/components.tsx`（共用訊息、狀態與報告元件）；另修改 `src/App.tsx`、`src/api.ts`、`src/types.ts`、`src/hooks.ts`、`src/mock.ts`、`src/styles.css`。沒有修改依賴宣告、lockfile、Dockerfile 或部署設定。

M2 HTTP 串接如下，完全沿用契約，未要求 Server 增加欄位或端點：

| 操作 | 請求 |
| --- | --- |
| 新增測試 | `POST /api/workspaces/:id/tests {name,description}` |
| 載入草稿 | `GET /api/tests/:id/draft` |
| 儲存草稿 | `PUT /api/tests/:id/draft {revision,script}` |
| 驗證草稿 | `POST /api/tests/:id/draft/validate {revision}` |
| 明確發佈 | `POST /api/tests/:id/publish {revision,confirmed:true}` |
| 歷史版本 | `GET /api/tests/:id/versions` |
| 取消任務 | `POST /api/runs/:id/cancel` |

Run 解析支援 `kind`、`draftRevision`、`versionId`，同時容許 M1 舊回應省略擴充欄位。Draft／Version 的 revision 使用非負整數；validationStatus 使用契約既有十種狀態。

### M2 實際驗證與剩餘事項

- **本機正式建置一次通過**：`npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` production build，退出碼 `0`。轉換 37 個模組；`dist/index.html` 0.55 kB、CSS 12.31 kB、JS 227.11 kB（gzip 70.92 kB）。未在通過後重跑。
- 本輪沒有全面 UI 測試、沒有重跑 M1 smoke、沒有安裝套件與 Git 操作。Docker build 由總指揮負責；M2 真實 Server／Runtime 的黑箱 UI smoke 由指定 Muse 後續統一執行。未宣稱 M2 E2E 驗收完成。
- 前端不自行推斷附件已保存，只有 GET Draft 回傳的成功資格與報告可用時才開放確認。Server 必須在相同 revision 的驗證終態後更新 Draft 的 `validationRunId`、`validationStatus`、`reportUrl`；HTTP 衝突必須使用 409。
- 前端取消後等待 Server 的終態；Worker 回收、FIFO、重連去重與名額釋放仍屬 Server／Runtime，不能以按鈕回應推定容器已回收。
- 本機尚未儲存的草稿只存在頁面記憶體；使用者明確放棄或確認離開後不保存。POST 結果不明時，應先重新整理對應紀錄後再決定是否重送。

### Muse 黑箱 UI 定位表

以下都是畫面可見文字，無須讀取原始碼或 env。`N` 代表畫面目前 revision 數字；同名「重新整理」請以區塊標題定位。

| 區塊／欄位 | 可見 label／button | 預期行為 |
| --- | --- | --- |
| 登入 | `以開發管理員登入` | 顯示 Workspace 與測試列表 |
| 工作區 | `Workspace` | 原生 select 選擇工作區 |
| 列表 | `新增測試`、`搜尋名稱或描述`、`重新載入` | 新增表單、搜尋或重新載入列表 |
| 新增表單 | `測試名稱`、`描述（選填）` | 輸入名稱與說明 |
| 新增表單 | `建立測試`、`返回測試` | 建立後選取新測試，或取消新增 |
| 草稿編輯 | `Playwright TypeScript 腳本` | 可編輯多行 textarea；上方顯示 `revision N · 已儲存` 或 `有未儲存變更` |
| 草稿操作 | `儲存草稿` | 儲存後顯示 `已儲存 revision N。` |
| 草稿操作 | `驗證此 revision` | 送出後出現 validation Run；進行中按鈕為 `驗證進行中` |
| 衝突／重載 | `重新載入草稿` | 若有本機修改，先顯示捨棄確認 |
| 捨棄確認 | `確定放棄並重新載入`、`繼續編輯` | 明確載入最新草稿，或保留本機內容 |
| 驗證與發佈 | `重新整理驗證狀態`、`查看草稿驗證報告` | 重讀 Draft 權威資格、在新分頁開啟報告 |
| 驗證與發佈 | `我已檢視驗證報告，確認發佈 revision N` | 符合資格後可勾選；不會自動發佈 |
| 驗證與發佈 | `確認發佈 revision N` | 勾選後可按；成功顯示 `已發佈 revision N，版本 …` |
| 詳情 | `執行測試` | 只執行目前已發佈版本 |
| 執行紀錄 | `重新整理`、`取消執行` | 更新歷史，或取消指定活躍 Run；取消後顯示 `取消中…` 或 `已取消` |
| 執行紀錄 | `草稿驗證 · rN`、`正式執行` | 分辨 Run 類型與 revision／版本 |
| 執行紀錄 | `查看錯誤`、`開啟報告` | 展開失敗錯誤，或以新分頁開啟該 Run 報告 |
| 歷史版本 | `重新整理版本`、`revision N · 目前版本` | 重讀不可變版本並辨認目前版本 |
| 歷史版本 | `查看此版本腳本（唯讀）`、`查看版本驗證報告` | 檢視版本固定腳本及原驗證報告 |
| 歷史版本 | `載入驗證報告`、`重新載入驗證報告` | 找不到相關 Run 或尚缺連結時按需取得 |

建議 Muse 在同一條黑箱 smoke 依序完成：建立唯一名稱測試 → 貼入下方腳本 → 儲存／驗證成功 → 確認未勾選時不可發佈 → 修改／儲存一次，確認舊驗證不能放行新 revision → 再驗證並檢視報告 → 勾選並確認發佈 → 檢查歷史版本與唯讀腳本 → 正式執行並從該列取消。可在同一流程以第二分頁保留舊 revision，第一分頁儲存後再於第二分頁儲存，確認 409 提示且本機文字保留。若要涵蓋失敗顯示，將預期標題改成 `不會出現` 後儲存／驗證，確認顯示「失敗」、有錯誤與報告且不能發佈。這是後續驗收定位資訊，本 Agent 未執行該 smoke。

供黑箱操作貼入的本地頁面腳本如下；8 秒等待僅用來留下可觀察與取消的時間，不依賴外網：

```ts
import { test, expect } from '@playwright/test';

test('M2 本地頁面 smoke', async ({ page }) => {
  await page.setContent('<h1>完成</h1>');
  await expect(page.getByRole('heading')).toHaveText('完成');
  await page.waitForTimeout(8_000);
});
```

## M1 既有產物與行為

- React／TypeScript SPA：開發管理員登入、Workspace 選擇、測試列表與搜尋、測試詳情、發佈版本 ID、執行按鈕、最近結果、執行歷史與錯誤內容。
- 依 `contracts/mvp-v1.md` 呼叫七個端點：`POST /api/dev-login`、`GET /api/workspaces`、`GET /api/workspaces/:id/tests`、`GET /api/tests/:id`、`POST /api/tests/:id/runs`、`GET /api/tests/:id/runs`、`GET /api/runs/:id`。
- 登入完全使用 Server 回應，請求帶 `credentials: include`。不自行產生 token，也不將 mock 身分套入真實 API。
- 初次載入測試詳情與執行歷史可並行；有進行中的 Run 時，每 2 秒查詢該 Run 狀態，同輪完成後才排下一輪。終態停止輪詢；切換測試或返回登入會取消讀取與清除計時器。
- 呈現契約的全部十種 Run 狀態；`failed`、`timed_out`、`interrupted` 明確顯示異常。報告用 Server 的 `reportUrl` 在新分頁開啟，支援絕對及相對 HTTP(S) URL；不將報告 HTML 插入 SPA。
- 防止連點重複 POST。建立 Run 的網路錯誤不自動重送，會提示先重新整理紀錄，以免結果不明時建立重複任務。
- 未發佈測試不可執行；有載入、空資料、連線錯誤、重試與報告尚未提供等狀態。窄螢幕改成上下排列，可用鍵盤操作。
- 小型 mock 必須明確設定 `VITE_USE_MOCK=true`，畫面會持續顯示示範標示。提供成功與斷言失敗兩個範例；示範報告清楚標示未執行 Playwright。真實 API 錯誤不會自動切成 mock。

主要檔案：

| 檔案 | 用途 |
| --- | --- |
| `src/App.tsx`、`src/styles.css` | 繁中 UI、詳情、結果與歷史 |
| `src/api.ts`、`src/types.ts` | 契約型別、HTTP client、錯誤與報告 URL 處理 |
| `src/hooks.ts` | 資料載入、Run 輪詢、取消讀取與建立紀錄的競態處理 |
| `src/mock.ts`、`public/mock-report.html` | 明確 opt-in 的示範資料與報告 |
| `src/main.tsx`、`index.html` | SPA 入口 |
| `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts` | 固定直接與傳遞依賴、型別檢查與 Vite 開發代理 |
| `Dockerfile`、`nginx.conf.template` | 多階段建置、靜態部署與同源 `/api` 代理 |
| `.env.example`、`.gitignore`、`.dockerignore` | 設定範例與產物排除 |

## 串接設定

預設使用真實、同源 `/api`。開發時 Vite 將 `/api` 轉送到 `http://localhost:8080`，保留完整路徑；開發埠為 `5173`。

| 變數 | 預設值 | 生效時機 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | Vite 啟動／建置時；需含 API 前綴 |
| `WHIPPET_API_PROXY_TARGET` | `http://localhost:8080` | Vite 開發代理；只填 Server origin |
| `VITE_USE_MOCK` | `false` | Vite 啟動／建置時；只有字串 `true` 開啟 |
| `WHIPPET_API_UPSTREAM` | `http://server:8080` | Nginx 容器啟動時；不含 `/api`、結尾不加 `/` |

已完成首次安裝並保留 lockfile；後續在 `apps/web/` 執行：

```sh
npm ci --no-audit --no-fund
npm run dev
npm run build
```

`npm run preview` 只預覽靜態產物，未提供 `/api` 代理；要串 API 請使用 Vite 開發模式或 Nginx 容器。若使用絕對 API URL，Server 需允許前端 origin 與 credentialed CORS；建議先用同源代理。

Docker build context 為 `apps/web/`，從 repo 根目錄可用：

```sh
docker build -t whippet-web apps/web
```

Compose 整合時將 Web 的容器埠 `80` 對外，並讓 Web 與名稱為 `server`、監聽 `8080` 的 Server 共用網路；若服務名稱不同，設定 `WHIPPET_API_UPSTREAM`。該 upstream 必須能在 Nginx 啟動時解析。Dockerfile 已改成先複製 `package.json` 與 `package-lock.json`，再執行 `npm ci --no-audit --no-fund`；Docker 映像尚未建置。

## 實際檢查

1. **整合依賴準備完成**：總指揮回報 `npm install` 成功（70 packages）。已保留 lockfile v3，並核對八個直接依賴的實際鎖定版本與 `package.json` 完全一致。Web Agent 原先的沙箱安裝因 DNS `ENOTFOUND` 中止，未重試或重複安裝；專案內 `.npm-cache` 已加入 Git 與 Docker 排除清單。
2. **正式 production build 通過**：Web Agent 在 Node `v22.23.4` 執行 `npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` 建置皆成功，退出碼 `0`。共轉換 34 個模組；產出 `dist/index.html`（0.55 kB）、CSS（10.02 kB）與 JS（212.46 kB，gzip 66.98 kB）。不需修正應用程式碼，完成後未重跑建置。
3. **Docker 可重現安裝設定已更新**：Dockerfile 先複製 manifest 與 lockfile，再執行 `npm ci --no-audit --no-fund`；排除本機 `node_modules`、`.npm-cache` 與 `dist`。本輪未執行 Docker build。
4. **原實作階段的既有檢查**：依賴未準備時，純 API／型別／mock 模組曾通過既有快取 TypeScript 的嚴格檢查，TSX／CSS 曾通過既有 esbuild 的語法打包。當時正式 build 因缺少 `tsc` 受阻；此限制已由本次完整正式建置解除。
5. **原實作階段 API client 最小 smoke 通過，整合階段未重跑**：使用 stub fetch 驗證七個端點與 HTTP 方法、cookie 選項、202 建立 Run、失敗狀態、結構化 API 錯誤、非 JSON 回應、未知狀態、取消請求、相對／絕對報告網址及拒絕 `javascript:`；另驗證 mock 成功／失敗與報告欄位。後續兩個局部修正（讀取 JSON 途中保留取消訊號、同步錯誤文案）已包含在本次正式型別檢查與建置；未新增功能或擴大測試範圍，未宣稱完成 E2E。

## 限制與接手事項

- 前端實作、完整 React 型別檢查與 Vite production build 已完成；瀏覽器操作／視覺檢查、Docker 建置與真實 Server → Manager → Worker → 報告的流程仍待整合驗證。
- `package.json` 已固定直接依賴與 Docker 映像標籤，`package-lock.json` 已保存傳遞依賴。Dockerfile 已改用 `npm ci`；未額外重裝依賴或建置 Docker 映像。
- Server 需提供開發登入、預設 Workspace、已發佈固定測試、Run 狀態與可存取的報告附件。契約未定義登入 session/token 細節，目前只依固定登入回應與 cookie 串接。
- 「返回登入」只清除目前頁面的登入顯示並取消前端讀取；契約沒有登出端點，不代表撤銷 Server session。重新整理頁面後需再次點擊開發登入。
- 列表顯示名稱、描述與發佈狀態；執行結果在所選測試的詳情顯示，未為列表每個測試額外查詢歷史摘要。
- 輪詢僅追蹤目前測試中已載入的活躍 Run；若其他分頁建立任務，或終態仍缺報告，使用「重新整理」載入。單輪暫時失敗會保留既有狀態並重試，不把連線失敗改成任務失敗。
- M2 草稿／發佈／取消、M3 AI 對話與 M4 唯讀監看已在上方交付；M4 的真實媒體驗收狀態以上方最新紀錄為準。
- 依使用者要求，未啟動設計審查 Agent，也未執行額外設計研究／工具探查；未宣稱取得視覺審查通過。

整合時只需跑一條成功路徑，再執行一個真實斷言失敗：確認 UI 分別顯示「通過」與「失敗」、錯誤內容正確、報告可開啟，且完成後停止自動輪詢。此項由總指揮統一驗收，避免多人重跑全量測試。

本互動工作階段保留，等待總指揮後續串接指示。
