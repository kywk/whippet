# MVP 實作計畫

規格已寫入；M1 三個模組首批程式已交付；M1 已完成本機真實端到端驗收：成功、斷言失敗及兩份 HTML 報告顯示皆通過。M2、M3 已完成本機驗收；M4 已完成本機驗收；M5／M6 本機功能已通過，部署與開源缺口獨立追蹤；M7–M9 對話工作區已完成本機驗收；目前優先 M10–M12 Use Case 與 Agent 平台化（見文末章節）。需求以 [MVP 規格](../requirements/mvp.md) 為準，技術邊界見 [架構設計](../architecture/design.md)，負責範圍見 [分工計畫](delegation.md)。

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
| M7.4 主流程整合 | 完成（主流程＋既有checkpoint證據）／PM t3v | 真AI產稿/驗證/摘要、真UI發布/正式Run通過；續編/放棄沿用既有核心PASS，不重跑。歷史URL-only abort限制保留 |
| M8.0 Workspace 與安全執行契約 | 完成／PM t3v | v8 A/B與敏感媒體順序已落實；真AI確認範圍/角色登入/執行及回收通過，詳最新驗收收尾 |
| M8.1 Multi-workspace 與設定提案 API | 完成／Server交付、PM整合 | 真API、角色保存/resolve、兩Workspace隔離及真AI提案套用已驗收；既有定向DB證據沿用 |
| M8.2 Workspace 對話 UI | 完成（MVP驗收）／Web交付、PM整合 | 核心對話/隔離、真AI摘要UI發布與正式執行PASS；Workspace author監看真影格PASS；既有UI checkpoint證據沿用 |
| M8.3 Workspace skill 與受限登入探索 | 完成（MVP驗收；已知限制見收尾）／Runtime交付、PM整合 | 真AI正常登入探索/產稿/驗證/摘要全鏈PASS；越界/機密/敏感媒體證據沿用。12秒disabled慢表單author登入未成功，不納入登入PASS |
| M9 背景串接與完整操作交付 | 完成（本機MVP整合）／PM t3v、Server t41、Runtime t42、QA t43/t44 | 真模型兩頁有界history成功找回近期12則外代碼；設定更新後同session新背景、舊Version不變PASS；撤銷取消/拒history沿定向DB證據。詳最新M9收尾 |

推進順序（使用者最新授權允許M7待驗與M8開發並行）：M7.0 → M7.1／M7.2／M7.3 並行 → M7.4整合保留；M8.0 → M8.1／M8.2／M8.3 並行 → M9。Web 可先依已固定契約製作畫面，不等待所有後端功能；Runtime 範圍限制方案可在 M7 交付後先查核，避免 M8 晚期才發現阻塞。

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

2026-11-12 使用者授權提交並推進M8：M7現況已提交bc5f86d，未push。M7 UI黑箱僅腳本交付、AI全鏈仍待驗，不以提交代表整合完成。M8首波已派t31/t32一次最小契約提案（/private/tmp/whippet-m8-{server,runtime}-proposal.md），t30開始不依賴新HTTP的Workspace對話介面；三位核對sol/xhigh。PM固定v8後才啟動跨模組API/安全執行接線；未實現的強制範圍限制不可默認放行。

M8契約A已固定：t31 Workspace資料/訪談/proposal/機密AEAD保存，t30接線，t32 workspace-author@1無browser訪談先交付。B受限探索/實際網路腳本/登入證據仍未固定與未交付；Runtime的offline-only提案不能代表使用者同意刪除網路測試。不得將M8或完整產品驗收標完成。

M8 A Server主接線已交付至必要檢查階段：Workspace/proposal/AEAD與TLS listener/healthcheck；尚未A整合驗收。A允許test-author三個離線安全工具，不建browser，不允許request_validation；run/validate/新publish在安全執行未就緒時503。此限制為暫態，B真網站執行仍為必要交付。

M8 Runtime A owner回報固定可整合：Worker build及M8 mock5/5 PASS；Manager TestM8/TestM7/TestM3Author PASS0.701s；Linux arm64產物/private/tmp/whippet-manager-m8a，Worker部署須包含dist＋完整skills。含workspace-author/無browser edit/request_validation拒絕/owner與journal/schema檢查。DELIVERY收尾中，未真模型或Docker整合；B受控真網站執行提案仍待定，不標M8完成。

M8 B提案已收到（/private/tmp/whippet-m8b-runtime-proposal.md），尚未批准：受控TS子集會拒絕任意Node/evaluate/迴圈等，登入後停DOM/影像會限制AI探索，PM已向使用者釐清這兩項產品相容性。HTTP1.1/無WS限制亦未定案。A整合可獨立繼續；B未開始實作，不把提案當使用者授權。

M8 A PM真隔離DB首跑TestM8WorkspaceSliceA FAIL0.292s：案例以空草稿驗證，先回ErrInvalid，未到預期security_unavailable；已交t31補合法非空合成腳本再測原安全斷言，不能以任意error當PASS。log=/private/tmp/whippet-m8a-db-check.log；臨時DB已移除，尚未記A DB通過。

M8 A DB修正後實跑PASS：TestM8WorkspaceSliceA無skip，test0.36s／套件0.706s，log=/private/tmp/whippet-m8a-db-check-retry.log。涵蓋migration009/雙Workspace/proposal/AEAD與scope及有效非空腳本security gate且未排Run。僅修正測試前置，產品錯誤順序與安全斷言未弱化；臨時DB已移除。Server Linux arm64產物/private/tmp/whippet-server-m8-a（含TLS）已交付，A Web/真AI/TLS代理整合仍待驗，B待使用者產品邊界決策。

M8 A隔離預覽已啟動於http://127.0.0.1:18086：whippet-m8a-web/server/postgres，內網whippet-m8a-internal與Web橋接whippet-m8a-preview；Nginx至Server HTTPS verify on/固定SAN/合成短效測試憑證，主機Web/API皆HTTP200。使用快取映像＋固定binary/dist，不是乾淨建置；18080/18085未改。尚無Manager/AI，專用credentials真保存與瀏覽器對話全鏈仍待驗。測試資料與TLS材料只在/private/tmp/whippet-m8a-preview及隔離容器，整合結束需移除；未讀/輸出真憑證。

使用者已裁定M8 B：AI工作流盡量限於測試網站，工程師手動修改的Playwright不套網站限制；其他依PM建議，允許AI探索登入後頁面但不取得密碼/Token。受控AST子集/全部network=none/登入後禁DOM影像/協定降級不採用。B改沿既有runner與真報告，以AI工具範圍檢查/來源辨識/專用登入及敏感資料處理交付；不再等待先前選項答案。下一步一次對齊來源與credential wire後實作。

M8 B Web無新wire介面準備已交付：工程師手動修改/回AI續編入口，僅切本機操作方式、不改來源或權限；一般仍唯讀。typecheck PASS，未重跑Vite/瀏覽器；待Server來源/分能力契約固定再接線。t31修訂提案與t32 AI工具origin gate持續進行；18086仍A固定預覽。

M8 B來源/四capabilities/確認快照契約已固定（v8 B段）：ai/manual/legacy由Server寫入路徑裁定，legacy保守範圍、人工完整執行，no-op不洗來源。t31啟動migration010及能力/runner/發布恢復、t30接權威欄位、t32接scriptOrigin與登入helper。保留A通過證據；B僅做新分支必要檢查與合成真登入流程，不重跑全套。

M8 B Web分來源/四能力接線已交付：scriptOrigin ai/manual/legacy與unknown語義、各能力gate、正式Run依發布版本、離線對話可用；最後build PASS（50 modules），定向API/能力合成48 checks PASS。未部署/真API/瀏覽器整合，18086仍A。Server B主流程已落碼（010/來源/能力/確認context/resolve/角色取消），定向單元與TestM8BServerLifecycle隔離DB待驗，不標B完成。

M8 B隔離DB首跑FAIL：TestM8BServerLifecycle於line252撤銷已供候選探索Run使用的role回resource not found，套件0.522s；前置resolve與同attempt重送已過。已交t31查role可見性/候選stale與撤銷邊界，保留原取消consumer斷言。log=/private/tmp/whippet-m8b-db-check.log；臨時DB已清，B DB未通過。

M8 B DB修正後PASS：TestM8BServerLifecycle無skip，test0.41s／套件0.704s；log=/private/tmp/whippet-m8b-db-check-retry.log。根因roleEligible與confirmedProposal對同範圍stale/context_changed判定不一致，已修正並保留跨owner/撤銷限制。臨時DB已移除；Server需交修正後新binary。Runtime B主接線已落碼、Node build PASS，必要mock與合成登入真報告入口收尾中；真容器/模型/瀏覽器全鏈仍待驗。

Server B修正後固定binary已交付/private/tmp/whippet-server-m8-b（Linux arm64 CGO0，含010/resolve/roleEligible），沿用PM DB0.704s與owner定向單元。PM已快照Server及Web B到/private/tmp/whippet-m8b-images，準備m8b-qa映像；未替換18085/18086、非乾淨依賴建置。Runtime固定產物尚待交付，B環境/全鏈未完成。

M8 B Runtime固定產物已交付（dist＋完整skills、/private/tmp/whippet-manager-m8b）；PM以快取Worker映像、network=none、容器內合成網站跑單一真瀏覽器案例。首跑FAIL0.846s：被阻擋redirect後chrome-error導覽打斷下一popup導覽，尚未執行登入/報告斷言；已交t32隔離測試page並保留原斷言，待固定後重跑。未用模型/key/DB/共享服務，PNG/live仍待驗，不記B完成。

M8 B Runtime合成真瀏覽器retry PASS：fixture隔離redirect/popup page後，同一入口1 test/0 skip，7.184s；未改產品origin gate或弱化斷言。未知origin命中0、loginAs完整spec真成功與刻意斷言失敗、原生HTML/results及解壓ZIP已知合成敏感值檢查通過。證據/private/tmp/whippet-m8b-runtime-evidence/summary.json；PM目視PNG的Authenticated/alpha可讀且敏感文字遮蔽，成功/失敗附件SHA256相同，pm-review.json記錄。僅容器內合成網站及stdin合成resolve回應，未驗實際Server→Manager resolve/真AI/LiveView，B全鏈仍待驗；容器已自動移除，既有預覽未變更。

## 下一波：M8 全鏈整合（2026-11-12）

狀態：進行中。使用者授權先 commit M8 A/B 固定成果，再推進下一波。沿用既有模組與隔離測試證據，不重跑全套。PM負責獨立B環境及部署；t32負責真Manager TLS resolve到Worker loginAs與LiveView接線；t31負責提供最短真API建置/設定/草稿驗證/摘要/發布流程及修正整合阻塞；t30負責新版Web單一QA旅程的操作接縫及修正UI阻塞。先完成無模型金鑰的真resolve登入/報告/回收，再接真AI對話到驗收摘要/人工發布與LiveView。t33待可操作環境就緒後黑箱驗收。不得把mock或直接runner合成回應當成全鏈；不安裝、不輸出機密、不動舊預覽、不push。M9歷史retrieval不搶先擴張。

M8全鏈波次前置：已提交6df86e6（93檔，機密掃描與diff check通過，未push）；三位原owner已開始接線。t31交正常API生命週期，無直接proposal/summary繞過端點。PM備合成HTTPS Responses fixture與登入站（/private/tmp/whippet-m8-wave、容器whippet-m8b-fixture、localhost18187/18188），Worker QA映像whippet-worker:m8b-wave含public測試CA並保留TLS驗證；Manager映像whippet-manager:m8b-qa。從預設Worker容器網路經host.docker.internal確認site/provider皆200及CA/SAN驗證成功。僅前置連通，不代表真Manager resolve或全鏈驗收；無真模型/金鑰，18080/18085/18086未動。

M8全鏈隔離環境已啟動：http://127.0.0.1:18087（新版含Workspace監看入口）、原生TLS API18089、whippet-m8b-{web,server,manager,postgres}與network whippet-m8b-wave；原18080/18085/18086未動。Web/API主機HTTP200、Manager WSS connected。真公開API主線PASS：Workspace author經明示HTTPS Responses fixture產proposal→confirm-scope/confirm→專用角色保存→manual完整loginAs spec→validation→fixture摘要→QA API確認發布→正式Run。validation b4129af8-3b4d-480d-aa10-33d228a27747、formal 29f05216-0540-4909-a58e-0840efffd3a2均expected1/unexpected0；Server resolved_role_ids為該角色且slot_released=true，兩attempt journal credentialsUsed/credentialsSanitized/reclaimed=true、phase=complete，無剩餘Worker容器。附件API真HTML/results/PNG已下載；證據/private/tmp/whippet-m8-wave（flow-state、stats、journal-evidence、server-evidence、artifact-list）。無SQL寫入/繞過端點、無stub resolve或人工stdin；proposal/summary是模型替身，API確認不等於UI黑箱。真AI、Workspace探索/LiveView與完整UI旅程仍待驗。t30本輪Web build已封裝m8b-qa，未重跑mock。

整合排程更正：使用者指出先前所有owner待命，剩餘驗收尚未真正派工。PM已立即向既有t33（Muse Spark 1.3 Contributor/xhigh）派M8 UI黑箱，hc read已看到本輪Thinking: Designing a Playwright black-box test for M8。範圍為18087 Workspace提案/確認/隔離及既有正式Test唯讀/續編/放棄，scripts/test/m8-workspace-ui.cjs為QA owner。QA沙箱如不能執行，由PM在既有Worker映像直接跑交付腳本，不再以腳本交付當驗收完成。PM負責LiveView環境/執行與缺陷路由，t30/t31/t32僅實際缺陷時修復；真AI尚未啟動。

使用者授權驗收多subagent併行後，已新增t3b LiveView及t3c報告附件黑箱（Muse/xhigh），hc read確認兩者皆已Thinking實際處理；t33 UI繼續。PM提供獨立whippet-m8b-progress容器（localhost18190/progress，Worker host.docker.internal18190），每秒真進度更新30秒至Completed，供manual Run監看不影響18187站或Workspace範圍。此為測試前置，LiveView/附件/UI尚未記PASS。

M8 LiveView黑箱首跑（PM既有Worker容器）：FAIL，尚未viewer。QA腳本API排validation後page.reload回開發登入頁，line156 searchbox搜尋測試等30秒逾時；PM目視/private/tmp/whippet-m8-live-evidence/m8-fail.png確認登入頁。已回t3b修登入/Workspace導覽與先選UI再排Run時序，不放寬影格/JPEG斷言。run 3c0659d2-1aa1-416c-ab2e-f8f16079945e不作監看PASS；不把先前probe validation成功冒充媒體證據。

M8平行報告黑箱t3c交付PASS（PM核對summary.json存在）：formal29f05216及validation b4129af8皆以公開GET真瀏覽HTML Passed1/Failed0/All1、results expected1/unexpected0、PNG1280×720可讀；原生HTML ZIP用內建zlib真解壓2個非影像entry，已知合成sentinel計數0。證據/private/tmp/whippet-m8-artifacts-evidence，腳本scripts/test/m8-artifacts-blackbox.cjs；未排新Run/改資料，沿用不重跑。LiveView retry仍FAIL且未排新Run：getByLabel Workspace同時匹配select/region/aside，已交t3b改精確combobox定位，影格/JPEG未驗。

M8 LiveView精確combobox修正後重跑：登入/Workspace/Test定位通過，run45abe198已正常排入；仍FAIL60s等viewer按鈕。PM截圖確認停在測試一般模式（正式歷史0，存在繼續修改入口）；QA已核實漏進編輯模式，validation只在編輯紀錄顯示符合產品規格。回t3b補真UI進編輯region後才排新Run；未驗任何媒體，不視產品LiveView故障。

M8 LiveView補編輯入口後重跑：真UI已進編輯模式；line169精確heading因實際名稱含紀錄筆數而逾時，未排本次新validation，尚未viewer。PM截圖確認AI與草稿驗證紀錄3可見；已請t3b修含筆數定位並一次補可見元素診斷，保留媒體斷言，不記LiveView PASS。

M8 LiveView含筆數定位修正後：進編輯/紀錄區PASS，API新排run7a456816，但等待最新結果監看按鈕60秒FAIL。m8-diag.json顯示歷史仍3、無監看按鈕，表明腳本API排程未同步UI；已要求t3b改真UI「驗證此revision」+waitForResponse取得新Run，保留全部媒體斷言。尚未viewer/串流，不能歸為媒體產品失敗。

M8 LiveView真UI路徑PASS：PM在既有Worker映像執行t3b固定腳本（真點驗證此revision→單次response取Run→同Run viewer），run076e956b-87e0-4dc8-aaa6-6d8ad67bd958，WebRTC readyState4/1280寬/frames1→2；JPEG800寬可解碼且src更新，停止viewer後Run仍running並正常succeeded。PM目視WebRTC/JPEG截圖為動態進度2/30→3/30及背景變化。證據/private/tmp/whippet-m8-live-evidence/m8-live-result.json、m8-webrtc.png、m8-jpeg.png。僅manual合成進度頁，不含credential/Workspace author探索；敏感輸入時LiveView遮蔽及真AI仍待驗，不能擴稱全部M8監看通過。已通過同案例不重跑。

M8 t33 Workspace UI阻塞定位：已過登入/新Workspace/提案/scope確認。PM目視roles-dump並核對腳本，角色選項「驗收角色·未設定」其value為真UUID，QA isPlaceholder誤將未設定當佔位；未設定是credential狀態。帳密disabled另由HTTP host.docker.internal非loopback造成，畫面已明示傳輸未保護，不是Server漏角色。PM驗證QA容器--network container:whippet-m8b-web、WEB_URL=http://127.0.0.1（port80）Web/API200，Nginx→Server仍驗TLS；已交t33修角色value核對及入口，產品guard不變。fixture對話不可稱登入/探索。腳本固定後續同一UI旅程，未記全部UI通過。

