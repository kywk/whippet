# AI 對話編輯

每個測試有一個持久對話。先儲存手動修改，再送出測試需求；AI 取得已儲存草稿與近期對話，探索網站後提出或寫入新草稿。可在同一對話說明需要調整的步驟與斷言。

author 任務與測試共用 Manager 的 FIFO／MAX_WORKERS。每次回合結束即回收容器，等待 QA 不占名額。若 AI 要求驗證，由 Server 另外排入普通 validation 任務，產生與 M2 相同的報告。發佈仍需要 QA 查看報告並明確確認。

AI 執行中若有人儲存另一份草稿，結果不會覆蓋新 revision；對話保留候選腳本，可比較後自行套用。AI 呼叫失敗或取消時保留原稿，可用新訊息重試。系統不會自行重跑同一 author attempt。

## 啟用 Runner 的 AI 設定

先依 [OpenCode Go 指南](opencode-go.md) 填妥本機 `deploy/.env.ai`，設定 `WHIPPET_AI_ENABLED=true`。使用者提供的 key 只放本機忽略檔，不提交。

從 repo 根目錄啟動具 AI 能力的本機 Manager：

```sh
docker compose --env-file deploy/.env --env-file deploy/.env.ai \
  -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml \
  -f deploy/compose.runner.ai.yml up -d --no-build manager
```

Manager 讀取 AI 設定，只注入 author 容器；一般 run／validation 沒有 AI key。Author 可使用瀏覽器工具，不直接執行生成的 spec。生成腳本的實際執行一律走另外的無 key 驗證容器。

非同機部署可省略 `compose.runner.local.yml`，並依本機指南設定可達的 SERVER_URL。首次升級需重建 Server、Web、Manager 與 Worker 映像。

## 範圍與限制

目前採原生 Responses、Muse Spark 1.3 Contributor xhigh、固定對話 session ID。每輪最多8次模型請求／12次工具呼叫／180秒；前端短輪詢狀態，不提供 token 串流。近期對話有限長，完整歷史保存在 DB。

工具包含讀／更新草稿、讀取最近驗證狀態與錯誤摘要、瀏覽器導航／頁面摘要／點擊／填寫及請求驗證。MVP 沒有 SSO、MFA、自動發佈、任意 shell／eval 工具或多 Agent 自治。網站內容與工具結果視為資料，不應改變使用者測試目標；敏感網站仍需依實際模型資料政策決定是否使用 Contributor。

本機代表流程已於2026-11-11驗收通過，含實際生成失敗後的同對話修復；見 [M3整合紀錄](../tracking/devlog/m3-integration.md)。即時影像屬 M4。

## 本機合成示範網站

本次驗收的 `m3-smoke-1794392723020` 使用本機18082的合成待辦清單。fixture容器保留運行；如需重新啟動：

```sh
docker run -d --rm --name whippet-m3-fixture -p 127.0.0.1:18082:8080 \
  --mount type=bind,source="$(pwd)/scripts/test/fixtures/m3-site.cjs",target=/tmp/site.cjs,readonly \
  --entrypoint node whippet-worker:m1 /tmp/site.cjs
```

Mac Docker Worker使用 `http://host.docker.internal:18082`。停止示範用 `docker stop whippet-m3-fixture`；這不影響平台，但使用該URL的合成測試將無法執行。

## Playwright 基本技能

Author 每輪會載入 [`playwright-authoring`](../../runtimes/worker/skills/playwright-authoring/SKILL.md)，將內容放入每次 Responses 請求的 instructions，不只是提供一份供人閱讀的文件。技能隨 Worker 映像封裝，以模組位置定位，不依賴啟動目錄；缺失時停止 author 任務並回報錯誤。

技能包含先觀察頁面再選 locator、getByRole／getByLabel、listitem 文字比對、自動等待與可重試斷言、完整 TypeScript 腳本及測試隔離。修復時先讀驗證錯誤，保留原測試意圖與斷言，不用 skip、硬等待或放寬斷言換取通過。探索工具接受 literal CSS／text selector，生成的 Playwright 腳本則可使用完整 Locator API。

這是精簡的 MVP 基礎技能，沒有增加檢索框架或模型請求。是否正確仍以獨立 validation 的真實 Playwright 執行為準；技能本身不保證模型每次都能一次產稿成功。

需要截圖證據時，技能會引導 Agent 在關鍵斷言後以 `testInfo.attach` 附加 PNG；報告附件由平台保存。失敗自動截圖已開啟。實際範例與 PNG 驗收結果見 [本機驗收指南](whippet-acceptance.md)。
