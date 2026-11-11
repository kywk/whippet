# Agent 分工與派工計畫

M1 已交付，現依使用者指示推進 M2。里程碑與唯一進度來源為 [實作計畫](implementation.md)。

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
