# M12.1 Wave1：Worker 引擎接縫

狀態：2026-11-16 Wave1 已實作。本節固定 Runtime 內部接縫與後端設定；**沒有升級 HTTP／WS protocol_version、修改 Run dispatch 或放寬 v10 author.json**。Workspace／skill 的 engine、provider 快照屬 M12.2；跨 Run 總嘗試／成本界限後續另訂，不能由本節推定完成。

## 後端選擇

| 環境設定 | 規則 |
| --- | --- |
| `WHIPPET_AI_ENGINE` | `builtin`（缺值預設）或 `vercel`；未知值拒絕，不 fallback |
| `WHIPPET_AI_PROVIDER` | `opencode`（預設）或 `openai-responses` |
| `WHIPPET_AI_BASE_URL`／`WHIPPET_AI_MODEL` | HTTPS base URL／單一模型ID；opencode沿用原預設，其他provider必填；不從SDK catalog或環境自動探索 |
| `OPENCODE_API_KEY` | 只供opencode使用 |
| `WHIPPET_AI_API_KEY` | 只供顯式openai-responses使用；缺值不借用OPENCODE_API_KEY |
| `WHIPPET_AI_CONTEXT_WINDOW_TOKENS` | 未知模型／非已核endpoint使用Vercel時必填；正整數1024..2097152。已知Muse profile只適用精確OpenCode Responses base URL，允許降低、不允許超過官方容量 |
| `WHIPPET_AI_CONTEXT_INPUT_TOKENS` | 保守輸入估算上限，缺值65536；正整數1024..context window，不代表模型實際tokenizer |

reasoning effort仍使用原設定與skill快照，模型／effort／output cap不由adapter改選。Manager只對author容器傳上述白名單名稱與既有AI設定，不把值寫入input.json／journal／docker arguments；一般run不繼承AI設定或key。沒有自動provider重試、模型切換或payg fallback。現有Server派工仍以原skill快照為權威，provider/model不匹配即拒絕；此Wave不提供UI切換。

## AgentEngine

- `beforeRequest(context)`維持原context陣列介面。
- 新增`prepareRequest(body)`，接收完整序列化Responses body，回傳完成noSecret／secrets.clean後的body。builtin支援此選填鉤子；正式Vercel adapter要求存在，由runAuthor提供。執行順序為SDK序列化→固定模型／工具／預算→context準備與安全壓縮→final guard→容量／bytes檢查→既有request傳輸。
- 工具只來自同一份registry。schema／單次限額與guard dispatch仍由Whippet驗證；無SDK內建fs、shell、eval、fetch工具。SDK使用dummy key，其fetch接縫委派既有request；實際key、TLS、session header、heartbeat與noSecret仍在既有傳輸內。
- builtin與Vercel共用output cap驗證、三回合Test／Planner與五回合Module收尾保留、partial文字規則。總模型／工具／時間額度不變；Vercel retries=0、工具依序執行、重複call ID零重做。
- SDK文字答案不能覆蓋`pendingWork()`。在既定總請求尚有餘額時，附上guard尚未完成的工作繼續；耗盡則partial。guard確認交付後立即結束。

## 容量與壓縮

- 已核實OpenCode公開metadata：Muse Spark 1.3 Contributor context=1048576、output capability=131072；**Run output仍為原8192，Module依原快照最多16384**。capability來源與SHA見本Wave安全證據。
- text-only估算為serialized input／instructions／tools的UTF-8 bytes，加512 framing allowance。另保留Run output與1024 safety tokens；可用input取模型剩餘容量與後端input cap的較小值。此為保守預檢，不宣稱精確token計數，也不支援原生image／file輸入的容量估算。
- 達80%門檻才嘗試壓縮舊工具結果。保留全部初始對話、目前草稿／Stage、原始限制、決策與證據；保留所有call/result ID／順序及provider reasoning；最新一份工具結果保留全文。
- 只壓縮可由**當前提供工具**取回的`catalog_get(moduleVersionId)`成功結果及`read_skill_reference(skillId,referenceId)`。必須與回傳固定ID相符；原文仍在Server不可變版本／打包且hash固定的reference。summary保留身分、metadata、原文hash與精確read-back args，標明DATA與非驗證證據。不得將draft／report／Plan／未知結果改成不可取回摘要；G5舊snapshot修剪照舊。
- 不執行隱藏取回、不消耗額外模型請求；模型若需原文，走既有工具及同一預算。壓縮後仍超界則停止；不提高上限或默刪受保護資料。

## partial與觀測

- 引擎內部新增`context_capacity`／`output_truncated`原因。Worker輸出仍使用既有`partial.reason=budget_exhausted`，message／nextStep如實說明容量或截斷，不能誤稱8次請求都已用完。
- checkpoint始終從Worker guard重建。截斷保留固定`INCOMPLETE_MAX_OUTPUT_TOKENS`分類，未執行半份args；有可信checkpoint才回partial，否則安全失敗。容量預檢可以在零HTTP時回未完成結果。保留guard原有的剩餘工作文字，不以引擎自報稿取代。
- Module／Planner／summary既有partial限制不變；沒有新增跨Run Module checkpoint，也沒有排入隱式continue或正式validation。
- Manager額外接受`author:context:compacted:N`，N僅1..12，不含內容、雜湊、路徑或機密；其他自由文字仍拒絕。取消沿用AbortSignal與Manager回收後才釋放slot，不宣稱能終止供應商遠端計費。
