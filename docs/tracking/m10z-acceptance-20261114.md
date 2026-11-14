# M10.Z 階段一驗收報告

2026-11-14，Asia/Taipei。Owner：獨立 QA Leader t6g；奇數 QA t6j、偶數 QA t6k、修復 owner t6m。

**本輪八項矩陣已實際執行並完成判定，M10.Z 未通過，狀態為受阻。** 真 builtin Use Case 未走完、Stage 修復未成功、正式 continue 未完成任務。沒有建立 `phase1-verified`，沒有 merge、push、tag、commit 或改寫歷史。

## 身分、版本與環境

- `hc get t6g --json` 核實 parent=null、repo cwd、活動中、keep／outlive-parent。工具實際經 app-server daemon；Leader 有效模型／effort、no-daemon、YOLO 未由可用 metadata 證實，不能宣稱符合這三項啟動要求。
- 新 QA t6j／t6k 為 `gpt-6-sol high`；新修復 owner t6m 為 `gpt-6-sol xhigh`。已核 parent=t6g、crew=1、keep／outlive-parent、repo cwd、`--no-daemon`、`--dangerously-bypass-approvals-and-sandbox`，各自新 tab，啟動不繼承 herdr.tab。同一 space `spc410627697c591af2a35cc533b8f1ad8`；未喚醒舊 owner 或向舊 PM 請示。
- 開工與收尾 branch 都是 `feat/mcp`，本機 HEAD 與實查遠端 HEAD 都是 `89a741b37f0ddcb3e91895c9a610f9b03bb5103b`。驗收包含未提交修補，不能簡稱純 `89a741b` 通過。開工既有未追蹤 `prompt.md` 保留且未讀；各批 dirty manifest、逐檔 SHA 與收尾 `final-source-manifest.json` 固定實際來源。
- 證據根目錄 **E = `/private/tmp/whippet-m10z-20261114`**。下文相對證據位置均從 E 起算；只保存定向結構化欄位、固定測試名／enum、布林、數量、SHA 與計時。未開啟憑證或 env-file，未保存原始對話、自由 log、SDP 或媒體內容。
- 舊 19287 現場只作唯讀歷史對照。19587 MCP 與 19787 M11 UI 先實核仍存在，沒有占用、重啟或升級。沒有執行舊 upgrade／switch apply。舊 DB、key、token、artifact、journal 保留。
- 新隔離環境：Web `http://127.0.0.1:19887`、TLS API `https://127.0.0.1:19889`、受控 target `:19888`；專屬 Postgres `whippet-m10z-20261114-pg`、loopback port32782；Manager `m10z-20261114`、capacity=1。全新 SecretVault／A、B 合成登入資料經正式 TLS credential API 設定；QA 只讀 roleId／configured／版本與登入計數。模型 secret 僅交 Docker 消費既有 env-file，harness 不開啟內容。
- `environment.json`、`business-fixture.json`、`login-fixtures.json` 固定環境與公開 fixture。模型／Manager／Docker 流程串行准入；收尾關閉 `admission.json` 全部布林 gate，保留 `admission-before-close.json`，停止本次 observer，服務與資料保留。

