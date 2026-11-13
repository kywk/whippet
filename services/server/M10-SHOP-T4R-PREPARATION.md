# t4r：19287 升級後新 fixture 準備

Owner t4r；PM t4q。僅此文件與 m10_shop_t4r_fixture.py 為本輪 owned 檔案。
目前 preparing，尚未呼叫模型或任何 API，未部署、重啟、安裝或操作 Git。

## 最小流程

1. PM 完成 19287 migration019 + 診斷升級，明確通知可開始。
2. 先審閱 `python3 services/server/m10_shop_t4r_fixture.py preview`（純離線）。
3. 通知後才執行 `python3 services/server/m10_shop_t4r_fixture.py submit --pm-upgrade-complete`。旗標只是防誤觸，不是升級證明。
4. 固定既有 Workspace 與 login seed；建立一個新 Use Case/session，三個新 Module slug 為 shop-t4r-20261114-search/order/verify。只提交一次真 planner，結果與提交前 intent 保存於同目錄 m10_shop_t4r_fixture.result.json。任何部分失敗／回應不明直接停，禁止刪除 state 重跑；交 PM 核對是否已建立資源或 Run。
5. 後續僅觀察此新 Run/session：GET `/api/runs/{plannerRunId}` 與 GET `/api/tests/{testId}/editing-sessions/{editingSessionId}`，確認 terminal、pendingRunIds=[]、reclaimPending=false。成功後 GET `/api/tests/{testId}/plan?editingSessionId=...` 保存原 AI Plan 供 PM；注意 active-session Plan GET 有 reconcile 路徑，不作升級前純讀檢查。
6. 審核恰好 login reuse + search/order/verify create、固定 seed、新 slug、正向 bindings、完整各自 harness 前置、hidden 規則。失敗或偏離要求都停給 PM，不自動 PUT 修正、retry、confirm、summary 或 publish。PM 人工 confirm 是另一個獨立步驟。

三 create 的 harness 各自 goto /login，透過 whippet/login 的 loginAs 與既有 buyer role 登入，斷言 /products 與 account-state；不能只寫「同 search」，也不能 import 其他 Module。order harness 自行取得商品再呼叫自己的 order；verify harness 自行建立當次新訂單再呼叫自己的 verify。Module 主體組合時共用原 page session。hidden productId 僅核對既有 value，選定相符商品表單，只填 quantity=2；不 fill hidden、不改 DOM、不硬編 orderId。

保留舊 Plan 5f532f99-8dc9-42b5-9e27-8823276e3bcb 及全部舊結果。migration019 的舊 Run cancel_requested=NULL 代表歷史未知，不能手動改 false 取得 retry 資格。未變更預算或 skills。

## 升級前 DB 唯讀條件

下列為提供 PM 的查核 SQL，本 owner 尚未執行 DB 查詢。不含連線資料，也不讀 env。

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT count(*) FILTER (WHERE status NOT IN
 ('succeeded','failed','cancelled','timed_out','interrupted')) AS active,
 count(*) FILTER (WHERE NOT slot_released) AS unreclaimed
FROM runs;
SELECT count(*) AS pending_validation FROM module_validation_requests WHERE NOT resolved;
SELECT count(*) AS schedulable_plans FROM plans WHERE status IN ('confirmed','running');
COMMIT;
```

作用範圍應為 19287 使用的整個 DB，不只此 Workspace。active=0 且 unreclaimed=0 是必要條件，但單次快照不充分：module validation 排程與 running Plan 可再入列；還須 PM 阻止新 UI/API 提交，確認 Manager 心跳／實際 worker 清空，再在切換前重查。以上額外兩項若非零，先由 PM 判讀，勿由本腳本取消或改 DB。不要以成功終態、空 pendingRunIds 或沒有 run_events 單獨推論已回收／從未取消。

## 原 artifact 目錄確認（不讀 env 值）

Server main.go 使用 ARTIFACT_DIR，未配置才用 ./data/artifacts；LocalArtifacts 會轉絕對路徑並解 symlink。因此不能由原始碼預設值直接斷言現場目錄。

由 PM 對確定對應 19287 的舊容器只投影 Docker inspect 的 Id、Config.WorkingDir、Mounts；禁止整份 inspect、Config.Env、raw log 或 env dump。搭配既有啟動文件的非秘密路徑資訊確認候選 root；若沒有已知設定，只在候選資料路徑唯讀查檔案，不搜尋秘密檔。

以已知成功 login validation db785e6e-4677-4403-a6a4-4f52dcce8d03 的 artifacts 表讀 name/storage_key/size_bytes/sha256（限定該 run），在候選 root 下檢查同一 storage_key 檔案的大小與 SHA，不讀出報告內容。比對成功只證明該候選含該 artifact；多處副本時仍須掛載或非秘密啟動設定確認實際 root，不能猜。掛載目的地沒有涵蓋該 root 時，視為容器可寫層資料，PM 升級前需保全整個 root 與舊容器，再在新服務驗證既有 report 可讀；不能只保留 DB。若無法唯一確認 root，回報未確認並停止替換。

## 已完成檢查與限制

Python AST 與離線 proposal 產生通過；固定 seed、三個不同 slug、尚未建立 result state 已檢查。沿用現有公開 API fixture 的 tests/editing-session/draft 模式及既有 messages request；本輪沒有執行 API／模型／DB／容器查核，因此現場升級狀態、slug 可用性與 artifact 實際目錄仍待 PM 確認。
