import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://host.docker.internal:18080' });

const FIXED = '固定頁面：成功範例';
const escFixed = FIXED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('固定成功範例歷史報告可讀', async ({ page }, testInfo) => {
  test.setTimeout(45000);

  await test.step('登入並進入固定成功範例', async () => {
    await page.goto('/');
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    await expect(page.getByRole('heading', { name: '測試' }).first()).toBeVisible({ timeout: 10000 });
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    await expect(listRegion).toBeVisible({ timeout: 10000 });
    const fixedBtn = listRegion.getByRole('button', { name: new RegExp('^' + escFixed) });
    await expect(fixedBtn).toHaveCount(1, { timeout: 10000 });
    await fixedBtn.first().click();
    await expect(
      page.getByRole('region', { name: '測試詳情' }).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  await test.step('等待至少一筆通過歷史', async () => {
    const table = page.getByRole('table', { name: '測試執行歷史，最新紀錄在前' });
    await expect(table).toHaveCount(1, { timeout: 10000 });
    await expect(table.first()).toBeVisible({ timeout: 10000 });
    const passRows = table.first().getByRole('row', { name: /通過/ });
    await expect(passRows.first()).toBeVisible({ timeout: 10000 });
    await testInfo.attach('歷史表格', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  await test.step('開啟首筆通過報告並驗證內容', async () => {
    const table = page.getByRole('table', { name: '測試執行歷史，最新紀錄在前' }).first();
    const passRow = table.getByRole('row', { name: /通過/ }).first();
    const link = passRow.getByRole('link', { name: '開啟報告（新分頁）' });
    await expect(link).toHaveCount(1, { timeout: 10000 });
    const popupPromise = page.waitForEvent('popup');
    await link.first().click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    const body = popup.locator('body');
    await expect(body).toContainText(/Passed\s*1/, { timeout: 10000 });
    await expect(body).toContainText(/Failed\s*0/, { timeout: 10000 });
    const text = (await body.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    await testInfo.attach('驗證報告', {
      body: await popup.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await popup.close();
  });
});
