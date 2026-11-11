# M2 整合驗收

2026-11-11，Asia/Taipei。使用者指定先補 M2、測試通過後提交；本輪未開始 M3。

## 實作與環境

Herdr t30／t31／t32 使用 Codex sol xhigh，分別負責 Web／Server／Manager。t33 使用 OpenCode Muse Spark 1.3 Contributor xhigh，僅依黑箱契約與合成資料撰寫測試；總指揮執行本機 Docker 整合。沿用 Mac／OrbStack、PostgreSQL volume 與既有 journal，migration 003 成功套用，未清除既有資料。

Server Go 測試及 build 通過；Manager M2／去重 race 測試通過（5.089 秒）；Web TypeScript／Vite build 通過。Server、Web、Manager Docker 映像建置成功。Worker／AI 未變更，沒有再呼叫模型。

## 實際結果

- `scripts/test/m2-api-smoke.cjs`：exit 0。建立 Test、儲存、驗證、發佈與正式執行成功。未驗證、舊 revision 及新 revision 尚未驗證的發佈皆回 409；修改草稿後版本快照不變。
  - Test `0756dc23-c4d6-4bab-9881-7caf8ee036f9`。
  - Version `f0d71aed-fffa-43b3-9268-5a13f9b34342`，revision 3。
  - 正式 Run `9e9a780d-fb74-466e-b02a-3647cf461030` succeeded。
- `scripts/test/m2-ui-smoke.cjs`：exit 0。全 UI 新增、儲存、驗證、開啟報告、勾選確認、發佈與 reload 草稿值比對通過。報告呈現 Passed 1／Failed 0。Test 名稱 `m2-ui-1794391308092`。原生 select 測試操作曾等候逾時後跳過，不影響單 workspace 主流程；腳本後續改用 selectOption，未重跑已通過主流程。
- `scripts/test/m2-queue-smoke.cjs`：exit 0。MAX_WORKERS=2，先觀察 running／running／queued；外部 kill 第一個合成 Worker，第一個 Run failed，後兩個 succeeded。追加執行中取消得到 cancelled，最終沒有殘留 Worker 容器。
  - 被終止 Run `5db98806-044b-4778-b174-94a28f443492`。
  - 原排隊 Run `be43a3c8-dff9-495e-bb14-090050e176d8`。
  - 取消 Run `76a33cae-bb2f-46e6-ad36-2f28868f394c`。
- `scripts/test/m2-reconnect-smoke.cjs`：exit 0。第一次手動重啟與測試結束太接近，未採為執行中斷線證據；補跑一次，在 running 回報當下自動重啟 Server。Manager 18:03:56 斷線、18:03:58 重連，同一 Run `9b85ccd1-7555-4d54-9af8-692ca2c6f76f` 最後 succeeded 並有報告。Docker 事件確認只有一個 start，之後 die／destroy，未重跑。

## 限制與接續

這是本機 Linux 容器的代表情境驗收，不宣稱跨主機 Linux Server＋Mac Runner、完整故障矩陣或負載測試完成。超時及清理失敗保留名額由既有 Worker watchdog 與本輪 Manager 單元測試覆蓋；不另外耗時重跑真實超時。

驗收暫用容量 2，結束恢復部署預設 MAX_WORKERS=1；可在本機 env 依指南調整。AI key 仍只留本機忽略檔，沒有傳入一般 Playwright 容器。M3 對話／Agent 工具迴圈與 M4 即時監看尚未開發。
