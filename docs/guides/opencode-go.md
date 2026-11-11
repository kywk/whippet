# OpenCode Go Muse 預配置

目前只預配 Worker 的原生 Responses 請求、離線檢查與一次性 coding probe。AI 預設停用，key 尚未提供；沒有接上網頁 AI 對話、Server 草稿或 Agent 工具迴圈，不代表 M3 已完成。本輪沒有發送任何模型請求。

## 固定的 Go 設定

| 項目 | 值 |
| --- | --- |
| API 協定 | 原生 Responses，非 Chat Completions |
| Base URL | `https://opencode.ai/inference/go/openai/v1` |
| 實際請求 | `POST https://opencode.ai/inference/go/openai/v1/responses` |
| Model | `muse-spark-1.3-contributor` |
| Reasoning | JSON body `reasoning: {"effort":"xhigh"}` |
| 驗證 | `Authorization: Bearer <OPENCODE_API_KEY>` |
| User-Agent | `whippet-worker/0.1` |
| Session | `x-opencode-session: <呼叫者的對話 ID>`，同一對話保持相同值 |

Model 欄位不加 `opencode-go/`，也不加 `#xhigh`；effort 是獨立的 body 欄位。Session 由呼叫者提供，不會按每次請求隨機產生。Go 建議 coding-agent traffic，因此 probe 使用固定、合成的 Playwright TypeScript coding prompt，不傳實際專案資料。官方介面說明見 [OpenCode Go 文件](https://opencode.ai/docs/console/go)；公開模型能力列於 [Go models catalog](https://opencode.ai/inference/go/v1/models)，指定模型包含 `xhigh`。

## 訂閱與 Contributor 資料政策

- Go／Go Plus 對應單人 workspace。Go Teams 的 service account 不涵蓋訂閱額度；建議使用有訂閱資格的**個人 Console API key**，之後由使用者提供。
- **Extra Usage 是 Console Go 的帳戶設定，沒有對應的 endpoint flag。** 啟用時，訂閱額度用完後可改扣 Console 餘額；Go Teams 預設啟用。本次不啟用、不關閉，也不調整任何帳戶設定。
- 本程式不重試 401／403／429，也不改用另一個 pay-as-you-go endpoint；但若帳戶本身已啟用 Extra Usage，服務端仍可能依帳戶設定扣餘額。這與 client 自動切換端點是不同機制。
- Contributor 的輸入與輸出可用於訓練，**不是 ZDR**。使用者須在 Console Privacy 開啟 `Allow paid endpoints that train on request data`，並符合 Meta 地區限制；程式不會代改這些設定。

這些條件以 [官方 Go 訂閱、Extra Usage 與 Contributor 說明](https://opencode.ai/docs/console/go) 為準。離線 `ai:check` 不會驗證訂閱、地區、隱私設定或 key 是否有效，也不會連線查看帳戶。

## Key 的填寫位置

範例位於 [deploy/.env.ai.example](../../deploy/.env.ai.example)，其中 key 必須維持空白。真實設定只放在被忽略的 `deploy/.env.ai`；總指揮已建立空 key、`enabled=false` 的本機檔案，權限為 600。本 Agent 沒有讀取該檔案，也沒有讀取全域 provider 設定或既有憑證。

首次在其他環境設定時，可從 repo 根目錄建立本機副本；`cp -n` 不覆寫既有檔案：

```sh
cp -n deploy/.env.ai.example deploy/.env.ai
chmod 600 deploy/.env.ai
```

使用文字編輯器在 `deploy/.env.ai` 填入個人 Console API key。要允許未來的明確 live probe，再將 `WHIPPET_AI_ENABLED=false` 改為 `true`；不設定任何 Extra Usage／payg 變數。不要將 key 填進 example、腳本、`input.json`、journal 或報告。

| 環境變數 | 預設／用途 |
| --- | --- |
| `WHIPPET_AI_ENABLED` | `false`；只有精確的 `true` 才允許發送請求 |
| `WHIPPET_AI_BASE_URL` | 上表 Go Responses base URL；不含 `/responses` |
| `WHIPPET_AI_MODEL` | `muse-spark-1.3-contributor` |
| `WHIPPET_AI_REASONING_EFFORT` | `xhigh` |
| `OPENCODE_API_KEY` | 空白；只注入一次性的 AI 程序 |
| `WORKER_IMAGE` | `whippet-worker:m1`，Compose 所使用的 Worker 映像 |

`deploy/.env.ai` 受既有 `.env.*` 規則排除；總指揮已加上 `!.env.*.example`，只有 example 應進版控。本輪不執行 Git。

## 離線檢查

Worker 套件不自動讀 `.env`、全域 provider 檔或 OpenCode CLI 設定，只讀該程序收到的環境變數。已有編譯產物時，從 repo 根目錄執行：

```sh
npm --prefix runtimes/worker run ai:check
```

未提供設定時，會輸出 `enabled:false`、`keyConfigured:false`、`ready:false` 與「API key 尚未設定」，exit=0。設定不合法則 exit=1。即使有 key 且 enabled=true，check 仍完全不聯網，也不輸出 key、headers 或設定原文。

本次修改新增了 `dist/ai/`，既有 `whippet-worker:m1` 映像須由總指揮更新一次；build context 只包含 Worker，不包含 `deploy/.env.ai`：

```sh
docker build -t whippet-worker:m1 runtimes/worker
```

使用 [compose.ai.yml](../../deploy/compose.ai.yml) 執行一次性容器 check：

```sh
docker compose --env-file deploy/.env.ai -f deploy/compose.ai.yml --profile ai run --rm --no-deps ai-check
```

該 Compose 是獨立 opt-in 檔案，不合併或修改 Manager stack；沒有 Docker socket、任務目錄掛載或常駐服務。Key 只給 `ai-check`／`ai-probe` 的 AI 程序，不會傳入一般 Manager spawned Playwright 容器。不要將這份 AI env 檔加入 Manager／一般 Worker 的環境設定。

如需檢查 Compose 格式，使用 `config --quiet`，避免展開後的 key 印到終端：

```sh
docker compose --env-file deploy/.env.ai -f deploy/compose.ai.yml --profile ai config --quiet
```

## 日後的一次 live probe

**本輪不可執行以下 live 指令。** 待使用者提供 key、確認上述資格與資料政策，並明確設為 enabled=true 後，才由使用者或另行授權的 Agent 執行一次：

```sh
docker compose --env-file deploy/.env.ai -f deploy/compose.ai.yml --profile ai run --rm --no-deps ai-probe --live --session=whippet-conversation-001
```

在已注入上述環境變數的原生 Worker 程序，也可使用：

```sh
npm --prefix runtimes/worker run ai:probe -- --live --session=whippet-conversation-001
```

若要直接由 Node 載入本機 env 檔，從 repo 根目錄使用：

```sh
node --env-file=deploy/.env.ai runtimes/worker/dist/ai/cli.js probe --live --session=whippet-conversation-001
```

同一對話沿用 `whippet-conversation-001`，新的對話由呼叫者選擇另一個固定 ID。Session 只接受 1..128 個英數字、點、底線、冒號或連字號；沒有預設值。

Probe 使用固定合成 HTML，要求產生一份 `@playwright/test` spec；不讀專案、不中途呼叫工具，也不執行產出的程式。每次明確執行只嘗試一個 POST，`max_output_tokens=4096`、120 秒 timeout；不追蹤 redirect、不自動重試、不換模型／端點。缺少 `--live`、enabled、key 或 session 都會在 fetch 前失敗。

成功只輸出 `status:completed`、文字長度與 `requests:1`，不印模型原文，也不寫腳本或報告。401、403、429、其他 HTTP 錯誤、逾時與不完整回應均 exit=1，輸出固定錯誤分類及適用的 HTTP 狀態。逾時時服務端可能已收到請求，不能據此假定未計量；程式不自行追加請求。

## 開發驗證

```sh
npm --prefix runtimes/worker run build
npm --prefix runtimes/worker run test:ai
npm --prefix runtimes/worker run ai:check
```

AI 測試只用合成假 key 與 fetch mock；不讀真實 key、不連模型服務、不調整帳戶設定。當前預配置的實際驗證紀錄見 [DELIVERY-AI.md](../../runtimes/worker/DELIVERY-AI.md)。
