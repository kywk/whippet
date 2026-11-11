# MVP 實作計畫

規格已寫入；M1 三個模組首批程式已交付；M1 已完成本機真實端到端驗收：成功、斷言失敗及兩份 HTML 報告顯示皆通過。M2、M3 已完成本機驗收；M4 已完成本機驗收；M5／M6 本機功能已通過，部署與開源缺口獨立追蹤；目前優先 M7–M9 對話工作區。需求以 [MVP 規格](../requirements/mvp.md) 為準，技術邊界見 [架構設計](../architecture/design.md)，負責範圍見 [分工計畫](delegation.md)。

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

狀態：完成。Owner：Herdr t30 Web、t31 Server、t32 Runtime（Codex sol／xhigh），t33 Muse 黑箱驗收，總指揮整合。契約 contracts/mvp-v4.md。M4 已以 80a8dfa 提交並推送 origin/main；600f28e 為 M3。新一輪不自行 commit／push。

- [x] Runtime：畫面擷取與 WebRTC 輸出；Server 轉送協商訊息，支援自架 TURN 設定。
- [x] Web：唯讀監看、連線狀態與斷線重試；沒有觀看者時避免持續占用不必要影像資源。
- [x] Runtime／Web：提供經 Server 轉送畫面的 WSS 備援，降低網路限制對觀察能力的影響。
- [x] Integration：以部署環境實測決定預設影像參數，文件記錄所需連線與備援方式。

交付：執行中可看見瀏覽器畫面；影像故障不取消測試，也不阻塞其他功能開發。
最小驗證：一條 WebRTC 觀看路徑及一次備援切換；不建立影像壓測或完整 NAT 組合矩陣。

實際驗收（2026-11-11）：Server／Manager 必要 Go 測試、Worker build 與真實 RTP 影格測試通過；Mac Chromium → OrbStack Worker 主流程成功，WebRTC 解碼影格 2→3、JPEG 更新、停止監看時 Run 仍 running，最後 succeeded（Run `3a23fa36-0eb4-46ac-a311-ba5541882fcb`）。可見 Chrome demo Run `c63b68dc-88a6-4501-a9e8-2e72a8fd48cf` 顯示 WebRTC 12→30 秒與 JPEG 39 秒，報告兩張 1280×720 PNG 載入正常。TURN 跨主機與 Linux 實機組合留待 M5，未宣稱通過。操作見 [即時監看指南](../guides/live-view.md)。

M4 真實網站補充驗收：依使用者要求改以 Whippet 登入→搜尋→詳情→報告 popup→返回登入示範；Chrome WebRTC 目視觀察到頁面與 popup 切換，Run `248aa019-454d-464b-a2e7-3c519a65feb8` succeeded。合成計數頁僅作串流診斷，不取代實際操作驗收。

## M5：畫質、Workspace 設定與部署收尾

狀態：進行中。Owner：PM t35（GPT-6-Astra／low）；Web t30、Server t31、Runtime t32（GPT-6.1-Sol／xhigh）；黑箱 QA t33（Muse Spark 1.3 Contributor／xhigh）。2026-11-11 已核對 Herdr 啟動參數及各 pane TUI 模型，沿用共享 repo 單檔 owner；不安裝新套件、不自行 commit／push。

