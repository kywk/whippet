#!/usr/bin/env node
// M8 黑箱 Live 驗收（真瀏覽器 WebRTC/JPEG）：不讀 repo source，不重試 POST，不重建 run。
// - 模型: opencode-go/muse-spark-1.3-contributor#xhigh 已確認有效（models tool: status=active, variants含xhigh）
// - Provider 是明示 fixture，非真 AI；本腳本只用 manualExecution，不碰 credential，不改 Workspace 範圍。
// - Workspace: 2f8aa581-c593-4e89-bc8a-a70641929a77（既有，不新建 Workspace）
// - 獨立 Test: m8-qa-live（不存在則建立，不碰其他 Test）
// - 合成站: http://host.docker.internal:18190/progress（PM 提供，取代18187；主機 localhost:18190）
//   頁面 role=status 初值 Running，#progress 每秒更新＋底色切換，30秒後 Completed。
//   spec 用 expect(getByRole(status)).toHaveText(Completed,{timeout:45000})，不用 sleep。
// - 流程: 真UI登入→選Workspace→選Test→進測試編輯模式→PUT/no-op前置→真UI點「驗證此 revision」＋waitForResponse取新Run→點最近編輯結果開始監看→斷言live面板Run id→WebRTC真影格→JPEG備援→停止監看不取消Run→poll succeeded寫summary。舊run作廢不算live，全程單次排Run、單一路徑。
// 用法（PM t36 在有 Docker/Node 處跑）：
//   容器內: WEB_URL=http://host.docker.internal:18087 WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m8-live-evidence node scripts/test/m8-live-ui.cjs
//   主機直跑: WEB_URL=http://localhost:18087 WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m8-live-evidence node scripts/test/m8-live-ui.cjs
//   worker 容器已有: /opt/whippet/worker/node_modules/@playwright/test + Chromium（WHIPPET_PLAYWRIGHT_MODULE 可覆寫）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_ID = '2f8aa581-c593-4e89-bc8a-a70641929a77';
const TEST_NAME = 'm8-qa-live';
const TEST_DESC = 'M8 live progress 18190 manual (black-box, no credential)';
const PROGRESS_SPEC_URL = 'http://host.docker.internal:18190/progress';
const WEB_URL = (process.env.WEB_URL || 'http://host.docker.internal:18087').replace(/\/$/, '');
const EVIDENCE_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m8-live-evidence';
const RESULT_PATH = path.join(EVIDENCE_DIR, 'm8-live-result.json');
const RUN_POLL_MS = 120 * 1000;
const POLL_GAP_MS = 2000;

