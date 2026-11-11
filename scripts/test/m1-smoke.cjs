#!/usr/bin/env node
// M1 黑箱：兩個範例各執行一次，全經 UI 點擊，不手動 POST，不用任何金鑰。
// 由總指揮在本機 Docker 內執行；本腳本只連目標站，不外部聯網、不外傳檔案/原始碼/憑證。
// 總 timeout 120s；任何失敗即停止，不重試建立任務。
'use strict';

const BASE = (process.env.WHIPPET_WEB_URL || 'http://web').replace(/\/$/, '');
const TOTAL_MS = 120000;
const deadline = Date.now() + TOTAL_MS;

const EXPECTED = [
  { prefix: '固定頁面：成功範例', expect: 'succeeded' },
  { prefix: '固定頁面：斷言失敗範例', expect: 'failed' },
];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

function remainMs() { return deadline - Date.now(); }
function assertDeadline(step) {
  if (Date.now() >= deadline) throw new Error(`總超時 120s（於 ${step}），停止。`);
}

async function visibleText(page) {
  try {
    return ((await page.evaluate(() => document.body ? document.body.innerText || '' : '')).trim());
  } catch (e) { return `(讀取失敗: ${e.message})`; }
}

async function dumpVisible(page, label, consoleErrors) {
  console.log(`=== ${label} === URL: ${page.url()}`);
  const t = await visibleText(page);
  console.log(`--- 可見文字 (前 2000 字) ---\n${t.slice(0, 2000) || '(空)'}`);
  if (consoleErrors && consoleErrors.length) {
    console.log(`--- console/pageerror (${consoleErrors.length}) ---`);
    consoleErrors.slice(-20).forEach((m) => console.log(`  ! ${m.slice(0, 500)}`));
  }
}

function failExit(msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  process.exit(code);
}

