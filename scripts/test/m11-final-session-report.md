# M11 session 集中驗收安全報告

## 範圍與結果

本報告只涵蓋 M11 W7 browser session、可信登入與 LiveView 的定向驗收，不代表所有 M11 工作已完成。r4 測試使用 PM 提供的隔離真 TLS Server、原生 Manager、Docker Worker image、已確認 scope 的 Workspace、合成角色及獨立 opaque MCP broker。QA 未讀取 Token、金鑰、環境檔、raw log、cookie 或影像內容；MCP 回應由 broker 檢查隱私後，QA 只輸出固定欄位與布林。PM 負責環境來源與二進位識別。

| r4 實際觀測 | 結果 |
| --- | --- |
| 真 MCP 初始化／工具列舉、session open／ready、導覽與快照 | 通過；broker 隱私檢查通過 |
| UI viewer 首幀 | 通過；WebRTC 解碼影格計數遞增，JPEG `decode()` 成功 |
| 單次 browser_login | `submitted=true`，允許附 page；broker 隱私檢查通過 |
| 合成目標登入 | 成功計數相對基準增加一次；PM 指定該期間無其他登入 |
| 敏感輸入與恢復 | 至少一次觀察到暫停且 video、image 同時 hidden；其後媒體恢復 |
| 登入後快照 | broker 隱私檢查通過 |
| close／失效 | MCP 回報 closed/reclaimed；舊 session snapshot 遭拒，UI viewer 被移除 |
| 關閉後 viewer 再 attach | 真同源 WebSocket 收到固定 `error/not_found`，明確拒絕 |
| Docker 實際回收 | PM 獨立核對該 session／lease 對應容器不存在；Manager journal、DB 未回收 session 均為零 |
| 容量 | PM 回報 Manager capacity=2、DB 未釋放 Run slot=0；完整容量恢復的獨立定向證據仍待 PM 裁定 |
| 專用 QA Token 撤銷 | r5 定向補驗：UI 顯示已撤銷，緊接的 broker RPC 回 401，隱私檢查通過 |

首次 r3 viewer 等待約 45 秒未觀察到首幀；該輪有目標登入成功、後續快照隱私檢查通過及產品回報回收。PM 獨立確認 r3 對應容器不存在及 DB 未回收 lease 為零。r3 的 `LOGIN_SUBMITTED_ONLY=false` 是 QA 將語義誤解為只能有一個 key 所致的假陰性；當次 `submitted` 未單獨保存，不補宣稱。r3 未觀察到敏感暫停，不能由 r4 結果回填。

## 限制與未完成

- r4 觀察器證明至少一次暫停時兩個媒體元素同時 hidden；當次未記錄整段暫停期間的所有 DOM 變更，故不宣稱已證實全程無可見媒體。後續 harness 已加入暫停期間可見違規紀錄，但尚未重新執行。
- r4 UI 撤銷專用 `Isolated session QA` Token 時，PM 環境的另一 Playwright 連線自動 dismiss 確認視窗。唯讀核對該 Token 當時仍有效，broker 下一次請求為 200；這是環境 harness 競態，不判產品缺陷。PM 修正環境後，r5 僅補 UI 撤銷及下一次 RPC 401，結果通過；未重跑登入或 LiveView，主 Agent Token 未撤銷。
- 第一份 r4 隱私結論依賴 PM broker 對完整回應與全部合成 fixture 秘密的掃描；QA 不取出或列印秘密及 MCP body。
- 固定布林無法單獨證明全部錯誤、跨 Workspace、撤銷或斷線負例；其他波次與產品缺口以 PM 的獨立彙整為準。
