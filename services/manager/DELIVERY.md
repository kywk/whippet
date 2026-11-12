# Runtime M8 B 與既有交付

更新：2026-11-12（Asia/Taipei）。Owner：Runtime Agent t32，gpt-6.1-sol／xhigh。

## 最新修復波次：敏感監看暫停／恢復與 offerId 綁定

依 PM 在唯讀查核後新增的明確授權，僅修改 Manager／Worker；不跨 Server/Web owner。已交付 **`/private/tmp/whippet-manager-m8-mask`**（Linux arm64）及最新 **`runtimes/worker/dist/`＋完整 `skills/`**。本輪 skill 未變。觀測條件與修復前缺口記在 [whippet-m8-mask-runtime-note.md](/private/tmp/whippet-m8-mask-runtime-note.md)。**尚未執行真 slow-login UI／影像／重協商驗收，不以定向測試宣稱登入遮蔽 PASS。**

- `src/live/observer.ts`：tick、pause、resume、close 共用序列；pause 立即使 epoch/callback 失效，再排空在途 capture／atomic frame write、刪 JPEG／停止獨立媒體 helper。pause 完成後舊 callback 不能重建檔案，敏感期間新 viewer/control 仍會被讀取並得到自身 `waiting/sensitive_input`，不啟動 capture。保留已暫停旗標直到 serialized resume marker 寫完，避免 resume 排隊期間搶先擷取。短暫暫停只處理 screencast／keyless 媒體 helper，不取消測試或回收 Run 容器。
- Worker 對每個新 WebRTC helper/offer 產生 UUID `offerId`，只套用 `answerOfferId` 與本 offer 相符的 answer；重新讀取最新 control，不沿用 helper.start 前捕獲的舊 answer。pause/mode/viewer 變更停止前一代媒體，重新建立 offer。
- `src/live/files.ts`、login hook：新增有界 UUID `answerOfferId` 讀取；login finally 會 await resume，marker 寫好才繼續。resume 持續保留 `state=waiting/reason=sensitive_input_complete` 於該恢復 epoch（可同時含新 SDP/offerId），不做可能被 100ms polling 漏掉的短 pulse。JPEG 與 WebRTC 都先有 complete，WebRTC 再等 fresh offer／真影格；complete 本身不是 streaming 成功。
- Manager `live_binding.go`／`live.go`：安全 reason 白名單加入 `sensitive_input` 與 `sensitive_input_complete`。pause/mode 清 control answer/answerOfferId 與 active offer；同 viewer 保留 versioned／retired ID 狀態，拒絕晚到、退役或無 ID answer，不因晚到 WebRTC answer 中斷目前 JPEG。舊無 ID 只保留非敏感首次協商相容；見 ID 或進入敏感流程後不可降級。Manager 在同一媒體 WS 上**先送 complete state，再送新 UUID offer／JPEG**；pause 時即使磁碟有舊 JPEG 也不發送。
- Server 依當前 LiveSession 填公開 state.viewerId、保證 Messages/Frames writer 順序與舊 queue 清理，由 t31 負責；Web 的敏感鎖、current viewerId 比對、complete 前丟棄所有 offer、complete 後 fresh UUID／真影格解鎖，由 t30 負責。本 Agent 未修改這些檔案；三端須同步後再做 PM slow fixture 驗收，不能只部署 Runtime。

實際必要檢查：

1. Worker 正式 `npm run build` **PASS**；`node --test dist/live/sensitive.test.js` **3/3 PASS、0 skip**。使用真暫存檔案與可控制的 capture/helper，驗證 capture start／atomic write 與 pause 競態、pause 完成後 stale callback 無寫入、中途 viewer 正確 pause state、持續 complete 先於新 JPEG、WebRTC fresh UUID／拒絕舊或 untagged／mode前 answer。
2. Manager `go test -race -mod=readonly ./internal/manager -run '^TestLiveSensitive|^TestLiveMediaLeaseAndJPEGAreIndependent$' -count=1` **PASS，2.072s**，四項測試。binding 測試驗 complete→offer、退役 ID／降級／晚到 answer 拒絕及首次 legacy 相容；**真 loopback WS 媒體 wire** 驗 pause 阻擋已存在 JPEG、complete 必先於 binary，且晚到 answer 不停止 JPEG／Run；另驗既有正常 JPEG lease 生命週期。這是 Manager→Server wire 的測試，不是假稱已驗完整 Server 公開 writer／UI。只提升必要 loopback httptest 權限，沒有 Docker／部署。
3. Linux arm64 cross-build **PASS**：`/private/tmp/whippet-manager-m8-mask`，既有 Go cache／`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`／`-mod=readonly`／`CGO_ENABLED=0`，沒有下載依賴。

