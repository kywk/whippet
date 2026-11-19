# Whippet 專案規範

Self-hosted Playwright 平台。使用繁體中文與台灣用語；優先交付可操作的 MVP。

## 工作方式

- 先讀與任務相關的檔案，沿用已確認決策。一般實作選擇由負責 Agent 決定。
- 以可執行的垂直切片推進；必要檢查通過後進入下一項，不為 MVP 建立完整企業治理。
- 總指揮負責排程、介面協調與整合；獨立模組可交給專業 Agent。每個檔案同時只有一位 owner。
- 規則以本檔為主，細則按需讀取；使用者指示優先。CLAUDE.md 只作入口。

## Agent Harness

- 調整任何 Harness 規則或新增 Agent／adapter 前，先讀 [共用 Harness 規格](docs/requirements/usecase-agent-platform.md#agent-harness)。同次變更一併處理內建 Agent、MCP 互動／接單與第三方框架 adapter。
- 對話意圖與資料信任、Workspace 範圍、工具、機密、預算、取消與去重、腳本來源、驗證與發佈均由 Whippet 強制執行。模型迴圈依任務快照及工具介面執行。
- 每次改動都要從內建 Agent、MCP 與各個已支援的第三方 adapter 的正常入口驗證放行與拒絕。MCP 依變更涵蓋互動及接單，交付時回報各入口的實際結果與驗證缺口。

## 細則索引

| 細則 | 讀取時機與用途 |
| --- | --- |
| [tech-stack.md](.agent-rules/tech-stack.md) | 選擇執行環境或新增依賴時讀取 |
| [project-structure.md](.agent-rules/project-structure.md) | 新增檔案或調整目錄時讀取 |
| [tracking.md](.agent-rules/tracking.md) | 接續任務與交接時讀取 |
| [verification.md](.agent-rules/verification.md) | 選擇測試範圍與回報完成時讀取 |
| [commit-message.md](.agent-rules/commit-message.md) | 每次 Git 提交前，依此規範撰寫並核對標題、內文與尾註 |

## 需求與任務入口

- 修改功能或判斷範圍：讀 [MVP 規格](docs/requirements/mvp.md)。
- Use Case、模組庫、MCP 或 Agent adapter：讀 [Use Case 與 Agent 平台化規格](docs/requirements/usecase-agent-platform.md)。
- 修改資料、API、Worker 或通訊：讀 [架構與協定](docs/architecture/design.md)。
- 開始開發或選擇下一項：讀 [實作計畫](docs/tracking/implementation.md)。
- 派工、並行或變更共同介面：讀 [分工計畫](docs/tracking/delegation.md)。

## 完成與交接

交付時回報變更、實際檢查與剩餘限制；更新受影響任務即可。僅文件建立不代表實作完成。目前已進入實作與整合：可安裝專案依賴與建置所需映像。使用者已授權階段性 Git commit；推送與歷史改寫另依明確指示。
