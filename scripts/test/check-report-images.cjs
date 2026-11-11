#!/usr/bin/env node
// Playwright HTML 報告圖片檢查（黑箱）：只開參數提供的報告 URL。
// locator 由總指揮實際觀察提供：a[href^="#?testId="]，不另猜 data-testid。
// 無硬 wait；visible 後點擊；waitForFunction 等 PNG 數>=EXPECTED 且全部載入，逾時即失敗。
// 任何 image HTTP/requestfailed/CSP 或未載入 PNG 皆非零；錯誤用 throw，finally 照關 browser。
// 用法：node whippet-report-images.cjs "<報告URL>" [expectedCount]
'use strict';

const REPORT_URL = (process.argv[2] || process.env.WHIPPET_REPORT_URL || '').trim();
const EXPECTED = parseInt(process.argv[3] || process.env.WHIPPET_EXPECTED_IMAGES || '1', 10) || 1;
const TOTAL_MS = 120 * 1000;
const t0 = Date.now();

function fail(msg) {
  throw new Error(msg);
}

async function main() {
  if (!REPORT_URL) fail('缺少報告 URL（argv[1] 或 WHIPPET_REPORT_URL）');
  const pw = require('/opt/whippet/worker/node_modules/playwright');
  const { chromium } = pw;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const httpImgFailures = [];
    const failedRequests = [];
    const consoleErrors = [];
    const pageErrors = [];

    page.on('requestfailed', (req) => {
      if (req.resourceType() === 'image') failedRequests.push(`${req.url().slice(0, 300)} :: ${(req.failure() && req.failure().errorText) || ''}`.slice(0, 400));
    });
    page.on('response', (res) => {
      const req = res.request();
      if (req.resourceType() === 'image' && res.status() >= 400) {
        httpImgFailures.push(`HTTP ${res.status()} ${req.url().slice(0, 300)}`.slice(0, 400));
      }
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 400)));

    console.log(`report ${REPORT_URL} expected>=${EXPECTED}`);
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await page.title();
    console.log(`title ${title}`);

    const testLinks = page.locator('a[href^="#?testId="]');
    await testLinks.first().waitFor({ state: 'visible', timeout: 30000 });
    await testLinks.first().click();

    await page.waitForFunction(() => location.hash.includes('testId='), null, { timeout: 10000 });
    await page.waitForFunction((exp) => {
      const re = /\/data\/[^"'?#\s]+\.png(\?.*)?$/i;
      const pngs = Array.from(document.querySelectorAll('img')).filter(
        (el) => re.test(el.currentSrc || el.src || ''),
      );
      return pngs.length >= exp && pngs.every((el) => el.complete && (el.naturalWidth || 0) > 0);
    }, EXPECTED, { timeout: 30000 });

    const pngs = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
      .filter((el) => /\/data\/[^"'?#\s]+\.png(\?.*)?$/i.test(el.currentSrc || el.src || ''))
      .map((el) => ({
        src: (el.currentSrc || el.src || '').slice(0, 400),
        complete: !!el.complete,
        w: el.naturalWidth || 0,
        h: el.naturalHeight || 0,
      })));
    console.log(`png total=${pngs.length}`);
    pngs.forEach((m, i) => console.log(`  png[${i}] complete=${m.complete} ${m.w}x${m.h} src="...${m.src.slice(-120)}"`));

    const csp = [...consoleErrors, ...pageErrors].filter((m) => /csp|content security|blocked|cross-origin|allow-same-origin|sandbox/i.test(m));
    console.log(`--- summary ---`);
    console.log(`url=${REPORT_URL}`);
    console.log(`title=${title}`);
    console.log(`pngTotal=${pngs.length} expected>=${EXPECTED}`);
    console.log(`httpImgFailures=${httpImgFailures.length} requestFailed=${failedRequests.length} csp=${csp.length}`);
    httpImgFailures.slice(0, 10).forEach((m) => console.log(`  httpFail: ${m}`));
    failedRequests.slice(0, 10).forEach((m) => console.log(`  reqFail: ${m}`));
    csp.slice(0, 10).forEach((m) => console.log(`  csp: ${m.slice(0, 300)}`));

    if (pngs.length === 0) fail('PNG 為 0 張（全頁 0 張不可視為成功）。');
    const unloaded = pngs.filter((m) => !(m.complete && m.w > 0));
    if (unloaded.length > 0) fail(`有 ${unloaded.length} 張 PNG 未載入。`);
    if (pngs.length < EXPECTED) fail(`PNG ${pngs.length} < expected ${EXPECTED}`);
    if (httpImgFailures.length > 0) fail(`有 ${httpImgFailures.length} 個圖片 HTTP 失敗。`);
    if (failedRequests.length > 0) fail(`有 ${failedRequests.length} 個圖片 requestfailed。`);
    if (csp.length > 0) fail(`有 ${csp.length} 個 CSP/沙箱錯誤。`);
    if (Date.now() - t0 > TOTAL_MS) fail('總超時');
    console.log(`DONE pngLoaded=${pngs.length} expected=${EXPECTED}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`FAIL: ${(e && e.stack) || e}`);
  process.exit(/缺少報告|locator/.test((e && e.message) || '') ? 2 : 1);
});
