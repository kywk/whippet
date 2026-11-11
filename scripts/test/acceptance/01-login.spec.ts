import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://host.docker.internal:18080' });

const FIXED = '固定頁面：成功範例';
const escFixed = FIXED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('登入 Workspace 與搜尋固定測試', async ({ page }, testInfo) => {
  test.setTimeout(45000);

  await test.step('開啟首頁並登入', async () => {
    await page.goto('/');
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    await expect(page.getByRole('heading', { name: '測試' }).first()).toBeVisible({ timeout: 10000 });
  });

  await test.step('確認 Workspace 為預設值', async () => {
    const combo = page.getByRole('combobox', { name: 'Workspace' });
    await expect(combo).toHaveCount(1, { timeout: 10000 });
    await expect(combo.first()).toBeVisible({ timeout: 10000 });
    const defOpt = page.getByRole('option', { name: '預設 Workspace' });
    await expect(defOpt.first()).toBeAttached({ timeout: 10000 });
    const defVal = await defOpt.first().getAttribute('value');
    const curVal = await combo.first().inputValue();
    if (defVal === null || defVal === '') {
      expect(curVal).toBe('預設 Workspace');
    } else {
      expect(curVal).toBe(defVal);
    }
    await expect(
      page.getByRole('complementary', { name: 'Workspace 測試列表' }).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('searchbox', { name: '搜尋測試' }).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('button', { name: '返回登入', exact: true }).first(),
    ).toBeVisible({ timeout: 10000 });
    await testInfo.attach('登入完成', {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  await test.step('搜尋固定測試僅一筆', async () => {
    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await search.fill(FIXED);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const allBtns = listRegion.getByRole('list').first().getByRole('button');
    await expect(allBtns).toHaveCount(1, { timeout: 10000 });
    await expect(allBtns.first()).toContainText(FIXED, { timeout: 10000 });
    await testInfo.attach('搜尋結果', {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  await test.step('進入詳情確認標題', async () => {
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const fixedBtn = listRegion.getByRole('button', { name: new RegExp('^' + escFixed) });
    await fixedBtn.first().click();
    await expect(
      page.getByRole('region', { name: '測試詳情' }).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: FIXED, exact: false }).first(),
    ).toBeVisible({ timeout: 10000 });
    await testInfo.attach('測試詳情', {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  await test.step('返回登入頁確認可重新登入', async () => {
    const backBtn = page.getByRole('button', { name: '返回登入', exact: true });
    await expect(backBtn).toHaveCount(1, { timeout: 10000 });
    await backBtn.first().click();
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await expect(loginBtn.first()).toBeVisible({ timeout: 10000 });
  });
});
