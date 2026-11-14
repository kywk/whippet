# Agent 分工與派工計畫

M1–M6 本機功能證據沿用；目前由 UI／UX PM 推進 M7–M9 規格與後續實作。里程碑與唯一進度來源為 [實作計畫](implementation.md)。

## 固定分工

同時最多三個實作 Agent，加上一個輕量總指揮；小任務可由一個 Agent 完成，不為湊分工而拆工作。

| 角色 | 寫入範圍 | 責任 |
| --- | --- | --- |
| 總指揮／整合 | `contracts/`、`deploy/`、根目錄建置設定、`docs/`、`.agent-rules/` | 任務排序、最小契約、跨模組決策、部署串接、進度與必要驗收 |
| Web Agent | `apps/web/` | React SPA、測試與草稿頁面、對話介面、報告與唯讀監看 |
| Server Agent | `services/server/`，含其 migrations | Go API、PostgreSQL、版本與發佈規則、任務表、Manager gateway、附件管理 |
| Runtime Agent | `services/manager/`、`runtimes/worker/` | Go Manager、Docker 生命週期、Node／TS Agent 與 Playwright、影像輸出 |

- 各模組已建立，沿用既有實作，以最小垂直切片補齊缺口。
- Agent 在自己的範圍內直接完成實作與必要檢查；需要跨範圍修改時回報具體介面需求，由 owner 處理。
- Dockerfile 放在各自服務目錄，由該 owner 維護；Compose 與部署指南由總指揮整合。
- 契約由總指揮單一寫入。新增必要欄位時同步通知受影響 owner，不先建立未使用的完整框架。
- 同一檔案同一時間只交給一位 owner；交接須說明接手範圍與已知變動。

## 開發波次

| 波次 | 依賴 | Web Agent | Server Agent | Runtime Agent | 整合交付／最小驗證 |
| --- | --- | --- | --- | --- | --- |
| 1：固定腳本執行 | 最小 Run／任務契約 | 登入、列表、詳情、執行與結果 | Workspace、Test、Run API、任務保存 | WSS 連線、啟動 Worker、執行與回報 | 一個成功與一個斷言失敗的端到端結果 |
| 2：草稿與排隊 | 波次 1 可串接 | 草稿、驗證、發佈、歷史 | revision、發佈交易、版本快照、狀態對帳 | 併發、取消、超時、回收、重連 | 舊驗證拒絕發佈；Worker 終止後下一任務啟動 |
| 3：AI 對話 | 草稿契約完成 | 對話、修改預覽、接續編輯 | 訊息與 session 持久化、Agent 任務 | 模型 adapter、工具迴圈、產生／修復 | 一個真實模型走完對話至發佈 |
| 4：即時監看 | Worker 生命週期可用 | 監看播放器與備援狀態 | 協商／影像轉送端點 | 畫面擷取、WebRTC 與備援 | 一條觀看路徑與一次備援切換 |
| 5：部署收尾 | 主流程完成 | 修 UI 阻塞 | 修 API／持久化阻塞 | 修 Linux／Mac Docker 阻塞 | Linux Server＋Mac 執行端完整流程一次 |

波次是交付順序，不是全面等待柵欄。Web 可先依契約使用 mock；Server 可使用假 Manager；Runtime 可用固定任務。影像工作在所需介面可用時開始，不阻塞草稿與 AI 功能。

## 每次派工格式

總指揮只附本次需要的文件段落與契約，不轉交整份歷史對話。

```text
目標：完成 <里程碑中的可操作功能>。
Owner：<角色>；可修改：<具體路徑>。
讀取：AGENTS.md、相關細則、<規格／契約的必要章節>。
依賴：<已具備的 API／事件／fixture；尚未具備則採指定 mock>。
交付：<程式行為與可供下一位串接的輸入輸出>。
最小驗證：<一個相關測試或一條可重現操作>。
邊界：沿用 MVP 決策，僅處理本功能直接需要的錯誤情境。
回報：修改檔案、串接方式、實際驗證、阻塞或需 owner 接手的事項。
```

