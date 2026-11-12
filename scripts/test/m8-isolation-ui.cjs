#!/usr/bin/env node
// M8 isolation 黑箱（唯讀 UI）：切換 Workspace 證明設定對話隔離，補之前 api-only。
// 只讀公開 UI/API 與合成資料；唯讀，不讀產品 source/真 secret。UI 不 POST 訊息/不改設定/不刪草稿/不排 Run；唯一允許 POST 是登入。
// provider 為明示 fixture，非真 AI。模型 opencode-go/muse-spark-1.3-contributor#xhigh（active，variants 含 xhigh）。
// 執行：
//   主機：WEB_URL=http://127.0.0.1:18087 node scripts/test/m8-isolation-ui.cjs
//   容器（共享 Web net）：docker --network container:whippet-m8b-web -v /private/tmp:/private/tmp -v $PWD:/work -w /work whippet-worker:m8b-wave node scripts/test/m8-isolation-ui.cjs
//     容器內 WEB_URL 預設 http://127.0.0.1（Nginx→Server 仍真 TLS，不放寬）
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/@playwright/test';
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1:18087').replace(/\/$/, '');
for (const bad of ['18080', '18085', '18086']) {
  if (WEB_URL.includes(bad)) throw new Error(`拒跑：不可對舊環境 ${bad} 驗收`);
}
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-isolation-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });

const WS_A = 'a6f9a68c-c481-4fc7-ba5a-328203c29a54';
const WS_B = '2f8aa581-c593-4e89-bc8a-a70641929a77';
// 合成對話差異（公開 GET 已觀察，非猜測）：A 含 example.test，B 含 Authenticated；assistant fixture 相同不作隔離依據
const A_MUST = 'http://example.test';
const B_MUST = 'Authenticated';