M8 Workspace UI改loopback後實跑：scope200，角色/帳號/密碼皆可見且啟用，證明傳輸前置已解。續於QA輔助核對FAIL404：腳本誤造GET /workspaces/:id/roles，正確為Workspace詳情.roles；已交t33修已知契約，未改產品。此次W64ec955a未寫credential，UI全流程仍待續跑。

M8 UI重跑前腳本一致性檢查：發現收尾禁止所有PUT與任務必需credentials保存矛盾，及API找到正式Test後未切其Workspace（targetWsId未用）。已請t33一次修為只允許本次W/角色credentials PUT，並真UI切targetTest.ws再定位；其餘禁止寫入不放寬。這兩項為QA前置問題，未再排無效整條流程。

M8 UI完整retry：W3f755888，已PASS角色UUID核對、真credentials保存/欄位清空、第二提案對話接續。套用按鈕disabled導致FAIL：第二次scope確認重置QA checkbox，腳本只首輪有重勾；已交t33待scope200/真scopeConfirmed後重勾再apply，且apply response listener須在click前（原click後存在race）。不可force click或以null回應當PASS。已過段落證據保留，完整UI仍待完成。

M8 UI確認時序修正後實跑：Wa6f9a68c，credentials保存/清空、第二proposal、scope HTTP200＋GET scopeConfirmed、apply HTTP200皆PASS。隨後等正式設定region可見FAIL，漏點「查看目前正式設定（唯讀）」details summary。已交t33補真UI展開並一次核對後續收合/locator前置；不能把這個QA遺漏判產品設定未套用。現有截圖保留，完整UI仍待後段。

M8 UI checkpoint接續：W a6f9a68c已active/settings；三筆published Test使首次選取歧義，PM指定M8 manual synthetic login後續跑。已PASS API-only Workspace conversation隔離、真UI切至該Test Workspace、一般頁順序與正式腳本唯讀；報告domcontentloaded後立即讀body導致內容過少FAIL，未等待原生client rendering。交t33沿t3c已驗報告locator等待真內容，不降門檻。分段驗收，完整UI隔離與後段editing/discard未記PASS。

M8 checkpoint報告等待修正後：已PASS一般頁順序/唯讀、真報告Passed1 Failed0、真UI editing start。接續FAIL全頁「繼續修改」非唯一（頁首與歷史版本草稿列皆有入口，符合設計）；已交t33固定scope歷史版本草稿入口，維持續編POST/同session與discard權威狀態斷言。未完成discard，不記完整後段PASS；session現已建立需續用。

M8 checkpoint續編scope修正後重跑：既有session50c183ac仍active；FAIL等待編輯region，根因QA else只取id未點真UI續編，先前稱分支已PASS不準確。PM一次指出後續兩個模式錯配（resume後需回general才點歷史草稿列刪除；general開dialog取消後仍general），已交t33統一修模式轉移，保留同session/狀態斷言；未完成discard。

M8 UI後段模式修正後核心PASS：session50c183ac真UI續編200同id、返回一般再續編同id、草稿列dialog取消後仍active原id、確認放棄後API discarded且草稿列移除；一般順序/readonly/真報告Passed1 Failed0均PASS。末尾腳本exit1因requestfailed僅記URL /api/tests/3d519fe7-dd81-4d8e-809e-0843b2dfa20b，缺errorText，無法判斷正常abort或真錯；已交t33補唯讀導航診斷、t30核對cleanup取消路徑，不重建/重discard。不能宣稱整條無網路錯誤；證據m8-09/10/11/12已留。

M8末尾GET失敗：t30唯讀核對精確URL為getTest/useResource；切頁卸載或discard兩次retry均可能cleanup abort，避免舊回應寫入，未見業務缺陷。亦存在12秒timeout abort，不能僅ERR_ABORTED即忽略。已要求t33唯讀診斷關聯request時序/動作/同URL後續200；原事件缺failure原因仍保留限制，不將新重現冒充舊事件證明。不改碼、不重build/discard。

使用者再次確認進度並禁止新subagent用opencode mini。PM查明t33仍在唯讀診斷，t3b/t3c待命；以標準opencode run新增t3f真UI Workspace隔離、t3g登入監看遮蔽（Muse/xhigh），不重跑已PASS普通LiveView/報告/草稿放棄。新pane t3f/t3g已啟動，真AI由PM獨立接線，不能把這些fixture驗收當真AI完成。

M8唯讀網路診斷已執行exit0：本次0 requestfailed，但腳本未切目標Test之Workspace，兩次選Test略過；只能記Workspace切換未觀察錯誤，不能解釋原末尾事件或宣稱相關Test網路乾淨。不再以這項低價值重現反覆阻擋已通過生命週期，原URL-only事件列歷史未分類限制。

M8 Workspace真UI隔離PASS：t3f標準opencode run交腳本，PM容器實跑exit0；A a6f9a68c對話4筆、B 2f8aa581對話2筆，真UI切Workspace/開設定、可見訊息與各GET conversationId一致，B不殘留A獨有文字。僅登入POST、其餘唯讀。證據/private/tmp/whippet-m8-isolation-evidence/iso-result.json與iso-01~03 PNG，補足先前api-only隔離限制。

登入監看遮蔽：t3g交腳本與可觀測前置需求，尚未真跑且UNVERIFIED。PM核對發現原通過條件（status字串＋晚期video有frame）不足，已請t32確認公開sensitive_input與恢復訊號；不以沒捕捉到秘密當PASS。PM於獨立QA fixture新增/slow-login與/slow-session：12秒Ready前置、提交回應延遲12秒、登入後10秒Completed；保留原/login/session與provider路徑，沿同已確認origin/role，不改產品hook或Workspace設定。待固定QA採樣/通過條件後單次執行。

M8登入監看發現產品真缺口（t32唯讀）：Manager剝除sensitive_input；Web streaming時忽略waiting並留舊圖；resume新helper可能採舊answer；pause/tick有競態。遮蔽驗收暫停，不能記PASS。PM已固定v8敏感暫停/offerId UUID echo及answerOfferId接縫，派t32 Runtime/Manager、t30 Web、t31 Server relay並行修復，沿既有sol/xhigh；只跑受影響定向檢查/build，不重跑DB/整站。交付後PM更新隔離產物，單跑slow-login的暫停前/中/後真媒體案例。未部署新碼，原普通LiveView通過證據保留但不涵蓋敏感階段。

敏感監看修復接縫補明：PM採waiting/sensitive_input_complete作JPEG明確恢復事件，要求先事件再新frame；一般waiting/streaming不能解鎖。WebRTC只由全新UUID offer解除敏感鎖。已同步t30/t31/t32並更新v8，仍實作中未驗收。

敏感恢復事件補viewer綁定：Server state使用當前LiveSession ViewerID，Web以ready.viewerId嚴格核對resume，缺值/錯值不解JPEG；已同步三owner，納入當前修正與必要relay測試。

敏感WebRTC race收斂：complete先於新offer，complete前所有offer均stale，正確viewer complete後仍paused等新UUID協商及真frame。無新欄位，已同步三owner納入定向順序檢查；修復版尚未交付/部署。

t32已實作resume epoch持續complete避免輪詢漏訊號，Manager先state再offer/JPEG；另指出Server雙queue writer可能倒序。PM已交t31確認並修實際viewer writer屏障（含pause舊queued frame），以雙queue同時ready定向測試驗輸出順序。尚待owner交付，不記整合PASS。

敏感監看Server修正版固定交付：/private/tmp/whippet-server-m8-live-offer（Linux arm64 CGO0 static ELF），含offerId/權威ViewerID與實際writer media epoch/resume barrier。t31更正最終定向PASS為Server0.356s、Gateway0.351s；前訊0.473s為誤填，不作證據。未DB重測/部署，待Web與Runtime固定後共同更新隔離環境及慢速登入驗收。

Runtime敏感修復固定交付：Manager /private/tmp/whippet-manager-m8-mask（arm64 static已核對），Worker build/定向3/3與Manager race4項PASS2.072s，含真loopback resume-before-JPEG。PM已快照Server/Manager/Worker至/private/tmp/whippet-m8-mask-images並以既有快取COPY-only封裝三個:m8-mask-qa映像，未替換執行服務；等Web固定後同步部署。已用標準opencode run啟動whippet-qa-mask-v2接續已退出t3g的登入監看QA檔，依Runtime note補實際WS事件/清屏/前後新影格與模式分別判定，不用文字regex冒充遮蔽PASS。

t32 DELIVERY已固定，Manager race2.072s僅真loopback Manager wire，非公開Server/UI全鏈。補明complete state pending offerId不消耗實際offer去重ID；已同步t30/t3n及v8，避免恢復協商被合法同ID state提前擋下。不重建Runtime、不重跑已過測試。

敏感監看三端已部署至既有 B 隔離環境（18087／TLS18089）：Server/Manager/Web/Worker均改用:m8-mask-qa，資料庫、工作目錄與合成金鑰保留，舊預覽不動。部署前26筆Run皆終態。Web公開asset index-CwSWSYQ9.js SHA256=560d23aa39994064ab9f3b1517fe6168f73013ab12d8e24273fa77046bf2415d，與t30固定產物一致；Server readyz真CA驗證通過。QA t3n交付後退出，PM接手腳本必要修正：API寫稿後真UI重新載入草稿；前/後截圖依實際階段；公開answer echo欄位為offerId（answerOfferId是內部control），actual offer限定type=offer而非state.pending ID；JPEG不要求WebRTC offer；核心窗增加清空媒體斷言並保存去敏事件與samples。首輪未排Run因舊UI revision停用；f3ffd20c真Run成功且暫停/恢復有觀測，但QA錯誤欄位判讀記UNVERIFIED，不冒充PASS。慢站新增合成echo span及/slow-status非機密時序，仍沿原已確認origin、無產品hook。

敏感監看公開三端整合PASS（PM真容器／真UI）：WebRTC Run c9f05ad9-84e3-40ac-ad97-06dc2d308283，pause13711→complete25811→新offer26215→answer26224ms；敏感前21組影格遞增，核心12個取樣diff0且videoWidth/liveTracks/readyState皆0，恢復後18組遞增。JPEG Run4443b587-0ea3-4d2c-9351-b4a5bb71dd84，pause16947→complete29047ms；前兩張真圖、核心binary0且畫面清空、恢復後11 binary/10新圖來源。兩Run succeeded，真Server HTTPS resolve→loginAs完整manual spec。PM目視核心清畫面與恢復後Authenticated/alpha可讀、合成echo遮罩。證據/private/tmp/whippet-m8-login-live-evidence/{webrtc-retry,jpeg}/（含去敏WS順序、samples、三階段PNG、fixture時序），總結M8-MASK-PASS.md及pm-review.json。此波產品無新增修正；QA修正後必要兩模式通過，不重跑其餘矩陣。未驗敏感中途加入、Workspace author探索及真AI；M8整體仍未完成。未commit/push/安裝。

2026-11-12 新PM t3v接手：hc get核實parent=null、crew=1，終端實際GPT-6-Astra low；起始HEAD 8b3975e、工作目錄乾淨。全新QA t3x以標準opencode run啟動，parent=t3v且相同space/tab，去敏session metadata核實opencode-go/muse-spark-1.3-contributor/xhigh。owner僅scripts/test/m8-login-live-ui.cjs與/private/tmp/whippet-m8-midjoin-evidence，先修核中途viewer分支，再由PM逐模式實跑；未排新Run、不恢復t3q/t3r。真AI由PM負責，非機密設定確認B仍synthetic-fixture、既有M1 Manager為Muse/xhigh且key存在；尚未搬移key或變更服務，依交接禁止自行搬運key的限制等待安全暫時接線確認。M8仍進行中，未commit/push。

M8敏感中途viewer黑箱PASS（新PM t3v整合、新QA t3x Muse/xhigh交腳本後退出）：PM接手補重連click前時間戳以避免漏ready/pause；保留JOIN=0原判定，JOIN=1以新viewer獨立判定。現有Worker容器語法檢查PASS，真UI串行兩模式實跑均exit0/Run succeeded。WebRTC638e62a6：新viewer pause20605→complete29502→offer29910→answer29922ms，15核心取樣清屏/diff0，恢復18組遞增；JPEG6f6f9145：pause23968→complete32569→首binary32571ms，15核心取樣清屏/binary0，恢復10張不同圖。PM目視兩模式核心清空、恢復Authenticated/alpha可讀且合成echo遮罩。證據/private/tmp/whippet-m8-midjoin-evidence/{webrtc,jpeg}與M8-MIDJOIN-PASS.md、pm-review.json；git diff --check PASS。僅manual slow-login單viewer串行中途加入，不含多viewer併發、Workspace author探索或真AI；B仍fixture，真AI暫時接線確認待回覆。未改產品、未安裝/commit/push、不恢復舊鏈。

2026-11-12 使用者指示以重建重啟解除接線等待：PM將已驗證固定產物重新封裝為:m8-real-qa（無安裝/下載），確認B DB無活躍Run後重建Server/Manager/Web，保留DB/掛載/授權值。真AI設定沿既有M1 Manager在記憶體傳遞，不讀印或複製deploy/.env.ai、不落檔機密；M1及其他預覽未動。TLS readyz與公開Workspace API PASS，舊B應用容器停用保留為-before-real供回復。已以公開API啟動新Workspace95296031之真AI訪談Run40d7392a，結果待核實，不以設定存在當全鏈通過。

真AI首次訪談Run40d7392a succeeded，公開Workspace API確認currentProposal存在；證據/private/tmp/whippet-m8-real-evidence/first-author.json。真模型通道已實跑確認，不再等待接線授權；Workspace探索/改稿/驗證/摘要/人工發布尚未完成，不標M8完成。

M8真AI主流程續行：Workspace95296031確認同origin scope並透過專用端點保存合成角色後，探索Run0e057951成功；Manager journal credentialsUsed/credentialsSanitized/reclaimed=true、phase=complete，證明真登入與回收。套用同範圍新proposal後，AI產稿Run daeb2878成功，Test cea8a396／session1a790e12／revision2 scriptOrigin=ai；AI要求的validation acc336e4成功（expected1/unexpected0），未另排重複驗證。真AI摘要5c56a12e成功且validForCurrentDraft=true，PM已審閱與同revision證據一致。全新QA t3z→t3v、同space/tab/crew=1，實際metadata Muse/xhigh，僅owner scripts/test/m8-real-publish-ui.cjs，補真UI審閱發布，PM待交付實跑再接正式Run。未commit/push/安裝。

M8真AI主流程PASS：t3z交付後PM實跑真UI，首次因QA舊checkbox文案未點發布，按實際畫面修正後publish201，version fac81dbf、session1a790e12 published；一般頁腳本唯讀/版本/真報告可見。PM再真UI執行正式版本Run126ae0e4成功expected1/unexpected0，原生報告Passed1/Failed0目視通過；探索/產稿/驗證/摘要/正式執行五attempt均complete/reclaimed。新validation報告真解壓已知敏感值0、PNG可讀。證據/private/tmp/whippet-m8-real-evidence與whippet-m8-real-publish-evidence。尚缺Workspace author testId=null監看入口（不能用manual證據替代），已派全新t40→t3v Muse/xhigh寫唯一補驗腳本，M8待此項收尾。

## M8 MVP 驗收收尾（2026-11-12，PM t3v）

狀態：完成（依本節範圍與既有分段證據）；M9仍待辦，不混稱M9完成。沒有新增產品功能或修產品碼，只有QA腳本、整合環境與進度紀錄；未安裝、commit或push。

- 真模型：既有Muse Spark 1.3 Contributor/xhigh；Workspace95296031首次提案40d7392a、scope確認後真登入探索0e057951、AI產稿daeb2878、validation acc336e4、真摘要5c56a12e全部成功。登入探索有credentialsUsed/sanitized/reclaimed證據，AI稿來源為ai。
- 真UI：摘要/報告審閱後publish201，version fac81dbf，session1a790e12為published；一般頁正式腳本唯讀，正式Run126ae0e4 succeeded、expected1/unexpected0，原生HTML報告Passed1/Failed0。五attempt complete且reclaimed；新報告解壓及results已知合成敏感值0，PNG可讀。
- 敏感中途viewer：WebRTC638e62a6、JPEG6f6f9145均PASS，詳whippet-m8-midjoin-evidence；普通監看、原viewer敏感遮蔽、角色/Workspace隔離、續編/取消刪除/放棄沿用既有PASS。
- Workspace author監看：新QA t40的model metadata核實Muse/xhigh，parent=t3v。PM修ID抄寫、精確aria-label與UI重載，以及按實際傳輸取兩個可解碼更新影像。最終60303291 testId=null/authorMode=workspace/succeeded，WebRTC1280、frames1→2、ready.viewerId匹配，觀測pause6753→complete16848ms；目視恢復影像的欄位被遮罩。證據/private/tmp/whippet-m8-workspace-live-evidence/media-retry。這是author入口/媒體PASS，不是慢站登入PASS。
- 已知限制如實保留：慢站刻意將按鈕disabled12秒，author工具預設action timeout10秒，可能觸及逾時（未取得精確內部錯誤，不作已證實根因）；60303291模型回覆credentials_unavailable、未登入，正常/login之真登入全鏈則已PASS。330ee497探索failed的精確原因未從去敏結果確定，不能捏造；b7d345c6探索succeeded但開頁晚而自動JPEG，舊QA只等WebRTC導致未驗。敏感核心像素/媒體無洩漏的強斷言沿用先前manual兩模式，不把author僅事件觀測擴稱同等矩陣。歷史URL-only GET abort仍未分類。這些記錄不代表新增缺陷已修。
- 環境：18087／TLS18089維持真AI :m8-real-qa；DB與資料保留；舊B應用-before-real停用保留供回復；其他預覽未動。新的QA均已退出，PM t3v獨立根保留。