## 可直接派出的首批任務

### Web Agent

- 讀取 MVP 的登入、列表、詳情與執行需求，以及已發布的 Run API 契約。
- 在 `apps/web/` 建立 React SPA 的上述頁面，使用 mock 開始，API 就緒後串接。
- 完成條件：能按執行、呈現狀態、開啟報告。最小驗證：建置及一條操作流程。

### Server Agent

- 讀取架構的資料模型與最小任務協定，實作預設 Workspace、固定身分、Test／Run API、PostgreSQL 與 Manager gateway。
- 僅修改 `services/server/`；提供 migrations 及本地啟動所需環境變數給總指揮。
- 完成條件：可建立任務、保存 Worker 結果並查詢。最小驗證：一條 API → 任務 → 結果整合測試。

### Runtime Agent

- 讀取 Manager／Worker 邊界與最小任務契約，實作 Manager 主動連線、啟動 Worker 容器、固定腳本執行與回報。
- 僅修改 `services/manager/`、`runtimes/worker/`；先在可用 Docker 環境執行。
- 完成條件：真實 Playwright 產生結果與報告，程序結束後容器可清理。最小驗證：固定測試執行一次。

## 輕量整合規則

- 總指揮只審查跨模組契約、關鍵行為與實際證據，不重新做完每位 Agent 的工作。
- 只有資料遺失、重複執行、錯誤發佈與資源無法回收等核心問題阻擋該功能交付；介面美化與非核心調整排到後續。
- 測試通過且沒有新改動，就沿用結果。不要額外加入全量重跑、多人重複審查或反覆規格核准。
- 完成時由總指揮更新 implementation 的任務狀態；只有真的需要跨工作階段接續，才寫 handoff。

## 本次執行路由（使用者已指定）

透過 herdr 可見 pane 執行互動式 Agent。一般開發使用 Codex gpt-6.1-sol／xhigh；特別困難任務才使用 gpt-6-astra／medium。單純測試使用 OpenCode muse spark 1.3／xhigh（啟動前核對精確模型 ID）。不得默默替換模型。首批共用 contracts/mvp-v1.md；同一工作目錄依檔案 owner 協作，不執行 Git 操作。

## M2 本輪分工

共同契約為 `contracts/mvp-v2.md`。t30 負責 Web 草稿／發佈／取消；t31 負責 Server 草稿、版本、發佈交易與排程介面；t32 負責 Manager 併發、取消、回收及去重。開發維持 Codex sol／xhigh。t33 使用 OpenCode Muse Spark 1.3 Contributor／xhigh，僅依合成資料與黑箱介面撰寫驗收腳本，不讀取專案原始碼或憑證。總指揮負責部署、整合驗收與最後提交。M3 暫不開始。

## M3 本輪分工

共同契約 `contracts/mvp-v3.md`。沿用 Herdr t30 Web 對話與稿件預覽、t31 Server 持久對話與author結果交易、t32 Runtime工具迴圈與author容器隔離，皆 Codex sol／xhigh。t33 Muse 僅負責合成黑箱驗收，總指揮負責部署與真實模型串接。M2驗收結果沿用，不重跑無關測試。

## M4 本輪分工

共同契約 `contracts/mvp-v4.md`。t30 負責 React 監看與 Nginx WS proxy；t31 負責獨立 LiveHub／viewer 與 Manager media WS；t32 負責 fixture／author 畫面擷取、Chromium WebRTC helper、Manager live bridge。沿用既有依賴，不安裝新套件、不由子 Agent 操作 Git。總指揮管理契約、Compose、整合驗收；t33 Muse 僅撰寫合成黑箱驗收腳本。

## M5／M6 本輪分工（2026-11-11）

