#!/usr/bin/env node
// M2 UI smoke（黑箱）：全程只用 UI，不手動打 API，不讀 key，不上傳，不外部聯網。
// 登入 → 選 workspace(若需) → 新增測試 → 填草稿 → 儲存 → 驗證 → 看報告 → 勾選確認 → 發佈 → 驗歷史 → reload 驗草稿保留。
// 不做正式執行（API smoke 涵蓋），不做其他 UI 覆蓋。總上限 3 分鐘。
'use strict';

const BASE = (process.env.WHIPPET_WEB_URL || 'http://web').replace(/\/$/, '');
const SHOT = '/private/tmp/whippet-m2-ui.png';
const TOTAL_MS = 3 * 60 * 1000;
const t0 = Date.now();

const UI_SCRIPT = `import {test,expect} from '@playwright/test';
test('synthetic',async({page})=>{await page.setContent('<h1>M2 UI</h1>');await expect(page.getByRole('heading')).toHaveText('M2 UI')});`;

function remainMs() { return t0 + TOTAL_MS - Date.now(); }
function checkDeadline(step) {
  if (Date.now() > t0 + TOTAL_MS) throw new Error(`總超時 3 分鐘（於 ${step}）`);
}

async function visibleText(page) {
  try { return (await page.evaluate(() => document.body ? document.body.innerText || '' : '')).trim(); }
  catch (e) { return `(讀取失敗: ${e.message})`; }
}

