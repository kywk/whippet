# Runtime M6、M5 與既有交付

更新：2026-11-11（Asia/Taipei）。Owner：Runtime Agent。

## PM 最終隔離整合回報

PM t35 回報 M5／M6 隔離功能整合 **最終 PASS**：

- M5 Workspace 設定的相對 URL 已完成驗證、發布與正式 Run，結果 succeeded。
- M6 真失敗 Run `86d6fe61-ebf4-4c67-b4a4-2898de9d1225` 保存 ZIP **12,931 bytes**／MD **1,145 bytes**；API 與 UI 下載 hash 一致。
- 本機 show-trace 從根入口載入真實 Set content／toHaveText／error-context；HTML 顯示 **Failed 1／Passed 0**，詳細內容正常，HTTP／pageerror／CSP 錯誤皆 **0**。先前 Viewer 失敗是 PM 手拼 URL 錯誤，產品未因此修改。
- 證據：`/private/tmp/whippet-m6-download-evidence`。隔離服務、網路與 Viewer 已關閉；**原共用服務未更新，未 commit／push**。

以上為 PM 執行與回報的整合證據。本 Agent 本輪僅更新此交付紀錄，未重跑測試、修改程式或操作服務。下方「待 PM 整合」為交付當時的歷史狀態，以本節最終回報為準。

## 最新 M6：失敗 ZIP／Markdown 證據（隔離真實 fixture 已通過）

PM t35 已透過正常 approval 完成下方隔離容器驗證：**exit 0，1 test PASS、無 skip**。真失敗 fixture 的 result 為 **failed**，產生 ZIP／MD／PNG 且 hash 檢查通過；成功 fixture 為 **succeeded**，沒有 ZIP／MD。證據分別位於 `/private/tmp/whippet-m6-runtime-evidence/m6-fail-FrFz99` 與 `/private/tmp/whippet-m6-runtime-evidence/m6-pass-1mJ5fo`。這是 PM 執行回報，本 Agent 不重跑；完整 Server／Manager／Worker→Web 下載整合仍由 PM 接續，不將隔離 fixture 視為整條產品流程已驗收。

M5 後續實跑已由 PM t35 確認 **exit 0**：live **2/2**（decoded frames 3、1280×720 斷言、JPEG、停止 helper 後原頁繼續），workspace **3/3 無 skip**（relative／legacy 都 succeeded）。證據 `/private/tmp/whippet-m5-runtime-evidence`；不再重跑 M5。

M6 依 `contracts/mvp-v6.md`，只改原 owner 目錄，沒有新增套件、模型呼叫、部署、共用服務重啟、Git 或 docs／contracts 修改。Manager／Worker 的控制與媒體協定未變。

| 產物／接縫 | 實作 |
| --- | --- |
| `runtimes/worker/src/runner.ts` | trace=`retain-on-failure`、retries=0、video=off；HTML reporter noCopyPrompt=true，對應 env 固定為 1；先匯出可選證據，再沿用原生 PNG／HTML 與成功門檻。 |
| `src/failure-artifacts.ts` | 匯出原生 HTML data/<sha1>.zip/.md；HTML 缺失時只從本次 output/test-results 尋找 trace.zip／error-context.md，不製造證據或仿製報告。深度最多 4、總掃描最多 2048 entries；拒絕 symlink／非 regular file、檢查內容 SHA1。依內容／副檔名去重，配額滿即停止。 |
| 配額／格式 | ZIP 每檔 64 MiB，MD 1 MiB，兩者合計 32 檔／128 MiB，PNG 原配額獨立。ZIP **只接受 PK0304／PK0506**，明確拒絕 PK0708；MD 嚴格 UTF-8。全程不解壓 ZIP、不執行內容。無效／超限僅固定原因警示，不印檔案內容或原始錯誤，不改原斷言結果。 |
| `src/report-artifacts.ts` | PNG data 目錄允許與可選 ZIP／MD 共存；PNG 本身的嚴格驗證與先圖後 HTML 規則不變。 |
| Manager `failure_evidence.go`／`artifacts.go`／`author.go` | 只讓普通 run／validation 接受 data/<40hex>.zip/.md；os.Root、regular file、大小／SHA1／格式重驗。ZIP application/zip、MD text/markdown; charset=utf-8，排在 report.html／results.json／result 前上傳。author 仍只接受 author.json。 |
| Manager `journal.go`／`manager.go` | journal 白名單／32 檔限制；recovery 上傳前重驗可選配額／有效性。**僅可選 ZIP／MD 且明確 HTTP 413** 才移除該 journal 上傳項並持久化固定 http_413 警示，保留原 result；network／5xx／401／409 及必要報告／PNG 均沿用原處理。不因補送或略過重跑 Worker。 |
| skill／README | 沿用 writing-for-agents 的精簡能力說明：失敗 trace／MD 自動留存下載、trace 以本機開啟；沒有內嵌 viewer，影片仍不支援。技能檔／mock 一併更新，未呼叫模型。 |

