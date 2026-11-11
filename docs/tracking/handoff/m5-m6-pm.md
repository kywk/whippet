# M5／M6 PM 接手（2026-11-11）

## 最新指示與角色

使用者因原對話太長，要求開新 PM agent session 主導 M5／M6 派工與驗收。PM 指定 GPT-6-Astra light；本機模型 metadata 無 light，輕量值為 low（lighter reasoning），啟動用 gpt-6-astra / low，已向使用者說明。使用繁體中文、台灣用語。你是新的總指揮，直接接手推進，不只是提出計畫後停下來。

沿用 Herdr 可見 pane 派工：一般開發 Codex gpt-6.1-sol / xhigh，特別困難才 gpt-6-astra / medium；單純測試 OpenCode Muse Spark 1.3 Contributor / xhigh。先讀 /Users/kywk/.config/herdr-app/AGENTS.md 與 external-agent-tools skill。可沿用既有成功 session，禁止默默換模型。總指揮保持輕量，依 owner 分工、整合與驗收；不要自己重做全部模組。

專案根目錄 /Users/kywk/kywk/project/whippet（實際 /Users/kywk/workspace/whippet）。沿用既有共享 repo 的每檔單一 owner 模式；不用另建 worktree 打亂已啟動服務。先讀 AGENTS.md、.agent-rules/tracking.md、verification.md，其他按需讀。不要把全部歷史塞進 context。

## 現況與入口

- M1～M4 主要流程已完成，實作與證據在 docs/tracking/implementation.md、docs/guides/。
- 最新程式 commit 80a8dfa feat: add M4 WebRTC live browser monitoring，已成功推送 origin/main https://github.com/kywk/whippet.git。先前 M3 commit 600f28e。
- implementation.md 首段仍誤寫 M4 未完成，M4 段仍誤寫 push 等 remote；接手整理時修正，勿據此重新開發 M4。
- deploy/.env.ai 有使用者金鑰，已由 .gitignore .env.* 忽略，未追蹤、歷史無此檔。不得輸出、提交、複製到文件或 force add；只讀範例檔。交接文件也沒有 key。
- Git HTTPS helper 設定誤指 Linux gh 路徑。本機 /opt/homebrew/bin/gh 已登入。需要經授權 push 時可單次覆寫：git -c credential.helper= -c 'credential.helper=!/opt/homebrew/bin/gh auth git-credential' push。不要擅改全域設定。
- 本輪既有規則不安裝新套件；盡量用現有依賴／快取。未授權下一批 commit/push，不自動發布；之前的 commit/push 指示已完成。

## 下一階段範圍

使用者已要求你主導 M5/M6，但尚無定稿 M6 規格。先依下列待辦整理兩階段、更新 implementation 的 owner 與驗收條件，屬可逆排程不必重新問整套架構。

優先順序：
1. 改善 WebRTC 實際網頁細字清晰度。現在操作、新分頁切換都可見，但畫質偏糊；先診斷實際編碼／尺寸／bitrate，不盲目加大所有參數。保留 JPEG 備援、停止監看不停止 Run。
2. 補 Workspace 設定：原 MVP 規格包含網站名稱／URL 清單、預設測試 URL、非機密執行設定；目前模型只有基本 Workspace，沒有完整設定 API/UI。需落實設定如何進入任務快照與 Agent；不把 API key 放前端。
3. M5 部署／MVP 收尾：現有 Compose 已可用，整理乾淨建置、啟動、持久化與設定說明；Linux Server＋Mac Docker Worker 跨主機驗收尚未做，現況只是 Mac OrbStack 的 Linux 容器。TURN 設定接線有但未做實際跨 NAT TURN 驗證。無遠端主機或 TURN 資料先完成獨立部分，再提出具體所需資訊。
4. M6 建議定義為 MVP 缺口與開源交付收尾，與 M5 避免重複：報告 trace/影片/Markdown 支援範圍、README、LICENSE（尚未選定，不擅自決定授權）、依賴聲明、必要操作指南。trace 是原規格已有的缺口，影片非必須本輪全面實作；排好優先，不做過度驗證。

不自行擴張：真實登入/SSO/RBAC、多 Workspace 管理、多 Manager、Polling/HTTP Push、排程/CI、人工遠端接管、K8s、負載與完整 NAT 測試矩陣。這些留後續，除非使用者另指示。

## Herdr 現有 owner / pane