剩餘驗收：PM `/slow-login` 12秒ready／`/slow-session` 12秒延遲／登入後10秒進度；需要公開 WS 正確 viewer 的 pause/complete、核心敏感窗口無 fresh image、解碼像素無合成 known sentinel、恢復後兩個時點真正遞增影格與可讀非機密進度。JPEG與WebRTC各自判定，不以regex文案或late frames>0替代；敏感期中途加入另驗。不能把前節一般 manual LiveView PASS 擴充成此項已完成。

本輪無 Docker／部署／模型／安裝／Git／真秘密讀取，未重跑無關全量或前波直接 runner 案例。產物與 owner 程式固定，交 PM 整合後再依真失敗修復。

## 最新 wave：正常 API 真 resolve／正式 Run 已由 PM 通過

M8 A/B 已由 PM 提交 `6df86e6` 後，使用者授權下一波；本 Agent 未操作 Git。本波接線筆記：[whippet-m8-wave-runtime.md](/private/tmp/whippet-m8-wave-runtime.md)。採 PM 現有 `whippet-worker:m8b-wave`（固定 dist/skills＋公開 Node 測試 CA）、`whippet-manager:m8b-qa`；網站 `http://host.docker.internal:18187`、明示替身的 HTTPS Responses `https://host.docker.internal:18188/v1`、B Web/API 18087、真 Server TLS 18089。沒有新增 author env 白名單或略過 TLS。

PM 回報**正常 API 全鏈首切片 PASS**：Workspace author 走 HTTPS fixture 產提案→scope/apply→專用角色保存→manual `loginAs` validation→fixture summary→QA API明確發布→正式 Run。真 validation `b4129af8-3b4d-480d-aa10-33d228a27747` 與正式 Run `29f05216-0540-4909-a58e-0840efffd3a2` 均 succeeded、**expected1／unexpected0**；兩次真 DB resolved_role_ids 命中、slot_released=true；兩次 Manager journal credentialsUsed／credentialsSanitized／reclaimed=true、phase=complete，且無 Worker 殘留。證據 `/private/tmp/whippet-m8-wave`。

沒有 SQL 寫入、手改 journal、假 resolve 或測試程序注入 stdin；資料準備沿 t31 正常 API/provider fixture，不採筆記初版的 seed 前置。**只有提案／摘要是已標示的模型回應替身，Server HTTPS resolve／Manager interactive attach／Worker loginAs／原生報告與回收均是真實流程。** manual LiveView 真 UI 後續結果見下節；真 AI／Workspace author 與登入敏感輸入遮蔽仍待驗，不把此結果當 M8 全部完成。

本 Agent 本輪只唯讀核對接線、寫暫存筆記及 `runtimes/worker/examples/m8-wave-login.spec.ts` 最小範例；spec只含角色 ID，對齊 PM `/login`→POST`/session`，驗 Authenticated／alpha 與 cookie 布林，不印值、不假設不存在的 `/app`／stats。以既有 TypeScript `transpileModule` **語法轉譯檢查 PASS**，未執行該 spec、未稱完整 typecheck。原先未使用的重複網站入口已移除，沿用 PM fixture。正式 Manager/Worker、binary/dist/skills 沒有修改或重建，未部署／安裝／讀真秘密／模型／Git，沒有重跑已過 mock 或直接 runner 案例。依 PM 指示只補實際證據後待命，等整合失敗再修。

### PM 後續：manual LiveView 真 UI 黑箱 PASS

PM 回報 Run **`076e956b`**（回報短 ID）的 manual LiveView 真 UI 黑箱已通過：WebRTC 寬 **1280**、`readyState=4`、影格計數 **1→2**；JPEG 寬 **800** 且畫面持續更新。透過真 UI 按鈕停止 viewer 後，Run 沒有被取消並最終 **succeeded**。證據：`/private/tmp/whippet-m8-live-evidence/m8-live-result.json` 與同目錄 PNG。

