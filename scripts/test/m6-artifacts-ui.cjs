#!/usr/bin/env node
// M6 失敗證據 artifacts 黑箱：需 WEB_URL＋M6_ISOLATED=1＋WHIPPET_RUN_ID＋WHIPPET_TEST_NAME，缺一拒跑。
// API：GET /api/runs/:id/artifacts 取 items，驗 data/<40小寫hex>.zip 及 .md 各至少一個；下載驗 200/attachment/nosniff/PK/UTF8/bytes=size/SHA1=檔名，存 evidence dir，不印原文。
// UI：登入→搜尋→選測→Run 精確容器展開「下載失敗證據」→點「下載 <hash>.zip/.md」download 事件驗 hash 一致；缺精確容器即報 PM，不猜。
// 只讀不寫：無新 run/模型/發佈/資料修改。不裝 Trace Viewer。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/playwright';
const WEB_URL = (process.env.WEB_URL || '').trim();
const RUN_ID = (process.env.WHIPPET_RUN_ID || '').trim();
const TEST_NAME = (process.env.WHIPPET_TEST_NAME || '').trim();
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/tmp';
const OVERALL_MS = 180 * 1000;
const t0 = Date.now();
const ART_RE = /^data\/([0-9a-f]{40})\.(zip|md)$/;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) throw new Error(`FAIL overall-timeout step=${step}`);
}