最新授權覆蓋歷史提交安排：不安裝套件、不自行 commit／push、不輸出憑證。PM t35 已核對 GPT-6-Astra／low，維持輕量協調；t30／t31／t32 沿用 sol／xhigh 可見 pane。t33 沿用 Muse Spark 1.3 Contributor／xhigh，只做黑箱測試，整合就緒後才執行。

首批 t32 診斷與改善 WebRTC 畫質；t31 提出並落實 Workspace 持久化與快照；t30 檢查播放器縮放並準備設定 UI，API 串接等待 PM 固定介面。共享契約、部署、docs 與進度檔由 PM 單一寫入。子 Agent 不重啟或部署共享服務。第二批才派 runtime 設定接線與 M6 trace／附件；避免同 owner 同時承接互相干擾工作。範圍、狀態與驗收只在 implementation.md 維護。


## M7–M9 當前分工（2026-11-12）

本節為最新路由；任務狀態僅在 implementation.md 維護。規格文件已提交 1e6fd7e；最新授權已啟動 M7 首波：t30 實作獨立 UI 切片，t31／t32 先回覆最小介面提案。其餘依進度表，不代表全部已啟動。

| Owner／路由 | 寫入範圍 | 可直接派出的任務 |
| --- | --- | --- |
| PM／gpt-6-astra low | docs、contracts、deploy、根建置設定 | 固定每波最小契約與遷移；整合隔離預覽、進度及必要驗收 |
| t30 Web／gpt-6.1-sol xhigh | apps/web | M7 一般／對話模式、草稿入口與確認放棄、對話結果／監看／發佈卡片；M8 多 Workspace 對話與機密欄位 |
| t31 Server／gpt-6.1-sol xhigh | services/server（含 migrations） | M7 編輯週期與對話歸屬、摘要／發佈一致性、放棄競態；M8 Workspace proposal、scope、機密保存與任務授權 |
| t32 Runtime／gpt-6.1-sol xhigh | services/manager、runtimes/worker | M7 測試編輯與摘要 skills／背景輸入；M8 設定 skill、登入工具、出站限制與機密生命週期 |
| t33 黑箱／Muse Spark 1.3 Contributor xhigh | 本輪指定 scripts/test/m7-*、m8-*、m9-* | 依契約與可見標籤寫最小合成黑箱；不讀產品原始碼、真實憑證、不改 DELIVERY 或其他 owner 檔案 |

特別困難且確有需要的任務才升至 astra／medium，先核對有效模型／effort，不默默替換。沿用共享 repo，單檔單 owner；不另建重複 Agent。所有 Agent 不安裝套件、不自行 commit／push、不重啟共享服務、不讀印 deploy/.env.ai。

### 首波任務內容

共同讀取 AGENTS.md、requirements/ai-workspace.md、implementation.md 的 M7 與已固定的新契約；不要轉交整份舊對話。

1. PM 向 t31／t32 收集一次最小介面差異後固定 M7 契約；未固定前只盤點，不各自發明 endpoint。
2. t30 落實指定詳情順序與對話模式，保持掛載／狀態以避免切換遺失草稿；等待 API 時可使用明確標示的合成資料。不可用假狀態宣稱真驗證通過。
3. t31 落實編輯週期與版本摘要交易，兼容舊資料；刪除／取消後的遲到結果不能恢復草稿或繼續驗證。
4. t32 將既有 Playwright recipe 拆成按任務載入的 skills，摘要模式無寫腳本工具；不建外掛平台。實作 skill 檔時載入適用 skill-creator／writing-for-agents 規範。
5. 各 owner 回報檔案、介面、實際最小驗證及剩餘限制；PM 整合後才派 t33 跑主流程。無新變更則不重跑已通過檢查。

M8 依相同方式先固定 proposal／機密／網路政策再並行；Runtime 不能只提供 prompt 禁止越界就宣稱交付。出站限制涉及 deploy 的部分由 t32 提出需求、PM 修改。無法在現有依賴完成的項目回報具體阻塞，不私自安裝。


