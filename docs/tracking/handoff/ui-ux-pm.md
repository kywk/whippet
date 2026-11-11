# UI／UX 新對話交接（2026-11-12）

2026-11-12 最新：使用者已同意 AI 優先 UI、編輯週期、多 Workspace、帳密表單與 Worker skill-set 方案，要求先更新規格／計畫／分工。已整理 requirements/ai-workspace.md、mvp.md、architecture/design.md、implementation.md 與 delegation.md；M7–M9 實作尚未派工。下一步按 implementation.md 固定 M7 最小契約，不再重問已確認方向。

以下保留開場時背景：使用者要求另開 agent session，下一階段進行 Whippet UI／UX 調整。使用繁體中文、台灣用語。先盤點現有 UI 與實際可見狀態，再釐清最優先的調整範圍，不自行做全站重設計。

## 授權與路由

- PM 使用 gpt-6-astra／low（使用者原指定 light，本機對應 low）；一般開發 gpt-6.1-sol／xhigh，特別困難才 astra／medium；純黑箱測試 Muse Spark 1.3 Contributor／xhigh。
- Herdr 可見 pane；先讀 `/Users/kywk/.config/herdr-app/AGENTS.md`、external-agent-tools skill。既有 t30 Web、t31 Server、t32 Runtime、t33 QA 可沿用，先 get/read 確認狀態與模型，勿干擾其他專案。
- 共享 repo、每檔單一 owner；PM 管 docs/contracts/deploy，t30 管 apps/web。UI任務按需載入 impeccable 與 React 技能。
- 不安裝新套件、不輸出憑證。上輪使用者僅授權 commit，已完成；本輪不要自行 commit/push。
- cwd 明確指定 `/Users/kywk/kywk/project/whippet`。Herdr whippet space `spc410627697c591af2a35cc533b8f1ad8` 的 folder metadata 曾錯指別專案，不能依賴它。

## 已完成與現況

- 最近提交 `5170d2c feat: add workspace settings and failure evidence downloads`；65檔，提交後工作目錄乾淨，未push。開工重新核對Git狀態。
- M1–M4 本機已驗收。M5新增Workspace網站清單／預設URL／timeout設定與固定任務快照，WebRTC以contentHint=text保留1280×720；M6新增失敗trace ZIP／Markdown下載。
- M5／M6單元、build、隔離PostgreSQL、真Worker、完整Server→Manager→Worker及Mac Chromium下載都PASS。Trace Viewer真動作、HTML失敗報告、CSP亦PASS，不需無改動重跑全套。
- 原服務仍是舊部署：Web http://localhost:18080、API http://localhost:18081；新版M5/M6曾用18085隔離驗收，隔離容器／網路／Viewer均已關閉。不可把舊18080畫面誤認為最新原始碼。
- 最新Web dist已建置，依賴在本機。正常Dockerfile離線build因依賴層無快取受阻；不下載套件。可以使用既有映像與編譯產物建立隔離預覽，不宣稱乾淨建置通過。
- 無真模型呼叫需求。`deploy/.env.ai` 含使用者金鑰且Git忽略，禁止輸出／提交／複製。只讀範例設定。

## 必要入口

- AGENTS.md、.agent-rules/tracking.md、verification.md。
- docs/tracking/implementation.md 為唯一進度來源；delegation.md列owner。
- apps/web/DELIVERY.md頂端為M5/M6 UI與accessibility標籤、驗收紀錄；src/App.tsx、DraftEditor.tsx、WorkspaceSettings.tsx、RunArtifacts.tsx、styles.css 按需讀取。
- contracts/mvp-v5.md／mvp-v6.md：UI不能削弱revision衝突、未存稿保護、發佈門檻或報告sandbox。
- 截圖 `/private/tmp/whippet-m5-settings-evidence/`、`/private/tmp/whippet-m6-download-evidence/` 可先檢視（不代表目前服務版本）。
- 現有黑箱腳本 scripts/test/m5-settings-ui.cjs、m6-artifacts-ui.cjs，僅針對變更選最小檢查。
- 本機Chromium路徑：`/Users/kywk/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`。

## 保留但不自動擴張

- 乾淨建置、跨主機Linux/Mac、TURN、映像第三方授權尚有缺口；LICENSE尚未選定，先前問題未收到回答。不是本次UI任務的預設範圍。
- 上一個討論是「點擊測試後能否在使用者瀏覽器執行」。僅做可行性分析，建議本機Agent＋專用瀏覽器；未獲授權實作。不要把它當已確認需求或立即增加裝置配對／多Manager／擴充功能。
- 新對話第一步：回報有效model/effort，讀必要規範，檢視現有UI與上述截圖，用簡短問題確認使用者優先調整的畫面／操作痛點；同時可做唯讀盤點。不只回覆可以，也不在方向不明時大量改碼。
