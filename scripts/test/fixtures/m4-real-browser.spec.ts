import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://host.docker.internal:18080' });

test('M4 真實瀏覽器操作畫面', async ({ page, context }, testInfo) => {
  test.setTimeout(55000);

  await page.goto('/');
  // DEMO: 首次停 8 秒等觀看者連線
  await page.waitForTimeout(8000);
  const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
  await expect(loginBtn).toHaveCount(1);
  await testInfo.attach('登入頁', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await loginBtn.first().click();
  await expect(page.getByRole('heading', { name: '測試' }).first()).toBeVisible();
  // DEMO: 登入後停 5 秒
  await page.waitForTimeout(5000);

  const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
  await expect(search).toBeVisible();
  await search.fill('固定頁面：成功範例');
  // DEMO: 搜尋停 4 秒
  await page.waitForTimeout(4000);
  const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
  await expect(listRegion).toBeVisible();
  await testInfo.attach('搜尋結果', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  const fixedBtn = listRegion.getByRole('button', { name: /^固定頁面：成功範例/ });
  await expect(fixedBtn).toHaveCount(1);
  await fixedBtn.first().click();
  const detail = page.getByRole('region', { name: '測試詳情' }).first();
  await expect(detail).toBeVisible();
  // DEMO: 詳情停 5 秒
  await page.waitForTimeout(5000);

  const reportLink = detail.getByRole('link', { name: '開啟報告（新分頁）' }).first();
  await expect(reportLink).toBeVisible();
  const popupPromise = context.waitForEvent('page');
  await reportLink.click();
  const popup = await popupPromise;
  await expect(popup).toHaveTitle(/Playwright Test Report/);
  // DEMO: 報告停 6 秒
  await page.waitForTimeout(6000);

  const testLink = popup.locator('a[href^="#?testId="]').first();
  await expect(testLink).toBeVisible();
  await testLink.click();
  // DEMO: 測試明細停 5 秒
  await page.waitForTimeout(5000);
  await testInfo.attach('報告', {
    body: await popup.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await popup.close();

  const backBtn = page.getByRole('button', { name: '返回登入', exact: true });
  await expect(backBtn).toHaveCount(1);
  await backBtn.first().click();
  // DEMO: 返回停 4 秒
  await page.waitForTimeout(4000);
  await expect(page.getByRole('button', { name: '以開發管理員登入', exact: true })).toHaveCount(1);
});
