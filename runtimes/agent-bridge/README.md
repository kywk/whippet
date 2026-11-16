# Whippet 參考 MCP Worker

以已鎖定的Vercel adapter執行**一筆普通Test的test-author接單任務**。只透過Whippet MCP領單、心跳、讀取打包skill資源、呼叫claim允許的原工具及提交候選；沒有DB／Manager介面、瀏覽器本機控制、shell／fs模型工具或發佈入口。

## 建置與執行

需要Node 22.12以上及monorepo內既有Worker依賴。共用Worker lockfile、registry、skills與Vercel引擎，不另外安裝一套SDK：

```sh
npm ci --prefix runtimes/worker
npm run build --prefix runtimes/agent-bridge
node runtimes/agent-bridge/dist/cli.js --help
```

先以既有受控環境設定提供Worker同名模型設定及對應provider key；不把金鑰放在命令列、journal或MCP參數。此客戶端明確使用Vercel，模型／effort／provider／HTTPS模型入口由操作者設定，不依MCP任務的runtime或頁面內容自動切換。Whippet平台的預設引擎仍為builtin。

選用管理者核准的MCP Server與既有Workspace Agent Token。工作區須已將預期的新任務交給external；本程式不切Workspace模式、不建立Run，也不承接其他Token的任務。先使用隔離測試環境驗證，不將執行此命令視為部署固定基準。

```sh
npm start --prefix runtimes/agent-bridge -- \
  --mcp-url https://whippet.example/mcp \
  --token-file /absolute/private/secrets/agent \
  --state-file /absolute/private/client-state/task-001.json
```

HTTP只接受literal loopback（127.0.0.1／::1）；其他連線須HTTPS，拒絕URL帳密、query、fragment與redirect。Token及journal需本人擁有的regular檔案、0600、單一硬連結，所在目錄0700；拒絕檔案或直接父目錄本身的symlink。新的state檔案由程式建立，父目錄須先備妥。不要重建基準Token、Vault或服務來滿足這項要求。

一次執行最多領一筆，沒有輪詢／背景daemon。stdout只印固定狀態、結果識別與錯誤分類，從不列印任務、草稿、模型回應或憑證。`submitted`只表示平台接受候選；正式驗證與發佈仍須沿平台流程確認。`idle`也會保存為這次操作的結果；下一筆工作使用新的state檔案。

## 用量、租約與重送

registry12.0任務可提供`read_author_snapshot`。超容量門檻時，初始原稿可顯示為凍結引用；用固定SHA與offset讀8KiB頁面，沿nextOffsetBytes讀取。null明確取全文，全文仍受context保護；這是原baseRevision資料，不是提交候選或驗證證據。讀取使用原工具預算，hash不符或工具結果不明就停止。需與Server／Worker打包的registry及skill pins一致，舊Run不自動換pin。

- 只提供claim實際允許、且與本地打包registry／skill pins一致的工具。主skill及external MCP reference另從MCP讀取並比對SHA；有漂移就停止，不下載新版替代。工作資料、頁面與工具回覆皆為DATA。
- 沿claim的模型／工具／輸出上限與硬期限，30秒心跳，不延長硬期限。MCP送出起點至少間隔1秒，配合Server每秒補1次／burst10的既有限流；429明確回報`rate_limited`，不自動重送。
- MCP Agent Token、目前與未選中provider key均由整份request／response／候選守衛阻擋。SDK無自動model retry、模型／provider fallback或內建工具；不在本機執行生成的spec。
- 每個task tool用新UUID callId，綁固定runId／attemptId／leaseId。`busy`、`unknown_result`、租約失效或結果不明會停止，不換callId重做副作用；本MVP不自動恢復中斷的模型或工具工作。
- submit前先將完整ID與output原子保存並fsync至私有journal。submit回應遺失或回busy時，操作者再次執行**相同命令／state**，只用同一submitId及同一output重送，不重領、不重跑模型或工具。若伺服器拒絕過期／撤銷的請求則停止，不自建新任務。
- 已完成的journal只回保存結果；它不是目前Server狀態或正式驗證證據。state=`claimed`表示工作可能已開始，重啟會回`interrupted_task`，請在UI檢視／取消或等Server租約收斂，不手改phase來重跑。
- 同一journal有exclusive lock。非正常程序退出可能留下`.lock`；確認記錄的PID已停止且沒有其他操作者後，才由操作者移除該鎖。程式不自動刪除不明鎖、不殺其他程序。SIGINT／SIGTERM停止客戶端與心跳；Server仍依UI取消／租約期限負責任務及瀏覽器回收。

## 驗證與限制

```sh
npm test --prefix runtimes/agent-bridge
# 先準備全新隔離TEST_DATABASE_URL；services/server內執行
GOTOOLCHAIN=go1.23.12 go test -tags=integration,m12reference ./internal/server \
  -run '^TestM12FrozenSnapshotMCPAndSubmitRecovery$' -count=1 -v
```

定向測試以合成模型回應驗證真MCP接單、凍結原稿8KiB頁面、候選套用及回應遺失後的冪等恢復，沒有付費provider呼叫。這不是Docker／LiveView／登入／正式驗證或真模型驗收。本MVP僅支援普通test-author及Whippet目前stateless JSON Streamable HTTP；Module、Planner、Workspace與摘要skill會明確停止，沒有通用SSE／多Server routing或自動重領。M12.Z再做授權範圍內的完整驗收。