先前失敗由 PM 定位為 QA 登入／locator／模式／API 操作未與 UI 同步；最終已按真 UI 按鈕流程通過，**沒有修改 Runtime**。本次只記錄 PM 實際執行與回報，本 Agent 未重建／重跑。這項 PASS 僅證明 manual Run 的 WebRTC／JPEG／停止觀看生命週期；**登入敏感輸入遮蔽、Workspace author 與真 AI 仍待驗**，不以一般 manual 監看替代其驗收，也不宣稱 M8 整體完成。

## 最新 M8 B：完整 Playwright、AI scope 與角色登入

依 `contracts/mvp-v8.md` **最新 B 裁定及固定來源／resolve／IPC**實作。本節覆蓋下方 A 暫態：不再全面禁止 run／validation／request_validation，不採 AST 子集、network=none 出站代理、HTTP1.1-only、全面禁 WS／登入後 DOM 或替代 reporter。**Runtime 隔離合成驗證通過，不代表 M8 整體或真 AI 全鏈已完成。** LiveView 敏感輸入的代表畫面及 Server→Manager 真 resolve／AI 串接仍待 PM。

固定交付：

- Worker：`runtimes/worker/dist/` **與完整 `skills/`**，含既有 adapter／recipe。沒有新增套件或 SDK，未改 lockfile／Dockerfile；ZIP codec 重用目前固定 Playwright **1.64.1** 的 `playwright-core/lib/utilsBundle` 內 yauzl/yazl，更新 Playwright 版本時需核對該接縫。
- Manager：`/private/tmp/whippet-manager-m8b`，已確認為 Linux arm64／靜態連結 ELF。沿用既有 Go cache、`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`、`-mod=readonly`、`CGO_ENABLED=0`；未下載依賴。
- 修訂接線提案：`/private/tmp/whippet-m8b-runtime-revised.md`；其中已被 PM 後續固定的內容，以契約和本節實作為準：來源叫 **scriptOrigin**，frame 是 **64 KiB**，正式 helper 採下列五參數形式。舊 `/private/tmp/whippet-m8b-runtime-proposal.md` 的 AST／強代理／禁觀察方案已撤銷，不能當作已同意需求。

### 實作與邊界

