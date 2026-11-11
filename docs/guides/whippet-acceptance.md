# 本機 Whippet 驗收

開啟 http://localhost:18080 →「以開發管理員登入」→ 搜尋 **Whippet 驗收**。選擇案例後可查看腳本、歷史紀錄與報告，或按「執行測試」重跑已發佈版本。

| 案例 | 驗收內容 | 關鍵截圖 |
| --- | --- | --- |
| 01 登入與搜尋 | 登入預設 Workspace、搜尋唯一結果、開啟詳情、返回登入 | 登入、搜尋結果、測試詳情 |
| 02 歷史執行報告 | 從固定成功範例的歷史紀錄開啟真實報告，確認 Passed 1／Failed 0 | 歷史紀錄、報告內容 |
| 03 新增與暫存草稿 | 新增、存稿、未驗證不可發佈，重整後內容一致 | 儲存草稿、重新載入 |
| 04 未儲存編輯防護 | 未存編輯阻擋 AI 訊息／驗證／發佈，還原後恢復 | 未存防護、還原後狀態 |

在執行紀錄點「開啟報告」，再點報告中的測試名稱，可查看步驟與截圖附件。截圖是當次瀏覽器畫面的證據；通過與否仍由腳本斷言決定。

案例 03 每次會新增一份 `驗收產物・草稿・<時間戳>` 未發佈測試，其餘案例不儲存測試資料、不送出 AI 請求。案例 02 查看既有報告，不在 Worker 內啟動另一個 Worker，避免單一併發時互相等待。

## 腳本與本機網址

四份腳本位於 [`scripts/test/acceptance`](../../scripts/test/acceptance)。Mac Docker Worker 使用 `http://host.docker.internal:18080`；這是 Worker 連回宿主機的網址，使用者瀏覽器仍開啟 localhost。這組案例依賴目前預設 Workspace 與「固定頁面：成功範例」。

需要重新匯入腳本時，在 repo 根目錄執行：

```sh
node scripts/test/register-acceptance.cjs
```

匯入工具會建立／更新同名測試，透過平台 Worker 驗證後發佈。它會沿用同一 revision 已存在的驗證，避免中斷重跑造成重複排程；失敗即停止，保留錯誤供檢查。變更腳本會建立新 revision 並重新驗證。

## 本次驗收結果（2026-11-11）

四個最新版本均由平台 Worker 執行 validation 通過後發佈；報告內共 9 張 PNG 經 Chromium 確認 complete、naturalWidth > 0，圖片 HTTP／CSP 錯誤均為 0。登入截圖已目視確認為登入後 Workspace，非過場畫面。

| 案例 | revision | 截圖數 | 報告 |
| --- | --- | --- | --- |
| Whippet 驗收 01｜登入與搜尋 | 4 | 3 | [開啟報告](http://localhost:18081/api/runs/8cd30023-c743-4aa6-a6ee-12332692d865/artifacts/report.html) |
| Whippet 驗收 02｜歷史執行報告 | 3 | 2 | [開啟報告](http://localhost:18081/api/runs/6d11d763-de1e-42b1-9d75-235ec54950a9/artifacts/report.html) |
| Whippet 驗收 03｜新增與暫存草稿 | 3 | 2 | [開啟報告](http://localhost:18081/api/runs/b55df781-248a-4a6f-9a61-3f075e0e72d4/artifacts/report.html) |
| Whippet 驗收 04｜未儲存編輯防護 | 2 | 2 | [開啟報告](http://localhost:18081/api/runs/ad71c445-59c6-4cca-8939-d58ba11ef0fb/artifacts/report.html) |

另外以既有「固定頁面：斷言失敗範例」確認失敗時自動截圖：Run `e55d01a1-579c-48a7-ab7f-21c845ceb74e` 正確為 failed，報告內一張 PNG 正常載入。該失敗報告另會嘗試讀取 Playwright 的 `error-context.md`，目前未支援 Markdown 附件，會被 CSP 擋下，因此通用報告檢查程式對這份報告回傳非零；不影響 PNG 與既有錯誤摘要顯示。此限制保留，沒有放寬安全政策或宣稱完整附件已支援。

本輪不呼叫真實 AI 模型、不安裝套件、不執行 Git 操作。AI 基本技能的載入另以 mock request capture 驗證；不能將它視為模型產稿成功率的量測。