實際檢查：

- 正式 `npm run build`：PASS，最新 dist 已更新。
- `node --test dist/failure-artifacts.test.js dist/report-artifacts.test.js`：**4/4 PASS**。涵蓋 native／fallback 去重、HTML 缺失但有既存證據、不掃其他任務、錯誤 signature（含0708）／UTF-8／hash／symlink／超限略過、32 檔，以及原 PNG 相對引用。
- `node --test --test-name-pattern='packaged Playwright authoring skill' dist/author/author.test.js`：**1 PASS**，實際 request capture 證明更新的下載／viewer 限制已載入；無 live 模型。
- Manager `go test -mod=readonly ./internal/manager -run '^TestM6' -count=1`：**4 tests PASS，0.656s**。涵蓋白名單／格式／symlink／per-file／32 檔／128 MiB／PNG 獨立配額、原斷言與必要報告門檻，以及 413 recovery 移除後完成 journal 不重跑，401／409／5xx／network／PNG／HTML 不可當 optional413 吞掉。
- Go build／既有 cache Linux arm64 交叉編譯 PASS：`/private/tmp/whippet-manager-m6`（靜態 ELF aarch64）。Worker 交付最新 `runtimes/worker/dist/` 與更新後 `skills/`。下列真實容器檢查已由 PM 代跑 PASS，詳見本節首段；本 Agent 未重跑。

### PM 一次隔離容器命令

**真失敗 spec：`runtimes/worker/examples/fail.spec.ts`**，可原樣用於之後 Server→Manager Run；內容是 page.setContent 加固定錯誤文字斷言，1 秒內真失敗。成功對照 `runtimes/worker/examples/pass.spec.ts`。兩者不用服務／DB／模型，沒有變更 scripts/test/fixtures 下的唯讀真實網站案例。

單一 cached image、唯讀掛 dist／examples，產物到 `/private/tmp/whippet-m6-runtime-evidence`。Node 測試內依序啟動真正 runner：失敗預期 exit 1／result failed，必須同時存在 ZIP／MD／PNG 與真 Playwright HTML；成功預期 exit 0／result succeeded，不能留下 ZIP／MD。檢查 hash、ZIP signature、MD UTF-8。失敗 Run 不會被包裝成 Playwright 成功；最外層測試 exit 0 僅代表上述預期都成立。

```sh
mkdir -p /private/tmp/whippet-m6-runtime-evidence
docker run --rm --pull=never --network bridge \
  --memory 1g --cpus 1 --pids-limit 256 --shm-size 256m \
  --mount type=bind,source=/Users/kywk/kywk/project/whippet/runtimes/worker/dist,target=/opt/whippet/worker/dist,readonly \
  --mount type=bind,source=/Users/kywk/kywk/project/whippet/runtimes/worker/examples,target=/fixtures,readonly \
  --mount type=bind,source=/private/tmp/whippet-m6-runtime-evidence,target=/tmp/evidence \
  -e WHIPPET_EVIDENCE_BROWSER_TEST=1 \
  -e WHIPPET_EVIDENCE_FIXTURES=/fixtures \
  -e WHIPPET_EVIDENCE_DIR=/tmp/evidence \
  --entrypoint node whippet-worker:m1 --test dist/evidence-runner.test.js
```

預期一項 test PASS／無 skip，console 兩筆 fixture status 分別 failed／succeeded。入口 `dist/evidence-runner.test.js`。PM 以正常 approval 執行一次，不需先改共用部署。

待整合：Server／Web 的列表與 ZIP／MD 下載端點、標頭／隔離／HTML CSP／外部入口由各 owner 接手；本 Agent 未放寬 CSP。HTML 的 trace 按鈕不宣稱可用，使用者下載後用本機 Playwright show-trace 開啟。fallback 不保證硬殺前未 flush 的檔案；可選證據缺少／略過不取代必要報告或改成成功。不新增影片、內嵌 viewer、任意附件框架或遠端環境矩陣。

## 最新 M5：細字清晰度與 Workspace 快照

此節優先於下方歷史紀錄。Owner 仍限 `services/manager/`、`runtimes/worker/`；未部署、未重啟共用服務、未安裝套件、未讀／印真實憑證、未呼叫模型、未執行 Git，未修改 docs／contracts 或唯讀的真實網站 fixture。Docker 診斷由 PM t35 透過正常 approval 執行，本 Agent 不重試 Docker。

### 畫質根因、參數與證據

