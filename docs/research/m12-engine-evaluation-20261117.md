# M12 引擎比較與預設決策

2026-11-17（Asia/Taipei），獨立Leader；基於feat/agent-adapter 740415b及Wave14必要代表驗收。**維持builtin預設，Vercel保持明確opt-in。** 採用Vercel作正式adapter的M12.0選型不變；目前證據可支持這個有界接縫與新UseCase流程可用，尚不足以證明全面品質或效率優於builtin。

## 比較範圍與來源

依使用者「新引擎只跑必要代表子集、沿用builtin證據、不重跑M10／M11全量」限制，本次不再跑舊14題或付費builtin。下列資料分開呈現，沒有混成同一批成功率：

| 引擎／資料 | 成功觀察 | 模型／工具 | input／output tokens | 延遲 |
| --- | --- | --- | --- | --- |
| builtin：已驗M10／M11／Wave8證據 | 各已驗功能沿用；原14題同批無人工全過未證實 | 這份比較沒有匹配的新量測 | unknown | unknown |
| pi0.73.1原native spike，G01/G03/G09/G11 | 3 PASS／1 FAIL（75%）；G01與其餘題分兩次啟動，非單批全過 | 5／3 | 11485／3206 | 四題合計33868ms；平均8467ms |
| Vercel7.0.173原native spike，同四題 | 3 PASS／1 FAIL（75%） | 5／3 | 11332／3120 | 四題合計35500ms；平均8875ms |
| G11補齊G01必要資料後，pi／Vercel | 各1 PASS，**assisted**另列 | 各1／1 | pi2397／724；Vercel2395／767 | pi6430ms；Vercel6337ms |
| 正式production Vercel，Wave14新UseCase | 1筆代表流程PASS；包含腳本化確認／UI發佈，不是原黃金14題 | 12／11（僅實際模型三個role） | 54727／4493 | 三role client latency合計54011ms；整條Go流程64400ms |

原spike數據來自[原選型](m12-engine-spike-20261116.md)及其保留的[pi G01](evidence/m12-engine-spike-20261116/pi-native-g01/summary.json)、[pi其餘三題](evidence/m12-engine-spike-20261116/pi-native-subset/summary.json)、[Vercel四題](evidence/m12-engine-spike-20261116/vercel-native-subset/summary.json)。G11原FAIL因獨立題目缺G01 fixture，沒有覆寫；[pi assisted](evidence/m12-engine-spike-20261116/pi-g11-context/summary.json)與[Vercel assisted](evidence/m12-engine-spike-20261116/vercel-g11-context/summary.json)不可拿來重算原四題全過。兩個spike樣本小，延遲受provider變動影響；builtin缺同條件量化資料，不能據此宣稱誰較快或成功率較高。

builtin沿用[M10.Z Wave8交接](../tracking/handoff/m10z-wave8-20261116.md)、[M11最終交接](../tracking/handoff/m11-final-20261114.md)與受控安全證據，不讀舊Agent對話／screen或重啟退役環境。供應商金額計價不在M12範圍，這裡只記provider回報tokens，不虛構金額。

## 正式新引擎代表流程

目前checkout的Vercel adapter、registry16.0、打包skills與Server runtime快照，經正常Server排入三個實際模型role，固定OpenCode Muse muse-spark-1.3-contributor／xhigh：

| role | 原snapshot上限（模型／工具／時間／output） | 實際模型／工具 | input／output | client latency |
| --- | --- | --- | --- | --- |
| usecase-planner | 8／12／180000ms／8192 | 6／6 | 22833／1073 | 17200ms |
| module-authoring | 8／12／180000ms／16384 | 5／5 | 29144／1832 | 20168ms |
| acceptance-summary | 1／0／180000ms／8192 | 1／0 | 2750／1588 | 16643ms |

沒有模型失敗重送、引擎／provider fallback或額度提高。複用seed先走真Playwright正式驗證、**合成transport**摘要及正常發佈；其1次合成模型／20+10假token另標synthetic，不混入上表。原預演誤用無正式證據fixture版本時，整批摘要被正確拒絕；改走實際seed驗證，沒有放寬發佈條件。[實際結果與統計](evidence/m12-wave14-20261117/live-summary.json)。