const MANUAL_SCRIPT = `import { test, expect } from '@playwright/test';
test('m8 live progress', async ({ page }) => {
  await page.goto('${PROGRESS_SPEC_URL}');
  await expect(page.getByRole('status')).toHaveText('Completed', { timeout: 45000 });
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const candidates = [
    process.env.WHIPPET_PLAYWRIGHT_MODULE,
    '/opt/whippet/worker/node_modules/playwright',
    '/opt/whippet/worker/node_modules/@playwright/test',
    'playwright',
    '@playwright/test',
  ].filter(Boolean);
  let lastErr = null;
  for (const m of candidates) {
    try {
      const mod = require(m);
      if (mod && mod.chromium) return { mod, where: m };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`找不到 Playwright（試過 ${candidates.join(', ')}）: ${lastErr && lastErr.message}`);
}

function loadExpect() {
  const candidates = [
    '/opt/whippet/worker/node_modules/@playwright/test',
    '@playwright/test',
  ];
  if (process.env.WHIPPET_PLAYWRIGHT_MODULE) {
    try {
      const dir = path.dirname(process.env.WHIPPET_PLAYWRIGHT_MODULE);
      candidates.unshift(path.join(dir, '@playwright', 'test'));
      candidates.unshift(process.env.WHIPPET_PLAYWRIGHT_MODULE);
    } catch {}
  }
  for (const m of candidates) {
    try {
      const mod = require(m);
      if (mod && mod.expect) return mod.expect;
    } catch {}
  }
  throw new Error('找不到 @playwright/test expect');
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const { mod: pw } = loadPlaywright();
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);
  const failShot = path.join(EVIDENCE_DIR, 'm8-fail.png');
  let page = null;
  try {
    const context = await browser.newContext();
    page = await context.newPage();

    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    // 真已登入斷言：aside Workspace 測試列表（不是模糊 heading「測試」，登入頁 h1「讓測試開始跑。」會誤吃）
    const listRegionEarly = page.getByRole('complementary', { name: 'Workspace 測試列表' });
    await listRegionEarly.first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('heading', { name: '測試', exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log(`web-ok ${WEB_URL} workspace=${WORKSPACE_ID}`);

    // 階段 A（不產生 Run）：只確保獨立 Test + editing-session 存在，供 UI 選定；不 PUT draft、不 validate
    const ensured = await page.evaluate(async ({ wid, name, desc }) => {
      const j = async (method, p, body) => {
        const r = await fetch(p, {
          method,
          headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 2000) }; }
        if (!r.ok) throw new Error(`${method} ${p} HTTP=${r.status} ${text.slice(0, 500)}`);
        return data;
      };
      const ws = await j('GET', `/api/workspaces/${wid}`);
      const caps = (ws && ws.capabilities) || {};
      const manualOk = ws.manualExecution ?? caps.manualExecution?.available ?? true;
      const list = await j('GET', `/api/workspaces/${wid}/tests`);
      const items = (list && list.items) || [];
      let test = items.find((t) => t.name === name) || null;
      if (!test) test = await j('POST', `/api/workspaces/${wid}/tests`, { name, description: desc });
      if (!test.id) throw new Error('test 缺 id');
      let sessResp = await j('GET', `/api/tests/${test.id}/editing-session`);
      let session = sessResp && sessResp.session ? sessResp.session : null;
      if (!session) session = (await j('POST', `/api/tests/${test.id}/editing-session`, {})).session;
      if (!session || !session.id) throw new Error('editing-session 缺 id');
      return { testId: test.id, editingSessionId: session.id, manualOk: !!manualOk };
    }, { wid: WORKSPACE_ID, name: TEST_NAME, desc: TEST_DESC });
    if (!ensured.manualOk) throw new Error('manualExecution 未就緒，不繼續');
    console.log(`ensure testId=${ensured.testId}`);

    // 真UI選定正確 Workspace/Test（不 reload：reload 會掉登入態；用 Workspace 下拉＋重選取得新 Test）
    const wsSelect = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await wsSelect.waitFor({ state: 'visible', timeout: 30000 });
    await wsSelect.selectOption(WORKSPACE_ID, { timeout: 30000 });
    console.log(`ui-workspace-ok ${WORKSPACE_ID}`);

    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await search.waitFor({ state: 'visible', timeout: 30000 });
    await search.fill(TEST_NAME);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    await listRegion.waitFor({ state: 'visible', timeout: 30000 });
    const esc = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const testBtn = listRegion.getByRole('button', { name: new RegExp('^' + esc) });
    // 若剛建立的 Test 尚未出現在列表，用「重新載入」重取（不 reload，不掉登入；不新建多餘 Test）
    try {
      await testBtn.first().waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      const reloadBtn = listRegion.getByRole('button', { name: '重新載入', exact: true });
      await reloadBtn.waitFor({ state: 'visible', timeout: 30000 });
      await reloadBtn.click();
      await testBtn.first().waitFor({ state: 'visible', timeout: 30000 });
    }
    await testBtn.first().click();
    await page.getByRole('region', { name: '測試詳情' }).first().waitFor({ state: 'visible', timeout: 30000 });
    const testId = ensured.testId;
    console.log(`ui-test-ok ${testId}`);

    // 先真UI進「測試編輯模式」：一般模式只列正式Run，validation歷史只在編輯側。不以API暗建session假設UI已進編輯。
    const detailRegion = page.getByRole('region', { name: '測試詳情' }).first();
    const editBtn = detailRegion.getByRole('button', { name: /^(繼續修改|開啟編輯工作區|修改腳本)$/ }).first();
    await editBtn.waitFor({ state: 'visible', timeout: 30000 });
    await editBtn.click();
    const editingRegion = page.getByRole('region', { name: '測試編輯模式' });
    await editingRegion.first().waitFor({ state: 'visible', timeout: 30000 });
    // 斷言「AI 與草稿驗證紀錄」所在處已就位（編輯側歷史標題，含筆數如「AI 與草稿驗證紀錄 3」），再單次排Run
    const verifyHeading = editingRegion.getByRole('heading', { name: /^AI 與草稿驗證紀錄(?:\s+\d+)?$/ });
    await verifyHeading.first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('ui-editing-ok AI 與草稿驗證紀錄');

    // 階段 B（UI 就位後才排 Run，全程只排一次）：先同源 PUT/no-op 確保 draft 與 UI 同 revision（前置，不產生 Run），
    // 再真UI點「驗證此 revision」並 waitForResponse 擷取 Run ID（UI 按鈕觸發正常狀態更新，live 面板才知道新 Run）。
    // 前一版 prep 的 runId 已超時作廢，本次不沿用、不算 live；失敗不再重排，避免多餘 Run 耗盡 30 秒 fixture。
    const draftInfo = await page.evaluate(async ({ tid, script }) => {
      const j = async (method, p, body) => {
        const r = await fetch(p, {
          method,
          headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 2000) }; }
        if (!r.ok) throw new Error(`${method} ${p} HTTP=${r.status} ${text.slice(0, 500)}`);
        return data;
      };
      const sessResp = await j('GET', `/api/tests/${tid}/editing-session`);
      const session = sessResp && sessResp.session ? sessResp.session : null;
      if (!session || !session.id) throw new Error('editing-session 缺 id（UI 就位後重取失敗）');
      const sid = session.id;
      const curRev = session.draft && typeof session.draft.revision === 'number' ? session.draft.revision : 1;
      const curScript = session.draft ? session.draft.script : '';
      if (curScript === script) return { editingSessionId: sid, revision: curRev, putDone: false };
      const saved = await j('PUT', `/api/tests/${tid}/draft`, { editingSessionId: sid, revision: curRev, script });
      if (!saved.revision) throw new Error('save draft 缺 revision');
      if (saved.scriptOrigin !== 'manual') throw new Error(`scriptOrigin 非 manual: ${saved.scriptOrigin}`);
      return { editingSessionId: sid, revision: saved.revision, putDone: true };
    }, { tid: testId, script: MANUAL_SCRIPT });
    console.log(`draft-ready rev=${draftInfo.revision} put=${draftInfo.putDone}`);
    const validateBtn = editingRegion.getByRole('button', { name: '驗證此 revision', exact: true });
    await validateBtn.waitFor({ state: 'visible', timeout: 30000 });
    await validateBtn.scrollIntoViewIfNeeded().catch(() => {});
    const respP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/draft\/validate$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 60000 },
    );
    await validateBtn.click();
    const resp = await respP;
    if (resp.status() !== 202) throw new Error(`validate HTTP=${resp.status()}`);
    const vj = await resp.json();
    const runId = vj && vj.id;
    if (!runId) throw new Error('validate 回應缺 runId');
    console.log(`new-run testId=${testId} runId=${runId} rev=${draftInfo.revision} (UI 按鈕真操作；舊 run 作廢不算 live)`);

    // 自有 Run viewer（單一路徑）：真UI validate 後 UI 狀態正常更新，新 Run 即為「最近編輯結果」的開始監看目標；
    // 點該按鈕後斷言 live 面板 Run id 即新 runId，不猜歷史列、不追別人的 Run、不占別人 viewer。斷言不符即 FAIL，不另尋按鈕。
    const latestSection = editingRegion.locator('section', { has: page.getByRole('heading', { name: /^最近編輯結果/ }) }).first();
    await latestSection.waitFor({ state: 'visible', timeout: 60000 });
    const latestWatch = latestSection.getByRole('button', { name: '開始監看', exact: true });
    await latestWatch.waitFor({ state: 'visible', timeout: 60000 });
    await latestWatch.click();

    const region = page.getByRole('region', { name: '唯讀監看' });
    await region.waitFor({ state: 'visible', timeout: 30000 });
    await region.getByText(runId, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log(`live-run-ok ${runId}`);
    const connStatus = page.getByRole('status', { name: '監看連線狀態' });
    await connStatus.waitFor({ state: 'visible', timeout: 30000 });
    await expectText(page, connStatus, /監看中：WebRTC/, 30000);

    // 真 video：尺寸/readyState/frames遞增
    const video = page.locator('video[data-testid="live-video"]');
    await video.waitFor({ state: 'visible', timeout: 30000 });
    const v0 = await page.evaluate(() => {
      const v = document.querySelector('video[data-testid="live-video"]');
      const s = v.srcObject;
      const tracks = s ? s.getVideoTracks() : [];
      let frames = 0;
      try { frames = v.getVideoPlaybackQuality().totalVideoFrames || 0; } catch {}
      return {
        readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
        hasStream: !!s, live: tracks.filter((t) => t.readyState === 'live' && t.enabled).length,
        frames,
      };
    });
    if (!(v0.readyState >= 2 && v0.w > 0 && v0.hasStream && v0.live > 0 && v0.frames > 0)) {
      throw new Error(`webrtc 初檢未過 ${JSON.stringify(v0)}`);
    }
    await page.waitForFunction((prev) => {
      const v = document.querySelector('video[data-testid="live-video"]');
      if (!v) return false;
      let f = 0;
      try { f = v.getVideoPlaybackQuality().totalVideoFrames || 0; } catch { return false; }
      return f > prev;
    }, v0.frames, { timeout: 30000 });
    const v1 = await page.evaluate(() => {
      const v = document.querySelector('video[data-testid="live-video"]');
      let f = 0;
      try { f = v.getVideoPlaybackQuality().totalVideoFrames || 0; } catch {}
      return { frames: f, w: v.videoWidth, readyState: v.readyState };
    });
    if (!(v1.frames > v0.frames && v1.w > 0 && v1.readyState >= 2)) {
      throw new Error(`webrtc 幀數未遞增 before=${v0.frames} after=${v1.frames}`);
    }
    console.log(`webrtc frames ${v0.frames}->${v1.frames} ${v1.w}x? readyState=${v1.readyState}`);

    const webrtcShot = path.join(EVIDENCE_DIR, 'm8-webrtc.png');
    await page.screenshot({ path: webrtcShot, fullPage: true });
    console.log(`shot ${webrtcShot}`);

    // JPEG 備援：真 img 解碼成功且更新
    const jpegBtn = page.getByRole('button', { name: '切換 JPEG 備援', exact: true });
    await jpegBtn.waitFor({ state: 'visible', timeout: 30000 });
    await jpegBtn.click();
    const jpegImg = page.getByRole('img', { name: 'JPEG 備援唯讀監看畫面' });
    await jpegImg.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('img[alt="JPEG 備援唯讀監看畫面"]');
      if (!el) return false;
      const src = el.currentSrc || el.src || '';
      return (el.naturalWidth || 0) > 0 && src.startsWith('blob:');
    }, null, { timeout: 30000 });
    const j0 = await jpegImg.evaluate((el) => ({ w: el.naturalWidth || 0, h: el.naturalHeight || 0, src: el.currentSrc || el.src || '' }));
    if (!(j0.w > 0 && j0.src.startsWith('blob:'))) throw new Error(`jpeg 初檢未過 w=${j0.w} src=${j0.src.slice(0, 32)}`);
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('img[alt="JPEG 備援唯讀監看畫面"]');
        if (!el) return false;
        const cur = el.currentSrc || el.src || '';
        return cur && cur !== prev && (el.naturalWidth || 0) > 0;
      },
      j0.src,
      { timeout: 30000 },
    );
    const j1 = await jpegImg.evaluate((el) => ({ w: el.naturalWidth || 0, src: el.currentSrc || el.src || '' }));
    console.log(`jpeg w=${j0.w}->${j1.w} updated=${j0.src !== j1.src}`);
    await expectText(page, connStatus, /監看中：JPEG 備援/, 30000);
    const jpegShot = path.join(EVIDENCE_DIR, 'm8-jpeg.png');
    await page.screenshot({ path: jpegShot, fullPage: true });
    console.log(`shot ${jpegShot}`);

    // 停止監看：必須不取消 Run
    const stopBtn = page.getByRole('button', { name: '停止監看', exact: true });
    await stopBtn.waitFor({ state: 'visible', timeout: 30000 });
    await stopBtn.click();
    await expectText(page, connStatus, /已停止監看/, 30000);
    const srcNull = await page.evaluate(() => {
      const v = document.querySelector('video[data-testid="live-video"]');
      return v ? v.srcObject === null : true;
    });
    if (!srcNull) throw new Error('停止後 video.srcObject 非 null');
    console.log(`STOPPED ${runId}`);

    const chkRaw = await page.evaluate(async (id) => {
      const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
      return { http: r.status, body: (await r.text()).slice(0, 2000) };
    }, runId);
    if (chkRaw.http !== 200) throw new Error(`GET run HTTP=${chkRaw.http}`);
    const chkRun = (JSON.parse(chkRaw.body).run) || JSON.parse(chkRaw.body);
    if (chkRun.status === 'cancelled') throw new Error('停止後 Run 已 cancelled');
    console.log(`stop-check status=${chkRun.status}`);

    // 同源 poll 至 succeeded（真結果）
    const tStart = Date.now();
    let run = null;
    for (;;) {
      if (Date.now() - tStart > RUN_POLL_MS) throw new Error(`run 等待超時 id=${runId}`);
      await sleep(POLL_GAP_MS);
      const fr = await page.evaluate(async (id) => {
        const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
        return { http: r.status, body: (await r.text()).slice(0, 4000) };
      }, runId);
      if (fr.http !== 200) throw new Error(`GET run HTTP=${fr.http}`);
      const jj = JSON.parse(fr.body);
      run = jj.run || jj;
      console.log(`poll status=${run.status}`);
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status)) break;
    }
    if (run.status !== 'succeeded') throw new Error(`run 終態非 succeeded: ${run.status}`);
    if (!run.reportUrl) throw new Error('缺 reportUrl');

    const summary = {
      model: 'opencode-go/muse-spark-1.3-contributor#xhigh',
      modelChecked: 'active/variants含xhigh',
      workspaceId: WORKSPACE_ID,
      testId, testName: TEST_NAME,
      runId, framesBefore: v0.frames, framesAfter: v1.frames,
      videoW: v1.w, jpegW: j1.w,
      webrtc: true, jpeg: true, status: run.status, reportUrl: run.reportUrl,
      progress: PROGRESS_SPEC_URL,
      evidenceDir: EVIDENCE_DIR,
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log(`DONE ${JSON.stringify(summary)}`);
  } catch (e) {
    // 失敗診斷（僅此無 credential Test：只收 heading/button 名稱與 aria 結構，不收 input 值、不碰密碼）
    try {
      if (page) {
        let snap = null;
        try { snap = await page.locator('main').ariaSnapshot({ timeout: 10000 }); }
        catch { try { snap = (await page.locator('body').ariaSnapshot({ timeout: 10000 })) || null; } catch { snap = null; } }
        let headings = [], buttons = [];
        try { headings = (await page.getByRole('heading').allTextContents()).map((s) => (s || '').trim().slice(0, 80)).slice(0, 60); } catch {}
        try { buttons = (await page.getByRole('button').allTextContents()).map((s) => (s || '').trim().slice(0, 80)).slice(0, 80); } catch {}
        const diag = { error: String((e && e.message) || e).slice(0, 500), url: page.url(), headings, buttons, ariaSnapshot: (snap || '').slice(0, 8000) };
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'm8-diag.json'), JSON.stringify(diag, null, 2) + '\n');
        console.log(`diag headings=${JSON.stringify(headings)}`);
        console.log(`diag buttons=${JSON.stringify(buttons)}`);
      }
    } catch {}
    try {
      if (page) await page.screenshot({ path: failShot, fullPage: true });
      console.log(`failshot ${failShot}`);
    } catch {}
    console.error(`FAIL: ${(e && e.stack) || e}`);
    process.exitCode = 1;
    throw e;
  } finally {
    await browser.close();
  }
}

let _pwExpect = null;
function getExpect() {
  if (!_pwExpect) _pwExpect = loadExpect();
  return _pwExpect;
}

async function expectText(page, locator, re, timeout) {
  await getExpect()(locator).toContainText(re, { timeout });
}

main().catch((e) => {
  console.error(`FAIL: ${(e && e.message) || e}`);
  process.exit(process.exitCode || 1);
});
