'use strict';
// Bounded DOM-only diagnosis of an already opened isolated QA lease.
const { chromium } = require('../../runtimes/worker/node_modules/playwright');
const fs = require('node:fs');
async function main() {
  const lease = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (!/^[0-9a-f-]{36}$/i.test(lease.sessionId)) throw Error();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19790');
  let page;
  try {
    const pages = browser.contexts().flatMap(c => c.pages());
    for (const candidate of pages) {
      if (candidate.url().startsWith('http://127.0.0.1:19787/') && await candidate.evaluate(() => window.name === 'm11-session-qa-t67')) {
        if (page) throw Error();
        page = candidate;
      }
    }
    if (!page) throw Error();
    console.log('WORKSPACE_COMBO=' + await page.getByRole('combobox', { name: 'Workspace' }).count());
    console.log('WORKSPACE_BUTTON=' + await page.getByRole('button', { name: 'Workspace 設定' }).count());
    console.log('SETTINGS_TAB=' + await page.getByRole('tab', { name: '正式設定與能力' }).count());
    const section = page.locator('.workspace-browser-sessions');
    console.log('SESSION_SECTION=' + await section.count());
    console.log('SESSION_ROW=' + await section.locator('li').filter({ hasText: lease.sessionId.slice(0, 8) }).count());
    console.log('SESSION_ERROR=' + await section.getByRole('alert').count());
    console.log('SESSION_EMPTY=' + await section.getByText('目前沒有可列出的瀏覽器 session。').count());
    console.log('SESSION_BUTTON=' + await section.locator('li').filter({ hasText: lease.sessionId.slice(0, 8) }).getByRole('button', { name: '開始監看' }).count());
    console.log('LIVE_PANEL=' + await page.locator('.live-panel').count());
    console.log('LIVE_STREAMING=' + await page.locator('[data-testid="live-status"]').filter({ hasText: '監看中：' }).count());
    console.log('LIVE_WAITING=' + await page.locator('[data-testid="live-status"]').filter({ hasText: '等待監看畫面' }).count());
    console.log('LIVE_ERROR=' + await page.locator('[data-testid="live-status"]').filter({ hasText: '監看連線失敗' }).count());
    console.log('LIVE_UNAVAILABLE=' + await page.locator('[data-testid="live-status"]').filter({ hasText: '目前無法監看' }).count());
  } finally { await browser.close(); }
}
main().catch(() => { console.log('DIAGNOSTIC=INCOMPLETE'); process.exitCode = 1; });
