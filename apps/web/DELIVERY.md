# Web M1 交付紀錄

日期：2026-11-11（Asia/Taipei）。Owner：Web Agent。所有本輪新增與修改均位於 `apps/web/`；未執行 Git、未啟動其他 Agent。進度主檔由總指揮彙整，本 Agent 未修改。接續整合已獲准安裝固定依賴：總指揮代跑安裝成功，已保留 `package-lock.json`，Web Agent 正式 `npm run build` 通過。

## 產物與行為

- React／TypeScript SPA：開發管理員登入、Workspace 選擇、測試列表與搜尋、測試詳情、發佈版本 ID、執行按鈕、最近結果、執行歷史與錯誤內容。
- 依 `contracts/mvp-v1.md` 呼叫七個端點：`POST /api/dev-login`、`GET /api/workspaces`、`GET /api/workspaces/:id/tests`、`GET /api/tests/:id`、`POST /api/tests/:id/runs`、`GET /api/tests/:id/runs`、`GET /api/runs/:id`。
- 登入完全使用 Server 回應，請求帶 `credentials: include`。不自行產生 token，也不將 mock 身分套入真實 API。
- 初次載入測試詳情與執行歷史可並行；有進行中的 Run 時，每 2 秒查詢該 Run 狀態，同輪完成後才排下一輪。終態停止輪詢；切換測試或返回登入會取消讀取與清除計時器。
- 呈現契約的全部十種 Run 狀態；`failed`、`timed_out`、`interrupted` 明確顯示異常。報告用 Server 的 `reportUrl` 在新分頁開啟，支援絕對及相對 HTTP(S) URL；不將報告 HTML 插入 SPA。
- 防止連點重複 POST。建立 Run 的網路錯誤不自動重送，會提示先重新整理紀錄，以免結果不明時建立重複任務。
- 未發佈測試不可執行；有載入、空資料、連線錯誤、重試與報告尚未提供等狀態。窄螢幕改成上下排列，可用鍵盤操作。
- 小型 mock 必須明確設定 `VITE_USE_MOCK=true`，畫面會持續顯示示範標示。提供成功與斷言失敗兩個範例；示範報告清楚標示未執行 Playwright。真實 API 錯誤不會自動切成 mock。

主要檔案：

| 檔案 | 用途 |
| --- | --- |
| `src/App.tsx`、`src/styles.css` | 繁中 UI、詳情、結果與歷史 |
| `src/api.ts`、`src/types.ts` | 契約型別、HTTP client、錯誤與報告 URL 處理 |
| `src/hooks.ts` | 資料載入、Run 輪詢、取消讀取與建立紀錄的競態處理 |
| `src/mock.ts`、`public/mock-report.html` | 明確 opt-in 的示範資料與報告 |
| `src/main.tsx`、`index.html` | SPA 入口 |
| `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts` | 固定直接與傳遞依賴、型別檢查與 Vite 開發代理 |
| `Dockerfile`、`nginx.conf.template` | 多階段建置、靜態部署與同源 `/api` 代理 |
| `.env.example`、`.gitignore`、`.dockerignore` | 設定範例與產物排除 |

## 串接設定

預設使用真實、同源 `/api`。開發時 Vite 將 `/api` 轉送到 `http://localhost:8080`，保留完整路徑；開發埠為 `5173`。

| 變數 | 預設值 | 生效時機 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | Vite 啟動／建置時；需含 API 前綴 |
| `WHIPPET_API_PROXY_TARGET` | `http://localhost:8080` | Vite 開發代理；只填 Server origin |
| `VITE_USE_MOCK` | `false` | Vite 啟動／建置時；只有字串 `true` 開啟 |
| `WHIPPET_API_UPSTREAM` | `http://server:8080` | Nginx 容器啟動時；不含 `/api`、結尾不加 `/` |

已完成首次安裝並保留 lockfile；後續在 `apps/web/` 執行：

```sh
npm ci --no-audit --no-fund
npm run dev
npm run build
```

`npm run preview` 只預覽靜態產物，未提供 `/api` 代理；要串 API 請使用 Vite 開發模式或 Nginx 容器。若使用絕對 API URL，Server 需允許前端 origin 與 credentialed CORS；建議先用同源代理。

Docker build context 為 `apps/web/`，從 repo 根目錄可用：