完整證據索引：/private/tmp/whippet-m8-real-evidence、/private/tmp/whippet-m8-real-publish-evidence、/private/tmp/whippet-m8-midjoin-evidence、/private/tmp/whippet-m8-workspace-live-evidence。腳本語法/實跑與git diff --check通過；完成不代表已Git提交、公開發布或生產環境驗證。

## M9 啟動（2026-11-12）

使用者授權先commit後推進M9。已提交ee926d8（M8驗收腳本與進度，選定檔案機密模式掃描、diff check通過，未push）。M9不重跑M8已PASS矩陣。

1. 進行中／PM t3v：固定M7延後的session-scoped有界歷史檢索契約；不建立通用RPC、不讓Worker取得Manager token、不每輪全量載入歷史。
2. 進行中／全新Server t41、Runtime t42：先提交現有接縫與最小介面提案，待PM固定後實作。兩者parent=t3v、crew=1、同space/tab，終端核實GPT-6.1-Sol xhigh。Server單一owner services/server；Runtime單一owner services/manager與runtimes/worker；PM擁有contracts/docs/deploy。
3. 待辦／新Muse xhigh QA：歷史工具實際找回近期窗口以外的一筆決策、跨session/Workspace與cutoff拒絕；確認不把機密或未來訊息帶入模型。
4. 待辦／PM＋新QA：Workspace設定更新後續編採新背景、原正式版本快照不被覆寫、撤銷許可後阻止新使用的最小整合旅程。重用M8既有發布/正式Run/監看證據，不重建全套。

沿用不安裝、不讀印複製deploy/.env.ai、不輸出憑證、不push；本輪commit指示已用於ee926d8，後續先保留工作成果待交付。不得恢復舊t30–t36或t3q/t3r鏈。

M9 v9契約已固定並派實作：專用history HTTP＋history_request/response、Run建立前cutoff、6片段/8192UTF8/頁、4次attempt-local、15秒；summary不開工具，test/workspace author按需讀。t41已開始Server cutoff/HTTP/分頁，t42已開始唯一stdin demux與Worker history client，無migration/配額表。新QA t43→t3v同crew/space/tab，去敏session metadata已核實Muse/xhigh；owner scripts/test/m9-settings-continuity.cjs，先寫可checkpoint接續的設定更新/舊Version不變驗收，不自行執行或撤銷M8角色。既有TestM8BServerLifecycle已涵蓋撤銷取消與拒resolve，沿用不重跑；新history失效路徑另補定向檢查。

M9固定產物已於2026-11-12由PM部署至既有B（18087／TLS18089）：Server/Manager/Worker :m9-qa，Web沿:m8-real-qa，DB與既有配置保留；部署前活躍Run為0，TLS readyz及公開API PASS，舊應用-before-m9保留可回復。t41定向單元0.309s、隔離DB與M9單元0.935s全PASS無skip；t42 Worker build+27/27、Manager受影響race1.760s與最後M9 race1.495s PASS。整合發現test-author skill舊句「遠端歷史不可用」與M9矛盾，owner已移除並重新COPY-only封裝Worker，無其他產品修正。

M9設定接續真AI黑箱PASS：t43腳本由PM補強完整設定僅背景變更比對、checkpoint不重POST、問題不透露marker、僅接受同Run assistant回答。Workspace95296031 revision2→3，session f615c956同週期draft3→4，validation/summary失效，原Version fac81dbf完整快照不變；新Run dfaf69df以新背景回答marker，未變稿。證據/private/tmp/whippet-m9-settings-evidence/m9-result.json。此項驗於既有M8程式（M9未修改的接續行為）；角色撤銷/新history拒絕由t41隔離DB定向證據涵蓋。

M9歷史全鏈進行中：全新t44→t3v/crew1同space/tab，標準opencode run Muse/xhigh；交付scripts/test/m9-history-live.cjs後退出。PM接手修空session建立分支並將隨機代碼增為128-bit，公開API建立專用Test c3bd8c3a/session47724b44，已開始串行真AI歷史填充/最終檢索。PASS需同Run預設輸入不含答案、去敏history成功事件、assistant答中三者，不以QA腳本交付或只答中作PASS。尚未完成；不重跑M8、未安裝/commit/push。

M9歷史全鏈首輪FAIL，未標完成：t44 effective metadata已由opencode session export核實opencode-go/muse-spark-1.3-contributor/xhigh。7輪真AI準備方案中首輪5eac1633忽略只收件指示、探索改稿，f2 7a30f20b失敗，不能作合格fixture。PM改為無活躍Run時暫停B Manager，透過公開API新建專用Test a3ad64fa/session8df48beb，12筆user逐筆queued→cancelled（無模型/assistant/summary污染），完成後立即恢復Manager。最後真模型Run ccc5f905兩次history均4–5ms內history_unavailable，回答未找到；PM唯讀證明預設12訊息及所有Run輸入沒有隨機代碼、cutoff62內確有首marker。三重斷言FAIL，證據/private/tmp/whippet-m9-history-evidence/cancel-fixture。t41/t42正在真handler+DB及Node→Manager→TLS跨接縫診斷；不重跑M8。

使用者出門授權盡可能推進完整開發驗收。已開全新t45→t3v/crew1同space/tab、effective sol/xhigh核實，獨立owner docs/release/image-components.md與scripts/release/inventory-images.py，盤點既有本機映像OS/瀏覽器/FFmpeg及授權檔。仍不安裝/下載/自行Git/變更LICENSE；Linux跨主機與TURN缺外部環境的限制保留。

M5/M6交付補強：新owner t45已完成五個既有QA映像的實物版本與授權檔盤點，docs/release/image-components.md列出image ID、OS/runtime/browser/FFmpeg版本、授權候選檔與Firefox封裝授權頁雜湊；scripts/release/inventory-images.py使用Python內建庫，離線/唯讀/無repo或socket掛載，五映像實跑exit0，Docker不可用時5項unverified/exit1已驗。PM已讀交付並將README連到盤點入口；未重跑已PASS盤點。完整聲明仍缺Alpine/npm/WebKit/Go等項，Whippet LICENSE仍待選，未聲稱開源發布完成。

M9歷史失敗已定位（81352430診斷回合）：模型將首次cursor輸出為精確字串"null"，不是JSON null；Worker precheck拒絕、未送任何history_request。去敏diagnostic只保留stage與布林（cursorLiteralNull=true/cursorEmpty=false），options/history能力/額度/stdin皆正常；暫診斷映像每回合後均已還原。真TLS endpoint probe200/no-store/6items、Server真handler+DB兩頁與Runtime真Node→TLS及Docker attach/stdin測試皆PASS，故不改Server或放寬owner/context。PM更新v9：只在模型工具入口正規化精確字串null，其他非法cursor/HTTP/IPC維持嚴格；t42修loop與定向測試後交新Worker，待全鏈重驗。

## M9 本機 MVP 驗收收尾（2026-11-12，PM t3v）

狀態：完成；M1–M8無關PASS沿用，M5/M6的乾淨安裝、跨主機/TURN與發布聲明缺口仍獨立未完成。沒有新增通用RPC、配額表或擴功能。未安裝、未讀印複製deploy/.env.ai、未新增commit或push；HEAD仍ee926d8。

- 歷史真全鏈PASS：專用Test17d105c5/session c3c1786a，12則合成user經公開API排入後取消（無模型），最後真Muse/xhigh Run400a1505-87cc-4f03-b85e-04003ab71fb3 succeeded。attempt123945f4兩次read_conversation_history:succeeded，真正經Worker→Docker stdin→Manager TLS→Server取兩頁；cutoff86，預設12則及script/settings/context/author全無隨機128-bit答案，舊history含答案且不超cutoff，最終同Run assistant答中。journal complete/reclaimed=true。證據/private/tmp/whippet-m9-history-evidence/final/{m9-history-result.json,pm-verification.json}。沒有人工將答案塞入模型，也不是合成provider；準備資料與最終推論明確區分。
- 可重現驗收：scripts/test/m9-history-live.cjs具checkpoint/原子保存/不重POST；取消fixture由PM停無活躍Run的專用Manager準備，恢復後才跑最後模型。公開檢查只標public_checks_pass；scripts/test/m9-history-pm-verify.py經READ ONLY SELECT連結輸入缺席、工具事件與回答三重證據，實跑exit0，只輸出布林/雜湊/固定事件，不印訊息內容或憑證。
- 設定接續PASS沿本輪證據：Workspace95296031 rev2→3、同session f615c956 draft3→4，真AI新背景回答、validation/summary失效、Version fac81dbf完整快照不變。t41隔離DB補設定刷新/角色撤銷取消與history拒讀；無須撤銷現有M8驗收角色。
- 實作修復：只在模型工具入口將精確字串"null"轉為JSON null；HTTP/IPC/HistoryClient保持嚴格、非法位置不放行。新回歸先紅後綠1/1；Worker build、真Node→Manager→TLS兩頁新測試PASS0.38s/race1.759s。原Worker27/27、Manager race、Server單元/DB通過證據沿用；新增Server真handler+DB兩頁PASS0.838s、Docker attach/stdin opt-in PASS/race1.850s。已移除skill舊矛盾文案。初始失敗與診斷回合保留，不把它們改標PASS。
- 部署：18087／TLS18089；Server/Manager/Worker :m9-qa，Web:m8-real-qa。最終Worker image ID cda295c1ca394034bfd9de698722c37ea2cfd30e9b9669b24048bba8c0c68ddb，loop SHA201f16ef6fe21a3e6bed3f0edb85e485c02b02fdb009f151ff7e031369b10b22；固定包無診斷helper，正式Manager未重build。DB/既有配置保留，-before-m9應用保留回復。其餘預覽未更新。
- 限制：歷史真模型代表案例為test-author；workspace-author路由/空頁/隔離以定向測試涵蓋，不宣稱另跑同等真模型全矩陣。skills官方quick_validate缺PyYAML未跑（不安裝），實際loader/schema/build已驗。正常Dockerfile乾淨建置、遠端Linux＋Mac/TURN環境、Whippet LICENSE與完整第三方聲明仍待外部條件/決策。五映像實物盤點已交付，非公開發布完成。

## 使用者指定提交與環境整理（2026-11-12）

已提交d2ba719（M9有界歷史／全鏈驗收／映像盤點，共38檔）；提交前diff check與指定檔案憑證模式掃描PASS，未push。依指示停止16個舊Whippet容器：M1四服務、M7/M8A各三服務、M3 fixture、M8 progress、四個殘留QA。保留最新B的Web/Server/Manager/Postgres及18187合成網站，資料volume/報告未刪，其他專案未動。Git只有main、origin/main與目前主worktree，worktree prune --dry-run無失效項目，沒有可清理的多餘分支／worktree。

## AI 對話原生語音輸入（2026-11-12）

測試對話與 Workspace 設定對話已共用語音輸入按鈕；僅瀏覽器提供 SpeechRecognition／webkitSpeechRecognition 時顯示。使用者點擊後才啟動，辨識完成把文字附加於草稿，由使用者確認送出；辨識錯誤顯示在輸入區，切換頁面會停止錄音。不使用 Server STT 或新增依賴。Web build/typecheck PASS；本機瀏覽器以模擬原生 STT 驗證兩處輸入、原文保留及不自動送出，無 STT 介面時按鈕隱藏。真麥克風與各瀏覽器辨識服務可用性仍依使用者設備與權限決定。新Web dist已於2026-11-12 copy-only套用至現有18087 Web容器，原靜態檔備份於/private/tmp/whippet-stt-web-backup；18087真UI再驗測試對話語音填字PASS，未送出訊息。未提交。

語音輸入中斷修復（2026-11-12）：原 `continuous=false` 且每次瀏覽器 `onend` 即結束聆聽，真語音停頓後無法接續。改為持續模式，正常 `onend` 於短暫間隔後自動重啟；手動停止、送出停用、權限或辨識錯誤會終止重啟。18087 瀏覽器模擬 STT 回歸先紅（首句後 starts=1、麥克風停止），修後綠（starts=2、麥克風保持聆聽），第二句接續、手動停止及權限拒絕不重啟皆 PASS。Web build/typecheck PASS，已 copy-only 更新現有Web容器，更新前靜態檔備份 `/private/tmp/whippet-stt-before-continuous`。未實測實體麥克風與瀏覽器語音服務，未提交。


## M10–M12：Use Case 與 Agent 平台化（2026-11-13 使用者同意）

規格見 [Use Case 與 Agent 平台化規格](../requirements/usecase-agent-platform.md)，架構見 [design.md M10–M12](../architecture/design.md)，分工見 [delegation.md](delegation.md)。開發期間每項只做「最小驗證」，通過就推進；每個階段收尾時執行一次 Z 項完整驗證。Z 項通過才能標記 tag 或 merge。

### M10 階段一：自研引擎與 Use Case（`main`）

狀態：進行中。依賴：M9 已完成。

2026-11-13 首波：PM `t3d`；新對話 Server `t4b`、Runtime `t4c`、Web `t4d`、QA `t4f`，同 space/tab、parent=t3d、crew=1。使用者改指定開發 GPT-6 Astra light（CLI low）；QA 維持 Muse Spark Contributor xhigh。M10.0 待雙方盤點後固定契約；此紀錄不代表驗證通過。

首波交付：Server/Runtime 已回覆 M10.0 差異；PM 已建立 v10 與 registry 契約候選，待雙方確認，尚未固定。Runtime M10.1 內部切片 build 與 author 34/34 通過（owner 回報），尚缺共同 registry/production partial 接線，維持進行中。Web M10.7 合成預覽 build/tsc/diff-check 通過（owner 回報），目視受 browser host 阻擋，真 API 未接。QA t4f 已啟動但 Herdr status=null、畫面空白，基準尚未取得，不列通過。

| 項目 | Owner | 內容 | 最小驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| M10.0 | PM | 先收 t31／t32 的最小差異，再固定 v10 契約：工具註冊表 schema、harness tool IPC、Test.kind／Module／stages／依賴、runner `files[]`、author `partial` 輸出、skill manifest | owner 確認無衝突 | 完成（t4b/t4c 確認 v10 裁定無衝突；registry JSON 靜態檢查通過） |
| M10.1 | t4c＋t4b | 抽出 `AgentEngine` 並把現有迴圈包成 builtin；工具註冊表分派（G4）；checkpoint 與 `partial`（G1）；snapshot 修剪（G5） | 既有 author 測試全部通過；新增預算耗盡回傳 partial 的單元測試 | 完成（author/guard/Manager測試與真三端PartialServerBridge非SKIP通過；模型為合成，真模型留M10.Z） |
| M10.2 | t4c＋t4b | skill manifest 與 `read_skill_reference`、依 skill 設定預算（G3／G6）；四個新 skill 與 playwright-authoring 補強 | skill 載入與大小上限測試 | 完成（Runtime build/author44項、Server新增4項含真PG通過；四新skill以輔助形式載入，平台工具待M10.6） |
| M10.3 | t4b | Test.kind、Module 欄位與 slug、版本依賴、Catalog 查詢、harness tool IPC 端點（由 history IPC 泛化） | Go 測試：依賴固定版本、跨 Workspace 拒絕、IPC attempt 核對 | 完成（Server build、TestM10 6/6，含隔離 PostgreSQL 2 項無 SKIP；bundle 接線仍屬 M10.4/5） |
| M10.4 | t4c＋t4b | Runner `files[]`、`@lib` 對應、依來源套用範圍；Manager 傳遞 | 人工 Module＋Use Case 成功與失敗各一，報告看得出失敗的 Stage | 完成（Runtime成功/刻意失敗Stage實跑；Server新增4項含2真PG，bundle快照/來源/assignment通過） |
| M10.5 | t4b | Plan 狀態機、Stage 依序排入、Use Case spec 模板產生、原子發佈 | 單元測試：Stage 失敗即停止、取消、批次發佈回滾 | 完成（Plan失敗/取消/遲到/候選過期/原子回滾PG測試；真三端batch摘要及回收後原子publish通過，模型為合成） |
| M10.6 | t4c＋t4b | catalog／module／usecase／plan 工具接上註冊表與 IPC | 單元測試加一次真模型「搜尋並複用」 | 完成（registry10.2；定向測試及真模型搜尋→固定版複用→Server保存非SKIP PASS，5model/3tools；未含整批發布） |
| M10.7 | t4d | Module 列表與詳情（簽章、引用者）、Use Case Stage 檢視、Plan 確認卡、Stage 進度、partial「繼續」卡 | build 加目視 | 完成（build＋真Module/Plan/批次發布目視；B隔離真partial/單次continue，限制見證據） |
| M10.8 | PM＋t4p | 黃金任務集 v1（10–15 題，含新建、修復、複用、拆解、越界、注入頁、預算耗盡），放在 `scripts/test/golden/` | 用 builtin 跑一次並記錄基準 | 完成（首次真基準與離線覆核已保存：4 PASS／2 FAIL／8 UNVERIFIED；不是完整驗收通過） |
| M10.9 | PM t4s＋Server t50＋Runtime t4z | 整合 smoke：用真模型把「登入 → 搜尋 → 下單 → 驗證」拆成 4 段並發佈 | 一條主流程 | 進行中（Plan composed/r18四Stage ready；3 author＋3 Module驗證＋整體Use Case驗證共7 Run成功並回收，待批次摘要／發佈） |
| M10.10 | PM t4s＋t4z＋t50 | 有界Module兩段暫存／commit真自試，timeout清理與安全階段觀測 | 正負真自試、三端回收／正式驗證、一次受控真模型 | 完成（分段工具／診斷、journal與Module遮蔽修補已部署；retry7三Module自試1/0、parser/upload與正式驗證及Compose成功，秘密負向守衛保持） |
| **M10.Z** | PM＋t33 | **階段一完整驗證**（見下方） | 全部通過後標記 `phase1-verified` | 待辦 |