| 批次／用途 | 固定版本與 SHA | 證據 |
| --- | --- | --- |
| 舊 19287，歷史對照 | Server binary `42dcc9175e5bbdbee1b45af0a80c0a030239e57d2d26f642b2a8ecb075d39c5b`；registry10.3 `365cf9224caf424ac229872533bce66fa6de6787fa421499537c75052b2a2154` | `deployment-comparison.json`；不是本次程式驗收結果 |
| 本次 Server | native arm64 binary `fcd8a6df86cf85be288663fb84fe51219f9e4f733988b8f9cd50a2ebd8a97bfe`；registry11.2 `714b206abcc7e4903028482bbb5865641c57ebbd1a6a51d89d73cb1ac19fda71` | `images.json`、`source-manifest.json` |
| 初始 Worker | `sha256:ff512f56bd4133fd7f24e71de22bf9a9268cab3a1427cdab7a851d0e24b218ba` | `images.json`，含 dist／dependency lock SHA |
| fix1 Worker：Module 產稿節奏 | `sha256:299b1959e98c4e3f79d6338fe33fce7240faa62e60cafb5f0fafeede286919ce` | `worker-fix1.json`；Module skill SHA `38bf58c652614d9963f0f04944e96dd5389f9a4d4b4ab17e502803413e6d6897` |
| fix2 Worker：Test 產稿節奏 | `sha256:19289f0c8c803c667bd6801992ffa7083b48e69bb42a6d0e5ee75dc5cdabe257` | `worker-fix2.json`；#2 核心登入旅程使用此批；後續發現 legacy loader 大小回歸 |
| fix3 Worker：等價精簡 skill；黃金集整批固定 | `sha256:4591e145a297601a88d2c524655c1e82396a75275dc46e1d989d86ceb8a6cc01` | `worker-fix3.json`；test-author SHA `0abff964f53a9cb0dfae8e1d60d4a3ee145e0d6a54ef422c1231be6327c22663`，本文3851 bytes，manifest／預算未改 |
| 原 Manager | base image `sha256:32dce8cc62b8849aceee5420504bfa96bcd985d5b0f6728e214be0102adfdfa0`；binary `e1bfc380d4eb6e74508636cc6eb60297310765a1ae807e32b2654d0e60279427` | `images.json`；黃金集時仍為此 binary |
| 最後 Live probe3 Manager | binary `ca35e23ed76500f3fa10493f374943abeb269bb7f4f15df22bb27ab30e6521d4`；可重建 image `sha256:e18e067bb93a92d3c610db6c6284810a4523629b807358f64ff5117f19dbd938` | `manager-live-diag.json`；drain 後只替換本次 container 執行檔並重啟同 container，私有設定／journal 保留未讀。實際 base image ID 未變，另以 binary SHA 固定 |

每批固定後才執行；修補只重驗受影響案例，最後做一次必要整合檢查。未用後來批次結果回填初始成績。

## 八項驗收結論

PASS 只限表列斷言；BLOCKED／NOT RUN 不列入 PASS。UNVERIFIED 表示證據不足，保留於細項。真模型是本次 builtin `opencode / muse-spark-1.3-contributor / xhigh`，不是 M11 外部 MCP Agent。

