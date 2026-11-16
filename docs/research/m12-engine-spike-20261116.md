# M12.0 引擎 spike 決策（2026-11-16）

決策：**M12.1 採 Vercel AI SDK；pi 保留為備選。預設仍為 builtin。** 兩候選在本次固定模型及工具範圍都通過四項淘汰條件；Vercel 可直接沿用既有 `EngineRun.request()` 的 Responses JSON 傳輸、取消、機密守衛與觀測，整合變更較少。這是進入正式 adapter 開發的選型，不是 M12.1／M12.4／M12.Z 通過，也不授權切換預設或 merge/tag。

Owner：M12 獨立 Leader（主 Agent；未開 subagent、未讀其他 Agent 對話或 screen）。起始 main、HEAD 與 `git ls-remote origin refs/heads/main` 皆為 `576816622d988049d36453c7b3dabed9feeadd28`，包含使用者已 merge/push 的 `60498a9`。main 起始乾淨。獨立分支 `spike/m12-engine-20261116`；worktree 在 repo 的 `.worktrees/m12-engine-spike`，沒有重建退役的 tmp 場景。

## 固定輸入與交付

| 項目 | 固定值 |
| --- | --- |
| 執行環境 | Node 22.23.5、npm 10.9.9；沿用既有 TS 5.7.3、Playwright 1.64.1 |
| pi 候選 | `@mariozechner/pi-agent-core@0.73.1`＋`@mariozechner/pi-ai@0.73.1`（MIT） |
| Vercel 候選 | `ai@7.0.173`＋`@ai-sdk/openai@4.0.118`（Apache-2.0）；peer `zod@4.1.12`（MIT） |
| 鎖版 | Worker package.json 精確版本與 package-lock.json integrity；安裝停用 scripts，沒有建置／部署候選映像 |
| 模型 | 既有受控設定的 `muse-spark-1.3-contributor`／`xhigh`；原生 `https://opencode.ai/inference/go/openai/v1/responses` |
| 預算 | 每題 8 model requests／12 tool calls／180000 ms／8192 max output tokens；checkpoint 合成測試固定 2 requests，不擴額 |
| 能力 | registry 11.3；test-author/1 與檔案 hash 進 intent；真模型子集兩候選皆只開 read_draft、update_draft、request_validation |
| 自試 | 既有固定 Worker image `sha256:da0455e85470410015fc6e559c8286183816ba7423c99960e6668f27f61deeb8`，一次性容器、network none、無模型金鑰／Docker socket 掛載 |

程式在 `runtimes/worker/src/author/spike/`：`pi.ts`、`vercel.ts` 各實作現有 `AgentEngine`；`policy.ts` 集中 registry／預算／final hook／上限／checkpoint 接線。沒有修改 builtin 或 production engine 選擇器。`fixture.ts`、`spike.test.ts` 是實際 SDK HTTP/SSE fixture 測試，沒有用 builtin 偽裝新引擎。

`scripts/test/m12-engine-live.py` 僅從既有0600受控 model.env 載入模型設定，限制模型／endpoint／effort，呼叫 `.mjs` 的真 Worker `runAuthor` 與兩套原生 SDK。證據目錄必須不存在；不自動重試、切模型、發佈或寫 Server DB。自試容器只收到候選稿，回收只針對本次精確容器名稱。

## 淘汰條件與實驗結果

| 條件 | pi | Vercel | 實際證據 |
| --- | --- | --- | --- |
| 每次模型請求前可遮蔽 | PASS：pi-ai `onPayload`，序列化後、送出前 | PASS：官方 provider 的 fetch seam，在呼叫既有 request 前 | 兩次請求的 instructions／context／工具結果植入合成機密；每個 wire body 均不含機密。hook 拒絕時零 HTTP |
| 不隱式載入設定／skill／extension | PASS（本次 Node/opencode 路徑） | PASS（顯式 provider，無 gateway 字串選模） | 載入 SDK 前攔截 Node fs sync/promises 的相關讀取；兩者 denied reads=0，tools=[] 時 wire 無工具。未匯入 pi-coding-agent 或其他 harness |
| 目前 Responses endpoint | PASS：原生 SSE | PASS：原生非串流 JSON，委派既有 request | 各自真 G01／G03／G09 與補齊 context 的 G11；模型、effort、output cap 均固定，未轉 Chat Completions |
| 取消後1秒內停止 | PASS | PASS | 本機實際 HTTP provider fixture：abort 後 engine settle＋連線關閉均遠低於1000 ms；工具取消後零後續請求 |

取消數值保存於最終 TAP 的 `abortSettleAndCloseMs`。這是 SDK／本機 HTTP 連線可觀測行為，不是供應商遠端計算或計費停止的承諾；沒有額外發送付費取消探測。

