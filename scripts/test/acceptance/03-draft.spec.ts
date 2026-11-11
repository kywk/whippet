import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://host.docker.internal:18080' });

const DRAFT_TS = `import { test, expect } from '@playwright/test';
test('acceptance draft', async ({ page }) => {
  await page.setContent('<h1>Whippet acceptance draft</h1>');
  await expect(page.getByRole('heading')).toHaveText('Whippet acceptance draft');
});`;

test('新增並暫存草稿不驗證', async ({ page }, testInfo) => {
  test.setTimeout(45000);
  const draftName = '驗收產物・草稿・' + Date.now();

  await test.step('登入並新增測試', async () => {
    await page.goto('/');
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    await expect(page.getByRole('heading', { name: '測試' }).first()).toBeVisible({ timeout: 10000 });
    const addBtn = page.getByRole('button', { name: '新增測試', exact: true });
    await expect(addBtn).toHaveCount(1, { timeout: 10000 });
    await addBtn.first().click();
    const nameField = page.getByLabel('測試名稱');
    await expect(nameField).toHaveCount(1, { timeout: 10000 });
    await nameField.first().fill(draftName);
    const descField = page.getByLabel('描述（選填）');
    await expect(descField).toHaveCount(1, { timeout: 10000 });
    await descField.first().fill('驗收合成草稿，僅暫存不驗證');
    const createBtn = page.getByRole('button', { name: '建立測試', exact: true });
    await expect(createBtn).toHaveCount(1, { timeout: 10000 });
    await createBtn.first().click();
    await expect(
      page.getByRole('region', { name: '測試詳情' }).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  await test.step('填寫草稿並儲存', async () => {
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本');
    await expect(scriptBox).toHaveCount(1, { timeout: 10000 });
    await scriptBox.first().fill(DRAFT_TS);
    const saveBtn = page.getByRole('button', { name: '儲存草稿', exact: true });
    await expect(saveBtn).toHaveCount(1, { timeout: 10000 });
    await saveBtn.first().click();
    await expect(page.getByText(/儲存成功|已儲存|儲存完成/).first()).toBeVisible({ timeout: 10000 });
    await expect(saveBtn.first()).toBeDisabled({ timeout: 10000 });
    await expect(scriptBox.first()).toHaveValue(DRAFT_TS, { timeout: 10000 });
    await testInfo.attach('儲存完成', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  await test.step('確認未驗證不可發佈執行', async () => {
    const pubBtn = page.getByRole('button', { name: /^確認發佈 revision/ });
    await expect(pubBtn).toHaveCount(1, { timeout: 10000 });
    await expect(pubBtn.first()).toBeDisabled({ timeout: 10000 });
    const cb = page.getByRole('checkbox', { name: /^我已檢視驗證報告，確認發佈 revision/ });
    await expect(cb).toHaveCount(1, { timeout: 10000 });
    await expect(cb.first()).toBeDisabled({ timeout: 10000 });
    const runBtn = page.getByRole('button', { name: '執行測試', exact: true });
    await expect(runBtn).toHaveCount(1, { timeout: 10000 });
    await expect(runBtn.first()).toBeDisabled({ timeout: 10000 });
  });

  await test.step('重載後草稿一致且未發佈', async () => {
    await page.reload();
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await expect(loginBtn).toHaveCount(1, { timeout: 10000 });
    await loginBtn.first().click();
    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await expect(search).toBeVisible({ timeout: 10000 });
    await search.fill(draftName);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const row = listRegion.getByRole('button', {
      name: new RegExp('^' + draftName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await row.first().click();
    const scriptBox = page.getByLabel('Playwright TypeScript 腳本');
    await expect(scriptBox).toHaveCount(1, { timeout: 10000 });
    await expect(scriptBox.first()).toHaveValue(DRAFT_TS, { timeout: 10000 });
    await expect(page.getByText(/未發佈|未發布|尚未驗證|尚未發佈/).first()).toBeVisible({ timeout: 10000 });
    await testInfo.attach('重載一致', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
});
