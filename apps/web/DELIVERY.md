# Web M1／M2 交付紀錄

日期：2026-11-11（Asia/Taipei）。Owner：Web Agent。所有新增與修改均位於 `apps/web/`；未執行 Git、未啟動其他 Agent。進度主檔與測試後 commit 由總指揮彙整處理。M1 整合時由總指揮完成依賴安裝，已保留 lockfile；本次 M2 沿用現有依賴，未安裝套件、未讀取 env 檔案。

## M2 最新交付

依 `contracts/mvp-v2.md` 完成，保留既有 M1 登入、列表、正式執行、短輪詢與報告流程。沒有 M3／AI 對話介面，沒有變更共用契約或其他 owner 的檔案。

- **新增測試**：Workspace 列表提供建立表單，POST 名稱與選填描述；直接選取新測試，進入空白草稿。未發佈測試不能執行正式版本。
- **草稿**：GET 初始草稿、編輯 TypeScript、以 `{revision,script}` PUT 儲存；畫面區分已儲存與未儲存內容。切換測試／Workspace、返回登入、重新整理或離開頁面前，對尚未儲存草稿或進行中的草稿請求提示確認。
- **409 衝突**：不自動覆寫或重送，保留本機編輯內容。顯示 revision／驗證資格過期提示；可先複製內容，再明確確認捨棄並載入最新草稿。未知網路結果不當成儲存／發佈成功。
- **草稿驗證**：只能驗證已儲存 revision；POST `{revision}` 建立 validation Run，與正式 Run 一起短輪詢。完成後 GET 草稿同步權威驗證資格，保留使用者在等待期間輸入的文字；舊 revision 的成功不能開放目前草稿發佈。
- **明確確認發佈**：目前 revision 驗證 `succeeded`、草稿有合法報告 URL、無未儲存內容且無衝突時，才開放確認勾選。使用者勾選後，再按確認發佈按鈕，送 `{revision,confirmed:true}`。最終交易門檻仍由 Server 核對；成功後更新目前版本與版本歷史。
- **歷史版本與報告**：GET versions，顯示 revision、建立時間、版本 ID、目前版本標示與唯讀腳本。以 Version 的 `validationRunId` 對應執行報告；若歷史列表未含該 Run，可按鈕載入，不為每個版本立即發送額外請求。
- **取消**：活躍 Run 的歷史列可取消；queued 回 cancelled、其餘依 Server 回應顯示 cancelling，繼續輪詢至終態。取消操作同時適用正式與驗證 Run；較早送出的 GET 不會覆蓋取消回應。
- **mock 相容**：明確 opt-in 的 mock 同步支援 M2 草稿、revision、驗證／發佈、唯讀版本與取消；維持明顯示範標示。腳本內 `MOCK_FAIL` 是 mock 專用失敗標記，並非執行 Playwright；正式 API 完全不使用此判斷。

新增檔案為 `src/DraftEditor.tsx`（草稿與發佈流程）、`src/TestActions.tsx`（新增測試、取消、歷史版本）、`src/components.tsx`（共用訊息、狀態與報告元件）；另修改 `src/App.tsx`、`src/api.ts`、`src/types.ts`、`src/hooks.ts`、`src/mock.ts`、`src/styles.css`。沒有修改依賴宣告、lockfile、Dockerfile 或部署設定。

M2 HTTP 串接如下，完全沿用契約，未要求 Server 增加欄位或端點：

| 操作 | 請求 |
| --- | --- |
| 新增測試 | `POST /api/workspaces/:id/tests {name,description}` |
| 載入草稿 | `GET /api/tests/:id/draft` |
| 儲存草稿 | `PUT /api/tests/:id/draft {revision,script}` |
| 驗證草稿 | `POST /api/tests/:id/draft/validate {revision}` |
| 明確發佈 | `POST /api/tests/:id/publish {revision,confirmed:true}` |
| 歷史版本 | `GET /api/tests/:id/versions` |
| 取消任務 | `POST /api/runs/:id/cancel` |

Run 解析支援 `kind`、`draftRevision`、`versionId`，同時容許 M1 舊回應省略擴充欄位。Draft／Version 的 revision 使用非負整數；validationStatus 使用契約既有十種狀態。

### M2 實際驗證與剩餘事項

- **本機正式建置一次通過**：`npm run build`，完整 `tsc --noEmit` 與 Vite `7.1.9` production build，退出碼 `0`。轉換 37 個模組；`dist/index.html` 0.55 kB、CSS 12.31 kB、JS 227.11 kB（gzip 70.92 kB）。未在通過後重跑。
- 本輪沒有全面 UI 測試、沒有重跑 M1 smoke、沒有安裝套件與 Git 操作。Docker build 由總指揮負責；M2 真實 Server／Runtime 的黑箱 UI smoke 由指定 Muse 後續統一執行。未宣稱 M2 E2E 驗收完成。
- 前端不自行推斷附件已保存，只有 GET Draft 回傳的成功資格與報告可用時才開放確認。Server 必須在相同 revision 的驗證終態後更新 Draft 的 `validationRunId`、`validationStatus`、`reportUrl`；HTTP 衝突必須使用 409。
- 前端取消後等待 Server 的終態；Worker 回收、FIFO、重連去重與名額釋放仍屬 Server／Runtime，不能以按鈕回應推定容器已回收。
- 本機尚未儲存的草稿只存在頁面記憶體；使用者明確放棄或確認離開後不保存。POST 結果不明時，應先重新整理對應紀錄後再決定是否重送。