async function main() {
  if (!WEB_URL) throw new Error('FAIL 缺少明確 WEB_URL（拒跑）');
  if (process.env.M6_ISOLATED !== '1') throw new Error('FAIL 需 M6_ISOLATED=1 才允許執行（隔離部署）');
  if (!RUN_ID) throw new Error('FAIL 缺少 WHIPPET_RUN_ID（待 PM 提供 run，不猜）');
  if (!TEST_NAME) throw new Error('FAIL 缺少 WHIPPET_TEST_NAME（待 PM 提供，不猜）');

  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);

  let page = null;
  const pageErrors = [];
  const badResponses = [];
  let watchDownloads = false;

  const shot = async (name) => {
    const p = path.join(EV_DIR, name);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`shot ${p}`);
  };

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
    page.on('requestfailed', (req) => {
      if (watchDownloads) badResponses.push(`reqfail ${req.url().slice(0, 200)}`);
    });
    page.on('response', (res) => {
      if (!watchDownloads) return;
      const u = res.url();
      if (!u.startsWith(WEB_URL)) return;
      if (res.status() >= 400) badResponses.push(`HTTP ${res.status()} ${u.slice(0, 200)}`);
    });
    const api = page.request;

    // ---- API：列舉並驗證成品 ----
    checkOverall('api-list');
    const lr = await api.get(`${WEB_URL}/api/runs/${RUN_ID}/artifacts`);
    if (lr.status() !== 200) throw new Error(`FAIL artifacts http=${lr.status()}`);
    let lj = null;
    try { lj = await lr.json(); } catch { lj = null; }
    if (!lj || !Array.isArray(lj.items)) throw new Error('FAIL artifacts 形狀不符（要 {items:[{name,size,contentType,url}]}，不猜）');
    for (const [i, it] of lj.items.entries()) {
      if (!it || typeof it.name !== 'string' || typeof it.size !== 'number' || typeof it.contentType !== 'string' || typeof it.url !== 'string') {
        throw new Error(`FAIL artifacts items[${i}] 缺 name/size/contentType/url`);
      }
    }
    const zipItem = lj.items.find((it) => ART_RE.test(it.name) && it.name.endsWith('.zip'));
    const mdItem = lj.items.find((it) => ART_RE.test(it.name) && it.name.endsWith('.md'));
    if (!zipItem) throw new Error('FAIL 缺合法 data/<40hex>.zip');
    if (!mdItem) throw new Error('FAIL 缺合法 data/<40hex>.md');
    console.log(`PASS artifacts-list zip=${zipItem.name} size=${zipItem.size} md=${mdItem.name} size=${mdItem.size}`);

    const apiHashes = {};
    for (const it of [zipItem, mdItem]) {
      checkOverall(`api-dl ${it.name}`);
      const hex = it.name.match(ART_RE)[1];
      const url = it.url.startsWith('http') ? it.url : new URL(it.url, WEB_URL).toString();
      const dr = await api.get(url);
      if (dr.status() !== 200) throw new Error(`FAIL 下載 ${it.name} http=${dr.status()}`);
      const h = dr.headers();
      if (!String(h['content-disposition'] || '').toLowerCase().includes('attachment')) {
        throw new Error(`FAIL ${it.name} 缺 attachment`);
      }
      if (String(h['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
        throw new Error(`FAIL ${it.name} 缺 nosniff`);
      }
      const buf = await dr.body();
      if (buf.length !== it.size) throw new Error(`FAIL ${it.name} bytes=${buf.length} size=${it.size}`);
      if (sha1(buf) !== hex) throw new Error(`FAIL ${it.name} SHA1 非檔名`);
      const ct = String(h['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== String(it.contentType).split(';')[0].trim().toLowerCase()) {
        throw new Error(`FAIL ${it.name} Content-Type 與清單不一致`);
      }
      if (it.name.endsWith('.zip')) {
        const sig = buf.subarray(0, 4);
        const okZip = sig.length === 4 && sig[0] === 0x50 && sig[1] === 0x4b
          && ((sig[2] === 0x03 && sig[3] === 0x04) || (sig[2] === 0x05 && sig[3] === 0x06));
        if (!okZip) throw new Error(`FAIL ${it.name} 非 PK0304/PK0506`);
      } else {
        try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
          throw new Error(`FAIL ${it.name} 非 UTF8`);
        }
      }
      fs.writeFileSync(path.join(EV_DIR, path.basename(it.name)), buf);
      apiHashes[it.name] = hex;
      console.log(`PASS api-file ${it.name} bytes=${buf.length} sha1=檔名一致`);
    }

    // ---- UI：登入→搜尋→選測 ----
    checkOverall('login');
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    await page.getByRole('button', { name: 'Workspace 設定', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');

    checkOverall('select-test');
    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await search.waitFor({ state: 'visible', timeout: 30000 });
    await search.fill(TEST_NAME);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    await listRegion.waitFor({ state: 'visible', timeout: 30000 });
    const esc = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const testBtn = listRegion.getByRole('button', { name: new RegExp('^' + esc) });
    await testBtn.first().waitFor({ state: 'visible', timeout: 30000 });
    if (await testBtn.count() !== 1) throw new Error('FAIL 測試同名 button 非唯一');
    await testBtn.first().click();
    await page.getByRole('region', { name: '測試詳情' }).first().waitFor({ state: 'visible', timeout: 30000 });
    await shot('m6-test.png');
    console.log('PASS select-test');

    // ---- UI：Run 精確容器（執行紀錄 region 內 tbody tr，以 span[title=runId] 唯一定位） ----
    checkOverall('run-scope');
    let histRegion = page.getByRole('region', { name: /^執行紀錄 / });
    if (await histRegion.count() < 1) {
      histRegion = page.locator('section[aria-labelledby="history-title"]');
    }
    await histRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    const runRow = histRegion.first().locator('tbody tr').filter({ has: page.locator(`span[title="${RUN_ID}"]`) });
    await runRow.first().waitFor({ state: 'visible', timeout: 30000 });
    if (await runRow.count() !== 1) {
      throw new Error('FAIL 缺精確 run 容器（執行紀錄無此 Run ID 唯一列），請 PM 補 locator，不猜');
    }
    const expandBtn = runRow.getByRole('button', { name: '下載失敗證據', exact: true });
    await expandBtn.first().waitFor({ state: 'visible', timeout: 30000 });
    if (await expandBtn.count() !== 1) {
      throw new Error('FAIL 缺「下載失敗證據」展開鈕（run 列內），請 PM 補 locator，不猜');
    }
    const controlsId = await expandBtn.first().getAttribute('aria-controls');
    await expandBtn.first().click();
    const panel = runRow.getByRole('region', { name: `Run ${RUN_ID} 的失敗證據附件`, exact: true });
    await panel.first().waitFor({ state: 'visible', timeout: 30000 });
    if (await panel.count() !== 1) {
      throw new Error('FAIL 缺附件面板（run 列內），請 PM 補 locator，不猜');
    }
    if (controlsId) {
      const pid = await panel.first().getAttribute('id');
      if (pid !== controlsId) throw new Error('FAIL 附件面板 id 與 aria-controls 不符');
    }
    console.log('PASS expand');

    // ---- UI：hash 精確連結＋download 事件驗一致 ----
    watchDownloads = true;
    for (const it of [zipItem, mdItem]) {
      checkOverall(`ui-dl ${it.name}`);
      const base = path.basename(it.name);
      const link = panel.getByRole('link', { name: `下載 ${base}`, exact: true });
      await link.first().waitFor({ state: 'visible', timeout: 30000 });
      if (await link.count() !== 1) {
        throw new Error(`FAIL 缺連結「下載 ${base}」，請 PM 補 locator，不猜`);
      }
      const dlP = page.waitForEvent('download', { timeout: 30000 });
      await link.first().click();
      const dl = await dlP;
      const dlPath = await dl.path();
      if (!dlPath) throw new Error(`FAIL 下載無暫存檔 ${it.name}`);
      const buf = fs.readFileSync(dlPath);
      if (sha1(buf) !== apiHashes[it.name]) throw new Error(`FAIL 下載檔與 API hash 不一致 ${it.name}`);
      const stem = path.basename(it.name, path.extname(it.name));
      fs.writeFileSync(path.join(EV_DIR, `${stem}.ui${path.extname(it.name)}`), buf);
      console.log(`PASS ui-dl ${it.name} bytes=${buf.length} hash一致`);
    }
    watchDownloads = false;
    await shot('m6-evidence.png');

    if (pageErrors.length > 0) throw new Error(`FAIL pageerror x${pageErrors.length}: ${pageErrors[0]}`);
    const relevantBad = badResponses.filter((m) => !/favicon\.ico/.test(m));
    if (relevantBad.length > 0) throw new Error(`FAIL failed-HTTP: ${relevantBad[0]}`);
    console.log(`PASS no-pageerror-no-failed-http`);

    console.log('PASS all');
  } catch (e) {
    try {
      if (page) await page.screenshot({ path: path.join(EV_DIR, 'm6-fail.png'), fullPage: true });
    } catch {}
    console.error(`FAIL: ${(e && e.message) || e}`);
    process.exitCode = 1;
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`FAIL: ${(e && e.message) || e}`);
  process.exit(process.exitCode || 1);
});
