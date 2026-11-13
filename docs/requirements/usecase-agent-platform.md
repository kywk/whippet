# Use Case 與 Agent 平台化規格

2026-11-13 使用者已同意方向；本文件定義目標行為，不表示已實作。進度只在 [實作計畫](../tracking/implementation.md) 維護；技術設計見 [架構設計](../architecture/design.md) 的「M10–M12」章節。既有 [AI 對話工作區規格](ai-workspace.md) 的範圍、機密、人工發佈與 Workspace 隔離規則全部沿用。

## 目標

- QA 以對話描述一個測試任務；AI 拆成多個階段，優先複用 Workspace 既有模組，必要時新建或修改，最後組成一個 Use Case，經真實驗證後由人工發佈。
- Harness（工具、範圍、機密、預算、來源、發佈門檻）由 Whippet 掌握；LLM 迴圈可替換；外部 Agent 可透過 MCP 接入擔任撰寫者。

## 三階段與分支

| 階段 | 分支 | 交付 | 收尾條件 |
| --- | --- | --- | --- |
| 一：引擎與 Use Case | `main` | 自研引擎補強（G1–G6）、模組庫、Catalog、Plan → Stage → Compose | 階段一完整驗證通過，標記 `phase1-verified` |
| 二：MCP | `feat/mcp`（自 `phase1-verified` 分出） | MCP 端點、Agent Token、瀏覽器租用 session、互動模式與接單模式 | 階段二完整驗證通過後 merge 回 `main`，標記 `phase2-verified` |
| 三：Agent Adapter | `feat/agent-adapter`（自 `phase2-verified` 分出） | 開源 LLM 迴圈 adapter、多供應商設定、參考外部 Worker | 階段三完整驗證通過後 merge 回 `main`，標記 `phase3-verified` |

- 分支是短期階段分支，不長期並行。分支期間 `main` 只收 hotfix，hotfix 同步 merge 進活躍分支。
- 階段三的引擎選型 spike 可在階段二期間於拋棄式分支先做，只產出結論，不合併程式。
- 推送與歷史改寫依使用者另行指示。

## 名詞

| 名詞 | 定義 |
| --- | --- |
| Module | 可複用腳本，屬於一種 Test（`kind=module`）。類型：`setup`（資料準備）、`step`（流程動作）、`page`（Page Object）。有 slug、函式簽章、輸入、回傳、前置與後置狀態說明 |
| Module Harness | 每個 Module 附帶的最小 spec，用來單獨驗證該 Module；驗證成功才可發佈 |
| Use Case | 屬於一種 Test（`kind=usecase`），由有序 Stage 組成，產生一份 Playwright spec |
| Stage | Use Case 的一個階段：引用一個已固定版本的 Module 並帶入參數，或是一段內嵌步驟程式；可綁定回傳值，供後續階段引用 |
| Plan | 編輯週期內的階段計畫，每個 Stage 標記「複用／修改／新建」，經使用者確認後才開始產稿 |
| Catalog | Workspace 內已發佈 Module 的目錄：名稱、說明、簽章、標籤、最近驗證結果、被引用的 Use Case |
| Engine | 執行 LLM 迴圈的元件；內建引擎與開源 adapter 實作同一介面 |

## 階段一：行為規格

### 模組庫

- Module 沿用 Test 的編輯週期、草稿 revision、真實驗證、摘要與人工發佈流程；驗證對象是 Module Harness。
- 工程師可手動編輯 Module，保留完整 Playwright 能力；手動來源一樣由 Server 依寫入路徑記錄。
- Use Case 以 `@lib/<slug>` 引入 Module，並固定版本。Module 發佈新版本不改變既有 Use Case；Module 詳情列出被引用的 Use Case 與版本。Use Case 要升級引用版本，必須透過新草稿重新驗證。
- MVP 限制：Module 不能依賴其他 Module；Stage 只支援線性流程加參數，不支援條件與迴圈；不可跨 Workspace 引用。

### Use Case 組合

- Stage 結構是 Use Case 的事實來源；spec 由 Server 以確定性規則產生，每個 Stage 對應一個 `test.step`。內嵌步驟允許人工編輯。
- 執行報告要看得出失敗發生在哪個 Stage。
- 執行時，任一檔案來源不是 manual，就對整個 Run 套用 AI 網站範圍限制。

### Plan → Stage → Compose

1. **Plan**：AI 拆解任務並搜尋 Catalog，產出 Plan 卡片；使用者可以修改、確認或取消。
2. **Stage**：Server 依序為每個需要修改或新建的 Module 排入 author Run，Run 結束前 Module Harness 要自我試跑。某個 Stage 失敗時停在該階段，由使用者決定要修復、修改 Plan 或放棄。
3. **Compose**：組成 Use Case，排入真實驗證；失敗時用 healer skill 判斷是 Module 問題還是組合問題，不得為了通過而弱化斷言。
4. **發佈**：摘要完成後，Use Case 與本次新增的 Module 版本在同一個交易中人工確認發佈；任一驗證不成立就整批不發佈。