## M8 首波已派工（2026-11-12）

使用者授權M7現況提交後直接推進M8；commit bc5f86d，尚未push，M7未完成的整合證據照實保留。t30/t31/t32皆已核對sol/xhigh；現有scope不變。

- t31：一次最小Server提案（Workspace/設定對話/proposal/明確確認/資源scope/AEAD機密與任務授權），PM固定v8前不改共同介面。
- t32：一次最小Runtime提案（workspace-author@1/登入工具/全通道出站限制/機密生命週期及證據處理），列出deploy必要接縫，不以提示詞或browser route冒充隔離。
- t30：Workspace建立/修改對話與切換首切片，先做不依賴新API的結構；秘密欄位獨立、不進一般對話或瀏覽器持久儲存。新API/proposal/保存等v8固定，不假造成功。
- PM：對齊兩提案，固定一次契約後派實作；M7隔離18085維持供後續整合。t33不提前重跑；可操作切片完成再派黑箱。

## M8 下一波：全鏈整合

沿用 t30/t31/t32 sol/xhigh 與原owner界線。PM管隔離部署、整合與docs/contracts；t32提供真Manager→Worker登入/LiveView最短接線並修Runtime阻塞；t31提供真API生命週期接線並修Server阻塞；t30提供一條QA旅程操作清單並修Web阻塞。三位不另跑已通過檢查、不自行部署/Git。真環境就緒再交t33 Muse黑箱；無模型resolve切片先行，真AI及人工作業最後驗收。

### 驗收併行（使用者明確授權）

新增可見Herdr QA subagent，覆蓋先前不另建Agent限制；全部Muse Spark 1.3 Contributor/xhigh，已從pane核實開始活動。t33維持UI旅程，owner scripts/test/m8-workspace-ui.cjs；t3b whippet-qa-live負責scripts/test/m8-live-ui.cjs及獨立m8-qa-live Test/Run；t3c whippet-qa-artifacts負責scripts/test/m8-artifacts-blackbox.cjs，只讀既有兩個成功Run報告。各自/private/tmp證據目錄，不共享viewer、不改同一草稿。PM執行QA沙箱無法執行的腳本及管理環境；原模組owner僅修實際缺陷。真AI接線由PM負責，不向Contributor提供金鑰。

### 最新啟動限制與剩餘驗收

使用者要求避免opencode mini（Herdr控管問題）；之後新QA一律標準opencode run並指定Muse Spark1.3 Contributor/xhigh。t3f負責scripts/test/m8-isolation-ui.cjs真UI唯讀Workspace隔離；t3g負責scripts/test/m8-login-live-ui.cjs登入LiveView遮蔽觀測，各自證據目錄。t33僅收尾原網路診斷，不再加新任務；既有mini待命pane不派新工。PM負責環境與真AI接線，保留原scope/credential邊界。

2026-11-12 使用者要求本波提交後全部換新對話：PM與後續owner/QA均不得續用舊長對話；沿新PM→t36的parent鏈、crew=1與既有space/tab維持同一Herdr RPG session。禁止opencode mini。精確啟動/環境/未驗事項以handoff/ui-ux-pm.md為新對話入口，舊owner只作歷史證據。

最新更正：新 PM 要用 --no-parent 成為獨立 RPG 根，舊 t36 可以關閉；所有新派工 parent 鏈歸新 PM，不再歸 t36。t3q/t3r 錯誤鏈已停止，未開新 Run。


## M10–M12 分工（2026-11-13）

任務與狀態只在 [implementation.md](implementation.md) 的 M10–M12 章節維護。角色與寫入範圍沿用「M7–M9 當前分工」；模型路由與啟動方式依 handoff 的最新指定，不默默替換。所有 Agent 不自行 commit／push、不重啟共享服務、不讀取或印出 deploy/.env.ai；依賴安裝只限該階段契約明列的項目。

