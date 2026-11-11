# Whippet

Self-hosted Playwright 測試平台，讓 QA 透過對話建立、驗證與發佈測試，並由遠端 Worker 執行。

M1 本機流程已於 2026-11-11 由總指揮與 Muse 驗收完成：開發登入、固定測試、真實成功／斷言失敗執行及 Playwright 報告均已串通，兩份報告皆可在保留 sandbox 隔離下正常顯示。M2 草稿編輯、驗證發佈、版本快照、多 Worker、取消及重連已完成本機驗收，見 [M2 紀錄](docs/tracking/devlog/m2-integration.md)。M3 持久對話、AI工具產稿／同對話修復、驗證與確認發佈已完成實測，見 [M3紀錄](docs/tracking/devlog/m3-integration.md)。即時畫面仍待M4；驗收紀錄見 [Server DELIVERY](services/server/DELIVERY.md)。

## 本機啟動

需求：Docker Engine／Docker Desktop／OrbStack、Docker Compose v2 以上及 `openssl`。從 repo 根目錄執行：

```sh
# 產生隨機部署 token、DB 密碼、持久工作目錄；既有 .env 不覆寫。
sh deploy/init-local.sh

# 首次建置服務映像；已有對應映像時可省略。
docker compose --env-file deploy/.env -f deploy/compose.server.yml build server web
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build manager

# 僅在 whippet-worker:m1 尚不存在時建置；Worker 不作為常駐服務啟動。
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build worker

# 先啟動 DB／Server／Web，再啟動同一 Docker daemon 上的 Manager。
docker compose --env-file deploy/.env -f deploy/compose.server.yml up -d --no-build --wait
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml up -d --no-build manager
```

開啟 **http://localhost:18080**，點擊開發登入，選擇「固定頁面：成功範例」並執行。Server readiness 為 **http://localhost:18081/readyz**。Web／Server 僅綁定 `127.0.0.1`，PostgreSQL 不發布主機埠。

「固定頁面：斷言失敗範例」會刻意產生 `failed`，用於確認失敗狀態與報告；兩份腳本都使用本地 `page.setContent`，不依賴外網。完整檢查、持久化、停止與獨立 runner 設定見 [本機 M1 操作指南](docs/guides/local-m1.md)。

`deploy/.env` 與 `deploy/.local/` 留在本機，請保留部署 token、穩定的 Manager ID 與 journal；重新啟動不需要重新初始化。

## 專案文件

- [MVP 範圍](docs/requirements/mvp.md)
- [架構](docs/architecture/design.md)
- [實作進度](docs/tracking/implementation.md)
- [Agent 分工](docs/tracking/delegation.md)
- [M1 共用契約](contracts/mvp-v1.md)
- [M2 草稿、驗證與發佈](docs/guides/m2-drafts.md)
- [OpenCode Go Muse AI Worker 設定](docs/guides/opencode-go.md)
- [M3 AI 對話編輯與 Runner 設定](docs/guides/m3-authoring.md)

Server／Manager 使用 Go，Worker 使用 Node.js／TypeScript 與 Playwright，前端使用 React SPA，資料庫為 PostgreSQL。
模型 key 與 Manager token 請放在部署環境，不提交到原始碼。

開源授權仍待定案；目前不宣稱已採用 Apache-2.0。