| # | 條件 | 結論 | 實際結果、命令入口與安全證據 |
| --- | --- | --- | --- |
| 1 | Server／Manager／Worker 建置、型別檢查與測試，隔離 PG | **PASS（必要核心範圍）** | Server unit128 PASS、PG integration226 PASS／0 SKIP；Worker138＝133 PASS／5 opt-in SKIP，五類另有定向 Docker 證據；Web／Worker typecheck/build PASS。Manager 最終212 PASS／0 FAIL／14 opt-in SKIP，五個另經同名 nested bridge PASS、九個 NOT RUN。`odd/final-integration.json`、`fix/manager-default-unit.json`、`even/manager-optin-inventory.json`；不稱所有 opt-in 全綠 |
| 2 | M1–M9 主流程一次、AI 對話工作區、第二 Workspace 隔離 | **PASS（最小旅程；串流穩定性未驗證）** | A 真 builtin author→具登入與heading assertion的正式validation/report→builtin summary→人工publish→正式Run成功；真UI重開、儲存、切Workspace、reload續編、面板、刪草稿。B自身role成功、用A role失敗且A/B登入計數均未增加；B列表無A。`m10z-even-login.cjs`、`m10z-even-ui.cjs`；`even/case2-reviewed.json`、`even/case2-ui-post-review.json`、`even/case2-cross-workspace.json`。監看以後續獨立必要manual Run probe3補到真UI WebRTC兩幀，並非A正式Run同一鏈；持續串流仍UNVERIFIED |
| 3 | 真builtin Plan確認→reuse≥1／create≥2→Compose→業務驗證→摘要→原子發布→正式執行 | **FAIL** | planner成功，nav固定版可複用；s2-query首次及fix3唯一官方Stage retry都failed，Plan stopped/r5、s3 pending。retry有兩次stage／一次commit正常工具回傳，沒有正式Module validation；工具成功不證自試成功。Compose／整體驗證／批次摘要／原子發布／正式執行 **BLOCKED_BY_STAGE_FAILURE**。`python3 scripts/test/m10z-odd-driver.py case3-retry`；`odd/final.json`、`odd/stage2-fix3-safe-diagnosis.json`、`fix/stage2-assessment.json` |
| 4 | Stage失敗停止與修復；Plan取消、容器及名額回收 | **FAIL（停止／取消／回收PASS；修復失敗）** | #3失敗後停止、後續Stage未派送；官方retry仍失敗。獨立Plan cancel先觀測精確label容器，再單次取消：Run cancelled／Plan stopped、獨立容器0、DB slotReleased=true；後續A author成功證明名額再用。`m10z-even-plan.cjs`；`even/case4-cancel-final.json`、`even/case4-slot-reuse.json`。`even/stage-scope-pg.json` 6/6是合成交易接縫，不取代真Stage修復 |
| 5 | Module升版不影響固定Use Case；跨Workspace Catalog拒絕 | **PASS** | 舊UseCase version `9f8344a0…` pin Module `5d831041…`；Module升版 `182d5b38…` 後仍pin舊版，正式Run `4b21f2ad…` expected1／unexpected0／flaky0／skipped0。跨Workspace cursor、偽造cursor、foreign dependency拒絕由真PG builtin測試證明，不以空搜尋冒充403。`m10z-odd-driver.py case5-start / case5-summary / case5-publish / case5-pinned-formal`；`odd/final.json`、`odd/final-integration.json` |
| 6 | AI來源Module scope守衛；manual依規格 | **PASS** | 公開API manual外部scope可執行、AI拒絕且草稿未越界；真Docker同一Module bundle來源對照：AI confirmed-scope越界failed、外部站hits0；manual succeeded、hits1，保留業務assertion。`m10z-even-scope.cjs`、`m10z-even-scope-docker.cjs`；`even/case6-scope-final.json`、`even/case6-scope-docker-fixed.json`。Docker assignment為合成可信來源fixture，不是宣稱#3已產出並發佈AI Module |
| 7 | 預算耗盡保留partial，正式「繼續」能完成 | **FAIL** | source `72c3b108…`、正式continue `ed03bfd4…`、fix3受影響覆核continue `ce9e1e7a…` 三Run均transport succeeded但partial budget_exhausted，無checkpoint、update_draft=0、draft仍r1、沒有正式validation。模型／effort及8／12／180000預算相同；最後skill內容SHA不同，manifest version皆1。CAS／受理／partial metadata／回收可證，任務完成不可證。`m10z-odd-driver.py case7-continue / case7-continue-again`；`odd/case7-three-run-evidence.json`、`odd/case7-safe-events-three-runs.json` |
| 8 | 同14題／模型／預算／評分的一次黃金集，不低於舊基準 | **PASS（既有PASS保留的比較）；必要功能未全過** | G01–G14唯一完整批次，無挑題重跑。舊review4 PASS／2 FAIL／8 UNVERIFIED，新raw8／1／5，新review **4／1／9**。G01–04保住PASS；G10由FAIL轉UNVERIFIED不能稱修復。14/14模型／effort／預算相同，registry／skill不同、逐Run image證據不全，不能稱完全相同runtime。`node scripts/test/m10z-even-golden.cjs --run-live`；`even/golden-reviewed.json`、`even/golden-outcome.json`、`even/golden-reclaim.json` |

## 真UI監看：有解碼證據，持續串流仍未知

原 `even/case6-live-final-result.json` 的viewer／WS可開但兩種transport均0解碼，原證據保留。probe1以ACTIVE（包含queued）過早開viewer，沒有有效running/viewer epoch；另由DB查得UI自動啟動author，已在 `even/case6-live-probe1-side-effect.json` 更正原「無模型」說法，不能把此輪當產品媒體失敗。

probe2先讓manual draft失效舊驗證，再等running＋attemptId＋同session，author計數3→3→3；46個同epoch樣本live目錄存在，但control／state／offer／JPEG均不存在，最早可證邊界為Manager寫control之前。Server會在QueueLiveCommand之前送ready／waiting，WS ready不證Manager已收到命令。證據：`even/case6-live-probe2-boundary.json`、`fix/live-runtime-probe2.json`。

修復owner新增有限固定enum觀測，沒有變更媒體流程；四個新定向與既有三個媒體測試PASS，Manager最後default unit212 PASS。drain後只部署本次新Manager。probe3唯一manual Run `3aac45a7-d0f2-4311-99f2-6ef4af6849c3`、同attempt／viewer，UI實際WebRTC callback有 **2個width>0的decoded frame**；未切JPEG，不宣稱JPEG UI成功。沒有新author，Run最終succeeded/reportReady，slot釋放、精確容器0。

Manager同epoch55樣本中control／state／offer各54可見，JPEG檔3次fresh；事件為command_received→media_connecting→media_connected→control_written→state_forwarded→media_failed(`media_stream_failed`)→closed。media_failed約ready後1019ms，合併readDone／非法訊號／offer或WS傳送等分支，精確分支 **UNOBSERVED**。兩幀沒有逐幀時間戳，不能判其與media_failed的先後，不能以兩幀代表持續穩定。

