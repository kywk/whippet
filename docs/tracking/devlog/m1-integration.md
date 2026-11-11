# M1 本機整合

2026-11-11，Mac／OrbStack。

- Web 完整 TypeScript＋Vite build 通過；Worker 正式型別檢查及 build 通過。兩者 lockfile 已產生。
- Web、Server、Manager、Worker 四個 Docker 映像均建置成功。
- 本機 Web http://localhost:18080、API http://localhost:18081；DB／Server／Web healthy，Manager 已連線 capacity=1。
- 使用者指定的 Muse Spark 1.3 Contributor xhigh（herdr t33）負責黑箱測試腳本，主回合代跑 Docker；不提供原始碼與憑證。
- Chromium 開發登入、列表兩個合成測試通過。
- 成功測試 Run `227c0395-8575-4dac-ae57-fad845b7a78b` 實際為 succeeded，Worker 回收且 reportUrl 已產生。
- 首次報告呈現失敗：Playwright HTML report 在 sandbox 下存取 localStorage 觸發 SecurityError，畫面空白。已交 t31 修復，重用既有報告驗證，不重跑成功案例。
- 斷言失敗案例待報告修復後執行；M1 尚未驗收完成。

## 修復與驗收結果

Server 以僅限頁面生命週期的 storage shim 修復報告相容性，保留 opaque sandbox 與禁止外部連線；保存的原始附件不修改。Server 重建部署後，Muse 續測腳本 exit 0。

| 案例 | Run | 實際結果 | 報告可見內容 |
| --- | --- | --- | --- |
| 成功 | 227c0395-8575-4dac-ae57-fad845b7a78b | succeeded | Passed1 / Failed0 |
| 刻意斷言失敗 | 8d006958-875a-472f-a573-1ab0fa79eecf | failed | Passed0 / Failed1 |

兩案例均由真實 UI 建立 Run，經 Go Server → Manager → Docker Playwright Worker 執行。兩個任務各只建立一次；修復後直接重開既有成功報告。驗收於 Chromium 完成，不以 HTTP 200 代替報告呈現。

M1 完成；M2 的草稿／驗證發佈、多併發與取消、M3 AI、M4 即時畫面仍待實作。這次是 Mac 上 Linux 容器的代表性驗證，不宣稱跨主機或其他 CPU 架構已驗證。
