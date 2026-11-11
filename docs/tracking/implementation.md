# MVP 實作計畫

規格已寫入；M1 三個模組首批程式已交付；M1 已完成本機真實端到端驗收：成功、斷言失敗及兩份 HTML 報告顯示皆通過。M2、M3 已完成本機驗收；M4–M5 尚未完成。需求以 [MVP 規格](../requirements/mvp.md) 為準，技術邊界見 [架構設計](../architecture/design.md)，負責範圍見 [分工計畫](delegation.md)。

## 開發原則

- 每個里程碑交付可操作流程；先串通，再補必要的錯誤處理。
- 採單一 Go Backend、單一 Manager、PostgreSQL 任務表；暫不引入獨立訊息佇列或微服務。
- React SPA、Go Server／Manager、Node.js／TypeScript Worker 分別建置。
- 介面先以少量範例與欄位定義對齊，按實際需求擴充；Polling、HTTP Push 本期只保留接縫。
- 即時影像與 AI 使用固定的測試／任務識別介面，允許與核心流程平行開發。
- 每項完成後更新狀態及一行驗證結果；通過就推進，不反覆重跑全套檢查。

## M1：從網頁執行第一個固定測試

狀態：完成。Owner：Web t30、Server t31、Runtime t32（herdr，Codex gpt-6.1-sol／xhigh）。依賴：contracts/mvp-v1.md。

- [x] Server：預設 Workspace、開發用 Superadmin、測試列表／詳情、建立 Run、查詢結果。
- [x] Runtime：Manager 主動連線 Server，領取固定腳本任務，啟動 Worker 容器並回報結果。
- [x] Web：登入入口、列表、詳情、執行按鈕與狀態；先用短輪詢更新前端。
- [x] Integration：提供本機啟動設定與受控示範網站／測試，串通 Server → Manager → Worker → 報告。

交付：使用者按執行後，看到真實 Playwright 結果與一份可開啟的報告。
最小驗證：完整操作一次成功路徑；刻意讓一個斷言失敗，確認 UI 呈現失敗而非系統成功。

驗收紀錄：2026-11-11 Mac／OrbStack，Muse Spark 1.3 xhigh 黑箱腳本，成功／失敗各一次，報告正常顯示。見 [整合紀錄](devlog/m1-integration.md)。

## M2：可靠排隊與可用的草稿版本

狀態：完成。Owner：Herdr Web t30、Server t31、Runtime t32（Codex sol／xhigh），Muse t33 黑箱測試、總指揮整合。契約：contracts/mvp-v2.md。2026-11-11 通過模組建置、Server 測試、Manager race 測試與實際 API／UI／併發回收／重連驗收，見 [M2 整合紀錄](devlog/m2-integration.md)。

- [x] Server：一個 Test 一份草稿、revision、不可變的已發佈版本、歷史 Run 與附件關聯。
- [x] Server：提交任務時固定腳本與設定快照；發佈交易核對目前 revision 的驗證成功、報告就緒及使用者確認。
- [x] Runtime：全域併發上限、FIFO、取消、超時、容器回收；回收完成才釋放名額。
- [x] Runtime／Server：WSS 心跳、重連、命令去重、執行狀態對帳；斷線時不立即重派既有執行。
- [x] Web：暫存、驗證、確認發佈、歷史版本與報告入口；草稿先支援直接編輯，供下一階段 AI 接入。

交付：可編輯、驗證、發佈與執行測試；異常 Worker 不阻塞後續任務。
最小驗證：自動測試覆蓋舊 revision 不可發佈、重複命令不重複啟動；一次超額排隊與強制終止 Worker 的整合檢查。重連檢查確認同一 Run 不重複執行。

## M3：QA 對話建立與修正測試

狀態：完成。Owner：Herdr Web t30、Server t31、Runtime t32（Codex sol／xhigh）、Muse t33黑箱驗收，總指揮整合。契約 contracts/mvp-v3.md。2026-11-11 通過建置／必要mock、真實模型探索產稿→驗證失敗→同對話修復→驗證成功→確認發佈，以及UI重開／稿件對照／未儲存防護；見 [M3整合紀錄](devlog/m3-integration.md)。

