#!/usr/bin/env node
// M3 UI smoke（純黑箱）：全程 UI，不手動 API，不送模型請求，不儲存/不發佈。
// WHIPPET_TEST_NAME 必填（API smoke 建立的合成 test 名稱）；單 workspace 不操作 select。
// 總上限 120 秒，失敗非零，截圖僅本地 /private/tmp。
'use strict';

const BASE = (process.env.WHIPPET_WEB_URL || 'http://web').replace(/\/$/, '');
const TEST_NAME = process.env.WHIPPET_TEST_NAME || '';
const SHOT = '/private/tmp/whippet-m3-ui.png';
const TOTAL_MS = 120 * 1000;
const t0 = Date.now();

function remainMs() { return t0 + TOTAL_MS - Date.now(); }
function checkDeadline(step) {
  if (Date.now() > t0 + TOTAL_MS) throw new Error(`總超時 120 秒（於 ${step}）`);
}

async function visibleText(page) {
  try { return (await page.evaluate(() => document.body ? document.body.innerText || '' : '')).trim(); }
  catch (e) { return `(讀取失敗: ${e.message})`; }
}

async function fail(page, errs, msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  try {
    const t = await visibleText(page);
    console.log(`--- 可見文字摘要前 2000 字 ---\n${t.slice(0, 2000) || '(空)'}`);
  } catch {}
  if (errs && errs.length) {
    console.log(`--- pageerrors/console.error (${errs.length}) ---`);
    errs.slice(-20).forEach((m) => console.log(`  ! ${String(m).slice(0, 500)}`));
  }
  try { await page.screenshot({ path: SHOT, fullPage: true }); console.log(`screenshot ${SHOT}`); }
  catch (e) { console.log(`screenshot 失敗: ${e.message}`); }
  process.exit(code);
}

