# M6 失敗證據附件契約

延伸 v3／v5；本輪補失敗 trace ZIP 與 error-context Markdown 的保存、列表與下載。不提供內嵌 trace viewer、不新增影片或任意附件框架。

## 名稱、範圍與配額

僅普通 run／validation 新增 `^data/[0-9a-f]{40}\.(zip|md)$`。40 位 hash 為檔案內容 SHA1，沿用 Playwright HTML reporter 的名稱；儲存不可覆寫仍沿用既有 SHA256 機制。author 僅 author.json，原 PNG／報告規則不變。

- ZIP 每檔最多 64 MiB；MD 每檔最多 1 MiB。
- ZIP＋MD 每 Run 合計最多 32 檔／128 MiB，PNG 配額獨立維持原值。
- Worker／Manager 限定 regular file、拒絕 symlink／traversal，核對內容 hash、ZIP 基本 signature（僅 PK0304／PK0506，不接受 PK0708 單獨開頭）與 MD UTF-8。不解壓 ZIP、不執行內容，也不引入 ZIP 套件。
- Server 驗證名稱、kind、大小／總額與 hash；基本 ZIP signature／MD UTF-8 可沿用標準函式。配額與同 attempt 冪等保存沿用 Run 鎖。不同內容不可覆寫。
- Runtime 在上傳前排除超限或無效的可選證據，以不含內容的警示紀錄略過原因，不能讓可選附件造成永久 413 重試。

## API 與瀏覽器行為

沿用附件上傳與下載端點、token／X-Attempt-Id 綁定。

新增 `GET /api/runs/:id/artifacts` → `{items:[{name,size,contentType,url}]}`。未知 Run 回 404；已知 Run 無附件回空陣列。只列該 Run 當前 attempt 已保存、可透過既有下載端點讀取的白名單附件；依 name 排序。不列檔案系統路徑、token 或未上傳成功項目。

- ZIP：`application/zip`。
- MD：`text/markdown; charset=utf-8`。
- 兩者 `Content-Disposition: attachment; filename="<hash.ext>"`、`X-Content-Type-Options: nosniff`、CSP `sandbox; default-src 'none'`（可沿用等效既有安全標頭）。
- HTML 原有 opaque sandbox、storage shim、script／connect 限制不變；不為下載或 Copy prompt 放寬 CSP。
- Run.reportUrl、發布與成功所需報告門檻不變。可選證據缺少不改寫原始斷言結果；必要報告缺少仍遵守原門檻。

## Runtime（M5 交付後開始）

runner trace 改 `retain-on-failure`，retries 維持 0、video off；HTML reporter 設 `noCopyPrompt:true`，避免 error-context Copy prompt 嘗試受 CSP 禁止的 fetch。

匯出原生 `data/<hash>.zip/.md` 並保留報告相對引用。即使 HTML 缺失，仍從本次 test-results 下有界掃描既有 trace.zip／error-context.md，依內容定名匯出可取得的證據；不掃其他任務或主機目錄，不保證硬殺前未 flush 的檔案。避免同內容重複計數，依配額停止收集。

Manager 於 result 前上傳合法可選附件，沿既有 journal 補送／去重，不為附件失敗重跑測試。不要改寫控制或媒體協定。

## Web

於既有 Run 結果／歷史旁提供明確的「下載失敗證據」入口，按需讀取附件列表，只顯示 ZIP／MD 下載連結。顯示檔案類型與大小；空列表顯示未取得證據，不視為測試成功。連結位於平台頁面、HTML 報告 sandbox 外，直接用 API 提供的受檢查 URL，不抓內容進管理 DOM。

明示 trace 為下載後以本機 Playwright Trace Viewer 開啟；不聲稱報告內建 trace 按鈕可用。不加新視窗框架、輪詢或新套件。

## 最小驗收

- Server：名稱／kind／大小／合併配額、同 attempt 重送與不可覆寫、列表隔離及下載標頭；確認 HTML CSP 未放寬。
- Runtime／Manager：一條固定斷言失敗產生 ZIP／MD、成功不留 trace、HTML 缺失仍匯出可取得證據；沿用既有上傳 journal 測試，只補受影響分支。
- 整合：一次實際失敗，平台外部入口可下載 ZIP／MD；以既有本機 show-trace 開啟 ZIP，HTML 無新增 CSP 錯誤。沒有遠端環境不阻塞本機驗收，不擴張成完整矩陣。
