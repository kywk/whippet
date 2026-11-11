INSERT INTO workspaces(id, name)
VALUES ('00000000-0000-4000-8000-000000000001', '預設 Workspace')
ON CONFLICT DO NOTHING;

INSERT INTO tests(id, workspace_id, name, description) VALUES
('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
 '固定頁面：成功範例', '使用 page.setContent 驗證本地 HTML，不需要外網。'),
('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
 '固定頁面：斷言失敗範例', '刻意斷言錯誤文字，供整合驗證 failed 狀態與報告。')
ON CONFLICT DO NOTHING;

INSERT INTO test_versions(id, test_id, version, script, timeout_ms) VALUES
('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 1,
$spec$import { test, expect } from '@playwright/test';

test('Whippet local smoke succeeds', async ({ page }) => {
  await page.setContent('<!doctype html><html><head><title>Whippet</title></head><body><h1>Whippet ready</h1><button>Run test</button></body></html>');
  await expect(page.getByRole('heading')).toHaveText('Whippet ready');
  await expect(page.getByRole('button', { name: 'Run test' })).toBeVisible();
});
$spec$, 60000),
('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1,
$spec$import { test, expect } from '@playwright/test';

test('Whippet deliberate assertion failure', async ({ page }) => {
  await page.setContent('<!doctype html><html><body><h1>Whippet ready</h1></body></html>');
  await expect(page.getByRole('heading')).toHaveText('Deliberately incorrect heading', { timeout: 1000 });
});
$spec$, 60000)
ON CONFLICT DO NOTHING;

UPDATE tests SET published_version_id = '20000000-0000-4000-8000-000000000001'
WHERE id = '10000000-0000-4000-8000-000000000001' AND published_version_id IS NULL;
UPDATE tests SET published_version_id = '20000000-0000-4000-8000-000000000002'
WHERE id = '10000000-0000-4000-8000-000000000002' AND published_version_id IS NULL;