### Muse 黑箱 UI 定位表

以下都是畫面可見文字，無須讀取原始碼或 env。`N` 代表畫面目前 revision 數字；同名「重新整理」請以區塊標題定位。

| 區塊／欄位 | 可見 label／button | 預期行為 |
| --- | --- | --- |
| 登入 | `以開發管理員登入` | 顯示 Workspace 與測試列表 |
| 工作區 | `Workspace` | 原生 select 選擇工作區 |
| 列表 | `新增測試`、`搜尋名稱或描述`、`重新載入` | 新增表單、搜尋或重新載入列表 |
| 新增表單 | `測試名稱`、`描述（選填）` | 輸入名稱與說明 |
| 新增表單 | `建立測試`、`返回測試` | 建立後選取新測試，或取消新增 |
| 草稿編輯 | `Playwright TypeScript 腳本` | 可編輯多行 textarea；上方顯示 `revision N · 已儲存` 或 `有未儲存變更` |
| 草稿操作 | `儲存草稿` | 儲存後顯示 `已儲存 revision N。` |
| 草稿操作 | `驗證此 revision` | 送出後出現 validation Run；進行中按鈕為 `驗證進行中` |
| 衝突／重載 | `重新載入草稿` | 若有本機修改，先顯示捨棄確認 |
| 捨棄確認 | `確定放棄並重新載入`、`繼續編輯` | 明確載入最新草稿，或保留本機內容 |
| 驗證與發佈 | `重新整理驗證狀態`、`查看草稿驗證報告` | 重讀 Draft 權威資格、在新分頁開啟報告 |
| 驗證與發佈 | `我已檢視驗證報告，確認發佈 revision N` | 符合資格後可勾選；不會自動發佈 |
| 驗證與發佈 | `確認發佈 revision N` | 勾選後可按；成功顯示 `已發佈 revision N，版本 …` |
| 詳情 | `執行測試` | 只執行目前已發佈版本 |
| 執行紀錄 | `重新整理`、`取消執行` | 更新歷史，或取消指定活躍 Run；取消後顯示 `取消中…` 或 `已取消` |
| 執行紀錄 | `草稿驗證 · rN`、`正式執行` | 分辨 Run 類型與 revision／版本 |
| 執行紀錄 | `查看錯誤`、`開啟報告` | 展開失敗錯誤，或以新分頁開啟該 Run 報告 |
| 歷史版本 | `重新整理版本`、`revision N · 目前版本` | 重讀不可變版本並辨認目前版本 |
| 歷史版本 | `查看此版本腳本（唯讀）`、`查看版本驗證報告` | 檢視版本固定腳本及原驗證報告 |
| 歷史版本 | `載入驗證報告`、`重新載入驗證報告` | 找不到相關 Run 或尚缺連結時按需取得 |

建議 Muse 在同一條黑箱 smoke 依序完成：建立唯一名稱測試 → 貼入下方腳本 → 儲存／驗證成功 → 確認未勾選時不可發佈 → 修改／儲存一次，確認舊驗證不能放行新 revision → 再驗證並檢視報告 → 勾選並確認發佈 → 檢查歷史版本與唯讀腳本 → 正式執行並從該列取消。可在同一流程以第二分頁保留舊 revision，第一分頁儲存後再於第二分頁儲存，確認 409 提示且本機文字保留。若要涵蓋失敗顯示，將預期標題改成 `不會出現` 後儲存／驗證，確認顯示「失敗」、有錯誤與報告且不能發佈。這是後續驗收定位資訊，本 Agent 未執行該 smoke。

供黑箱操作貼入的本地頁面腳本如下；8 秒等待僅用來留下可觀察與取消的時間，不依賴外網：

```ts
import { test, expect } from '@playwright/test';

test('M2 本地頁面 smoke', async ({ page }) => {
  await page.setContent('<h1>完成</h1>');
  await expect(page.getByRole('heading')).toHaveText('完成');
  await page.waitForTimeout(8_000);
});
```

## M1 既有產物與行為

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
- M2 草稿／發佈／取消已在上方最新交付實作；仍不含 M3 AI 對話與即時監看。
- 依使用者要求，未啟動設計審查 Agent，也未執行額外設計研究／工具探查；未宣稱取得視覺審查通過。

整合時只需跑一條成功路徑，再執行一個真實斷言失敗：確認 UI 分別顯示「通過」與「失敗」、錯誤內容正確、報告可開啟，且完成後停止自動輪詢。此項由總指揮統一驗收，避免多人重跑全量測試。

本互動工作階段保留，等待總指揮後續串接指示。