1. **來源與完整 runner**：Manager `protocol.go`／`manager.go`／`journal.go` 與 Worker `runner.ts`／author types 透傳、保存 `scriptOrigin=ai|manual|legacy`；缺欄按 legacy 解讀，不猜 manual。模型輸出 schema 不接受來源。manual 保留完整 Playwright／Node，runner 不套 AI 網站 gate、不要求 target 才可執行；資源 owner、角色授權、key 隔離與真報告門檻仍在。ai／legacy 使用已確認 config 的 browser fixture guard；舊無 context 輸入只具未確認空範圍，不能默默放行網頁探索。這不限制任意 Node 全部出站，也不宣稱是 OS 沙箱。
2. **AI browser tools**：`src/author/scope.ts`／`tools.ts`／`main.ts` 使用 Server 固定的 allowedTools＋workspaceContext.config／有效 targets。任何稿件來源的 AI 工具均套同一 scope。target 可作驗測頁；api dependency 供 XHR/fetch/EventSource/WS，cdn 供 script/style/image/font/media 等子資源；login dependency 的頂層須經可信角色登入操作，不作一般 target。未知／排除／用途錯誤只回安全 origin、固定錯誤及先確認範圍的建議，不帶 URL query/body/header，不自行加許可。WS/WSS 對應 HTTP/HTTPS origin，未全面禁止正常 WS 或 HTTP2。
3. **redirect／popup**：context route 在首次請求前驗 origin；唯讀核對目前 Playwright 版本發現 redirect chain 後續跳過 route callback，因此加 Chromium 固定 CDP response-stage Location 檢查，保留原生跳轉，不預送表單、不重送 request 或改寫最終頁 URL。新 page/popup 先 ready，再繼續；無法建立檢查時拒絕該次操作。AI context 的 service worker 為 block，避免其繞過 Playwright request interception；manual runner 不受此項設定限制。後續任意自建 browser／原生 Node／page route 改寫不屬全通道保證。
4. **author 分支**：Workspace 訪談 tools=[] 仍不建 browser/live；Server 確認後可只授予 browser 工具並進最多 8 requests／12 tools。test-author 可按實際能力使用 browser／request_validation；summary 保持零工具／唯讀／單請求。`read_validation_report` 仍只讀保存摘要。skills 實際載入並要求 AI 產稿／修復守已確認範圍，保留完整 spec、有效斷言與人工發布，不讓模型自報 manual。一般 run 不取得 AI key，生成 spec 不在帶 key author 執行。
5. **Manager resolve**：新增 `credentials.go`，只向設定 Server 的 HTTPS 專用端點 POST 本 attempt 角色參照；不 follow redirect，不弱化 TLS，核對 no-store、裸回應完整 Workspace/Run/attempt/role/ref/version／loginOrigin 與各 4096-byte 非空值。拒絕跨 scope、過期／錯版本與無權角色；不重試、不改用新版本或新 URL。Server 的 assigned/current attempt、控制 session、現行版本／撤銷核對由 Server 實作，Runtime 不以快照代替此權威查驗。
6. **stdio／記憶體 IPC**：Docker create/start 使用 interactive attach；沿 Docker CLI 分離 stdout/stderr，不自行拼 raw Docker multiplex framing。stdout `credential_request` metadata 在 log 前攔下；秘密回覆只向該容器 stdin `credential_response`，綁 UUID requestId／attempt／固定 roleRefs。每 frame 64 KiB、decoded username/password 各 4096 bytes、單 pending、15 秒、每 attempt 最多 20 次；取消、錯 attempt、舊 requestId、結束後回覆均不套用。秘密不放一般 input、env、argv、journal 或 log。Worker／Manager 只在記憶體保留必要已知值供遮蔽，結束／回收後釋放參照，重連同 attempt 不重跑。
7. **完整 spec 登入**：`src/login/client.ts`／`broker.ts`／`helper.ts`。父 runner 持有 Docker stdin；Playwright 子程序不直接繼承此 stdin，而經每 attempt 獨占 `/tmp` socket，父目錄 0700、socket 0600，只有 IPC、不存秘密檔案。既有 tsconfig paths 指向可信 shim：

   ```ts
   import { test, expect } from '@playwright/test';
   import { loginAs } from 'whippet/login';

   test('role login', async ({ page }) => {
     await page.goto('/login');
     const result = await loginAs(page, 'SERVER_SAVED_ROLE_UUID',
       '#username', '#password', 'button[type=submit]');
     expect(result).toEqual({ submitted: true });
     await expect(page.getByRole('heading')).toHaveText('Authenticated');
   });
   ```

   helper 由同 Workspace／attempt 的 roleRef 取得值，驗目前頁面及 form.action／formaction 是 Server 的 loginOrigin；manual 也不能把平台角色帳密填到任意站。回傳 **submitted，不是登入成功**，後續真斷言才判定。完整 Node 能觀察自身登入頁/session，這不是對惡意同任務程式的秘密沙箱，亦不授予跨 Workspace 或 Manager/key 權限。
8. **敏感輸入與原生證據**：`login/privacy.ts`／LiveObserver 在敏感填寫前暫停 live 並清待送影格，固定 DOM 程式對 password／已知值欄位及文字做視覺遮罩，送出後恢復必要觀察；不全面停用登入後 DOM/PNG。snapshot 不帶 input value、移除 URL query/fragment；本次密碼、cookie／hidden 值只在可信記憶體登錄，模型請求及工具輸出按字串葉節點遮蔽，不給 cookie/storageState 工具。
9. **真報告不造假**：Worker `login/artifacts.ts` 與 Manager `credential_artifacts.go` 檢查原生 HTML 內嵌 ZIP、trace ZIP、JSON／NDJSON／MD 的已知敏感文字；不只掃壓縮 bytes。每檔／entry 最多 64 MiB、每 archive 解壓總量最多 128 MiB、4096 entries、遞迴深度最多 2，禁止無界解壓；不解出任意路徑到檔案系統。只改字串葉節點／安全錯誤內容，**不改數值 stats、真斷言結果或 HTML 的靜態 JS shell**；更動 ZIP/MD 後重算 SHA1 檔名並同步原生引用，Manager 仍先附件後結果。Worker 無法安全處理的個別可選附件會省略、移除其引用並記固定警示；必要 HTML/results 不合格則 failed／不發布，絕不用假報告換通過。Manager recovery 若已用憑證但尚未完成安全處理且已失去記憶體值，保守不傳不明證據、不重跑；journal 只留非機密 used/sanitized 狀態。

### 實際檢查

