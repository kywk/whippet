# M10 合成商店

僅供隔離驗收，使用 Node 內建模組，沒有外部依賴、CDN、付款或真實帳號。
PM 在記憶體產生 `FIXTURE_USERNAME`／`FIXTURE_PASSWORD`，同一組透過 Whippet 正式角色 credentials API 注入；不得寫入 prompt、Module、證據或此目錄。`PORT` 預設 8080。

`GET /login` → 正確帳密 `POST /login` → HttpOnly session → 受保護 `/products?q=Whippet` → `POST /orders` → `/orders/<新 UUID>`。登入成功必須斷言受保護頁的 `account-state`，不能只看表單提交。訂單查詢綁定目前 session；每次下單產新 ID，後續以該 ID 核對商品、數量、總額、狀態，不能讀舊訂單代替。

部署使用已存在且固定 ID 的 Node 映像，唯讀掛載此腳本；不下載套件。只在 M10.9 專用網路啟動，待 Runtime 確認 Worker 可達 origin 後才正式確認 scope。不得把 `.invalid` DOM fixture 或缺角色結果當作本流程登入成功。

所有資料只存程序記憶體，重啟即消失。此為 HTTP 隔離測試站，cookie 不設 Secure；不可對外部署或用於真實資料。沒有 request/body/cookie 存取日誌。驗收證據只留狀態碼、合成商品／訂單 ID 與斷言結果。
