#!/usr/bin/env node
// M8 Workspace author 真影格黑箱（parent=t3v，全新黑箱QA）。
// 真AI主流程探索/產稿/驗證/摘要/UI發布/正式Run已PASS不重跑；manual LiveView已PASS不重跑。
// 僅驗：Workspace author監看入口＋真影格（testId=null）。真UI登入→選Workspace 95296031→Workspace設定對話；
// PM就緒時從公開API啟動真AI探索slow-login（同既有origin/role），本腳本亦可公開API POST workspace messages啟動且不改proposal/credentials，只一筆。
// 內容：真瀏覽工具開slow-login，等按鈕可用再以既有驗收角色登入並觀察Completed回覆實際觀察，不改設定範圍。
// listener在click前掛，API排程後經真UI重讀active Run；從設定頁監看當前Workspace author，驗ready.viewerId＋WebRTC兩取樣遞增；
// 敏感pause/complete能觀測則記，否則記未觀測不假裝。Run succeeded、testId=null、authorMode=workspace。
// 不自行執行，交PM容器跑。只讀公開UI/API、既有QA腳本、contracts/mvp-v8.md；不讀產品源碼/DB/journal/.env.ai/真憑證。
// 參照m8-workspace-ui.cjs與m8-login-live-ui.cjs定位；現有Playwright模組；WEB_URL=http://127.0.0.1。不安裝/部署/Git/子agent。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const WS_ID = '95296031-b243-4bb6-b964-e90dd8af4bb5';
const SLOW_URL = 'http://host.docker.internal:18187/slow-login';
const MSG = '只做三步探索並立即回覆，不產生新proposal、不修改設定：1 browser_navigate開啟http://host.docker.internal:18187/slow-login；2 使用browser_login既有驗收角色與#username、#password、button[type=submit]登入（工具會等待按鈕，不要用多次snapshot輪詢）；3 browser_snapshot一次確認Authenticated與alpha後立即回覆，不等待Completed，不繼續工具迴圈。';
const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1').replace(/\/$/, '');
for (const bad of ['18080', '18085', '18086']) if (WEB_URL.includes(bad)) throw new Error(`拒跑舊環境 ${bad}`);
const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/@playwright/test';
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-workspace-live-evidence';
fs.mkdirSync(EV_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const pw = require(PW_MODULE);
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  let page = null;
  const wsEvents = [];
  const mutBad = [];
  try {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('request', (r) => {
      try {
        if (!r.url().startsWith(WEB_URL)) return;
        const p = new URL(r.url(), page.url()).pathname;
        const m = r.method();
        if (['PUT', 'PATCH', 'DELETE'].includes(m)) mutBad.push(`${m} ${p}`);
        else if (m === 'POST' && p !== '/api/dev-login' && !/\/api\/workspaces\/.+\/messages$/.test(p)) mutBad.push(`POST ${p}`);
      } catch {}
    });
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await loginBtn.count() !== 1) throw new Error('FAIL 登入按鈕非唯一');
    await loginBtn.click();
    const combo = page.getByRole('combobox', { name: 'Workspace' }).first();
    await combo.waitFor({ state: 'visible', timeout: 30000 });
    if (await combo.evaluate((el) => el.tagName) === 'SELECT') await combo.selectOption(WS_ID, { timeout: 30000 });
    else { await combo.click(); await sleep(800); await page.getByRole('option').first().click(); throw new Error('FAIL Workspace非SELECT，需PM確認公開bundle'); }
    console.log('PASS login+workspace');
    const setBtn = page.getByRole('button', { name: 'Workspace 設定', exact: true });
    if (await setBtn.count() !== 1) throw new Error('FAIL Workspace設定非唯一');
    await setBtn.first().click();
    await page.getByRole('heading', { name: 'Workspace 設定對話' }).first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('list', { name: '已儲存的 Workspace 訊息' }).first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Workspace 需求或修改訊息' }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS settings-dialog');
    await page.screenshot({ path: path.join(EV_DIR, 'm8-author-01-settings.png'), fullPage: true }).catch(() => {});
    // 經真UI(fetch同源同登入態)重讀active Run；無運行中author則只POST一筆啟動，不改proposal/credentials。
    const ensured = await page.evaluate(async ({ wid, msg }) => {
      const j = async (m, p, b) => {
        const r = await fetch(p, { method: m, headers: b ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = null; }
        if (!r.ok) throw new Error(`${m} ${p} HTTP=${r.status} ${t.slice(0, 200)}`);
        return d;
      };
      const w0 = await j('GET', `/api/workspaces/${wid}`);
      const w = (w0 && w0.workspace) || w0;
      const rev = w.revision; let ctxRev = w.contextRevision;
      try { const c = await j('GET', `/api/workspaces/${wid}/conversation`); const cc = (c && c.conversation) || c; if (cc && cc.contextRevision !== undefined) ctxRev = cc.contextRevision; } catch {}
      const chk = async (id) => {
        if (!id) return null;
        try { const r = await j('GET', `/api/runs/${id}`); return (r && r.run) || r; } catch { return null; }
      };
      let run = await chk(w.activeRunId);
      let reused = false;
      if (run && (run.status === 'running' || run.status === 'queued' || run.status === 'waiting') && run.testId === null && (run.authorMode === 'workspace' || run.kind === 'author')) reused = true;
      else {
        const body = { content: msg, revision: rev, contextRevision: ctxRev };
        const p = await j('POST', `/api/workspaces/${wid}/messages`, body);
        const rr = (p && p.run) || p;
        const rid = (rr && rr.id) || p.runId || p.id;
        if (!rid) throw new Error('POST messages缺runId');
        run = await chk(rid); reused = false;
        if (!run) run = { id: rid };
      }
      const w1 = await j('GET', `/api/workspaces/${wid}`);
      const ww = (w1 && w1.workspace) || w1;
      return { runId: run.id, activeRunId: ww.activeRunId, testId: run.testId ?? null, authorMode: run.authorMode || null, kind: run.kind || null, workspaceId: run.workspaceId || null, status0: run.status || '', reused };
    }, { wid: WS_ID, msg: MSG });
    console.log(`run=${ensured.runId} reused=${ensured.reused} active=${ensured.activeRunId}`);
    if (ensured.activeRunId && ensured.activeRunId !== ensured.runId) throw new Error(`FAIL activeRun非本次Run active=${ensured.activeRunId} run=${ensured.runId}`);
    const runId = ensured.runId;
    // listener在click前掛：只收當前Run live WS白名單欄位，不存SDP/binary。
    let tWatch0 = Date.now();
    page.on('websocket', (ws) => {
      try {
        const u = ws.url();
        if (!u.includes('/api/runs/') || !u.includes('/live') || !u.includes(runId)) return;
        const pick = (raw) => {
          if (typeof raw !== 'string') return;
          let o = null; try { o = JSON.parse(raw); } catch { return; }
          if (!o || typeof o !== 'object') return;
          const e = { dt: Date.now() - tWatch0 };
          for (const k of ['type', 'state', 'reason', 'viewerId', 'transport', 'offerId']) if (typeof o[k] === 'string') e[k] = o[k].slice(0, 64);
          if (o.offer && typeof o.offer.id === 'string') e.offerId = o.offer.id.slice(0, 64);
          wsEvents.push(e);
        };
        ws.on('framereceived', (x) => { try { pick(typeof x === 'string' ? x : x && x.payload); } catch {} });
        ws.on('framesent', (x) => { try { pick(typeof x === 'string' ? x : x && x.payload); } catch {} });
      } catch {}
    });
    // 從設定頁監看當前Workspace author。
    await page.getByRole('button', { name: '重新載入設定對話', exact: true }).click();
    await page.getByRole('button', { name: `開始監看 Workspace Run ${runId}`, exact: true }).first().waitFor({state:'visible',timeout:30000});
    const watchBtns = page.getByRole('button', { name: `開始監看 Workspace Run ${runId}`, exact: true });
    if (await watchBtns.count() < 1) throw new Error('FAIL 設定頁缺開始監看（Workspace author監看入口未驗）');
    tWatch0 = Date.now();
    await watchBtns.first().click();
    const region = page.getByRole('region', { name: '唯讀監看' });
    await region.first().waitFor({ state: 'visible', timeout: 30000 });
    await region.first().getByText(runId, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log(`PASS live-run ${runId}`);
    await page.getByRole('status', { name: '監看連線狀態' }).first().waitFor({ state: 'visible', timeout: 30000 });
    const readMedia = () => {
      const v=document.querySelector('video[data-testid="live-video"]');
      if(v&&v.videoWidth>0&&v.readyState>=2)return {transport:'webrtc',value:v.getVideoPlaybackQuality().totalVideoFrames,w:v.videoWidth};
      const im=document.querySelector('img[data-testid="live-jpeg"],img[alt="JPEG 備援唯讀監看畫面"]');
      if(im&&im.complete&&im.naturalWidth>0)return {transport:'jpeg',value:im.currentSrc||im.src,w:im.naturalWidth};
      return null;
    };
    let first=null,second=null;
    for(let i=0;i<180;i++){
      const m=await page.evaluate(readMedia);
      if(m&&!first)first=m;
      else if(m&&first&&m.transport===first.transport&&m.value!==first.value){second=m;break;}
      await sleep(500);
    }
    if(!first||!second)throw new Error('No two changing decoded media samples');
    const f0=first.transport==='webrtc'?first.value:null;
    const f1={f:second.transport==='webrtc'?second.value:null,w:second.w};
    console.log('PASS '+second.transport+' two decoded changing samples width='+second.w);
    await region.screenshot({path:path.join(EV_DIR,'m8-author-02-live.png')});
    const readyEv = wsEvents.find((e) => e.type === 'ready' && e.viewerId);
    const viewerId = readyEv ? readyEv.viewerId : null;
    if (!viewerId) throw new Error(`FAIL 缺ready.viewerId（ws=${wsEvents.length}，不判PASS）`);
    console.log(`PASS ready.viewerId=${viewerId}`);
    let pauseEv = wsEvents.find((e) => e.type === 'state' && e.state === 'waiting' && e.reason === 'sensitive_input') || null;
    let compEv = wsEvents.find((e) => e.type === 'state' && e.reason === 'sensitive_input_complete') || null;
    console.log(`observe pause=${pauseEv ? pauseEv.dt : 'none'} complete=${compEv ? compEv.dt : 'none'}（有則記，無不假裝）`);
    // poll至succeeded，驗testId=null/authorMode=workspace。
    let run = null;
    const tS = Date.now();
    for (;;) {
      if (Date.now() - tS > 600 * 1000) throw new Error('FAIL Run等待逾時');
      const paused=await region.getByText('敏感輸入暫停',{exact:true}).count();
      if(paused)await region.screenshot({path:path.join(EV_DIR,'sensitive-paused.png')});
      const resumed=wsEvents.some(e=>e.reason==='sensitive_input_complete');
      if(resumed&&await page.evaluate(readMedia))await region.screenshot({path:path.join(EV_DIR,'sensitive-resumed.png')});
      await sleep(1000);
      const g = await page.evaluate(async (id) => {
        const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
        const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch {}
        return { http: r.status, body: (d && d.run) || d };
      }, runId);
      if (g.http !== 200) throw new Error(`FAIL GET run http=${g.http}`);
      run = g.body;
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status)) break;
    }
    if (run.status !== 'succeeded') throw new Error(`FAIL Run終態非succeeded: ${run.status}`);
    if (run.testId !== null) throw new Error(`FAIL testId非null: ${run.testId}`);
    if (run.authorMode !== 'workspace') throw new Error(`FAIL authorMode非workspace: ${run.authorMode}`);
    if (run.workspaceId !== WS_ID) throw new Error('FAIL workspaceId不符');
    if (mutBad.length) throw new Error(`FAIL 違規寫入 ${mutBad[0]}`);
    pauseEv = wsEvents.find(e=>e.reason==='sensitive_input')||null;
    compEv = wsEvents.find(e=>e.reason==='sensitive_input_complete')||null;
    fs.writeFileSync(path.join(EV_DIR,'ws-events.json'),JSON.stringify(wsEvents,null,2));
    const summary = { pass: true, verdict: 'pass', workspaceId: WS_ID, runId, testId: run.testId, authorMode: run.authorMode, kind: run.kind || null, status: run.status, reused: ensured.reused, viewerId, observedTransport: second.transport, twoDecodedChangingSamples:true, framesBefore: f0, framesAfter: f1.f, videoW: f1.w, wsEvents: wsEvents.length, pauseAt: pauseEv ? pauseEv.dt : null, completeAt: compEv ? compEv.dt : null, sensitiveObserved: Boolean(pauseEv && compEv), slowLogin: SLOW_URL, evidenceDir: EV_DIR };
    fs.writeFileSync(path.join(EV_DIR, 'm8-workspace-author-live-result.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`DONE pass run=${runId} viewer=${viewerId} frames=${f0}->${f1.f} pause=${summary.pauseAt} complete=${summary.completeAt}`);
  } catch (e) {
    try {
      const diag = { error: String((e && e.message) || e).slice(0, 500), url: page ? page.url() : '', wsEvents: wsEvents.slice(0, 50) };
      fs.writeFileSync(path.join(EV_DIR, 'm8-workspace-author-live-diag.json'), JSON.stringify(diag, null, 2) + '\n');
    } catch {}
    try { if (page) await page.screenshot({ path: path.join(EV_DIR, 'm8-workspace-author-live-fail.png'), fullPage: true }); } catch {}
    console.error(`FAIL: ${(e && e.message) || e}`);
    process.exitCode = 1;
    throw e;
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(`FAIL: ${(e && e.message) || e}`); process.exit(process.exitCode || 1); });