- 正式 `npm run build` **PASS**。受影響 author mock（M7、M8 A、M8 B）同批 **13/13 PASS、無 skip**；最後 B 新檢查 **4/4 PASS**，包括用途／未知 origin、對模型的固定阻擋、single pending／錯 attempt／late reply／frame 上限，以及真正 ZIP 內容遮蔽保留 unexpected=1、expected=0 和原生 JS shell。沒有模型呼叫。
- Manager `TestM8`＋`TestM7` **PASS，0.378s**；最後受影響 `TestM8B` 四項 **PASS，0.495s**，包括 source input/journal/default legacy、合成 TLS resolve／no-store／owner／redirect 拒絕、取消 metadata 不轉 log、不送 late 值、嵌入 ZIP 內容處理不變真失敗計數。首次預設沙箱因 loopback bind 禁止而中止，不算 PASS；其後以正常 approval 執行同一必要 TLS 測試，未碰共用服務或真憑證。Linux arm64 cross-build **PASS**。
- PM 以既有 **whippet-worker:m1** 映像，掛最新 dist＋skills 唯讀、network=none（本測試網站全在同容器 loopback）、`/evidence` 跑以下單一真瀏覽器入口。此 network=none 只是隔離測試配置，**產品沒有改成 network=none**：

   ```sh
   WHIPPET_M8_BROWSER_TEST=1 WHIPPET_M8_EVIDENCE_DIR=/evidence \
     node --test dist/login/m8-browser.test.js
   ```

- **首跑 FAIL**，0.846s：被阻擋 redirect 的非同步 chrome-error 導覽干擾同 page 的下一個 popup 步驟；尚未進入登入／報告，沒有算通過。僅修 fixture：redirect 後 close，popup 使用另一個 page 並 await ready，並明確設定合成站 HTML MIME；產品 gate 未放寬，所有後續斷言保留。只再正式 build PASS，未重跑 mock／其他測試。
- PM **同一入口 retry PASS：1 test、0 skip、7.184s**。`foreignHits=0`；完整 `loginAs` 真成功為 **expected=1**，刻意斷言失敗為 **unexpected=1**。原生 HTML/results 與 ZIP **解壓內容**的合成敏感值檢查全部通過，沒有假造成功或壓縮 bytes 檢查替代內容驗證。
- PM 已**目視 PNG**：Authenticated 與 alpha 一般內容可讀，合成敏感 span 已遮蔽；pass/fail PNG SHA256 相同。證據：`/private/tmp/whippet-m8b-runtime-evidence/summary.json`、同目錄 `pm-review.json` 及 pass/fail 子目錄。這是 PM 真容器執行與目視回報；本 Agent 未自行 Docker、模型、安裝、Git、讀印真實憑證、部署或重啟 18080／18085。隔離容器已 rm，預覽未改。

### 剩餘整合與真實限制

- **LiveView 的敏感輸入／恢復觀察畫面仍 pending**；不可把 PNG 目視、DOM CSS 斷言或 byte 掃描當 live 畫面證據。Server→Manager 真 TLS resolve→Worker／真 AI 對話→validation→summary→人工發布仍 pending。Server 的隔離 DB lifecycle PASS 不取代此全鏈。
- 遮蔽針對可信來源已知的密碼／cookie/token、敏感輸入，不承諾任意網站未知秘密、canvas／圖片／所有編碼與第三方 widget 可自動識別。PNG/live 用來源視覺遮罩，需要代表畫面驗收；已知值 scanner 無法證明像素內容安全。對不能安全保留的證據如實省略／阻擋發布，不削弱報告與 revision 門檻。
- scope 是 AI 工作流防誤操作，Node raw network、自建 context/browser、工程師任意完整腳本不屬 OS 全通道沙箱；manual 網站範圍豁免不等於角色／跨 Workspace／key 豁免。服務設定與 role 撤銷仍由 Server 權威取消，Manager 確認容器回收後才放名額，不宣稱可瞬間追回已送進同任務程序的值。
- 本輪不再重建／重測或擴張實作；依 PM 指示只更新本 DELIVERY 後凍結，後續整合／提交由 PM 負責。下方 A／M7 等為歷史交付，以本節 B 裁定為準。

## 最新 M8 A：Workspace 純訪談與非機密提案

