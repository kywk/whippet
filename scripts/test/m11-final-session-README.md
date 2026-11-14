# M11 W7 session 驗收準備

狀態：僅準備，**必須等 PM 明示 W7 push 和隔離環境 READY 才能執行**。這是 session 切片，不代表完整 M11 全部波次已驗收。執行前由 PM 核對二進位、Worker image、scope、role、真 TLS、隔離環境及下列缺口。

## 最小接線

PM 提供的 `root/session-rpc.sock` 每個連線接收一行 JSON-RPC，回傳一行 `{httpStatus,privacyViolation,body}`；broker 私有持有 Token、經真 HTTPS `/mcp`，並對整個回應檢查 fixture 秘密。只接受 `privacyViolation === false`，不列印或保存 MCP body；目標登入是否成功只看 `target-state.json` 的 `loginSucceeded === true`。`ready.json` 只取 Web/CDP/target URL、Workspace 名稱與 roleId；不連 Token socket、不讀金鑰、環境檔或 raw log。broker 的掃描必須包含本次全部合成帳密與 fixture 機密，否則快照秘密檢查無法成立。

UI 使用 PM 提供的獨立已登入 page，不重新整理，僅使用 DOM、可見性與媒體元素尺寸觀察，不讀 cookie、網路回應、截圖、影像或 console；多個登入頁時以 `window.name = 'm11-session-qa-t67'` 定位。單獨建立新 page 雖共用 cookie，但不會還原 Web 分頁的登入狀態。MCP body 僅在程式記憶體解讀必要的協定狀態與租約 ID。執行輸出只有固定檢查名稱與布林，不印 body、例外或密文。intent 目錄內只存 requestId、sessionId、leaseId、callId；送出 open／login／close 前先以獨佔建立及 fsync 記錄意圖。發送結果未知時停止，勿換 ID 重做；由 PM 根據 intent 收斂與清理。

PM 放行後，由 QA 建立全新私有空目錄（0700），並執行：

```sh
node scripts/test/m11-final-session-ui.cjs --ready-dir /PM/隔離環境根目錄 --intent-dir /QA/私有空目錄 --w7-push-ready
```

`--w7-push-ready` 是防誤觸開關，不是放行的證據。腳本使用既有 Worker 安裝的 Playwright，綁定 Web 19787、CDP 19790、Docker 可達目標 host.docker.internal:19788；不接觸舊環境。會依序執行 MCP initialize/list、session open/status、navigate、snapshot、UI 監看、login、目標成功布林、敏感暫停與媒體隱藏、快照、畫面恢復、close/status、舊 session 拒絕、UI viewer 失效、第二 session open/close。登入要求 `submitted === true`，允許另附 broker 掃描過的 page；此布林僅表示送出，成功另由 fixture 布林證明。pause 以登入前安裝的 DOM MutationObserver 捕捉。

目標提供 `loginCount` 時記錄登入前基準並要求增加恰好一次；若只提供布林，登入前要求為 false，再等其變為 true。PM 須協調其他 QA 在這段期間不對同一 fixture 登入，否則訊號無法歸因。預先為 true 而無計數器時腳本停止，不重設共享狀態。

首次 open 已成功、且尚無 login/close intent 時，可在同一命令最後加 `--resume` 使用記錄中的租約；會先查狀態，略過 open 與 navigate。已有 login intent 時不得用此方式繼續，以免重送未知結果。

分段模式：`--viewer-only` 開啟租約、導覽並等待首幀後停止，保留 viewer／租約；PM 放行後以同一 intent 目錄加 `--resume-viewer`，要求 WebRTC 解碼影格遞增與 JPEG `decode()` 成功，再單次登入、檢查敏感暫停與恢復、close。此模式不會再開第二個 session；Docker 與容量仍須外部證據。分段執行前須協調 t66 的資源與 fixture 登入計數。

本次首次執行的「只能有 submitted 一個欄位」屬 QA 斷言過嚴造成的假陰性，實際 submitted 值當次未獨立保存，不能補宣稱；fixture 成功布林與快照隱私結果各自獨立。首幀未見、敏感暫停未觀察到，需待修復及 PM 放行後以新 fixture 執行完整定向重驗；不得以調整斷言代替媒體或秘密驗證。

r4 定向重驗已觀察到 WebRTC 解碼影格遞增、JPEG 可解碼、submitted=true、登入成功計數加一、敏感暫停且兩媒體元素 hidden、恢復、快照隱私檢查通過，以及產品回報回收／舊 session 拒絕／UI viewer 移除。當次 pause 觀察器未記錄整個暫停期間的每次變更，不能宣稱已證實全程無可見媒體；後續 harness 已增加該紀錄。Docker 與容量證據由 PM 獨立核對。

## 完整結論仍需獨立證據

- `reclaimed=true` 是產品回報，不能單獨證明實際 Docker 移除。PM 需依兩個已記錄 lease／容器標籤提供獨立、去敏後的移除布林，並確認不存在誤刪別的容器；不可讓 QA 讀 raw log。
- 第二 session ready 證明原 Token 的單一 session 限制解除，但 Manager 若有兩個以上 slot，這不足以證明原 slot 恢復。需 PM 以獨立容量基準與回收後容量證據核實，或在已知其他 slot 受控占滿的情況下進行該項；不可把第二次 open 單獨記為容量恢復 PASS。
- UI viewer 被移除／終止及舊 session snapshot 拒絕，並非直接驗證舊 viewer 通道無法重新 attach；若需涵蓋該項，應由 PM 提供不含憑證的獨立布林證據，或補安全的管理端驗證。不要以 UI 清單消失冒充 attach 拒絕。
- 僅在驗收範圍及時間允許時，UI 撤銷專用 `Isolated session QA` Token，再以 broker 驗拒絕；不可撤 `Isolated MCP author`。目前腳本未自動撤銷，也未聲稱此項通過。
- 發生 FAIL 或不確定結果時保留 intent 與固定階段，停止自動重送，回報 PM／相應 owner；不自行修產品、部署或執行 Git。若 QA 中途失敗，可能仍有活躍租約，PM 應根據已持久化意圖協助安全回收。

`RESULT=PASS_PARTIAL_DOCKER_ORACLE_REQUIRED` 只代表腳本內檢查，尚須合併上述獨立證據才可裁定相應驗收項目。沒有觀測到暫停、LiveView 或目標成功時記 FAIL／未驗，不能以 fixture 或單元測試代替。
