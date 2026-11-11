# Agent 分工與派工計畫

M1–M6 本機功能證據沿用；目前由 UI／UX PM 推進 M7–M9 規格與後續實作。里程碑與唯一進度來源為 [實作計畫](implementation.md)。

## 固定分工

同時最多三個實作 Agent，加上一個輕量總指揮；小任務可由一個 Agent 完成，不為湊分工而拆工作。

| 角色 | 寫入範圍 | 責任 |
| --- | --- | --- |
| 總指揮／整合 | `contracts/`、`deploy/`、根目錄建置設定、`docs/`、`.agent-rules/` | 任務排序、最小契約、跨模組決策、部署串接、進度與必要驗收 |
| Web Agent | `apps/web/` | React SPA、測試與草稿頁面、對話介面、報告與唯讀監看 |
| Server Agent | `services/server/`，含其 migrations | Go API、PostgreSQL、版本與發佈規則、任務表、Manager gateway、附件管理 |
| Runtime Agent | `services/manager/`、`runtimes/worker/` | Go Manager、Docker 生命週期、Node／TS Agent 與 Playwright、影像輸出 |

- 各模組已建立，沿用既有實作，以最小垂直切片補齊缺口。
- Agent 在自己的範圍內直接完成實作與必要檢查；需要跨範圍修改時回報具體介面需求，由 owner 處理。
- Dockerfile 放在各自服務目錄，由該 owner 維護；Compose 與部署指南由總指揮整合。
- 契約由總指揮單一寫入。新增必要欄位時同步通知受影響 owner，不先建立未使用的完整框架。
- 同一檔案同一時間只交給一位 owner；交接須說明接手範圍與已知變動。

## 開發波次

| 波次 | 依賴 | Web Agent | Server Agent | Runtime Agent | 整合交付／最小驗證 |
| --- | --- | --- | --- | --- | --- |
| 1：固定腳本執行 | 最小 Run／任務契約 | 登入、列表、詳情、執行與結果 | Workspace、Test、Run API、任務保存 | WSS 連線、啟動 Worker、執行與回報 | 一個成功與一個斷言失敗的端到端結果 |
| 2：草稿與排隊 | 波次 1 可串接 | 草稿、驗證、發佈、歷史 | revision、發佈交易、版本快照、狀態對帳 | 併發、取消、超時、回收、重連 | 舊驗證拒絕發佈；Worker 終止後下一任務啟動 |
| 3：AI 對話 | 草稿契約完成 | 對話、修改預覽、接續編輯 | 訊息與 session 持久化、Agent 任務 | 模型 adapter、工具迴圈、產生／修復 | 一個真實模型走完對話至發佈 |
| 4：即時監看 | Worker 生命週期可用 | 監看播放器與備援狀態 | 協商／影像轉送端點 | 畫面擷取、WebRTC 與備援 | 一條觀看路徑與一次備援切換 |
| 5：部署收尾 | 主流程完成 | 修 UI 阻塞 | 修 API／持久化阻塞 | 修 Linux／Mac Docker 阻塞 | Linux Server＋Mac 執行端完整流程一次 |

波次是交付順序，不是全面等待柵欄。Web 可先依契約使用 mock；Server 可使用假 Manager；Runtime 可用固定任務。影像工作在所需介面可用時開始，不阻塞草稿與 AI 功能。

## 每次派工格式

總指揮只附本次需要的文件段落與契約，不轉交整份歷史對話。

```text
目標：完成 <里程碑中的可操作功能>。
Owner：<角色>；可修改：<具體路徑>。
讀取：AGENTS.md、相關細則、<規格／契約的必要章節>。
依賴：<已具備的 API／事件／fixture；尚未具備則採指定 mock>。
交付：<程式行為與可供下一位串接的輸入輸出>。
最小驗證：<一個相關測試或一條可重現操作>。
邊界：沿用 MVP 決策，僅處理本功能直接需要的錯誤情境。
回報：修改檔案、串接方式、實際驗證、阻塞或需 owner 接手的事項。
```