依 `contracts/mvp-v8.md` 頂部裁定及 PM 最新補充完成 Runtime A；**不是 M8 完成**。B 的網站探索、強制出站限制、登入與授權撤銷尚未實作；新版正式 run／validation／publish 仍須由 Server 回 `security_unavailable`，不能以訪談 succeeded 當 Playwright 成功。M7 整體 UI／真 AI 驗收也未因此補稱完成。

交付：`runtimes/worker/dist/` **加完整 `runtimes/worker/skills/`**，以及 Linux arm64 binary `/private/tmp/whippet-manager-m8a`。本輪沒有 Docker／部署／重啟共用服務、安裝、Git、讀印真實憑證或模型呼叫。既有 adapter、180000 ms author 時限、author 專用 AI 環境白名單及一般 run 不帶 key 的隔離維持。

- `skills/workspace-author/SKILL.md`、`src/author/skill.ts`：新增固定 `workspace-author@1` 映射，以 module URL 載入，不依賴 cwd；既有 Docker COPY skills 已涵蓋。純訪談不載入 Playwright recipe、不提供 browser／任何工具、不建 observer／live，只一次 Responses request，無自動重試。對話由呼叫者提供 conversationId，沿用既有 model／reasoningEffort／stateless transcript。
- `src/workspace-context.ts`、`src/author/types.ts`、`loop.ts`：只接受平面 workspaceId／testId／workspaceContext；Workspace 任務 testId、editingSessionId、sourceVersion 均為 null，script 空字串，allowedTools=[]。config 可 null、roleRefs 僅參照；背景作 DATA 而非授權。**A 不接受 requiredPolicyVersion、owner、workspaceSessionId 或另一套 context**。
- `services/manager/internal/manager/workspace_context.go`、`protocol.go`：有界固定 schema、未知欄位拒絕；name trim 後 1..200 UTF-8 bytes，說明最多 8192 bytes；targets／dependencies 各 20、roles 10、excludedOrigins 40；origin／default URL 2048 字元。正規化後三個 origin 集合互斥且各自去重檢查，矛盾直接失敗、不刪改輸入；dependency purpose 為 login/api/cdn。新角色可 roleId:null，非 null 僅允許快照同 Workspace roleRefs 中的 UUID。訪談 proposal 可尚未完整；正式確認的必填項與至少一 target 由 Server 再驗。
- `manager.go`、`journal.go`、`artifacts.go`、`author_skill.go`：保存／透傳非機密 Workspace owner/context 與原 author 輸入；explicit null 與空陣列保留。回收後仍依 journal skill/schema 收集同 attempt 的 author.json，不相信模型 metadata；共用容量、取消、回收、重連與去重，不重跑 attempt。Workspace author 成功只收嚴格 `{message,proposal?,conversationSummary?}`（2 MiB），不要求 Playwright 報告；conversationSummary 最多 8192 bytes。拒絕 script、驗證旗標、確認／權限／秘密欄位、null proposal、跨 Workspace 角色及超限內容。
- A 的 `test-author` 可只用 `read_draft`／`read_validation_report`／`update_draft` 子集維護候選；不建 browser/live。read_validation_report 只讀保存摘要、不抓 URL。新 Workspace 任務若宣告 browser 或 request_validation，Manager／Worker 都拒絕；即使模型私自呼叫未提供的 request_validation，也只得到 tool_failed，不排驗證、不回 true 旗標。summary 維持唯讀、零工具，typed Workspace context 可作背景。舊輸入沒有 M8 欄位仍保持既有相容行為；**新版欄位不得退回舊 bridge 執行**。

實際檢查（只用合成資料、mock fetch／容器 driver）：