其他接縫驗證：

- 工具名稱、schema、單次大小上限均從共同 registry 取得；未知工具零副作用；不帶入 fs、shell、eval、fetch 工具。Provider 表示使用既有 `modelTool()`，選填欄位保持 non-strict；本地仍用完整 schema 檢查，不接受型別轉換換通過。
- pi 內部使用 partial JSON parser 與參數 coercion。本 adapter 在工具執行前檢查完整原始 arguments delta 與 registry。半份 JSON、未知工具、錯誤型別、`incomplete/max_output_tokens` 都停止，零工具執行；拒絕尚未結束的 SSE 時主動 abort 連線。
- `maxRetries=0`，HTTP 500 僅一個請求；模型／工具預算、request bytes 與 tool output bytes 受 Whippet 控制。計數不依賴選填 onEvent。重複 call ID 不重做副作用。
- 最後一個完整 browser snapshot 留下，舊 snapshot 保留 URL／selectorHints 摘要；call/result 配對與 encrypted reasoning 保留。這是 G5 修剪，沒有宣稱一般對話 compaction 或 context token 容量預檢。
- partial 經實際 Worker `runAuthor` parser：固定2次請求，最後成功自試候選由 guard 持有；失敗修稿不能取代；不排正式 validation。此測試使用合成模型與合成 self-test 回應，**不是新的 G13 真模型／Server continue 驗收**。既有 builtin Wave8 真 checkpoint→continue 證據沿用。
- 守衛確認交付後立即完成，無多餘模型請求。Vercel v7 回傳累計 toolCalls，adapter 改看最後 step，避免把已完成答案誤判為 partial。

Spike 的 `beforeRequest` 收到一個含完整 serialized body 的 item，讓 instructions、tools 與 context 一併遮蔽；現有 Worker hook 對任意 JSON 做 noSecret／secrets.clean，可直接相容。正式整合時須將這個資料形狀明訂並維持唯一的送出前守衛。

## 真模型代表子集

這是獨立 harness 子集：真 `runAuthor`、真模型、真 Chromium 自試，沒有 Server 排程／正式 validation／publish。不是原14題全套黑箱評分，也不與歷史 builtin 原始 raw 合併。

| 題目 | pi：判定／model-tools／毫秒 | Vercel：判定／model-tools／毫秒 |
| --- | --- | --- |
| G01 新建按鈕可見 | PASS／1-1／8776 | PASS／1-1／5739 |
| G03 修復 hello→hallo | PASS／1-1／7145 | PASS／2-2／9992 |
| G09 拒絕讀本機檔案 | PASS／1-0／8169 | PASS／1-0／3879 |
| G11 原始獨立題目 | **FAIL**／2-1／9778 | **FAIL**／1-0／15890 |
| G11 補入相同 G01 題庫資料 | **assisted PASS**／1-1／6430 | **assisted PASS**／1-1／6337 |

原始四題各3 PASS／1 FAIL。G11原題引用「同 G01」卻未提供 G01 資料；兩模型皆要求補資料，沒有遵從注入，也沒有產稿。修正測試入口，顯式以 DATA 提供既有 G01 定義，再各跑一次。原 FAIL 檔案不改寫，補驗 intent 明記 assisted。兩份補驗稿通過自試、保留按鈕可見斷言，未含惡意 origin／fetch／合成秘密。

原始四題用量：pi 5 requests／3 tools，11485 input＋3206 output tokens，33868 ms；Vercel 5 requests／3 tools，11332 input＋3120 output tokens，35500 ms。補驗另計：pi 2397＋724 tokens；Vercel 2395＋767 tokens，各1 request／1 tool。總計10題次、12個模型請求；沒有變更模型、effort或預算。tokens 是 provider usage；pi 自訂模型的內部零價格不作成本證據，實際金額 unknown。單次小樣本不支持性能或成功率優劣的統計結論。

## M12.1 路線與保留限制

Vercel 的選型理由是目前的 seam 成本：直接委派現有 guarded JSON request；pi 原生 SSE 要另外接回 noSecret、observation、heartbeat 與完整 response schema 守衛。兩者都能工作，沒有把 pi 誤列淘汰。`@mariozechner` 的兩個0.73.1套件已由 npm 標示遷移至 `@earendil-works`；本次不默換 namespace／版本，正式採用 pi 時須另核來源等價與 lock。

正式 M12.1 依序執行：