實際planner讀草稿／Plan／打包reference、Catalog查找與propose_plan，保存兩段draft。控制harness腳本確認Plan後，Module經原staging＋commit自試完成；Server正式Module驗證→Compose→正式UseCase驗證→真模型批次摘要→真PlanPanel人工確認控制項與整批發佈，產生1個新Module及1個UseCase版本。前面的「人工」指產品確認控制項由測試腳本操作，不宣稱本輪有人手動點擊或原題全自動通過。

三份正式Playwright報告（seed、Module、UseCase）各expected1／unexpected0／flaky0／skipped0；另用固定獨立acceptance spec執行**原Module本體**，核對name=alpha、真按鈕點擊後role=status實際顯示done-alpha及回傳{name,status}，1/0/0/0。獨立spec沒有替換正式bundle或修改其hash。只涵蓋本機setContent合成頁單一路徑，不代表真外部網站／登入／所有輸入；正式報告是實際keyless Docker Worker產物，模型transport則確為真provider。

UI單次確認checkbox及POST200、pageerror0／HTTP錯誤0，390px無水平溢出；[UI receipt](evidence/m12-wave14-20261117/live-first/ui/result.json)、[桌面](evidence/m12-wave14-20261117/live-first/ui/desktop.png)、[窄版](evidence/m12-wave14-20261117/live-first/ui/narrow.png)均已目視。控制工具透過僅本次Run可用的測試broker接真HarnessPlatform／PG；Manager使用真assignment／artifact parser bridge，沒有宣稱此波重跑完整Manager WebSocket／TLS生命週期，該段沿用既有bridge／MCP證據。

目前候選Worker映像固定sha256:d9526cd4ee5e8535808f44270c44a492bce8997650a14fff9b652d8d677e7775，從明列的最小source context建置；SDK及lockfile版本不變。瀏覽器／自試容器停網、唯讀root、只掛本波私有輸出、沒有模型key環境；未部署至builtin／MCP固定基準。模型在host的正式runAuthor／Vercel engine內執行，beforeRequest、註冊表及原用量守衛仍生效。

## 裁定與未驗證

- 四個淘汰條件、工具註冊表／取消／遮蔽／Responses接縫沿用M12.0及正式adapter的實驗與定向測試；歷史／原稿引用、來源記憶、Module局部編輯、Module／Stage原額度checkpoint由Wave6–13各自驗證。這次新UseCase支持整體接線，沒有取代這些守衛或原發佈E2E要求。
- 保留builtin預設。Vercel可由已驗runtime profile明確選擇；要切預設，仍需可比較的品質證據，這輪沒有得到builtin同條件metrics或原14題無人工同批全過，不能憑SDK名稱或單筆新成功直接切換。
- 第二provider真測為**UNVERIFIED**：目前受控Muse設定及兩個預設engine profiles均屬opencode；父程序沒有OPENAI_API_KEY、ANTHROPIC_API_KEY或第二runtime profile設定。沒有借用其他服務金鑰或自行選新模型／effort。[非機密可用性紀錄](evidence/m12-wave14-20261117/provider-availability.json)。M12.Z允許金鑰不可用時明列未驗證。
- 原始失敗、assisted分類與未驗證項目維持；任意大產物、任意長對話全量語意、程序崩潰／取消的隱式checkpoint與跨全Plan金額／帳號配額沒有宣稱提供。未merge／tag，來源不等於部署。

全部raw保留於~/.local/share/whippet/evidence/m12-wave14-20261117；Git保留必要receipt／來源assignment／真結果JSON／UI圖片及完整[raw SHA索引](evidence/m12-wave14-20261117/raw-index.json)，不把重複HTML／artifact store塞入Git，也不覆寫任何舊raw。

## Wave15補充：指定三階段與品質界線

M12.Z指定的1複用＋2新Module及發佈後正式執行，最後以ASSISTED Plan review＋凍結原真模型Module產物重播完成；5份正式與2份獨立報告各1/0/0/0。原三段自主Plan提案未通過fixture契約（6實際模型請求），保留FAIL；具體差異在舊fixture清除前未捕捉，沒有假定原因或宣稱自主提案已修好。後續獨立fixture漏heading前提已補齊，兩Module原body／metadata／harness完全不變。完整來源與逐步判讀見[M12.Z集中紀錄](m12-stage3-verification-20261117.md)。

Wave15真provider合計16請求／15工具、85010 input／11200 output，含原失敗planner；重播用合成transport並明列，不算新的provider成功。這進一步支持保留人工Plan檢視與builtin預設；不是原14題無人工同批全過證據，也不與Wave14單新Module的無修稿代表流程混成一個成功率。