async function main() {
  let pw;
  try {
    pw = require('/opt/whippet/worker/node_modules/@playwright/test');
  } catch (e) {
    failExit(`找不到 Playwright 套件: /opt/whippet/worker/node_modules/@playwright/test (${e.message})`);
  }
  const { chromium } = pw;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e && e.message || e)}`));

  try {
    assertDeadline('開啟首頁');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
    await dumpVisible(page, '初始畫面');

    // 登入：唯一按鈕「以開發管理員登入」，否則停止
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    const nLogin = await loginBtn.count();
    if (nLogin !== 1) {
      await dumpVisible(page, '登入選擇不明', consoleErrors);
      failExit(`選擇不明：登入按鈕數量=${nLogin}，停止回報（exit 2）。`, 2);
    }
    await loginBtn.first().click();
    await page.waitForTimeout(2000);
    await dumpVisible(page, '登入後畫面', consoleErrors);

    for (const { prefix, expect } of EXPECTED) {
      assertDeadline(`開始 ${prefix}`);
      // 若不在列表（找不到測試按鈕），回首頁一次；仍找不到就停止
      let btn = page.getByRole('button', { name: new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
      let n = await btn.count();
      if (n !== 1) {
        console.log(`回到列表: ${BASE}`);
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        // 若被登出（登入按鈕重現），只點一次重登入
        const relog = page.getByRole('button', { name: '以開發管理員登入', exact: true });
        if (await relog.count() === 1) {
          console.log('偵測到登出狀態，重登入一次。');
          await relog.first().click();
          await page.waitForTimeout(2000);
        }
        await dumpVisible(page, `回到列表後 (${prefix})`, consoleErrors);
        btn = page.getByRole('button', { name: new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
        n = await btn.count();
      }
      if (n !== 1) {
        await dumpVisible(page, `測試選擇不明: ${prefix}`, consoleErrors);
        failExit(`選擇不明：測試按鈕「${prefix}」數量=${n}，停止，不猜測執行（exit 2）。`, 2);
      }
      console.log(`開啟測試詳情: ${prefix}`);
      await btn.first().click();
      await page.waitForTimeout(1500);
      await dumpVisible(page, `詳情 (${prefix})`, consoleErrors);

      // 詳情唯一「執行測試」，否則停止
      const runBtn = page.getByRole('button', { name: '執行測試', exact: true });
      const nRun = await runBtn.count();
      if (nRun !== 1) {
        await dumpVisible(page, `執行按鈕不明: ${prefix}`, consoleErrors);
        failExit(`選擇不明：詳情「執行測試」數量=${nRun}，停止（exit 2）。`, 2);
      }

      // 點擊前先監聽 POST /api/tests/.../runs 回應（只捕捉，不手動打 API）
      assertDeadline(`執行點擊 ${prefix}`);
      const respPromise = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/runs$/.test(new URL(r.url(), page.url()).pathname),
        { timeout: Math.max(1000, Math.min(20000, remainMs())) },
      ).catch(() => null);
      console.log(`點擊「執行測試」（一次，不重試）: ${prefix}`);
      await runBtn.first().click();
      const resp = await respPromise;
      if (!resp) {
        await dumpVisible(page, `未捕捉到建立任務回應: ${prefix}`, consoleErrors);
        failExit(`失敗：點擊後未捕捉到 POST /api/tests/.../runs 回應（${prefix}），停止，不重試。`);
      }
      let runJson = null;
      try { runJson = await resp.json(); } catch (e) {
        await dumpVisible(page, `建立任務回應非 JSON: ${prefix}`, consoleErrors);
        failExit(`失敗：POST runs 回應非 JSON（HTTP ${resp.status()}，${prefix}），停止。`);
      }
      console.log(`POST runs HTTP ${resp.status()} JSON: ${JSON.stringify(runJson).slice(0, 1000)}`);
      const runId = runJson && (runJson.id || (runJson.run && runJson.run.id));
      if (!runId) {
        await dumpVisible(page, `回應缺 runId: ${prefix}`, consoleErrors);
        failExit(`失敗：回應缺 runId（${prefix}），停止，不重試。`);
      }
      console.log(`runId=${runId}（${prefix}），開始輪詢 GET /api/runs/:id`);

      // 輪詢 GET /api/runs/:id 等終態（經頁面同源 fetch，不用金鑰）
      let run = null;
      while (true) {
        assertDeadline(`輪詢 ${prefix} runId=${runId}`);
        await page.waitForTimeout(2000);
        let fetched;
        try {
          fetched = await page.evaluate(async (id) => {
            const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
            const t = await r.text();
            return { http: r.status, body: t.slice(0, 2000) };
          }, runId);
        } catch (e) {
          console.log(`輪詢 fetch 異常，重試下輪: ${e.message}`);
          continue;
        }
        let j = null;
        try { j = JSON.parse(fetched.body); } catch { console.log(`輪詢 HTTP ${fetched.http} 非 JSON: ${fetched.body.slice(0, 300)}`); continue; }
        run = j.run || j;
        const st = run.status;
        console.log(`poll ${prefix} status=${st} http=${fetched.http}`);
        if (TERMINAL.has(st)) break;
      }
      console.log(`終態 ${prefix}: status=${run.status} reportUrl=${run.reportUrl || '(無)'}`);
      if (run.status !== expect) {
        await dumpVisible(page, `狀態不符: ${prefix} 預期=${expect} 實際=${run.status}`, consoleErrors);
        failExit(`失敗：${prefix} 預期=${expect}，實際=${run.status}（runId=${runId}），停止。`);
      }
      if (!run.reportUrl) {
        await dumpVisible(page, `缺 reportUrl: ${prefix}`, consoleErrors);
        failExit(`失敗：${prefix} 終態=${run.status} 但缺 reportUrl（runId=${runId}），停止。`);
      }
      const reportUrl = /^https?:\/\//i.test(run.reportUrl) ? run.reportUrl : new URL(run.reportUrl, page.url()).toString();
      console.log(`開啟報告: ${reportUrl}`);
      const repPage = await context.newPage();
      repPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[report console.error] ${m.text()}`); });
      repPage.on('pageerror', (e) => consoleErrors.push(`[report pageerror] ${String(e && e.message || e)}`));
      try {
        assertDeadline(`開啟報告 ${prefix}`);
        await repPage.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await repPage.waitForTimeout(1500);
        const title = await repPage.title().catch(() => '');
        const rtext = await visibleText(repPage);
        console.log(`報告 Title: ${title}`);
        console.log(`報告可見文字 (前 1500 字):\n${rtext.slice(0, 1500) || '(空)'}`);
        const t = rtext.trim();
        if (t.length < 20 || /^(404|500|not found|cannot get)/i.test(t.slice(0, 100))) {
          await dumpVisible(repPage, `報告疑似白頁/錯誤頁: ${prefix}`, consoleErrors);
          await repPage.close().catch(() => {});
          failExit(`失敗：${prefix} 報告疑似白頁/錯誤頁（runId=${runId}），停止。`);
        }
      } finally {
        await repPage.close().catch(() => {});
      }
      console.log(`PASS: ${prefix} 終態=${expect}，報告可見。`);

      // 回列表給下一個範例
      if (prefix !== EXPECTED[EXPECTED.length - 1].prefix) {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }
    }

    console.log('DONE: 兩範例各執行一次皆符合預期（succeeded / failed），報告皆可見。');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`FAIL: ${e && e.stack || e}`);
  process.exit(1);
});
