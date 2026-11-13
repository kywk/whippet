# Whippet PM 交接（2026-11-12，M9本機驗收後）

唯一進度來源：[implementation.md](../implementation.md) 最新「M9 本機 MVP 驗收收尾」。M7–M9本機功能已完成；不要依舊交接重跑M8或重新派歷史retrieval開發。

## 使用者授權與根節點

- 使用者最新要求：「我要出門運動，請盡可能推進專案的完整開發與驗收」。本輪已實際完成M9整合／根因修復／真模型驗收與映像盤點。
- 繁體中文；不安裝／下載新依賴、不讀印或複製deploy/.env.ai、不輸出憑證、不push。
- 使用者最新明確要求commit、停止舊服務、清理不用的worktree/branch。M9功能／驗收／盤點已提交d2ba719，未push；本次環境整理另保存紀錄。不要用git reset/clean覆蓋成果。
- 當前PM t3v為獨立根parent=null、crew=1，effective gpt-6-astra/low已核實。t36及錯誤舊鏈t3q/t3r不恢復。
- 新對話若取代PM須--no-parent；新owner/QA須全新對話、parent接當前PM、crew=1，明確cwd=/Users/kywk/kywk/project/whippet，--keep --outlive-parent。
- 同space=spc410627697c591af2a35cc533b8f1ad8、tab=whippet-ui-ux-20261112。RPG session沿parent鏈決定，非僅tab相同。
- 開發Codex gpt-6.1-sol/xhigh；QA標準opencode run --model opencode-go/muse-spark-1.3-contributor#xhigh，禁mini。按需讀skills/herdr-qa-opencode；核對hc get與實際模型metadata。

## 本輪owner與變更

- t41 Server：services/server；固定/private/tmp/whippet-server-m9，SHA6105c3b9e559c28a6343b3abc0333d95a90d5438d0b5fc29c2966c1486adb750。
- t42 Runtime：services/manager+runtimes/worker；固定/private/tmp/whippet-manager-m9，SHA9ad62d818deb57d950a1e38a11c94ac532967d23493895692f5e9e78b1b217ee；Worker /private/tmp/whippet-worker-m9/{dist,skills}。
- t43/t44 QA已退出；PM接手scripts/test/m9-settings-continuity.cjs、m9-history-live.cjs並實跑。新增m9-history-pm-verify.py為PM唯讀三重證據檢查，不交黑箱QA讀DB。
- t45交付scripts/release/inventory-images.py、docs/release/image-components.md；五映像盤點已跑，不需再跑全套。
- 共同契約contracts/mvp-v9.md、README、架構、進度與本交接為PM owner。
- 所有owner parent=t3v/crew1同space/tab，實際sol/xhigh或Muse/xhigh已核實。產品凍結，只有新具體缺陷才派修；新工作開新對話。

## 執行環境

- 最新Web http://localhost:18087，原生TLS API https://127.0.0.1:18089。whippet-m8b-{web,server,manager,postgres}，network whippet-m8b-wave。
- Server/Manager/Worker :m9-qa；Web :m8-real-qa。最終Worker image ID cda295c1ca394034bfd9de698722c37ea2cfd30e9b9669b24048bba8c0c68ddb；loop.js SHA201f16ef6fe21a3e6bed3f0edb85e485c02b02fdb009f151ff7e031369b10b22。
- DB與原配置保持；Manager真Muse/xhigh、MAX_WORKERS=1。真模型配置只沿既有容器env在記憶體傳遞，未讀.env.ai，未輸出或落檔秘密。
- /private/tmp/whippet-m8-wave含work/artifacts/tls；**不要跑start.py或重新初始化**，會改DB/token/key。舊應用-before-real及-before-m9已停用保留可回復；18080/18085/18086舊環境及舊Manager/DB/QA容器已依使用者要求停止。僅最新B四服務及18187合成網站維持運行；其他專案服務未動。
- TLS CA /private/tmp/whippet-m8-wave/tls/cert.pem。QA容器共享Web namespace，WEB_URL=http://127.0.0.1，僅掛腳本/evidence；避免nonloopback credential guard。
- 合成站whippet-m8b-fixture於18187；/login正常，/slow-login刻意disabled12秒。慢站author登入未成功的限制保留，不重跑已PASS正常/login全鏈。
- 收尾健康檢查兩端200、活躍Run0。兩個暫診斷映像已移除；正式固定包無m9-diagnostic helper，不部署tmp diag包。

## 已驗收，不重跑

M8完整證據：/private/tmp/whippet-m8-real-evidence、whippet-m8-real-publish-evidence、whippet-m8-midjoin-evidence、whippet-m8-workspace-live-evidence。正常角色登入探索→AI產稿→validation→摘要→真UI發布→正式Run及報告PASS；敏感中途viewer WebRTC/JPEG PASS；Workspace author testId=null真媒體PASS（不等於慢站登入成功）。歷史URL-only GET abort仍未分類。