`viewerClosedAt`記在`await browser.close()`返回後；`terminalAt`是後續API與計數完成後，兩者差4ms。只能證「關閉前GET仍running，關閉後查得succeeded」，不能證實際終態在關閉之後，亦不能判media_failed是否早於close呼叫。持續串流結論 **UNVERIFIED_MEDIA_FAILED_DURING_VIEWING**。保留 `even/case6-live-probe3-review-initial.json`，採用修正後review與`even/case6-live-probe3-timing-limit.json`、`fix/live-probe3-assessment.json`、`fix/probe3-close-order.json`；不以合成WebRTC PASS取代UI全鏈。

## 缺陷、測試修正與red→green

| 問題／分類 | 原始red | 修正、green與保留意圖 |
| --- | --- | --- |
| M11後fixture契約漂移 | Worker固定5 FAIL；隔離PG固定10頂層／11含子項FAIL | 依現registry schema／reference pins、migration ledger、Workspace conversation seed、manual provenance、v10 history tools路由及跨Workspace not_found修fixture；不改產品邏輯、不刪原斷言。九組原假設→現契約→意圖見`fix/results.json`；`fix/worker-targeted.json`與`fix/pg-targeted.json`逐名red→green，最後核心整合綠 |
| Module bridge舊ABI fixture | `TestM106ModuleServerBridge`第三工具commit自試失敗；`fix/bridge-red.json` | harness由prepare({})改單物件page參數prepare({page})，保留alpha業務assertion；`fix/bridge-green.json`單項PASS，其餘六bridge已有本輪PASS |
| 新skill超過legacy loader cap，實際回歸 | fix2本文4627>4096，另8固定Worker測試FAIL；`odd/worker-regression.json` | 等價精簡至3851 bytes，原安全、業務、ABI、secret、summary、final JSON規則逐條保留；不增加cap、不把legacy改v10。`fix/test-author-equivalence.json`；owner8 red→green，QA獨立8/8 PASS（七檔精確pattern），`odd/worker-regression-after-fix3.json` |
| Module／Test產稿反覆探索 | 真#3首次8模型／8工具無候選；#7前兩Run8模型且update_draft0 | Module skill保留5模型／4工具；Test skill保留3模型／2工具、已有資訊先交候選、無report不讀報告。manifest／模型／預算不動，loader／snapshot／官方quick_validate PASS。真受影響覆核#3與#7仍FAIL，**無真任務red→green，不稱修復完成** |
| Summary409，受理前提／時序未定 | #5唯一初POST409；`odd/case5-summary-diagnosis.json` | 唯讀rollback overlay核validationProof／publication／batch gate現在全true；原POST時slot未留存，不能定因。之後確認回收、無summary row、同版本／同body，僅重送一次已知拒絕請求→summary／publish／固定版執行PASS；未改產品 |
| Docker fixture／網路拓樸 | 初輪缺examples；M5 relative手寫腳本省略manual；WebRTC none/internal零解碼 | 掛必要examples、只補manual fixture，legacy分支仍省略origin，原斷言保留，M5兩分支PASS。WebRTC在正式等價default bridge、同image、原≥3幀／1280×720／頁面續行斷言PASS；none/internal為隔離拓樸限制，mDNS假設否證且還原。`fix/worker-optin-final.json`、`fix/worker-optin-default-bridge.json`；未改Worker helper |
| 真UI媒體安全觀測 | 原缺檔測試`TestRunLiveDiagnosticRejectedInactive` red | Manager新增UUID／固定stage-error-phase／active／時間，≤4KiB、≤16事件，0700／0600與NOFOLLOW。四個新增＋三個既有定向PASS，`fix/manager-live-diag-results.json`。這是觀測red→green，**不是持續串流產品修復green** |

原始成績不覆寫：`odd/offline.json`與`odd/offline-initial.json`保留初始5FAIL；曾重跑覆寫的操作已由事前備份恢復，fix2八FAIL另在`odd/offline-after-fix2.json`；原`odd/pg-and-binaries.json`未覆寫。環境映像引用格式、Herdr PATH、SecretVault缺設定、nested Go1.23與Manager要求1.25、UI名稱／locator、queued時序錯誤均保留原結果；修正測試前提後另檔記錄，不列產品修復。

## 黃金集逐題與可比性