- t30 Codex sol xhigh：apps/web/，idle/done。
- t31 Codex sol xhigh：services/server/，idle/done。
- t32 Codex sol xhigh：services/manager/、runtimes/worker/，idle/done。
- t33 OpenCode Muse Spark 1.3 Contributor xhigh：單純黑箱測試，最近建立真實操作腳本。hc status 可能不回報但 read 有 TUI 模型與 xhigh 證據。
- 先 hc get/read 檢查，勿干擾其他終端（t1r 等）。可沿用或開新 pane，自己管理工作；不得強制通過子代理權限對話，需依正常 approval 工具執行。
- Herdr whippet space id spc410627697c591af2a35cc533b8f1ad8，其 folder metadata 錯指別專案，啟動務必明確指定 cwd！不重啟 core/app、不更動使用者其他 workspace。

## 現有服務／驗收

- Web http://localhost:18080，API http://localhost:18081。
- Worker 內測站用 http://host.docker.internal:18080。
- Docker compose project whippet-m1；server/web/runner-manager/postgres 已執行，image tags whippet-{server,web,manager,worker}:m1。
- deploy/compose.server.yml、compose.runner.yml、compose.runner.local.yml、compose.runner.ai.yml；不印 compose config 原文（含 secrets），可 config --quiet。
- 本機現有快取可以建置；前次使用 /private/tmp/whippet-{server,manager,web,worker}-m4-image 疊加 image，僅作開發捷徑，M5 應驗證正常 Dockerfile 可重建，不能把這當開源安裝流程。
- 真實網站 demo scripts/test/fixtures/m4-real-browser.spec.ts；合成計數 m4-live.spec.ts 只作診斷。使用者明確要求觀看真正瀏覽器操作，不能再拿計數頁當最終demo。
- 真實示範測試名 M4 Demo｜實際瀏覽器操作，testId 62bb2578-077b-4e28-905f-4948615c929c，草稿 r2，未發布。登入→搜尋→詳情→報告 popup→返回登入，約39秒，停留僅方便觀看，斷言仍用 expect。
- 成功 Run 248aa019-454d-464b-a2e7-3c519a65feb8；report /api/runs/<runId>/artifacts/report.html。3張PNG已在真實Chromium載入，無圖片HTTP/CSP錯誤。Chrome可見WebRTC顯示測試列表、搜尋結果與報告popup切換。
- Mac Chromium 自動 WebRTC/JPEG/停止監看 smoke Run 3a23fa36-0eb4-46ac-a311-ba5541882fcb：live video track，實際frames 2→3；JPEG更新，stop時Run仍running，最後succeeded。
- Server/Manager Go相關測試、Manager race、Worker build、真實RTP loopback已通過。只針對本次變更重跑相關檢查，不再重跑全部M1～M4。
- 原生 Mac Chromium 可用 path /Users/kywk/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing；SDK需 explicit executablePath。現有 scripts/test/m4-ui-smoke.cjs 有環境變數介面。
- 純UI驗收可用既有Playwright；使用者可見Chrome示範需用CUA工具。browser connector host曾不可用，但native com.google.Chrome可用。別用osascript繞過CUA。

## M4 重要實作邊界

contracts/mvp-v4.md 為契約。獨立控制與media WS；真WebRTC video track（非DataChannel冒充視訊），JPEG binary WS備援。每Run一viewer，viewer lease、心跳、bounded latest frame；Manager↔Worker /work/live 檔案橋接；停止觀看或隱藏頁籤釋放影像但Run繼續。

Worker觀察標準 fixture browser/context/page/popup 與 author browser；自行啟動其他browser process不保證。helper為獨立無key Chromium，page screencast→canvas.captureStream(3)→RTCPeerConnection。目前1280×720、JPEG quality55；新頁自動跟隨最新未關閉page。

helper加 --disable-features=WebRtcHideLocalIpsWithMdns，僅短生命週期sender使用；修正Docker .local mDNS candidate無法讓Mac觀看，現在數字IP可直連。不改使用者Chrome設定。TURN設定WHIPPET_LIVE_ICE_SERVERS只用媒體專用憑證。

## 接手第一步

回報你實際使用模型/effort與接手狀態，讀必要文件，整理M5/M6切分，立即以Herdr派發互不衝突的小任務（畫質與Workspace可分owner），更新implementation。不要把這份交接當已完成工作；用實際變更與最小驗收交付。需要使用者決策的只有明確阻塞（遠端環境、授權選擇等），其餘自主推進。