M10.Z 清單：
1. 三個模組全部建置、型別檢查與測試（含 Postgres 整合測試）。
2. M1–M9 主流程回歸一次（AI 對話工作區規格的最小驗收，加第二 Workspace 隔離）。
3. Use Case 全流程（真模型）：Plan 確認 → 至少複用 1 個、新建 2 個 Module → Compose → 真實驗證 → 摘要 → 原子發佈 → 正式執行。
4. Stage 失敗的停止與修復；Plan 執行途中取消後，名額正確回收。
5. Module 升版不影響已固定版本的 Use Case；跨 Workspace 搜尋 Catalog 被拒。
6. AI 來源 Module 套用範圍守衛；manual Module 不套用。
7. 預算耗盡時保留 partial，按「繼續」能完成。
8. 黃金任務集 builtin 成績不低於 M10.8 基準。

### M11 階段二：MCP（`feat/mcp`，基線 `ded0364`）

狀態：進行中。2026-11-14 使用者明確授權直接開發，覆蓋原 M10.Z 開發順序門檻；M10.Z 尚未完成，未建立 phase1-verified。既有驗收現場19287保留，新工作先隔離驗證。

獨立 PM t52（parent=null、gpt-6-astra low）接手；Server t53、Runtime t54 為全新 gpt-6-sol high 對話，parent=t52，各自新 tab，crew=1、keep/outlive-parent、明確 repo cwd、no-daemon 與 YOLO 均已 hc 實核 working。PM 唯一 docs/contracts/Git owner；首波兩 owner 盤點最小接縫，v11 固定後實作。

| 項目 | Owner | 內容 | 最小驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| M11.0 | t52 PM | v11 契約：MCP 工具如何對應註冊表、Agent Token、session 租約、claim／submit；tech-stack 加入 MCP Go SDK | owner 確認 | 進行中 |
| M11.1 | t58（首波t53） | MCP 端點、Token 雜湊與撤銷、速率限制、Server 端工具、稽核、prompts／resources 提供 skill | Go 測試：列出工具、撤銷後立即拒絕、跨 Workspace 拒絕 | 進行中 |
| M11.2 | t59（首波t54） | Worker `session` 模式、Manager 租約與閒置回收、browser／login 工具代理 | 建立、閒置逾時、回收後釋放名額 | 進行中 |
| M11.3 | t5g | 接單模式：`authorEngine` 設定、claim／心跳／submit、逾時與取消收斂 | 單元測試：重複 submit、逾時、取消 | 進行中 |
| M11.4 | t55 | Token 管理（只顯示一次）、authorEngine 設定、來源徽章、稽核列表 | build 加目視 | 進行中 |
| M11.5 | PM | `docs/guides/mcp-agent.md` 接入指南；用一個現成 Agent 跑一次互動模式 | 外部 Agent 產出 Use Case 草稿 | 進行中 |
| **M11.Z** | PM＋t33 | **階段二完整驗證** | 通過後 merge 回 main，標記 `phase2-verified` | 待辦 |

2026-11-14 首波v11已固定並派實作：t53為Token／管理gate／唯讀MCP與skill resources；t54為獨立browser session核心、IPC及共用容量回收。claim/submit、互動寫入與Server session代理尚待後切片，M11.0不提前列完成。MCP啟用時管理API必須同步受保護，避免既有開發身分入口繞過Token邊界；既有19287不改。

首波Web已交付管理key記憶體登入／cookie接線、Token一次顯示／撤銷／稽核及MCP代理；`npm run build`與`node scripts/check-m11-agent-api.mjs`通過，隔離真Server整合待QA t56。external engine與來源徽章尚未啟用，M11.4維持進行中。

2026-11-14 首波程式與隔離驗證已交付（各子項仍進行中）：Server TestM11/Postgres與build PASS，Manager定向race/build PASS，Worker session＋privacy 7/7 PASS，Web build/API檢查及QA合成UI PASS，PM真HTTP smoke 18項PASS。修復Token遲到回應、Catalog DB錯誤誤成功與匿名session敏感快照，均有行為red→green。新隔離服務已回收，未動19287。詳見 [首波交接](handoff/m11-first-wave-20261114.md)；後續先固定Server session／claim wire，未完成項不提前列完成。

2026-11-14 Wave 2 匿名瀏覽器切片已交付（M11整階段仍進行中）：registry11.0 與 v11 租約契約固定；t58 接 Server 持久租約／MCP browser 代理，t59 完成 close 重送收斂，t5b 完成本機 transport（Keychain不可互動時採0600專用憑證檔）。PM 實跑真 Docker Runtime browser/reclaim 測試 PASS（2.427s），不等同 Server 全鏈驗收。t5c租約異常QA全PASS，t5d真MCP→Server→Manager→Docker→Worker 33項全PASS（含同callId不重點擊、實際回收與容量恢復）；本機持久 MCP 已獨立安裝於19587，先使用首波Server驗接入；全新Codex QA t5f實際catalog_search與skill resource讀取皆PASS。Wave2 Server已經兩路QA通過並更新本機；stdio真連線initialize、精確9工具與Catalog皆PASS，本機Workspace未確認scope。首波 39c15cc 已依使用者要求推送。

2026-11-14 Wave3 已固定test-author外部接單契約並開工：t5g Server task_claim/heartbeat/tool_call/submit與authorEngine CAS，t5h bridge metadata及external adapter說明，t5j Web引擎切換與Run狀態。t5m固定snapshot2真MCP租約異常QA已PASS，Server TestM11及external race PASS、Web build/API/UI與transport17項PASS；t5k真UI→全新Codex t5p→MCP接單/探索/提交→AI revision2→正式validation succeeded與可開啟報告全鏈PASS（1 passed，0 failed/flaky/skipped）。本機MCP已更新13工具，隔離環境已回收，腳本與正式報告保留於專用tmp證據。附帶builtin acceptance-summary Run failed，未驗摘要或發佈；詳見 [Wave3交接](handoff/m11-wave3-20261114.md)。，不以自報selfTest替代。module/usecase互動寫入、login/LiveView仍另波處理。

2026-11-14 最新執行節奏：使用者授權每wave核心必要驗證後commit/push，全部功能完成後才集中完整驗收；9eb337c已推送。實作owner維持全新Sol high，QA改用本機可用gpt-6.1-terra xhigh（使用者指定Terra）。Wave4先補普通Test/Module/Plan batch外部acceptance-summary；Wave5平台化產稿/互動寫入，後續session登入/LiveView，再M11.Z。不將M10.Z或尚未實作項提前列完成。

Wave4外部摘要切片完成：普通Test/Module/Plan batch沿原parser/CAS與權威驗證快照，Core Server測試/build、Web build/合成檢查、Worker15測試PASS；Terra t5t overlay真MCP/PG三分支current/stale共6 case PASS（20.358s）。validation artifact為合成證據，不算真Playwright；最後集中完整驗收。另owner誤跑舊TestM7出現未歸因line81失敗，已停止，不假稱舊baseline已知問題。

Wave5核心切片已完成：t5w/t5x/t5y接外部module-authoring、usecase-planner（含Plan Stage原skill）、workspace-author；t5z Terra真in-process MCP＋隔離PG的三作者權威/CAS/冪等測試PASS。Workspace正向失敗經snapshot守衛修復後red→green；Module候選仍未自試，正式validation另排，Planner ref仍由同attempt Server發行。Web typecheck/UI/build、三skill SHA載入與Worker typecheck PASS。合成證據不當真Docker/UI，完整驗收仍待全部wave。互動create/edit/validate/report與session login/LiveView仍後波。

M11.Z 清單：
1. 依使用者最新限制，不重跑 M1–M9 或舊 M10 全套／模型刷測；本次集中驗證 M11 受影響主流程，不把歷史證據算成本次通過。
2. 互動模式端到端：外部 Agent 建立 Module 與 Use Case 草稿 → 真實驗證 → 人在 UI 發佈；MCP 沒有任何發佈路徑。
3. 接單模式：UI 對話交給外部 Agent 完成；逾時、取消、重複 submit 都不重複寫入。
4. 撤銷 Token 後立即拒絕；跨 Workspace 拒絕；session 回收後名額恢復。
5. 檢查稽核紀錄與 log，確認沒有憑證或金鑰；用注入頁確認權限沒有被放大。

### M12 階段三：Agent Adapter（`feat/agent-adapter`，自 `phase2-verified` 分出）

狀態：待辦。依賴：M11.Z。M12.0 spike 可在 M11 期間於拋棄式分支先做。

| 項目 | Owner | 內容 | 最小驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| M12.0 | t32 | 2 天 spike：pi-agent-core＋pi-ai 與 Vercel AI SDK，依規格的淘汰條件與黃金子集比較；PM 裁定並更新 tech-stack | 結論文件放在 `docs/research/` | 待辦 |
| M12.1 | t32 | 開源引擎 adapter（只用註冊表工具）、多供應商 provider 設定、`beforeRequest` 遮蔽 | adapter 單元測試：遮蔽 hook、取消 1 秒內停止、沒有內建工具；長對話容量預檢／合法compaction／固定預算續接驗收依架構容量策略 | 待辦 |
| M12.2 | t31／t30 | 依 Workspace 或 skill 設定 engine、provider、model，並快照進 Run；UI 設定 | Go 測試加目視 | 待辦 |
| M12.3 | t32 | `runtimes/agent-bridge/` 參考外部 Worker（MCP 接單模式客戶端） | 完成一筆接單任務 | 待辦 |
| M12.4 | t33＋PM | 兩個引擎跑黃金任務集；PM 依成功率、工具呼叫數、token、延遲決定預設引擎 | 比較紀錄放在 devlog | 待辦 |
| **M12.Z** | PM＋t33 | **階段三完整驗證** | 通過後 merge 回 main，標記 `phase3-verified` | 待辦 |

M12.Z 清單：
1. M10.Z 第 1、2 項回歸，並重跑 M11.Z 第 2、3 項。
2. 新引擎通過全部淘汰條件測試；黃金任務集的成績與決策紀錄。
3. 新引擎跑一次 Use Case 全流程（M10.Z 第 3 項）。
4. 至少兩個 provider 各跑一次（金鑰不可用時註明未驗證）。
5. agent-bridge 經 MCP 完成一筆接單任務。


M10.3 隔離驗證環境（2026-11-13）：PM 建立專用 `whippet-m10-test-postgres`，使用既有 postgres:16.11-bookworm、loopback 15439、tmpfs；pg_isready 通過。`/private/tmp/whippet-m10-test-db.py` 僅在記憶體注入專用 TEST_DATABASE_URL，供 t4b 跑 M10 定向 integration tests；測試結果待回報，未動應用 DB。

M10 首波驗證更新：t4b 回報 Server build 與 TestM10 6/6 通過，PM 已核對測試檔/交付範圍及 diff-check；M10.3 完成，但 module/usecase 執行/發佈仍 fail closed，等待 bundle。t4c 回報 Worker author 43/43、Manager 定向 6 項通過，M10.1 仍缺 production partial、M10.2 仍缺新 skills 與 Server enqueue 快照。下一切片：t4b 接 manifest 快照產生→partial 接收與 CAS；t4c 補四個新 skill→M10.4。未跑全套 E2E、未建立階段 tag。

M10 partial 啟用門檻：Server t4b 回報 build 與 14 項 M10 測試（含真 PG、無 SKIP）通過，涵蓋 checkpoint/hash/過期/取消/回收/CAS/並發重送。Web 真 Catalog/partial/continue 接線與 build/API 合成邊界檢查通過，目視及真整合未驗，Plan/Stage 仍合成。已確認 Worker history.ts 仍走 history_request，而 Server v10 需 /tools；Runtime 優先補 v9/v10 分流及 generic IPC 定向測試，完成前禁止開 production partial，M10.1/M10.7 維持進行中。

M10.4 Runtime 切片：t4c 回報 bundle/@lib/混合來源 scope/Manager 傳遞已完成，Worker build與定向14項、Manager bundle2項通過；真Chrome合成 Module+UseCase 成功/刻意失敗各一通過，HTML/JSON辨識Stage2失敗。證據見 runtimes/worker/DELIVERY-M10.md。整體待Server bundle接線，維持進行中；Runtime優先補v10 history generic IPC，production partial未開。Web確認所有檔案位於apps/web範圍。QA已建立黃金集，基準尚未驗收；已提醒區分既有builtin與未部署M10能力及僅操作本輪自建資料。

Server接收端正式交付：14項M10頂層測試全部通過，其中真PG6項（partial3、platform2、normalSnapshot1），無SKIP；build/diff-check通過，尚未部署。正常enqueue已產完整v10快照；production啟用仍依generic IPC門檻。t4b接續M10.4 bundle快照/來源/派送，並提出M10.5/6 Plan與工具介面供PM固定；未定介面不先實作。

M10.1 generic IPC門檻：Runtime v9/v10分流10/10、真Node→Manager→TLS fixture（2模型/1genericIPC/1成功）通過；真Server handler＋PG bridge由t4b接續驗證，尚未列通過。PM另要求核對Manager author artifact partial接收，不以input snapshot相容代替output parser相容；production partial仍關閉。M10.4完成不代表Compose/Module摘要/原子發佈已開放，後三者仍屬M10.5。

M10.1 bridge已驗證：t4b執行 TestM10HarnessServerBridge（integration,m10bridge）非SKIP通過，真Node author→Manager toolChannel→隔離TLS Server ManagerAuth/harness→PG，memo1、genericIPC1/success1/failure0，opaque provider ID保留；模型端為合成Responses2請求，不能當真模型驗收。初輪fixture缺user messages已修正，最後鏈路通過。尚待三端author.json 13MiB/partial接收與Worker守衛測試，production partial仍關閉。

Server author artifact上限更新：13MiB總JSON、script raw2MiB；新增2項通過，含真PG讀取/套用約12MiB escaping候選及超限拒絕，partial主skill/update_draft授權補強。Manager/Worker對應接收與守衛測試待回報，不部署、不提前啟用。

M10.8 QA交付審查：t4f已exit0，14題定義通過但基準全部UNVERIFIED。PM讀腳本確認 --run-live 未實作任務執行，probe以猜測路徑404判builtin不可用不成立；不能當可重跑基準。已開全新Herdr QA修正任務（同PM/space/tab、Muse xhigh），要求正確契約、真執行/逐題斷言、只操作本輪自建資料，本輪先離線修正。前任對既有樣式ID的session探測/discard之所有權待證據釐清，未再做mutation。M10.8維持進行中。

M10.1 最後接線授權：Manager partial schema/權限/hash拒絕矩陣及13MiB read/open/upload/parser測試通過（含約12MiB escaping、恰上限、+1拒絕）；Worker build/author51項及guard8項通過，候選由守衛閉包持有，不採信引擎或模型注入。真Server bridge與Server13MiB門檻均已通過。PM授權t4c接正式v10 partial輸出並與t4b做隔離三端持久化→回收→continue唯一排程測試，未授權部署共享服務。M10.1待最後接線結果，未標完成；仍非真模型驗收。

M10.1 最後門檻：TestM10PartialServerBridge非SKIP通過，真Node預算1→Manager parser/HTTPS上傳→Server保存無checkpoint partial→未回收409→heartbeat回收→continue同body同Run，DB source關聯1；合成模型/隔離PG，非真模型。M10.5 Plan2項PG測試通過（CAS/取消/遲到/reuse Compose/失敗停止），create/modify/批次摘要/發佈尚未完成。registry10.1新增八工具與必要JSON schema、Module25MiB artifact及planner candidateRef/平台context，已交兩端接續M10.5/6。

M10.6 平台bridge：t4b回報非SKIP通過，真Node→Manager→隔離TLS Server/tools→專用PG，合成model4請求/3genericIPC/3success/0failure，catalog_search/catalog_get/propose_plan及canonical candidateRef收尾CAS保存draft Plan。非真模型，正常新primary enqueue/Module Stage/批次發佈尚待接線。批次summary契約與GET Plan summary唯讀接縫已固定，三端與Web接續。QA修正owner t4g已開始，Herdr live但status=null未回報；只離線修正，不跑live。

M10.5/6 batch接線：Runtime回報author.batch nested驗型/完整轉送、4MiB/32項去重排序、mode/null規則、evidence與主Run一致及summary零工具已完成，Worker新增2項/Manager1項通過。acceptance-summary主檔更新，已通知Server取最新raw hash；Module三端bridge與真模型搜尋複用仍待驗。

真模型入口準備：Server新增TestM106LiveModelServerBridge，初次僅編譯no tests to run，不計驗收。PM已讀入口，僅檢查目前程序WHIPPET_AI_ENABLED/BASE_URL/MODEL/OPENCODE_API_KEY存在性，四項皆未設定；未讀任何憑證值，尚未發出真模型請求。要求owner核對live fixture budget/model與manifest一致，其他M10.5工作持續。

M10.8 第二次PM審查仍未接受：修正版live已有HTTP流程，但終態值、continue原Run revision、HTTP錯誤分類、null Plan/reuse/G12無證據判PASS、tools指標來源仍有誤判風險。已派新Herdr QA僅離線修正與HTTP回放驗證，不跑live。t4g離線syntax/check-only成功不等於基準完成。M10.6真模型入口已由Runtime交付M106-LIVE-MODEL.md及離線2項PASS，live缺env SKIP，仍待實際環境注入。

