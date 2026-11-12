#!/usr/bin/env node
// M8 唯讀導航診斷：登入→切換 Workspace→選 Test→切回，記錄 request 起始/失敗/成功時間、method/url/errorText、導航動作與後續同 URL 200。
// 只讀：僅允許 POST /api/dev-login（登入）；其餘 PUT/PATCH/DELETE/POST 一律 FAIL。不建 session、不發訊息、不驗證、不發布。
// 分類規則（與 m8-workspace-ui.cjs 一致）：僅「abort 字樣＋用時<10s＋關聯導航取消＋後續同 URL 200」列預期；逾時疑慮／其他錯誤／缺佐證一律 FAIL。
// 無 HAR、無 request body、不碰登入資料欄。觀察用，不做產品判斷；機制未觸發即如實記「無失敗觀測」。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/@playwright/test';
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1').replace(/\/$/, '');
for (const bad of ['18080', '18085', '18086']) {
  if (WEB_URL.includes(bad)) throw new Error(`拒跑：不可對舊環境 ${bad} 驗收`);
}
const TEST_NAME = (process.env.WHIPPET_TEST_NAME || '').trim();
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-ui-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });
const OVERALL_MS = 300 * 1000;
const t0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) throw new Error(`FAIL overall-timeout step=${step}`);
}
let _pwExpect = null;
function getExpect() {
  if (!_pwExpect) {
    _pwExpect = require(path.join(path.dirname(PW_MODULE), '@playwright', 'test')).expect;
  }
  return _pwExpect;
}