1. 正式 `npm run build`：**PASS**；最新 dist 已更新。最後靜態檢視補上 origin 原始路徑／空 port 檢查，避免 WHATWG URL 將 `/a/..` 正規化後誤當根 origin；該最小對齊後只再正式 build 通過，依 PM 指示未重跑 mock／無關測試。下列 mock 結果為此前固定版本的實際執行結果。
2. `node --test dist/author/m8.test.js`：**5/5 PASS、0 skip**。capture 證明 skill 內文確實進 instructions、平面 config:null／configured roleRefs 進 DATA、空 tools／相同 session／設定 effort、無 browser 動作；涵蓋提問／提案、欄位／scope／角色／byte 邊界、function_call 拒絕、M7 summary 背景與 no-browser edit／request_validation 禁止。沒有真模型。
3. 受影響 `dist/author/m7.test.js`：**4/4 PASS**（本輪早期與 M8 mock 同次執行）；後續僅新增 M8 scoped 限制與 mock，未重跑無關 legacy 全套。
4. Manager `go test -mod=readonly ./internal/manager -run '^TestM8|^TestM7|^TestM3Author' -count=1`：**PASS，0.701s**。3 項新 M8 覆蓋 dispatch→input→journal 的 null／owner、去重／取消／回收前占名額、拒絕 live、嚴格輸出與不回退舊 bridge；沿用受影響 M7／M3 key、輸出 schema、去重與回收測試。初次新測試因 mock Manager 沒有 WS 而收到預期 offline ACK 錯誤，已調整測試接收該固定錯誤，再以實際 driver／journal 驗證執行；沒有把此錯誤吞進產品流程。
5. Linux arm64 交叉編譯：**PASS**，`/private/tmp/whippet-manager-m8a`。使用既有 GOCACHE、`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`、`-mod=readonly`、`CGO_ENABLED=0`，未下載依賴。
6. 新 skill 人工核對 frontmatter 與實際 loader/request capture。skill-creator quick_validate 的 PyYAML 缺依賴限制沿 M7 紀錄，未重試、未安裝，**不宣稱該腳本 PASS**。

整合接手：Server dispatch 必須帶同一已保存的 workspaceId／testId:null／workspaceContext，Workspace author editingSessionId 必須明確 null；成功輸出仍由 Server 核對 Run/attempt/baseRevision/contextRevision 再保存候選。秘密值不允許從專用 credentials API 轉入此通道。這批 schema 限制不能辨認自由文字中的所有秘密，也不是自動遮蔽系統；一般對話仍不得輸入帳密。A 沒有 lease／resolve／秘密值傳遞、網站探索或可宣稱的登入測試。

B 最小受控真網站方案另交 `/private/tmp/whippet-m8b-runtime-proposal.md`，僅提案，等待 PM／使用者固定相容範圍、證據及部署接縫；本輪未先碼代理／IPC／租約框架。

## M7.3：兩個固定 skill 與唯讀驗收摘要（歷史交付）

依 `contracts/mvp-v7.md` **頂部固定決策**及 PM 補充實作；未採暫存提案的 context／mode 或 artifact metadata。只改 `services/manager/`、`runtimes/worker/`；未安裝套件、執行 Git、讀印真實憑證、啟動瀏覽器／Docker、呼叫真模型、部署或重啟服務，未修改 docs／contracts。

| 位置 | 變更與限制 |
| --- | --- |
| Worker `skills/test-author/SKILL.md`、`skills/acceptance-summary/SKILL.md` | 兩個明確任務 skill，skillVersion 固定字串 `1`。沿 skill-creator／writing-for-agents 規範撰寫，沒有外掛平台、任意路徑、動態下載或新 SDK。 |
| `skills/playwright-authoring/recipe.md`、既有 SKILL.md | 將已驗證的 locator／listitem／web-first／完整 spec／PNG recipe 抽成單一共用檔；legacy 流程仍保留，兩個新 skill 也載入 recipe。摘要只以例子理解記錄中的程式，不執行例子。 |
| `src/author/skill.ts` | module URL 定位／去 frontmatter／快取及每檔 4096-byte 上限；固定 ID 映射並核對 version，未知／不完整 pin 不降級到 legacy。COPY skills 的既有 Dockerfile 已涵蓋新檔，不改 Dockerfile／lockfile。 |
| `src/author/types.ts` | 平面 skillId／skillVersion／allowedTools／editingSessionId／contextRevision／sourceVersion／conversationSummary／validationEvidence。完整驗證 hash／revision／成功證據／stats 與 byte 界限；summary 可 messages=[]，完整 script 與合格 evidence 仍必填；edit／legacy 仍需 user 訊息。拒絕另一套 mode／context／reportUrl。 |
| `src/author/loop.ts` | 每輪模型請求帶固定完整稿、Workspace、來源版本及週期摘要 DATA；保持原 Responses adapter／reasoningEffort／conversationId session／stateless reasoning。edit 的工具宣告和實際執行都限制在 allowedTools 子集；本輪候選仍只由工具變動。新 edit 最終 JSON 可維護 conversationSummary，最多 8192 UTF-8 bytes。 |
| `src/author/main.ts` | 先驗輸入，再僅為非 summary 建立 ExplorationBrowser／observer。summary 不建 browser，不抓報告或遠端歷史、不執行 spec；只一次模型 request，無自動重試。共同總時限維持最多 180000 ms。 |
| 摘要輸出 | 嚴格只有 message／description／backgroundSummary／optional name；description 16384 bytes、backgroundSummary 8192 bytes、name 200 bytes，message 沿既有界限。拒絕 script、requestValidation、skillId／session 等額外欄位，也拒絕任何模型 function_call。綁定只取 Server 保存 input，artifact 不回填。 |
| Manager `protocol.go`、`author_skill.go`、`author.go` | 接收固定欄位、拒絕未知／半套 pin、校驗允許工具及 evidence 的 revision／SHA256；JSON null／contextRevision 0／空 tools/messages 原樣保留。legacy author 仍可用，頂層 workspaceSettings／timeout 語義不改。 |
| Manager `manager.go`、`journal.go`、`artifacts.go` | 同一 kind=author／入口／容量／取消回收與 author.json（2 MiB）管線。有界固定非機密 Author input 保存到 journal，recovery 以該輸入選輸出 schema，不信任 artifact 自報類型，也不重跑 attempt。普通 Run 不新增 AI key。 |