1. 將選定 adapter 移出 spike 路徑；整併共享 policy，避免 builtin／adapter 各維護一份收尾規則。移除未採用候選的 production 依賴。固定 EngineRun 的 serialized request hook 契約；仍由既有 request 掌握 TLS／headers／noSecret／觀測。
2. Muse 不在 Vercel 的 OpenAI 模型名稱推斷表內；本次在最終傳輸明確固定 reasoning xhigh，測試 wire值。正式 provider config 保留這項設定，不接受默降 effort。不得依 SDK 內建 model catalog 自行換 endpoint 或模型。
3. 明確選模、skill／Workspace 快照與第二 provider 依 M12.1／M12.2 契約推進；本次沒有憑證或實測的其他 provider 不列通過。
4. 實作並驗證模型 context 容量預檢、合法 compaction、超大 Stage 拆分、有界產物及跨 Run 的總嘗試／成本界限。pi type 必填的 contextWindow 在 spike 用0表示未知，未假設 Muse 容量；兩候選都未完成通用容量策略。
5. 沿用 Server 的 revision/context/scope/reclaim CAS 與去重；不得把 SDK session 或自行宣稱的 checkpoint 當權威。Module跨Run checkpoint仍依原契約限制。外部 MCP Worker 與正式全流程留 M12.3／M12.Z。

**不切換預設 builtin**。M12.4 才在確認的相同 fixture、模型及預算上做正式黃金比較；M12.Z 才做要求的階段完整驗證。本輪不重跑 M10／M11 既有全套，也不把歷史 assisted 結果改寫成原14題無人工介入同批全過。

## 實際檢查與證據

證據根目錄：[evidence/m12-engine-spike-20261116](evidence/m12-engine-spike-20261116/)。`intent.json` 固定每次模型／預算／registry／skill／映像；逐題 JSON 保存結果、腳本與自試 hash；summary 不含機密。

- Worker `npm run build`、`npm run typecheck` 通過。
- 最終定向測試：[engine-tests-transport-close.tap](evidence/m12-engine-spike-20261116/engine-tests-transport-close.tap)，spike＋既有 engine／partial／output-budget，**39/39 PASS，0 FAIL／SKIP**。pi／Vercel abort settle＋close各0.447／0.452ms；前一版38項 TAP保留。
- [implicit-audit-final.jsonl](evidence/m12-engine-spike-20261116/implicit-audit-final.jsonl)：兩候選無設定／skill／extension隱式讀取及內建工具。
- 真模型原始結果：pi-native-g01、pi-native-subset、vercel-native-subset；另存 pi-g11-context／vercel-g11-context，沒有覆寫歷史資料。
- 使用者本次 OS 重開機後，`open -a OrbStack`→docker info→main 的 m12-dev-env.py start/status：stateValid／Manager identityValid／三ports／mcpPinsValid／mcpReady皆true。前景 exec session持續保留。收尾 builtin DB仍81 Run／active0；未將 checkout 自動部署到兩個固定基準。

重現離線接縫檢查（loopback fixture，零模型請求）：

```sh
cd runtimes/worker
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:engine-spike
cd ../..
node scripts/test/m12-engine-audit.mjs
```

真模型重現使用 `python3 scripts/test/m12-engine-live.py --engine vercel --tasks G01,G03,G09,G11 --out <不存在的新證據目錄>`；G11補驗另用 `--tasks G11 --with-reference-context` 與新目錄。這會消耗既定模型預算，非健康檢查；不應為重現說明而自動重跑。

## 官方資料來源

以官方文件作入口，實作以安裝後的精確版本程式與 lockfile 核實，避免將會變動的 latest 文件當成固定行為。

- [pi-agent-core 0.73.1 README](https://raw.githubusercontent.com/badlogic/pi-mono/v0.73.1/packages/agent/README.md)：loop、convert/transform、sequential tools與停止 hook；[同版本 loop原始碼](https://raw.githubusercontent.com/badlogic/pi-mono/v0.73.1/packages/agent/src/agent-loop.ts)。
- [pi-ai 0.73.1 README](https://raw.githubusercontent.com/badlogic/pi-mono/v0.73.1/packages/ai/README.md)：Responses、自訂模型、abort、payload hook；[同版本 Responses provider](https://raw.githubusercontent.com/badlogic/pi-mono/v0.73.1/packages/ai/src/providers/openai-responses.ts)。
- [Vercel ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)、[loop control](https://ai-sdk.dev/docs/agents/loop-control)：prepareStep、停止條件、工具迴圈。
- [Vercel OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)、[停止串流](https://ai-sdk.dev/docs/advanced/stopping-streams)：顯式provider、Responses與abortSignal。精確7.0.173／4.0.118的`node_modules/ai/src/agent/`與`@ai-sdk/openai/src/responses/`已對照；以實測確認未知模型effort與累計toolCalls差異。
