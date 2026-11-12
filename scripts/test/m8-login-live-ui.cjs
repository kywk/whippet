#!/usr/bin/env node
// M8 loginAs Live遮蔽黑箱（獨立Test，不碰別人Test，不重驗普通LiveView）。
// 模型: opencode-go/muse-spark-1.3-contributor#xhigh 已確認 (models tool active, variants含xhigh)。不用mini、不啟其他agent。
// t3g 已退出，可獨佔修改本檔。產品三端修復即將整合，PM待Web到齊部署；本腳本不重跑舊版，只收斂實際通過條件。
// Workspace: 2f8aa581-c593-4e89-bc8a-a70641929a77（既有，不新建）。
// 獨立 Test: m8-qa-login-mask（不存在則建立，不碰 m8-qa-live / M8 manual synthetic login）。每次真UI validate 一次，不跟其他Test搶viewer。
// 合成慢站(同origin公開): http://host.docker.internal:18187/slow-login（真DOM: #username #password button[type=submit]）。
//   12s後button enabled → spec須 expect enabled timeout20s 再 loginAs；POST /slow-session 延遲12s全response（含headers，不先送headers拖body）；
//   頁面 Authenticated/alpha 與10s status Completed進度，spec等Completed且cookie只判布林。roleId 仍公開GET已確認角色，不寫帳密。
// PM待補: 合成echo span供遮罩刺激＋時間戳端點。本腳本先交需求：無觀測（無pause/complete/真frames）不得PASS，一律未驗。
// 實際通過條件（舊maskHit status regex＋late frames>0不足，已廢止）：
//   只掛真UI既有唯一Live WS的framereceived/sent（不開第二viewer），只存type/state/reason/viewerId/offerId/SDP hash，不存原SDP/binary；
//   敏感前同viewer/mode已有兩真frames；pause事件後清屏、1s在途排空後6s核心窗口無新frame；同viewer complete先於新offer與answer echo（complete前offer須丟棄）；
//   新peer恢復後兩個遞增frames（恢復後兩時間點比較，不要求大於暫停前累計，不拿舊counter誤當恢復）；三階段截圖供PM目視。
//   MODE=webrtc或jpeg各自判斷，不把fallback算WebRTC；可選JOIN_DURING_SENSITIVE=1僅敏感中途viewer檢查（停止後重連，單viewer串行，不併發搶占）。
// spec timeout覆蓋全程（Workspace內 test.setTimeout 60s），不用sleep作斷言，只用expect poll/timeout；fixture known sentinel僅本地布林＋PM像素目視，不以壓縮bytes掃描當影像證據。
// 用法（PM有 Docker/Node處跑，映像已有 @playwright/test＋Chromium，不安裝）：
//   主機直跑: WEB_URL=http://127.0.0.1 MODE=webrtc WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m8-login-live-evidence node scripts/test/m8-login-live-ui.cjs
//   容器共享Web net（仍 Nginx→Server真TLS）: docker --network container:whippet-m8b-web -e WEB_URL=http://127.0.0.1 -e MODE=webrtc -e WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m8-login-live-evidence whippet-worker:m8-mask-qa node scripts/test/m8-login-live-ui.cjs
//   jpeg模式: MODE=jpeg 同上；中途加入: JOIN_DURING_SENSITIVE=1 同上（僅另取一筆，不覆蓋已連viewer主判）。
// 本腳本不安裝/部署/Git，不讀frame內敏感DOM/真secret（含.env.ai），錯誤不記body；公開WS JSON/log不含sentinel另目視像素。
// 固定檢查: node --check scripts/test/m8-login-live-ui.cjs（本機有node即跑，否則PM執行）；不聲稱實跑。完成回報給t36。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WORKSPACE_ID = '2f8aa581-c593-4e89-bc8a-a70641929a77';
const TEST_NAME = 'm8-qa-login-mask';
const TEST_DESC = 'M8 loginAs live mask (black-box, no credential)';
const SLOW_LOGIN_URL = 'http://host.docker.internal:18187/slow-login';
const SENTINEL_ROLE_ID = '5b9ab57a-4152-4559-914f-aaf362e24787';
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1').replace(/\/$/, '');
const EVIDENCE_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-login-live-evidence';
const RESULT_PATH = path.join(EVIDENCE_DIR, 'm8-login-live-result.json');
const MODE = (process.env.MODE || 'webrtc').toLowerCase() === 'jpeg' ? 'jpeg' : 'webrtc';
const JOIN_DURING_SENSITIVE = process.env.JOIN_DURING_SENSITIVE === '1';
const SENTINEL_HINT = process.env.WHIPPET_MASK_SENTINEL || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadPw() {
  const c = [process.env.WHIPPET_PLAYWRIGHT_MODULE, '/opt/whippet/worker/node_modules/playwright', '/opt/whippet/worker/node_modules/@playwright/test', 'playwright', '@playwright/test'].filter(Boolean);
  let e = null;
  for (const m of c) { try { const mod = require(m); if (mod && mod.chromium) return mod; } catch (err) { e = err; } }
  throw new Error('找不到 Playwright: ' + (e && e.message));
}
function loadExpect() {
  const c = ['/opt/whippet/worker/node_modules/@playwright/test', '@playwright/test'];
  for (const m of c) { try { const mod = require(m); if (mod && mod.expect) return mod.expect; } catch {} }
  throw new Error('找不到 expect');
}
function sdpHash(s) {
  try { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); } catch { return 'hash-err'; }
}
function srcHash(s) {
  try { return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16); } catch { return 'hash-err'; }
}
function buildScript(roleId) {
  return `import { test, expect } from '@playwright/test';
import { loginAs } from 'whippet/login';
const roleId='${roleId}';
test.setTimeout(60000);
test('m8 loginAs live mask', async ({ page }, testInfo) => {
  await page.goto('${SLOW_LOGIN_URL}');
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  const submitBtn = page.locator('button[type=submit]');
  await expect(submitBtn).toBeEnabled({ timeout: 20000 });
  const submitted = await loginAs(page, roleId, '#username', '#password', 'button[type=submit]');
  expect(submitted).toEqual({submitted:true});
  await expect(page).toHaveURL(/\\/slow-session$/);
  await expect(page.getByRole('heading')).toHaveText('Authenticated');
  await expect(page.getByRole('listitem')).toHaveText(['alpha']);
  await expect(page.getByText('Completed')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => (await page.context().cookies()).some((c) => c.name==='session' && c.httpOnly)).toBe(true);
  await testInfo.attach('authenticated-safe', { body: await page.screenshot(), contentType: 'image/png' });
});
`;
}
// 只存白名單欄位，不存原SDP/binary/body；sentinel僅本地布林，不記值。
function noteWsEvent(list, dt, dir, raw, leakState) {
  try {
    let s = null;
    if (raw == null) return;
    if (typeof raw === 'object' && raw !== null && ('payload' in raw)) raw = raw.payload;
    if (Buffer.isBuffer(raw)) {
      if (SENTINEL_HINT && leakState) { try { if (raw.includes(SENTINEL_HINT)) leakState.leaked = true; } catch {} }
      list.push({ dt, dir, kind: 'binary', binLen: raw.length });
      return;
    }
    if (typeof raw !== 'string') {
      try { s = String(raw); } catch { list.push({ dt, dir, kind: 'unknown' }); return; }
    } else s = raw;
    if (SENTINEL_HINT && leakState && s.includes(SENTINEL_HINT)) leakState.leaked = true;
    // 二進位或超長非JSON只記長度，不存原文
    let obj = null;
    try { obj = JSON.parse(s); } catch { list.push({ dt, dir, kind: s.length > 300 ? 'blob-text' : 'text', len: s.length }); return; }
    if (obj === null || typeof obj !== 'object') { list.push({ dt, dir, kind: 'json-scalar', len: s.length }); return; }
    const pick = (o) => ({
      type: typeof o.type === 'string' ? o.type.slice(0, 32) : undefined,
      state: typeof o.state === 'string' ? o.state.slice(0, 32) : undefined,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 64) : undefined,
      viewerId: typeof o.viewerId === 'string' ? o.viewerId.slice(0, 64) : undefined,
      transport: typeof o.transport === 'string' ? o.transport.slice(0, 16) : undefined,
      offerId: typeof o.offerId === 'string' ? o.offerId.slice(0, 64) : (o.offer && typeof o.offer.id === 'string' ? o.offer.id.slice(0, 64) : undefined),
      answerOfferId: o.type === 'answer' && typeof o.offerId === 'string' ? o.offerId : typeof o.answerOfferId === 'string' ? o.answerOfferId.slice(0, 64) : (o.answer && typeof o.answer.offerId === 'string' ? o.answer.offerId.slice(0, 64) : undefined),
    });
    const p = pick(obj);
    // SDP只存hash
    let hash = null;
    try {
      const sdp = obj.sdp || (obj.offer && obj.offer.sdp) || (obj.answer && obj.answer.sdp) || null;
      if (typeof sdp === 'string' && sdp.length > 0) hash = sdpHash(sdp);
    } catch {}
    const rec = { dt, dir, kind: 'json' };
    for (const k of ['type', 'state', 'reason', 'viewerId', 'transport', 'offerId', 'answerOfferId']) if (p[k] !== undefined) rec[k] = p[k];
    if (hash) rec.sdpHash = hash;
    // offer/answer物件內ID變體（不存SDP原文）
    try {
      if (!rec.offerId && typeof obj.id === 'string' && /offer/i.test(obj.type || '')) rec.offerId = obj.id.slice(0, 64);
      if (!rec.answerOfferId && typeof obj.id === 'string' && /answer/i.test(obj.type || '')) rec.answerOfferId = obj.id.slice(0, 64);
    } catch {}
    list.push(rec);
  } catch {
    try { list.push({ dt, dir, kind: 'note-err' }); } catch {}
  }
}
async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const pw = loadPw();
  const expect = loadExpect();
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  let page = null;
  const t0 = Date.now();
  const wsEvents = [];
  const leakState = { checked: Boolean(SENTINEL_HINT), leaked: false };
  try {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    await page.getByRole('complementary', { name: 'Workspace 測試列表' }).first().waitFor({ state: 'visible', timeout: 30000 });
    const tLogin = Date.now() - t0;
    console.log(`web-ok ${WEB_URL} t=${tLogin}ms mode=${MODE} joinMid=${JOIN_DURING_SENSITIVE ? 1 : 0}`);
    const ensured = await page.evaluate(async ({ wid, name, desc, sentinel }) => {
      const j = async (m, p, b) => {
        const r = await fetch(p, { method: m, headers: b ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        const t = await r.text();
        let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = { _raw: '' }; }
        if (!r.ok) throw new Error(`${m} ${p} HTTP=${r.status}`);
        return d;
      };
      const ws = await j('GET', `/api/workspaces/${wid}`);
      const lr = (ws.settings && ws.settings.loginRoles && ws.settings.loginRoles[0]) || {};
      const roleId = lr.roleId || (ws.roles && ws.roles[0] && ws.roles[0].roleId) || sentinel;
      if (!roleId) throw new Error('缺 roleId（公開GET無角色）');
      const list = await j('GET', `/api/workspaces/${wid}/tests`);
      const items = (list && list.items) || [];
      let t = items.find((x) => x.name === name) || null;
      if (!t) t = await j('POST', `/api/workspaces/${wid}/tests`, { name, description: desc });
      if (!t.id) throw new Error('test 缺 id');
      let s = await j('GET', `/api/tests/${t.id}/editing-session`);
      let sess = s && s.session ? s.session : null;
      if (!sess) sess = (await j('POST', `/api/tests/${t.id}/editing-session`, {})).session;
      if (!sess || !sess.id) throw new Error('editing-session 缺 id');
      return { testId: t.id, editingSessionId: sess.id, roleId };
    }, { wid: WORKSPACE_ID, name: TEST_NAME, desc: TEST_DESC, sentinel: SENTINEL_ROLE_ID });
    console.log(`ensure testId=${ensured.testId} roleId=${ensured.roleId} t=${Date.now() - t0}ms`);
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(WORKSPACE_ID, { timeout: 30000 });
    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await search.waitFor({ state: 'visible', timeout: 30000 });
    await search.fill(TEST_NAME);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    const esc = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const testBtn = listRegion.getByRole('button', { name: new RegExp('^' + esc) });
    try { await testBtn.first().waitFor({ state: 'visible', timeout: 15000 }); }
    catch { await listRegion.getByRole('button', { name: '重新載入', exact: true }).click(); await testBtn.first().waitFor({ state: 'visible', timeout: 30000 }); }
    await testBtn.first().click();
    const detail = page.getByRole('region', { name: '測試詳情' }).first();
    await detail.waitFor({ state: 'visible', timeout: 30000 });
    await detail.getByRole('button', { name: /^(繼續修改|開啟編輯工作區|修改腳本)$/ }).first().click();
    const editing = page.getByRole('region', { name: '測試編輯模式' });
    await editing.first().waitFor({ state: 'visible', timeout: 30000 });
    await editing.getByRole('heading', { name: /^AI 與草稿驗證紀錄/ }).first().waitFor({ state: 'visible', timeout: 30000 });
    const script = buildScript(ensured.roleId);
    const draft = await page.evaluate(async ({ tid, sc }) => {
      const j = async (m, p, b) => {
        const r = await fetch(p, { method: m, headers: b ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        const t = await r.text();
        let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = {}; }
        if (!r.ok) throw new Error(`${m} ${p} HTTP=${r.status}`);
        return d;
      };
      const s = await j('GET', `/api/tests/${tid}/editing-session`);
      const sess = s && s.session ? s.session : null;
      if (!sess || !sess.id) throw new Error('editing-session 缺 id');
      if (sess.draft && sess.draft.script === sc) return { editingSessionId: sess.id, revision: sess.draft.revision || 1 };
      const saved = await j('PUT', `/api/tests/${tid}/draft`, { editingSessionId: sess.id, revision: sess.draft ? sess.draft.revision : 1, script: sc });
      if (saved.scriptOrigin !== 'manual') throw new Error('scriptOrigin 非 manual');
      return { editingSessionId: sess.id, revision: saved.revision };
    }, { tid: ensured.testId, sc: script });
    console.log(`draft-ready rev=${draft.revision} t=${Date.now() - t0}ms`);
    await editing.getByRole('button', { name: '重新載入草稿', exact: true }).click();
    const vBtn = editing.getByRole('button', { name: '驗證此 revision', exact: true });
    await vBtn.waitFor({ state: 'visible', timeout: 30000 });
    const respP = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/draft\/validate$/.test(new URL(r.url(), page.url()).pathname), { timeout: 60000 });
    const tClick = Date.now();
    await vBtn.click();
    const resp = await respP;
    if (resp.status() !== 202) throw new Error(`validate HTTP=${resp.status()}`);
    const vj = await resp.json();
    const runId = vj && vj.id;
    if (!runId) throw new Error('validate 回應缺 runId');
    console.log(`new-run runId=${runId} t_click=${Date.now() - tClick}ms`);
    // 掛既有唯一Live WS（此runId），不另建viewer；只存白名單＋hash。
    let tWatch0 = Date.now();
    page.on('websocket', (ws) => {
      try {
        const u = ws.url();
        if (!u.includes('/api/runs/') || !u.includes('/live')) return;
        if (!u.includes(runId)) return;
        ws.on('framereceived', (raw) => { try { noteWsEvent(wsEvents, Date.now() - tWatch0, 'rx', raw, leakState); } catch {} });
        ws.on('framesent', (raw) => { try { noteWsEvent(wsEvents, Date.now() - tWatch0, 'tx', raw, leakState); } catch {} });
      } catch {}
    });
    const latest = editing.locator('section', { has: page.getByRole('heading', { name: /^最近編輯結果/ }) }).first();
    await latest.waitFor({ state: 'visible', timeout: 60000 });
    await latest.getByRole('button', { name: '開始監看', exact: true }).click();
    const region = page.getByRole('region', { name: '唯讀監看' });
    await region.waitFor({ state: 'visible', timeout: 30000 });
    await region.getByText(runId, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
    const conn = page.getByRole('status', { name: '監看連線狀態' });
    await conn.waitFor({ state: 'visible', timeout: 30000 });
    const tWatch = Date.now();
    tWatch0 = tWatch;
    console.log(`live-run-ok ${runId} mode=${MODE} t_watch=${tWatch - tClick}ms`);
    const video = page.locator('video[data-testid="live-video"]');
    const jpeg = page.locator('img[data-testid="live-jpeg"], img[alt="JPEG 備援唯讀監看畫面"]');
    await video.or(jpeg).first().waitFor({ state: 'visible', timeout: 30000 });
    // jpeg模式切備援；webrtc模式不切（fallback另記，不算WebRTC PASS）。
    let jpegToggled = false;
    if (MODE === 'jpeg') {
      try {
        const tb = region.getByRole('button', { name: '切換 JPEG 備援', exact: true });
        await tb.first().waitFor({ state: 'visible', timeout: 10000 });
        await tb.first().click();
        jpegToggled = true;
      } catch { jpegToggled = false; }
    }
    const samples = [];
    let shotPre = null, shotCore = null, shotPost = null;
    let midJoin = null;
    let midRejoined = false;
    // 取樣60s：只作觀測，不拿sleep當斷言。
    for (let i = 0; i < 120; i++) {
      const s = await page.evaluate(async (id) => {
        const st = (document.querySelector('[data-testid="live-status"]') || {}).textContent || '';
        const v = document.querySelector('video[data-testid="live-video"]');
        let frames = -1, w = 0, rs = 0, live = 0;
        try { if (v) { frames = v.getVideoPlaybackQuality().totalVideoFrames ?? -1; } } catch { frames = -1; }
        try { if (v) { w = v.videoWidth || 0; rs = v.readyState; const tr = v && v.srcObject ? v.srcObject.getVideoTracks() : []; live = tr.filter((t) => t.readyState === 'live' && t.enabled).length; } } catch {}
        let jw = 0, jc = false, jsrc = '';
        try {
          const im = document.querySelector('img[data-testid="live-jpeg"]') || document.querySelector('img[alt="JPEG 備援唯讀監看畫面"]');
          if (im) { jw = im.naturalWidth || 0; jc = Boolean(im.complete); jsrc = im.currentSrc || im.src || ''; }
        } catch {}
        let runStatus = '';
        try {
          const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
          if (r.status === 200) { const t = await r.text(); try { const jj = JSON.parse(t); runStatus = (jj.run || jj).status || ''; } catch {} }
          else runStatus = 'http' + r.status;
        } catch { runStatus = 'fetch-err'; }
        return { statusText: (st || '').slice(0, 120), frames, w, readyState: rs, liveTracks: live, jpegW: jw, jpegComplete: jc, jpegSrc: (jsrc || '').slice(0, 200), runStatus };
      }, runId);
      const dt = Date.now() - tWatch;
      const rec = { dt, ...s, jpegSrcHash: srcHash(s.jpegSrc) };
      delete rec.jpegSrc;
      samples.push(rec);
      // 階段截圖觸發（觀測驅動，非固定sleep斷言）
      try {
        const pauseEv = wsEvents.find((e) => e.kind === 'json' && e.type === 'state' && e.state === 'waiting' && e.reason === 'sensitive_input');
        if (!shotPre && !pauseEv && ((MODE === 'webrtc' && rec.frames > 0 && rec.w > 0) || (MODE === 'jpeg' && rec.jpegW > 0))) {
          const p = path.join(EVIDENCE_DIR, 'm8-mask-pre.png');
          await page.screenshot({ path: p, fullPage: false });
          shotPre = p;
        }
        if (pauseEv && !shotCore && dt >= pauseEv.dt + 3000 && dt <= pauseEv.dt + 6000) {
          const p = path.join(EVIDENCE_DIR, 'm8-mask-core.png');
          await region.screenshot({ path: p }).catch(async () => { await page.screenshot({ path: p, fullPage: false }); });
          shotCore = p;
        }
        const resumed = wsEvents.find((e) => e.kind === 'json' && e.type === 'state' && e.reason === 'sensitive_input_complete');
        if (!shotPost && resumed && dt > resumed.dt && ((MODE === 'webrtc' && rec.frames > 1 && rec.w > 0 && rec.liveTracks > 0) || (MODE === 'jpeg' && rec.jpegW > 0))) {
          const p = path.join(EVIDENCE_DIR, 'm8-mask-post.png');
          await region.screenshot({ path: p });
          shotPost = p;
        }
        // JOIN_DURING_SENSITIVE：暫停核心期停止後重連（單viewer串行），另取中途viewer一筆
        if (JOIN_DURING_SENSITIVE && !midRejoined && pauseEv && dt >= pauseEv.dt + 2000 && dt <= pauseEv.dt + 5000) {
          midRejoined = true;
          try {
            const stopB = region.getByRole('button', { name: '停止監看', exact: true });
            await stopB.first().click({ timeout: 5000 });
            await sleep(800);
            let rc = null;
            try { rc = region.getByRole('button', { name: '重新連線', exact: true }); await rc.first().waitFor({ state: 'visible', timeout: 5000 }); await rc.first().click(); }
            catch { const sb = region.getByRole('button', { name: /開始監看/, exact: false }); await sb.first().click({ timeout: 5000 }).catch(() => {}); }
            midJoin = { rejoinedAt: Date.now() - tWatch, note: '已重連，待pause(viewerId)與無擷取' };
          } catch (e2) { midJoin = { rejoinedAt: Date.now() - tWatch, note: '重連按鈕缺，無法中途加入', err: String((e2 && e2.message) || e2).slice(0, 120) }; }
        }
      } catch {}
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(s.runStatus)) break;
      await sleep(500);
    }
    const runEnd = samples.length ? samples[samples.length - 1].runStatus : 'unknown';
    if (runEnd !== 'succeeded') throw new Error(`run 終態非 succeeded: ${runEnd}`);
    // ---- 嚴格判定（取代舊regex＋late frames>0）----
    const isPause = (e) => e && e.kind === 'json' && e.type === 'state' && e.state === 'waiting' && e.reason === 'sensitive_input';
    const isComplete = (e) => e && e.kind === 'json' && e.type === 'state' && e.state === 'waiting' && e.reason === 'sensitive_input_complete';
    const pauses = wsEvents.filter(isPause);
    const completes = wsEvents.filter(isComplete);
    // 同viewer＋同transport（MODE）配對
    let pauseEv = null, completeEv = null, viewerId = null;
    const reasons = [];
    if (pauses.length === 0) reasons.push('缺pause事件(state/waiting/sensitive_input)；無觀測不得PASS，需PM慢fixture＋時間戳端點');
    else {
      // 優先MODE transport一致者
      pauseEv = pauses.find((e) => e.transport === MODE && e.viewerId) || pauses.find((e) => e.viewerId) || pauses[0];
      viewerId = pauseEv.viewerId || null;
      if (!viewerId) reasons.push('pause缺viewerId（Server須填當前LiveSession viewerId）');
      if (pauseEv.transport && pauseEv.transport !== MODE) reasons.push(`pause transport=${pauseEv.transport}非${MODE}；fallback不算${MODE} PASS`);
      if (!pauseEv.transport) reasons.push('pause缺transport(webrtc|jpeg)，無法分模判定');
    }
    if (pauseEv && viewerId) {
      const cand = completes.filter((e) => e.viewerId === viewerId);
      completeEv = cand.find((e) => !e.transport || e.transport === (pauseEv.transport || MODE)) || cand[0] || null;
      if (!completeEv) reasons.push('缺同viewer complete(sensitive_input_complete)；complete須先於新offer');
      else if (completeEv.dt <= pauseEv.dt) reasons.push('complete早於pause，順序錯');
      else if (pauseEv.transport && completeEv.transport && completeEv.transport !== pauseEv.transport) reasons.push('complete transport與pause不一致');
    } else if (pauses.length > 0 && completes.length === 0) reasons.push('缺complete事件');
    // 中途加入（可選）：重連後新viewerId亦須pause＋無擷取
    let midJoinVerdict = null;
    if (JOIN_DURING_SENSITIVE) {
      if (!midJoin || !midJoin.rejoinedAt) midJoinVerdict = '未執行中途重連（按鈕缺或窗口不足），另取一筆未完成';
      else {
        const after = wsEvents.filter((e) => e.dt > midJoin.rejoinedAt && isPause(e) && e.viewerId && e.viewerId !== viewerId);
        const midPause = after[0] || null;
        if (!midPause) midJoinVerdict = '中途viewer未收到自身viewerId pause，不可PASS中途項';
        else {
          const drain = wsEvents.filter((e) => e.dt >= midPause.dt && e.dt <= midPause.dt + 1000 && e.kind === 'binary').length;
          const coreNew = samples.filter((s) => s.dt > midPause.dt + 1000 && s.dt <= midPause.dt + 4000);
          const vidInc = coreNew.length >= 2 ? (coreNew[coreNew.length - 1].frames - coreNew[0].frames) : 0;
          midJoin.viewerId = midPause.viewerId;
          midJoin.pauseAt = midPause.dt;
          midJoin.noCapture = vidInc <= 0;
          midJoinVerdict = midJoin.noCapture ? 'pass' : '中途viewer敏感期仍有新frame，FAIL中途項';
          if (!midJoin.noCapture) reasons.push('中途viewer敏感期有新frame');
        }
      }
    }
    // 敏感前兩真frames（同viewer/mode，固定延遲不等於已連線）
    let preOk = false, preDetail = '';
    if (pauseEv) {
      const pre = samples.filter((s) => s.dt < pauseEv.dt);
      if (MODE === 'webrtc') {
        const seq = pre.filter((s) => s.frames >= 0 && s.w > 0 && s.readyState >= 2).map((s) => s.frames);
        let incPairs = 0;
        for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) incPairs++;
        preOk = incPairs >= 1 && seq.length >= 2;
        preDetail = `webrtc preSamples=${pre.length} incPairs=${incPairs}`;
        if (!preOk) reasons.push(`敏感前無兩真frames(${preDetail})；固定12s不等於viewer已連線`);
      } else {
        const seq = pre.filter((s) => s.jpegW > 0).map((s) => s.jpegSrcHash);
        const uniq = [...new Set(seq)];
        preOk = seq.length >= 2 && uniq.length >= 2;
        preDetail = `jpeg preSamples=${pre.length} uniqSrc=${uniq.length}`;
        if (!preOk) reasons.push(`敏感前無兩真JPEG(${preDetail})`);
      }
    }
    // 核心窗口：1s排空＋6s無新frame（舊安全快取不是新影格）
    let coreOk = false, coreDetail = '';
    if (pauseEv && completeEv) {
      const drainEnd = pauseEv.dt + 1000;
      const coreEnd = drainEnd + 6000;
      if (completeEv.dt < coreEnd) {
        reasons.push(`窗口不足：complete早於6s核心窗（pause=${pauseEv.dt} complete=${completeEv.dt}，需>=${coreEnd}）；時間不足即未觀察`);
      } else {
        if (MODE === 'webrtc') {
          const win = samples.filter((s) => s.dt > drainEnd && s.dt <= coreEnd && s.frames >= 0);
          if (win.length < 4) { reasons.push(`核心窗取樣不足(${win.length}點，需多點比較)`); coreDetail = `points=${win.length}`; }
          else {
            const diff = win[win.length - 1].frames - win[0].frames;
            coreOk = diff === 0 && win.every((s) => s.w === 0 && s.liveTracks === 0 && s.readyState === 0);
            coreDetail = `points=${win.length} diff=${diff}`;
            if (!coreOk) reasons.push(`核心窗仍有新解碼frame(diff=${diff})；敏感期不得產新秘密影格`);
          }
        } else {
          const binNew = wsEvents.filter((e) => e.dt > drainEnd && e.dt <= coreEnd && e.kind === 'binary').length;
          const win = samples.filter((s) => s.dt > drainEnd && s.dt <= coreEnd);
          const hashes = [...new Set(win.map((s) => s.jpegSrcHash))];
          coreOk = binNew === 0 && hashes.length <= 1 && win.length >= 4 && win.every((s) => s.jpegW === 0);
          coreDetail = `binNew=${binNew} uniqSrc=${hashes.length}`;
          if (!coreOk) reasons.push(`核心窗仍有新JPEG(binNew=${binNew} uniqSrc=${hashes.length})`);
        }
      }
    }
    // complete先於新offer與answer echo；complete前offer須丟棄（無answer）
    let offerEv = null, answerEv = null, seqOk = false;
    const offerEvents = wsEvents.filter((e) => e.type === 'offer' && e.dir === 'rx' && e.offerId);
    const answerEvents = wsEvents.filter((e) => e.type === 'answer' && e.dir === 'tx' && e.answerOfferId);
    if (pauseEv && completeEv && MODE === 'webrtc') {
      const between = offerEvents.filter((e) => e.dt > pauseEv.dt && e.dt < completeEv.dt);
      if (between.length > 0) {
        const answered = between.some((o) => answerEvents.some((a) => a.answerOfferId === o.offerId && a.dt > o.dt && a.dt < completeEv.dt));
        if (answered) reasons.push('complete前offer被answer（應丟棄），順序FAIL');
        else reasons.push('complete前有offer（須丟棄；雖無answer仍記順序疑點，需t31查雙queue順序）');
      }
      const preIds = new Set(offerEvents.filter((e) => e.dt < pauseEv.dt).map((e) => e.offerId));
      const cands = offerEvents.filter((e) => e.dt > completeEv.dt && !preIds.has(e.offerId));
      offerEv = cands[0] || null;
      if (!offerEv) reasons.push('缺complete後新UUID offer（complete只表等待新offer，仍非streaming）');
      else {
        answerEv = answerEvents.find((a) => a.answerOfferId === offerEv.offerId && a.dt > offerEv.dt) || null;
        if (!answerEv) reasons.push(`缺answer echo(offerId=${offerEv.offerId})；answer須原樣echo且answerOfferId相同`);
        else seqOk = true;
      }
    }
    if (pauseEv && completeEv && MODE === 'jpeg') {
      const fresh = wsEvents.find((e) => e.kind === 'binary' && e.dt >= completeEv.dt);
      seqOk = Boolean(fresh && completeEv.viewerId === viewerId && completeEv.transport === 'jpeg');
      if (!seqOk) reasons.push('JPEG缺同viewer complete後fresh binary');
    }
    // 新peer恢復兩遞增frames（恢復後兩時間點比較，不拿舊counter）
    let recOk = false, recDetail = '';
    const anchor = answerEv || offerEv || completeEv;
    if (anchor) {
      const post = samples.filter((s) => s.dt > anchor.dt);
      if (MODE === 'webrtc') {
        const seq = post.filter((s) => s.frames >= 0 && s.w > 0 && s.readyState >= 2);
        let inc = 0;
        for (let i = 1; i < seq.length; i++) if (seq[i].frames > seq[i - 1].frames) inc++;
        recOk = seqOk && seq.length >= 2 && inc >= 1;
        recDetail = `postSamples=${seq.length} inc=${inc} base=${seq.length ? seq[0].frames : 'na'}(恢復後基線，不比暫停前累計)`;
        if (!recOk) reasons.push(`恢復後無兩遞增frames(${recDetail})；新peer counter可歸零，只比恢復後遞增`);
      } else {
        const binPost = wsEvents.filter((e) => e.dt > anchor.dt && e.kind === 'binary');
        const imgPost = post.filter((s) => s.jpegW > 0);
        const uniq = [...new Set(imgPost.map((s) => s.jpegSrcHash))];
        recOk = seqOk && binPost.length >= 2 && uniq.length >= 2;
        recDetail = `binPost=${binPost.length} uniqSrc=${uniq.length}`;
        if (!recOk) reasons.push(`恢復後無兩張不同JPEG(${recDetail})；不能只查naturalWidth>0或舊src`);
      }
      // 恢復後截圖（PM目視）
      try {
        if (recOk && !shotPost) {
          const p = path.join(EVIDENCE_DIR, 'm8-mask-post.png');
          await region.screenshot({ path: p }).catch(async () => { await page.screenshot({ path: p, fullPage: false }); });
          shotPost = p;
        }
      } catch {}
    }
    // fallback：webrtc要求webrtc傳輸＋video恢復；退jpeg另記，不算WebRTC PASS
    let fallback = null;
    try {
      const transports = [...new Set(wsEvents.filter((e) => e.transport).map((e) => e.transport))];
      if (MODE === 'webrtc' && transports.includes('jpeg')) fallback = `出現jpeg傳輸(${transports.join(',')})；若video未恢復而jpeg恢復，僅記備援，不算WebRTC PASS`;
    } catch {}
    const verdict = (pauseEv && completeEv && preOk && coreOk && seqOk && recOk && reasons.length === 0) ? 'pass' : 'unverified';
    const reason = verdict === 'pass' ? '' : reasons.join('；') || '未捕捉到敏感階段真影格；需PM獨立慢fixture/延遲鉤＋echo span＋時間戳端點，不判PASS';
    // 補拍缺失階段圖（PM目視至少三張；缺圖亦未驗）
    try { if (!shotPre) { const p = path.join(EVIDENCE_DIR, 'm8-mask-pre.png'); await page.screenshot({ path: p, fullPage: false }).catch(() => {}); if (fs.existsSync(p)) shotPre = p; } } catch {}
    try { if (!shotCore) { const p = path.join(EVIDENCE_DIR, 'm8-mask-core.png'); await page.screenshot({ path: p, fullPage: false }).catch(() => {}); if (fs.existsSync(p)) shotCore = p; } } catch {}
    try { if (!shotPost) { const p = path.join(EVIDENCE_DIR, 'm8-mask-post.png'); await page.screenshot({ path: p, fullPage: false }).catch(() => {}); if (fs.existsSync(p) && verdict === 'pass') shotPost = p; } } catch {}
    const summary = {
      model: 'opencode-go/muse-spark-1.3-contributor#xhigh', modelChecked: 'active/variants含xhigh',
      providerNote: '明示fixture，非真AI；只驗遮蔽/恢復，不作AI探索',
      workspaceId: WORKSPACE_ID, testId: ensured.testId, testName: TEST_NAME, runId, roleId: ensured.roleId,
      loginUrl: SLOW_LOGIN_URL, mode: MODE, jpegToggled, joinMid: JOIN_DURING_SENSITIVE, midJoin, midJoinVerdict,
      tValidateMs: tWatch - tClick, samples: samples.length, wsEvents: wsEvents.length,
      viewerId, pauseAt: pauseEv ? pauseEv.dt : null, completeAt: completeEv ? completeEv.dt : null,
      offerId: offerEv ? offerEv.offerId : null, offerAt: offerEv ? offerEv.dt : null,
      answerOfferId: answerEv ? answerEv.answerOfferId : null, answerAt: answerEv ? answerEv.dt : null,
      sdpHashes: wsEvents.filter((e) => e.sdpHash).map((e) => ({ dt: e.dt, dir: e.dir, h: e.sdpHash })),
      preOk, preDetail, coreOk, coreDetail, seqOk, recOk, recDetail, fallback,
      observations: { samples, wsEvents },
      sentinelLeakBool: leakState.checked ? leakState.leaked : 'skipped(無WHIPPET_MASK_SENTINEL；僅PM像素目視，不掃壓縮bytes)',
      needPm: ['合成echo span刺激', '時間戳端點(POST到達/response放行)', '三階段截圖PM目視(遮罩＋非機密區可讀)', 'offerId/viewerId公開順序(t31)'],
      shots: { pre: shotPre, core: shotCore, post: shotPost, pmVisual: 'pending－需PM目視確認遮罩與非機密區可讀，不以DOM regex/壓縮bytes冒稱' },
      earlyStatus: samples.slice(0, 5).map((s) => ({ dt: s.dt, st: s.statusText, f: s.frames, jw: s.jpegW, rs: s.runStatus })),
      verdict, reason: reason.slice(0, 1000),
      evidenceDir: EVIDENCE_DIR,
    };
    try { await page.screenshot({ path: path.join(EVIDENCE_DIR, 'm8-login-live.png'), fullPage: true }); } catch {}
    fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log(`DONE verdict=${verdict} run=${runId} mode=${MODE} samples=${samples.length} ws=${wsEvents.length} ${reason}`.slice(0, 1000));
    if (fallback) console.log(`NOTE ${fallback}`);
    if (verdict !== 'pass') { console.log('UNVERIFIED: 嚴格條件未全滿足，不判遮蔽PASS（缺事件/窗口不足/順序錯，詳result.json，需PM補echo span＋時間戳端點）'); return; }
  } catch (e) {
    try {
      if (page) {
        let headings = [], buttons = [];
        try { headings = (await page.getByRole('heading').allTextContents()).map((s) => (s || '').trim().slice(0, 80)).slice(0, 40); } catch {}
        try { buttons = (await page.getByRole('button').allTextContents()).map((s) => (s || '').trim().slice(0, 80)).slice(0, 60); } catch {}
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'm8-login-live-diag.json'), JSON.stringify({ error: String((e && e.message) || e).slice(0, 500), url: page.url(), tMs: Date.now() - t0, headings, buttons }, null, 2) + '\n');
      }
    } catch {}
    try { if (page) await page.screenshot({ path: path.join(EVIDENCE_DIR, 'm8-login-live-fail.png'), fullPage: true }); } catch {}
    console.error(`FAIL: ${(e && e.message) || e}`);
    process.exitCode = 1;
    throw e;
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(`FAIL: ${(e && e.message) || e}`); process.exit(process.exitCode || 1); });
