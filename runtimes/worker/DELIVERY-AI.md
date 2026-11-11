# OpenCode Go Muse 預配置交付

更新：2026-11-11 17:38（Asia/Taipei）。Owner：Runtime Agent。

已完成最小 Responses 設定、請求組裝、離線 check、明確 opt-in 的一次性 probe、Compose 與中文指南。**本輪未做 live 模型呼叫，也未讀取真實 key、全域 provider 設定或本機 `deploy/.env.ai`。** 未執行 Git、未啟動其他 Agent；不變更 Manager、M1 執行流程或帳戶設定，不宣稱網頁 AI 對話／M3 完成。

## 產物

| 檔案 | 內容 |
| --- | --- |
| `src/ai/config.ts` | 預設停用、精確 Go base URL／model／xhigh、設定驗證、固定錯誤分類與不含 key 的離線狀態。 |
| `src/ai/responses.ts` | 原生 fetch、一個 POST、caller-owned session、固定 coding probe prompt、回應解析；無 SDK、重試、redirect 或 payg 端點切換。 |
| `src/ai/cli.ts` | `check` 完全離線；`probe` 同時要求 `--live`、enabled、key、session。只印安全摘要／錯誤分類，不印 headers、模型原文或 raw errors。 |
| `src/ai/ai.test.ts` | 8 項合成 key／fetch mock／CLI 測試，沒有模型服務請求。 |
| `package.json` | 新增 `ai:check`、`ai:probe`、`test:ai`；未新增依賴，既有 lockfile 沿用。 |
| `README.md` | 指向 AI 設定指南，釐清預配置與尚未實作的 author／工具迴圈。 |
| `../../deploy/compose.ai.yml` | 獨立 opt-in `ai` profile、一次性 `ai-check`／`ai-probe`；使用既有 Worker 映像，不掛任務目錄或 Docker socket。 |
| `../../deploy/.env.ai.example` | enabled=false、key 空白，其餘指定值完整列入。 |
| `../../docs/guides/opencode-go.md` | 精確 endpoint／model／reasoning／UA／session、key 填寫位置、執行方式與 Go／Contributor 政策。 |

請求固定基線：`POST https://opencode.ai/inference/go/openai/v1/responses`，model `muse-spark-1.3-contributor`，`reasoning:{effort:"xhigh"}`，`User-Agent: whippet-worker/0.1`，Authorization Bearer。`x-opencode-session` 必須由呼叫者按對話固定提供；沒有隨機 fallback。Base URL／model／effort 可替換，未建立多 provider 框架。

## 實際檢查結果

1. `npm run build`：**exit=0**，正式 TypeScript 編譯／型別檢查通過。本輪只執行一次 build。
2. `npm run test:ai`：**8 passed、0 failed、exit=0**。涵蓋：
   - 預設停用／缺 key 的離線狀態，輸出不含合成 key。
   - exact URL、model、reasoning、User-Agent、Bearer 與同一 caller session 的組裝。
   - 停用、缺 key、缺 session 在 fetch 前失敗。
   - 拒絕 URL credentials、CLI 用的 `opencode-go/`／`#xhigh` model 格式及未知 effort。
   - 一次 mocked POST 解析成功文字。
   - 401／403／429／503 各只嘗試一次，錯誤內容不洩漏回應 body 或 key。
   - 連線錯誤、不完整回應、無效 JSON、空文字的固定失敗分類。
   - CLI 缺少 `--live` 直接失敗，無 key 的 check 可正常執行。
3. 離線 `ai:check`：**exit=0**，使用下列清空繼承環境的指令，避免讀取任何 ambient key：

   ```sh
   env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
     WHIPPET_AI_ENABLED=false OPENCODE_API_KEY= \
     npm --cache /private/tmp/whippet-npm-cache run ai:check
   ```

   實際輸出：

   ```json
   {"ok":true,"network":"not_used","enabled":false,"keyConfigured":false,"ready":false,"message":"API key 尚未設定；未連線。"}
   ```

4. 總指揮已回報 Worker Docker 映像重建成功（映像內 TS build 通過）。本 Agent 沒有自行執行或重試 Docker build；容器 `compose ai-check` 由總指揮代跑，exit=0，network=not_used、enabled=false、keyConfigured=false，未連線。

## Key 與 Compose 隔離

- 總指揮已建立被忽略的 `deploy/.env.ai`，其 key 為空、enabled=false、權限 600；本 Agent 未讀取或改寫該檔案。
- 總指揮已在根 `.gitignore` 加 `!.env.*.example`；真實 `.env.ai` 仍忽略。只有 example 應納入版本控制，本輪不做 Git。
- AI key 只由 `compose.ai.yml` 白名單環境變數注入 AI 程序；沒有修改一般 Manager／Worker 的環境設定，也不寫入 input、journal、report。
- Compose 必須顯式使用 `--env-file deploy/.env.ai -f deploy/compose.ai.yml --profile ai`；不將它合併為 Manager 的 env 設定。
- ai-check 為本機設定驗證，不驗證 key、帳戶、地區或訂閱。即使 enabled=true、有 key，check 也不建立請求。

## 日後待使用者提供 key

指南已列明：Go／Go Plus 對應單人 workspace；Go Teams service account 不涵蓋訂閱額度，建議有訂閱資格的個人 Console API key。Extra Usage 是 Console Go 帳戶設定，Teams 預設啟用；本輪不啟用／調整，無 endpoint flag。Contributor 輸入／輸出可訓練、非 ZDR，需使用者在 Console Privacy 開啟 `Allow paid endpoints that train on request data`，並符合 Meta 地區限制。

待使用者提供 key 並明確啟用後，才能另行授權執行 guide 的一次 live probe。Probe 只使用固定合成 Playwright coding prompt、最多一次 POST、120 秒 timeout、4096 output tokens；不執行模型產生的程式，不自動追加請求，也不切換 payg。帳戶已開啟的 Extra Usage 仍可能由服務端扣餘額，client 不會代替帳戶政策。

目前不需要等待 API key。互動工作階段保留，等待後續指示。

## 後續實際驗證

2026-11-11 使用者提供 key 並授權後，總指揮透過 Compose 一次性覆寫 WHIPPET_AI_ENABLED=true 執行固定合成 coding probe。exit=0、status=completed、textCharacters=264、requests=1。未輸出金鑰、未執行生成程式、未更改帳戶設定。