M10.5最小驗證完成：t4b控制面9頂層（7真PG）通過；PM核對Plan取消/遲到與create/modify/active_session/create_stale/create_atomic_rollback測試及diff-check。TestM105BatchSummaryServerBridge非SKIP，真Node完整batch prompt→Manager→TLS Server/PG→batchHash CAS/回收/原子publish通過；模型為合成。Module bridge另補真dist/runner.js雙檔純計算assert與真HTML/JSON上傳，PG validation succeeded/reclaimed。仍無真網站UI/真模型整批驗收，M10.6/7/8/9/Z尚未完成。

Server最終交付補充：定向10頂層（8真PG）通過，公開Confirm去重/取消遲到及插入後故障回滾已涵蓋。尚有獨立Module summary/publish未開放之功能缺口，PM已派t4b補齊harness+body驗證/摘要/人工發布與舊證據拒絕測試；不影響已通過Plan批次M10.5判定，但M10.Z前必須關閉此缺口。

獨立Module summary/publish缺口已關閉（原始碼/隔離驗證）：t4b新增migration018及module_summary接線，5個PG情境PASS（publish、metadata/harness/body過期、摘要中metadata變更），含未驗證/validation未回收/summary未回收拒絕、immutable版本及重送；ModuleSummary與受影響BatchSummary三端bridge均非SKIP PASS，build/diff-check PASS。Runtime無剩餘介面阻礙。模型與validation reports仍為合成fixture，尚未部署或真模型/真網站驗收。

M10.8 QA第三輪：14題定義PASS、離線回放19/19 PASS（終態、source Run revision、HTTP錯誤分類、缺Plan/reuse/G12證據不PASS、工具指標與assistant Run綁定）；PM核對腳本與offline-replay.json及diff-check。僅接受離線判分修正證據，不等於完整live基準就緒：仍需本輪自有已發布Module fixture、固定版實際引用/續跑完成與資料清理實跑核對。builtin維持UNVERIFIED，M10.8進行中。

整合派工已恢復：Herdr確認t4b/t4c/t4d working，分別製備固定Server包/隔離升級驗證、Runtime COPY-only包、現有headless Chrome UI截圖。PM唯讀核對現行容器掛載/端口（Web18087/API18089）及linux/arm64；發現m9-qa tags與執行中image ID不一致，已要求各release固定核實的完整ID不pull，禁止以可變tag混用。未讀容器Env、未更動共享服務。

M9→M10升級代表驗證：t4b隔離schema非SKIP PASS，001–010基線→014故意撞名令011–013及migration ledger整批回滾、M9資料不變→移除測試衝突後011–018成功→舊單script Run可Claim→再次Migrate冪等。Server arm64/amd64離線binary完成。跨owner完整image ID不可見原因待釐清，PM要求比對Docker daemon/context（PM為orbstack，daemon ID 33ab83d5-9a2d-4921-8659-a59cdda95cf1），尚不能只定性為tag漂移；禁止fallback或pull，binary/shared包製備繼續。

PM部署產物驗證：Runtime包153檔、Server包54檔SHA全數核對通過，shared一致。裸sha256作FROM被BuildKit當遠端名稱導致初次build失敗；改建專用SHA命名本機alias並立即核對ID後COPY-only成功（未pull映像，初次有失敗metadata查詢）。M10 arm64 image IDs：Server568538c4e44110d1ba842c8437c00cadb2abe86289030d92f9f2e6949a44e511、Managerf5365b170288ccb1589dee8924ef8ab91ecdab26c1a53a8675b93668babaf838、Worker3216e013d72434205fd234f4b7a8dd40e138f10cd9a75c337e93c908c3f9eaa7。未啟動服務。Web合成目視28截圖（桌面/390窄版）、零pageerror/未處理API/水平溢出，已修實際UI缺陷；archive SHA核對通過，Web映像建置中。真後端驗收仍待進行。

Web COPY-only映像亦建置完成：linux/arm64，image ID 494d3b4c1fab485060cdc215b0ddb179d423e7cf89ef40d5334ef22b5d7a546c；四映像尚未切換共享服務。本次階段性提交保存實作與現有驗證，不代表M10.Z通過，無phase1 tag。

階段性commit：4017119（M10實作/契約/測試，未push、未tag）。提交後PM已啟動獨立whippet-m10-acceptance network/專用Postgres/TLS Server19089/Web19087；Server內建healthcheck成功、同源GET /api/workspaces真200，既有M9服務未更動。Web初次模板覆寫唯讀conf失敗，已改新容器直接nginx啟動修正；使用新合成TLS/測試設定，不讀既有憑證。Web owner已接19087做無攔截API的唯讀目視；目前新DB無UseCase/partial，尚無Manager/真模型，不宣稱全流程完成。

19087真整合首輪：Web Catalog空狀態與Workspace正式設定desktop/mobile HTTP200、pageerror0；首頁seed歷史版本INVALID_RESPONSE，尚未通過，Web定位精確欄位並與Server分工修正。獨立Manager已確認TLS連線，t4b建立owned純計算Module成功/刻意失敗fixture並跑正式validation；無模型摘要/發佈未排入，Plan/partial UI仍未驗。

部署後真手動驗證：t4b公開API新建Module4144fee0-7ace-47e2-a03c-00636cd61e25，Run1861abfd-1fdd-4a46-8456-11bc2ba97a89 succeeded(expected1/skipped0)；Moduleecd4bb35-ebfa-41e9-ad29-b89d86a1aa16，Run0ec31292-7923-46aa-bb33-cf88ce803e25預期failed(unexpected1/skipped0)，Stage1成功/Stage2 intentional-mismatch，HTML/JSON俱全。UseCase52cf7b3c-1223-4b90-bc4d-cfc59fc22a6d Plan null供UI空狀態。首頁缺陷定位為舊seed版本validationRunId明確null，Web歷史listVersions過嚴；PM同意僅歷史讀取窄相容，新增publish回應仍嚴格。另發現Module建立/metadata+harness手動編輯UI缺口，已派Web接線，M10.7維持進行中。

19087 Web seed修正已部署image713c1a22011500a18173808052d8c147745745c27fbaeb1ff837d71758f2319e；舊驗收Web保留before-seed-fix。真後端16截圖：首頁無INVALID_RESPONSE、Module成功/失敗報告及Plan null顯示，pageerror/HTTP錯誤/溢出皆0；初始FAIL證據保留。選UseCase產生2次editing-session POST（200既有session），不宣稱完全唯讀；PM要求釐清腳本是否進入編輯或產品唯讀路徑意外POST，再定向修正。Module手動UI仍開發中。

M10.7真Module UI缺口關閉：19087新image2f9bf238a8f474ed1acdf3e8fef73ec13dde2beb4cce74812688963f694b0d0b。Web owned Test34d6ad61-0cb8-4308-b893-9d29dd7d3147/session0fb78d53-cad8-4237-9b58-f2ff4a086b19：create201、完整metadata/body/harness保存200 rev2，desktop/390重開逐欄一致；owned外部CAS推rev3後舊UI PUT409僅1次、4秒不重送/本機內容保留、明確reload不覆寫。原UseCase52cf7b3c兩viewport選取Plan null僅GET零POST/PUT。8截圖、零pageerror/非預期HTTP/溢出，證據real-backend/owned-2026-11-13T05-25-52-297Z；未模型/摘要/發布/validation。接續owned Plan draft/CAS真UI，M10.7整批Plan/partial仍未驗。

M10.7真Plan draft驗證通過：owned Test99f1a379-3937-4211-995f-b8420f9778fe／Planc77cdc38-8c2e-4e15-8ac7-88d33ced49d0，32階段UI保存/desktop-mobile重開順序與literal/binding/bind一致；33階段UI不送出、API400不落資料；外部CAS後舊UI409一次不重送，放棄重開才取新revision。9截圖，無模型/confirm/發布。M10.7仍待執行/partial。PM派Server/Runtime製備離線Linux預編bridge測試包，規劃從既有配置Manager的Docker CLI直接繼承env啟隔離容器，不讀/印/落檔真key；尚未執行live。

M10.6真模型隔離bridge首輪（2026-11-13）：PM核對預編包260檔SHA及Server binary後，從既有Manager直接繼承模型環境，僅注入專用測試DB，執行單一TestM106LiveModelServerBridge。實際結果FAIL、非SKIP（testObserved=true/exitCode1/suppressedLines8）；安全摘要沒有成功計數，不能據此判定模型未被呼叫。證據/private/tmp/whippet-m10-live-evidence/attempt-1-result.json。已派原Server/Runtime owner補固定錯誤分類定位，不輸出原始模型內容或憑證；M10.6仍進行中，未標驗收通過。

M10.6真模型診斷第二輪：診斷v2封包SHA核對後實跑，FAIL非SKIP，Manager與Worker皆已執行；觀測modelRequests=5為請求啟動事件，不等於成功回應數。固定分類WORKER_FAILED，來源platform_bridge_postgres_test.go:153與harness_live_model_test.go:226；genericIPC/toolSuccess尚未取得，不能判定模型連線或工具語意原因。證據/private/tmp/whippet-m10-live-evidence/result-v2.json。Runtime接續補失敗時工具計數與Worker安全錯誤分類，先離線驗證再封新包；未盲目第三次重試、未放寬驗收。

M10.6真模型診斷第三輪：v3 SHA核對後實跑FAIL非SKIP。modelStarts=5、genericIPC=3、toolSuccess=0，工具HTTP全部400/invalid_request（3次）；search/get/propose語意皆false。Worker最後分類RESPONSE_SCHEMA_OR_GUARD，不能將其直接視為最初根因。證據/private/tmp/whippet-m10-live-evidence/result-v3.json。已交Server/Runtime owner檢查工具envelope/schema/UUID/args接縫，優先合成重現與最小修正，保留嚴格驗型，不再盲目live重試。

M10.6工具400定位補充：Server owner回報TestM106BridgeRequestDiagnostics與專用PG TestM106CatalogCursorDiagnostics非SKIP通過。null/empty/valid/malformed四例皆通registry schema，null及有效游標查詢成功，empty/malformed維持語意ErrInvalid/HTTP400；未放寬規則。此合成差異尚不能證明live根因。v4僅測試wrapper補固定tool/reason/status，等待診斷binary封包後定向觀測。

M10.6診斷v4實跑FAIL非SKIP：3次工具均catalog_search，Server皆STORE_SEMANTIC/HTTP400，表示decode/schema通過後遭拒；5次模型啟動、0工具成功。證據/private/tmp/whippet-m10-live-evidence/result-v4.json。尚未直接定因cursor：PM要求Server/Runtime合成核對Go int解碼與JSON整數表示（10.0/1e1）差異及cursor語意分支，先完成離線根因判別再決定修正，不放寬門檻。

M10.6根因判別與最小修補：Server 12組專用PG（3整數表示×4游標）非SKIP全通過，配合固定fixture的ErrInvalid分支排除，可由程式路徑唯一推論v4的catalog_search語意400為cursor驗證拒絕；未讀取游標原值，不知具體是哪個條件。整數解碼非缺陷。PM僅補registry工具description與v10文字：首次cursor=null、同query/Workspace原樣nextCursor、換query重設、null表示末頁；schema/授權不變。新registry SHA7270660dce6aadbb4d8c64965b50e18600d2f1dd469168cb226e563f616f0383，diff-check通過。Runtime接最小hash/映射驗證與新隔離包，尚未驗證修補後live。

M10.6游標說明修補實跑：封包SHA與不變binary/prompt核對後FAIL非SKIP，4次模型啟動、2次catalog_search皆STORE_SEMANTIC/400 invalid_request、0工具成功，Worker RESPONSE_SCHEMA_OR_GUARD。證據/private/tmp/whippet-m10-live-evidence/result-cursor-fix.json；description-only尚未解決問題。停止提示調整式重試，兩owner接完整null傳遞合成測試及精確cursor拒絕固定分類（不讀出原值），先離線判別與封包，不放寬驗收。

M10.6精確游標分類live：FAIL非SKIP，兩次catalog_search皆JSON_INVALID（base64解碼後JSON解析失敗）、HTTP400，4次模型啟動、0工具成功；null保真與Server正常null查詢已由合成測試排除。證據/private/tmp/whippet-m10-live-evidence/result-cursor-enum.json。Runtime接查400→模型工具錯誤回饋，提出安全可操作錯誤提示並以合成loop驗修正重試；不自動代換cursor、不放寬Server或增加預算，未再live。

M10.6固定參數回饋修正：Manager窄400/no-store/typed envelope映射、Worker pending固定enum與安全指引已由owner build/定向反例及真builtin合成loop恢復（5model/4tool）通過；PM核差異及封包SHA後實跑真模型FAIL非SKIP。3次modelStarts、1次catalog_search JSON_INVALID/400、0工具成功，最終TIMEOUT（原預算不增）。證據/private/tmp/whippet-m10-live-evidence/result-catalog-feedback.json。尚無固定回饋已送達模型的live證據，不宣稱修補有效或無效；暫停追加live，Runtime先分析送達與逾時階段的固定布林/計數觀測，不記原內容、不加預算、不重跑全套。

M10.6逾時觀測決策：Runtime真builtin合成驗provider/body/tool等待均可timed_out、外部abort為cancelled，證實現有總摘要無法判斷回饋送達。PM審閱timeout-check/PROPOSAL.md並授權最小可選觀測：固定回饋鏈布林與request階段計數，includedAtFetch僅代表本機交fetch；不宣稱遠端收到或provider支援能力。維持prompt/registry/skills/budget/timer/授權，未啟觀測不增加產品log；先離線驗分類/防洩漏/不改行為，再封包審查，尚未再live。

M10.6 observer實跑FAIL非SKIP：8個request皆fetch/headers/bodyParsed/responseAccepted；7次catalog_search均400（JSON_INVALID/BASE64_INVALID/EMPTY），0工具成功，最終BUDGET_OR_SIZE_LIMIT。feedbackMapped/frameAccepted/queued/includedAtFetch及toolsIncluded/functionCallObserved六項全true，managerProcessDeadline=0，證明固定回饋本機鏈成立但不證明遠端理解；本輪不是逾時。證據/private/tmp/whippet-m10-live-evidence/result-observer.json。停止同形live重試與加預算，Runtime先核實際serialized nullable schema與既有history字串null相容背景，再提最小接縫方案；未授權自動改cursor或放寬Server。

M10.6 actual-fetch離線定位：真runAuthor/builtin/provider builder送出cursor仍為[string,null]且required，但strict=false；原因為modelTool原schema含x-max即關strict，剝x-*後未重評。PM選僅catalog_search provider strict:true窄修補，其他工具不變；不加literal-null轉換、不改registry/local guard或Server、不silent fallback。Runtime接actual-fetch/反例最小測試及新包；尚未證明後端strict支援或修正有效，未再live。

M10.6 strict-search實跑FAIL非SKIP：8request皆完成解析，7次catalog_search均400（JSON_INVALID6/EMPTY1），0工具成功，預算耗盡；固定feedback本機鏈全true。證據/private/tmp/whippet-m10-live-evidence/result-strict-search.json。strict未遭後端直接拒絕，但nullable|string結構約束無法保證opaque cursor語意，不能宣稱後端嚴格遵守或修補有效。停止同形live，PM改請Server/Runtime評估首次搜尋無cursor與明確翻頁工具分離的最小契約方案，保持scope/游標驗證與單一registry schema；尚未修改該wire或自動轉參數。

M10.6介面修正已定：PM固定registry10.2（SHA f38d8b32fa8554d8f27f4a824be038460f32df860d8cacd4444c01b269014f5a），catalog_search只query/limit首頁，catalog_next_page接非空cursor/limit；Server以同Run/attempt成功tool result.nextCursor精確發行匹配並核scope，避免讓模型產生首頁游標。兩owner已接最小切片與定向測試，原live guard/預算不變；無自動錯值轉null、無新依賴/migration。新包需registry/skills三端一致，正式切包先排空或取消回收舊Run，未部署/未live。

M10.6最小驗收通過（2026-11-13）：PM核對registry10.2封包全SHA後執行TestM106LiveModelServerBridge，真模型→Node→Manager→TLS Server→隔離PG非SKIP PASS；5次模型請求、3genericIPC/3success，catalog_search/catalog_get/propose_plan全200，artifact上傳及canonical固定版reuse draft CAS通過，未排程。證據/private/tmp/whippet-m10-live-evidence/result-registry102.json。首頁/翻頁分離後首次通過，無游標自動轉換、不增預算；先前失敗證據保留。M10.6依該列最小驗證標完成，M10.7/8/9/Z仍未完成。接續製備同shared10.2 production包，排空/回收後再切獨立19087驗收環境，不動18087舊M9。

10.2獨立驗收部署（2026-11-13）：PM核production Server/Runtime全包SHA並以固定本機基底COPY-only建置，未pull。專用DB僅2筆終態Run且未回收數0後，保留舊容器before-registry102與/data產物再切Server/Manager；模型設定由既有程序環境直接繼承，未輸出秘密，observer=0。新image Server2a4d7da1b4de1d76a7fd00aaf6cae6e2a71e6918565e002fbc783a4c427a6f2c／Manager4fc57e7bc7e65ed617a85de1625c873ccac952e9a51742c691db2617f3b68c68／Worker97a3a8c0f322d6e3618d60dc5c52045da570a74f9152e381be367420d3c096ab；Server內建healthcheck與19087同源workspaces HTTP200通過，18087未動。t4b接新owned Module真驗證/摘要/發布seed及reuse+create Plan draft，t4d已備六個單步UI腳本待新IDs，M10.7仍未完成。