async function main() {
  if (!TEST_NAME) {
    console.error('FAIL 缺少 WHIPPET_TEST_NAME（API smoke 建立的合成 test 名稱）');
    process.exit(2);
  }
  const pw = require('/opt/whippet/worker/node_modules/@playwright/test');
  const { chromium } = pw;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => errs.push(`[pageerror] ${String((e && e.message) || e)}`));
  context.on('page', (p) => {
    p.on('pageerror', (e) => errs.push(`[pageerror] ${String((e && e.message) || e)}`));
  });

  try {
    checkDeadline('開首頁');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await loginBtn.count() !== 1) await fail(page, errs, `登入按鈕非唯一 count=${await loginBtn.count()}`, 2);
    await loginBtn.first().click();
    await page.waitForTimeout(2000);

    // 單 workspace：不操作 select，直接找 test
    checkDeadline('選測試');
    const esc = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const testBtn = page.getByRole('button', { name: new RegExp(esc) });
    if (await testBtn.count() < 1) await fail(page, errs, `找不到含 testName 的 button: ${TEST_NAME}`, 2);
    await testBtn.first().click();
    await page.waitForTimeout(1500);

    // 等待對話區
    checkDeadline('等對話區');
    const heading = page.getByRole('heading', { name: 'AI 測試對話' });
    try {
      await heading.first().waitFor({ state: 'visible', timeout: Math.max(1000, Math.min(60000, remainMs())) });
    } catch { await fail(page, errs, 'heading「AI 測試對話」未出現'); }
    const msgList = page.getByRole('list', { name: '已儲存的對話訊息' });
    try {
      await msgList.first().waitFor({ state: 'visible', timeout: Math.max(1000, Math.min(30000, remainMs())) });
    } catch { await fail(page, errs, 'list「已儲存的對話訊息」未出現'); }

    // 至少 4 則 li、至少 2 個「AI 助手」、alpha/beta 可見
    const items = msgList.first().getByRole('listitem');
    const n = await items.count();
    console.log(`對話 li 數=${n}`);
    if (n < 4) await fail(page, errs, `對話不足 4 則（實際 ${n}）`);
    const t0txt = await visibleText(page);
    const aiCount = (t0txt.match(/AI 助手/g) || []).length;
    console.log(`AI 助手出現次數=${aiCount}`);
    if (aiCount < 2) await fail(page, errs, `「AI 助手」不足 2（實際 ${aiCount}）`);
    if (!/alpha/i.test(t0txt) || !/beta/i.test(t0txt)) await fail(page, errs, '對話未同時可見 alpha/beta 合成需求與回覆');
    console.log('對話 alpha/beta 可見');

    // 展開最後一個「查看腳本前後對照」：以其最近 details ancestor 範圍查兩個 pre
    checkDeadline('展開對照');
    const summaryLoc = page.locator('summary', { hasText: '查看腳本前後對照' });
    const ns = await summaryLoc.count();
    if (ns < 1) await fail(page, errs, '找不到「查看腳本前後對照」');
    const lastSummary = summaryLoc.nth(ns - 1);
    await lastSummary.scrollIntoViewIfNeeded({ timeout: 10000 });
    await lastSummary.click();
    await page.waitForTimeout(1000);
    const scope = lastSummary.locator('xpath=ancestor::details[1]');
    const pres = scope.locator('pre');
    const np = await pres.count();
    if (np < 2) await fail(page, errs, `對照 details 內 pre 不足 2（實際 ${np}）`);
    const preTexts = [];
    for (let i = np - 2; i < np; i++) {
      const pre = pres.nth(i);
      await pre.waitFor({ state: 'visible', timeout: 10000 });
      preTexts.push((await pre.innerText()).trim());
    }
    console.log(`對照 details 內 pre 長度=${preTexts.map((s) => s.length).join('/')}`);
    if (preTexts.some((s) => s.length === 0)) await fail(page, errs, '對照 pre 有空白');
    const changed = preTexts[preTexts.length - 1];
    if (!/beta/i.test(changed)) await fail(page, errs, '變更後 pre 未含 beta');
    if (!/alpha/i.test(preTexts.join('\n'))) await fail(page, errs, '對照 pre 未含 alpha');
    const bodyAfter = await visibleText(page);
    if (/本分頁無法還原|未提供歷史稿/.test(bodyAfter)) await fail(page, errs, '出現還原失敗/無歷史稿提示');
    console.log('對照 pre 含 alpha/beta，無還原失敗提示');

    // 點開最後「查看續接驗證報告」連結檢查 report
    checkDeadline('驗證報告');
    const links = page.getByRole('link', { name: /查看續接驗證報告/ });
    const nl = await links.count();
    if (nl < 1) await fail(page, errs, '找不到「查看續接驗證報告」連結');
    const lastLink = links.nth(nl - 1);
    const popupP = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await lastLink.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
    await lastLink.click();
    const popup = await popupP;
    if (!popup) await fail(page, errs, '驗證報告未開 popup');
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await popup.waitForTimeout(2500);
    let repTxt = '';
    try { repTxt = (await popup.evaluate(() => document.body ? document.body.innerText || '' : '')).trim(); } catch {}
    const norm = repTxt.replace(/\s+/g, ' ');
    console.log(`報告前 500 字:\n${norm.slice(0, 500) || '(空)'}`);
    if (!/Passed/i.test(norm) || !/Failed\s*0/i.test(norm)) {
      await popup.close().catch(() => {});
      await fail(page, errs, '報告未含 Passed 及 Failed0');
    }
    await popup.close().catch(() => {});
    console.log('報告含 Passed 及 Failed0');
    await page.waitForTimeout(800);

    // 草稿欄讀原值→附加一行合成註解；需求欄填合成訊息；驗送出 disabled+先儲存提示；隨即還原
    checkDeadline('草稿驗證');
    const draftField = page.getByLabel('Playwright TypeScript 腳本', { exact: false });
    if (await draftField.count() < 1) await fail(page, errs, '找不到 label「Playwright TypeScript 腳本」', 2);
    let orig = '';
    try { orig = await draftField.first().inputValue(); }
    catch (e) { await fail(page, errs, `讀草稿 inputValue 失敗: ${e.message}`); }
    if (!orig) await fail(page, errs, '草稿原值空白');
    const msgField = page.getByLabel('測試需求或修改訊息', { exact: false });
    if (await msgField.count() < 1) await fail(page, errs, '找不到 label「測試需求或修改訊息」', 2);
    await draftField.first().fill(orig + '\n// m3-ui-smoke synthetic comment');
    await msgField.first().fill('m3 ui smoke synthetic message');
    await page.waitForTimeout(800);
    const sendBtn = page.getByRole('button', { name: '送出訊息' });
    if (await sendBtn.count() !== 1) {
      await draftField.first().fill(orig);
      await msgField.first().fill('');
      await fail(page, errs, `「送出訊息」非唯一 count=${await sendBtn.count()}`, 2);
    }
    const disabled = await sendBtn.first().isDisabled().catch(() => null);
    const hintTxt = await visibleText(page);
    if (disabled !== true || !/先儲存|請先儲存|儲存草稿/.test(hintTxt)) {
      await draftField.first().fill(orig);
      await msgField.first().fill('');
      await fail(page, errs, `送出未 disabled 或無先儲存提示（disabled=${disabled}）`);
    }
    console.log('送出 disabled 且有先儲存提示');
    // 還原，不送出/不儲存/不發模型請求
    await draftField.first().fill(orig);
    await msgField.first().fill('');
    await page.waitForTimeout(500);

    // reload→重登選同 test→檢查訊息數及草稿仍原值
    checkDeadline('reload 確認');
    const beforeCount = await page.getByRole('list', { name: '已儲存的對話訊息' }).first().getByRole('listitem').count().catch(() => -1);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const relog = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await relog.count() === 1) {
      await relog.first().click();
      await page.waitForTimeout(2000);
    }
    const testBtn2 = page.getByRole('button', { name: new RegExp(esc) });
    if (await testBtn2.count() < 1) await fail(page, errs, `reload 後找不到 test: ${TEST_NAME}`, 2);
    await testBtn2.first().click();
    await page.waitForTimeout(2000);
    const afterCount = await page.getByRole('list', { name: '已儲存的對話訊息' }).first().getByRole('listitem').count().catch(() => -1);
    console.log(`訊息數 reload 前=${beforeCount} 後=${afterCount}`);
    if (afterCount !== beforeCount) await fail(page, errs, `reload 後訊息數不一致（${beforeCount}→${afterCount}）`);
    const draftField2 = page.getByLabel('Playwright TypeScript 腳本', { exact: false });
    if (await draftField2.count() < 1) await fail(page, errs, 'reload 後找不到草稿欄', 2);
    const v2 = await draftField2.first().inputValue().catch(() => null);
    if (v2 !== orig) await fail(page, errs, 'reload 後草稿 inputValue 非原值');

    console.log(`DONE ui test=${TEST_NAME} messages=${afterCount}`);
  } catch (e) {
    if (e && /總超時/.test(e.message)) await fail(page, errs, e.message);
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch(async (e) => {
  console.error(`FAIL: ${(e && e.stack) || e}`);
  process.exit(1);
});
