#!/usr/bin/env node
// M7 editing-session 首切片黑箱：一般↔編輯、續編不重建、取消保留、確認放棄真 discarded、重開新 session。
// 目標 URL 預設獨立 18085（拒絕舊 18080）；不碰模型/驗證完成/發布；不建正式 Run。API 僅用公開端點。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/playwright';
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1:18085').replace(/\/$/, '');
if (/18080/.test(WEB_URL)) throw new Error('拒跑：不可對舊 18080 驗收');
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m7-ui-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });
const OVERALL_MS = 240 * 1000;
const t0 = Date.now();

let _pwExpect = null;
function getExpect() {
  if (!_pwExpect) {
    _pwExpect = require(path.join(path.dirname(PW_MODULE), '@playwright', 'test')).expect;
  }
  return _pwExpect;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) throw new Error(`FAIL overall-timeout step=${step}`);
}

async function main() {
  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);

  let page = null;
  const result = { webUrl: WEB_URL, screenshots: [], consoleErrors: 0, pass: false };
  const consoleErrs = [];
  const pageErrs = [];
  const httpBad = [];
  const reqFail = [];
  const postPaths = [];
  try {
    const context = await browser.newContext();
    page = await context.newPage();
    const api = page.request;
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrs.push(String((e && e.message) || e).slice(0, 300)));
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (u.startsWith(WEB_URL) && !/favicon\.ico/.test(u)) reqFail.push(u.slice(0, 200));
    });
    page.on('response', (res) => {
      const u = res.url();
      if (u.startsWith(WEB_URL) && !/favicon\.ico/.test(u) && res.status() >= 400) {
        httpBad.push(`HTTP ${res.status()} ${u.slice(0, 200)}`);
      }
    });
    page.on('request', (r) => {
      if (r.method() === 'POST') postPaths.push(new URL(r.url(), page.url()).pathname);
    });
    const pwExpect = getExpect();
    const shot = async (n) => {
      const p = path.join(EV_DIR, n);
      await page.screenshot({ path: p, fullPage: true });
      result.screenshots.push(n);
      console.log(`shot ${p}`);
    };
    const jget = async (p, label) => {
      checkOverall(label);
      const r = await api.get(WEB_URL + p);
      if (r.status() !== 200) throw new Error(`FAIL ${label} http=${r.status()}`);
      try {
        return await r.json();
      } catch {
        throw new Error(`FAIL ${label} 非 JSON`);
      }
    };
    const sessionOf = (j) => {
      const s = j && (j.session !== undefined ? j.session : j);
      return s && s.id ? s : null;
    };

    // 0. 工作區與測試基線
    checkOverall('workspaces');
    const wj = await jget('/api/workspaces', 'workspaces');
    if (!Array.isArray(wj.items) || wj.items.length < 1 || !wj.items[0].id) {
      throw new Error('FAIL workspaces 形狀不符（要 {items:[{id}]}）');
    }
    const wsId = wj.items[0].id;
    result.workspaceId = wsId;
    console.log(`PASS workspaces items=${wj.items.length}`);

    // 1. 登入
    checkOverall('login');
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    if ((await loginBtn.count()) !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    await page.getByRole('button', { name: '新增測試', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');
    await shot('m7-01-login.png');

    // 2. 新增測試（空種子 DB，每次新 Test 保證乾淨起點）
    checkOverall('create-test');
    const createP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/workspaces\/.+\/tests$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    const addBtn = page.getByRole('button', { name: '新增測試', exact: true });
    if ((await addBtn.count()) !== 1) throw new Error('FAIL 新增測試非唯一');
    await addBtn.click();
    const createResp = await createP;
    if (createResp.status() !== 201) throw new Error(`FAIL 建測試 http=${createResp.status()}`);
    const cj = await createResp.json();
    const testId = (cj.test && cj.test.id) || cj.id;
    if (!testId) throw new Error('FAIL 建測試回應缺 id');
    result.testId = testId;
    console.log(`PASS create-test id=${testId}`);

    const generalRegion = () => page.getByRole('region', { name: '測試一般模式' });
    const editingRegion = () => page.getByRole('region', { name: '測試編輯模式' });
    const modeNow = async () => {
      const g = (await generalRegion().count()) > 0 && await generalRegion().first().isVisible().catch(() => false);
      const e = (await editingRegion().count()) > 0 && await editingRegion().first().isVisible().catch(() => false);
      return { g, e };
    };
    await generalRegion().or(editingRegion()).first().waitFor({ state: 'visible', timeout: 30000 });
    let m0 = await modeNow();
    console.log(`after-create mode general=${m0.g} editing=${m0.e}`);

    // 3. 到一般模式；若建立已自動開 session 則記錄調適
    let adaptedAutoStart = false;
    if (!m0.g) {
      const backBtn = page.getByRole('button', { name: '返回一般模式', exact: true });
      if ((await backBtn.count()) !== 1) throw new Error('FAIL 返回一般模式非唯一');
      await backBtn.click();
      await generalRegion().first().waitFor({ state: 'visible', timeout: 30000 });
    }
    let cur = sessionOf(await jget(`/api/tests/${testId}/editing-session`, 'get-session-0'));
    if (cur) {
      adaptedAutoStart = true;
      console.log(`NOTE 建立已自動開 session（調適續行） id=${cur.id}`);
    }
    result.adaptedAutoStart = adaptedAutoStart;

    // 4. 一般模式驗證：唯讀腳本／正式歷史／版本說明缺值；GET 不建 session
    checkOverall('verify-general');
    await pwExpect(generalRegion().first()).toBeVisible({ timeout: 30000 });
    const roNames = ['正式版本腳本（唯讀）', '歷史版本腳本（唯讀）'];
    let roFound = 0;
    for (const nm of roNames) {
      const box = page.getByLabel(nm, { exact: true });
      if ((await box.count()) > 0) {
        if (await box.first().isEditable()) throw new Error(`FAIL ${nm} 可編輯`);
        roFound++;
      }
    }
    if (roFound < 1) throw new Error('FAIL 無唯讀腳本（兩種唯讀 textbox 皆缺）');
    console.log(`PASS readonly-script found=${roFound}`);
    const histRegion = page.getByRole('region', { name: /^正式執行歷史/ });
    await histRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    if ((await histRegion.count()) !== 1) throw new Error('FAIL 正式執行歷史非唯一');
    const vHead = page.getByRole('heading', { name: '版本說明' });
    await vHead.first().waitFor({ state: 'visible', timeout: 30000 });
    if ((await vHead.count()) !== 1) throw new Error('FAIL 版本說明 heading 非唯一');
    await pwExpect(page.getByText(/尚無版本說明/).first()).toBeVisible({ timeout: 30000 });
    console.log('PASS version-desc-missing-marker');
    const g1 = sessionOf(await jget(`/api/tests/${testId}/editing-session`, 'get-session-general-1'));
    const t1 = await jget(`/api/tests/${testId}`, 'get-test-general-1');
    const a1 = t1.activeEditingSession !== undefined ? t1.activeEditingSession : null;
    if (!adaptedAutoStart) {
      if (g1 || (a1 && a1.id)) throw new Error('FAIL 一般模式 GET 建立了 session');
      console.log('PASS general-get-no-session');
    } else if (!g1 || g1.id !== cur.id) {
      throw new Error('FAIL 模式切換遺失 session');
    }
    await shot('m7-02-general.png');

    // 5. 修改腳本明確 start（201）；未知 pointer 才用開啟編輯工作區
    checkOverall('start');
    let s1 = adaptedAutoStart ? cur.id : null;
    let startBtnName = null;
    if (!adaptedAutoStart) {
      const b1 = page.getByRole('button', { name: '修改腳本', exact: true });
      const b2 = page.getByRole('button', { name: '開啟編輯工作區', exact: true });
      let sb = null;
      if ((await b1.count()) === 1) {
        sb = b1.first();
        startBtnName = '修改腳本';
      } else if ((await b2.count()) === 1) {
        sb = b2.first();
        startBtnName = '開啟編輯工作區';
      } else {
        throw new Error('FAIL 無 start 按鈕（修改腳本／開啟編輯工作區皆缺）');
      }
      const startP = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
        { timeout: 30000 },
      );
      await sb.click();
      const startResp = await startP;
      if (startResp.status() !== 201) throw new Error(`FAIL start http=${startResp.status()} expected=201`);
      const sj = await startResp.json();
      s1 = (sj.session && sj.session.id) || sj.id;
      if (!s1) throw new Error('FAIL start 回應缺 session id');
      result.startButton = startBtnName;
      console.log(`PASS start 201 via=${startBtnName} session=${s1}`);
    } else {
      result.startButton = 'auto-on-create';
      console.log(`PASS start adapted session=${s1}`);
    }
    await pwExpect(editingRegion().first()).toBeVisible({ timeout: 30000 });
    await pwExpect(page.getByRole('region', { name: '對話編輯工作區' }).first()).toBeVisible({ timeout: 30000 });
    await shot('m7-03-editing.png');

    // 6. 返回一般（保留本機編輯），session 不變
    checkOverall('back-general');
    const backBtn2 = page.getByRole('button', { name: '返回一般模式', exact: true });
    if ((await backBtn2.count()) !== 1) throw new Error('FAIL 返回一般模式非唯一');
    await backBtn2.click();
    await pwExpect(generalRegion().first()).toBeVisible({ timeout: 30000 });
    const g2 = sessionOf(await jget(`/api/tests/${testId}/editing-session`, 'get-session-general-2'));
    if (!g2 || g2.id !== s1) throw new Error('FAIL 模式切換改變 session');
    console.log('PASS back-general session-unchanged');
    // 草稿列應已出現（後續移除驗證用先決條件）
    const verHist = page.getByRole('region', { name: /^歷史版本/ });
    await verHist.first().waitFor({ state: 'visible', timeout: 30000 });
    const verText0 = await verHist.first().innerText();
    if (!/草稿/.test(verText0)) throw new Error('FAIL 版本列表無草稿列，無法驗證後續移除');
    await shot('m7-04-back-general.png');

    // 7. 續編 resume（200 同一 session，不重建）
    checkOverall('resume');
    const resumeBtn = page.getByRole('button', { name: '繼續修改', exact: true });
    if ((await resumeBtn.count()) !== 1) throw new Error('FAIL 繼續修改非唯一');
    const resumeP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    await resumeBtn.click();
    const resumeResp = await resumeP;
    if (resumeResp.status() !== 200) throw new Error(`FAIL resume http=${resumeResp.status()} expected=200`);
    const rj = await resumeResp.json();
    const sid = (rj.session && rj.session.id) || rj.id;
    if (sid !== s1) throw new Error(`FAIL resume 重建 session（${sid} != ${s1}）`);
    result.resumedSameId = true;
    await pwExpect(editingRegion().first()).toBeVisible({ timeout: 30000 });
    console.log('PASS resume same-session');
    await shot('m7-05-resumed.png');

    // 8. 刪除入口定位（先 scope 可見模式）
    const findDeleteBtn = async () => {
      const scopes = [
        ['editing', editingRegion()],
        ['general', generalRegion()],
        ['history', page.getByRole('region', { name: /^歷史版本/ })],
      ];
      for (const [nm, sc] of scopes) {
        if ((await sc.count()) < 1) continue;
        try {
          await sc.first().waitFor({ state: 'visible', timeout: 5000 });
        } catch {
          continue;
        }
        const b = sc.first().getByRole('button', { name: '刪除草稿', exact: true });
        if ((await b.count()) === 1) return { btn: b.first(), scope: nm };
      }
      const g = page.getByRole('button', { name: '刪除草稿', exact: true });
      if ((await g.count()) === 1) return { btn: g.first(), scope: 'page' };
      throw new Error('FAIL 找不到唯一 刪除草稿');
    };
    const openDiscardDialog = async () => {
      const { btn, scope } = await findDeleteBtn();
      console.log(`delete scope=${scope}`);
      await btn.click();
      const dlg = page.getByRole('dialog', { name: '確認放棄本次修改？', exact: true });
      await dlg.first().waitFor({ state: 'visible', timeout: 30000 });
      if ((await dlg.count()) !== 1) throw new Error('FAIL 放棄 dialog 非唯一');
      return dlg.first();
    };

    // 9. 先取消確認一次，證明保留
    checkOverall('cancel-retain');
    {
      const dlg = await openDiscardDialog();
      await shot('m7-06-discard-dialog.png');
      const keepBtn = dlg.getByRole('button', { name: '保留草稿', exact: true });
      if ((await keepBtn.count()) !== 1) throw new Error('FAIL 保留草稿非唯一');
      await keepBtn.click();
      await pwExpect(dlg).toBeHidden({ timeout: 30000 });
      const gk = sessionOf(await jget(`/api/tests/${testId}/editing-session`, 'get-session-after-cancel'));
      if (!gk || gk.id !== s1 || gk.status !== 'active') throw new Error('FAIL 取消後 session 非 active 原 id');
      await pwExpect(editingRegion().first()).toBeVisible({ timeout: 30000 });
      result.retainedAfterCancel = true;
      console.log('PASS cancel-retain');
      await shot('m7-07-retained.png');
    }

    // 10. 確認放棄，等待真 discarded＋草稿列移除
    checkOverall('discard-confirm');
    let discardHttp = 0;
    {
      const dlg = await openDiscardDialog();
      const cBtn = dlg.getByRole('button', { name: '確認放棄草稿', exact: true });
      if ((await cBtn.count()) !== 1) throw new Error('FAIL 確認放棄草稿非唯一');
      const discP = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url(), page.url()).pathname.endsWith(`/editing-sessions/${s1}/discard`),
        { timeout: 30000 },
      );
      await cBtn.click();
      const discResp = await discP;
      discardHttp = discResp.status();
      if (discardHttp !== 200 && discardHttp !== 202) throw new Error(`FAIL discard http=${discardHttp}`);
      await pwExpect(dlg).toBeHidden({ timeout: 30000 });
      result.discardHttp = discardHttp;
      const tStart = Date.now();
      for (;;) {
        if (Date.now() - tStart > 60000) throw new Error('FAIL discard 60s 未完成');
        await sleep(2000);
        const g = await api.get(`${WEB_URL}/api/tests/${testId}/editing-sessions/${s1}`);
        if (g.status() === 404) throw new Error('FAIL 已結束週期查不到（應 200 discarded）');
        if (g.status() !== 200) throw new Error(`FAIL discard 查詢 http=${g.status()}`);
        const gj = await g.json();
        const st = (gj.session || gj).status;
        console.log(`discard poll status=${st}`);
        if (st === 'discarded') break;
        if (st !== 'discarding' && st !== 'active') throw new Error(`FAIL 非預期週期狀態 ${st}`);
      }
      const gl = sessionOf(await jget(`/api/tests/${testId}/editing-session`, 'get-session-after-discard'));
      if (gl) throw new Error('FAIL 放棄後仍有 active session');
      await pwExpect(verHist.first()).not.toContainText('草稿', { timeout: 60000 });
      result.discardedApi = true;
      result.draftRowRemoved = true;
      console.log('PASS discard discarded+草稿列移除');
      await shot('m7-08-discarded.png');
    }

    // 11. 重新開始新 session（新 id）
    checkOverall('restart');
    {
      const gVis = (await generalRegion().count()) > 0
        && await generalRegion().first().isVisible().catch(() => false);
      if (!gVis) {
        const bb = page.getByRole('button', { name: '返回一般模式', exact: true });
        if ((await bb.count()) !== 1) throw new Error('FAIL 放棄後無一般模式可回');
        await bb.click();
        await pwExpect(generalRegion().first()).toBeVisible({ timeout: 30000 });
        console.log('NOTE discard 後經返回一般模式');
      }
      const b1 = page.getByRole('button', { name: '修改腳本', exact: true });
      const b2 = page.getByRole('button', { name: '開啟編輯工作區', exact: true });
      let sb = null;
      if ((await b1.count()) === 1) sb = b1.first();
      else if ((await b2.count()) === 1) sb = b2.first();
      else throw new Error('FAIL 重開無 start 按鈕');
      const rp = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
        { timeout: 30000 },
      );
      await sb.click();
      const rr = await rp;
      if (rr.status() !== 201) throw new Error(`FAIL restart http=${rr.status()} expected=201`);
      const rjj = await rr.json();
      const s2 = (rjj.session && rjj.session.id) || rjj.id;
      if (!s2) throw new Error('FAIL restart 回應缺 session id');
      if (s2 === s1) throw new Error('FAIL restart 沿用舊 session');
      result.session2New = s2;
      await pwExpect(editingRegion().first()).toBeVisible({ timeout: 30000 });
      console.log(`PASS restart new-session ${s2}`);
      await shot('m7-09-newsession.png');
    }

    // 12. 收尾斷言：無模型／驗證／發布／正式 Run；錯誤彙總
    const badPosts = postPaths.filter((p) => /validate|publish|summary|messages|runs/.test(p));
    if (badPosts.length > 0) throw new Error(`FAIL 出現非預期 POST: ${badPosts.join(',')}`);
    if (pageErrs.length > 0) throw new Error(`FAIL pageerror x${pageErrs.length}: ${pageErrs[0]}`);
    const badHttp = [...httpBad, ...reqFail];
    if (badHttp.length > 0) throw new Error(`FAIL HTTP: ${badHttp[0]}`);
    result.consoleErrors = consoleErrs.length;
    result.session1 = s1;
    result.pass = true;
    fs.writeFileSync(path.join(EV_DIR, 'm7-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`DONE test=${testId} s1=${s1} s2=${result.session2New} consoleErr=${consoleErrs.length}`);
  } catch (e) {
    try {
      if (page) await page.screenshot({ path: path.join(EV_DIR, 'm7-fail.png'), fullPage: true });
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