async function main() {
  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);

  let page = null;
  const httpBad = [];
  const reqFail = [];
  const reqOk = [];
  const navMarks = [];
  const reqStart = new Map();
  const mutating = [];
  const markNav = (label) => { navMarks.push({ t: Date.now(), label }); };
  const result = { webUrl: WEB_URL, pass: false };

  try {
    const context = await browser.newContext();
    page = await context.newPage();
    const api = page.request;
    page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => { throw new Error(`FAIL pageerror: ${String((e && e.message) || e).slice(0, 200)}`); });
    page.on('request', (r) => {
      const raw = r.url();
      let p = raw;
      try {
        p = new URL(raw, page.url()).pathname;
      } catch {}
      if (['PUT', 'PATCH', 'DELETE'].includes(r.method())) mutating.push(`${r.method()} ${p}`);
      else if (r.method() === 'POST' && !/\/api\/dev-login$/.test(p)) mutating.push(`POST ${p}`);
      if (!raw.startsWith(WEB_URL) || /favicon\.ico/.test(raw)) return;
      reqStart.set(r, { t: Date.now(), method: r.method(), url: p });
    });
    page.on('requestfailed', (r) => {
      const raw = r.url();
      const st = reqStart.get(r) || null;
      reqStart.delete(r);
      if (!raw.startsWith(WEB_URL) || /favicon\.ico/.test(raw)) return;
      let p = raw;
      try {
        p = new URL(raw, page.url()).pathname;
      } catch {}
      let err = '';
      try {
        err = (r.failure() && r.failure().errorText) || '';
      } catch {}
      reqFail.push({ t: Date.now(), tStart: st ? st.t : Date.now(), method: (st && st.method) || r.method(), url: p.slice(0, 200), error: String(err || '').slice(0, 120) });
    });
    page.on('requestfinished', (r) => {
      reqStart.delete(r);
    });
    page.on('response', (res) => {
      const raw = res.url();
      reqStart.delete(res.request());
      if (!raw.startsWith(WEB_URL) || /favicon\.ico/.test(raw)) return;
      let p = raw;
      try {
        p = new URL(raw, page.url()).pathname;
      } catch {}
      if (res.status() >= 400) {
        httpBad.push({ t: Date.now(), method: res.request().method(), url: p.slice(0, 200), status: res.status() });
      } else {
        if (reqOk.length > 2000) reqOk.shift();
        reqOk.push({ t: Date.now(), method: res.request().method(), url: p });
      }
    });
    const pwExpect = getExpect();
    const shot = async (n) => {
      const p = path.join(EV_DIR, n);
      await page.screenshot({ path: p, fullPage: true });
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

    // 登入＋工作區基線
    checkOverall('login');
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if ((await loginBtn.count()) !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    const combo0 = page.getByRole('combobox', { name: 'Workspace' }).first();
    await combo0.waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');
    await shot('m8d-01-login.png');
    const wj = await jget('/api/workspaces', 'workspaces');
    if (!wj || !Array.isArray(wj.items) || wj.items.length < 1) throw new Error('FAIL workspaces 形狀不符');
    const wsNames = wj.items.map((w) => w.name).filter(Boolean);
    console.log(`PASS workspaces count=${wj.items.length}`);

    // 找一個 Test（僅用於切換觸發卸載；不發訊息、不驗證）
    let diagTest = null;
    if (TEST_NAME) {
      diagTest = { name: TEST_NAME };
    } else {
      for (const w of wj.items) {
        try {
          const tj = await jget(`/api/workspaces/${w.id}/tests`, `tests-of-${w.id}`);
          const items = (tj && tj.items) || [];
          if (items.length > 0 && items[0].name) {
            diagTest = { name: items[0].name, ws: w.name };
            break;
          }
        } catch {}
      }
    }
    console.log(diagTest ? `PASS diag-test=${diagTest.name}` : 'NOTE 無可用 Test，只做 Workspace 切換');

    const selectWorkspace = async (name, label) => {
      const cb = page.getByRole('combobox', { name: 'Workspace' }).first();
      await cb.waitFor({ state: 'visible', timeout: 30000 });
      const tag = await cb.evaluate((el) => el.tagName);
      markNav(label);
      if (tag === 'SELECT') {
        await cb.selectOption({ label: name });
        const sel = await cb.evaluate((el) => { const o = el.options[el.selectedIndex]; return o ? o.text.trim() : ''; });
        if (sel !== name) throw new Error(`FAIL 切換未生效（選中 ${sel}，要 ${name}）`);
      } else {
        await cb.click();
        await sleep(800);
        const o = page.getByRole('option', { name, exact: true });
        if ((await o.count()) !== 1) throw new Error(`FAIL 切換選項非唯一: ${name}`);
        await o.first().click();
      }
      await page.waitForTimeout(500);
      console.log(`PASS ${label} to=${name}`);
    };
    const selectTest = async (name, label) => {
      const boxes = page.getByRole('searchbox');
      if ((await boxes.count()) > 0) {
        await boxes.first().fill(name);
        await sleep(1000);
      }
      const b = page.getByRole('button', { name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
      if ((await b.count()) !== 1) throw new Error(`FAIL 測試按鈕非唯一/缺失: ${name}`);
      markNav(label);
      await b.first().click();
      await sleep(500);
      console.log(`PASS ${label} test=${name}`);
    };

    const others = wsNames.filter((n) => n !== wsNames[0]);
    const second = others[0] || wsNames[0];
    // 第一輪：切換觸發卸載（快速連續，促使 in-flight 重疊）
    await selectWorkspace(second, 'switch-1');
    if (diagTest) {
      try {
        await selectTest(diagTest.name, 'select-test-1');
      } catch (e) {
        console.log(`NOTE 選 Test 略過: ${e.message}`);
      }
    }
    await sleep(300);
    await selectWorkspace(wsNames[0], 'switch-2-rapid');
    console.log('NOTE 觀察窗 4s（記錄 in-flight 取消）');
    await sleep(4000);
    // 第二輪：回到穩定態再切一次
    if (diagTest) {
      try {
        await selectTest(diagTest.name, 'select-test-2');
      } catch (e) {
        console.log(`NOTE 選 Test 略過: ${e.message}`);
      }
    }
    await sleep(4000);
    await shot('m8d-02-end.png');

    // 判定：僅 abort＋短時＋關聯導航＋後續同 URL 200 列預期
    const ABORT_RE = /abort/i;
    const followupOk = (f) => reqOk.some((o) => o.method === f.method && o.url === f.url && o.t > f.t);
    const linkedNav = (f) => navMarks.find((m) => m.t >= f.tStart - 250 && m.t <= f.t + 500 && f.t - m.t <= 8000) || null;
    console.log(`--- requestfailed 明細（${reqFail.length}）---`);
    const unexpected = [];
    for (const f of reqFail) {
      const durAbort = ABORT_RE.test(f.error || '');
      const short = f.t - f.tStart < 10000;
      const nav = linkedNav(f);
      const fup = followupOk(f);
      const ok = durAbort && short && !!nav && fup;
      console.log(`  ${f.method} ${f.url} [${f.error || '無errorText'}] 用時${f.t - f.tStart}ms 關聯=${nav ? nav.label : '無'} 後續200=${fup ? '有' : '無'} -> ${ok ? '預期內導航取消' : '未分類'}`);
      if (!ok) unexpected.push(f);
    }
    console.log(`--- 導航標記（${navMarks.length}）---`);
    for (const m of navMarks) console.log(`  +${m.t - t0}ms ${m.label}`);
    if (httpBad.length > 0) throw new Error(`FAIL HTTP: HTTP ${httpBad[0].status} ${httpBad[0].method} ${httpBad[0].url}`);
    if (mutating.length > 0) throw new Error(`FAIL 唯讀違反（寫入）: ${mutating[0]}`);
    if (unexpected.length > 0) {
      const u = unexpected[0];
      throw new Error(`FAIL 未分類網路失敗: ${u.method} ${u.url} [${u.error || '無errorText'}]`);
    }
    const out = { pass: true, failed: reqFail.length, navs: navMarks.length, note: reqFail.length === 0 ? '本次觀察無 requestfailed（機制未觸發，不證明任何事）' : '全部失敗皆為有關聯＋後續 200 的導航取消' };
    fs.writeFileSync(path.join(EV_DIR, 'm8-net-diag.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(`DONE diag failed=${reqFail.length} navs=${navMarks.length} ${out.note}`);
  } catch (e) {
    try {
      if (page) await page.screenshot({ path: path.join(EV_DIR, 'm8d-fail.png'), fullPage: true });
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
