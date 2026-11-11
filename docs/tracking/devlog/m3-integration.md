# M3 對話編輯整合驗收

2026-11-11，Asia/Taipei。Herdr t30／t31／t32 使用 Codex sol xhigh 完成 Web／Server／Runtime；t33 使用 OpenCode Muse Spark 1.3 Contributor xhigh 撰寫合成黑箱驗收，總指揮執行。

## 交付

持久 Conversation／Message、author FIFO 任務、限定工具迴圈、候選草稿及 revision 衝突保護、驗證摘要回饋、回合結束後續接 validation、前端對話／狀態／前後稿件對照／取消。M2 發佈門檻保留，AI 不能自動發佈。

Author 最多8個模型請求、12次工具、180秒；使用原生 Responses、Muse Contributor xhigh、conversation ID 作 session。Manager 只把 AI key 注入 author；瀏覽器子程序與普通 run／validation 不繼承 key。沒有新增 SDK／套件依賴或任意 shell/eval 工具。

## 建置與必要測試

- Web TypeScript／Vite build 通過。
- Server domain／HTTP 測試及正式 Go build 通過（0.391秒）；追加驗證摘要的兩項定向測試與 build 通過。
- Worker 正式 TypeScript build、6項 author mock 測試通過；驗證摘要修改後3項受影響測試通過。
- Manager M3 focused race 測試通過（1.606秒）；既有去重定向測試、驗證摘要轉傳測試通過。
- Server、Web、Manager、Worker Docker 映像建置成功。PostgreSQL migration 004 在既有資料庫套用成功，未重建 volumes。

## 真實模型流程與修正

使用本機合成待辦清單網站 `http://host.docker.internal:18082`，沒有傳專案原始碼或真實網站資料。真實 author 共3次：第一個在獨立測試中觸及步數限制；第二、三個在同一對話完成產生與修復／修改。

1. 首次工具探索缺少直接可用的 selector 提示，fill／click 各失敗一次，8次請求用完後任務 failed。原草稿仍 revision 1、空字串，沒有套用失敗候選。修正為固定 DOM extractor 回最多30個 selector hints，未提高步數上限。
2. 修正後 author `8ee04bd8-c894-4a96-b134-f7fb23b94e29` 以6次模型請求完成 navigate、fill、click、update_draft、request_validation；五個工具均成功，草稿 revision 2。獨立 validation `4e2d1182-2dc9-45ce-bd85-b67390ab0e76` 實際失敗：生成腳本錯用 listitem accessible name。此結果保留，不宣稱最初 happy-path 腳本全數通過。
3. 新增 `read_validation_report` 讀取當前草稿驗證狀態／最多4000字元錯誤快照。在**同一對話**追加修復並擴充為 alpha、beta 兩筆資料，使用 listitem 陣列文字與 status「2 tasks」斷言，沒有減少或略過測試目標。
4. 修復 author `81a6d542-c4de-435e-9c15-f15d3d697535` 以4次模型請求完成 read_validation_report、update_draft、request_validation；草稿 revision 3，validation `b6ade330-6680-4960-88e5-0d374e4219f0` succeeded 並產生報告。
5. `m3-repair-smoke.cjs` exit 0，送出 confirmed=true 後發佈 Version `4bc7a62a-efaa-4078-be6e-250d6d957092`。確認版本腳本等於 revision 3，重新取得同一 conversation、4則訊息及 baseScript／proposedScript。

可回到 UI 查看：Test `fa8e372a-42a3-4437-912e-374b7fcc03e2`，名稱 `m3-smoke-1794392723020`，Conversation `b5d40f48-a68c-4eed-bc2a-1130adb7fe40`。

## 隔離與 UI

`m3-key-isolation.py` exit 0：實際 author 容器 keyPresent=true，validation 容器 keyPresent=false。只輸出布林值及 Run ID，未輸出憑證。所有 author／validation Worker 已移除；等待使用者不保留 Worker。MAX_WORKERS=1 下續接驗證順利完成，沒有占住author名額等待驗證。

`m3-ui-smoke.cjs` exit 0：4則訊息／2則AI回覆、前後稿件513／623字元、報告Passed 1／Failed 0、未儲存草稿時送出disabled、重新登入後4則訊息與草稿完整保留。首次腳本誤選全頁隱藏版本pre；修正為最後訊息details內查找後通過，沒有改產品或降低斷言。

## 運作與限制

本機 Web `http://localhost:18080` 維持運行；AI 透過 `compose.runner.ai.yml` 啟用，本機 `.env.ai` 權限600且被Git忽略。合成 fixture 容器 `whippet-m3-fixture` 留在本機18082，方便重跑此次示範；停止它會讓這些合成URL測試無法執行。

M3 沒有 token 串流，採短輪詢；M4 WebRTC／即時監看尚未開始。驗收為 Mac／OrbStack 的 Linux 容器，不宣稱跨主機 Linux Server＋Mac Runner已驗證。AI 生成仍可能失敗，需要實際驗證與對話修正，未增加自動重跑或自動發佈。