async function fail(page, errs, msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  try {
    const t = await visibleText(page);
    console.log(`--- 可見文字前 2000 字 ---\n${t.slice(0, 2000) || '(空)'}`);
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

  const testName = `m2-ui-${Date.now()}`;

  try {
    checkDeadline('開首頁');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    // 登入（唯一按鈕，否則停）
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await loginBtn.count() !== 1) await fail(page, errs, `登入按鈕非唯一 count=${await loginBtn.count()}`, 2);
    await loginBtn.first().click();
    await page.waitForTimeout(2000);

    // workspace 原生 select：單一直接不操作，多個才 selectOption 第一項（不用 option.click）
    try {
      const sel = page.locator('select').first();
      if (await sel.count() > 0 && await sel.isVisible()) {
        const values = await sel.evaluate((el) => Array.from(el.querySelectorAll('option')).map((o) => o.value));
        if (values.length <= 1) {
          console.log(`workspace 單一（${values.length}），不操作 select`);
        } else {
          console.log(`workspace selectOption 第一項 value=${String(values[0]).slice(0, 80)}`);
          await sel.selectOption(values[0], { timeout: 10000 });
          await page.waitForTimeout(1200);
        }
      } else {
        console.log('無 select，沿用預設 workspace');
      }
    } catch (e) { console.log(`workspace 選單跳過: ${e.message}`); }

    // 新增測試
    checkDeadline('新增測試');
    const addBtn = page.getByRole('button', { name: '新增測試', exact: true });
    if (await addBtn.count() !== 1) await fail(page, errs, `「新增測試」非唯一 count=${await addBtn.count()}`, 2);
    await addBtn.first().click();
    await page.waitForTimeout(1000);

    const nameField = page.getByLabel('測試名稱', { exact: false });
    if (await nameField.count() < 1) await fail(page, errs, '找不到 label「測試名稱」', 2);
    await nameField.first().fill(testName);
    const createBtn = page.getByRole('button', { name: '建立測試', exact: true });
    if (await createBtn.count() !== 1) await fail(page, errs, `「建立測試」非唯一 count=${await createBtn.count()}`, 2);
    await createBtn.first().click();
    await page.waitForTimeout(1500);
    console.log(`created test ${testName}`);

    // 填腳本
    checkDeadline('填腳本');
    const scriptField = page.getByLabel('Playwright TypeScript 腳本', { exact: false });
    if (await scriptField.count() < 1) await fail(page, errs, '找不到 label「Playwright TypeScript 腳本」', 2);
    await scriptField.first().fill(UI_SCRIPT);
    await page.waitForTimeout(500);

    // 儲存草稿 → 驗證此 revision（各一次，不重試）
    const saveBtn = page.getByRole('button', { name: '儲存草稿', exact: true });
    if (await saveBtn.count() !== 1) await fail(page, errs, `「儲存草稿」非唯一 count=${await saveBtn.count()}`, 2);
    await saveBtn.first().click();
    await page.waitForTimeout(1500);

    const validateBtn = page.getByRole('button', { name: '驗證此 revision', exact: true });
    if (await validateBtn.count() !== 1) await fail(page, errs, `「驗證此 revision」非唯一 count=${await validateBtn.count()}`, 2);
    await validateBtn.first().click();

    // 等「查看草稿驗證報告」link 出現
    checkDeadline('等驗證報告');
    const reportLink = page.getByRole('link', { name: /查看草稿驗證報告/ });
    try {
      await reportLink.first().waitFor({ state: 'visible', timeout: Math.max(1000, Math.min(120000, remainMs())) });
    } catch {
      await fail(page, errs, '「查看草稿驗證報告」未出現');
    }
    console.log('驗證報告連結出現，開啟確認可讀');

    // 開報告並確認可讀（popup 或同頁皆處理）
    let reportText = '';
    const popupP = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await reportLink.first().click();
    const popup = await popupP;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await popup.waitForTimeout(2000);
      reportText = await visibleText(popup);
      console.log(`報告(popup)前 500 字:\n${reportText.slice(0, 500) || '(空)'}`);
      if (reportText.trim().length < 10) { await popup.close().catch(() => {}); await fail(page, errs, '驗證報告 popup 空白'); }
      await popup.close().catch(() => {});
      await page.waitForTimeout(800);
    } else {
      await page.waitForTimeout(2500);
      reportText = await visibleText(page);
      console.log(`報告(同頁)前 500 字:\n${reportText.slice(0, 500) || '(空)'}`);
      if (reportText.trim().length < 10) await fail(page, errs, '驗證報告頁空白');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const relog = page.getByRole('button', { name: '以開發管理員登入', exact: true });
      if (await relog.count() === 1) {
        await relog.first().click();
        await page.waitForTimeout(2000);
        const back = page.getByRole('button', { name: testName, exact: false }).first();
        if (await back.count() > 0) { await back.click(); await page.waitForTimeout(1500); }
      }
    }

    // 發佈前先記錄歷史項數量與執行按鈕狀態（避免 body 泛判）
    const listItems = page.getByRole('listitem');
    const rows = page.getByRole('row');
    const histBefore = Math.max(await listItems.count().catch(() => 0), await rows.count().catch(() => 0));
    const runBtnBefore = page.getByRole('button', { name: '執行測試', exact: true });
    const runBeforeExists = await runBtnBefore.count();
    let runBeforeEnabled = false;
    if (runBeforeExists > 0) runBeforeEnabled = await runBtnBefore.first().isEnabled().catch(() => false);
    console.log(`發佈前 history項=${histBefore} 執行測試存在=${runBeforeExists} enabled=${runBeforeEnabled}`);

    // 勾選 + 確認發佈（各一次）
    checkDeadline('發佈');
    const cb = page.getByRole('checkbox', { name: /^我已檢視驗證報告，確認發佈 revision/ });
    if (await cb.count() !== 1) await fail(page, errs, `確認 checkbox 非唯一 count=${await cb.count()}`, 2);
    await cb.first().check();
    const pubBtn = page.getByRole('button', { name: /^確認發佈 revision/ });
    if (await pubBtn.count() !== 1) await fail(page, errs, `「確認發佈 revision」非唯一 count=${await pubBtn.count()}`, 2);
    await pubBtn.first().click();

    // 發佈確認：等待「歷史版本區出現實際版本項」或「成功訊息/執行測試 enabled」
    checkDeadline('確認發佈');
    {
      const end = Date.now() + Math.max(1000, Math.min(90000, remainMs()));
      let ok = '';
      const successMsg = page.getByText(/發佈成功|发布成功|已發佈|發佈完成|Publish.*success/i).first();
      while (Date.now() < end) {
        // A. 成功訊息可見
        try {
          if (await successMsg.count() > 0 && await successMsg.isVisible()) { ok = 'publish-success-msg'; break; }
        } catch {}
        // B. 執行測試 button 由 disabled/不存在變為 enabled
        try {
          const rb = page.getByRole('button', { name: '執行測試', exact: true });
          if (await rb.count() > 0 && await rb.first().isEnabled()) {
            if (!runBeforeEnabled) { ok = 'run-enabled'; break; }
          }
        } catch {}
        // C. 歷史版本區實際新增版本項（數量增加，而非 body 泛字）
        try {
          const nList = await page.getByRole('listitem').count().catch(() => 0);
          const nRow = await page.getByRole('row').count().catch(() => 0);
          if (Math.max(nList, nRow) > histBefore) { ok = `history-grew ${histBefore}->${Math.max(nList, nRow)}`; break; }
        } catch {}
        await page.waitForTimeout(1000);
      }
      if (!ok) await fail(page, errs, '發佈確認失敗：歷史無新增項且無成功訊息/執行測試 enabled');
      console.log(`發佈確認 ok=${ok}`);
    }

    // 重新載入並確認草稿保留：用 inputValue() 比對 UI_SCRIPT（textarea 值不在 innerText）
    checkDeadline('reload 驗草稿');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const relog2 = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await relog2.count() === 1) {
      await relog2.first().click();
      await page.waitForTimeout(2000);
      const back2 = page.getByRole('button', { name: testName, exact: false }).first();
      if (await back2.count() > 0) { await back2.click(); await page.waitForTimeout(1500); }
      else await fail(page, errs, `reload 後找不到剛建測試 ${testName}`, 2);
    }
    const scriptField2 = page.getByLabel('Playwright TypeScript 腳本', { exact: false });
    if (await scriptField2.count() < 1) await fail(page, errs, 'reload 後找不到 label「Playwright TypeScript 腳本」', 2);
    let v = '';
    try {
      v = await scriptField2.first().inputValue();
    } catch (e) {
      await fail(page, errs, `reload 後讀草稿 inputValue 失敗: ${e.message}`);
    }
    if (v !== UI_SCRIPT) await fail(page, errs, `reload 後草稿不符（inputValue 長度 ${v.length}，預期 ${UI_SCRIPT.length}）`);
    console.log('草稿保留確認（inputValue 一致）');

    try { await page.screenshot({ path: SHOT, fullPage: true }); } catch {}
    console.log(`DONE ui test=${testName} screenshot=${SHOT}`);
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