以實際 Whippet 登入頁為來源，透過同一個 screencast／VideoHelper／RTP pipeline 取得 PNG、JPEG、canvas、接收 video 的 1:1 裁圖。獨立 receiver 在已載入的真實網頁 stylesheet／detail-panel 裡插入測試 panel，量測現有 CSS 的顯示尺寸；此步不是完整產品 WS／UI E2E。

| 項目 | baseline | 僅 contentHint=text 對照 |
| --- | --- | --- |
| 來源 JPEG／canvas／track | 1280×720，track 3 FPS | 相同 |
| VP8 outbound／inbound | **320×180** | **1280×720，3 FPS** |
| qualityLimitationReason／packetsLost | bandwidth／0 | none／0 |
| JPEG edge MAE | 16.1615 | 16.1615 |
| video edge MAE | **50.6215** | **16.4953** |
| 3 秒靜態樣本實際 bitrate | 2,194 bps | 69,108 bps |
| encoder targetBitrate（非實際吞吐） | 500,000 | 2,083,333 |
| viewer 1440／1280 viewport、DPR 1 | client 960×540／800×450，放大 320×180 | client 相同，從 1280×720 縮小顯示 |

已目視 baseline／text 兩組 referenceCrop、jpegCrop、videoCrop：baseline video 細字失去可讀性；text video 接近原 JPEG。edge MAE 是相對同一原始 PNG 邊緣像素的平均誤差，越低越好；不是通用知覺品質分數。證據由 PM 執行產生於 `/private/tmp/whippet-m5-quality/{baseline,text}/summary.json` 與裁圖，本 Agent 唯讀分析，不將它們當成自己執行的 Docker 測試。