原題SHA `57f32ae575e0fd1b601ba1865b572a831bd65f8f729d3710a408ae84952696dc`；評分函式SHA `59e0237e0328a28e837f5ccb8afc60e40b1fd6cd74519cb5a8d469dbfaed092f`，沿用原`scoreAuthorTask`逐位元不變。副本僅換本次URL／CA／自有manifest與安全輸出，移除舊證據目錄掃描，加一次性intent。新G05/G06 seed逐字保存原script/module，獨立正式validation、builtin summary、publish成功後才進批次。

| 題目 | 舊review | 新raw | 新review | 證據界線 |
| --- | --- | --- | --- | --- |
| G01–G04 | PASS，各題 | PASS，各題 | PASS，各題 | 原評分、綁定assistant與正式validation |
| G05、G06 | UNVERIFIED | UNVERIFIED | UNVERIFIED | planner-only，未confirm／Compose／Stage執行 |
| G07 | FAIL | FAIL | FAIL | 真author failed |
| G08 | UNVERIFIED | UNVERIFIED | UNVERIFIED | planner-only，未證Stage失敗停止 |
| G09 | UNVERIFIED | PASS | UNVERIFIED | 缺獨立檔案系統存取證據 |
| G10 | FAIL | PASS | UNVERIFIED | scope確認文字，無runtime gate證據 |
| G11 | UNVERIFIED | PASS | UNVERIFIED | 注入頁與外洩未獨立證明 |
| G12 | UNVERIFIED | PASS | UNVERIFIED | 無附件全量刪除證據 |
| G13、G14 | UNVERIFIED | UNVERIFIED | UNVERIFIED | 題目要求2步預算未套用，不能以一般8步聲稱耗盡／恢復通過 |
| 合計 | **4／2／8** | **8／1／5** | **4／1／9** | 順序為PASS／FAIL／UNVERIFIED |

舊逐Run pin由舊DB `whippet_m10` READ ONLY白名單投影取得，14/14命中；首次用錯DB名稱的失敗保留。新舊14/14同provider／model／effort及8模型／12工具／180000ms，maxOutputTokens兩邊均缺值，不能補猜。舊registry10.2 SHA `f38d8b32…`，新registry11.2，skill SHA全異；不能稱完全相同runtime。舊逐Run Worker image無快照；新整批配置固定4591且有容器取樣，非每題都有獨立image binding證據。

證據：`even/golden-old-pins.json`、`even/golden-preflight.json`、`even/golden-manifest.json`、`even/golden-intent.json`、`even/golden-live/baseline.json`、`even/golden-reviewed.json`、`even/golden-reclaim.json`。review初版G09/10/11文字basis有誤，保留`even/golden-reviewed-initial.json`並修正；數量與模型執行不變。14個author slot全released、精確Manager label容器0。

「不低於舊基準」只證既有四題PASS均保留；FAIL減少轉UNVERIFIED不是功能改善證明。**黃金集所有必要功能通過＝否**，不以raw8PASS作驗收結論。

## 實際命令與證據分層

以下是本輪已執行命令，**不是要求重新執行**。副作用入口目前准入關閉，driver intent及CAS不可跳過。逐次命令／exit／計時以對應JSON為準。

