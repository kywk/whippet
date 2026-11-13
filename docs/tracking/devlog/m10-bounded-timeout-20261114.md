# M10 有界產稿與逾時修復驗證

2026-11-14，PM t4s；Runtime t4z、Server t50、QA t51。進度以 [implementation](../implementation.md) 為準。

## 真實逾時的證據界線

retry4 Run `ce8b012b-cdbc-49b9-b6b6-95cf6c156e1e`：Run 開始至結束 180518.407ms；第一個模型請求開始至第三請求失敗 180019.143ms，第三請求等待 176610.803ms。權威 timeoutMs 與 budget.maxDurationMs 同為 180000，loop 共用 deadline，並非每個請求各有 180 秒。候選提交、自試、正式 validation 均未開始。Manager watchdog 的最短期限為 5 分鐘，不能解釋此 180 秒終止。

精確 Run 的 READ ONLY SQL 只回固定數值、enum 與 hash：payload 2413 bytes、單一訊息 939 UTF8 bytes、module 183 bytes、script/harness 空。這些不是完整 provider token 數。歷史沒有 headers/body 分段觀測，不能推論 provider 卡在哪個內部分支，也不能判定 16384 輸出額度足夠或仍截斷。SQL 與投影保留於 `/private/tmp/whippet-m10-bounded-author/retry4-{timing,sizes}.{sql,json}`。

另以真 native fetch/local HTTP 重現非成功回應的 `body.cancel()` 可能不結束，修補為受原 signal 限制；正常 HTTP 失敗語意保持。這是獨立缺口，不當作 retry4 根因。Worker main／Manager 接線 M109 預設關閉的固定 17 enum、ordinal 1..8 觀測，Server 沿既有事件儲存；terminal 後事件可能被忽略，absence 不作根因證據。報告 `/private/tmp/whippet-m10-timeout-root/AB-RESULT.md`。

## 已完成切片

registry10.3 提供 script/harness 各最多 8192 UTF8 bytes 的 attempt-local staging，再以 commit 沿原完整 schema、scope、secret 與真自試守衛建立候選。只有通過自試才更新 checkpoint；失敗、未 commit、abort 均不得產生成功候選。原 8 模型／12 工具／180 秒／16384 輸出預算保持。舊 update 定義仍供相容及 final 完整驗型。

這可縮小單次產稿量，尚不是跨 Run 恢復或長對話 compaction。容量預檢、合法壓縮、有界 patch/hash 與可信續接仍列 M12.1，不能宣稱長任務問題已全部解決。

產品與定向測試已提交 `bf709cb`；沒有 tag/push。

## 實際驗證

- Worker 真路徑 timeout controls、cleanup red→green、main gate、staging 正負與 abort/重複 callId 通過；Manager 定向 race/build 通過。
- Server 單元與隔離 PostgreSQL 測試通過；真三端 bridge 使用合成 provider，經 Node 雙檔自試、Manager parser/upload、TLS Server、PG CAS/回收、唯一正式 validation 及 HTML/JSON 上傳通過（5 model／4 tool／0 generic IPC）。不代表真模型。
- QA t51 使用固定包 driver：success、failed-intent、uncommitted 均 exit0；正負案例同 harness 斷言未弱化。QA 曾超出兩檔讀取範圍執行 env 名稱 filter 與 package metadata 查詢；PM立即禁止，未觀察秘密值。此偏差保留，不採「只讀兩檔」自述。

## 固定包

位於 `/private/tmp/whippet-m10-bounded-release`，舊包不可覆寫：

| 包 | SHA256SUMS 的 SHA256 |
| --- | --- |
| shared（22 檔） | 789f704c90680db237b6699a3366ce97a6553bbc0a832dcd69ddfc08aa70610d |
| server-release（158 檔） | 8bd29b5f573296cbdc5a86dc56e545c254d06cd400b2ddcf1d11d1070690d31a |
| runtime-release（228 檔） | d7302fbab92bb3d0b958a77a36faee36c39fde5a4e5ec4d2c27ffd5202052bef |

## 部署中發現的相容性缺口

bounded-switch 保存原設定、bind、network alias、DB/Web；但 Manager 52ms 即 exit1，Server 正常。retry5 前置 Running 檢查擋下，尚無 intent/outcome、零 POST。

合成同 workdir、同 complete/reclaimed journal bytes 在 registry10.2 可啟動，只切10.3即 invalid journal author snapshot；空 journal＋10.3 可啟動。PM批准最窄歷史終態驗型修補，只略過 current registry pin 等值，保留所有結構與其他守衛，active/new仍 fail closed。不讀或改現場 journal、不初始化。部署實證尚待完成；不能只由合成結果排除現場其他初始化原因。


### 修補部署結果

修補已提交 `f651360`。Manager-only包89檔SHA256SUMS為 `4f868fb447507f799496985d5670e05c5d28994fc45af8e19854e2ef12275704`；新image `sha256:50dd74248757b60ec227e7c67a66f37cc23fef1e77fafa252f007ce143962aa8`。首次Docker build把裸SHA誤解為repository而失敗，未產生映像；改用已核完整ID的本機m1 tag後COPY-only建置通過，build輸出再次確認相同base ID。

獨立Manager-only替換後持續Running及完整前置心跳通過，原workdir/env/binds/aliases/Workerimage完全保存，Server/PG/Web ID不變，原receipt不覆寫。此現場恢復結果支持合成重現的journal相容缺口為啟動阻擋。新receipt `/private/tmp/whippet-m10-shop-environment/bounded-manager-repair.json`；apply不得重跑。

retry5唯一POST後Plan r13/running、search Run `256747aa-6298-4e4c-bc11-874ac38f3fd0`；快照與歷史payload不變已核，結果觀察中。


### retry5 最終影響

Plan stopped/r14，Run `256747aa-6298-4e4c-bc11-874ac38f3fd0` failed且全部回收。8次模型請求全部返回成功，分段stage與兩次commit確實執行；v3 terminal LIMIT、自試0通過/2失敗、lastSelfTestFailureClass TEST_FAILED，無checkpoint、author artifact或正式validation。這次沒有180秒TIMEOUT；分段能力通過現場工具路徑，但候選品質未通過。

影響：search尚不能發佈，order/verify維持pending，四Stage全流程與M10.Z仍不合格；不能以fixture QA或工具succeeded宣稱通過。現有固定分類未指出具體失敗斷言；不讀raw、不猜selector、不放寬harness、不增加模型額度或追加retry。下一步先建立最小結構化自試失敗證據。


retry5最終時間投影：started→finished144508.863ms（約144.5秒），timeoutMs180000且timedOut=false；model3耗75300.804ms、model8耗25071.571ms。8工具為draft1/reference1/stage4/commit2，全部工具succeeded，但兩次自試失敗；只保留最後自試class=TEST_FAILED，不能認定前次同類，更不能猜具體斷言。timing.sql/json與final/review/safe-events已封存。