### 引擎能力（G1–G6）

| # | 要求 |
| --- | --- |
| G1 | 預算即將耗盡時要求模型收尾；超過上限時回傳 `partial`，保留最後一份自我試跑通過的候選結果與「下一步」，UI 提供「繼續」動作，不整輪丟棄 |
| G2 | Plan 與 Stage 狀態結構化保存在 Server；每個 Run 只注入目前 Stage 需要的背景 |
| G3 | Skill 有 manifest（id、版本、預設工具、預算、references）；主檔上限 8KB，references 按需讀取；一個 Run 可組合主 skill 與輔助 skill，版本快照進 Run |
| G4 | 工具註冊表：schema、權限類型、執行端（server／worker）、單次上限；工具定義單一來源，供內建引擎、MCP 與 adapter 共用 |
| G5 | 同一 Run 內只保留最新一份完整頁面 snapshot，舊的壓成 URL 加 selectorHints 摘要；工具結果有大小上限 |
| G6 | 預算、模型與推理強度依 skill manifest 由 Server 決定並快照 |

### 新增 skill

`module-authoring`、`usecase-planner`、`catalog-reuse`、`usecase-healer`；既有 `playwright-authoring` 補強 `test.step` 與 locator 策略。可參考 Playwright 官方 planner、generator、healer 的方法（Apache-2.0），引用處要註明出處，工具名稱改用 Whippet 註冊表。

## 階段二：MCP

- Server 提供 MCP Streamable HTTP 端點。每個 Agent Token 只屬於一個 Workspace，由 Superadmin 在 UI 建立與撤銷；明文只顯示一次，撤銷立即生效，並有速率限制。
- MCP 工具由 G4 註冊表產生，與內建引擎是同一份定義；skill 以 MCP prompts 或 resources 提供。
- **互動模式**：開發者用自己的 Agent 連線，搜尋 Catalog、建立 Module 與 Use Case 草稿、提出 Plan、要求驗證、讀取報告、租用瀏覽器 session 探索。寫入一律成為草稿，來源記為 `agent:<token 名稱>`，並套用 AI 來源的網站範圍規則；發佈只能由人在 UI 確認。
- **接單模式**：Workspace 設定 `authorEngine = builtin | external`。設為 external 時，UI 對話產生的 author 任務由外部 Agent 以 `task_claim` 領取。領取時拿到與內建引擎相同的 context bundle（skill、背景、允許工具、預算）；工具呼叫綁定這次 attempt；最後以 `task_submit` 交回結果，交回內容用同一套 parser 驗證。租約要有心跳；逾時、取消或交回失效都要正確收斂，不重複寫入。
- **瀏覽器租用 session**：Worker 以 `session` 模式啟動，佔用既有容量名額，閒置 10 分鐘或總時長 30 分鐘回收，回收完成才釋放名額。沿用範圍守衛、登入工具（只傳 roleId）與 LiveView。
- **安全邊界**：Whippet 無法控制外部 Agent 本機上的環境，因此只保證 Whippet 這一側：外部 Agent 拿不到模型金鑰、憑證明文、Manager token 或其他 Workspace 的資源；所有寫入都要經過驗證與人工發佈；每次工具呼叫都寫入稽核紀錄。

## 階段三：Agent Adapter

- 以 2 天 spike 比較 pi-agent-core＋pi-ai（首選）與 Vercel AI SDK（備選）。符合任一淘汰條件就出局：無法在每次送出模型請求前套用機密遮蔽；會自動載入檔案系統上的設定、skill 或 extension；接不上目前使用的 Responses endpoint；取消後 1 秒內無法停止。
- 勝出的引擎在 Worker 內實作 Engine 介面，使用同一份工具註冊表，不帶入任何內建 fs、shell、eval 或 fetch 工具。
- Server 可依 Workspace 或 skill 指定 engine、provider、model；金鑰只放在後端環境。預設維持內建引擎，黃金任務比較達標才切換預設。
- 提供參考外部 Worker：用同一個開源引擎當 MCP 接單模式的客戶端，證明任何 Agent 都能依同一協定接入。

## 不包含

條件與迴圈 Stage、Module 互相依賴、跨 Workspace 共用、Use Case 平行執行、MCP 自動發佈、外部 Agent 本機環境的沙箱、RBAC。

## 各階段完整驗證

驗證清單見 [實作計畫](../tracking/implementation.md) 各階段的 Z 項。開發期間只做受影響模組的必要檢查；完整驗證集中在每個階段收尾時執行一次，有新改動才重跑相關項目。