M9設定接續：/private/tmp/whippet-m9-settings-evidence/m9-result.json，Workspace95296031-b243-4bb6-b964-e90dd8af4bb5 revision2→3，Testcea8a396-da05-4517-b877-47add4733cfb同session f615c956-80de-4cd7-a448-aa59f48179ff draft3→4；真模型以新背景答marker，原Version fac81dbf-d7d1-4ace-a4c5-8c902828556f快照不變。撤銷／取消／拒history依t41隔離DB與既有M8證據，未撤銷現有角色。

M9歷史：/private/tmp/whippet-m9-history-evidence/final，Test17d105c5-0d30-48aa-9040-ef3113ca49c9/session c3c1786a-b32a-4cf1-af1d-1b23787025dd；Run400a1505-87cc-4f03-b85e-04003ab71fb3／attempt123945f4-7331-4cf3-83e0-9962bf0e97cb。12則user先queued取消準備合成資料，最終真模型兩頁history成功，預設所有輸入不含答案、history在cutoff86內含答案、同Run assistant答中，complete/reclaimed=true。

只讀重驗證據（不呼叫模型）：
```sh
python3 scripts/test/m9-history-pm-verify.py --evidence-dir /private/tmp/whippet-m9-history-evidence/final
```

根因及修復已完成：真模型把cursor輸出為精確字串"null"，原Worker在IPC前拒絕。只在模型工具入口正規化此別名；HTTP/IPC/HistoryClient仍嚴格。空/空白/大寫/其他非法cursor不接受。新回歸先紅後綠，真Node→Manager→TLS、Docker attach、Server真handler+DB與原27項受影響測試證據見DELIVERY。初始失敗與tmp診斷回合保留，不標PASS。最終Workspace-author歷史未另跑真模型全矩陣，路由/隔離由定向測試涵蓋。

## 剩餘交付限制

- 正常Dockerfile乾淨建置仍缺依賴快取，使用者禁止新安裝/下載；本次COPY-only不替代乾淨安裝驗證。
- 缺可驗遠端Linux主機與TURN/NAT環境；OrbStack本機不等於跨主機驗收。
- Whippet LICENSE待使用者選定，不自行採Apache-2.0。五映像實物盤點已完成，但Alpine/npm/WebKit/Go/前端bundle等完整第三方聲明與發布物仍待補，見image-components.md；勿宣稱已公開發布。
- 官方skill quick_validate缺PyYAML未跑，實際loader/schema/build已驗；不為此安裝。
- 下一步以以上實際缺口為準，不自行加SSO/RBAC、多Manager、排程、Kubernetes或本機瀏覽器執行。

## M10–M12 新階段啟動（2026-11-13）

使用者已確認進入 [Use Case 與 Agent 平台化規格](../../requirements/usecase-agent-platform.md) 三階段（commit `45cb440`）：
- **M10（`main`）**：自研引擎 G1–G6、Module 庫、Catalog、Plan → Stage → Compose；零新外部依賴，沿用既有 COPY-only 映像建置模式。收尾通過 `M10.Z` 後標記 `phase1-verified`。
- **M11（`feat/mcp`，自 `phase1-verified` 分出）**：MCP Streamable HTTP、Agent Token、session 模式與接單模式；收尾通過 `M11.Z` 後 merge 回 `main` 並標記 `phase2-verified`。
- **M12（`feat/agent-adapter`，自 `phase2-verified` 分出）**：2 天 spike（pi-agent-core＋pi-ai vs Vercel AI SDK）→ adapter 實作 → 參考外部 Worker `runtimes/agent-bridge/`；收尾通過 `M12.Z` 後 merge 回 `main` 並標記 `phase3-verified`。
- 依賴授權：使用者於 2026-11-13 授權階段性安裝契約明列之專案依賴（覆蓋 M9 期間的臨時禁令），M10 維持零新依賴，M11／M12 僅安裝 `v11`／`v12` 契約核准項目。
- 任務清單、最小驗證與 Z 項完整驗證以 [implementation.md](../implementation.md) 文末「M10–M12」章節為唯一來源；分工與首波派工見 [delegation.md](../delegation.md) 文末。

## 提交與環境整理（使用者最新指示）

M9提交d2ba719，未push。停止16個舊Whippet服務／QA容器，保留所有volume、資料庫與報告；最新Web18087/TLS18089及測試依賴18187維持。Git僅main及origin/main、一個主worktree，prune dry-run無失效記錄，沒有可刪的多餘branch/worktree；未強刪任何未合併資料。
