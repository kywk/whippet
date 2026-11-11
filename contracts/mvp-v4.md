# M4 唯讀即時監看

## 範圍

沿用既有依賴，不新增套件。真 WebRTC video 為主要路徑，獨立 WS JPEG 為備援；不能將備援宣稱為 WebRTC。MVP 每個 Run 同時一位 viewer，第二位收到 busy；不支援鍵鼠操作。監看失敗不改 Run 結果、不重啟測試。無 viewer 不擷取、不開 helper。

## Viewer ↔ Server

`GET /api/runs/:runId/live` 升級同源 WebSocket，沿用開發身分授權與 Origin 檢查。Server 綁定目前非終態 Run 的 managerId／attemptId，產生 viewerId。不把 Manager token 給前端。

JSON 訊息：
- Server→Viewer `{type:"ready",viewerId,iceServers:[]}`。
- Server→Viewer `{type:"state",state:"waiting"|"connecting"|"streaming"|"unavailable"|"ended",transport?:"webrtc"|"jpeg",reason?:string}`。
- Runtime→Viewer `{type:"offer",sdp:string}`。
- Viewer→Runtime `{type:"answer",sdp:string}`。
- Viewer→Runtime `{type:"mode",mode:"webrtc"|"jpeg"}`。初始 webrtc；前端 20 秒沒有可播放影像或 peer failed 時切 jpeg，也提供手動切換。
- Viewer→Server `{type:"ping"}`，Server→Viewer `{type:"pong"}`。每 10 秒、30 秒租約。
- 拒絕／錯誤 `{type:"error",code:string,message:string}`（包括 busy、不支援與無作用中的 attempt）。

採 non-trickle ICE：offer／answer 等 gathering complete（最多 8 秒）後傳送完整 localDescription.sdp，不新增 candidate 訊息。TURN 透過部署 `WHIPPET_LIVE_ICE_SERVERS` JSON RTCIceServer 陣列設定，預設 []；這是提供給觀看者的媒體設定，不可使用 Manager 或 AI 憑證。不要在 log 印 credentials。

JPEG 備援每個 binary WS message 是一張完整 JPEG，最大 1 MiB；前端只保留最新 Blob URL。預設最大寬 1280、約 3 FPS、quality 55。WebRTC 必須真的收到可播放 video track 才顯示串流成功。

## Server ↔ Manager

原任務控制 envelope 新增 `live.start`／`live.stop`，runId、attemptId 沿用 envelope，payload `{viewerId,iceServers?}`。控制只傳短指令，不放影格。Server 在 viewer 斷線／逾時／Run 終態清理並送 stop；stop 依 viewerId 去重，不能關掉後來的 session。

Manager 主動建立 `GET /api/manager/runs/:runId/live?attemptId=...&viewerId=...` 的獨立 WS，Authorization Bearer 沿用 Manager token。Server 驗證目前 Run／attempt／manager 及 viewer 綁定。雙方傳送上述 offer／answer／mode／state；Manager 發 JPEG binary，Server 轉給 viewer。Manager 每 10 秒另送 `{type:"ping"}`，Server 回 `{type:"pong"}`；Manager 使用 35 秒讀取期限偵測半開連線。控制與媒體獨立寫入、有限佇列與寫入期限，慢 viewer 丟舊畫面不阻塞 heartbeat／cancel。媒體通道中斷即停止本機擷取，觀看者可重新連線。

## Manager ↔ Worker

Runtime owner 內部實作：沿用任務 bind 目錄的原子 live control/state 檔與最新 JPEG，不開 Worker 對外埠、不注入 Manager token。Control 帶 viewerId、mode、expiresAt、iceServers、answer；Manager 定期續租，Worker 到期自行停擷取。SDP／狀態需上限、只轉送目前 viewer。一般 Run／validation 用 fixture bridge 觀察現有 browser context/page/popup；author 直接掛現有探索 browser。自建獨立 browser process 不保證支援，需明列限制。頁面／瀏覽器無畫面顯示 waiting，測試仍持續。

Worker 以既有 Playwright screencast 取得 JPEG；webrtc 模式由無金鑰 Chromium helper canvas.captureStream 與 RTCPeerConnection 輸出真 video track。jpeg 模式關閉 helper、保留擷取。最後 viewer 離開時停止所有影像資源。任何媒體例外由 LiveView 自行處理，不使測試失敗。

## 最小驗收

同一受控慢速 UI 案例：真 WebRTC video 畫面、手動／失敗切 JPEG、關閉 viewer 後停止擷取且 Run 繼續完成。確認既有 PNG 報告仍可用。MVP 不做完整 NAT 矩陣；實際 TURN 未提供時只驗證設定接線，不能宣稱 TURN 已實測。
