# M9 Runtime 交付

2026-11-12（Asia/Taipei），t42 → parent t3v，crew=1；effective gpt-6.1-sol／xhigh 已由 PM 核實。依 `contracts/mvp-v9.md` 實作；未修改 Server／契約／docs／deploy。

## 真模型整合後最小修復：首次 cursor

PM 暫時診斷已確證模型送入精確字串 `"null"`，使 HistoryClient 在送 IPC 前拒絕；options／stdin／quota 正常。只在 `author/loop.ts` 工具入口將此精確字串轉成真正 null。沒有 trim／大小寫轉換；空字串、空白及任意非法位置仍拒絕，HistoryClient／IPC／Manager HTTP／Server 不放寬。

- 新回歸先紅：`literal-null: actual IPC request count 0 !== 1`；修復後 `node --test --test-name-pattern='M9 model cursor accepts' dist/author/history.test.js` **1／1 PASS**。同一測試涵蓋真 null／字串 null 成功、空字串／空白／加空白 null／大寫 NULL／非法位置拒絕，並確認嚴格 client 直接收到字串 null 仍拒絕。
- Worker `npm run build` PASS，已更新固定 `/private/tmp/whippet-worker-m9/{dist,skills}`；正式固定包沒有 `m9-diagnostic.js`。新 `dist/author/loop.js` SHA256：`201f16ef6fe21a3e6bed3f0edb85e485c02b02fdb009f151ff7e031369b10b22`。
- 只重跑受影響的新跨接縫 `TestM9HistoryRealAuthorIPCAndManagerTLS`：真 Node author 主程式／pipes／Manager handler／TLS HTTP，合成 provider 首次送字串 null、第二頁用合法 cursor，**PASS 0.38s（race 套件 1.759s）**；modelRequests3／historyHTTP2／historySucceeded2／historyFailed0／markerMatch=true。未重跑原 27 項。
- 新 `history_wire_test.go` 兩案皆明確 opt-in：`WHIPPET_M9_WORKER_ENTRY` 才跑真 Node，`WHIPPET_M9_WORKER_IMAGE` 才跑一次性 Docker。Docker 案合成 CA 使用測試程序的隔離 Transport，避免 macOS 不套 Linux SSL_CERT_FILE 的錯誤假設，cleanup 恢復原 Transport／移除合成容器；修 fixture 後 **PASS 0.46s（race 套件 1.850s）**，HTTP1／historySucceeded1／failed0。沒有預設必跑的環境失敗案例。

Manager 未重建，固定 SHA256 仍為 `9ad62d818deb57d950a1e38a11c94ac532967d23493895692f5e9e78b1b217ee`。兩份暫時診斷包僅在 `/private/tmp/whippet-worker-m9-diag-{1,2}`，已明標非正式，PM 回報診斷後已恢復穩定映像；正式程式及固定包均無診斷 stage。最終真模型／真 Server 整合由 PM 以新合成 fixture 驗收，不把本節合成 provider 當真模型 PASS。

## 固定產物

- Manager：`/private/tmp/whippet-manager-m9`，Linux arm64、靜態 ELF。
- Worker：`/private/tmp/whippet-worker-m9/dist/`＋完整 `skills/`；來源 `runtimes/worker/dist/`／`skills/` 亦已更新。部署需兩者一起，沿既有依賴／映像封裝，由 PM 操作。
- 初始盤點及設定續編／撤銷現況：`/private/tmp/whippet-m9-runtime-proposal.md`。

固定後文字修正：刪除 test-author skill 殘留的「Full remote history retrieval is unavailable.」，保留 M9 明確授予才可有界按需讀取的規則；已同步來源及固定 Worker skills。只核對文字與兩份檔案一致，未重 build／重跑既有 PASS；Manager binary 與 Worker dist 不變，PM 可 COPY-only 重封裝 Worker。

## 行為與接線

`author.history.maxSequence` 與 `allowedTools` 明確授予時，test-author／workspace-author 才提供 `read_conversation_history({cursor})`；summary／舊 Run 不開工具。預設摘要＋近期訊息維持，仍共用 8 模型／12 工具／180 秒預算。

Manager `history.go` 經專用 HTTPS history endpoint 讀取，嚴格核對完整 scope／cutoff／cursor／6 片段／8192 UTF-8 bytes；不跟 redirect、必須 no-store。requestId 去重、attempt 核對、4 次含失敗、15 秒、取消不回覆，錯誤只回 history_unavailable。history body 不入 journal／一般 log，不取得 role secret 或寫入 login broker。

Worker `attempt-io.ts` 唯一擁有 stdin，固定分流 credential_response／history_response；歷史 client 不會收到 credential payload。Manager 兩個專用 handler 共用整 frame 寫入鎖。HistoryClient 另驗 scope／cutoff／byte offset，關閉／取消／逾時後拒絕遲到 reply；模型只收到 items／nextCursor，沿既有 known-secret 清理及 provider key 拒漏規則。兩個 skill 僅補按需讀歷史的短規則，不擴網站／登入許可。

重啟沿既有清理／收集、不重跑；不新增持久 quota。Server 負責活躍 control session、same owner／active EditingSession、Run 固定 sequence、revision/context 與現行狀態，Runtime 不回退公開完整歷史端點。

## 實際檢查

- `npm run build` PASS。
- `node --test dist/author/history.test.js dist/author/m7.test.js dist/author/m8.test.js dist/author/m8b.test.js dist/author/author.test.js`：27／27 PASS，0 skip。涵蓋混合分流、scope/cutoff／超過 JS safe integer 的 sequence、UTF-8 分片、4 次失敗額度、假時鐘 15 秒、取消／晚到回覆、模型按需取回舊決策、Workspace 無 browser、known-secret 清理及受影響既有行為。
- Manager `go test -race -mod=readonly ./internal/manager -run 'TestM9|TestM8B.*(Credential|ScriptOrigin)|TestM7|TestM3Author' -count=1 -timeout=30s`：PASS 1.760s。整理 UTF-8 原始 bytes 檢查後，只再跑 `^TestM9`：PASS 1.495s；最終 Linux arm64 cross-build PASS。沒有下載依賴。
- 新取消 HTTP 案例初次因合成 handler 未讀 POST body 而無法觀察 peer 關閉、卡在 httptest.Close；已保留取消斷言、先讀 body 並保證 cleanup，修正後 PASS。只停止本輪測試程序，未操作共享服務。
- skill-creator `quick_validate.py` 因缺 PyYAML 無法執行；未安裝。兩個 skill 的 frontmatter／4096-byte loader 界限檢查與實際模型 request capture PASS，不稱官方 validator PASS。

## 待 PM 整合

尚未執行真 Server／Manager Docker attach／模型 history 全鏈或 M9 UI 驗收；單元測試的合成 provider 不當作真模型。設定變更刷新 active draft、保留既有 Version／Run、角色撤銷與取消已有 Server 實作及 M8 證據，本輪不擴功能或重跑 M8 主驗收。請 PM 以固定三端產物補一條按需取回近期窗口外合成決策，以及設定變更續編／舊快照不變的必要證據。

本輪未安裝、Git、讀取 deploy/.env.ai／真秘密、建立子 Agent、部署或重啟共享服務。