## 可直接派出的首批任務

### Web Agent

- 讀取 MVP 的登入、列表、詳情與執行需求，以及已發布的 Run API 契約。
- 在 `apps/web/` 建立 React SPA 的上述頁面，使用 mock 開始，API 就緒後串接。
- 完成條件：能按執行、呈現狀態、開啟報告。最小驗證：建置及一條操作流程。

### Server Agent

- 讀取架構的資料模型與最小任務協定，實作預設 Workspace、固定身分、Test／Run API、PostgreSQL 與 Manager gateway。
- 僅修改 `services/server/`；提供 migrations 及本地啟動所需環境變數給總指揮。
- 完成條件：可建立任務、保存 Worker 結果並查詢。最小驗證：一條 API → 任務 → 結果整合測試。

### Runtime Agent

- 讀取 Manager／Worker 邊界與最小任務契約，實作 Manager 主動連線、啟動 Worker 容器、固定腳本執行與回報。
- 僅修改 `services/manager/`、`runtimes/worker/`；先在可用 Docker 環境執行。
- 完成條件：真實 Playwright 產生結果與報告，程序結束後容器可清理。最小驗證：固定測試執行一次。

## 輕量整合規則

- 總指揮只審查跨模組契約、關鍵行為與實際證據，不重新做完每位 Agent 的工作。
- 只有資料遺失、重複執行、錯誤發佈與資源無法回收等核心問題阻擋該功能交付；介面美化與非核心調整排到後續。
- 測試通過且沒有新改動，就沿用結果。不要額外加入全量重跑、多人重複審查或反覆規格核准。
- 完成時由總指揮更新 implementation 的任務狀態；只有真的需要跨工作階段接續，才寫 handoff。

## 本次執行路由（使用者已指定）

透過 herdr 可見 pane 執行互動式 Agent。一般開發使用 Codex gpt-6.1-sol／xhigh；特別困難任務才使用 gpt-6-astra／medium。單純測試使用 OpenCode muse spark 1.3／xhigh（啟動前核對精確模型 ID）。不得默默替換模型。首批共用 contracts/mvp-v1.md；同一工作目錄依檔案 owner 協作，不執行 Git 操作。

## M2 本輪分工

共同契約為 `contracts/mvp-v2.md`。t30 負責 Web 草稿／發佈／取消；t31 負責 Server 草稿、版本、發佈交易與排程介面；t32 負責 Manager 併發、取消、回收及去重。開發維持 Codex sol／xhigh。t33 使用 OpenCode Muse Spark 1.3 Contributor／xhigh，僅依合成資料與黑箱介面撰寫驗收腳本，不讀取專案原始碼或憑證。總指揮負責部署、整合驗收與最後提交。M3 暫不開始。

## M3 本輪分工

共同契約 `contracts/mvp-v3.md`。沿用 Herdr t30 Web 對話與稿件預覽、t31 Server 持久對話與author結果交易、t32 Runtime工具迴圈與author容器隔離，皆 Codex sol／xhigh。t33 Muse 僅負責合成黑箱驗收，總指揮負責部署與真實模型串接。M2驗收結果沿用，不重跑無關測試。

## M4 本輪分工

共同契約 `contracts/mvp-v4.md`。t30 負責 React 監看與 Nginx WS proxy；t31 負責獨立 LiveHub／viewer 與 Manager media WS；t32 負責 fixture／author 畫面擷取、Chromium WebRTC helper、Manager live bridge。沿用既有依賴，不安裝新套件、不由子 Agent 操作 Git。總指揮管理契約、Compose、整合驗收；t33 Muse 僅撰寫合成黑箱驗收腳本。

## M5／M6 本輪分工（2026-11-11）

