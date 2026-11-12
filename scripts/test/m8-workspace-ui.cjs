#!/usr/bin/env node
// M8 Workspace 黑箱（wave 真旅程）：新 Workspace 訪談→提案→scope→合成登入資料→探索→apply→切換隔離→既有已發布 Test（唯讀/順序/真報告）→編輯週期（start/resume/取消保留/確認放棄真 discarded）。
// provider 為 fixture，只驗 Workspace 提案與設定流程；不測真 AI 產稿，不對既有 Test 發 AI 訊息，不把 fixture 當真模型。
// UI 操作一律走可見 DOM；API 只讀輔助核對（GET），不以 API 代替 UI。禁 PUT/PATCH/DELETE（唯一例外：本次 workspace＋已核對 role 的 credentials PUT）；禁 publish/summary/validate/正式 Run/test-messages POST。第二輪訊息僅為對話接續，不算真探索。
// 不存 HAR，不記帳密值，不讀產品原始碼/真憑證。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/@playwright/test';
// 獨立 B loopback 入口（容器共享 Web network namespace，port 80）；Nginx 後端維持真 TLS verify，不放寬
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1').replace(/\/$/, '');
for (const bad of ['18080', '18085', '18086']) {
  if (WEB_URL.includes(bad)) throw new Error(`拒跑：不可對舊環境 ${bad} 驗收`);
}
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-ui-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });
const TEST_NAME = (process.env.WHIPPET_TEST_NAME || '').trim();
// checkpoint 續跑：已 apply 工作區 id；設了就跳過建立→提案→scope→登入資料→對話→apply，只驗之後流程，並明記非單次整條
const CKPT_WS = (process.env.WHIPPET_WORKSPACE_ID || '').trim();
const OVERALL_MS = 1500 * 1000;
const PROPOSAL_MS = 300 * 1000;
const t0 = Date.now();

const SYNTH_WS = 'm8-qa-ws-' + Date.now();
const SYNTH_USER = 'm8-synth-user';
const SYNTH_PASS = 'm8-synth-LOCAL-ONLY';
const MSG1 = '這個工作區要驗測 M8 合成 Workspace 流程。主要網站是 http://example.test，必要相依服務是合成驗收頁（靜態文字與完成狀態）；以表單登入，角色為合成驗收員。驗收重點是登入後看到歡迎文字並等候完成狀態。請先整理目的、背景、目標／相依範圍及角色，提出完整設定提案；帳密會由我在專用欄位保存。';
const MSG2 = '請使用已保存的合成驗收員登入已確認網站，觀察登入後歡迎文字，完成必要探索並整理最終設定提案。';