| 任務 | 狀態／Owner | 交付與最小驗收 |
| --- | --- | --- |
| 真實網頁 WebRTC 細字清晰度 | 完成（模組驗收，未部署）／t32 | production 僅 contentHint=text；PM 真 RTP regression 2/2 PASS，含1280×720、3解碼影格、JPEG與原頁繼續。對照videoEdgeMAE 50.62→16.50（JPEG16.16）；證據 /private/tmp/whippet-m5-quality。可見部署demo尚未驗收 |
| Workspace 設定 API／持久化與快照 | 完成（模組驗收，未部署）／t31 | 2026-11-11 Go server/gateway 測試與 Linux arm64 build 通過；PM 以隔離 PostgreSQL 16.11 實跑 fresh001→006、upgrade005 快照／草稿失效／歷史timeout／不可變保護兩子案例 PASS（0.441s）；端到端待 Web／Runtime |
| Workspace 設定 UI | 完成（隔離驗收，原服務未部署）／t30；QA t33、PM執行 | 2026-11-11 真實Mac Chromium smoke exit0：儲存／重載、未存腳本全文保留、舊草稿操作阻擋、no-op不增revision、409、未知欄位400、設定還原皆PASS；scripts/test/m5-settings-ui.cjs，截圖 /private/tmp/whippet-m5-settings-evidence/；臨時容器與網路已移除 |
| 設定傳入 author／Worker | 完成（模組驗收，未部署）／t32 | Manager TestM5 2 PASS、author mock 1 PASS、build通過；PM真Worker workspace tests 3/3 PASS無skip，relative goto/PNG與legacy皆succeeded。證據 /private/tmp/whippet-m5-runtime-evidence；PM隔離全鏈相對URL草稿驗證→發布→正式Run succeeded，固定快照一致（Run b7c74923-f6ab-439a-954a-107383f6f691） |
| 正常 Dockerfile 建置與啟動／持久化指南 | 受阻（依賴層無快取）／PM | 2026-11-11 停用建置網路試建：Server 在 go mod download 失敗；Web npm ci 未命中快取，停止。禁止下載新套件，未宣稱乾淨建置通過；功能驗收可沿用既有 binary／dist |
| Linux Server＋Mac Docker 跨主機流程 | 受阻／PM＋t33 | 尚缺遠端 Linux 主機；現有 OrbStack Linux 容器不等於跨主機驗收，獨立工作照常推進 |
| 實際 TURN 跨 NAT | 受阻／PM＋t33 | 尚缺可驗證 TURN／網路環境；不擴大成完整 NAT 矩陣 |

交付：設定網站 → 建立 → 對話修改 → 驗證 → 發佈 → 執行 → 清楚監看 → 報告。已通過 M1–M4 證據沿用；只對新增設定、畫質與部署變更做相關驗收。第一批 agent 不部署／重啟共用服務，統一由 PM 整合後安排 QA。

## M6：MVP 證據附件與開源交付

狀態：進行中（功能整合已通過，開源交付仍有缺口）。契約 contracts/mvp-v6.md；t31 Server、t30 Web、t32 Runtime 已交付，t33 黑箱腳本由 PM 實跑通過，各 Agent 待命。

- [x] trace：Server migration007／配額／列表／attempt隔離與真DB測試 PASS（0.636s）；Runtime真fail/pass fixture PASS無skip。隔離全鏈失敗Run `86d6fe61-ebf4-4c67-b4a4-2898de9d1225` 保留ZIP/MD/PNG，API與Web真下載hash一致。
- [x] 報告附件：Web build及Mac Chromium下載PASS；本機既有show-trace成功載入Set content、toHaveText失敗與error-context。HTML Failed1/Passed0、Expected/Received與noCopyPrompt正常，兩頁0 HTTP/pageerror/CSP錯誤。影片與內嵌viewer不支援。
- [x] README與必要操作說明：已更新設定快照、下載與部署限制；直接依賴版本與本機LICENSE核實表完成。
- [ ] 映像第三方聲明：OS／瀏覽器／FFmpeg等實物授權未全部核實，不以Playwright授權概括映像；發布前補齊。
- [ ] LICENSE：受阻，待使用者選定授權；不自行採用候選 Apache-2.0，也不阻塞其他交付。

最小驗收於2026-11-11通過：真ZIP 12,931 bytes／MD 1,145 bytes，API與瀏覽器下載SHA1一致。腳本 scripts/test/m6-artifacts-ui.cjs；截圖、下載與Trace Viewer證據 /private/tmp/whippet-m6-download-evidence。隔離容器、網路與本機Viewer已關閉；原服務未更新，未commit／push。整體仍待授權與映像第三方聲明。

## 本期不排入

