# M11 集中 UI 驗收報告

## 範圍與方式

本報告涵蓋普通 Test、Module 與 Use Case 的指定 UI／外部 Agent 交接；不是整個 M11 的安全性或 session／LiveView 驗收結論。QA 僅操作真實 Web DOM，未讀取 cookie、管理 key、Agent Token 或原始 log，未攔截產品 API，也未代 Agent 修改稿件。正式報告以 UI 開啟並確認載入；版本與 Run ID 均為非機密識別值。

## A：普通 Test（r3）

- **通過**：真 UI 切換 external，建立 Test 並保存訂單查詢正、反需求；全新 MCP Agent 提交後，UI 核對 AI revision 2、正式驗證成功及報告可開啟。
- Test `a3af2385-a7c0-4167-9aee-409485518df1`；validation Run `1d869f03-ce04-4134-8263-cfb6f2534cf9`。
- 需求只送出一次。r3 證據保留，後續環境切換未重送 A。

## B：Module（r5）

- **初版已發佈**：真 MCP Agent 建立 Module；QA 透過 UI 核對 AI revision 2、正式驗證、報告、有效 external 摘要及四項發佈條件，人工勾選並發佈。初版 validation Run `fd3bdda4-19e0-4350-8bae-b50fc17c049c`。
- **ABI 定向 red**：PM 回報後續 Use Case 驗證發現既有 Module 的雙參數介面與 Compose 單物件呼叫不符。三端更新後，QA 以 UI 續編同 Module，確認 body 與當時已發佈版本一致、未修改 harness，只送出一次正式驗證；revision 3 的 Run `63acafc2-fa35-48c6-9cbd-85ce158921a7` 以 `failed` 結束。QA 未讀取原始 log，不單憑 UI 失敗狀態推論失敗原因。
- **修復版已發佈**：MCP Agent 修成單物件介面並完成正式驗證；QA 核對 AI revision 4、validation Run `fa722a8c-ac99-4d47-ab23-e52be2bd7daa`、真報告與有效 external 摘要，人工勾選並發佈。UI 顯示版本 `f9e84377-31d6-4b49-84b3-39c4c3a9ab49`。
- Module Test `e4bfd5ea-8026-475d-a2fb-a4cfb55f9bf3`。初版與修復版使用不同檢查點與驗證證據。

## C：Use Case（r5）

- 最初兩個 reuse Stage 的 Plan 曾由 UI 人工確認；正式驗證失敗後，PM 定位為上述 Module ABI 問題。修復 Module 並確認新版 Plan 後，validation Run `c9166f70-7ccf-4f91-9860-42b01089d649` 又以 `timed_out` 結束；QA 未自行重驗。PM 定向診斷指出需先導航至目標頁面；QA 以 UI 重新讀取 Plan，確認已停止及失敗。
- QA 檢視 Plan revision 7 的四階段設計：新建導航、兩個固定修復版 Module 的正反查詢、以及新建結果驗證 Module；末階段兩筆完整回傳綁定與 PM 提供的權威 Stage ID／空 path 一致。QA 透過 UI 人工確認此設計，並未在產稿前宣稱斷言已實作。
- 導航 Stage 首次外部 Author 達硬期限，未提交。QA 透過 UI 確認可重試、原工作已回收及來源版本後，依 PM 指示人工送出一次修復請求；新 Author Run `ffe7488c-4ff4-4013-beeb-a36b2e602a1d`。未重送該請求。
- **最終整批已發佈**：Plan revision 11 的四個 Stage 在 UI 均顯示就緒，兩個 reuse Stage 固定修復版 Module。Use Case revision 4 的正式 validation Run `131be1a6-ea00-4578-a348-2a03f3764a75` 在 UI 顯示成功，真報告可開啟。
- QA 從 UI 唯讀檢視 verifier 草稿與 harness：可見正反訂單物件的相等斷言、目前狀態文字斷言，以及兩項拒絕測試。PM 另獨立檢視正式 Run 不可變 bundle，回報斷言與正式測試證據；UI 草稿檢視與 PM 的 bundle 檢查是兩種不同證據，未將前者冒稱為不可變 bundle 檢查。
- QA 核對 external 整批摘要 Run `a34600e5-a37f-4785-be19-ddd22550a2bd`、Plan 11、兩個候選與發佈資格後，以 UI 勾選並人工整批發佈一次。Use Case 版本 `fc9f75b4-f619-4595-9b5d-2d48fcc856ef`；兩個候選版本 `f3039cc8-9d7f-48f7-8af2-61440a08235a`、`d9eb63ee-353a-417a-af1e-d1302fb20f94` 均在真 UI Module Catalog 可見。
- Use Case Test `e145d81a-a07e-4ce8-b1a8-9ea6f130228d`；Plan `665a8da0-1f5e-4bc0-ad66-c4a04ddddb1d`。

## 限制

各階段來自不同隔離環境：A 為 r3，B／C 為 r5；不得解讀為單一環境中連續完成全部階段。QA 未讀取原始對話、原始執行 log 或機密；前述由 PM 提供的診斷與不可變 bundle 檢查已明確標示其來源。獨立 session／LiveView 驗收由其他 owner 回報。