- [x] Runtime：OpenAI-compatible adapter、工具呼叫迴圈、瀏覽器探索、腳本產生／修正；限制單回合工具步數與執行時間。
- [x] Server：持久化對話、訊息與 Agent 執行結果；使用者等待／離線時釋放 Worker。
- [x] Web：對話、Agent 狀態、腳本差異、驗證報告及使用者確認操作。
- [x] Runtime／Server：修復寫入新草稿 revision；正式版本保持不變。模型與工具錯誤呈現可繼續操作的訊息。

交付：QA 說明流程後得到腳本，能在同一對話修改、驗證、暫存並重新開啟接續。
最小驗證：用一個實際相容模型走完產生 → 修改 → 驗證 → 確認發佈；確認重新開啟可讀取既有對話。其餘 API 邊界使用 stub，避免每次測試消耗模型額度。

## M4：唯讀即時監看

狀態：待辦。依賴：M1 的 Run ID 與 Worker 瀏覽器生命週期；可與 M2／M3 平行。

- [ ] Runtime：畫面擷取與 WebRTC 輸出；Server 轉送協商訊息，支援自架 TURN 設定。
- [ ] Web：唯讀監看、連線狀態與斷線重試；沒有觀看者時避免持續占用不必要影像資源。
- [ ] Runtime／Web：提供經 Server 轉送畫面的 WSS 備援，降低網路限制對觀察能力的影響。
- [ ] Integration：以部署環境實測決定預設影像參數，文件記錄所需連線與備援方式。

交付：執行中可看見瀏覽器畫面；影像故障不取消測試，也不阻塞其他功能開發。
最小驗證：一條 WebRTC 觀看路徑及一次備援切換；不建立影像壓測或完整 NAT 組合矩陣。

## M5：Linux／Mac Docker 部署與 MVP 收尾

狀態：待辦。依賴：M1–M4；Docker 建置與設定範例隨前述階段持續補齊。

- [ ] Integration：Server Compose、執行節點 Compose、設定範例、持久化 volumes 與啟動指南。
- [ ] Runtime：確認實際 Mac Docker CPU 架構可建置／執行；記錄測過的平台與限制。
- [ ] Integration：補上開源所需 README、選定的 LICENSE 與必要依賴聲明；授權定案前不宣稱已採用特定授權。
- [ ] 全體：修正完整主流程中實際遇到的阻塞，不另開無關重構或效能優化工作。

交付：依文件可啟動，完成建立 → 對話修改 → 驗證 → 發佈 → 執行 → 監看 → 報告。
最小驗證：Linux Server＋實際 Mac Docker 執行端跑一遍完整流程；其餘沿用前面已通過的結果。

## 本期不排入

真實登入／SSO、RBAC 管理介面、多 Workspace 管理、多 Manager 排程、Polling／HTTP Push 實作、遠端人工接管、全面瀏覽器矩陣、Kubernetes、完整負載測試與自動修復正式版本。

## 接續方式

下一個可執行任務是 M4：唯讀即時監看，沿用現有Run與Worker生命週期。M3已完成本輪驗收與交付，M4尚未開始。遇到非核心細節採可逆預設，記在相關任務，不延伸成新一輪設計訪談。

## M1 後的模型預配置

狀態：完成。Owner：Runtime t32（Codex sol／xhigh）、總指揮整合。M1 已先提交 `0b6f2f9`，再完成 OpenCode Go Muse Spark 1.3 Contributor／xhigh 的 Responses API 預配置、CLI 與獨立 Compose。TypeScript build、8 項 mock 測試、Worker Docker build 與容器離線 ai-check 通過。2026-11-11 使用者提供 key 並授權實測，單次 live probe 成功（completed、264 字元、requests=1）；未輸出或提交 key，不視為 M3 AI 對話已完成。設定方式見 [OpenCode Go 指南](../guides/opencode-go.md)。
