# Whippet 新 PM 對話交接（2026-11-12）

## 本輪授權與下一步

使用者要求先 commit，再開全新 PM 對話推進；之後所有派工也開新對話，不續用 t30/t31/t32/t33 等長對話。主要欠整合驗收，不是已知未開發功能：
1. 真 AI／Workspace 探索→改稿→真驗證→摘要→人工發布全鏈（現有 proposal/summary 是 HTTPS 模型替身，不能當真 AI）。
2. 敏感輸入期間新 viewer 加入的真 UI 黑箱驗收（防護已實作）。
只修實際發現的缺陷；不要重跑已 PASS 矩陣，不擴 M9／本機瀏覽器產品功能。

繁體中文，不安裝、不輸出憑證、不讀印或複製 deploy/.env.ai、不 push。此次提交授權僅本波，後續 commit 另依使用者指示。真模型若缺安全的既有接線，先查非機密配置與已授權可用入口，不自行輸出或搬運金鑰。

## 新對話仍屬同一 Herdr RPG session

已讀本機 mods/herdr-crew-rpg/{main.js,house.js}：crew=1 的 terminals 才進 crew；sessionOf 沿 parent 向上最多8層，遇非 crew parent、無 parent 或缺失 parent 時決定 session key。不是用 Codex thread ID，也不是只看 tab。

使用者最新更正：**新 PM 對話本身是獨立根節點**，舊 t36 將關閉。新 PM 必須以 `--no-parent` 啟動且 `parent=null`、`crew=1`；後續新 agents 用 `--parent <新PM位址>`（或同根下的owner）與 `crew=1`，全部留在新 PM 的 RPG session。不依賴 t36，亦不修改 Herdr mod 程式。舊錯誤鏈 t3q→t36、t3r→t3q 已停止，未改產品或執行新測試；不要恢復它們。

固定畫面標籤：
- herdr.space=spc410627697c591af2a35cc533b8f1ad8
- herdr.tab=whippet-ui-ux-20261112
- cwd=/Users/kywk/kywk/project/whippet（space 的舊 folder metadata 曾錯，永遠明確給 cwd）
- --keep --outlive-parent；crew.task/tool/model/effort 如實標示，啟動後 hc get 核對 parent/labels/argv，hc read 核對實際有效模型。

路由：PM gpt-6-astra/low；開發 gpt-6.1-sol/xhigh；困難問題才 astra/medium；純黑箱 QA opencode-go/muse-spark-1.3-contributor#xhigh。**禁止 opencode mini**；標準 opencode run 可經 hc 管理可見 pane，另核對 reported/status，不假定一定有 OSC。不要從 mini 續跑既有 session。按需讀 skills/herdr-qa-opencode。

## Owner 與入口

PM docs/contracts/deploy/隔離整合；新 Web owner apps/web；新 Server owner services/server；新 Runtime owner services/manager+runtimes/worker；新 QA 僅指定 scripts/test 與 evidence。每檔單 owner。純測試用 Muse；PM 有 Docker 可替 QA 執行腳本，不把交腳本當 PASS。
先讀 AGENTS.md、tracking/verification 細則、implementation.md 最新尾端、delegation.md、contracts/mvp-v8.md 最新追加規則。各模組 DELIVERY 保留精確證據。

## 現行 B 隔離環境

Web http://127.0.0.1:18087；原生 TLS API https://127.0.0.1:18089。容器 whippet-m8b-{web,server,manager,postgres}，network whippet-m8b-wave。Web/Server/Manager/Worker 都已切 :m8-mask-qa；不要拿舊18080/18085/18086作新證據，也不動它們。

產物：/private/tmp/whippet-server-m8-live-offer、whippet-manager-m8-mask、runtimes/worker/dist+skills、apps/web/dist。Web asset index-CwSWSYQ9.js SHA256=560d23aa39994064ab9f3b1517fe6168f73013ab12d8e24273fa77046bf2415d。

環境資料 /private/tmp/whippet-m8-wave；合成 master key/token 僅既有容器環境，保持原值、不可印出，不重跑 start.py。Server/Manager TLS 使用同目錄 tls 的合成公憑證，需真 CA/SAN 驗證。Manager 工作目錄 /private/tmp/whippet-m8-wave/work；MAX_WORKERS=1，同一 Test/viewer 不併行搶占。

whippet-m8b-fixture：18187 合成網站、18188 HTTPS Responses fixture（僅 workspace-author/acceptance-summary，非真 AI）。/slow-login 按鈕12秒後可用，/slow-session 延遲整個回應12秒，登入後10秒進度與合成敏感 echo；/slow-status 只記非機密 submittedAt/responseAt/count。whippet-m8b-progress 18190是已驗普通監看的30秒頁。

Workspace 2f8aa581-c593-4e89-bc8a-a70641929a77；合成角色5b9ab57a-4152-4559-914f-aaf362e24787（configured），已確認origin http://host.docker.internal:18187。不把帳密寫入 spec/model。完整人工腳本由 loginAs 五參數走真 Server TLS resolve。

## 已 PASS，勿重跑

- Server/Manager/Worker/Web 定向單元及 build，數字見 DELIVERY。
- 真公開 API 主線：validation b4129af8、formal29f05216 expected1/unexpected0；模型 proposal/summary 為 fixture，非真 AI。
- 真報告瀏覽／ZIP解壓／PNG：/private/tmp/whippet-m8-artifacts-evidence。
- 普通 manual LiveView WebRTC+JPEG、停止不取消Run：076e956b；/private/tmp/whippet-m8-live-evidence。
- Workspace真UI隔離：/private/tmp/whippet-m8-isolation-evidence/iso-result.json。
- Workspace核心後段含續編/取消刪除/真正discard為 checkpoint分段 PASS；/private/tmp/whippet-m8-ui-evidence/M8-CORE-PASS-NOTE.md。50c183ac session 已discarded，勿重刪。末尾URL-only GET abort歷史未分類保留，後續diag選Test略過不能冒充全網路乾淨。
- **敏感監看兩模式公開三端 PASS**：WebRTC c9f05ad9-84e3-40ac-ad97-06dc2d308283；JPEG4443b587-0ea3-4d2c-9351-b4a5bb71dd84。/private/tmp/whippet-m8-login-live-evidence/M8-MASK-PASS.md、pm-review.json、webrtc-retry/jpeg子目錄含去敏WS事件/取樣/三階段PNG/fixture時序。真UI validate、核心清畫面且無新媒體、complete先於新圖/新offer、answer echo、恢復真影格、合成echo目視遮蔽。僅manual slow-login；不涵蓋中途viewer/author。

QA敏感腳本 scripts/test/m8-login-live-ui.cjs 已由PM接手修正欄位/截圖/草稿重載並實跑。MODE=webrtc|jpeg；JOIN_DURING_SENSITIVE 分支尚未黑箱驗證且需先檢查本身是否仍以原viewer判整體（不要用未驗分支當產品失敗）。QA容器共享Web namespace，WEB_URL=http://127.0.0.1，避免瀏覽器credential guard拒非loopback HTTP；僅掛指定腳本與 evidence，不全repo掛載。

## 交接完成標準

確認此次兩個 commit 及乾淨工作目錄；新 PM parent=null，所有新 agents 的 RPG key 為新 PM 位址，再開新的必要owner/QA對話。進度以 implementation.md 為唯一來源；實跑後記結果與限制。M8仍進行中，不能以本波敏感監看PASS宣稱全完成。