真實登入／SSO、RBAC 管理介面、多 Manager 排程、Polling／HTTP Push 實作、遠端人工接管、全面瀏覽器矩陣、Kubernetes、完整負載測試與自動修復正式版本。

## M7–M9：AI 優先操作與多 Workspace

2026-11-12 使用者已確認需求，要求本輪先更新規格／計畫／分工。規格文件已提交 1e6fd7e。首波已派出：t30 進行不依賴新 API 的 UI 切片；t31／t32 先回覆最小契約提案，未固定契約前不改共同介面。Owner：PM 本 session（已核對 gpt-6-astra／low），Web t30、Server t31、Runtime t32（sol／xhigh），QA t33（Muse Spark 1.3 Contributor／xhigh）。

依據：[需求](../requirements/ai-workspace.md)、[架構](../architecture/design.md)、[分工](delegation.md)。不安裝套件、不印憑證、不自行 commit／push。

| 順序／任務 | 狀態／Owner | 交付與必要檢查 |
| --- | --- | --- |
| M7.0 最小編輯週期與摘要契約 | 完成／PM，t31／t32 已提案 | 已固定 contracts/mvp-v7.md；統一skillId/version、摘要schema與無副作用查詢，補正legacy草稿判斷 |
| M7.1 一般詳情與對話工作區 | 完成（模組建置，UI整合待驗）／t30 | 一般/編輯模式與固定契約接線交付；最後tsc/Vite build PASS，46 modules；t33已交付黑箱腳本；沙箱無本機Playwright/連線，瀏覽器實跑待PM |
| M7.2 編輯週期與版本背景 | 完成（模組與隔離DB驗證，未全鏈整合）／t31 | migration008、純讀/start/scope、摘要/發布/discard交付；定向單元PASS0.264s、PM隔離DB兩案PASS0.521s；Linux arm64產物 /private/tmp/whippet-server-m7 |
| M7.3 測試編輯／驗收摘要 skills | 完成（模組驗證，未整合）／t32 | author mock13/13、Manager TestM7三項及TestM3Author、Worker build與Linux arm64 cross-build PASS；dist＋skills需一起部署；quick_validate缺PyYAML未成功，不安裝 |
| M7.4 主流程整合 | 進行中／PM＋t33 | 既有 Workspace 建測試→驗證→摘要→人工發佈→正式執行→重開續編／放棄一次；不重跑 M1–M6 |
| M8.0 Workspace 與安全執行契約 | 待辦／PM，t31／t32 提案 | 固定 proposal／revision、target／dependency、機密引用與回收、出站限制及舊資料遷移；不做通用治理平台 |
| M8.1 Multi-workspace 與設定提案 API | 待辦／t31 | 建立／切換／更新、獨立對話、機密保存、統一 workspace scope；兩工作區隔離檢查 |
| M8.2 Workspace 對話 UI | 待辦／t30 | 建立／修改背景、範圍確認、專用機密輸入、提案確認；build＋最小操作 |
| M8.3 Workspace skill 與受限登入探索 | 待辦／t32 | 訪談、確認後探索、帳密表單工具、出站限制與證據遮蔽；合成網站成功／越界拒絕及機密不外洩檢查 |
| M9 背景串接與完整操作交付 | 待辦／PM＋各 owner，t33 黑箱 | 新 Workspace→對話設定→新測試→驗證／監看→摘要／發佈→修改設定與續編；既有版本快照不被覆寫、撤銷許可有效 |

推進順序：M7.0 → M7.1／M7.2／M7.3 並行 → M7.4 → M8.0 → M8.1／M8.2／M8.3 並行 → M9。Web 可先依已固定契約製作畫面，不等待所有後端功能；Runtime 範圍限制方案可在 M7 交付後先查核，避免 M8 晚期才發現阻塞。

完成以可操作切片與必要檢查為準；文件建立不算功能完成。只針對修改模組建置、核心狀態測試與一條主要流程，通過後推進。黑箱使用合成網站／帳密，不把真機密或專案原始碼傳給 Contributor。

