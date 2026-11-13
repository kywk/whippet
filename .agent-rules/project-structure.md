# 專案結構

[主規範](../AGENTS.md)

## 本輪文件骨架

```text
./
├── .agent-rules/
│   ├── project-structure.md  # 新增檔案或調整目錄時讀取
│   ├── tech-stack.md  # 選擇執行環境或新增依賴時讀取
│   ├── tracking.md  # 接續任務與交接時讀取
│   └── verification.md  # 選擇測試範圍與回報完成時讀取
├── docs/
│   ├── architecture/  # 模組、資料與通訊設計
│   ├── guides/  # 操作與部署指南
│   ├── requirements/  # 需求與 MVP 範圍
│   ├── research/  # 後續選型證據
│   └── tracking/  # 專案追蹤主目錄（日誌、交接）
│       ├── devlog/  # 開發過程與必要驗證紀錄
│       └── handoff/  # 目前狀態與接續事項
└── AGENTS.md  # Whippet 精簡主規範與按需閱讀索引
```

本輪另填入規格、架構、實作計畫與分工文件，並建立 CLAUDE.md 入口。完整文件入口見主規範。

## 隨實作建立的程式目錄

| 路徑 | 用途 |
| --- | --- |
| apps/web/ | React SPA |
| services/server/ | Go API、資料層、排程與連線管理 |
| services/manager/ | Go Worker 生命週期與 Docker 管理 |
| runtimes/worker/ | Node.js Agent 與 Playwright 執行 |
| contracts/ | 版本化 HTTP／WS／Worker 訊息格式與範例；`contracts/tools/` 為工具註冊表單一來源（M10） |
| runtimes/agent-bridge/ | M12 參考外部 Worker（MCP 接單客戶端） |
| scripts/test/golden/ | M10 起的黃金任務集，供各階段完整驗證與引擎比較 |
| deploy/ | Compose、映像與設定範本 |

上述程式目錄是預定位置，本輪不產生空程式框架。docs/research、guides、devlog、handoff 有實際內容時才加檔案。
