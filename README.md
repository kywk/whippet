# Whippet

Self-hosted Playwright 測試平台，讓 QA 透過對話建立、驗證與發佈測試，並由遠端 Worker 執行。

M1–M4 已完成本機驗收：固定測試、草稿驗證與不可變版本、AI 對話產稿／修復、WebRTC 唯讀監看與 JPEG 備援。M5 的 Workspace 設定與文字畫質修正已完成模組及隔離驗收；目前運行的既有服務尚未更新。M6 失敗 trace／Markdown 附件已完成隔離全鏈上傳、瀏覽器下載與本機 Trace Viewer 驗收。最新狀態以 [實作進度](docs/tracking/implementation.md) 為準。

本機驗證使用 Mac／OrbStack 的 Linux arm64 容器。Linux Server＋Mac Worker 跨主機與實際 TURN 跨 NAT 尚未驗證；不代表已具備完整正式環境驗證。

## 本機啟動

需求：Docker Engine／Docker Desktop／OrbStack、Docker Compose v2 以上及 `openssl`。從 repo 根目錄執行：

```sh
# 產生隨機部署 token、DB 密碼、持久工作目錄；既有 .env 不覆寫。
sh deploy/init-local.sh

# 首次建置服務映像；程式更新後也需重建，不能只依映像名稱判斷版本。
docker compose --env-file deploy/.env -f deploy/compose.server.yml build server web
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build manager

# 首次或 Worker 程式更新後建置；Worker 不作為常駐服務啟動。
docker compose --env-file deploy/.env -f deploy/compose.runner.yml build worker

# 先啟動 DB／Server／Web，再啟動同一 Docker daemon 上的 Manager。
docker compose --env-file deploy/.env -f deploy/compose.server.yml up -d --no-build --wait
docker compose --env-file deploy/.env -f deploy/compose.runner.yml -f deploy/compose.runner.local.yml up -d --no-build manager
```

首次建置需要取得 Docker 基底映像與鎖定依賴。本輪禁止下載新套件，正常 Dockerfile 的離線建置因依賴層缺少快取而未通過；隔離驗收使用既有映像加已編譯產物，不把此方式當成乾淨安裝證據。

開啟 **http://localhost:18080**，點擊開發登入，選擇「固定頁面：成功範例」並執行。Server readiness 為 **http://localhost:18081/readyz**。Web／Server 僅綁定 `127.0.0.1`，PostgreSQL 不發布主機埠。

「固定頁面：斷言失敗範例」會刻意產生 `failed`，用於確認失敗狀態與報告；兩份腳本都使用本地 `page.setContent`，不依賴外網。完整檢查、持久化、停止與獨立 runner 設定見 [本機 M1 操作指南](docs/guides/local-m1.md)。

`deploy/.env` 與 `deploy/.local/` 留在本機，請保留部署 token、穩定的 Manager ID 與 journal；重新啟動不需要重新初始化。

## 設定與證據

新版 Workspace 設定提供網站清單、預設測試 URL 與執行逾時；模型金鑰仍由部署環境注入。設定變更會建立新的草稿 revision 並要求重新驗證，已發佈版本與已排入任務保留原快照。非空預設 URL 作為 Playwright baseURL；author 僅取得固定資料，不因設定自動導覽。

失敗證據的新版介面提供 ZIP trace／Markdown 下載，入口在平台的執行結果與歷史中。trace 下載後使用已安裝的 Playwright `show-trace <檔案>` 開啟；不提供內嵌 Trace Viewer，影片仍未支援。HTML 報告、PNG 與原本的 sandbox 隔離保留。硬殺前尚未寫出的證據不保證取得。

## 專案文件

- [MVP 範圍](docs/requirements/mvp.md)
- [架構](docs/architecture/design.md)
- [實作進度](docs/tracking/implementation.md)
- [Agent 分工](docs/tracking/delegation.md)
- [M1 共用契約](contracts/mvp-v1.md)
- [M2 草稿、驗證與發佈](docs/guides/m2-drafts.md)
- [OpenCode Go Muse AI Worker 設定](docs/guides/opencode-go.md)
- [M3 AI 對話編輯與 Runner 設定](docs/guides/m3-authoring.md)
- [即時監看與備援](docs/guides/live-view.md)
- [Workspace 設定契約](contracts/mvp-v5.md)
- [失敗證據附件契約](contracts/mvp-v6.md)

Server／Manager 使用 Go，Worker 使用 Node.js／TypeScript 與 Playwright，前端使用 React SPA，資料庫為 PostgreSQL。
模型 key 與 Manager token 請放在部署環境，不提交到原始碼。

開源授權仍待定案；目前不宣稱已採用 Apache-2.0。

## 直接依賴與授權盤點

2026-11-11 依專案 manifest、已安裝套件 LICENSE 與 Go module cache 核對。此表是直接依賴盤點，未涵蓋全部傳遞依賴或容器組件，也不取代各套件原始 LICENSE／NOTICE。

| 模組 | 依賴與版本 | 授權 |
| --- | --- | --- |
| Web | react、react-dom 19.2.0 | MIT |
| Web 開發 | @types/node 22.18.6、@types/react／@types/react-dom 19.2.2 | MIT |
| Web 開發 | @vitejs/plugin-react 5.0.4、vite 7.1.9（core） | MIT |
| Web 開發 | typescript 5.9.3 | Apache-2.0 |
| Server | github.com/gorilla/websocket v1.5.3 | BSD-2-Clause |
| Server | github.com/lib/pq v1.10.9 | MIT |
| Manager | golang.org/x/net v0.56.0 | BSD-3-Clause |
| Worker | @playwright/test 1.64.1 | Apache-2.0 |
| Worker 開發 | @types/node 22.10.2 | MIT |
| Worker 開發 | typescript 5.7.3 | Apache-2.0 |

Dockerfile 宣告的 runtime 基底包括 Playwright v1.64.1-noble、distroless static-debian12、Alpine 3.23.2（另含 docker-cli／ca-certificates）、Nginx 1.28.0-alpine 與 PostgreSQL 16.11-bookworm。映像內 OS、瀏覽器、FFmpeg、Node.js／npm 與其他組件各有授權；本輪未完成逐項核實，不能以 Playwright 的 Apache-2.0 概括整張映像。發布映像前仍須補齊適用的第三方聲明。Whippet 本身的 LICENSE 仍待使用者選定。
