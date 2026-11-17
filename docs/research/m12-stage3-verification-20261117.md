# M12.Z 限定驗收與交付紀錄

2026-11-17（Asia/Taipei），M12獨立Leader，未開subagent、未讀舊Agent對話／screen。M12.0–M12.4來源功能及使用者指定的必要代表驗收已處理；**指定三階段流程最終為ASSISTED PASS，不是全自動全過。** builtin預設不變，第二provider真測UNVERIFIED，原14題無人工同批全過仍UNPROVEN。不merge／tag／部署固定基準。

## M12.Z門檻對照

| 清單 | 實際證據與判讀 |
| --- | --- |
| M10／M11相關回歸 | 依使用者不重跑已通過全套的限制，沿[M10 Wave8](../tracking/handoff/m10z-wave8-20261116.md)／[M11最終](../tracking/handoff/m11-final-20261114.md)及M12各wave受影響測試；本輪只補5個引擎准入守衛及1條真HTTP MCP參考Worker流程，沒有假稱重跑M1–M11完整回歸 |
| 四淘汰條件與工具邊界 | [本輪5項](evidence/m12-wave15-20261117/adapter-release-guards.txt)全部PASS：明確選擇／不fallback、每次請求最終遮蔽、capacity失敗零請求、取消及socket關閉0.93ms<1000ms、不明工具／重複ID／HTTP錯誤與output限制不重試。真Responses另由Wave14／15實際Muse請求證明；[隱式audit](evidence/m12-wave15-20261117/implicit-audit.json)denied reads0、tools0 |
| 必要黃金觀察與預設決策 | [比較紀錄](m12-engine-evaluation-20261117.md)，保留原3/4及G11 assisted分類，維持builtin預設；沒有新增14題全量付費回歸或虛構builtin同條件metrics |
| 1複用＋2新Module→Compose→驗證→摘要→UI原子發佈→正式執行 | 最終**ASSISTED Plan review＋凍結真模型產物重播PASS**；實際發布兩個候選，發佈後固定版本Run succeeded。5份正式及2份獨立Playwright報告各1/0/0/0；不是最初自主提案一口氣通過 |
| 兩個provider | opencode／Muse真測；第二provider未取得受控profile及key，依清單允許條件明列UNVERIFIED，沒有換模型／effort或借key |
| MCP參考Worker接單 | [本輪真HTTP流程](evidence/m12-wave15-20261117/mcp-release-flow.txt)PASS：registry16、凍結原文8KiB讀回、合成model2次、遺失提交回應後同ID/body重送2次只套用1稿；臨時schema／fixture token與journal均回收，未動既有token／Vault |
| 候選來源／版本 | image d9526cd…與目前registry16、6個skill bundles及references逐byte SHA相符；ai7.0.173／openai4.0.118／zod4.1.12，production無pi。migration最少029；[准入比對](evidence/m12-wave15-20261117/candidate-source-admission.json) |

本輪5個guard＋1個MCP＋1個完整流程，共7個不同頂層目標有通過的限定結果；同一流程各mode／重播不重複計數。中間包含真失敗，不把它報成同批7/7全綠。模型全部維持原Muse muse-spark-1.3-contributor／xhigh及各skill原額度；本波真provider共16請求、15工具、85010 input／11200 output，包含最初失敗planner，並非只計成功部分。[機器結果](evidence/m12-wave15-20261117/final-summary.json)。

## 三階段流程與修正過程

1. `live-full`：真planner使用6/8模型、6/12工具，提案未符合指定fixture契約而停止，沒有Stage或付費重送。舊harness在assert之前未保存canonical Plan，因此無法回填是哪個欄位不符；現已修成先存完整Plan及每筆受限工具request，原FAIL原樣保留，不宣稱這個自主規劃品質缺口已修復。
2. `live-reviewed-plan`：透過原SavePlan／確認流程明確採人工檢視fixture。兩個新Module由正式Vercel／真Muse分別用5／4請求產生，均自試及正式驗證成功。第二份獨立fixture漏掉上游實際輸出的heading alpha，導致timeout；原Module本體、metadata、原harness皆正確要求且提供該前提。補齊獨立fixture的heading，原回傳／status／頁面不變斷言完整保留，沒有刪斷言或改候選。
3. `reviewed-frozen-modules-final`：不重花兩個Module的模型請求。明確以synthetic transport重播已產生的完整body／metadata／harness；比對來源receipt／assignment SHA、skill／registry／model／runtime及slug，重新經真Worker guard自試與Server正式驗證。兩組本體／harness／metadata與原真模型產物完全相同；這是**assisted replay**，不是新的無人工真provider全鏈。最後尚未執行的批次摘要才呼叫一次真Muse。

最終三段：已正式驗證／發佈setup回{name:alpha}→新m12-verify操作本機按鈕、核對實際heading／status並回{name,status}→新m12-confirm只讀既有頁面、核對傳入及真status相符、回confirmed:true。前後綁定皆由Server固定；Module不互相import。真UI勾選確認／POST200一次，兩Module與UseCase原子發佈；[發佈後Run](evidence/m12-wave15-20261117/reviewed-frozen-modules-final/published-run.json)確為該UI回傳的固定版本且succeeded。

正式報告5份＝seed、兩個新Module、整體UseCase、發佈後正式Run；獨立2份另外檢查原Module實際行為，第二份也核對頁面未變。範圍限本機DOM的alpha/done-alpha單一路徑，不代表其他輸入、真網站或登入。keyless Docker停網／root唯讀；Scope、pins、時間與token上限未提高。fixture seed摘要及重播的合成tokens不算入真provider總數。

[真UI receipt](evidence/m12-wave15-20261117/reviewed-frozen-modules-final/ui/result.json)有pageerror0／HTTP錯誤0、390px寬度符合。桌面圖已目視；原窄版full-page PNG出現Chrome拼接重複，保留原raw。harness改成等字型／layout再截viewport，另以相同真資料做**唯讀視覺snapshot**補驗：[上方](evidence/m12-wave15-20261117/visual-viewport-final/narrow-top.png)、[摘要](evidence/m12-wave15-20261117/visual-viewport-final/narrow-summary.png)，均已目視。這個補驗沒有模型或API寫入，不冒充第二次真發佈流程。

## 交付與剩餘界線

M12.1有界MVP能力、M12.2 runtime設定、M12.3普通Test MCP參考Worker、M12.4比較裁定及M12.Z在上述限定範圍交付完成。自主Plan的語意符合率及原14題全自動同批成功率仍是未證實品質指標；保持人工檢視與builtin預設，不以assisted補驗改寫原FAIL。第二provider需新的受控profile／key才能補真測。

任意長對話全量語意、任意大候選、取消／崩潰時隱式checkpoint及全Plan／帳號金額配額未提供；MVP原有限制與已同意範圍不變。保留基準全部必要status true、未更新新image或新schema；本波容器與UI程序均回收。部署對齊及重開機恢復沿[指南](../guides/mcp-agent.md#m12-候選來源與升級對齊2026-11-17)。完整新raw另存~/.local/share/whippet/evidence/m12-wave15-20261117，[SHA索引](evidence/m12-wave15-20261117/raw-index.json)含所有中間失敗；不覆寫歷史raw。