| Owner | 寫入範圍 | M10 | M11 | M12 |
| --- | --- | --- | --- | --- |
| PM | docs、contracts（含 `contracts/tools/`）、deploy、根建置設定、Git 分支與 tag | v10 契約、整合 smoke、M10.Z | v11、接入指南、M11.Z、merge | 裁定引擎、M12.Z、merge |
| t30 Web | apps/web | Module、Use Case、Plan、partial 卡 | Token、authorEngine、稽核 | engine／provider 設定 |
| t31 Server | services/server | Test.kind、依賴、Catalog、tool IPC、Plan 調度、原子發佈 | MCP 端點、Token、接單租約 | engine 設定快照 |
| t32 Runtime | services/manager、runtimes/worker、runtimes/agent-bridge | AgentEngine、G1–G6、skills、多檔 runner、新工具 | session 模式與代理 | spike、adapter、agent-bridge |
| t33 QA | scripts/test/golden、scripts/test/m10-*、m11-*、m12-* | 黃金任務集、M10.Z 黑箱 | M11.Z 黑箱 | 引擎比較、M12.Z |

### 首波（M10）派工

1. PM 請 t31／t32 各回覆一次最小差異（只盤點，不改共同介面），之後固定 v10。
2. 契約固定前就可以開始、不依賴新介面的工作：t32 做 M10.1（內部重構，wire 不變）；t33 做 M10.8 黃金任務集；t30 用標示清楚的合成資料先做 M10.7 畫面結構。
3. v10 固定後：t31 做 M10.3 → M10.5；t32 做 M10.2、M10.4 → M10.6；t30 接真 API。
4. 每位 owner 回報修改檔案、介面、最小驗證與剩餘限制；PM 整合後做 M10.9，再派 t33 執行 M10.Z。

M11、M12 依相同方式進行：先固定契約，再並行開發，最後做 Z 項完整驗證。分支只由 PM 建立與 merge；owner 在 PM 指定的分支上工作。

## M11 最新路由（2026-11-14，覆蓋歷史模型／tab 規則）

獨立 PM t52 直接對使用者負責，parent=null，gpt-6-astra low。新 Server t53 與 Runtime t54（及後續 Web／QA）統一 gpt-6-sol high；全新對話，parent=t52、crew=1、keep/outlive-parent、明確 repo cwd，Codex no-daemon／完整 YOLO。不得續用舊 owner 或帶入 herdr.tab。

同 space `spc410627697c591af2a35cc533b8f1ad8` 實核新 tab：PM `tb0c4939cce7992d29f9b08b2d3c759df8`（Whippet M11 PM 11-14）、Server `tb03591fb11813679ec68a0c2462ea5ed8`（Whippet M11 Server 11-14）、Runtime `tba56c70dc8c17110664c12a5c0da3684c`（Whippet M11 Runtime 11-14）。三者 argv／parent／cwd／活動皆已核對。

檔案 owner 維持原角色邊界；最多三實作加 PM。子 agent 不 Git／部署／重啟共享服務。M11 先隔離測試，不動19287。首波收集 Server／Runtime 最小介面，由 PM 固定 v11；Web 待介面穩定再啟動。後續本地階段 commit 可執行，不自動 push／merge／tag。

首波介面固定後啟動 Web t55（gpt-6-sol high、parent=t52），獨立 tab `tb2081d7e3947353996d4de83b21a5e8e8`，命名 Whippet M11 Web 11-14；argv/keep/outlive-parent/cwd/working 已實核。唯一 owner apps/web，先接管理gate、Token與稽核，不啟用尚未實作external engine。

Web首切片交付停寫後，新增QA t56（全新gpt-6-sol high、parent=t52、crew=1、keep/outlive-parent/no-daemon/YOLO），獨立tab `tba3ee94e316121c59de0a0a2402f1743b`（Whippet M11 QA 11-14），已核cwd/argv/working。QA只寫scripts/test/m11-*及專用tmp證據，先審首波跨入口與敏感狀態，不重跑已通過build。實作中為Server、Runtime、QA三位。