```sh
docker build -t whippet-web apps/web
```

Compose 整合時將 Web 的容器埠 `80` 對外，並讓 Web 與名稱為 `server`、監聽 `8080` 的 Server 共用網路；若服務名稱不同，設定 `WHIPPET_API_UPSTREAM`。該 upstream 必須能在 Nginx 啟動時解析。Dockerfile 已改成先複製 `package.json` 與 `package-lock.json`，再執行 `npm ci --no-audit --no-fund`；Docker 映像尚未建置。

## 實際檢查

1. **整合依賴準備完成**：總指揮回報 `npm install` 成功（70 packages）。已保留 lockfile v3，並核對八個直接依賴的實際鎖定版本與 `package.json` 完全一致。Web Agent 原先的沙箱安裝因 DNS `ENOTFOUND` 中止，未重試或重複安裝；專案內 `.npm-cache` 已加入 Git 與 Docker 排除清單。
2. **正式 production build 通過**：Web Agent 在 Node `v22.23.4` 執行 `npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` 建置皆成功，退出碼 `0`。共轉換 34 個模組；產出 `dist/index.html`（0.55 kB）、CSS（10.02 kB）與 JS（212.46 kB，gzip 66.98 kB）。不需修正應用程式碼，完成後未重跑建置。
3. **Docker 可重現安裝設定已更新**：Dockerfile 先複製 manifest 與 lockfile，再執行 `npm ci --no-audit --no-fund`；排除本機 `node_modules`、`.npm-cache` 與 `dist`。本輪未執行 Docker build。
4. **原實作階段的既有檢查**：依賴未準備時，純 API／型別／mock 模組曾通過既有快取 TypeScript 的嚴格檢查，TSX／CSS 曾通過既有 esbuild 的語法打包。當時正式 build 因缺少 `tsc` 受阻；此限制已由本次完整正式建置解除。
5. **原實作階段 API client 最小 smoke 通過，整合階段未重跑**：使用 stub fetch 驗證七個端點與 HTTP 方法、cookie 選項、202 建立 Run、失敗狀態、結構化 API 錯誤、非 JSON 回應、未知狀態、取消請求、相對／絕對報告網址及拒絕 `javascript:`；另驗證 mock 成功／失敗與報告欄位。後續兩個局部修正（讀取 JSON 途中保留取消訊號、同步錯誤文案）已包含在本次正式型別檢查與建置；未新增功能或擴大測試範圍，未宣稱完成 E2E。

## 限制與接手事項

- 前端實作、完整 React 型別檢查與 Vite production build 已完成；瀏覽器操作／視覺檢查、Docker 建置與真實 Server → Manager → Worker → 報告的流程仍待整合驗證。
- `package.json` 已固定直接依賴與 Docker 映像標籤，`package-lock.json` 已保存傳遞依賴。Dockerfile 已改用 `npm ci`；未額外重裝依賴或建置 Docker 映像。
- Server 需提供開發登入、預設 Workspace、已發佈固定測試、Run 狀態與可存取的報告附件。契約未定義登入 session/token 細節，目前只依固定登入回應與 cookie 串接。
- 「返回登入」只清除目前頁面的登入顯示並取消前端讀取；契約沒有登出端點，不代表撤銷 Server session。重新整理頁面後需再次點擊開發登入。
- 列表顯示名稱、描述與發佈狀態；執行結果在所選測試的詳情顯示，未為列表每個測試額外查詢歷史摘要。
- 輪詢僅追蹤目前測試中已載入的活躍 Run；若其他分頁建立任務，或終態仍缺報告，使用「重新整理」載入。單輪暫時失敗會保留既有狀態並重試，不把連線失敗改成任務失敗。
- 不含 M2 草稿／發佈／取消 API、AI 對話與即時監看；M1 契約沒有的操作未建立假入口。
- 依使用者要求，未啟動設計審查 Agent，也未執行額外設計研究／工具探查；未宣稱取得視覺審查通過。

整合時只需跑一條成功路徑，再執行一個真實斷言失敗：確認 UI 分別顯示「通過」與「失敗」、錯誤內容正確、報告可開啟，且完成後停止自動輪詢。此項由總指揮統一驗收，避免多人重跑全量測試。

本互動工作階段保留，等待總指揮後續串接指示。
