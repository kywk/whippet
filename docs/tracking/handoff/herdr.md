# Herdr 開發交接

M1 進行中，非完成。space: spc410627697c591af2a35cc533b8f1ad8。

| Terminal | 任務 | 模型 |
| --- | --- | --- |
| t30 | apps/web | gpt-6.1-sol xhigh |
| t31 | services/server | gpt-6.1-sol xhigh |
| t32 | services/manager + runtimes/worker | gpt-6.1-sol xhigh |

已由實際 terminal 畫面確認模型及任務開始。使用 hc wait/read/send 接續原 pane，不重派。各 owner 完成時留下 DELIVERY.md。共同契約 contracts/mvp-v1.md。

未安裝依賴、未做 Git 操作。測試路由保留 OpenCode muse spark 1.3/xhigh，尚未查明精確 ID，也未啟動測試 Agent。整合者下一步收取產物並寫 Compose，確認入口與命令後再安排測試。

## 整合回合

使用者同意繼續依賴準備與整合，已更新規範允許專案依賴／映像下載，仍不做 Git。t30 處理前端依賴/build/lockfile；t31 暫時兼任 deploy/、docs/guides/、README.md owner，處理 Server build 與 Compose；t32 處理 Worker build/lockfile。原有三個 pane 都已接收續派，勿重開同任務。
測試模型精確 ID 已核對為 opencode-go/muse-spark-1.3-contributor，支援 xhigh；等 build 產物就緒後透過 opencode mini 互動 pane 做 M1 成功／失敗兩條流程。

本機 M1 四個映像已成功建置。Server stack 已 up：localhost:18080 Web、18081 API；DB/Server/Web healthy，Manager 已連線 capacity1。Muse pane t33（實際 xhigh 已確認）改採不讀原始碼的黑箱方式；登入與列出兩個合成測試已通過。正在準備 /tmp/whippet-smoke/m1.cjs 的兩個真實執行與報告步驟。

## M1 收尾

M1 真實端到端驗收已通過，詳細 run ID 與報告證據見 devlog/m1-integration.md。四個服務保持運作，本機 Web 18080、API 18081。下一階段為 M2 草稿／版本／發佈與 Runtime 併發／取消，沿用 t30/t31/t32；測試 t33 保留黑箱操作路由，禁止提供專案原始碼或憑證。