## M11 Wave 2（2026-11-14）

使用者已明確授權首波 commit/push 與下一波，feat/mcp 已推送至 39c15cc；另授權多位 QA 並行及本機安裝 Whippet MCP。三位全新實作 owner 為 t58 Server（services/server）、t59 Runtime（services/manager、runtimes/worker）、t5b Local transport（scripts/local-mcp）；QA t5c 只寫 scripts/test/m11w2-lease-*，t5d 只寫 scripts/test/m11w2-browser-*。PM 保持 docs/contracts/deploy/Git owner。

以上五位皆已實核 parent=t52、gpt-6-sol high、no-daemon/YOLO、crew=1、keep/outlive-parent 與 repo cwd；獨立新 tab 分別為 tb8f290fddf29358dcdf375296f107ebeb、tb464ca566dbdfddffa3e04f6060a7009f、tb9a82f197d54d1e3e1cb2d9840688637d、tb27fe8d8637546b54ac94e80ab6dac529、tbb63bd9e6ac285b7471fd6c222e462ebb，均在指定 space 命名。未繼承 herdr.tab，未喚醒首波舊 owner。

本波契約以 v11 Wave 2 與 registry11.0 為準：匿名四項 browser 工具與租約 open/status/close，持久 requestId/callId 去重與確認回收。QA 分別驗 fake Manager 異常及真 Docker 全鏈；不把兩者證據混用。login/LiveView/claim/互動寫入仍未整合，19287 保留。

本機實接QA t5f為全新gpt-6-sol high／parent=t52，argv/cwd/keep/outlive-parent/working已核，獨立tab `tb65ebfdd9f517da7b88a8a10c3cf54b94`（Whippet M11 Local MCP QA）。只以已註冊MCP讀Catalog/resources，不讀憑證檔、不以shell HTTP取代MCP，不改repo。

## M11 Wave3（2026-11-14）

使用者授權儘速推進剩餘wave，主線為網頁對話→MCP Agent接單→完整腳本E2E。全新owner t5g Server（services/server）、t5h Runtime/transport（services/manager、runtimes/worker、scripts/local-mcp、runtimes/agent-bridge）、t5j Web（apps/web）；QA t5k只寫scripts/test/m11w3-ui-*，t5m只寫scripts/test/m11w3-lease-*。各自gpt-6-sol high、parent=t52、crew=1、keep/outlive-parent、no-daemon/YOLO、repo cwd與working已核。

新tab依序為tb9e89cf829b34ecc2b287216202d46310、tbb14905f18c014e02a554ece83efbcae4、tbde84b4868afe05b0135877a7c99a1436、tba70dad631b91f60ab33aff91879dbb74、tb5fc86a53c77f8b674897c4470fccfc40，指定space各自命名，沒有herdr.tab繼承。PM sole docs/contracts/deploy/Git；舊owners已結束、不復用。測試獨立環境，不碰19287/19587。v11 Wave3與registry11.1先固定後實作。

真接單工作者t5n（Whippet M11 W3 MCP Author）為全新gpt-6-sol high、parent=t52、keep/outlive-parent/no-daemon/YOLO；metadata與working已核，獨立tab tb10442dc5bc91600cd5f997198c895888。本對話停用既有whippet，僅接私有測試whippet_e2e；Token經0700父目錄內0600 UNIX socket留記憶體，非secret argv/config。只用MCP領單/探索/提交，QA不代寫腳本；不Git/部署。

本次真接單初始t5n因PM指定不存在Python executable而MCP啟動失敗，未claim；修正前先以實核Python路徑驗四工具存在，再開全新t5p，並非模型盲重試。t5p為同模型/effort與parent，metadata已核，tab tbdbdb7e50bd6f916da806fb7686a8446d（Whippet M11 W3 MCP Author Fixed）。t5p真MCP接單/探索/提交成功，t5k真UI與formal validation全PASS。
