# M10.6 真模型搜尋並複用：隔離驗收入口

本輪只準備入口、編譯與缺 env 的 SKIP 驗證，未呼叫真模型。模型設定由 PM 從既有配置在記憶體注入執行環境；測試不讀憑證檔、容器環境或 deploy 設定，不印 endpoint/key。沒有自動重試整輪任務、切換模型或端點。

## 執行命令

完整驗收入口由 Server owner 維護：`services/server/internal/server/platform_bridge_postgres_test.go::TestM106LiveModelServerBridge`。PM 沿既有隔離 DB wrapper 注入 TEST_DATABASE_URL 及下方模型 env，再於 services/server 執行：

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOCACHE=/private/tmp/whippet-m10-go-cache \
  /Users/kywk/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.2.darwin-arm64/bin/go \
  test -tags=integration,m10bridge ./internal/server \
  -run '^TestM106LiveModelServerBridge$' -count=1 -v
```

外層另需 `WHIPPET_M10_MANAGER_GO` 指向上述既有 Go binary；由 Server fixture 啟動以下 Manager 子測試，cwd=services/manager：

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOCACHE=/private/tmp/whippet-m10-go-cache \
  /Users/kywk/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.2.darwin-arm64/bin/go \
  test ./internal/manager -run '^TestM106LiveModelServerBridge$' -count=1 -v
```

Worker 須有最新 dist（`npm run build`，cwd=runtimes/worker），不安裝依賴。不得僅憑 Manager 子測試 PASS 宣稱 Server 已保存 Plan。

## 環境變數

PM 只在執行環境注入：

- `WHIPPET_M106_LIVE_MODEL=1`：明確 live opt-in。
- `WHIPPET_AI_ENABLED=true`
- `WHIPPET_AI_BASE_URL`：既有 HTTPS Responses base URL，不含 /responses 尾端。
- `WHIPPET_AI_MODEL`
- `WHIPPET_AI_REASONING_EFFORT`
- `OPENCODE_API_KEY`

Server 隔離 fixture 提供：

- `WHIPPET_M10_BRIDGE_URL`：僅接受 HTTPS loopback 的測試 Server。
- `WHIPPET_M10_BRIDGE_CA`：合成公開 CA PEM 絕對路徑。
- `WHIPPET_M10_BRIDGE_TOKEN`：本輪 synthetic- 前綴測試 token。
- `WHIPPET_M10_BRIDGE_INPUT`：完整 WorkerInput JSON 絕對路徑。
- `WHIPPET_M10_BRIDGE_RESULT`：安全 handoff JSON 絕對路徑。
- `WHIPPET_M10_WORKER_ENTRY`：最新 dist/author/main.js 絕對路徑。
- `WHIPPET_M106_EXPECT_VERSION`：本輪合成已發布 Module version UUID，僅測試觀測使用。

未 opt-in 或任一必要 env 缺失皆明確 SKIP，訊息只有變數名稱。設定有提供但不合法則 FAIL。模型 provider/model/reasoning 必須與 Run 的完整 manifest 快照相符，不修改快照繞過核對。模型沒有收到 Manager token 或測試 CA；model key 僅在子程序環境。

## 合成 fixture 與輸入

Server 在隔離 PG 建立本輪 Workspace、Use Case editing session，以及一個同 Workspace 已發布的 setup Module。可使用 name=`M106 isolated alpha setup`、slug=`m106-alpha-setup`、exportName=`prepare`：

```ts
export async function prepare({}: Record<string, never>) {
  return { name: "alpha" };
}
```

對應 harness 使用 `@lib/m106-alpha-setup`，以 `expect(await prepare({})).toEqual({name:"alpha"})` 驗已發布 fixture；Module metadata、固定 version ID 與來源皆由 fixture 寫入。此任務只搜尋複用，不執行或重新發佈 Module。

Author primary=`usecase-planner`，nested `author.platform={planId:null,stageId:null,module:null}`，固定最新 registry/skill hashes。最小 allowedTools 為 catalog_search/catalog_get/propose_plan，無 browser/queue 工具；建議 manifest 原預算 8 model requests、12 tools、180000ms，允許的 gate 範圍為 4..8 requests、3..12 tools、至多180000ms。使用現有 pinned model/effort。

自然語言目標：「請搜尋目前 Workspace 已發布、可建立 name=alpha 資料的 setup Module，讀取匹配的固定版本，再提出只有一個 reuse Stage 的 Plan。保留該固定版本；本輪只提出候選，等待人工確認。」不要在 prompt 注入 version UUID 或合成工具回覆，測試須觀察模型自行搜尋取得 ID。

## 可觀測 PASS 條件

1. 真 Node 透過既有 Responses 設定產生工具呼叫，至少一次模型請求；沒有 mock model server 或 scripted calls。
2. `catalog_search` 的真 Server 成功結果包含 EXPECT_VERSION。
3. 隨後 `catalog_get` 請求與成功結果皆為同固定版本。
4. 隨後 `propose_plan` 的模型 arguments 與 Server canonical stages 都恰有一個 action=reuse Stage，moduleVersionId 為同版本。
5. Worker final candidateRef 等於最後成功提案的 ref；Manager parser 通過並實際 HTTPS 上傳 author.json。
6. 外層 Server fixture 對 terminal 執行收尾，PG 保存 canonical Plan、狀態 draft、只引用該固定版本；沒有排 author/validation 或確認/發佈。外層失敗不可算整合 PASS。

Manager handoff 沿原 result 格式，另含安全觀測：`{runId,attemptId,result,artifactUploaded:true,liveModel:true,catalogSearch:true,catalogGet:true,reuseVersionId,candidateRef,modelRequests,genericIPC,toolSuccess}`。不包含模型文字、request payload、endpoint、key 或 token。工具呼叫數不要求固定，仍受 Run budget 限制。

## 本輪已跑檢查

刻意移除 OPENCODE_API_KEY，執行 `TestM106LiveModel(EnvironmentGate|ServerBridge)`：編譯 PASS，environment gate PASS，live bridge 因缺 env 明確 SKIP；未發模型請求。Server owner 已確認外層入口只編譯、未執行 live。未部署、重啟服務或寫 QA scripts。

離線補充核對：Server 的 m10PlatformInput 直接載入 packaged planner manifest 建立 budget/model/skill pins；live fixture 指定 8 次請求，目前與 manifest 的 8/12/180000ms 相符。Manager `TestM106LiveModelPackagedPlanner` 已 PASS，若 manifest 改變即拒絕這份固定驗收預算。環境 model/effort 與 Run 不符會在啟動 Node 前 FAIL，Worker 再核對完整 manifest/main/reference pins。

沿用既有環境時，PM 在已具備上述五個模型設定的父程序啟動既有隔離 DB wrapper／Server 測試即可；不使用 source、cat、docker inspect 或任何憑證路徑。Server 只以名稱白名單將已繼承值放進 Manager 子程序的 Env，Manager 再將同一白名單傳給 Node。命令列不拼入設定值，也不使用 env/printenv 印出環境。若現有父程序沒有配置，維持 SKIP，等待 PM 的記憶體注入，不另找設定來源。