M10.7新owned前置鏈：t4b公開19087 API新Module f013a9bd-817d-4c68-9e65-5368266db354正式validation ecd6f472-2ce3-48a4-9fd8-6344513c1dc2 succeeded（expected1/unexpected0/skipped0，HTML/JSON及回收）；真模型獨立summary a11042c2-d362-4545-aaed-1a53a14a4fd0成功且有效/回收後人工發布Version32793ca5-ead9-4563-8d82-595b4e62f68d，Catalog可見，版本body/metadata/harness/證據吻合。新UseCase001a8f35-937c-448c-8891-fdfdeaab71b8／Plan059ae857-abf0-4868-8628-4d0d03684845 rev1 draft含reuse+create純計算，尚無Run。PM授權Web核對後單次UI confirm及觀察Stage，未授權此步摘要/批次發布。證據services/server/m10_registry102_acceptance.result.json；M10.7仍進行中。

M10.7真UI Plan確認發現阻礙：Web GET fixture吻合、兩viewport observe通過；僅1次confirm POST（planRevision1/confirmedtrue）HTTP200，Plan059ae857-abf0-4868-8628-4d0d03684845轉r3/stopped。reuse seed ready，create double failed，error為Module dispatch unavailable; check active editing session, slug and confirmed scope；無errorCode、Module/author/validation/candidate ID均未建立，UseCase runs空，故不是已建立Run回收問題。未摘要/發布/修改scope/重試。證據/private/tmp/whippet-m10-web-review/live-next/2026-11-13T06-53-53-584Z與result-r102.json。Server owner接公開API/原始碼/隔離測試定位前置拒絕，Web保留stopped證據，M10.7流程未通過。

M10.7 stopped根因已確認：Workspace needs_confirmation/scopeStatus unconfirmed/authRev0，AI capability reason scope_confirmation_required；create slug未存在。Server隔離TestM10PlanPureComputeRequiresScope非SKIP通過，直接dispatch精確ErrScopeConfirmation，Confirm重現reuse ready/create failed且零candidate/Run。manual validation與summary豁免不代表AI Module author豁免；屬PM fixture前置漏備，不放寬prepareAuthor。PM安排新owned Workspace僅合成https://m10-fixture.invalid且無roles/dependencies，由一次workspace-author產proposal先審核、未授權確認或探索；舊Workspace/stopped Plan保持。泛用Plan.error UX缺口另列後續，不作根因修補。

M10.7合法scope前置：新Workspace f6f4fdd5-bf28-4044-9dd2-0c06bb077736，workspace-author Runfe514441-653a-4a39-a417-1c66d3894ee2一次成功，proposal7bdc5215-d4ef-4b88-9faa-34b56236b7b9 pending/baseRevision1/contextRevision2。PM審閱完整非秘密content：唯一https://m10-fixture.invalid、無deps/roles、純計算、禁止瀏覽/網路/登入/憑證；授權t4b單次正式confirm並核capability，409/security_unavailable停。確認後才在新Workspace重建專屬seed Module真validation/summary/publish及reuse+create Plan draft，未授權Plan confirm；舊default/stopped證據保留。證據services/server/m10_r102_scope_proposal.result.json。

M10.7新scoped fixture已備：Workspace f6f4fdd5-bf28-4044-9dd2-0c06bb077736 active/confirmed rev2/auth1，AI exploration/execution可用。Module62991262-6c87-40a0-ace7-099aaabd5f60正式validation41a02589-d788-4eb9-8cfa-c3307184a2da succeeded/reclaimed；真模型summary0115688f-a939-470b-8535-ab30fe27593f一次成功有效/回收後發布固定versionf1dd26ab-d65d-4d35-9bcf-ffb2094ad9e2，Catalog可見。新UseCase0d349191-ed4a-44ec-8daa-ca950397efc7／Plana4c96e46-b57f-4bdb-9d8f-150f4b8c9af7 rev1 draft含reuse+create，無Run。PM授權Web核對後僅一次confirm並觀察，尚不摘要/批次發布；舊stopped fixture保留。證據services/server/m10_r102_scoped_acceptance.result.json。

M10.7真scoped Plan執行通過至composed：Web僅1次confirm200，Plana4c96e46-b57f-4bdb-9d8f-150f4b8c9af7 r3，seed/double ready；新Module919f9ed7-35c0-4b1a-9579-1084bff2b74c，author d13a8554-de77-40da-b3a7-13a56ba62430 succeeded（6model/5工具事件，未見browser/network/credentials），Module validation f87a6c29-1051-4e07-889c-422530fb278b與UseCase validation8e3e5f38-a771-4b54-807c-03772db25185 succeeded；候選8978cc8f-ae52-4da2-90fe-103099e36d20，兩session pending空/reclaimPending=false。45秒觀察先PENDING後GET成功，原證據保留。PM授權單次UI批次summary及provenance/回收核對，未授權發布。

M10.7真批次摘要UI通過：單次POST202，Run d50f185c-95f1-4260-9c84-000ebe545da4 succeeded，同Plana4c96e46-b57f-4bdb-9d8f-150f4b8c9af7/r3；batchHash8a2202beee481022f4d4c5ed1d5c6d5ca34da8aba69ccb346311703b5b080a73，stale=false/publishReady=true。候選僅create Module919f9ed7…/version8978cc8f…/r2，不含reuse，session回收完成；兩viewport未勾選時publish disabled，零pageerror/溢出。證據live-next/2026-11-13T07-07-25-686Z、07-08-49-346Z及SCOPED-SUMMARY.md。PM授權核同版門檻後單次UI明確確認發布，尚未有發布結果；partial仍未驗。

M10.7單次UI批次發布成功：publish POST200恰1次，UseCase version7c60723d-e1a4-4829-9e22-6979d12a3fc9/r2；moduleVersions恰候選8978cc8f-ae52-4da2-90fe-103099e36d20（Module919f9ed7…/r2），Catalog GET可見。發布後GET Plan使用已關閉editingSessionId回409，屬唯讀後驗接縫，不是publish409；腳本停止、未重送未開session。證據live-next/2026-11-13T07-11-10-011Z。Server接唯讀核對發布後done API，Web續查versions/Catalog/reuse；Plan done尚不宣稱已驗。

M10.7發布後證據與缺陷：Web published-2026-11-13T07-13-43-773Z兩viewport8截圖核UseCase7c60723d…r2/summary/validation、Module8978cc8f…r2/validation與Catalog引用正確，reuse仍原f1dd26ab版。Plan done無合法closed-session GET，維持UNVERIFIED。另發布後4秒內Test與versions GET各1903次、UI卡載入，browser已關閉，重開正常；列UI FAIL，交易成功不受影響。PM授權Server閉合session純SELECT Plan最小接縫（契約已定，寫入gate不變）與Web先合成重現再修GET迴圈，兩owner定向驗證後封新版包；不重送既有publish。

M10.7 closed Plan唯讀缺口已關閉：Server TestM10ClosedPlanReadOnly非SKIP驗published/discarded純讀、PG read-only/無當前Draft仍可讀done、跨test/workspace拒絕、active reconcile與closed PUT拒絕；build通過。PM核新production全SHA後COPY-only建置，確認零未回收Run再切獨立Server，image38700cb5f0e4e1bd815dc7977219c22cf473a228c7a81ad4481c6a3cd721eb16，舊容器before-plan-history保留。healthcheck成功；PM公開GET原closed session Plan HTTP200，a4c96e46-b57f-4bdb-9d8f-150f4b8c9af7實讀done/revision4，未建立session/重送publish。Web發布後GET storm仍待修正驗證，M10.7未完成。

M10.7 Web GET迴圈修正部署：owner以4秒合成窗口重現desktop8882/narrow9292 GET，App穩定selected Test ID綁定onModeChange後各4 GET且後2秒0；200/409/503×兩viewport六情境PASS、publish各1次，build/tsc/API邊界通過。PM核archive/dist SHA，固定基底COPY-only建置並僅替換19087 Web，imagede76ffddb9185e883b6ca8bf08324e2623c580c994ed3657c039b32298e397b3，舊before-publish-settle保留；首頁/同源workspaces200。Web接部署後已發布頁唯讀重開檢查，不重發publish；此不能冒充真發布轉場重演（轉場證據為合成）。Server另盤點新owned partial真UI fixture，尚不模型/資料寫入，M10.7仍未完成。

M10.7 partial fixture裁定：現公開messages無per-Run budget，snapshot固定manifest8model/12tool/180s；timeout/cancel/provider錯誤不算partial。PM先採一次production原預算自然耗盡方案A：新owned普通test/confirmed合成Workspace、有界純計算最多10案例、禁止browser/network/credentials/request_validation，僅一次messages不補訊息或重試。若真partial且回收再交UI；若未出現則如實記錄，不刷partial、不改manifest、不造DB資料。隔離budget1方案B僅備選未授權部署；continue需精確source appliedRevision或draftRevision且不換包。

M10.7 Web部署後唯讀重開PASS：imagede76ff…，desktop/narrow固定4秒各7 GET（Test/versions各1），後2秒全部GET=0；概覽穩定，零pageerror/HTTP錯誤/溢出。UseCase7c60723d…／候選8978cc8f…／Catalog引用與reuse f1dd26ab原版吻合，closed Plan公開GET200實讀done r4。證據live-next/deployed-reopen-2026-11-13T07-24-49-221Z（8截圖、計數、DEPLOYED-REOPEN.md）。除dev-login無POST，未重演真publish轉場；轉場修正證據仍為合成六情境，兩者分開。Web等待真partial/reclaimed新fixture與單次continue授權，M10.7仍進行中。

M10.7 partial方案A結果：新Test7f3502f4-56f5-400a-ae0c-179720bb792d／Runb202dfbd-cdda-4dc3-8dc8-d8aaf1a92bee一次author正常succeeded/reclaimed，5model/4tool、無authorPartial，不能驗continue。流程author.json requestValidation=true並自動衍生validation dcbf7a88-022b-4753-bf0f-3e4f2d6b240f succeeded，本輪禁正式validation限制未滿足；不直接歸因模型（loop成功update_draft可自動設旗標），owner已更正並保留原證據。PM不刷A，改B獨立19187/19189+專用DB/同包budget1（僅test-author manifest副本）製備；不改19087，不以隔離partial/continue驗收宣稱正式預算任務完成。

M10.7 B前置與A歸因補正：Server唯讀確認新default unconfirmed Workspace可普通test-author離線入列；全新空test只開session不PUT手動稿，legacy來源不授權request_validation，也不加browser/login。Runtime定位A旗標為builtin update_draft自試成功且allowedTools含request_validation時自動validation=true，模型final不接受此欄，故非模型設定。技能文字要求明確請求才呼叫驗證與自動旗標存在行為差異，列後續核對；B仍須實證partial/回收，不假定一回模型只呼叫read_draft。

M10.7 B隔離部署就緒：PM核budget1包SHA6bb9718…與唯一test-author manifest8→1差異，COPY-only專用Worker image648622566d7e58219eb414fb8138d38319965f46d203e347fdd6a6bc73943e0d（基底已驗10.2，dist不變）。新whippet-m10-budget1 network/專用PG/Server19189/Web19187/Manager，Server與Manager同readonly skills/registry、Worker固定同bytes；production observer關閉，真model env直接繼承不輸出秘密。健康與19187/API200通過，19087亦200未改。PM授權t4b新空test只開session不PUT、單次read_draft優先author；待實際partial/回收，不continue/重試/摘要/發布。

M10.7 B真partial成功（僅19187/budget1）：Testca5a067d-2491-4456-8f94-6bc7975553d1/session4e0dc1e5-06e8-4fd6-bd30-e628539eabf6，Run8fdf1ec1-f878-48a5-977f-06ced5decdf5 succeeded/reclaimed；恰1model+1read_draft，authorPartial budget_exhausted，artifact requestValidation=false，無script/checkpoint/appliedRevision。sourceDraft=currentDraft1，context0→2，pending空/reclaimPendingfalse，僅此author Run。證據services/server/m10_partial_ui_attempt_b.result.json。PM授權Web先observe兩viewport，再單次continue精確source revision1，至新Run終態/回收；不換包、不追加continue、不宣稱任務完成或production預算效果。

M10.7 B source pin補證：公開Run/artifact不暴露budget/hash，不能以部署預期或1model推論。PM僅對B專用DB Run8fdf1ec1-f878-48a5-977f-06ced5decdf5作READ ONLY窄欄位查詢，實證budget1/12/180000、registry10.2/f38d…、主skill test-author manifest d8c7150b…與固定包一致；未讀messages/model/秘密。證據/private/tmp/whippet-m10-budget1-environment/source-run-pin.json已交Web，標示PM DB實讀而非公開API。原單次continue授權不變。

M10.7最小驗收完成：B19187真partial UI兩viewport PASS，單次Continue body使用原source revision1→202新Run1b428eea-fffe-4109-94dd-e6c49fa2771d，succeeded+budget_exhausted partial，無checkpoint/appliedRevision，1model+read_draft，session context4/pending空/reclaimPendingfalse。pageerror/overflow0，settle4秒GET3+後2秒GET1無storm；證據/private/tmp/whippet-m10-web-review/partial-b/REPORT.md及review-1794555687419/results.json。此為budget1隔離partial/continue證據，未本輪409或冪等重送，不代表任務完成或production耗盡頻率；與既有Server CAS/去重測試分列。M10.7依build+目視列標完成，M10.8/9/Z仍未完成。

M10.8接續：PM依herdr-qa-opencode技能開全新QA t4j m10-golden-preflight（parent t3d、crew1、同space/tab、標準opencode-go/muse-spark-1.3-contributor#xhigh、keep/outlive-parent）。先離線審查production19087與budget1隔離19187界線、confirmed scope/已發布seed前置、實際budget不可假覆寫及owned manifest接縫；只修指定golden腳本/README，題目不變、不產品寫入/模型/發布。live基準仍UNVERIFIED，證據另存/private/tmp/whippet-m10-golden-preflight-r102。

M10.8 preflight審查：t4j definitions PASS/builtin UNVERIFIED、23離線回放PASS、live NOT_RUN。PM實讀發現manifest只驗形狀未傳runLiveOneTask，仍逐題建立unconfirmed Workspace，故尚不可直接live。另target守衛只檢端口且API/UI任一合規可放行。已開新Herdr QA t4k（標準Muse xhigh、parent t3d/同space-tab/crew1）補必填manifest v1、兩URL精確同源19087、純GET scope/固定seed核對、指定Workspace新建Test/僅清理本輪session；題目與斷言不降低，先離線。Server同步準備全新QA Workspace的scope proposal與G05/G06 seed設計，尚未confirm/publish；M10.8維持進行中。

M10.8 fixture審核：新QA Workspace33b9b990-e974-4732-b8f9-2d1e6bb26901 proposal681049cd-d29b-4b04-ad8b-211f3e79dd68一次模型產生，唯一m10-golden.invalid、允許本機setContent/DOM而禁網路/真登入/憑證，無roles/deps；PM授權送前核對後formal confirm及兩新Module正式validation/summary/publish。G05 ready heading；G06僅缺角色blocked表單，不能算credentials成功。普通test-author無Catalog，PM明確授權QA G05/G06 routeOverride=usecase planner（題目prompt/JSON不變），固定版reuse Plan與未完成可執行draft斷言分開評分，不能以seed或缺口阻擋假稱整題PASS。仍未跑live。

M10.8固定seed已備：QA Workspace33b9b990… formal confirm一次後active/confirmed revision2/auth1；G05 Testef24df7d…/Version7be6bb9a…，G06 Test7f53cf3c…/Version1b82353e…，各真bundle validation與一次真summary成功回收後人工發布。G06摘要確認僅blocked/未登入/未驗credentials才發布。PM公開GET核兩seed精確version/slug，寫manifest與public-preflight至/private/tmp/whippet-m10-golden-owned-fixture/。發布summary會更新名稱，故manifest附slug/publishedName，授權QA另存fixtureContext對應原hint，不宣稱舊中文名可搜；原題目prompt/JSON保持。manifest.settingsRevision比對公開Workspace.revision（非不存在settingsRevision欄）。QA仍離線接線中，尚未live。

M10.8 manifest接線審查：t4k30離線PASS、live NOT_RUN；PM核Workspace.revision映射已接，但G05/06 route/context裁定未納入且Catalog seed存在仍可能被當reuse，需實際新Plan固定依賴。已開新QA t4m（同Herdr規則/Muse xhigh）僅修四接縫：明記G05/06 planner routeOverride、獨立fixtureContext、精確Plan reuse證據與未執行draft/credentials斷言分列、budget2未實施不得整題PASS。保留題目、既有30測試與FAIL優先，不產品live。Server同步唯讀盤點M10.9/Z最小合成網站/角色前置，尚不建資料或模型。

M10.9前置啟動：PM建立deploy/fixtures/m10-shop零依賴Node合成商店（真帳密/session、受保護搜尋、新UUID訂單與同session查詢），syntax通過；本機HTTP smoke首輪受sandbox網路限制未執行成功，尚未部署/登入驗收。t4b確認Server需標準Base64的32-byte WHIPPET_SECRET_MASTER_KEY與原生TLS，角色credentials走正式API CAS；t4c確認Worker使用Docker default bridge、不繼承Manager network，需先實證固定host origin可達，不能宣稱網路層隔離。擬使用19287獨立環境保留19087 golden，單origin scope與真受保護頁斷言後才推進四Stage；M10.Z各項仍未完成。

M10.9前置實證：合成站本機HTTP smoke通過未授權/錯帳密/真session/搜尋/非法訂單/同筆查詢/新ID/未登入查單拒絕；建立專用19287/TLS19289、專用PG與Manager，沿固定10.2 production映像，新AES主key只在記憶體產生注入，19087/19187未變。站台http://host.docker.internal:19387由正式Worker default bridge讀healthz200，未宣稱網路層隔離。t4b受派僅新Workspace與一次proposal，待PM審閱再正式確認與角色credentials注入；四Stage尚未開始。

