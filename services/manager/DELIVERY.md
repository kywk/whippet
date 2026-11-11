# Runtime M2 交付

更新：2026-11-11（Asia/Taipei）。Owner：Runtime Agent。

**Manager 程式已固定，可建置映像。** M2 必要單元測試已通過 race 檢查；Docker 代表整合由總指揮負責，本 Agent 不建置／操作容器，也不重跑 M1 全量驗收。M1 先前已由總指揮與 Muse 完成成功／斷言失敗及報告驗收，見 [M1 整合紀錄](../../docs/tracking/devlog/m1-integration.md)。本次不做 M3。

## 已檢查並沿用

- 原本已有 ACK 前持久化、同 attempt 去重、terminal messageId 穩定重送、WS 重連、本機 journal／工作目錄鎖。
- Worker 已有 Playwright global timeout、外層 watchdog、SIGTERM／SIGINT 停止子程序群組及 5 秒後強制終止；這些程式本輪不修改，也不重跑無關 TypeScript／AI 測試。
- 原本已有 Docker exit／OOM 檢查、回收失敗重試、附件補傳、缺少真實報告不能成功的檢查。

## 補齊的缺口

| 檔案 | 變更 |
| --- | --- |
| `internal/manager/config.go` | MAX_WORKERS 接受正整數、預設 1，移除 M1 固定 1 的限制。 |
| `internal/manager/manager.go` | hello capacity 與本機上限使用相同 MAX_WORKERS；所有 run／validation 共用容量。每個 attempt 有獨立取消 context；WS session 中斷不取消 Worker。 |
| `internal/manager/cancel.go` | 處理 v2 cancel envelope；先持久化取消要求，再停止匹配的 run／attempt。重複 cancel 冪等，完成後不改終態。cancel 先於遺失 dispatch 到達時建立取消紀錄，遲到 dispatch 不會執行。 |
| `internal/manager/journal.go` | 新增向下相容的 `cancelRequested`、`reclaimed`。名額與 heartbeat.active 只在確認回收後移除；collection／terminal 寫入合併取消，防止取消被舊結果覆寫。 |
| `internal/manager/docker.go` | 回收時先嘗試 docker stop（5 秒 SIGTERM 寬限、命令最多 7 秒），再 docker rm --force；以 rm 成功或明確不存在確認回收。失敗維持名額並重試。 |
| `internal/manager/lifecycle_test.go` | 新增容量、取消、回收失敗、journal 恢復與取消先於派送的必要測試。 |
| `README.md` | 更新容量、cancel、heartbeat_ack、read deadline、回收／附件生命週期及整合說明。 |

只修改 `services/manager/`。`runtimes/worker/`（含 AI 模組）與其他 Agent 檔案本輪未修改；未安裝套件、未做 Git、未讀取 `deploy/.env.ai`，未呼叫模型。

## 關鍵行為與串接介面

1. 沿用 protocolVersion=1，依 [v1](../../contracts/mvp-v1.md) 及 [M2 契約](../../contracts/mvp-v2.md)。Server 負責 FIFO 與 queued cancel；Manager 不建立第二套佇列，超過實際上限的 dispatch 不 ACK。
2. hello `{capacity: MAX_WORKERS}`。設定是正整數，目前 Server gateway 接受 1..64；總指揮本次整合設 2。
3. cancel 帶匹配 `runId`／`attemptId`，payload `{}`；runId 與已知 attempt 不符時拒絕。取消只中止執行 context，不中止回收／附件補傳。任何取消、逾時或異常退出都先完成容器回收，才能送 result。
4. **容器回收與 Run 終態分開。** 持久化 `reclaimed=true` 才從本機占用與 heartbeat.active 移除；可用附件全數上傳完成才保存 complete／送 result。Server 繼續採「terminal 且 absent」才 ReleaseSlots，不需改此規則。
5. 新取消在 accepted／running／collecting 階段保存後，會合併為最終 cancelled；已 complete 的終態保持不變。Manager shutdown 仍嘗試獨立的容器回收；未確認回收就保留 journal，供下次啟動處理。
6. 每 10 秒 heartbeat；**t31／總指揮已協調 Server 成功處理後回 `type:"heartbeat_ack"`、`payload:{}`、相同 managerId**。Manager 設 35 秒 read deadline；沒有讀到 Server 訊息便斷線重連，Worker 繼續受本機 timeout 控制。此訊息回覆協調由總指揮代傳，契約文件由共同 owner 維護。
7. 重連先送 hello／目前 active，再重送已完成結果；同 attempt 不重跑。Server restart 而 Manager 不重啟時，既有 Worker context 與本機 timeout 不受影響。
8. Manager restart 時只清理未確認回收的容器／恢復附件補傳，不重新執行 script。未保存結果時保守回 failed 並註明中斷；已保存取消則回 cancelled。舊 M1 journal 沒有新欄位仍可讀取。

## 實際驗證

`gofmt -w internal/manager` 已完成。執行一次受影響範圍的 race 檢查：

```sh
GOROOT=/opt/homebrew/Cellar/go/1.27.4/libexec \
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
GOCACHE=/private/tmp/whippet-manager-go-cache \
go test -race -mod=readonly ./internal/manager \
  -run 'Test(M2|ManagerDispatchDedup)' -count=1
```

結果：**exit=0，`ok whippet/services/manager/internal/manager 5.089s`**。只使用既有相依套件快取，沒有下載。

涵蓋 7 項頂層測試（含 MAX_WORKERS 的 5 個設定子案例）：

- 既有同 attempt 重複 dispatch／重載 journal 不重跑，以及回收後才上傳並完成。
- MAX_WORKERS=2 可啟動兩個、第三個拒絕；異常退出尚未回收時仍不得啟動第三個，實際 driver 同時存活數不超過 2。
- cancel 只作用於匹配 attempt；重複 cancel 不多開 Worker；取消旗標先保存，回收前無 result 且仍出現在 active。
- collection 期間的取消不被舊成功結果覆寫。
- cancel 先於 dispatch、未完成 journal 恢復，都不會重新 Execute。
- watchdog timeout 加第一次回收失敗，仍保留 active／名額，重試成功才完成 timed_out。
- MAX_WORKERS=1／2 接受；0／負數／非數字拒絕。

容器 driver 是測試替身，這些結果不宣稱 Docker／WS 故障情境已實測。沒有重跑 repo 全量測試或未修改的 AI 測試。

## 總指揮接續的代表整合

- 建置 Manager 映像即可；本輪 Worker 沒有變更，不必因 runtime M2 重建 Worker。
- `MAX_WORKERS=2`：第三筆維持 FIFO 排隊，容器確實回收後才能放下一筆。
- 強制終止一個 Worker 容器：Run 失敗，回收完成，其他 Worker 繼續；不偽造成功。
- 取消執行中的 Run：只停止匹配 attempt，最後 cancelled；若回收受阻仍占名額。
- 重啟 Server、不重啟 Manager：完成 heartbeat_ack 握手、恢復相同 journal／active；同 attempt 不重跑。
- 如需要驗證半開連線，Manager 35 秒 read deadline 已加入；此環境未開埠或操作 Docker，實際 WS 斷線／讀取逾時由總指揮整合確認。

本輪程式已固定，等待總指揮的容器整合結果；提交由總指揮負責。