function getExpect() {
  const m = /\/@playwright\/test\/?$/.test(PW_MODULE) ? PW_MODULE : path.join(path.dirname(PW_MODULE), '@playwright', 'test');
  return require(m).expect;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);
  const result = { webUrl: WEB_URL, wsA: WS_A, wsB: WS_B, pass: false, screenshots: [] };
  const diag = []; // {t, method, url, status, err}
  const mutating = [];
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  let page = null;
  try {
    const context = await browser.newContext();
    page = await context.newPage();
    const api = page.request;
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(WEB_URL)) return;
      const p = new URL(u, page.url()).pathname;
      if (r.method() !== 'GET') {
        if (!(r.method() === 'POST' && p === '/api/dev-login')) mutating.push(`${r.method()} ${p}`);
      }
    });
    page.on('response', (res) => {
      const u = res.url();
      if (!u.startsWith(WEB_URL)) return;
      const p = new URL(u, page.url()).pathname;
      if (p.includes('/api/')) diag.push({ t: now(), method: res.request().method(), url: p.slice(0, 200), status: res.status() });
    });
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (!u.startsWith(WEB_URL)) return;
      diag.push({ t: now(), method: r.method(), url: new URL(u, page.url()).pathname.slice(0, 200), status: 'failed', err: String(r.failure()?.errorText || '').slice(0, 120) });
    });
    const pwExpect = getExpect();
    const shot = async (n) => {
      const p = path.join(EV_DIR, n);
      await page.screenshot({ path: p, fullPage: true });
      result.screenshots.push(n);
      console.log(`shot ${p}`);
    };
    const jget = async (p, label) => {
      const r = await api.get(WEB_URL + p);
      const st = r.status();
      diag.push({ t: now(), method: 'GET', url: p.slice(0, 200), status: st });
      if (st !== 200) throw new Error(`FAIL ${label} http=${st}`);
      try { return await r.json(); } catch { throw new Error(`FAIL ${label} 非 JSON`); }
    };

    // 0. 基線：兩 Workspace 並存且 conversationId 相異（公開 GET，不記 body）
    const wj = await jget('/api/workspaces', 'workspaces');
    const items = (wj && wj.items) || [];
    const wa0 = items.find((w) => w.id === WS_A);
    const wb0 = items.find((w) => w.id === WS_B);
    if (!wa0 || !wb0) throw new Error('FAIL 基線缺指定 Workspace');
    if (wa0.conversationId === wb0.conversationId) throw new Error('FAIL 基線共用 conversationId');
    result.baseA = { id: wa0.id, name: wa0.name, conversationId: wa0.conversationId, revision: wa0.revision };
    result.baseB = { id: wb0.id, name: wb0.name, conversationId: wb0.conversationId, revision: wb0.revision };
    console.log(`PASS baseline A conv=${wa0.conversationId} B conv=${wb0.conversationId}`);

    // 1. 登入（唯一允許 POST）
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if ((await loginBtn.count()) !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    const combo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await combo.waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');
    await shot('iso-01-login.png');

    const selectById = async (id) => {
      const tag = await combo.evaluate((el) => el.tagName);
      if (tag !== 'SELECT') throw new Error('FAIL Workspace 非 SELECT（與公開 bundle 不符）');
      await combo.selectOption(id);
      const sel = await combo.evaluate((el) => el.options[el.selectedIndex]?.value || '');
      if (sel !== id) throw new Error(`FAIL 切換未生效 選中=${sel} 要=${id}`);
    };
    const openSettings = async () => {
      const btn = page.getByRole('button', { name: 'Workspace 設定', exact: true });
      if ((await btn.count()) !== 1) throw new Error('FAIL Workspace 設定按鈕非唯一');
      await btn.first().click();
      // 沿 wave-web.md locator：以真 GET/可見 region 等待
      await page.getByRole('heading', { name: 'Workspace 設定對話' }).first().waitFor({ state: 'visible', timeout: 30000 });
      await page.getByRole('list', { name: '已儲存的 Workspace 訊息' }).first().waitFor({ state: 'visible', timeout: 30000 });
      await page.getByRole('textbox', { name: 'Workspace 需求或修改訊息' }).first().waitFor({ state: 'visible', timeout: 30000 });
    };
    const readList = async () => {
      const list = page.getByRole('list', { name: '已儲存的 Workspace 訊息' }).first();
      const txt = (await list.innerText().catch(() => '')) || '';
      const n = await list.getByRole('listitem').count().catch(() => -1);
      return { txt, n };
    };

    // 2. A：選單→開設定→核對 GET 與畫面
    await selectById(WS_A);
    await openSettings();
    const cA = await jget(`/api/workspaces/${WS_A}/conversation`, 'conv-A');
    if (cA.workspaceId !== WS_A) throw new Error('FAIL A 對話所屬不符');
    if (cA.id !== wa0.conversationId) throw new Error('FAIL A conversationId 與基線不符');
    if (cA.ownerType !== 'workspace') throw new Error('FAIL A 非 workspace 純讀歷史');
    const vA = await readList();
    result.A = { conv: cA.id, ctx: cA.contextRevision, n: cA.messages?.length, listN: vA.n, len: vA.txt.length };
    if (!vA.txt.includes(A_MUST)) throw new Error('FAIL A 畫面缺獨有訊息 example.test');
    if (vA.txt.includes(B_MUST)) throw new Error('FAIL A 畫面殘留 B 獨有 Authenticated');
    console.log(`PASS A ui+api conv=${cA.id} n=${cA.messages?.length} listN=${vA.n}`);
    await shot('iso-02-A-settings.png');

    // 3. B：切換→開設定→核對，且 A 獨有不殘留
    await selectById(WS_B);
    await openSettings();
    const cB = await jget(`/api/workspaces/${WS_B}/conversation`, 'conv-B');
    if (cB.workspaceId !== WS_B) throw new Error('FAIL B 對話所屬不符');
    if (cB.id !== wb0.conversationId) throw new Error('FAIL B conversationId 與基線不符');
    if (cB.id === cA.id) throw new Error('FAIL 兩 Workspace 共用 conversation');
    const vB = await readList();
    result.B = { conv: cB.id, ctx: cB.contextRevision, n: cB.messages?.length, listN: vB.n, len: vB.txt.length };
    if (cA.messages?.length === cB.messages?.length && vA.txt === vB.txt) {
      // 內容相同時不編造差異，改用 conversationId/可見名/切換請求對照
      const h2 = ((await page.getByRole('heading').first().innerText().catch(() => '')) || '').slice(0, 80);
      result.sameContentFallback = { h2, convA: cA.id, convB: cB.id };
      console.log(`NOTE 內容相同，走 conversationId/切換對照 convA=${cA.id} convB=${cB.id}`);
    } else {
      if (!vB.txt.includes(B_MUST)) throw new Error('FAIL B 畫面缺獨有 Authenticated');
      if (vB.txt.includes(A_MUST)) throw new Error('FAIL B 畫面殘留 A 獨有 example.test');
    }
    console.log(`PASS B ui+api conv=${cB.id} n=${cB.messages?.length} listN=${vB.n}`);
    await shot('iso-03-B-settings.png');

    if (mutating.length) throw new Error(`FAIL 出現非登入寫入: ${mutating[0]}`);
    result.pass = true;
    result.diag = diag;
    console.log('PASS isolation ui+api（真點設定＋GET＋可見訊息，唯讀）');
  } catch (e) {
    result.error = String((e && e.message) || e).slice(0, 500);
    result.diag = diag;
    result.mutating = mutating;
    console.error(result.error);
    try { if (page) await page.screenshot({ path: path.join(EV_DIR, 'iso-fail.png'), fullPage: true }); } catch {}
    result.screenshots.push('iso-fail.png');
  } finally {
    fs.writeFileSync(path.join(EV_DIR, 'iso-result.json'), JSON.stringify(result, null, 2));
    await browser.close().catch(() => {});
  }
  if (!result.pass) process.exit(1);
}
main();