M10.8 t4m交付35離線PASS/check-only PASS，尚未live。PM核讀發現共用draft revision遞增斷言可能將正常planner-only G05/G06誤判FAIL；reuse判斷亦接受缺action。嘗試回詢t4m收到finished未送達，待新QA補same-revision與missing-action反例；未以離線數量直接批准真基準。

M10.8已開新Herdr QA t4n m10-golden-score-guard（parent t3d/crew1/同space-tab/標準Muse xhigh），只修G05/06正常planner不增draft的誤判與action必須reuse，保留35測試意圖、live NOT_RUN。M10.9新Workspace f7918b78… proposal經PM完整審閱後formal confirm一次，revision2/auth1；PM由合成站容器直接經原生TLS credentials API注入，不讀出/列印值，secretVersion1/configuredtrue、auth2且credentialLogin/aiExecution皆true。注入前兩次是本地JS syntax失敗未HTTP寫入，修正與語法檢查後首次CAS0成功；公開證據/private/tmp/whippet-m10-shop-environment/credential-result.json。t4b接login Module真登入/正式validation/一次summary，尚不publish或Plan。

M10.8 t4n修正已經PM核讀：G05/G06同draft revision不再因此FAIL、exact reuse必須action===reuse；39離線回放PASS（owner證據）。PM已啟動一次真builtin基準，雙19087與固定manifest前置GET PASS，輸出新/private/tmp/whippet-m10-golden-live-r102-20261113，未覆寫offline；目前G01執行中，不預先宣稱成績。腳本舊log仍寫逐題新Workspace，實際已核runLiveOneTask使用manifest workspace、只新建Test/session。

M10.9 login seed已真驗：Test85cb8d95…/r2，正式validation db785e6e… expected1/unexpected0/skipped0且回收；透過loginAs後受保護/products與account-state斷言通過。獨立summary5783f96a…一次成功/valid/reclaimed，PM實讀body+harness及摘要確認只涵蓋登入，已授權核pin後單次publish，再新UseCase一次真planner四Stage，尚不confirm。M10.8真基準G01 PASS，G02進行中，最終成績待整輪結束。

M10.9 login seed單次發布成功，固定Version21457a77-f2f7-4f84-a24f-f63f0ce53497；新UseCase2945eec9-ab9a-40c9-9ac4-62390dbced51/sessionff62cbe1…，單次真planner Run4e887f4b…進行中。PM唯讀GET當下Plan null，尚未確認或建立候選，待回傳核四Stage與bindings。M10.8真基準目前G01/G02/G03 PASS，G04執行中，未計整輪通過。

M10.9單次planner已保存Plan5f532f99…r1，reuse login固定21457a77…＋search/order/verify三create，search productId/price→order→verify orderId綁定正確。PM審閱發現order描述要求fill hidden不合法，授權人工Plan CAS最小修訂成核value、只填quantity，並補三Module獨立harness完整loginAs與受保護頁前置；保留原AI稿/人工差異，不改Stage args/測試意圖。待planner回收後單次confirm修正版，追至composed/stopped，不summary/publish或自動重試。M10.8 G01–G04真基準PASS，G05進行中。

M10.9原planner回收後人工Plan CAS r1→r2一次，僅三個description補正，核固定版/IDs/args未變；confirm r2一次後Plan r3 running，login ready/search authoring。M10.8真基準G01–04 PASS、G05/06 UNVERIFIED（Plan-only未完整原題執行），G07 FAIL；PM公開GET確認G07 author Run1a3ae110…status=failed、Plan null，非只評分revision誤判，不重試覆寫。G08進行中。

M10.9首輪真四Stage停在search：Plan5f532f99…r3 stopped，author513cba2a…failed/artifacts空，無validation/candidate ID；login固定版ready、order/verify pending未派送，兩session已回收。8model succeeded與2次update_module_candidate工具succeeded不足證自試passed或budget根因。已派t4c安全固定碼盤點與離線red-capable診斷、t4b保持現場，未重試/改budget/擴scope。M10.8續跑G09 PASS/G10 FAIL/G11進行中，整輪未完。

M10.9安全診斷補充：Server authorResultDisposition會將failed error改泛用訊息，亦可能incoming succeeded後收尾拒絕；本輪公開Run無原始incoming status/errorCode，所以Worker精確原因未知。t4c已收到固定progress與時間窗，先確認是否留存可白名單讀取result，不讀raw內容/秘密，沒有證據不推budget。M10.8 G11/G12腳本評分PASS，現G13，整輪成績與限制待最後審閱。

M10.8首次真builtin14題已跑完：腳本原始7PASS/5FAIL/2UNVERIFIED、exit1，證據/private/tmp/whippet-m10-golden-live-r102-20261113。全部自有session cleanup/reclaimed=true；seed與Workspace保留。PM審閱：G07/G10 author真failed；G08 succeeded但唯一FAIL為planner draft未遞增；G13/G14 succeeded無partial，budget2未套用且共用revision斷言混入。原始結果不覆寫，待離線判分審核，不直接把缺證據題改PASS。M10.9窄READ ONLY單Run取得attempt3d913e1f…，精確work result/author.json均不存在；安全證據/private/tmp/whippet-m10-shop-environment/search-safe-diagnostic.json，Worker原因UNAVAILABLE，不再追raw journal/log。

M10.9離線診斷：t4c真runAuthor+builtin合成7分支PASS，--expect-tail-complete為已實跑red control；相同8model/8tool尾端可由自試pass或fail產生，無final→limit、缺checkpoint/非法shape→invalid_response、非法JSON→外層provider_failed等，均非現場根因證明。PM核PROPOSAL後授權default-off固定碼觀測與Manager≤4KiB安全sidecar、單terminal/防洩漏/on-off等價最小測試及COPY-only包；僅19287後續單Run可啟用，尚不部署/live，budget/prompt/registry/skills/Module partial不變。

M10.9/M10.Z修復缺口已確認：既有stopped Plan無同Stage原Module session重試接縫，create重建可能slug衝突，modify需已發布版且拒接active session。獨立發布search再reuse雖可行，會改變本批原子發布範圍，PM不採此替代。t4b受派先提最小人工Stage retry契約（CAS/權威原session綁定/終態回收/同body冪等/新author.platform/前序候選再核），尚未改wire或實作。Server額外觀測先暫緩，避免未證必要即擴診斷；Runtime固定碼觀測繼續。

M10.9修復接縫契約已固定於v10文末：GET/POST /plans/{id}/stages/{stageId}/retry，Server權威資格與來源/回收、Plan+Module revision/context三CAS、明確人工content/confirmed、019獨立冪等表、保留前序候選與整批發布、舊author/validation遲到守門。t4b實作Server與定向PG；t4d接Web修復表單/資格/409與合成目視。僅開發與最小驗證，尚未部署/重試現場；Server額外observer未開工。

M10.8最小交付完成：14題首次真builtin已執行並記錄，raw7/5/2原檔保留；t4p離線覆核基準為4PASS(G01–04)/2FAIL(G07,G10)/8UNVERIFIED。PM核REVIEW與逐題證據，兩FAIL指真author Run失敗，不代表已定位產品根因；G05/06只Plan未執行、G08未驗Stage停止、G13/14預算2未套用、G09/11/12缺網路/附件等證據。覆核檔/private/tmp/whippet-m10-golden-live-review/reviewed-verdicts.json，42離線回放僅驗評分、不當builtin。M10.Z需以相同覆核口徑比較且補足未驗門檻，不能僅拿raw7/14或覆核4/14當全驗收完成。原live未重跑、題目不改。

Stage retry Web接線進度（t4d）：types/API/failed Stage人工表單已接固定v10，build/API邊界PASS；缺欄未知拒絕、16000 codepoints/原文保留、三CAS與409/503單次已驗，合成桌面歷史POST running→GET stopped顯示通過。回收/快照清確認/窄版仍收尾中，未真API/模型/部署，待Server與Runtime包一併切19287。

Stage retry Web固定包SHA0d8d1c968f7154ad97771f534bf4ad54a44bc0a71e58626ff25f1d9e68e0cd95由PM實核，12合成案例與history receipt分離證據已讀；COPY-only Web映像已建，未切服務。Runtime診斷包SHA清單9167fee2…全檔核PASS，Manager/Worker COPY-only映像已建（無下載/新依賴），未部署。Server019新增取消歷史邊界：舊cancelling/cancelled=true，其他舊Run=NULL未知，新Run=false，永久捕捉取消；retry拒true與unknown。現舊search不能特例放行，後續新fixture驗升級後行為，舊證據保留。t4b補最小測試後封包。


2026-11-14 新 PM t4q 已接任（全新 Codex gpt-6-astra/low、parent=t3d 僅 session 錨點），新 tab tb027fb2ce66f7917ad66384a6c94cca3e；Server 新 owner t4r 同模型、parent=t4q/crew1/同 tab/keep/outlive-parent，負責新 owned 四 Stage fixture，未喚醒舊 owner。Server retry 固定包48檔及SHA清單核對PASS，固定本機基底 COPY-only image 已建。19287 升級前 active/unreclaimed=0；已切 Server019、Manager/Worker診斷及Web retry，原Postgres容器、artifact volume、Server key/token、Manager ID/token/WORK_DIR保存斷言PASS，舊三容器保留。公開receipt /private/tmp/whippet-m10-shop-environment/upgrade-1114.json。未初始化/重建角色、未碰其他環境；後續健康與新fixture驗證進行中，M10.9/Z仍未通過。

2026-11-14 t4q安全停點：19287升級後health PASS、原login報告HTTP200、Workspace/角色與credential能力保持；019舊search retry唯讀回source_unavailable（planRevision4），未POST retry。pending validation/running Plan皆0（升級後補核）。新Server t4r已交離線fixture腳本與準備文件，尚未submit/API/模型。使用者最新改要求no-parent獨立PM與全部subagent YOLO；t4q已通知t4r停止並保存詳細交接至handoff/m10-pm-20261114.md末段，待新獨立PM接續，不重跑已完成升級。

2026-11-14 獨立PM t4s接手：hc實核parent=null、Astra low、no-daemon與YOLO、keep/outlive-parent。19287三服務running且image SHA與upgrade receipt一致，舊search retry仍source_unavailable/r4；未重跑升級。依最新指示新owner皆獨立新tab，沿用t4r離線fixture，先核現況再單次planner並停draft供PM審閱。M10.9進行中，M10.Z/M11/M12未通過；不tag/push。

新Server owner t4t已核實parent=t4s、crew1、keep/outlive-parent、全新Astra low YOLO argv與working狀態；獨立新tab tb09f9e2871a2687a49cdd2afcb94ac0b2（Whippet Server M10 11-14），未繼承PM tab。單檔owner範圍services/server；單次planner完成後停draft待審閱。使用者本輪禁止重跑M1–M9及tag/push，覆蓋Z清單對應舊操作要求；相關歷史證據沿用並明記未重跑。

M10.9 t4t初次fixture submit於create-usecase收到HTTP400，未送planner；PM核CreatePlatformTest既有規則禁止UseCase slug，t4r離線fixture誤帶該欄位。已要求保留原intent、核無新增資源後僅修正fixture欄位，用獨立recovery state接續一次planner；不修改產品契約、不重送原錯誤body、不計為模型失敗。

M10.9修正fixture後唯一planner已提交：UseCase 7bb3430f-3acc-4eb6-ba72-556441acc145／session 6947dc0f-9417-4b36-b0e9-c57c88f713bc／Run d97e63a7-57f4-4546-93d1-a22d7a241570。原HTTP400 intent保留，recovery receipt證明matchingTests空、active/unreclaimed=0；新state為services/server/m10_shop_t4t_recovery.result.json。尚未confirm，等待planner回收與PM審閱。

M10.9唯一planner succeeded且公開session pendingRunIds=[]/reclaimPending=false；Plan b7c83de2-5b1f-4531-b526-ba4d65682045 r1/draft，四Stage與固定login版本符合。PM已讀完整Plan，要求僅手動補order/verify獨立搜尋前置描述，保留原AI提案與diff，不再呼叫planner；修訂完成後最後核閱再confirm。

M10.9 PM完成r2審閱：僅order/verify description擴充，其他Stage欄位與args逐項不變；Compose來源核實以stageId保存回傳，不需額外bind。PM以exclusive intent單次confirm成功，Plan r3/running、login ready/search authoring；receipt /private/tmp/whippet-m10-shop-environment/t4s-confirm.json。t4t接只讀Stage/正式validation及安全sidecar觀察，失敗先GET retry，不自動重試/摘要/發布。

M10.Z離線缺口覆核派新QA t4v：標準opencode run --auto --model opencode-go/muse-spark-1.3-contributor#xhigh；當版help證實--auto為未明拒權限自動核准。parent=t4s/crew1/keep/outlive-parent/cwd已核，新獨立tab tb87286382cab3e19954ac197a2e62aa56命名Whippet QA M10Z 11-14。僅讀指定公開證據並寫/private/tmp/whippet-m10z-t4s-evidence/REPORT.md，不跑API/模型/測試。初期hc status=null但實際畫面已開始讀任務，模型effective/OSC待核，不冒稱working。

M10.9新Plan停止r4：search author 89e442bb-4117-4063-98c3-b7ae1018a247 failed/slotReleased=true，login ready、後兩Stage pending、無正式validation。安全sidecar觀測LIMIT、自試0pass/1fail、無checkpoint、Manager WORKER_FAILED；自試根因UNKNOWN，不能猜特定預算或selector。GET retry eligible=true/r4/moduleRevision1/context1/reclaimed=true，尚未POST。新Runtime owner受派最小離線診斷與必要fixed enum增補提案，不模型/部署；不盲目retry。

新Runtime t4w已實核全新Astra low YOLO/parent=t4s/crew1/keep/outlive-parent/working，新tab tb297de7eaf32d3271de1ce356d6b320eb已命名。QA t4v離線REPORT完成exit0，PM已讀；另用sanitized session export僅投影model metadata，確認providerID=opencode-go/id=muse-spark-1.3-contributor/variant=xhigh（session ses_e2a200575ffezJP7ayFN2aRCEq）。QA未跑產品模型或測試，Z缺口不等於新失敗；執行期間hc status=null限制保留。

Runtime t4w離線原7分支與新增8標籤接縫檢查PASS，反向區分控制exit1；只證現有分類遺失，不當現場根因。PM採最小v2安全自試類別（v10文末），沿既有default-off M109 gate、嚴格v1/v2相容，不新增第二開關、不擴預算/提示/skills。t4w實作與必要測試/固定包，尚未部署或retry。

Server t4t安全reader v1/v2已交：外層版本與worker精確欄位、enum、duplicates/超限拒絕、v1與未觀測投影UNKNOWN、NOFOLLOW不變；5項離線測試一般與python -O皆PASS（owner回報），PM已檢視程式與diff-check。未重讀真sidecar/重試；Runtime分類與固定包仍製備中。

M109 v2：PM核固定包159檔SHA與基底一致，COPY-only --pull=false/--network=none建Manager c65025ac…與Worker cc7f5234…。排空Run/validation/Plan後僅切Manager，原ID/token/WORK_DIR及全部設定保存斷言PASS，Server/DB/Web容器ID未變，舊Manager保留；receipt /private/tmp/whippet-m10-shop-environment/diag-v2-switch.json。未重跑原upgrade-1114 apply。已授權t4t先核資格與環境後原Stage單次retry（CAS4/1/1）；目的為依實際自試回饋修復及取得新v2分類，根因仍UNKNOWN，不增預算或弱化斷言。尚待POST及結果，不當PASS。

原Stage首次retry已成功：t4t核Manager heartbeat約5秒、active/unreclaimed=0與三CAS後單次POST，Plan r5/running，search author 7fc9f5b0-c906-4e54-851c-916065bf2745。尚待結果與v2診斷，不自動再次retry。

首次retry已failed且回收：Plan stopped/r6，Run 7fc9f5b0… v2 terminalClass=LIMIT、selftest pass0/fail0、lastSelfTestFailureClass=UNKNOWN、無checkpoint/artifact/正式validation，order/verify pending。新GET retry仍eligible r6/m1/c2，但PM明令不再模型重試；先收固定grammar/registry白名單工具事件及預算數值投影，區分未進自試與前置工具拒絕，禁止raw內容/秘密。證據services/server/m10_shop_t4t_retry1.final.json。M10.9/Z未通過。

retry1安全事件定位：8model started/succeeded已達權威上限8，工具8/12（read_module_draft1/read_skill_reference1/browser_navigate4/browser_snapshot1/browser_login1），update_module_candidate0；未曾進入自試，無固定工具failed。不能推模型內部原因，但可定向修正探索耗盡行為。PM授權僅一次retry2，以人工content禁止重複探索工具、依已給完整fixture直接候選自試，真harness登入/斷言與原預算不變；三CAS預期r6/m1/c2需重核，不自動第三次retry。

retry2定向修復結果：原Plan stopped/r8，search Run 6e54e4b5-c9e1-4e6f-8c58-eb07fc7b6b58 failed且回收，CAS現8/1/3。browser探索0，read_module_draft/read_skill_reference各1成功，model started3/succeeded2/failed1，第3請求6heartbeat後failed，update_module_candidate0；v2 terminal/selftest皆UNKNOWN，自試0/0，無正式validation，後兩Stage pending。探索耗盡行為已消除，但新失敗不能歸因provider或timeout。PM停止後續模型retry，t4w僅離線核固定錯誤→UNKNOWN映射，不部署/模型；t4t保存intent/outcome/final/safe-events。M10.9/Z未通過，M11/M12未啟動。

