# 即時監看（M4）

狀態：M4 本機驗收完成；實際驗收結果以 [實作計畫](../tracking/implementation.md) 為準。

M4 提供執行中的瀏覽器唯讀畫面，主要使用 WebRTC video，無法建立媒體連線時切換經 Server 轉送的 JPEG 備援。觀看不會取得滑鼠／鍵盤控制，也不會改變測試結果。MVP 每個 Run 同時一位觀看者，沒有觀看者時不擷取畫面。

## 網路與設定

瀏覽器與 Manager 分別主動連線到 Server；控制任務與影像 WebSocket 分開，避免影像壅塞影響取消與心跳。正式 TLS 部署使用 HTTPS／WSS；本機 HTTP 對應 WS。前端 Nginx 必須代理 WebSocket Upgrade。

WebRTC 媒體不經一般 HTTP 反向代理。跨 Docker／主機或受限網路可能需要自架 TURN。Server 可透過 `WHIPPET_LIVE_ICE_SERVERS` 接受標準 RTCIceServer JSON 陣列，例如：

```dotenv
WHIPPET_LIVE_ICE_SERVERS=[{"urls":["turn:turn.example.test:3478"],"username":"viewer","credential":"replace-with-dedicated-media-credential"}]
```

使用獨立的媒體服務帳密；此設定會提供給觀看端，不能填 Manager token 或 AI API key。不提供設定時為空陣列，嘗試直接連線。尚未提供 TURN 服務與帳密時，不宣稱跨網路 TURN 已驗證。

## 範圍

- 原生 Playwright fixture browser／context／page／popup 與 AI 探索瀏覽器為目標；腳本自行啟動的獨立 browser process 不保證可觀察。
- 觀看端停止、隱藏頁籤或斷線後釋放串流，Run 繼續執行。
- 即時畫面與保存的 PNG 報告是不同功能；監看不是錄影，不提供回放。
- WebRTC 與 JPEG 備援需分別記錄實測結果。只有 WebSocket 連線或 SDP 協商成功，不代表已收到視訊。

## 本機示範與重跑

1. 開啟 http://localhost:18080 ，按「以開發管理員登入」。
2. 選擇「M4 Demo｜實際瀏覽器操作」，按「驗證此 revision」；此案例仍保留為草稿。
3. 在最近一次執行按「開始監看」，狀態出現「監看中：WebRTC」後，觀看 Worker 實際登入 Whippet、搜尋測試、查看詳情、開啟報告新分頁，再返回登入。案例約 40 秒；短暫停留只為方便觀看，不用來判斷測試是否成功。
4. 可按「切換 JPEG 備援」比較；「停止監看」只關閉影像，測試繼續執行。
5. 執行完成後開啟報告，測試詳情包含「登入頁」、「搜尋結果」與「報告」三張 PNG。

2026-11-11 已完成 Mac 原生 Chromium 與 Chrome → OrbStack Linux Worker 實測。Mac 自動驗收確認 live video track、實際解碼影格 2→3、JPEG 影像更新及停止後 Run 成功。可見 demo 亦觀察到 WebRTC 計數 12→30 秒，再切換 JPEG 39 秒。

[示範執行報告（本機）](http://localhost:18080/api/runs/c63b68dc-88a6-4501-a9e8-2e72a8fd48cf/artifacts/report.html)：兩張 1280×720 PNG 已在 Chromium 驗證載入，無圖片 HTTP／CSP 錯誤。

Worker 的獨立媒體 helper Chromium 使用數字 IP ICE candidate，避免 Docker `.local` mDNS candidate 無法由 Mac 解析。此設定僅套用短生命週期 helper，不修改使用者瀏覽器設定。實際跨主機 NAT／TURN 尚未驗證；無法直連時保留 JPEG 備援。

### 實際網站操作驗收

使用者要求的主要 demo 是實際瀏覽器操作，合成計數頁只保留為串流診斷案例。2026-11-11 Chrome 可見 WebRTC 已觀察到 Whippet 測試列表、搜尋後詳情與報告 popup 的切換；Run `248aa019-454d-464b-a2e7-3c519a65feb8` 約 39 秒成功。

[實際操作報告（本機）](http://localhost:18080/api/runs/248aa019-454d-464b-a2e7-3c519a65feb8/artifacts/report.html)。腳本：`scripts/test/fixtures/m4-real-browser.spec.ts`。目前 WebRTC 細字偏糊，畫質改善列入 M5；不影響操作串流與報告原始 PNG。