實際檢查，均無真模型／瀏覽器：

- Worker 正式 `npm run build` **PASS**，最新 `runtimes/worker/dist/` 已更新。
- `node --test dist/author/author.test.js dist/author/m7.test.js`：**13/13 PASS**，包含 4 項 M7 mock 與受影響 legacy／M5 author 行為。request capture 證明 skill／共用 recipe 真正進 instructions、平面可信快照進 input、空 summary messages、不宣告或執行越權工具、summary 不需要 browser、來源 DATA 不變系統指令、輸出無 metadata、byte overflow／錯 pin／hash／revision 在適當階段拒絕。
- Manager `go test -mod=readonly ./internal/manager -run '^TestM7|^TestM3Author' -count=1`：**PASS，0.565s**。3 項 M7 覆蓋 dispatch→input→journal 無損、未知 schema／缺字段／錯 hash 拒絕、以保存輸入決定摘要或 edit artifact schema，以及 legacy 相容；沿用受影響 M3 的 key 白名單／取消回收／同 attempt 去重檢查。
- Go build／Linux arm64 交叉編譯 **PASS**，產物 `/private/tmp/whippet-manager-m7`；使用既有 GOCACHE、GOPROXY=off、GOSUMDB=off、-mod=readonly，未下載依賴。
- skill-creator `quick_validate.py` 已嘗試，但缺 **PyYAML（ModuleNotFoundError: yaml）而未執行成功**。未安裝、未另造替代驗證框架；人工檢視 frontmatter／引用，並保留實際 loader/request capture 證據。不能將此腳本列 PASS。

交付資產：最新 **dist＋完整 skills/**（只配送 dist 不足），以及上述 Manager binary。M7 沒有更動 M5 媒體／M6 附件管線，不重跑無關 M1–M6。

整合限制／接手：

1. Server 需同步固定 payload 與嚴格 author.json schema，再以保存 input／session／baseRevision／contextRevision／validationRunId 等交易核對套用與發佈。Runtime 檢查不能替代 Server 的 settings／timeout／附件實體資格。摘要 Run succeeded 只代表摘要完成，不能視為新 Playwright 成功。
2. summary 的空 messages 要用 JSON `[]`，不是 null；nullable sourceVersion／conversationSummary 仍需保留欄位。edit 的 plain-text legacy 回覆保持相容；**新 test-author@1** 要依載入 skill 回 JSON message／optional conversationSummary，不能加另一套 output。
3. 摘要由 Web 呼叫冪等 endpoint 觸發，Runtime 不新增自動排程或續接驗證。已成功驗證下只重試摘要的 Server／Web 流程、放棄晚到結果與 QA 發佈門檻，由各 owner／PM 整合。
4. legacy 缺版本背景／週期摘要時維持 null，不假造。遠端歷史工具延 M9；M7 僅有界摘要＋近期訊息。M8 的出站限制、機密引用與遮蔽尚未實作，不用 prompt 宣稱已隔離；journal／模型輸入只接受這批非機密快照。
5. 真模型與 Server／Web 完整 M7 主流程尚未執行，由 PM 另排；不宣稱只靠 mock 已完成產品驗收。本輪程式固定後待命，不自行部署。

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