let _pwExpect = null;
function getExpect() {
  if (!_pwExpect) {
    const m = /\/@playwright\/test\/?$/.test(PW_MODULE)
      ? PW_MODULE
      : path.join(path.dirname(PW_MODULE), '@playwright', 'test');
    _pwExpect = require(m).expect;
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
  const result = { webUrl: WEB_URL, screenshots: [], pass: false };
  const consoleErrs = [];
  const pageErrs = [];
  const httpBad = []; // {t, method, url, status} 同源 4xx/5xx（一律 FAIL）
  const reqFail = []; // {t, tStart, method, url, error} 連線層失敗；僅「abort＋短時＋關聯卸載＋後續同 URL 200」列預期
  const reqOk = []; // {t, method, url} 同源成功回應（供後續同 URL 200 佐證），上限保留
  const navMarks = []; // {t, label} 可能引發 in-flight 取消的導航動作
  const reqStart = new Map();
  const markNav = (label) => { navMarks.push({ t: Date.now(), label }); };
  const mutatingPosts = [];
  const scopePosts = [];
  let verifiedRoleIds = [];
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const context = await browser.newContext();
    page = await context.newPage();
    const api = page.request;
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrs.push(String((e && e.message) || e).slice(0, 300)));
    page.on('request', (r) => {
      const raw = r.url();
      let p = raw;
      try {
        p = new URL(raw, page.url()).pathname;
      } catch {}
      if (r.method() === 'PUT' || r.method() === 'PATCH' || r.method() === 'DELETE') {
        mutatingPosts.push(`${r.method()} ${p}`);
      } else if (r.method() === 'POST') {
        mutatingPosts.push(`POST ${p}`);
      }
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
      if (/confirm-scope/.test(p)) {
        scopePosts.push(res.status());
      }
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

    // 0. 工作區基線
    checkOverall('workspaces');
    const wj = await jget('/api/workspaces', 'workspaces');
    if (!wj || !Array.isArray(wj.items) || wj.items.length < 1 || !wj.items[0].id) {
      throw new Error('FAIL workspaces 形狀不符（要 {items:[{id}]}）');
    }
    const beforeIds = new Set(wj.items.map((w) => w.id));
    const beforeNames = wj.items.map((w) => w.name);
    console.log(`PASS workspaces count=${wj.items.length}`);

    // 1. 登入
    checkOverall('login');
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if ((await loginBtn.count()) !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    const wsCombo0 = page.getByRole('combobox', { name: 'Workspace' });
    await wsCombo0.first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');
    await shot('m8-01-login.png');

    // 記錄既有 Workspace 選項（隔離切換用）
    const comboTag = await wsCombo0.first().evaluate((el) => el.tagName);
    let optNames = [];
    if (comboTag === 'SELECT') {
      optNames = await wsCombo0.first().evaluate((el) => Array.from(el.options).map((o) => o.text.trim()).filter(Boolean));
    } else {
      await wsCombo0.first().click();
      await sleep(800);
      const opts = page.getByRole('option');
      const n = await opts.count();
      for (let i = 0; i < Math.min(n, 20); i++) {
        optNames.push(((await opts.nth(i).innerText().catch(() => '')).trim().split('\n')[0] || '').slice(0, 80));
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    optNames = optNames.filter(Boolean);
    const oldWsName = optNames.find((n) => n !== SYNTH_WS) || beforeNames.find((n) => n !== SYNTH_WS);
    if (!oldWsName) throw new Error('FAIL 無既有 Workspace 可供隔離切換');
    console.log(`PASS combo existing=${oldWsName}`);

    if (!CKPT_WS) {
    // 2. 建立 Workspace（全新流程；checkpoint 模式跳過，前段見前次證據）
    checkOverall('create-workspace');
    const createBtn = page.getByRole('button', { name: '建立 Workspace', exact: true });
    if ((await createBtn.count()) !== 1) throw new Error('FAIL 建立 Workspace 非唯一');
    await createBtn.click();
    await page.getByRole('region', { name: '建立 Workspace' }).first().waitFor({ state: 'visible', timeout: 30000 });
    const wsNameField = page.getByRole('textbox', { name: 'Workspace 名稱（選填）' });
    if ((await wsNameField.count()) < 1) throw new Error('FAIL 缺 Workspace 名稱欄');
    await wsNameField.first().fill(SYNTH_WS);
    const startBtn = page.getByRole('button', { name: '建立並開始訪談', exact: true });
    if ((await startBtn.count()) !== 1) throw new Error('FAIL 建立並開始訪談非唯一');
    const createP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/workspaces$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    await startBtn.click();
    const createResp = await createP;
    if (createResp.status() !== 200 && createResp.status() !== 201) throw new Error(`FAIL 建工作區 http=${createResp.status()}`);
    const cj = await createResp.json().catch(() => null);
    const wid = (cj && ((cj.workspace && cj.workspace.id) || cj.id)) || null;
    const dlgRegion = page.getByRole('region', { name: `Workspace 對話：${SYNTH_WS}` });
    await dlgRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    if (!wid) {
      const wj2 = await jget('/api/workspaces', 'workspaces-after-create');
      const fresh = wj2.items.find((w) => !beforeIds.has(w.id));
      if (!fresh) throw new Error('FAIL 建後無新 Workspace id（API 查無）');
      result.workspaceId = fresh.id;
    } else {
      result.workspaceId = wid;
    }
    console.log(`PASS workspace id=${result.workspaceId}`);
    const wj3 = await jget(`/api/workspaces/${result.workspaceId}`, 'workspace-initial');
    const wInit = wj3.workspace || wj3;
    if (wInit.lifecycle !== undefined) console.log(`workspace lifecycle=${wInit.lifecycle}`);
    if (wInit.conversationId) result.workspaceConversationId = wInit.conversationId;
    await shot('m8-02-workspace.png');

    // 3. 訪談訊息 → 真提案
    checkOverall('proposal-1');
    const msgBox = page.getByRole('textbox', { name: 'Workspace 需求或修改訊息' });
    if ((await msgBox.count()) < 1) throw new Error('FAIL 缺 Workspace 需求或修改訊息');
    await msgBox.first().fill(MSG1);
    const sendWsBtn = page.getByRole('button', { name: '送出 Workspace 訊息', exact: true });
    if ((await sendWsBtn.count()) !== 1) throw new Error('FAIL 送出 Workspace 訊息非唯一');
    await sendWsBtn.click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-proposal-id]').length >= 1,
      null, { timeout: PROPOSAL_MS },
    );
    const pids1 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-proposal-id]')).map((el) => el.getAttribute('data-proposal-id')).filter(Boolean));
    if (pids1.length < 1) throw new Error('FAIL 無提案 data-proposal-id');
    const pid1 = pids1[0];
    const propRegion = page.getByRole('region', { name: '設定提案（待審內容）' });
    await propRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    result.proposal1 = pid1;
    console.log(`PASS proposal1 count=${pids1.length}`);
    await shot('m8-03-proposal.png');

    // 4. scope 確認
    checkOverall('scope-1');
    const scopeOf = (pid) => page.locator(`[data-proposal-id="${pid}"]`);
    const cb1 = scopeOf(pid1).getByRole('checkbox', { name: '我已檢視目標、相依範圍、角色與設定提案', exact: true });
    if ((await cb1.count()) < 1) throw new Error('FAIL 提案 scope 缺確認 checkbox（不猜）');
    await cb1.first().check();
    const scopeBtn1 = scopeOf(pid1).getByRole('button', { name: '確認提案範圍', exact: true });
    const scopeBtn = (await scopeBtn1.count()) === 1 ? scopeBtn1.first() : null;
    if (!scopeBtn) {
      const g = page.getByRole('button', { name: '確認提案範圍', exact: true });
      if ((await g.count()) !== 1) throw new Error('FAIL 確認提案範圍缺／不唯一');
      await g.first().click();
      console.log('NOTE scope 按鈕取自提案外（已記錄）');
    } else {
      await scopeBtn.click();
    }
    const scopeResp = await page.waitForResponse(
      (r) => r.request().method() === 'POST' && /confirm-scope/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    ).catch(() => null);
    console.log(`PASS scope-1 confirm-scope http=${scopeResp ? scopeResp.status() : 'n/a（UI已確認）'}`);
    if (scopeResp && scopeResp.status() !== 200) throw new Error(`FAIL confirm-scope http=${scopeResp.status()}`);
    try {
      const cbAfter = page.getByRole('checkbox', { name: '我已檢視目標、相依範圍、角色與設定提案', exact: true });
      console.log(`scope 確認後 checkbox n=${await cbAfter.count()} checked=${await cbAfter.first().isChecked().catch(() => '?')} confirm-scope posts=[${scopePosts.join(',')}]`);
    } catch {}

    // 5. 合成登入資料（專用欄位，絕不記值）
    checkOverall('credentials');
    const credRegion = page.getByRole('region', { name: '專用登入資料' });
    await credRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    const roleAll = credRegion.first().getByRole('combobox', { name: /登入角色/ });
    if ((await credRegion.count()) !== 1) throw new Error('FAIL 專用登入資料 region 非唯一');
    const accAll = page.getByLabel('登入帳號', { exact: true });
    const pwdAll = page.getByLabel('登入密碼', { exact: true });
    const scopeBoxAll = page.getByRole('checkbox', { name: '我已檢視目標、相依範圍、角色與設定提案', exact: true });
    const stateOf = async (loc, label) => {
      const n = await loc.count();
      const rows = [];
      for (let i = 0; i < Math.min(n, 5); i++) {
        let vis = false;
        let en = false;
        try {
          vis = await loc.nth(i).isVisible();
        } catch {
          vis = false;
        }
        try {
          en = await loc.nth(i).isEnabled();
        } catch {
          en = false;
        }
        rows.push(`[${i}]vis=${vis ? 1 : 0},en=${en ? 1 : 0}`);
      }
      return `${label} n=${n} ${rows.join(' ')}`;
    };
    console.log(`CRED-STATE ${await stateOf(roleAll, 'role')} | ${await stateOf(accAll, 'acc')} | ${await stateOf(pwdAll, 'pwd')} | scopeBox n=${await scopeBoxAll.count()}`);
    const pidsNow = await page.evaluate(() => Array.from(document.querySelectorAll('[data-proposal-id]')).map((el) => el.getAttribute('data-proposal-id')).filter(Boolean));
    console.log(`proposals now=[${pidsNow.join(',') || '(無)'}]`);
    // 欄位可能同時要求 scope 勾選狀態：確認後若被重置則重新勾選（只改本機勾選，不重送確認）
    {
      const n = await scopeBoxAll.count();
      let anyChecked = false;
      for (let i = 0; i < n; i++) {
        try {
          if (await scopeBoxAll.nth(i).isChecked()) {
            anyChecked = true;
            break;
          }
        } catch {}
      }
      if (!anyChecked && n > 0) {
        for (let i = 0; i < n; i++) {
          try {
            if (await scopeBoxAll.nth(i).isVisible()) {
              await scopeBoxAll.nth(i).check();
              console.log('NOTE scope 重新勾選（未重送確認）');
              break;
            }
          } catch {}
        }
      } else {
        console.log(`scope checkbox anyChecked=${anyChecked}`);
      }
    }
    const visFirst = async (loc, label) => {
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        try {
          if (await loc.nth(i).isVisible()) return loc.nth(i);
        } catch {}
      }
      throw new Error(`FAIL ${label} 無可見元素（共 ${n} 個）`);
    };
    const roleCombo = await visFirst(roleAll, '登入角色');
    const accField = await visFirst(accAll, '登入帳號');
    const pwdField = await visFirst(pwdAll, '登入密碼');
    const fmtF = (f) => `${f.method} ${f.url} [${f.error || '無errorText'}] 用時${f.t - f.tStart}ms`;
    const netSnap = () => [...httpBad.map((h) => `HTTP ${h.status} ${h.method} ${h.url}`), ...reqFail.map(fmtF)].slice(0, 8).join(' | ') || '(無失敗請求)';
    const roleTag = await roleCombo.evaluate((el) => el.tagName);
    let roleReady = false;
    if (roleTag === 'SELECT') {
      // 佔位文字（未選定/未設定）僅指尚未保存登入資料，不排除；候選=非空value＋非disabled，再與公開 roles roleId 核對
      const optDump = () => roleCombo.evaluate((el) => Array.from(el.options).map((o) => `[${o.selected ? '*' : ''}${o.disabled ? 'x' : ' '}${o.value ? 'v' : 'nov'}]${(o.text || '').trim().slice(0, 30)}`).join('|')).catch(() => '(讀取失敗)');
      let cands = [];
      const tStart = Date.now();
      while (Date.now() - tStart < 60000) {
        const all = await roleCombo.evaluate((el) => Array.from(el.options).map((o) => ({ v: o.value, t: (o.text || '').trim(), d: !!o.disabled })));
        cands = all.filter((o) => o.v !== '' && !o.d);
        if (cands.length > 0) break;
        await sleep(2000);
      }
      if (cands.length < 1) throw new Error(`FAIL 登入角色無可選選項（等60s）；選項=[${await optDump()}]；confirm-scope posts=[${scopePosts.join(',')}]；${await stateOf(roleAll, 'role')}；網路: ${netSnap()}`);
      const detResp = await api.get(`${WEB_URL}/api/workspaces/${result.workspaceId}`);
      if (detResp.status() !== 200) throw new Error(`FAIL workspace 詳情 http=${detResp.status()}`);
      let detJson = null;
      try {
        detJson = await detResp.json();
      } catch {
        detJson = null;
      }
      const detBody = detJson && (detJson.workspace || detJson);
      const roleItems = detBody && Array.isArray(detBody.roles) ? detBody.roles : null;
      if (!roleItems) throw new Error('FAIL 詳情缺 roles 陣列欄位（不猜）');
      const roleIds = roleItems.map((r) => r && (r.id !== undefined ? r.id : (r.roleId !== undefined ? r.roleId : r.role_id))).filter((x) => typeof x === 'string' && x);
      if (!roleIds.length) throw new Error('FAIL roles 無可用 UUID（需 id/roleId，不猜）');
      console.log(`PASS roles 詳情清單 ${roleIds.length} 筆`);
      verifiedRoleIds = roleIds;
      cands = cands.filter((o) => roleIds.includes(o.v));
      if (!cands.length) throw new Error(`FAIL 選項值非 roles roleId（選項=[${await optDump()}]；roleIds=${roleIds.length} 筆，不猜）；網路: ${netSnap()}`);
      console.log(`PASS roleId 核對通過（${cands.length} 候選）`);
      for (let i = 0; i < cands.length; i++) {
        await roleCombo.selectOption(cands[i].v);
        await sleep(500);
        const cur = await roleCombo.inputValue().catch(() => '');
        if (cur !== cands[i].v) continue;
        let en = false;
        for (let k = 0; k < 10 && !en; k++) {
          try {
            en = await accField.isEnabled();
          } catch {
            en = false;
          }
          if (!en) await sleep(500);
        }
        if (en) {
          roleReady = true;
          console.log(`PASS role idx=${i}/${cands.length} 啟用帳密欄（值不記錄）`);
          break;
        }
      }
      if (!roleReady) {
        await shot('m8-roles-dump.png');
        // 鍵盤真實操作備援：合成事件未驅動應用狀態時，用 trusted 鍵盤事件掃描選項
        try {
          await roleCombo.focus();
          for (const key of ['Home', 'ArrowDown', 'ArrowDown', 'Enter']) {
            await page.keyboard.press(key);
            await sleep(800);
            let enK = false;
            try {
              enK = await accField.isEnabled();
            } catch {
              enK = false;
            }
            if (enK) break;
          }
          let en2 = false;
          for (let k = 0; k < 6 && !en2; k++) {
            try {
              en2 = await accField.isEnabled();
            } catch {
              en2 = false;
            }
            if (!en2) await sleep(500);
          }
          if (en2) {
            roleReady = true;
            console.log('NOTE role 鍵盤操作啟用帳密欄（已記錄）');
          }
        } catch {}
        if (!roleReady) {
          const selText = await roleCombo.evaluate((el) => { const o = el.options[el.selectedIndex]; return o ? o.text.trim().slice(0, 40) : '(無)'; }).catch(() => '(讀取失敗)');
          let scopeChecked = '?';
          try {
            const scb = page.getByRole('checkbox', { name: '我已檢視目標、相依範圍、角色與設定提案', exact: true });
            scopeChecked = (await scb.count()) > 0 ? String(await scb.first().isChecked().catch(() => '?')) : 'missing';
          } catch {
            scopeChecked = '?';
          }
          throw new Error(`FAIL 無角色可啟用登入欄；selected=${selText} scopeChecked=${scopeChecked}；選項=[${await optDump()}]；confirm-scope posts=[${scopePosts.join(',')}]；${await stateOf(roleAll, 'role')} | ${await stateOf(accAll, 'acc')}；網路: ${netSnap()}（須經 loopback 入口 http://127.0.0.1；host.docker.internal 視為未受保護）`);
        }
      }
    } else {
      await roleCombo.click();
      await sleep(800);
      const ropts = page.getByRole('option');
      if ((await ropts.count()) < 1) throw new Error('FAIL 登入角色無可選項');
      await ropts.first().click();
      console.log('PASS role selected（自訂選單）');
      roleReady = true;
    }
    if (!roleReady) throw new Error('FAIL 角色未就緒');
    await pwExpect(pwdField.first()).toBeEnabled({ timeout: 30000 });
    await accField.first().fill(SYNTH_USER);
    await pwdField.first().fill(SYNTH_PASS);
    const saveBtn = page.getByRole('button', { name: '保存登入資料', exact: true });
    if ((await saveBtn.count()) !== 1) throw new Error('FAIL 保存登入資料非唯一');
    await saveBtn.click();
    await pwExpect(accField.first()).toHaveValue('', { timeout: 30000 });
    await pwExpect(pwdField.first()).toHaveValue('', { timeout: 30000 });
    await pwExpect(credRegion.first().getByText('已設定').first()).toBeVisible({ timeout: 30000 });
    console.log('PASS credentials 已設定＋表單清空（值未記錄）');
    await shot('m8-04-credentials.png');

    // 6. 對話接續訊息 → 最新提案 → 再確認 → 套用（明示：fixture 只回提案，此輪僅驗對話接續 schema/UI 接線，非真登入／探索）
    checkOverall('proposal-2');
    result.dialogContinuationOnly = true;
    console.log('NOTE 第二輪訊息僅驗對話接續（schema/UI 接線），非真登入／探索：fixture 只回提案');
    await msgBox.first().fill(MSG2);
    await sendWsBtn.click();
    await page.waitForFunction(
      (old) => Array.from(document.querySelectorAll('[data-proposal-id]')).some((el) => el.getAttribute('data-proposal-id') && el.getAttribute('data-proposal-id') !== old),
      pid1, { timeout: PROPOSAL_MS },
    );
    const pids2 = await page.evaluate(() => Array.from(document.querySelectorAll('[data-proposal-id]')).map((el) => el.getAttribute('data-proposal-id')).filter(Boolean));
    const pid2 = pids2.find((p) => p !== pid1);
    if (!pid2) throw new Error('FAIL 探索後無新提案');
    result.proposal2 = pid2;
    console.log('PASS proposal2 新提案出現');
    const cb2 = scopeOf(pid2).getByRole('checkbox', { name: '我已檢視目標、相依範圍、角色與設定提案', exact: true });
    if ((await cb2.count()) < 1) throw new Error('FAIL 新提案 scope 缺確認 checkbox');
    await cb2.first().check();
    const scopeBtn2 = scopeOf(pid2).getByRole('button', { name: '確認提案範圍', exact: true });
    let scopeBtnEl = null;
    if ((await scopeBtn2.count()) === 1) {
      scopeBtnEl = scopeBtn2.first();
    } else {
      const g2 = page.getByRole('button', { name: '確認提案範圍', exact: true });
      if ((await g2.count()) !== 1) throw new Error('FAIL 新提案確認範圍缺／不唯一');
      scopeBtnEl = g2.first();
      console.log('NOTE scope 按鈕取自提案外（已記錄）');
    }
    checkOverall('confirm-scope-2');
    const scopeP2 = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /confirm-scope/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    await scopeBtnEl.click();
    const scopeResp2 = await scopeP2;
    if (scopeResp2.status() !== 200) throw new Error(`FAIL confirm-scope-2 http=${scopeResp2.status()}`);
    console.log('PASS confirm-scope-2 http=200');
    // 以權威 GET 確認 scopeConfirmed 真值（不用 sleep／UI 推測當通過）
    {
      const tStart = Date.now();
      let lastNote = '';
      let ok = false;
      while (Date.now() - tStart < 30000) {
        try {
          const wj = await jget(`/api/workspaces/${result.workspaceId}`, 'workspace-scope-check');
          const cand = wj.currentProposal || wj.proposal || wj;
          if (cand && cand.scopeConfirmed === true) {
            ok = true;
            break;
          }
          lastNote = `scopeConfirmed 非真（keys=${Object.keys(cand || {}).slice(0, 8).join(',')})`;
        } catch (e) {
          lastNote = e.message;
        }
        await sleep(2000);
      }
      if (!ok) throw new Error(`FAIL scopeConfirmed 非真值（GET 30s）：${lastNote}`);
    }
    console.log('PASS scopeConfirmed=true（權威 GET）');
    // 確認會重置勾選：對 pid2 重新勾選（只改本機，不重送確認），再等 apply 可用；絕不強制點 disabled
    if (!(await cb2.first().isChecked().catch(() => true))) {
      await cb2.first().check();
      console.log('NOTE scope 重新勾選（未重送確認）');
    }
    const applyBtn = scopeOf(pid2).getByRole('button', { name: '確認並套用提案', exact: true });
    let applyEl = null;
    if ((await applyBtn.count()) === 1) {
      applyEl = applyBtn.first();
    } else {
      const ga = page.getByRole('button', { name: '確認並套用提案', exact: true });
      if ((await ga.count()) !== 1) throw new Error('FAIL 確認並套用提案缺／不唯一');
      applyEl = ga.first();
      console.log('NOTE apply 按鈕取自提案外（已記錄）');
    }
    await pwExpect(applyEl).toBeEnabled({ timeout: 30000 });
    const applyP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/proposals\/.+\/confirm$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    await applyEl.click();
    const applyResp = await applyP;
    if (applyResp.status() !== 200) throw new Error(`FAIL apply http=${applyResp.status()}`);
    console.log('PASS apply http=200');
    const formalSummary = page.getByText('查看目前正式設定（唯讀）', { exact: true });
    if ((await formalSummary.count()) !== 1) throw new Error('FAIL 查看目前正式設定（唯讀）缺／不唯一');
    await formalSummary.first().click();
    const formalRegion = page.getByRole('region', { name: '目前正式設定（唯讀）' });
    await formalRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    const formalText = ((await formalRegion.first().innerText().catch(() => '')) || '').trim();
    if (formalText.length < 10) throw new Error('FAIL 正式設定為空');
    const wApplied = await jget(`/api/workspaces/${result.workspaceId}`, 'workspace-applied');
    const wA = wApplied.workspace || wApplied;
    if (wA.lifecycle !== 'active') throw new Error(`FAIL 套用後 lifecycle 非 active`);
    if (!wA.settings) throw new Error('FAIL 套用後 settings 空');
    result.applied = true;
    console.log('PASS applied lifecycle=active settings非空');
    await shot('m8-05-applied.png');
    } else {
    // checkpoint 續跑：前段（建立／提案／scope／登入資料／對話接續／apply）已跑，證據見前次執行；本次不重做，不冒充單次整條通過
    checkOverall('checkpoint-resume');
    const wjCk = await jget(`/api/workspaces/${CKPT_WS}`, 'workspace-checkpoint');
    const wbCk = wjCk.workspace || wjCk;
    if (wbCk.lifecycle !== 'active') throw new Error(`FAIL checkpoint 非 active: ${wbCk.lifecycle}`);
    if (!wbCk.settings) throw new Error('FAIL checkpoint settings 空');
    result.workspaceId = wbCk.id || CKPT_WS;
    result.checkpointed = true;
    result.dialogContinuationOnly = true;
    console.log(`PASS checkpoint 已apply工作區接續 id=${result.workspaceId}（前段已跑，不重做）`);
    const wjCkList = await jget('/api/workspaces', 'workspaces-checkpoint-list');
    const ckMeta = ((wjCkList && wjCkList.items) || []).find((w) => w.id === result.workspaceId);
    if (!ckMeta || !ckMeta.name) throw new Error('FAIL checkpoint 工作區缺名稱');
    result.checkpointName = ckMeta.name;
    const ckCombo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await ckCombo.waitFor({ state: 'visible', timeout: 30000 });
    markNav('switch-workspace-checkpoint');
    if ((await ckCombo.evaluate((el) => el.tagName)) === 'SELECT') {
      const ckAll = await ckCombo.evaluate((el) => Array.from(el.options).map((o) => ({ v: o.value, t: (o.text || '').trim() })));
      const ckByVal = ckAll.find((o) => o.v === result.workspaceId);
      if (ckByVal) {
        await ckCombo.selectOption(ckByVal.v);
      } else {
        const ckByLabel = ckAll.find((o) => o.t === ckMeta.name);
        if (!ckByLabel) throw new Error(`FAIL 選單無 checkpoint 工作區: ${ckMeta.name}`);
        await ckCombo.selectOption({ label: ckMeta.name });
      }
      const ckSel = await ckCombo.evaluate((el) => { const o = el.options[el.selectedIndex]; return o ? o.text.trim() : ''; });
      if (ckSel !== ckMeta.name) throw new Error(`FAIL checkpoint 選取未生效（選中 ${ckSel}）`);
    } else {
      await ckCombo.click();
      await sleep(800);
      const ckOpt = page.getByRole('option', { name: ckMeta.name, exact: true });
      if ((await ckOpt.count()) !== 1) throw new Error(`FAIL checkpoint 選項非唯一: ${ckMeta.name}`);
      await ckOpt.first().click();
    }
    let ckDlgSeen = false;
    try {
      await page.getByRole('region', { name: `Workspace 對話：${ckMeta.name}` }).first().waitFor({ state: 'visible', timeout: 10000 });
      ckDlgSeen = true;
    } catch {}
    result.checkpointDialogSeen = ckDlgSeen;
    console.log(ckDlgSeen ? 'NOTE checkpoint 對話區可見，後續照常驗隱藏' : 'NOTE checkpoint 對話區未直接可見，隔離改以切換＋API 並存驗證（已記錄）');
    await shot('m8-00-checkpoint.png');
    }

    // 7. 切換 Workspace 證明隔離（切換目標=目前選中以外第一個；不假設預設 Workspace）
    checkOverall('isolation');
    const combo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await combo.waitFor({ state: 'visible', timeout: 30000 });
    markNav('switch-workspace-isolation');
    const comboTag2 = await combo.evaluate((el) => el.tagName);
    let comboOptions = [];
    if (comboTag2 === 'SELECT') {
      comboOptions = await combo.evaluate((el) => Array.from(el.options).map((o) => o.text.trim()).filter(Boolean));
    } else {
      await combo.click();
      await sleep(800);
      const nOpts = await page.getByRole('option').count();
      for (let i = 0; i < Math.min(nOpts, 20); i++) {
        comboOptions.push(((await page.getByRole('option').nth(i).innerText().catch(() => '')).trim().split('\n')[0] || '').slice(0, 80));
      }
      await page.keyboard.press('Escape').catch(() => {});
      comboOptions = comboOptions.filter(Boolean);
    }
    const curName = result.checkpointed ? result.checkpointName : SYNTH_WS;
    const switchTo = comboOptions.find((n) => n !== curName);
    if (!switchTo) throw new Error('FAIL 無可切換的其他 Workspace');
    if (comboTag2 === 'SELECT') {
      await combo.selectOption({ label: switchTo });
      const selLabel = await combo.evaluate((el) => { const o = el.options[el.selectedIndex]; return o ? o.text.trim() : ''; });
      if (selLabel !== switchTo) throw new Error(`FAIL workspace 切換未生效（選中 ${selLabel}，要 ${switchTo}）`);
    } else {
      await combo.click();
      await sleep(800);
      const opt = page.getByRole('option', { name: switchTo, exact: true });
      if ((await opt.count()) !== 1) throw new Error(`FAIL 切換選項非唯一: ${switchTo}`);
      await opt.first().click();
    }
    console.log(`PASS switch-workspace from=${curName} to=${switchTo}`);
    const dlgName = result.checkpointed ? `Workspace 對話：${result.checkpointName}` : `Workspace 對話：${SYNTH_WS}`;
    if (result.checkpointed && !result.checkpointDialogSeen) {
      console.log('NOTE checkpoint 對話區未開過，不驗隱藏；隔離以後續 API 並存＋conversation 相異為準（已記錄）');
    } else {
      await pwExpect(page.getByRole('region', { name: dlgName }).first()).toBeHidden({ timeout: 30000 });
    }
    const wjIso = await jget('/api/workspaces', 'workspaces-isolation');
    const mine = wjIso.items.find((w) => w.id === result.workspaceId);
    const other = wjIso.items.find((w) => w.name === switchTo);
    if (!mine || !other || mine.id === other.id) throw new Error('FAIL 隔離：工作區未並存');
    const cMine = await jget(`/api/workspaces/${mine.id}/conversation`, 'conv-mine').catch(() => null);
    const cOther = await jget(`/api/workspaces/${other.id}/conversation`, 'conv-other').catch(() => null);
    const idOf = (c) => c && ((c.conversation && c.conversation.id) || c.id || c.conversationId);
    if (idOf(cMine) && idOf(cOther) && idOf(cMine) === idOf(cOther)) throw new Error('FAIL 隔離：兩 Workspace 共用 conversation');
    result.isolated = true;
    result.isolationMode = (result.checkpointed && !result.checkpointDialogSeen) ? 'api-only' : 'ui+api';
    console.log(`PASS isolation 對話區切換＋conversationId 相異（${result.isolationMode}）`);
    await shot('m8-06-isolation.png');

    // 8. 既有 M8 wave synthetic 已發布 Test：尋 testId
    checkOverall('find-test');
    let targetWsId = other.id;
    let targetTest = null;
    const testNameRe = TEST_NAME ? new RegExp('^' + TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null;
    for (const w of wjIso.items) {
      let tj = null;
      try {
        const r = await api.get(`${WEB_URL}/api/workspaces/${w.id}/tests`);
        if (r.status() !== 200) continue;
        tj = await r.json();
      } catch {
        continue;
      }
      const items = (tj && tj.items) || [];
      for (const t of items) {
        const nm = t.name || '';
        if (TEST_NAME ? testNameRe.test(nm) : !!t.publishedVersionId) {
          if (TEST_NAME || !targetTest) {
            targetTest = { id: t.id, name: nm, ws: w.id, published: !!t.publishedVersionId };
          }
          if (TEST_NAME) break;
        }
      }
      if (TEST_NAME && targetTest) break;
      if (!TEST_NAME && targetTest) {
        const all = [];
        for (const w2 of wjIso.items) {
          try {
            const r2 = await api.get(`${WEB_URL}/api/workspaces/${w2.id}/tests`);
            if (r2.status() !== 200) continue;
            const j2 = await r2.json();
            for (const t of j2.items || []) if (t.publishedVersionId) all.push(t.name);
          } catch {}
        }
        if (all.length !== 1) throw new Error(`FAIL 已發布 Test 非唯一（${all.length} 個），請以 WHIPPET_TEST_NAME 指定`);
        break;
      }
    }
    if (!targetTest || !targetTest.id) throw new Error('FAIL 找不到既有 M8 wave synthetic 已發布 Test（請給 WHIPPET_TEST_NAME）');
    if (!targetTest.published) throw new Error(`FAIL 指定 Test 未發布: ${targetTest.name}`);
    result.test = { id: targetTest.id, name: targetTest.name };
    console.log(`PASS find-test name=${targetTest.name}`);
    targetWsId = targetTest.ws;
    // 先切到 Test 所在 workspace（combobox），再等該 Test 列表出現後搜尋／點擊；不假設跨 workspace Test 已在當前列表
    checkOverall('switch-test-workspace');
    {
      const wsMeta = wjIso.items.find((w) => w.id === targetTest.ws) || {};
      const wsName = wsMeta.name;
      if (!wsName) throw new Error('FAIL 找不到 Test 所屬 Workspace 名稱');
      const wsCombo = page.getByRole('combobox', { name: 'Workspace' }).first();
      await wsCombo.waitFor({ state: 'visible', timeout: 30000 });
      markNav('switch-workspace-test');
      const wsTag = await wsCombo.evaluate((el) => el.tagName);
      if (wsTag === 'SELECT') {
        const allOpts = await wsCombo.evaluate((el) => Array.from(el.options).map((o) => ({ v: o.value, t: (o.text || '').trim() })));
        let sel = null;
        const byVal = allOpts.find((o) => o.v === targetTest.ws);
        if (byVal) {
          sel = byVal.v;
        } else {
          const byLabel = allOpts.find((o) => o.t === wsName);
          if (!byLabel) throw new Error(`FAIL workspace 選項無 id/名稱匹配: ${wsName}`);
          sel = { label: wsName };
        }
        await wsCombo.selectOption(sel);
        const selLabel = await wsCombo.evaluate((el) => { const o = el.options[el.selectedIndex]; return o ? o.text.trim() : ''; });
        if (selLabel !== wsName) throw new Error(`FAIL workspace 切換未生效（選中 ${selLabel}，要 ${wsName}）`);
      } else {
        await wsCombo.click();
        await sleep(800);
        const wopt = page.getByRole('option', { name: wsName, exact: true });
        if ((await wopt.count()) !== 1) throw new Error(`FAIL workspace 選項非唯一: ${wsName}`);
        await wopt.first().click();
      }
      console.log(`PASS switch-workspace to=${wsName}`);
    }

    // 9. 選 Test → 一般順序／唯讀／真報告
    checkOverall('select-test');
    const searchBoxes = page.getByRole('searchbox');
    if ((await searchBoxes.count()) > 0) {
      await searchBoxes.first().fill(targetTest.name);
      await sleep(1000);
    }
    const tBtn = page.getByRole('button', { name: new RegExp('^' + targetTest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    if ((await tBtn.count()) !== 1) throw new Error('FAIL 既有 Test 按鈕非唯一（請給精確 WHIPPET_TEST_NAME）');
    markNav('select-test');
    await tBtn.first().click();
    const gR = page.getByRole('region', { name: '測試一般模式' });
    await gR.first().waitFor({ state: 'visible', timeout: 30000 });
    const orderLocs = [
      ['heading-版本說明', page.getByRole('heading', { name: '版本說明' })],
      ['最近一次正式執行', page.getByRole('region', { name: '最近一次正式執行' })],
      ['正式執行歷史', page.getByRole('region', { name: /^正式執行歷史/ })],
      ['歷史版本', page.getByRole('region', { name: /^歷史版本/ })],
      ['正式版本腳本', page.getByLabel('正式版本腳本（唯讀）', { exact: true })],
    ];
    const ys = [];
    for (const [nm, loc] of orderLocs) {
      await loc.first().waitFor({ state: 'visible', timeout: 30000 });
      if ((await loc.count()) !== 1) throw new Error(`FAIL 一般順序 ${nm} 非唯一`);
      const bb = await loc.first().boundingBox();
      if (!bb) throw new Error(`FAIL 一般順序 ${nm} 無框`);
      ys.push([nm, bb.y + bb.height / 2]);
    }
    for (let i = 1; i < ys.length; i++) {
      if (ys[i][1] < ys[i - 1][1] - 4) throw new Error(`FAIL 一般順序錯亂: ${ys[i][0]} 在 ${ys[i - 1][0]} 之前`);
    }
    console.log('PASS general-order 版本說明→最近執行→歷史→版本→唯讀腳本');
    const roFormal = page.getByLabel('正式版本腳本（唯讀）', { exact: true }).first();
    if (await roFormal.isEditable()) throw new Error('FAIL 正式腳本可編輯');
    const formalRun = page.getByRole('region', { name: '最近一次正式執行' }).first();
    const repLink = formalRun.getByRole('link', { name: /（新分頁）/ });
    if ((await repLink.count()) < 1) throw new Error('FAIL 最近執行無報告連結');
    if ((await repLink.count()) > 1) {
      const repNames = await repLink.evaluateAll((els) => els.map((e) => (e.textContent || '').trim().slice(0, 60)));
      console.log(`NOTE 報告連結多個（${repNames.length}），取第一個: ${repNames.join(' | ')}`);
    }
    const popupP = page.waitForEvent('popup', { timeout: 30000 });
    await repLink.first().click();
    const popup = await popupP;
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
    const pTitle = await popup.title().catch(() => '');
    if (!/Playwright Test Report/.test(pTitle)) throw new Error(`FAIL 報告 title 非預期: ${pTitle}`);
    // 原生報告為 client render：等真 Passed/Failed 已渲染元素，不以 domcontentloaded 後立即讀數當通過，不降字數門檻
    await pwExpect(popup.getByText(/Passed/i).first()).toBeVisible({ timeout: 60000 });
    await pwExpect(popup.getByText(/Failed/i).first()).toBeVisible({ timeout: 60000 });
    await popup.screenshot({ path: path.join(EV_DIR, 'm8-08-report.png') });
    const pText = (await popup.evaluate(() => document.body ? document.body.innerText || '' : '')).trim();
    if (pText.length < 50) throw new Error('FAIL 報告內容過少');
    const mP = pText.match(/Passed\s*(\d+)/i);
    const mF = pText.match(/Failed\s*(\d+)/i);
    if (!mP || !mF) throw new Error('FAIL 報告缺 Passed/Failed 數字');
    result.report = { title: pTitle, passed: mP[1], failed: mF[1] };
    console.log(`PASS report title ok Passed=${result.report.passed} Failed=${result.report.failed}`);
    await popup.close().catch(() => {});
    await shot('m8-07-test-general.png');

    // 10. 既有 Test 編輯週期（不發 AI 訊息）：start→resume→取消保留→確認放棄真 discarded
    checkOverall('editing-start');
    const sessOf = async () => {
      const g = await jget(`/api/tests/${targetTest.id}/editing-session`, 'editing-session');
      return (g.session !== undefined ? g.session : g) || null;
    };
    let s0 = await sessOf();
    let s1 = null;
    if (!s0 || !s0.id) {
      const b1 = page.getByRole('button', { name: '修改腳本', exact: true });
      const b2 = page.getByRole('button', { name: '開啟編輯工作區', exact: true });
      let sb = null;
      if ((await b1.count()) === 1) sb = b1.first();
      else if ((await b2.count()) === 1) sb = b2.first();
      else throw new Error('FAIL 無 start 按鈕（修改腳本／開啟編輯工作區）');
      const sp = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
        { timeout: 30000 },
      );
      markNav('start-editing');
      await sb.click();
      const sr = await sp;
      if (sr.status() !== 201) throw new Error(`FAIL start http=${sr.status()} expected=201`);
      const sjj = await sr.json();
      s1 = ((sjj.session && sjj.session.id) || sjj.id);
      if (!s1) throw new Error('FAIL start 回應缺 session id');
    } else {
      s1 = s0.id;
      console.log(`NOTE 既有 active session，沿用 id=${s1}（續跑分支）`);
      // 續跑停在一般模式：經草稿列 繼續修改 進入編輯（resume 200 同 id），不重建 session
      const verHist0 = page.getByRole('region', { name: /^歷史版本/ });
      await verHist0.first().waitFor({ state: 'visible', timeout: 30000 });
      if ((await verHist0.count()) !== 1) throw new Error('FAIL 歷史版本 region 非唯一');
      if (!/草稿/.test(await verHist0.first().innerText())) throw new Error('FAIL 無草稿列');
      const resume0 = verHist0.first().getByRole('button', { name: '繼續修改', exact: true });
      if ((await resume0.count()) !== 1) throw new Error('FAIL 草稿列 繼續修改缺／不唯一（續跑）');
      const rp0 = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
        { timeout: 30000 },
      );
      markNav('resume-checkpoint');
    await resume0.first().click();
      const rr0 = await rp0;
      if (rr0.status() !== 200) throw new Error(`FAIL 續跑 resume http=${rr0.status()} expected=200`);
      const rrjResume = await rr0.json();
      const sidResume = (rrjResume.session && rrjResume.session.id) || rrjResume.id;
      if (sidResume !== s1) throw new Error('FAIL 續跑重建 session');
      console.log('PASS resume same-session（續跑分支）');
    }
    result.session1 = s1;
    await pwExpect(page.getByRole('region', { name: '測試編輯模式' }).first()).toBeVisible({ timeout: 30000 });
    console.log('PASS editing start');
    await shot('m8-09-editing.png');

    checkOverall('editing-resume');
    const backBtnM = page.getByRole('button', { name: '返回一般模式', exact: true });
    if ((await backBtnM.count()) !== 1) throw new Error('FAIL 返回一般模式非唯一');
    markNav('back-to-general');
    await backBtnM.click();
    await pwExpect(page.getByRole('region', { name: '測試一般模式' }).first()).toBeVisible({ timeout: 30000 });
    const smid = await sessOf();
    if (!smid || smid.id !== s1) throw new Error('FAIL 模式切換改變 session');
    const verHist = page.getByRole('region', { name: /^歷史版本/ });
    await verHist.first().waitFor({ state: 'visible', timeout: 30000 });
    if ((await verHist.count()) !== 1) throw new Error('FAIL 歷史版本 region 非唯一');
    if (!/草稿/.test(await verHist.first().innerText())) throw new Error('FAIL 無草稿列，無法驗證移除');
    // 續編取草稿列內按鈕（一般模式頁首同名按鈕不在此 scope）
    const resumeBtn = verHist.first().getByRole('button', { name: '繼續修改', exact: true });
    if ((await resumeBtn.count()) !== 1) throw new Error('FAIL 草稿列 繼續修改缺／不唯一');
    const rp = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/editing-session$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    markNav('resume-same-session');
    await resumeBtn.first().click();
    const rr = await rp;
    if (rr.status() !== 200) throw new Error(`FAIL resume http=${rr.status()} expected=200`);
    const rjj = await rr.json();
    if (((rjj.session && rjj.session.id) || rjj.id) !== s1) throw new Error('FAIL resume 重建 session');
    result.resumedSame = true;
    console.log('PASS resume same-session');
    // 回到一般模式再操作草稿列（刪除入口在一般模式歷史版本區）
    const backBtn2 = page.getByRole('button', { name: '返回一般模式', exact: true });
    if ((await backBtn2.count()) !== 1) throw new Error('FAIL 返回一般模式（二次）非唯一');
    markNav('back-to-general-2');
    await backBtn2.click();
    await pwExpect(page.getByRole('region', { name: '測試一般模式' }).first()).toBeVisible({ timeout: 30000 });

    // 刪除固定走同一草稿列（歷史版本 region 內）；dialog 按鈕限 dialog 內，不用全頁 count
    const findDeleteBtn = async () => {
      const b = verHist.first().getByRole('button', { name: '刪除草稿', exact: true });
      if ((await b.count()) !== 1) throw new Error('FAIL 歷史版本草稿列缺唯一 刪除草稿');
      return { btn: b.first(), scope: 'history-draft-row' };
    };
    const openDiscard = async () => {
      const { btn, scope } = await findDeleteBtn();
      console.log(`delete scope=${scope}`);
      await btn.click();
      const dlg = page.getByRole('dialog', { name: '確認放棄本次修改？', exact: true });
      await dlg.first().waitFor({ state: 'visible', timeout: 30000 });
      if ((await dlg.count()) !== 1) throw new Error('FAIL 放棄 dialog 非唯一');
      return dlg.first();
    };

    checkOverall('cancel-retain');
    {
      const dlg = await openDiscard();
      await shot('m8-10-discard-dialog.png');
      const keepBtn = dlg.getByRole('button', { name: '保留草稿', exact: true });
      if ((await keepBtn.count()) !== 1) throw new Error('FAIL 保留草稿非唯一');
      await keepBtn.click();
      await pwExpect(dlg).toBeHidden({ timeout: 30000 });
      const gk = await sessOf();
      if (!gk || gk.id !== s1 || gk.status !== 'active') throw new Error('FAIL 取消後 session 非 active 原 id');
      await pwExpect(page.getByRole('region', { name: '測試一般模式' }).first()).toBeVisible({ timeout: 30000 });
      result.retainedAfterCancel = true;
      console.log('PASS cancel-retain');
      await shot('m8-11-retained.png');
    }

    checkOverall('discard-confirm');
    {
      const dlg = await openDiscard();
      const cBtn = dlg.getByRole('button', { name: '確認放棄草稿', exact: true });
      if ((await cBtn.count()) !== 1) throw new Error('FAIL 確認放棄草稿非唯一');
      const discP = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url(), page.url()).pathname.endsWith(`/editing-sessions/${s1}/discard`),
        { timeout: 30000 },
      );
      await cBtn.click();
      const discResp = await discP;
      if (discResp.status() !== 200 && discResp.status() !== 202) throw new Error(`FAIL discard http=${discResp.status()}`);
      await pwExpect(dlg).toBeHidden({ timeout: 30000 });
      result.discardHttp = discResp.status();
      const tStart = Date.now();
      for (;;) {
        if (Date.now() - tStart > 90000) throw new Error('FAIL discard 90s 未完成');
        await sleep(2000);
        const g = await api.get(`${WEB_URL}/api/tests/${targetTest.id}/editing-sessions/${s1}`);
        if (g.status() === 404) throw new Error('FAIL 已結束週期查不到（應 200 discarded）');
        if (g.status() !== 200) throw new Error(`FAIL discard 查詢 http=${g.status()}`);
        const gj = await g.json();
        const st = (gj.session || gj).status;
        console.log(`discard poll status=${st}`);
        if (st === 'discarded') break;
        if (st !== 'discarding' && st !== 'active') throw new Error(`FAIL 非預期週期狀態 ${st}`);
      }
      const gl = await sessOf();
      if (gl) throw new Error('FAIL 放棄後仍有 active session');
      await pwExpect(verHist.first()).not.toContainText('草稿', { timeout: 60000 });
      result.discarded = true;
      console.log('PASS discard discarded+草稿列移除');
      await shot('m8-12-discarded.png');
    }

    // 11. 收尾斷言：禁 PUT/PATCH/DELETE（唯一例外：本次 workspace＋已核對 role 的 credentials PUT）；禁 publish/summary/validate/正式Run/測試訊息 POST
    const forbidden = mutatingPosts.filter((m) => {
      if (/^(PUT|PATCH|DELETE) /.test(m)) {
        if (m.startsWith('PUT ')) {
          const mm = new RegExp(`^PUT /api/workspaces/${escRe(result.workspaceId)}/roles/([^/]+)/credentials$`).exec(m);
          if (mm && verifiedRoleIds.includes(mm[1])) return false;
        }
        return true;
      }
      if (!m.startsWith('POST ')) return false;
      const p = m.slice(5);
      return /publish|summary|validate/.test(p)
        || /\/api\/tests\/.+\/runs$/.test(p)
        || /\/api\/tests\/.+\/messages/.test(p);
    });
    if (forbidden.length > 0) throw new Error(`FAIL 違規請求: ${forbidden[0]}`);
    console.log(`POST/PUT/PATCH/DELETE 共 ${mutatingPosts.length} 筆皆在允許範圍`);
    // 收尾：pageerror 與同源 HTTP>=400 一律 FAIL；requestfailed 僅「已證實 abort＋短時＋關聯卸載＋後續同 URL 200」列預期
    const ABORT_RE = /abort/i;
    const TIMEOUT_SUSPECT_MS = 10000;
    const followupOk = (f) => reqOk.some((o) => o.method === f.method && o.url === f.url && o.t > f.t);
    const linkedNav = (f) => navMarks.find((m) => m.t >= f.tStart - 250 && m.t <= f.t + 500 && (f.t - m.t) <= 8000) || null;
    const classify = (f) => {
      if (!ABORT_RE.test(f.error || '')) return { kind: 'other-error' };
      if (f.t - f.tStart >= TIMEOUT_SUSPECT_MS) return { kind: 'timeout-suspect' };
      const nav = linkedNav(f);
      if (!nav) return { kind: 'abort-no-link' };
      if (!followupOk(f)) return { kind: 'abort-no-followup' };
      return { kind: 'expected', nav: nav.label };
    };
    if (pageErrs.length > 0) throw new Error(`FAIL pageerror x${pageErrs.length}: ${pageErrs[0]}`);
    const badHttp = httpBad.map((h) => `HTTP ${h.status} ${h.method} ${h.url}`);
    if (badHttp.length > 0) throw new Error(`FAIL HTTP: ${badHttp[0]}`);
    if (reqFail.length > 0) {
      console.log(`--- requestfailed 明細（${reqFail.length}） ---`);
      for (const f of reqFail) {
        const c = classify(f);
        console.log(`  ${f.method} ${f.url} [${f.error || '無errorText'}] 用時${f.t - f.tStart}ms -> ${c.kind}${c.nav ? ` ← ${c.nav}` : ''}`);
      }
    }
    const unexpected = reqFail.map((f) => ({ ...f, reason: classify(f).kind })).filter((f) => f.reason !== 'expected');
    for (const f of reqFail) {
      if (classify(f).kind === 'expected') console.log(`NOTE 預期內導航取消: ${f.method} ${f.url}`);
    }
    if (unexpected.length > 0) {
      const u = unexpected[0];
      throw new Error(`FAIL 未分類網路失敗(${u.reason}): ${u.method} ${u.url} [${u.error || '無errorText'}]`);
    }
    result.consoleErrors = consoleErrs.length;
    result.pass = true;
    fs.writeFileSync(path.join(EV_DIR, 'm8-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`DONE ws=${result.workspaceId} test=${targetTest.name} mode=${result.checkpointed ? 'checkpoint續跑（前段已跑）' : 'full'} consoleErr=${consoleErrs.length}`);
  } catch (e) {
    try {
      if (page) await page.screenshot({ path: path.join(EV_DIR, 'm8-fail.png'), fullPage: true });
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
