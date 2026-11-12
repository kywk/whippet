#!/usr/bin/env node
// M8 真UI審閱摘要→確認發布→一般頁正式版本與報告可見（黑箱，唯一任務 parent=t3v）。
// 固定對象：Workspace 95296031-b243-4bb6-b964-e90dd8af4bb5，Test cea8a396-da05-4517-b877-47add4733cfb（M8 real AI login acceptance），editingSession 1a790e12-7403-46b6-8399-e68e99c02e2c。
// 真AI探索/產稿rev2/validation acc336e4已PASS；摘要5c56a12e執行中，本腳本只等公開GET summary.validForCurrentDraft=true，不排新Run、不重跑舊PASS。
// 流程：公開GET核對摘要→真UI續編→審閱→勾選＋確認發布（listener先掛再點）→確認publish回應＋session published→一般頁正式版本與報告可見。不以API POST publish代替UI。
// 定位參照 m8-workspace-ui.cjs（登入/Workspace/Test）與 m8-login-live-ui.cjs；不讀產品源碼/DB/journal/機密或deploy/.env.ai。
// 用法（PM容器跑）：WEB_URL=http://127.0.0.1 WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m8-real-publish-evidence node scripts/test/m8-real-publish-ui.cjs
// 限制：禁PUT/PATCH/DELETE；禁POST summary/validate/runs/messages；唯一允許POST是真UI點擊觸發的publish；不改既有腳本；不安裝/部署/Git。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1').replace(/\/$/, '');
for (const bad of ['18080', '18085', '18086']) if (WEB_URL.includes(bad)) throw new Error(`拒跑舊環境 ${bad}`);
const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/@playwright/test';
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-real-publish-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });
const WS_ID = process.env.WHIPPET_WORKSPACE_ID || '95296031-b243-4bb6-b964-e90dd8af4bb5';
const TEST_ID = process.env.WHIPPET_TEST_ID || 'cea8a396-da05-4517-b877-47add4733cfb';
const TEST_NAME = process.env.WHIPPET_TEST_NAME || 'M8 real AI login acceptance';
const SESS_ID = process.env.WHIPPET_SESSION_ID || '1a790e12-7403-46b6-8399-e68e99c02e2c';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let page = null;
  const mut = [];
  const badHttp = [];
  try {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    const api = page.request;
    page.on('request', (r) => {
      try {
        const u = new URL(r.url(), page.url());
        if (!r.url().startsWith(WEB_URL)) return;
        if (['PUT', 'PATCH', 'DELETE'].includes(r.method())) mut.push(`${r.method()} ${u.pathname}`);
        else if (r.method() === 'POST') mut.push(`POST ${u.pathname}`);
      } catch {}
    });
    page.on('response', (res) => {
      try { if (res.url().startsWith(WEB_URL) && res.status() >= 400) badHttp.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`); } catch {}
    });
    const jget = async (p, label) => {
      const r = await api.get(WEB_URL + p);
      if (r.status() !== 200) throw new Error(`FAIL ${label} http=${r.status()}`);
      try { return await r.json(); } catch { throw new Error(`FAIL ${label} 非JSON`); }
    };
    const shot = async (n) => { try { await page.screenshot({ path: path.join(EV_DIR, n), fullPage: true }); console.log(`shot ${n}`); } catch {} };
    // 1. 登入＋選Workspace＋選Test（參照 m8-workspace-ui）。
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await loginBtn.count() !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    const wsCombo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await wsCombo.waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');
    if (await wsCombo.evaluate((el) => el.tagName) === 'SELECT') {
      const opts = await wsCombo.evaluate((el) => Array.from(el.options).map((o) => ({ v: o.value, t: o.text.trim() })));
      const hit = opts.find((o) => o.v === WS_ID);
      if (!hit) throw new Error('FAIL Workspace選項無此id');
      await wsCombo.selectOption(hit.v);
    } else {
      await wsCombo.click(); await sleep(800);
      const meta = await jget('/api/workspaces', 'workspaces');
      const wn = (meta.items || []).find((w) => w.id === WS_ID);
      if (!wn) throw new Error('FAIL Workspace id不存在');
      const opt = page.getByRole('option', { name: wn.name, exact: true });
      if (await opt.count() !== 1) throw new Error('FAIL Workspace選項非唯一');
      await opt.first().click();
    }
    console.log('PASS workspace');
    const search = page.getByRole('searchbox').first();
    if (await search.count() > 0) { await search.fill(TEST_NAME); await sleep(1000); }
    const tBtn = page.getByRole('button', { name: new RegExp('^' + TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    if (await tBtn.count() !== 1) throw new Error('FAIL Test按鈕非唯一');
    await tBtn.first().click();
    await page.getByRole('region', { name: '測試詳情' }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS select-test');
    // 2. 公開GET確認摘要 validForCurrentDraft（等真摘要，不排新Run）。
    let sess = null;
    const t0 = Date.now();
    for (;;) {
      const g = await jget(`/api/tests/${TEST_ID}/editing-session`, 'editing-session');
      sess = (g && g.session) || null;
      if (sess && sess.id === SESS_ID && sess.summary && sess.summary.validForCurrentDraft === true) break;
      if (Date.now() - t0 > 600 * 1000) throw new Error(`FAIL 摘要未就緒 status=${sess && sess.status} summary=${JSON.stringify(sess && sess.summary).slice(0, 200)}`);
      await sleep(5000);
    }
    if (!sess.description && !(sess.summary && sess.summary.description)) console.log('NOTE summary描述由卡片確認');
    console.log(`PASS summary valid rev=${sess.summary.revision} run=${sess.summary.runId || sess.summary.validationRunId || ''}`);
    // 3. 真UI續編進編輯模式（沿用同一session，不重建）。
    const editBtn = page.getByRole('button', { name: /^(繼續修改|開啟編輯工作區|修改腳本)$/ }).first();
    if (await editBtn.count() > 0 && await editBtn.isVisible().catch(() => false)) {
      const rp = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname), { timeout: 30000 }).catch(() => null);
      await editBtn.click();
      const rr = await rp;
      if (rr) {
        if (rr.status() !== 200 && rr.status() !== 201) throw new Error(`FAIL 續編 http=${rr.status()}`);
        const rj = await rr.json().catch(() => null);
        const sid = (rj && rj.session && rj.session.id) || (rj && rj.id);
        if (sid !== SESS_ID) throw new Error('FAIL 續編重建session');
        console.log('PASS resume same-session');
      }
    }
    const editing = page.getByRole('region', { name: '測試編輯模式' });
    await editing.first().waitFor({ state: 'visible', timeout: 30000 });
    await shot('m8-real-01-editing.png');
    // 4. 真UI審閱＋確認發布（listener先掛再點，不以API代替）。
    const cb = editing.getByRole('checkbox', { name: /^我已檢視驗證報告與驗收摘要，確認發[佈布]/ });
    if (await cb.count() !== 1) throw new Error('FAIL 發布checkbox缺/非唯一');
    const pubBtn = editing.getByRole('button', { name: /^確認發[佈布] revision/ });
    if (await pubBtn.count() !== 1) throw new Error('FAIL 確認發布按鈕缺/非唯一');
    if (!(await cb.first().isChecked().catch(() => false))) await cb.first().check();
    const pubP = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url(), page.url()).pathname === `/api/tests/${TEST_ID}/publish`, { timeout: 60000 });
    await pubBtn.first().click();
    const pubResp = await pubP;
    if (pubResp.status() !== 200 && pubResp.status() !== 201) throw new Error(`FAIL publish http=${pubResp.status()}`);
    const pj = await pubResp.json().catch(() => null);
    const verId = (pj && ((pj.version && pj.version.id) || pj.id || pj.publishedVersionId)) || null;
    console.log(`PASS publish http=${pubResp.status()} ver=${verId || ''}`);
    await shot('m8-real-02-published.png');
    // 5. 確認session published＋正式指標。
    let closed = null;
    for (let i = 0; i < 30; i++) {
      const g = await api.get(`${WEB_URL}/api/tests/${TEST_ID}/editing-sessions/${SESS_ID}`);
      if (g.status() === 200) { const gj = await g.json().catch(() => null); closed = (gj && gj.session) || null; if (closed && closed.status === 'published') break; }
      await sleep(2000);
    }
    if (!closed || closed.status !== 'published') throw new Error('FAIL session非published');
    const tj = await jget(`/api/tests/${TEST_ID}`, 'test-published');
    const tBody = (tj && tj.test) || tj;
    if (!tBody.publishedVersionId) throw new Error('FAIL Test無publishedVersionId');
    console.log(`PASS session published ver=${tBody.publishedVersionId}`);
    // 6. 一般頁正式版本與報告可見（不排新Run）。
    const backBtn = page.getByRole('button', { name: '返回一般模式', exact: true });
    if (await backBtn.count() === 1) { await backBtn.first().click(); }
    const general = page.getByRole('region', { name: '測試一般模式' });
    await general.first().waitFor({ state: 'visible', timeout: 30000 });
    const ro = page.getByLabel('正式版本腳本（唯讀）', { exact: true }).first();
    await ro.waitFor({ state: 'visible', timeout: 30000 });
    if (await ro.isEditable().catch(() => true)) throw new Error('FAIL 正式腳本可編輯');
    const roText = await ro.inputValue().catch(() => '');
    if (roText.trim().length < 10) throw new Error('FAIL 正式腳本為空');
    const verHist = page.getByRole('region', { name: /^歷史版本/ });
    await verHist.first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS general 正式版本可見');
    const repLink = general.getByRole('link', { name: /（新分頁）/ });
    if (await repLink.count() > 0) {
      const popupP = page.waitForEvent('popup', { timeout: 30000 });
      await repLink.first().click();
      const popup = await popupP;
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
      await popup.getByText(/Passed/i).first().waitFor({ state: 'visible', timeout: 60000 });
      console.log('PASS report 可見');
      await popup.close().catch(() => {});
    } else {
      console.log('NOTE 無正式執行報告連結，僅正式版本可見（不排新Run）');
    }
    await shot('m8-real-03-general.png');
    // 收尾：禁違規POST。
    const bad = mut.filter((m) => {
      if (/^(PUT|PATCH|DELETE) /.test(m)) return true;
      if (!m.startsWith('POST ')) return false;
      const p = m.slice(5);
      if (p === `/api/tests/${TEST_ID}/publish`) return false;
      if (/\/editing-session$/.test(p)) return false;
      return /publish|summary|validate/.test(p) || /\/runs$/.test(p) || /\/messages/.test(p);
    });
    if (bad.length > 0) throw new Error(`FAIL 違規請求 ${bad[0]}`);
    if (badHttp.length > 0) throw new Error(`FAIL HTTP ${badHttp[0]}`);
    fs.writeFileSync(path.join(EV_DIR, 'm8-real-publish-result.json'), JSON.stringify({ pass: true, session: SESS_ID, publishedVersionId: tBody.publishedVersionId, versionId: verId }, null, 2) + '\n');
    console.log('DONE publish-ui PASS');
  } catch (e) {
    try { if (page) await page.screenshot({ path: path.join(EV_DIR, 'm8-real-publish-fail.png'), fullPage: true }); } catch {}
    console.error(`FAIL: ${(e && e.message) || e}`);
    process.exitCode = 1;
    throw e;
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(`FAIL: ${(e && e.message) || e}`); process.exit(process.exitCode || 1); });