最新授權覆蓋歷史提交安排：不安裝套件、不自行 commit／push、不輸出憑證。PM t35 已核對 GPT-6-Astra／low，維持輕量協調；t30／t31／t32 沿用 sol／xhigh 可見 pane。t33 沿用 Muse Spark 1.3 Contributor／xhigh，只做黑箱測試，整合就緒後才執行。

首批 t32 診斷與改善 WebRTC 畫質；t31 提出並落實 Workspace 持久化與快照；t30 檢查播放器縮放並準備設定 UI，API 串接等待 PM 固定介面。共享契約、部署、docs 與進度檔由 PM 單一寫入。子 Agent 不重啟或部署共享服務。第二批才派 runtime 設定接線與 M6 trace／附件；避免同 owner 同時承接互相干擾工作。範圍、狀態與驗收只在 implementation.md 維護。


## M7–M9 當前分工（2026-11-12）

本節為最新路由；任務狀態僅在 implementation.md 維護。規格文件已提交 1e6fd7e；最新授權已啟動 M7 首波：t30 實作獨立 UI 切片，t31／t32 先回覆最小介面提案。其餘依進度表，不代表全部已啟動。

| Owner／路由 | 寫入範圍 | 可直接派出的任務 |
| --- | --- | --- |
| PM／gpt-6-astra low | docs、contracts、deploy、根建置設定 | 固定每波最小契約與遷移；整合隔離預覽、進度及必要驗收 |
| t30 Web／gpt-6.1-sol xhigh | apps/web | M7 一般／對話模式、草稿入口與確認放棄、對話結果／監看／發佈卡片；M8 多 Workspace 對話與機密欄位 |
| t31 Server／gpt-6.1-sol xhigh | services/server（含 migrations） | M7 編輯週期與對話歸屬、摘要／發佈一致性、放棄競態；M8 Workspace proposal、scope、機密保存與任務授權 |
| t32 Runtime／gpt-6.1-sol xhigh | services/manager、runtimes/worker | M7 測試編輯與摘要 skills／背景輸入；M8 設定 skill、登入工具、出站限制與機密生命週期 |
| t33 黑箱／Muse Spark 1.3 Contributor xhigh | 本輪指定 scripts/test/m7-*、m8-*、m9-* | 依契約與可見標籤寫最小合成黑箱；不讀產品原始碼、真實憑證、不改 DELIVERY 或其他 owner 檔案 |

特別困難且確有需要的任務才升至 astra／medium，先核對有效模型／effort，不默默替換。沿用共享 repo，單檔單 owner；不另建重複 Agent。所有 Agent 不安裝套件、不自行 commit／push、不重啟共享服務、不讀印 deploy/.env.ai。

### 首波任務內容

共同讀取 AGENTS.md、requirements/ai-workspace.md、implementation.md 的 M7 與已固定的新契約；不要轉交整份舊對話。

1. PM 向 t31／t32 收集一次最小介面差異後固定 M7 契約；未固定前只盤點，不各自發明 endpoint。
2. t30 落實指定詳情順序與對話模式，保持掛載／狀態以避免切換遺失草稿；等待 API 時可使用明確標示的合成資料。不可用假狀態宣稱真驗證通過。
3. t31 落實編輯週期與版本摘要交易，兼容舊資料；刪除／取消後的遲到結果不能恢復草稿或繼續驗證。
4. t32 將既有 Playwright recipe 拆成按任務載入的 skills，摘要模式無寫腳本工具；不建外掛平台。實作 skill 檔時載入適用 skill-creator／writing-for-agents 規範。
5. 各 owner 回報檔案、介面、實際最小驗證及剩餘限制；PM 整合後才派 t33 跑主流程。無新變更則不重跑已通過檢查。

M8 依相同方式先固定 proposal／機密／網路政策再並行；Runtime 不能只提供 prompt 禁止越界就宣稱交付。出站限制涉及 deploy 的部分由 t32 提出需求、PM 修改。無法在現有依賴完成的項目回報具體阻塞，不私自安裝。