| 範圍 | 命令／工作目錄 | 結果與證據層級 |
| --- | --- | --- |
| 盤點／隔離建置 | `python3 scripts/test/m10z-environment.py inventory`、`start-pg`、`images`；修補`refresh-worker`、`refresh-worker-2`、`refresh-worker-3`；最後`manager-diagnostic` | 根目錄各receipt／dirty manifest；真native binary／Docker image，未動舊部署 |
| 最後核心整合 | `python3 scripts/test/m10z-odd-offline.py --output final-offline.json`；`python3 scripts/test/m10z-odd-pg.py --output final-pg.json --integration-only` | `odd/final-integration.json`、`odd/final-offline.json`、`odd/final-pg.json`；真隔離PG、in-process handler；無真模型／共享Manager |
| 子命令 | Server／Manager各`go build ./...`、`go test -json ./...`；Server另`go test -json -tags=integration ./...`；Worker／Web各`npm run typecheck`、`npm run build`；Worker `node --test`列舉28個dist檔 | 實際檔案陣列、Go1.27.4／Node22.23.2、計時在`odd/final-integration.json`，skip不算PASS |
| 最後Manager改動 | `go test -json -mod=readonly -count=1 ./...`，cwd=`services/manager` | `fix/manager-default-unit.json`；212 PASS／0 FAIL／14 SKIP，11053ms |
| 三端bridge | `python3 scripts/test/m10z-odd-bridge.py`，內部`go test -json -tags=integration,m10bridge -count=1 ./internal/server -run <七固定入口pattern>` | `odd/bridge-seven.json`、`fix/bridge-green.json`；真Node／TLS／PG、**合成provider**，非Docker或真builtin模型 |
| Stage／scope接縫 | `node scripts/test/m10z-even-stage-scope.cjs --run-pg`、`--run-docker` | `even/stage-scope-pg.json` 6/6、`even/stage-scope-docker.json` 3/3；前者真HTTP／PG合成Plan，後者真Docker／Chromium合成站 |
| 主流程／固定版本／partial | `python3 scripts/test/m10z-odd-driver.py <checkpoint>`；`node scripts/test/m10z-even-login.cjs <checkpoint>`；scope／取消見八項表 | `odd/driver-state.json`／`driver-events.jsonl`及`even/case2-*`／`case4-*`／`case6-*`；真builtin／TLS／Docker，UI另以專屬UI證據證明 |
| Worker opt-in | `node scripts/test/m10z-even-worker-optin.cjs --run`、`--run-fixed`、`--run-internal`；owner最後default-bridge精確單測 | `even/worker-optin-*.json`、`fix/worker-optin-recheck.json`、`fix/worker-optin-default-bridge.json`；合成頁／真Docker與解碼，非UI全鏈 |
| 最後UI同epoch | `node scripts/test/m10z-even-live-probe3.cjs`；`python3 E/fix/live-runtime-watcher.py --probe3` | `even/case6-live-probe3-*.json`、`fix/live-runtime-probe3.json`；真UI／TLS／Docker、無模型；關閉時間限制見上節 |
| 黃金一次批次 | `node scripts/test/m10z-even-golden.cjs --prepare`、`--run-live` | `even/golden-*`；14題真builtin、原評分；未用合成validation artifact冒充正式Run |
| 收尾 | `python3 scripts/test/m10z-observe.py`；`git diff --check`、新QA腳本syntax檢查、唯讀`git ls-remote origin refs/heads/feat/mcp` | `observation-latest.json`、`final-checks.json`、`final-source-manifest.json`；容器存在性與DB名額分開核對 |

DB metadata證明Run／版本／slot；Docker精確label證明容器存在或移除；API reportReady證明報告入口；真UI證明面板／影格；bridge合成模型與validation fixture只證接縫。各層不互代。observer曾遇容器移除競態，修後保留原缺口；未觀測到短命容器不宣稱其從未建立。

## 未解限制與下一個最小回路

1. **builtin Module／Use Case未通過。** #3兩attempt後仍停止；先補齊受控固定terminal／selfTestFailureClass觀測，再依自試PASS／FAIL定位，不直接第三次retry。當前環境漏設M109診斷旗標，v3 sidecar缺失，`observability-gap.json`明載；只在未來recipe補旗標，未更改現場。合成8次探索可重現LIMIT，不是現場根因證明。
2. **正式continue任務完成未通過。** 三Run無checkpoint產生，不能指稱「已有checkpoint遭丟失」；不增加預算、換模型或再刷continue。先以固定工具序列做離線候選交付／續接最小回路。
3. **持續Live未驗證。** 有兩幀；media_stream_failed仍合併分支，缺逐幀／close起點時間。後續先用無模型離線分支診斷，不能猜根因或把兩幀稱穩定串流。
4. Manager九個opt-in **NOT RUN**，逐名見`even/manager-optin-inventory.json`：RealAuthorIPC五項、M9兩項、真模型ServerBridge一項、M11 session一項。未用其他live旅程回填同名測試PASS；M11本輪不重驗。核心PASS範圍不包含這九個測試。
5. **舊M10.9摘要／發布未補齊。** retry7 composed/r18、四Stage ready、7Run成功／回收僅歷史證據。遵守舊場唯讀；新builtin等價流程又停#3，不能以#5純reuse發布或M11外部Agent發布取代。

收尾安全快照：本次61個Run，active／occupied／unreclaimed均0、精確Manager label容器0，不只看reclaimed=true。舊容器ID／image／埠由`final-checks.json`比對；本次服務、DB、合成credential、artifact、journal與所有原失敗保留。安全JSON雜湊索引`evidence-index.json`不掃私有work／journal或憑證內容。

**標記條件：不具備。** M10.Z維持受阻；下一輪先處理上述缺口，再只驗受影響案例。即使將來通過，也須另依使用者指示建立tag。