## 接續方式

2026-11-12 使用者授權先提交 M7 現況，再推進 M8；M7 UI/真AI全鏈未驗收項目保留至後續整合，不標完成。下一步固定 M8 最小契約並向原 t30／t31／t32 派工；派工前重查 pane 狀態與模型，每檔單一 owner。t33 在可操作切片就緒後才執行黑箱。M5／M6 既有證據沿用；Dockerfile 離線依賴、跨主機／TURN、LICENSE 及映像聲明不阻塞本輪 UI／AI 開發。18080 是舊部署，最新畫面須用既有產物的隔離預覽核對。本機瀏覽器執行未授權，不納入 M7–M9。

## M1 後的模型預配置

狀態：完成。Owner：Runtime t32（Codex sol／xhigh）、總指揮整合。M1 已先提交 `0b6f2f9`，再完成 OpenCode Go Muse Spark 1.3 Contributor／xhigh 的 Responses API 預配置、CLI 與獨立 Compose。TypeScript build、8 項 mock 測試、Worker Docker build 與容器離線 ai-check 通過。2026-11-11 使用者提供 key 並授權實測，單次 live probe 成功（completed、264 字元、requests=1）；未輸出或提交 key，不視為 M3 AI 對話已完成。設定方式見 [OpenCode Go 指南](../guides/opencode-go.md)。

## M3 後續：本機驗收案例與 Playwright 技能

狀態：完成。Owner：總指揮整合、Server t31／Runtime t32（Codex sol／xhigh）、QA t33（Muse Spark 1.3 Contributor／xhigh）。四個實際 Whippet UI 案例經 Worker 驗證後發佈，9 張關鍵 PNG 在真實 Chromium 報告正常載入，登入截圖經目視修正過場問題。PNG 附件管線、失敗自動截圖與 author 實際載入的精簡技能已部署；技能包含 locator／等待／斷言／修復／截圖 recipe，mock request capture 與必要 build／測試通過。較長腳本的 WS frame 問題已修復，原受阻 Run 沿用原 attempt 成功。

驗收入口、報告及實際檢查見 [本機驗收指南](../guides/whippet-acceptance.md)。限制：trace／video／Markdown 附件未支援；額外失敗範例 PNG 可見，但 error-context.md 的 CSP 檢查未通過，已如實記錄。本輪無新模型呼叫、未安裝套件、未執行 Git 操作。

M7契約裁定：Worker 遠端歷史按需檢索延至 M9；M7 先使用週期摘要＋近期訊息，完整歷史仍保存，不能宣稱已完成 Worker retrieval。M9 需固定 session-scoped 有界唯讀接縫後補齊。

2026-11-12 PM M7隔離DB驗證：以既有postgres:16.11-bookworm建立獨立臨時DB，TestM7EditingLifecycle與TestM7LegacyMigration全部PASS，無skip，套件0.521s；log=/private/tmp/whippet-m7-db-check.log。容器已移除、共享服務未動。Server正式build與Web最終交付仍收尾，尚未完成新版UI／真模型整合。

M7隔離UI環境已啟動：18085，whippet-m7-web/server/postgres及內部network whippet-m7-qa；既有映像＋最新binary/dist建立m7-qa，非乾淨Dockerfile建置。Manager/AI尚未接入。t33已派一般/編輯/續編/放棄首切片黑箱，證據預定/private/tmp/whippet-m7-ui-evidence；原18080未動，整合結束需移除隔離容器/網路。Server最終Linux arm64與Web最終build皆由owner回報PASS，完整AI主流程尚待驗證。

M7預覽連線修正：Web僅掛internal網路時HostConfig雖有18085，實際NetworkSettings.Ports為null，主機curl拒絕連線。新增whippet-m7-preview橋接網路並僅接Web後映射生效；主機Web及API均HTTP200。清理時需一併移除此preview網路。先前只檢查容器內healthcheck不足以證明主機可達，後續預覽交付必須核對主機HTTP。
