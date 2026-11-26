# 全站管理後台規格

Super Admin 在同一個入口管理全站 Workspace、成員與 AI 執行資源；Site Manager 負責前兩項。本文定義目標行為。[v13](../../../contracts/mvp-v13.md) 是現行相容基準，開發與驗收身分沿用既有 session。正式環境的個人登入與身分佈建另行規劃。

## 角色與操作

| 操作 | Super Admin | Site Manager | Workspace Admin | Workspace User |
| --- | --- | --- | --- | --- |
| 進入全站管理、建立／查看／更新／封存／還原 Workspace | 全站 | 全站 | — | — |
| 指派、移除 Workspace Admin 或 User | 全站 | 全站 | 僅管理所屬 Workspace 的一般成員 | — |
| 指派、撤銷全站角色 | 可，須保留最後一位 Super Admin | — | — | — |
| 查看全站 AI 資源、調配、建立 Agent、管理 Agent 金鑰 | 全站 | — | — | — |

Site Manager 與 Workspace User 分別沿用資料值 `site_admin`、`qa`。既有 Workspace 內的工作權限沿用 v13。Server 在每次操作查核目前角色與資源歸屬，包括舊全站角色 API。Web 依 Server 回傳的能力顯示入口。Site Manager 可搜尋帳號並修改成員關係；撤銷成員後，後續存取立即依最新權限判定。

## Workspace 與成員

Workspace 清單可查看使用中與已封存項目。建立後可立即指派既有帳號，成員頁顯示 Workspace、帳號及目前角色。管理用名稱可直接更新；涉及執行快照的網站範圍、角色設定仍走既有提案與確認流程。

刪除操作採可還原的「封存」。Server 先停止接受新任務、派工、MCP 領單與新瀏覽器租約，顯示待處理及執行中數量。排隊工作取消；執行中工作與既有租約可選擇等候結束或明確取消。清空後轉為已封存，保留成員、版本、報告與歷史稽核。還原後恢復正常授權，不重送已取消的任務。封存與領單競爭時，以 Server 成功提交的狀態轉換為準。

## AI 資源與調配

清單呈現資源識別、來源、可服務 Workspace、能力、最近活動、有效租約及可用容量。區分 Agent 設定、連上的執行端與一次性 Worker／Run；Manager 重連沿用資源識別。僅核發 Token 顯示「等待連線」，缺乏容量或心跳證據顯示未知。未知容量不計入可派工數。

| 來源 | 連線證據 | 可用操作 |
| --- | --- | --- |
| 受管 Manager／Worker | WSS 註冊、心跳、容量及 Run 關聯 | 指派 Workspace、暫停／恢復新派工、排空後移出 |
| 外部 MCP 接單 Agent | 綁定 Workspace 的 Agent 身分、能力登錄及租約心跳 | 暫停／恢復領單、取消任務、撤銷 Token；調往其他 Workspace 時核發新授權並停用舊授權 |
| MCP 互動客戶端 | 已授權的最近活動及瀏覽器租約 | 檢視活動、結束租約、撤銷存取；互動本身不增加接單容量 |

Server 依來源回傳可執行操作，並在執行時重新驗權。共用 Token 無法辨識個別程序時，按憑證彙整並標示。調配只影響新任務，保留執行中 attempt 的 Workspace 與租約；需要中止時走取消流程。撤銷憑證立即拒絕後續使用。

## AI Manager 建立 Agent

1. Super Admin 選定 Workspace、名稱、引擎（內建、Vercel 或 Pi）及執行方式（平台代管或自管 MCP）。依執行端宣告列出可用組合。AI Manager 顯示配置供確認，透過同一個 Server 管理介面執行，權限依呼叫者決定。
2. 每個 Agent 獨立設定模型供應商、模型及 API Key。代管模式使用專用機密欄位和加密儲存，執行時只提供給指定 Agent。自管 MCP 由操作者在客戶端設定該 Agent 的 Key，平台提供綁定單一 Workspace 的接入 Token。Token 明文只顯示一次。兩種憑證各自輪替、撤銷，模型對話、設定查詢、日誌與稽核均不含明文。
3. 代管模式由既有 Manager 配置執行資源，自管模式提供連線指引並等待回連。連線、引擎能力與最小模型工作驗證成功後才開放接單。無可用 Manager、錯誤 Key 或心跳逾時須顯示原因與可重試操作。重送同一建立請求沿用既有 Agent；部分失敗時回收該次配置的資源。
4. 變更角色、封存、調配、取消及金鑰異動記錄操作者、時間、目標及結果。所有入口沿用 [Agent Harness](../usecase-agent-platform.md#agent-harness) 的工具、預算、範圍、驗證與人工發佈規則。

## 驗收情境

- A1：四種既有身分分別操作 UI 與直接 API。Site Manager 可管理兩個 Workspace 的成員，直接調整全站角色或呼叫 AI 管理 API 得到 403；最後一位 Super Admin 受保護。
- A2：在有排隊工作、執行中工作與租約時封存，分別驗證等候及取消。封存期間新領單遭拒，還原後可接新單，原報告可讀。
- A3：受管、MCP 互動、MCP 接單同時出現，重連後資源數正確。暫停或改派與領單同時發生時，工作只執行一次且 Workspace 正確。
- A4：從 AI Manager 建立兩個使用不同 Key 的 Agent。以錯誤 Key 驗證失敗，輪替後重試成功；另一 Agent 仍可執行，重送不重複建立。核對對話、API 回應及日誌的遮罩。
- A5：內建、Vercel、Pi、MCP 互動與接單均從正常入口驗證允許及拒絕。互動驗證瀏覽器租約，接單驗證 claim 至 submit；分別驗證跨 Workspace 或撤權拒絕。記錄實際 provider 或合成回應，以及未驗證範圍。

[實作計畫](../../tracking/implementation.md#全站管理後台) · [分工任務](../../tracking/delegation.md#全站管理後台)