retry2離線真engine案例已證AuthorError(invalid_response)會漏映射為UNKNOWN，不能據此判定現場回應。PM授權最後最小離線修補terminal INVALID_RESPONSE與可信cancelled映射，保留精確既有分類、不推原生例外；不模型/封包/部署。Server reader已同步terminal白名單，selftest拒該值，6項離線測試PASS。Runtime實作中，已部署v2固定包保持不變。

最後離線修補完成：Worker可信invalid_response→INVALID_RESPONSE、main cancelled→CANCELLED，既有精確類別優先、原生未知保持UNKNOWN；Manager/reader白名單同步。真engine同案例red exit1→green exit0、Worker build＋4最小測試、Manager3項、Linux arm64 build及diff-check PASS；main code-only cancelled僅靜態核對。報告/private/tmp/whippet-m109-t4s-diagnosis/FINAL-OFFLINE-FIX.md。source ahead of deployment，已部署v2 release逐檔SHA不變，未再封包/部署/模型。原retry2現場仍UNKNOWN；M10.9受阻、M10.Z未過，M11/M12待依賴。後續先決定模型失敗的安全觀測方案，不能把此合成修補當現場定因或直接第三次retry。

2026-11-14 使用者於476b980/ed1b860提交後授權繼續M10測試修復。PM唯讀核19287原服務running，Plan仍stopped/r8、retry CAS8/1/3且reclaimed。新Runtime t4x已核全新Astra low YOLO/parent=t4s/crew1/keep/outlive-parent/working，獨立tab tb1c3ba7d00bbbc837c7269162edf75b68（Whippet M10 模型失敗修復）。先離線補模型請求失敗階段的安全固定分類提案，避免再次UNKNOWN；未新模型/部署，不重跑原升級。

M10續作：t4x真runAuthor/engine離線16案baseline PASS，新增stage期望red exit1；PM固定v3模型請求失敗單enum契約（含結構化incomplete原因，不改8192/預算），t4x實作/封新固定包。新Server t4y接安全reader與最小離線驗型，無現場mutation；尚未新模型/部署。

M109 v3已驗：Runtime16真分支red→green、10 gate/abort＋14 observer/白名單、5既有定向、Manager含race/build PASS；Server t4y reader10項一般/-O PASS。PM核固定包287檔（manifest da6e63e4f43c04d091d97bc9d0ffd98202c8640eaf04965e04a38d077728568b），COPY-only兩image PASS，僅19287 Manager切換，保存斷言PASS；receipt /private/tmp/whippet-m10-shop-environment/diag-v3-switch.json，原切換腳本不可重跑。新t4y已核全新Astra low YOLO/parent=t4s/crew1/keep/outlive-parent/獨立tab tb2b56156d39260feca32803ca9ab31285（Whippet M10 v3 驗收）。PM授權核前置後單次retry3，逐字沿用retry2 content，唯一變項診斷，不新增planner或加預算。尚待現場結果。

retry3單次受控驗證：Plan stopped/r10、Run f0a93b46-9cf8-4c01-a1d7-fa72adcf7884 failed且slotReleased，active/unreclaimed/unresolvedValidation=0。v3權威分類INCOMPLETE_MAX_OUTPUT_TOKENS/INVALID_RESPONSE，自試0/0、無checkpoint/artifact，第三模型請求截斷，read draft/reference各1成功、探索與update候選0；只證retry3，不回填舊Run。PM已詢問使用者是否僅module-authoring輸出上限8192→16384，保留8/12/180，尚待答覆；t4x/t4y僅盤點可設定與快照方案，不改預算/模型。

輸出預算最小提案已完成：Runtime /private/tmp/whippet-m10-model-boundary/OUTPUT-BUDGET-PROPOSAL.md；Server services/server/m10_shop_t4y_output-budget.proposal.json。沿budget.maxOutputTokens可選欄與author_payload快照，不增API/migration；缺欄有效8192、主module顯式opt-in16384、其餘8/12/180不變，兩端effective比較、舊hash不符仍拒絕。目前僅提案，未改產品預算/manifest、未追加模型，等待使用者選擇。


2026-11-14 使用者同意Module單次輸出16384，並要求長對話／大任務不要靠反覆加大上限。G6可選maxOutputTokens實作進行中：PM owner契約／主manifest／架構，t4x owner Runtime／Manager，t4y owner Server。兩端沿既有獨立tab與YOLO session續作；維持8/12/180，先離線相容與定向測試再整合一次受控驗證。長任務另核對輸入壓縮、Stage拆解、候選引用與checkpoint能力；未實作的能力不列完成。


G6輸出快照修復離線通過：Server6單元＋4隔離PG（新retry新pin／16384、舊payload逐字不變、派送／冪等／CAS），Worker24定向＋COPY布局14項，Manager output-budget/registry race及TS/Linux build PASS。PM核Server32檔／Runtime289檔SHA與新shared22檔（只Module manifest變更），COPY-only build後已同步切換19287 Server／Manager及Worker指向；DB/Web與原設定保存斷言PASS。新receipt `/private/tmp/whippet-m10-shop-environment/output-budget-switch.json`；`/private/tmp/whippet-m10-output-budget/switch.py --apply` **已用不得重跑**。已授權t4y在前置全部PASS後單次retry4，內容沿retry3，只有G6輸出上限變更；結果待觀察，未宣稱M10通過。


retry4首次前置因Manager心跳逾20秒而停止，intent/outcome不存在、零POST。PM查明新switch漏保留原upgrade的Server network alias `whippet-m10-server`；已單獨補回alias並保持同containerId/IP，`output-budget-network-repair.json`保存修復receipt。switch腳本補保留alias（仍禁止重跑apply）。等待心跳恢復再由t4y重核完整前置，未放寬門檻；先前「設定保存」斷言只涵蓋env/binds/ports/user/workdir，未涵蓋alias，此限制已更正。


retry4最終安全停點：Plan b7c83de2 stopped/r12；search Run ce8b012b-cdbc-49b9-b6b6-95cf6c156e1e timed_out/slotReleased=true，session pending=[]/reclaimPending=false、active/unreclaimed/unresolvedValidation/activePlans全0。新snapshot實讀16384／8／12／180000、module pin9da0afe4…，實際Worker image0d4e593…已觀測，原retry3 payload SHA未變。v3 TIMEOUT、modelRequestFailureStage UNKNOWN、自試0/0、無checkpoint/artifact/正式validation；第三模型請求11heartbeat後failed，僅draft/reference各一次成功，candidate/browser0。沒有新incomplete，不能斷言16384仍截斷或已足夠。僅一次POST，未第五次retry／summary／publish。證據services/server/m10_shop_t4t_retry4.{intent,outcome,snapshot-proof,final,safe-events,review}.json及observations。M10.9仍受阻／M10.Z未過；不繼續升時間或token，下一項為有界候選編輯／降低單次產稿工作量與可信Module續接契約的離線設計，沿design容量策略，尚未實作或新模型驗證。


2026-11-14 使用者續授權推進下一工作並查明retry4真實timeout原因。新Runtime t4z owner runtimes/worker＋services/manager（manifest由PM），新Server/流程t50 owner services/server；皆全新Astra low YOLO、parent=t4s、crew1、keep/outlive-parent/cwd已核，獨立tab分別tb5abfc4cf6c26e6642944fd2d2e85d55f（Whippet M10 逾時根因）、tb5139026e90eed672c4ded1aefbb4506a（Whippet M10 有界產稿）。先真路徑快速timeout回放＋精確歷史安全時間投影，並定有界候選切片；不提高預算、不先新模型、不重跑apply。舊owner t4x/t4y已完成且不並寫。


retry4根因界線已核：真歷史model1開始→model3 failed180019.143ms、model3等待176610.803ms；Run timeout_ms與G6皆180000。author payload2413 bytes／單訊息939 bytes、原script/harness皆空，非保存大稿證據；不是完整provider token數。Manager watchdog至少5分鐘，無自試工具事件；可證author總deadline中止未完成模型請求，歷史缺headers/body觀測，provider內因不可證。t4z真HTTP五control通過，另非ok response body.cancel無限等待red已獨立修補green；不把旁支清理缺口當retry4根因。M109沿既有17enum觀測接線完成定向測試，未部署。

下一垂直切片進行中：PM固定registry10.3與v10追加stage_module_candidate_part＋commit_module_candidate（兩段各8KiB，attempt-local stagingRevision CAS，完整commit自試才候選），新module skill/manifest已固定shared22檔 SHA256SUMS789f704c…；t4z實作Runtime/Manager，t50實作Server等價commit權限及PG guards。舊update/schema與舊證據保留，無migration/跨Run partial，不提高8/12/180/16384。共同檔由PM唯一owner，尚未部署或真模型。


M10.10固定包與QA：Server158檔SHA8bd29b5f…、Runtime228檔SHAd7302fba…均PM逐檔核對，隔離三端bridge真Node自試／Manager parser-upload／TLS Server／PG回收與唯一正式validation PASS（合成provider5model/4tool/0IPC），不重跑同bridge。新QA t51標準Muse xhigh active/--auto/parent=t4s/獨立tab tb8f90f790d634fbc38b46968a2824d795，指定driver三情境success/failed-intent/uncommitted exit0；正負harness斷言保持，未commit無自試／候選。PM觀察QA曾額外執行env名稱filter與package metadata讀取，並立即禁止再讀；未觀察秘密值，不能採其「僅讀兩指定檔」自述。QA結果只證fixture，不證M10或180秒真模型。

PM已COPY-only同步切19287 Server/Manager及Worker指向新bounded映像，env/binds/ports/DB/Web與network aliases保存斷言PASS；receipt `/private/tmp/whippet-m10-shop-environment/bounded-switch.json`，`/private/tmp/whippet-m10-bounded-release/switch.py --apply`已用不得重跑。t50獲明確一次retry5授權，先核完整前置再POST；content只兩處改成new tools/禁止自行擴權，其他意圖逐字不變。尚待現場結果，不追加retry。


M10.10部署前置發現Manager在52ms內exit1，Server正常；t50依Running硬門檻停止，retry5 intent/outcome/proof皆不存在，零POST。Id/image與兩public bind均符合receipt；最初口述bind定位已更正。t4z合成同workdir、同journal bytes由registry10.2切10.3可重現invalid journal author snapshot，空journal新registry可啟動。PM批准最窄已complete/reclaimed/合法result歷史metadata入口略過current pin等值，其他守衛不變；active/new嚴格fail closed。現場根因尚待Manager-only修復驗證，不讀raw journal/log、不刪除、不初始化。產品與定向測試已提交bf709cb；docs/安全證據後續整理提交。


Manager相容修補f651360：合成原red→green，三角色終態回復/去重/bytes不變及20拒絕案例、8頂層race PASS；PM核新Manager-only包89檔SHA256SUMS4f868fb447507f799496985d5670e05c5d28994fc45af8e19854e2ef12275704。COPY-only映像50dd7424…已獨立切換，原workdir/env/binds/aliases/Workerimage與Server/PG/Web ID保存；Manager恢復Running及完整前置心跳PASS，支持已重現journal相容缺口是現場阻擋。receipt bounded-manager-repair.json；repair-manager.py --apply已用不得重跑。

retry5完整前置PASS後僅一次POST：Plan running/r13，search Run256747aa-6298-4e4c-bc11-874ac38f3fd0；新registry10.3／分段工具／manifest與16384/8/12/180快照PASS，原retry4 payload SHA未變，exclusive intent/outcome/proof保存。t50僅唯讀觀察至回收，不追加retry/summary/publish。


retry5安全停點：Plan stopped/r14，Run256747aa-6298-4e4c-bc11-874ac38f3fd0 failed且slotReleased，session pending=[]/reclaimPending=false，active/unreclaimed/unresolvedValidation/activePlans全0。模型8次全部成功，已進入分段stage與兩次commit；v3 LIMIT、TEST_FAILED、自試passed0/failed2、無checkpoint/artifact、正式validation0，後兩Stage仍pending。本次沒有180秒TIMEOUT；不能把工具succeeded當自試PASS，不能推具體selector/斷言原因。原retry4 payload不變；不追加retry、不加預算、不弱化harness。M10.9/Z仍未通過，下一定向工作為自試失敗的最小安全結構化診斷，不刷模型。


retry5最終時間投影：started→finished144508.863ms（約144.5秒），timeoutMs180000且timedOut=false；model3耗75300.804ms、model8耗25071.571ms。8工具為draft1/reference1/stage4/commit2，全部工具succeeded，但兩次自試失敗；只保留最後自試class=TEST_FAILED，不能認定前次同類，更不能猜具體斷言。timing.sql/json與final/review/safe-events已封存。


使用者要求繼續實際查明並修復TEST_FAILED，PM接續派原owner：t50核原attempt目錄/Worker已清理，僅存在journal布林與sidecar，未讀journal/秘密。批准以部署Worker c31055…、同shop fixture源碼隔離複本與新合成憑證，真verifyDraft/loginAs/@lib及原登入/price120/productId斷言做定向重現，保留負向控制；這是runner接縫驗證，不冒稱retry5原稿回放。t4z保留Runtime owner，待red接縫做最小修補，不擴診斷schema、不新模型、不放寬斷言。


TEST_FAILED定向重現進展：t50固定部署Worker c31055…＋同shop fixture隔離複本、全新合成憑證、真verifyDraft/loginAs/@lib已驗最小search參考候選。最終正向734ms PASS；未登入1556ms及錯價121之694ms皆按原斷言FAIL。這反證固定參考流程的runner接線故障，非retry5已刪原稿回放。第一次最終負向替換未命中新文字造成control意外PASS，修正替換命中檢查後三控制符合預期，原產品/斷言未弱化。

PM已審閱同slug、exportName=run、動態productId與price120完整候選。現有直接PUT draft會令原失敗鏈CAS不符，不能無模型原Plan接續；不擴新API或繞批次。t50準備既有Stage retry6 content附完整已驗候選，要求原樣stage/commit及短final，待PM核精確request後才單次POST。t4z只離線備order/verify參考候選，不現場修改或執行。


retry6已在PM審閱完整候選/content hash與守衛後單次授權提交：11項一般/-O測試、isolated PG真SQL候選hash相符/漂移/無候選三控制PASS。完整前置PASS後唯一POST，Plan running/r15、search Run dc65295a-f787-4856-93c5-705827f57573；source payload unchanged、新pin/budget與providedContentPinned PASS。t50只觀察原樣落稿、自試/正式validation及自動後續Stages到安全停點，不另POST/summary/publish。


retry6已取得具體現場故障：search真自試1/0、checkpoint完整、Worker COMPLETED，Manager卻未collect/artifact。t50經PM批准只對單一attempt journal逐層NOFOLLOW/regular/上限/duplicate與型別校驗，僅回固定enum/布林：CREDENTIAL_EVIDENCE_REJECTED、credentialsUsed=true、credentialsSanitized=false、complete/reclaimed；無raw輸出或副本。PM定位sanitizeCredentialOutputs將scrub重新JSON序列化的byte差異誤判為Module含秘密。t4z真路徑red→green修補中：乾淨artifact保持原bytes，真secret/duplicate/非法仍拒，不放寬憑證保護、不改其他報告遮蔽。retry6 Plan stopped/r16；禁止重送，新Manager修補完成後再單次驗同一已驗候選。


Manager credential修補已commit a895872，真serializer red→green、token/秘密/duplicate/非法/超限守衛、普通report與runAttempt parser/upload/race/Linux build PASS。PM核manager-credential-release最終89檔manifest f739a71b…，COPY-only image655d9bd4…部署；Binds順序斷言中止後只讀核逐值相同並收尾receipt，未重跑apply。原三服務/Worker/設定與資料保留。t50完整三receipt鏈與前置PASS後唯一retry7，Plan running/r17、Runff056bf9-37da-4130-89c0-3758a855872b，原content/candidate不變、新snapshot PASS，觀察至回收，不追加POST。


retry7 search現場驗證成功：selftest1/0、checkpoint三true，Manager result/parser/upload accepted；candidateCount1且body/harness/metadata hash完全相符，正式validation d80088bd-bcd5-4d52-8759-30d83c09a8c7 succeeded。Plan r17 search ready，order自動author Run b3e8fd53-a1ca-4c32-896f-55de8b7a0537執行中，verify pending。這是原阻擋的正式修復證據，仍不代表四Stage/整批發佈通過。


retry7自動下游order：Run b3e8fd53-a1ca-4c32-896f-55de8b7a0537自試1/0、Manager ACCEPTED，正式validation dc69a01a-a130-4089-9167-59f7078e014f succeeded並回收，order ready；verify自動author cfbb09d9-12e0-4add-8fb4-1c99d4c7596e執行中，無額外POST。t4z離線order/verify備援11/11符合預期（兩正向、各錯product/quantity/total/status拒絕、新session讀原單404）；僅備援未採入Plan，不當現場成績。


retry7最終驗收：Plan composed/r18、login/search/order/verify全ready。三author、三Module validation、整體Use Case validation70f3d51a-56d8-4e17-a3d3-6d617ab21e06共7 Run全succeeded/slotReleased=true；session無pending/reclaim，active/unreclaimed/unresolvedValidation/activePlans全0。search原稿SHA/metadata完全相符，sourcePayloadUnchanged=true，唯一POST。services/server/m10_shop_t50_retry7.{final,review}.json為安全證據。M10.10完成；M10.9尚待批次摘要/發佈，M10.Z其他缺口與原4PASS/2FAIL/8UNVERIFIED不回填、不改分數。未追加retry/summary/publish、未tag/push。


四個正式validation報告ready已補實讀：report.html/results.json公開metadata size>0且逐一HEAD200（未讀內容），reportsReadyCount4。既有批次summary/publish請求欄位與三receipt SHA已存services/server/m10_shop_t50_retry7.handoff.json；尚未送出。