production 修正只有 `src/live/helper.ts` 在 `pc.addTrack` 前設定 `track.contentHint = "text"`。**沒有設定或提高 bitrate、JPEG quality、解析度、FPS、canvas 尺寸、CSS；沒有改 JPEG／popup 選頁／viewer 停止與 Run 生命週期。** W3C 的 [text content hint](https://www.w3.org/TR/mst-content-hint/#video-content-hints) 明確適用於網頁文字，應優先保留細節，符合實測根因。

新增 `src/live/quality-check.ts` 為手動隔離診斷入口，輸出受限 stats 與圖片，不印 SDP／ICE credentials 或建立 Run。`--hint=` 可重現空 hint baseline，`--hint=text` 作單變數對照，省略使用 production。既有 live browser smoke 已加入接收端必須 1280×720 的 regression assertion；正式 build 通過，production 真 RTP regression 由 PM 依下方單容器命令執行一次。DPR 2、動態高負載與受限頻寬未做本輪矩陣驗證，不宣稱所有網路都不會降畫質。

### v5 設定接線

- Manager `protocol.go`／`workspace.go`／`author.go`／`manager.go`：dispatch／Worker input 頂層 optional `workspaceSettings`，依 v5 驗證非機密欄位與界限，使用 json.RawMessage 保留原快照；run／author 都透傳，不讀 Workspace API、不重新取目前設定。未知設定欄位、userinfo、非 HTTP(S) 等拒絕，錯誤不回顯輸入。舊 dispatch 缺欄位時仍接受且不補造快照。
- Worker `src/workspace.ts`：共用快照驗證，舊 input 可省略；不正規化或覆寫任務設定。`runner.ts` 僅在非空 defaultTestUrl 設 Playwright project use.baseURL，空或缺欄位保持舊行為；不自動 goto、不注入 env。執行 timeout 仍用既有頂層 timeoutMs。
- author `types.ts`／`loop.ts`：同一頂層快照驗證後放進最初 Saved draft snapshot JSON，後續 request 沿用該固定資料；system 明示設定是 DATA、不得覆寫使用者目標或因設定自動導覽。網站清單／預設 URL 可供產稿參考，非空預設 URL 告知將成為獨立 runner 的 baseURL。author timeout 仍最多 180000，不被 workspace timeout 3600000 覆寫；不增加工具／模型呼叫或直接執行 spec。
- `examples/workspace-relative.spec.ts`：容器內短暫 127.0.0.1:18765 固定 HTML server，snapshot baseURL=/base/，真正 `page.goto('probe')` 必須到 /base/probe，並產一張 PNG；不需共用服務、DB 或模型。`examples/legacy-input.spec.ts`：缺 workspaceSettings 時 baseURL 必須 unset。

### 實際檢查與交付

| 檢查 | 本輪實際結果 |
| --- | --- |
| Worker `npm run build` | PASS，最新 dist 已更新。 |
| `node --test dist/workspace.test.js` | 2 passed／1 browser fixture skipped／0 failed；快照合法性、原樣回傳、舊欄位缺省與固定錯誤。 |
| `node --test --test-name-pattern='^M5 Workspace' dist/author/author.test.js` | 1 passed；兩次 mock request 捕捉固定 JSON、DATA 指示、不自動導覽、author 180000 與缺欄位相容，沒有模型連線。 |
| Manager `go test -mod=readonly ./internal/manager -run '^TestM5' -count=1` | 2 tests PASS，0.412s；run／author 新舊 input、RawMessage 原樣、未知欄位／userinfo拒絕、author timeout 不改。 |
| Manager Linux arm64 build | PASS，`/private/tmp/whippet-manager-m5`，ELF aarch64 靜態連結；既有 cache、GOPROXY=off、GOSUMDB=off、-mod=readonly。 |
| PM 已代跑畫質 baseline／text | 都產出實際 stats／PNG，text 對照 1280×720 通過；不是新 production 的全量驗收。 |
| 下列 production RTP／runner 固定 fixture | **PM 已代跑 PASS／exit0：live2/2、workspace3/3 無 skip**；證據 `/private/tmp/whippet-m5-runtime-evidence`。 |

交付映像資產：最新 `runtimes/worker/dist/`、既有 `skills/`；Manager binary 如上。正式 Dockerfile 本輪未改，未使用新 SDK／依賴。正常編譯原始碼分別由各 owner 的既有 Dockerfile 處理；本 Agent不部署。

### PM 單容器最小驗證命令（本 Agent 未執行）

使用既有快取 `whippet-worker:m1`，唯讀掛最新 dist／examples，產物只到 `/private/tmp/whippet-m5-runtime-evidence`。先 RTP regression，再相對 goto／PNG 與 legacy fixture；短暫 HTTP server 在同容器，無共用服務／DB／模型需求。PM 依正常 approval 執行一次即可，無須先重建或部署共用映像。

```sh
mkdir -p /private/tmp/whippet-m5-runtime-evidence
docker run --rm --pull=never --network bridge \
  --memory 1g --cpus 1 --pids-limit 256 --shm-size 256m \
  --mount type=bind,source=/Users/kywk/kywk/project/whippet/runtimes/worker/dist,target=/opt/whippet/worker/dist,readonly \
  --mount type=bind,source=/Users/kywk/kywk/project/whippet/runtimes/worker/examples,target=/fixtures,readonly \
  --mount type=bind,source=/private/tmp/whippet-m5-runtime-evidence,target=/tmp/evidence \
  -e WHIPPET_LIVE_BROWSER_TEST=1 \
  -e WHIPPET_WORKSPACE_BROWSER_TEST=1 \
  -e WHIPPET_WORKSPACE_FIXTURES=/fixtures \
  -e WHIPPET_WORKSPACE_EVIDENCE_DIR=/tmp/evidence \
  --entrypoint sh whippet-worker:m1 -c \
  'node --test dist/live/live.test.js && node --test dist/workspace.test.js'
```

預期：live tests 2 passed（含 decoded video 1280×720），workspace tests 3 passed（第 3 項內真正 runner 執行 relative／legacy 各一次）。console 顯示兩筆 fixture succeeded；relative 產物含 report.html、results.json、result.json 與一張 data/<sha1>.png，legacy 同樣有真 Playwright 報告。

待整合：Server／UI 套用 v5 快照後，由 PM 排一條主要設定→草稿→驗證／發佈流程；舊 queued Run／Version 固定快照與衝突交易屬 Server owner。真實網站操作與 popup／JPEG／停止監看的既有 M4 驗收沿用，不在這批重做；新清晰度的可見 demo 由 PM 選時整合。本批不接 M6 trace／Markdown 實作。

## 最新 M4 交付（此節優先於下方歷史紀錄）

最新整合回報：Docker viewer 在同 bridge 已走完整 UI，真 video 幀 1→2、手動 JPEG 可顯示且更新、停止監看後 Run 仍 running。Mac native 原先未收到 video，自動 JPEG 成功，驗收正確判 failed。總指揮代取原 helper offer 僅一筆 UDP host `.local` mDNS candidate、無 numeric host；現只在 `src/live/helper.ts` 的 ephemeral sender launch 加入 `--disable-features=WebRtcHideLocalIpsWithMdns`。**最新 Worker 正式 build 通過、dist 已更新；numeric candidate 與 Mac native 真 video 尚待總指揮驗證。Manager／Linux binary 未變，不需重建。** 沒有改觀看端或被測 browser 設定，沒有加入 TURN／依賴。

只修改 `services/manager/`、`runtimes/worker/`，依 [M4 契約](../../contracts/mvp-v4.md)。沒有安裝套件、執行 Git、讀 env 檔案／實際 key、呼叫模型或增加依賴。原有 1 GiB／1 CPU／256 PID／256 MiB shm 限額維持。

| 產物 | 位置與狀態 |
| --- | --- |
| Linux arm64 Manager | `/private/tmp/whippet-manager-m4`，ELF aarch64 靜態連結，10,203,371 bytes；既有 cache／`-mod=readonly` 交叉編譯 exit 0。 |
| Worker dist | `runtimes/worker/dist/`，正式 TypeScript build exit 0；含 live/files、helper、observer、fixture-bridge 與最小測試。 |
| Worker skill | 保留既有 `skills/`，衍生映像須與 dist 一起保留；M4 未改 AI loop 或技能。 |

實作接縫：

- `src/runner.ts`／`src/live/fixture-bridge.ts`：保留原始完整 spec，以任務 tsconfig paths 攔截 `@playwright/test`，將 named／default test 導向擴充 browser fixture。原始 API 從 `playwright/test` 載入，避免 alias 遞迴；不強制 API-only 測試開 browser。
- `src/live/observer.ts`：觀察 fixture browser 的既有／新 context、page／popup，選最近建立且存活的 page。author 直接掛既有探索 browser。有效租約才啟動 screencast；無 page 為 waiting；租約到期或 mode 改變時停止／切換。操作與關閉有短期限，例外遮蔽為固定 media_failed，不變更 Run result。
- `src/live/helper.ts`：獨立無金鑰 Chromium 將 JPEG 畫入 canvas，透過 `canvas.captureStream(3)` video track／RTCPeerConnection 輸出真 RTP video；沒有 DataChannel、模型生成程式或對被測網站導航。non-trickle offer／answer 最多等 ICE gathering 8 秒；只有 viewer 可確認影像已可播放，不將 peer setup 當成成功串流。
- `src/live/files.ts`：受限 regular file／大小讀取、原子 rename；helper env 只含必要瀏覽器白名單，排除 Manager token／AI key。
- Manager `live.go`：`live.start/stop` viewerId 去重／匹配停止；媒體 WS 主動連線 `/api/manager/runs/:runId/live?attemptId=...&viewerId=...`，Bearer 只存在 Manager header。與任務控制 WS 分開，incoming 佇列 8 筆、write deadline 3 秒、每 10 秒 ping／35 秒 read deadline；Server 已由總指揮協調回 pong。
- Manager 經任務 bind 目錄 `live/control.json` 每 5 秒原子續租，expiresAt 為 Unix 毫秒、有效 30 秒，包含 viewerId／mode／iceServers／answer。Worker state.json 含 viewerId／state／transport／offer；最新影格為 `<viewerId>.jpg`。Manager 每 100 ms 只讀最新檔案：JSON 192 KiB、SDP 128 KiB、JPEG 1 MiB，os.Root／regular file／固定名稱檢查；慢 viewer 不累積舊影格、不阻塞 heartbeat/cancel。離線與停止會將 expiresAt 改 0。所有媒體暫存不進 input／journal／report／log。
- Manager `manager.go`：prepare 建立 live 子目錄；Worker 執行結束時停止媒體，仍沿用既有確認容器回收／附件上傳／終態流程，不改 MAX_WORKERS 或同 attempt 不重跑規則。新 viewer 等舊 media 清理後接手，遲到的舊 stop 不會取消新 viewer。

實際檢查：

1. 本 Agent：`npm run build` 通過。離線 `node --test dist/live/live.test.js` **1 passed／1 browser test skipped／0 failed**；驗租約到期、大小與 helper env 白名單。沒有假稱 skipped browser test 成功。
2. 本 Agent：真正呼叫 Playwright CLI `--list`，任務 tsconfig path mapping／產生的 bridge 成功註冊 named import 與 default import **2 tests**；沒有啟動 browser 或聯網。完整擷取 fixture 整合待下一步。
3. 總指揮代跑既有 Worker 映像、正常 Docker default bridge 的 `WHIPPET_LIVE_BROWSER_TEST=1 node --test dist/live/live.test.js`：**2/2 passed，真正 RTP video framesDecoded=3、jpegCaptured=true**，約 2.7 秒；關閉 helper 後原測試頁可繼續。第一次 network=none 沒有有效 ICE candidate 而失敗（framesDecoded=0），已定位為測試網路配置，不據此改程式或冒稱成功。
4. 本 Agent：Manager `go build -mod=readonly ./...` 與 Linux arm64 交叉編譯通過。`TestLive` 最小 race 因 sandbox bind 被拒，總指揮已代跑相同命令，**PASS／無 race，1.343s**；不再重跑。涵蓋舊 viewer stop、防止 token 寫到 control、WS JPEG、disconnect 撤銷租約、媒體不改任務狀態，以及 symlink／大小拒絕。

```sh
GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
GOCACHE=/private/tmp/whippet-manager-go-cache \
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
go build -mod=readonly -trimpath -o /private/tmp/whippet-manager-m4 ./cmd/manager
```

總指揮接續：使用上述 binary／最新 dist 衍生既有映像，保留 skills。以 45 秒受控頁驗 fixture→Manager media WS→UI video、JPEG 切換、關 viewer 後停擷取且 Run／PNG 正常完成；author observer 尚未做模型 live（本輪禁止模型呼叫）。Worker 沒有新增外部 port 或 task input 欄位。Docker helper loopback 已證明真 video 路徑，**不代表完整 UI／Mac 原生／跨網／TURN 已驗收**。

限制：獨立自行 launch／connect 的 browser process、繞過 `@playwright/test` bridge 的匯入不保證觀察；目前選最近存活 page，沒有換頁 UI、音訊或遠端操作。TURN 只完成設定接線，未用真 TURN 實測。helper 增加一個 Chromium，既有限額是否足夠由整合確認，尚未擴大限額。即時 video 並不增加 trace／video／Markdown 報告附件支援；PNG 附件管線未變更。

**PNG 管線已交付並部署；總指揮回報 4 個 Whippet 真實驗收案例的報告 9 張 PNG 全部通過，案例 01 revision 4 已修正過場並經目視確認。** M3 先前已完成同對話 read_validation_report 修復、revision 3 validation 成功、confirmed 發佈及 UI／key 隔離驗收。結果以總指揮的 [M3 整合紀錄](../../docs/tracking/devlog/m3-integration.md) 為準；本 Agent 不呼叫模型或重跑上述驗收。

## 本輪 PNG 交付（此節優先於下方 M3 基線紀錄）

- Worker `src/report-artifacts.ts` 將原生 `html/data/<sha1>.png` 複製為 `output/data/<sha1>.png`，全部成功後才輸出 report.html，不解析 HTML ZIP、不改寫報告。
- Runner 預設 screenshot only-on-failure，成功步驟用 spec 的 testInfo.attach 手動附加 PNG；trace／video 關閉且仍不支援附件上傳。
- Manager `screenshots.go`／`artifacts.go`／allowlist／journal 支援 `data/[0-9a-f]{40}.png`。10 MiB／張、最多 32 張／64 MiB 合計；只接受 regular file／directory，Root 限制路徑、拒絕 symlink／traversal，檢查 PNG header 與 SHA-1 內容。
- 上傳順序為全部 PNG → report.html → results.json → result。圖片收集不合法會 failed 且扣住 HTML；上傳失敗保留檔案／journal 補送，不宣稱成功。author 不接受 PNG。
- Server owner t31 已配合 POST／GET `.../artifacts/data/<hash>.png`、image/png 與必要報告存在檢查；PNG 不計入原本「兩份必要報告」數量，不改 Server terminal-and-absent 名額規則。
- skill 已改為 testInfo.attach 成功步驟 recipe，保留 trace／video 不支援的描述。README 已移除 screenshot off／未上傳／Docker 尚未驗證等過時說明。

交付供既有映像衍生 COPY：

| 產物 | 位置／說明 |
| --- | --- |
| Manager binary | `/private/tmp/whippet-manager-screenshots`，ELF Linux arm64、靜態連結，10,115,690 bytes。 |
| Worker 編譯輸出 | `runtimes/worker/dist/`，含最新 runner.js、report-artifacts.js。 |
| 技能資產 | `runtimes/worker/skills/`，須與 dist 一起 COPY 到既有 Worker 映像。 |

本 Agent 實際檢查：正式 npm build 通過；PNG 匯出測試 1 項、Manager 截圖測試 3 項、更新後 skill mock capture 1 項均通過。測試涵蓋原生相對路徑、先圖後報告、MIME／attempt、regular file／symlink、檔名／數量／大小限制與失敗扣住 HTML。未重跑既有 8 個 author mock／全量 E2E。

Linux binary 使用既有快取交叉編譯，exit=0：

```sh
GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
GOCACHE=/private/tmp/whippet-manager-go-cache \
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
go build -mod=readonly -trimpath -o /private/tmp/whippet-manager-screenshots ./cmd/manager
```

總指揮部署後首筆 Run `04152970-718a-4b66-a752-8555224d42c0` succeeded／published，真 Chromium HTML 報告 3 張 PNG 全載入且零 CSP／HTTP 錯誤；後續回報 4 案例／9 PNG 通過。這些是總指揮回報的整合證據，不是本 Agent 的 live 測試。案例 01 最終 Run `8cd30023-c743-4aa6-a6ee-12332692d865` 已通過、發佈且目視確認；本輪依使用者限制不執行 Git 操作。

## 產物與邊界

| 範圍 | 變更 |
| --- | --- |
| Manager `protocol.go`、`author.go` | 接受 kind author、baseRevision／conversation／messages，白名單環境傳遞與固定進度格式。author timeout 最多 180000 ms；對話最近最多 12 則／總 32000 字元。 |
| Manager `manager.go`、`journal.go` | 持久化 kind 與必要快照；author 共用既有 MAX_WORKERS、ACK、取消 context、回收確認、heartbeat、重連及同 attempt 去重。舊 journal 的空 kind 視為普通 run。 |
| Manager `docker.go` | author 以同一映像的 `node dist/author/main.js` 啟動；run 保留原 CMD。只有 author create 使用 `--env NAME` 白名單，值不放在 argv。普通 run 的 Docker CLI 環境亦移除 AI 設定／key。 |
| Manager `artifacts.go` | author 成功只接受 author.json（2 MiB），不要求 Playwright 報告；普通 run 只接受原本兩份報告。author 失敗不補傳候選，錯誤固定遮蔽。 |
| Worker `src/author/types.ts` | author input／output、上下文界限、固定遮蔽錯誤。 |
| Worker `src/author/loop.ts` | 原生 Responses function calling、最多 8 requests／12 tools／180 秒；無 retry、payg fallback、previous_response_id 或持久模型狀態依賴。 |
| Worker `src/author/tools.ts` | 8 個必要工具（含 read_validation_report）、HTTP(S) 探索、文字 aria snapshot 與 bounded selector hints；無任意 shell／eval 工具。瀏覽器 subprocess 不繼承 AI key。 |
| Worker `src/author/main.ts` | 獨立入口、SIGTERM／timeout、最後寫 author.json／result.json；不執行模型生成的 spec。只印固定進度。 |
| Worker package／README、Manager README | 新增 npm author／test:author 入口與串接文件；沒有新增 SDK 或相依套件。 |
| `author_test.go`、`src/author/author.test.ts` | Manager kind／環境／附件／名額／取消測試及 Worker 工具續接、界限與遮蔽測試。 |

所有修改限於 `services/manager/`、`runtimes/worker/`。未安裝套件、未讀 `deploy/.env.ai`／任何真實 key、未讀全域 provider 設定、未呼叫模型、未執行 Git。本 Agent 不執行 Docker／live；總指揮負責部署。

## 固定介面

- 沿用 [M3 契約](../../contracts/mvp-v3.md)，沒有要求新增 artifact schema。input 加 kind／author；journal 保存 kind，不含 AI 設定或 key。
- Manager 專用環境白名單為 `WHIPPET_AI_ENABLED`、`WHIPPET_AI_BASE_URL`、`WHIPPET_AI_MODEL`、`WHIPPET_AI_REASONING_EFFORT`、`OPENCODE_API_KEY`，只給 author 容器。一般 run／validation 不注入。部署 overlay 由總指揮維護。
- 模型 endpoint／model／User-Agent 沿用既有 Responses 設定，`x-opencode-session=conversationId`；reasoning 使用 `config.reasoningEffort`（預設 xhigh），沒有硬編碼破壞替換設定。
- 函式為原生 `type:function` schema，工具回覆為 `type:function_call_output`，以 call_id 配對；完整保留 reasoning／function_call 等 output items。採 `store:false`、`include:["reasoning.encrypted_content"]`，不使用 previous_response_id。依 [官方 function calling](https://developers.openai.com/api/docs/guides/function-calling) 與 [stateless reasoning](https://developers.openai.com/api/docs/guides/reasoning)；Go provider 的 live 相容性仍以總指揮驗收為準，不自動降級格式或切換端點。
- `read_draft` 讀目前候選、`update_draft` 只替換記憶體候選；`request_validation` 只回旗標。成功輸出 `{message,script?,requestValidation}`，由 Server 回收後交易套用／衝突保留／另排 validation。author 不執行生成 spec、不等待 validation，也不自動發佈。
- 既有 run／validation 的報告成功門檻未削弱。author 成功只檢查 author.json；普通 run 不得上傳該檔。Server 依 kind 保存／讀取附件，由 Server owner 實作。
- 進度沿用 log event，只轉送 `author:model:<序號>:<started|succeeded|failed>`、`author:tool:<序號>:<固定名稱>:<succeeded|failed>`。不包含工具參數、DOM、provider body、模型原文或 key；其他 author stderr 全部遮蔽。

## 最新 selector 修正

總指揮回報第一次真實 author：navigate 成功，但 aria snapshot 缺乏 CSS 資訊，fill／click 各猜錯一次並額外讀 snapshot，導致第 8 次 request 更新候選後達 limit；草稿未套用，符合失敗保護。

已針對此根因修正，**沒有增加 8 requests／12 tools 預算**：

- navigate／click／snapshot 回傳最多 30 個 input／button／link／textarea／select 的 selectorHints：tag、id、name、type、文字及可用 CSS selector；不讀 input value。
- 優先產生唯一 id／name selector，否則固定程式產生完整 nth-of-type CSS 路徑。DOM 擷取程式固定，沒有模型可提供程式的 eval 工具。
- schema 明確要求 literal CSS／text= selector，禁止傳入 page.getByRole(...) 這種 JS 表達式。
- 指示 navigate／click 已回 snapshot／hints，避免無謂再讀 snapshot 消耗模型回合。

此修正後只執行必要正式 build，**exit=0**；未自行重試模型。Manager 未因 selector 修正變動，最新修正只需重建 Worker。總指揮尚未回報修正後 live 結果。

總指揮後續回報：selector 修正後 author **6 requests／5 tools 全成功**，但產生的 spec 使用不正確的 listitem accessible-name 斷言，獨立 validation 真實失敗；沒有弱化發佈門檻。為支援同對話修復，依更新後 M3 契約新增：

- `author.validation?:{runId,status,error?}`，Manager 轉傳、Worker 驗證；error 最多 4000 字元，沒有快照可照常執行。
- `read_validation_report` 只回這份快照，無值回 `{status:"none"}`；不讀任意 report、不執行 spec、不同步等待 validation。
- system 提醒修復時讀取摘要，仍把摘要當資料；進度白名單加入該固定工具名稱。8 requests／12 tools／180 秒上限不變。
- 正式 build 通過；受影響 Worker mock **3 passed**（stateless 續接、輸入邊界、optional validation 修復），Manager `TestM3AuthorOptionalValidationSnapshot` 通過（0.322s）。沒有重跑全套或自行呼叫模型。

**這個 validation snapshot 修正同時改動 Manager 與 Worker，兩個映像皆須重建**。總指揮接續目前 test 的同對話修復，不必重跑第一輪生成。修復後 live 驗證結果尚待回報。

## 實際檢查

1. Worker `npm run build`：正式 TypeScript 編譯／型別檢查通過；加入 selector hints 後再 build 一次亦通過，最後一次 exit=0。
2. Worker `npm run test:author`：**6 passed、0 failed、exit=0**（selector 修正前，工具續接與界限核心未改動）：
   - 8 個 mock response 走完 read／navigate／snapshot／fill／click／update／validation／final，候選只回傳、不執行。
   - stateless encrypted reasoning 與 call_id 回傳、相同 conversation session、reasoning effort 使用設定值。
   - 8 requests／12 tools 上限、缺 key／停用、401／429 不重試、secret echo／raw error 遮蔽。
   - 整輪 timeout／取消、非 HTTP(S) 與未知 eval 工具拒絕、可只回提問而無候選稿。
3. Manager `gofmt -w internal/manager` 完成；M3 focused race 檢查 **4 項測試通過、exit=0**：

   ```sh
   GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
   GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
   GOCACHE=/private/tmp/whippet-manager-go-cache \
   go test -race -mod=readonly ./internal/manager -run '^TestM3' -count=1
   ```

   結果：`ok whippet/services/manager/internal/manager 1.606s`。涵蓋 author 白名單與獨立入口、普通 run 不注入 key、input／journal 無 AI 設定、kind 對應附件、author 共用名額／取消回收／去重，以及固定進度白名單。
4. 加入 author kind 後，既有 `TestManagerDispatchDedupAndCollectionOrdering` focused 檢查通過（0.380s）；沒有重跑 repo 全量、M1／M2 E2E 或無關 AI probe 測試。

以上均使用合成假 key／fetch／容器 driver；不是本 Agent 的真實模型或 Chromium 驗收。

## 總指揮接續

1. 最新 validation snapshot 修正需重建 Manager／Worker，請更新兩個映像後續接目前 test 的修復；不重跑第一輪。
2. 使用合成站 `http://host.docker.internal:18082`，不新增 Worker network 設計。驗收 navigate→fill→click→update_draft→request_validation，從固定進度確認動作。
3. 核對 author.json 上傳後的 baseRevision 交易套用／衝突、冪等 result，以及回收後才建立普通 validation。確認 validation 容器沒有 key。
4. 真實完成同對話修改→驗證成功→人工發佈→重開對話；未完成前不將 M3 標為完成。

等待總指揮整合結果，提交由總指揮負責。

PNG 以外附件仍有限制：額外失敗範例的自動截圖可見，但 `error-context.md` 未上傳且讀取會遭 CSP 阻擋。完整檢查與限制見 [本機驗收指南](../../docs/guides/whippet-acceptance.md)。
