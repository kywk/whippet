# v13 平台角色、Workspace 成員與測試封存

## 開發登入

登入頁提供四個固定身分，預選 **QA User**。

| `userId` | 登入選項 | 初始全站角色 | Workspace 初始成員角色 |
| --- | --- | --- | --- |
| `dev-admin` | Super Admin | `superadmin` | — |
| `dev-site-admin` | Admin | `site_admin` | — |
| `dev-workspace-admin` | Workspace Admin | `none` | `workspace_admin` |
| `dev-qa` | QA User | `none` | `qa` |

- `POST /api/dev-login` 接受 `{userId}`，回傳 `{user}` 並發送同源 HttpOnly session cookie。既有不帶 body 的開發登入請求對應 `dev-admin`。`POST /api/dev-logout` 撤銷 session，`GET /api/me` 讀取當前角色與權限。
- 啟用 `WHIPPET_ADMIN_TOKEN` 時，登入要求管理 key。共用管理 key 可登入任一固定身分，適用開發與驗收。使用該 key 的部署端 CLI 可獨立管理 Server。Web 在登入後以 session 存取 API。
- User 包含 `id`、`name`、`role`、`permissions`。全站權限欄位為 `createWorkspace`、`manageUsers`、`manageSuperAdmins`。

## 角色指派與資源授權

| 能力 | Super Admin | Site Admin | Workspace Admin | RD／QA |
| --- | --- | --- | --- | --- |
| 建立 Workspace | ✓ | ✓ | — | — |
| 設定網站、登入角色、Workspace Agent／執行設定 | 全站 | 全站 | 成員範圍 | — |
| 指派 Workspace Admin | 全站 | 全站 | — | — |
| 指派 QA／RD 成員 | 全站 | 全站 | 成員範圍 | — |
| 指派 Site Admin | ✓ | ✓ | — | — |
| 指派 Super Admin、管理 MCP Token 與工具稽核 | ✓ | — | — | — |
| 操作測試資產、執行、驗證、報告與即時監看 | 全站 | 全站 | 成員範圍 | 成員範圍 |

- `GET /api/users` 回傳 `{items: User[]}`。`PATCH /api/users/{userId}/role` 接受 `{role}` 並回傳 `{user}`。系統至少保留一位 Super Admin。
- `GET /api/workspaces/{id}/members` 回傳 `{items}`，每筆有 `id`、`name`、`role`。`PUT /api/workspaces/{id}/members/{userId}` 接受 `{role}` 並回傳 `{member}`。角色值為 `workspace_admin`、`qa`、`none`，`none` 代表移除成員。Workspace Admin 可操作所管理 Workspace 的 QA 成員。
- Workspace 清單與詳情回傳 `permissions`，欄位為 `manageTests`、`manageSettings`、`manageMembers`、`manageWorkspaceAdmins`、`manageAgentTokens`。Server 從資料庫資源關聯決定 Workspace，只列出可存取的 Workspace。跨 Workspace 資源以 404 回覆。已登入且同 Workspace 的操作權限不足回 403。
- 遷移為現有 Workspace 建立預設成員，新建 Workspace 在同一交易建立預設成員。之後以實際成員紀錄判定。撤權在更新後即套用於 HTTP 和監看，先前排隊的 Run 照原快照執行。
- 登入後開啟報告時，Server 以本次 Run 的短效路徑提供隔離報告頁面與相對路徑附件。PNG、ZIP、Markdown 附件授權最長 10 分鐘，每次讀取重查來源 session 與 Workspace 權限。報告頁面使用一般登入授權。反向代理的存取紀錄應省略 `/api/runs/{id}/report-view/` 路徑。
- 全站 Agent Manager 的設定權限保留給 Super Admin。Workspace 設定可選用後端可用的 Agent 執行設定。MCP 與 Manager 各自使用對應的機器身分，沿用 Agent Harness 的 Workspace、範圍、任務和工具授權。

## 測試資產封存

- `POST /api/tests/{id}/archive` 接受 `{confirmed:true}`，回傳 204。適用 Test、Module、Use Case。編輯中的資產須先完成發佈或放棄草稿，放棄中的資產須等候回收。重送封存請求回傳 204。
- `GET /api/workspaces/{id}/archived-tests` 回傳 `{items}`。封存資產以 `archived: true` 標記，原版本與 Run 紀錄可讀。一般清單與 Catalog 搜尋隱藏已封存資產。
- 封存後禁止開新草稿或排入新的獨立 Run。已排入的 Run、歷史報告及 Use Case 已固定的 Module 版本仍可使用。
