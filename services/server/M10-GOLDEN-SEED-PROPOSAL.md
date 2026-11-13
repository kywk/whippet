# M10.8 G05／G06 seed 提案（尚未建立或發布）

目標為全新 QA Workspace `m10-golden-r102`，唯一合成 origin `https://m10-golden.invalid`。等待 PM 審核正式 proposal；本文件不代表 seed 已驗證。

## G05：固定頁面：成功範例

Module 建議 slug `golden-ready-page`、kind `setup`、exportName `prepareReadyPage`，named args `{page}`。inputs 為 Playwright page；returns `{heading:string}`；前置是已核准本機 setContent，不需登入或網路。body：

```ts
export async function prepareReadyPage({page}) {
  await page.setContent('<h1>Whippet ready</h1>');
  return {heading: 'Whippet ready'};
}
```

harness 從 `@lib/golden-ready-page` 匯入函式，以 `test.step('Stage 1: prepare',...)` 呼叫，再以 `test.step('Stage 2: heading',...)` 對 `page.getByRole('heading')` 做 `toHaveText('Whippet ready')` 及 `toBeVisible()`。禁止 goto、fetch、外部資源及 credentials。

發布前必須真 body+harness bundle validation、回收、獨立 Module summary、人工 API publish；取得固定 version ID 後才提供給 QA。G05 應驗搜尋命中此名稱／slug、讀同一固定版本、產生固定版本 reuse 證據，不以單純提及名稱或複製文字冒稱已搜尋。

## G06：登入片段（缺角色阻擋範例）

Module 建議 slug `golden-login-role-gap`、kind `setup`、exportName `prepareLoginRoleGap`，named args `{page}`。用途僅是展示合成表單與「未配置 Workspace 角色」的可觀察阻擋；不是可登入的 Module，不接帳密參數、不讀環境或檔案。

```ts
export async function prepareLoginRoleGap({page}) {
  await page.setContent('<label>帳號<input name="username"></label>' +
    '<label>密碼<input name="password" type="password"></label>' +
    '<button disabled>登入</button>' +
    '<p role="status">缺少 Workspace 角色與 credentials；未執行登入</p>');
  return {status: 'blocked', reason: 'workspace_role_not_configured'};
}
```

harness 匯入 `@lib/golden-login-role-gap`，確認兩輸入值皆空、登入按鈕 disabled、status 顯示缺口，並斷言回傳 blocked／固定 reason。metadata preconditions 明示本 seed 專用於 roles=[] 的 fixture；postconditions 僅保證缺角色阻擋 UI，沒有登入成功或驗證 credentials。

若後續另行配置角色，不能沿此 seed 冒稱真登入測試，應走正式 Workspace role／credentials 工具與新的授權及驗收；本輪不配置角色或秘密。不把 golden prompt 的 password sentinel 寫進任何 body/harness/metadata。

## 驗收界線與需 PM／QA 對齊處

- G06 prompt 要求無角色回報缺口，但 blackbox 同時寫「script 仍可通過合成 login 頁」。本 proposal 的 harness PASS 只代表缺口阻擋模式通過，不能算 login／credentials 成功；QA 應分開記錄此兩件事，不能以假登入補分。
- Catalog 只包含已發布 Module；舊預設一般 Test 不會自動變成 G05 Catalog seed。必須先發布新的合法 Module 固定版。
- 普通 test-author 當前無 Catalog 工具；搜尋／固定版 reuse 應由具 Catalog 能力的 planner 流程提供。G05/G06 黑箱若仍要求「普通 test-author 搜尋 Module 後直接產 spec」，須由 PM／QA 先固定路由與期望，seed 本身不能補出未授權工具能力。
- 本輪只讀題目、產 Workspace proposal 與設計 seed；沒有建立 seed Test、驗證、摘要、發布或確認 scope。
