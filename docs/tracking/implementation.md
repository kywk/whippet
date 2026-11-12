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
