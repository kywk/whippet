import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://host.docker.internal:18080' });

const FIXED = '固定頁面：成功範例';
const escFixed = FIXED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('未存編輯防護不送出', async ({ page }, testInfo) => {
  test.setTimeout(45000);
  let orig = '';

  await test.step('登入並開啟固定成功範例', async () => {
    await page.goto('/');
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    await expect(page.getByRole('heading', { name: '測試' }).first()).toBeVisible({ timeout: 10000 });
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const fixedBtn = listRegion.getByRole('button', { name: new RegExp('^' + escFixed) });
    await expect(fixedBtn).toHaveCount(1, { timeout: 10000 });
    await fixedBtn.first().click();
    await expect(
      page.getByRole('region', { name: '測試詳情' }).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  await test.step('確認草稿已載入且送出可用', async () => {
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本');
    await expect(scriptBox).toHaveCount(1, { timeout: 10000 });
    await expect
      .poll(async () => (await scriptBox.first().inputValue()).trim().length, { timeout: 10000 })
      .toBeGreaterThan(0);
    orig = await scriptBox.first().inputValue();
    const msgBox = page.getByLabel('測試需求或修改訊息');
    await expect(msgBox).toHaveCount(1, { timeout: 10000 });
    await msgBox.first().fill('驗收合成：未存防護檢查');
    const sendBtn = page.getByRole('button', { name: '送出訊息', exact: true });
    await expect(sendBtn).toHaveCount(1, { timeout: 10000 });
    await expect(sendBtn.first()).toBeEnabled({ timeout: 10000 });
  });

  await test.step('未存修改時鎖定送出驗證發佈', async () => {
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本').first();
    await scriptBox.fill(orig + '\n// unsaved acceptance check');
    const sendBtn = page.getByRole('button', { name: '送出訊息', exact: true });
    await expect(sendBtn.first()).toBeDisabled({ timeout: 10000 });
    const validateBtn = page.getByRole('button', { name: '驗證此 revision', exact: true });
    await expect(validateBtn).toHaveCount(1, { timeout: 10000 });
    await expect(validateBtn.first()).toBeDisabled({ timeout: 10000 });
    const cb = page.getByRole('checkbox', { name: /^我已檢視驗證報告，確認發佈 revision/ });
    await expect(cb).toHaveCount(1, { timeout: 10000 });
    await expect(cb.first()).toBeDisabled({ timeout: 10000 });
    await expect(
      page.getByText('有未儲存的腳本編輯，請先儲存草稿再送出訊息。', { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await testInfo.attach('防護鎖定', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  await test.step('還原後送出恢復且免存', async () => {
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本').first();
    await scriptBox.fill(orig);
    const sendBtn = page.getByRole('button', { name: '送出訊息', exact: true });
    await expect(sendBtn.first()).toBeEnabled({ timeout: 10000 });
    const saveBtn = page.getByRole('button', { name: '儲存草稿', exact: true });
    await expect(saveBtn).toHaveCount(1, { timeout: 10000 });
    await expect(saveBtn.first()).toBeDisabled({ timeout: 10000 });
    await testInfo.attach('還原完成', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  await test.step('重載後草稿仍為原值', async () => {
    await page.reload();
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const fixedBtn = listRegion.getByRole('button', { name: new RegExp('^' + escFixed) });
    await expect(fixedBtn).toHaveCount(1, { timeout: 10000 });
    await fixedBtn.first().click();
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本');
    await expect(scriptBox).toHaveCount(1, { timeout: 10000 });
    await expect(scriptBox.first()).toHaveValue(orig, { timeout: 10000 });
  });
});
