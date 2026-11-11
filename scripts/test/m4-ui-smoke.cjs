#!/usr/bin/env node
// M4 UI 黑箱（真瀏覽器 WebRTC/JPEG 驗收）：不讀 repo，不重試 POST，不重建 run。
// 登入→搜尋→選測→驗證取 runId→開始監看→WebRTC 真影格→截圖→JPEG 備援→截圖→停止→poll succeeded→寫 summary。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/playwright';
const WEB_URL = (process.env.WEB_URL || 'http://host.docker.internal:18080').replace(/\/$/, '');
const TEST_NAME = 'M4 驗收｜即時監看';
const EVIDENCE_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/tmp';
const RESULT_PATH = '/tmp/whippet-m4-ui-result.json';
const RUN_POLL_MS = 90 * 1000;
const POLL_GAP_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);
  const failShot = path.join(EVIDENCE_DIR, 'm4-fail.png');
  let page = null;
  try {
    const context = await browser.newContext();
    page = await context.newPage();

    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    await page.getByRole('heading', { name: '測試' }).first().waitFor({ state: 'visible', timeout: 30000 });

    const search = page.getByRole('searchbox', { name: '搜尋測試' }).first();
    await search.waitFor({ state: 'visible', timeout: 30000 });
    await search.fill(TEST_NAME);
    const listRegion = page.getByRole('complementary', { name: 'Workspace 測試列表' }).first();
    await listRegion.waitFor({ state: 'visible', timeout: 30000 });
    const esc = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const testBtn = listRegion.getByRole('button', { name: new RegExp('^' + esc) });
    await testBtn.first().waitFor({ state: 'visible', timeout: 30000 });
    await testBtn.first().click();
    await page.getByRole('region', { name: '測試詳情' }).first().waitFor({ state: 'visible', timeout: 30000 });

    // 驗證一次，不重試
    const validateBtn = page.getByRole('button', { name: '驗證此 revision', exact: true });
    await validateBtn.waitFor({ state: 'visible', timeout: 30000 });
    const respP = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/tests\/.+\/draft\/validate$/.test(new URL(r.url(), page.url()).pathname),
      { timeout: 30000 },
    );
    await validateBtn.click();
    const resp = await respP;
    if (resp.status() !== 202) throw new Error(`validate HTTP=${resp.status()}`);
    const vj = await resp.json();
    const runId = vj && vj.id;
    if (!runId) throw new Error('validate 回應缺 runId');
    console.log(`runId=${runId}`);

    // 開始監看（history 的「開始監看 Run UUID」不會精確匹配）
    const watchBtn = page.getByRole('button', { name: '開始監看', exact: true });
    await watchBtn.waitFor({ state: 'visible', timeout: 30000 });
    await watchBtn.click();

    const region = page.getByRole('region', { name: '唯讀監看' });
    await region.waitFor({ state: 'visible', timeout: 30000 });
    const connStatus = page.getByRole('status', { name: '監看連線狀態' });
    await connStatus.waitFor({ state: 'visible', timeout: 30000 });
    await expectText(page, connStatus, /監看中：WebRTC/, 30000);

    // 真 video：readyState/videoWidth/srcObject live track/幀數遞增
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
    console.log(`webrtc frames ${v0.frames}->${v1.frames}`);

    const webrtcShot = path.join(EVIDENCE_DIR, 'm4-webrtc.png');
    await page.screenshot({ path: webrtcShot, fullPage: true });
    console.log(`shot ${webrtcShot}`);

    // JPEG 備援
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
    const j0 = await jpegImg.evaluate((el) => ({ w: el.naturalWidth || 0, src: el.currentSrc || el.src || '' }));
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
    await expectText(page, connStatus, /監看中：JPEG 備援/, 30000);
    const jpegShot = path.join(EVIDENCE_DIR, 'm4-jpeg.png');
    await page.screenshot({ path: jpegShot, fullPage: true });
    console.log(`shot ${jpegShot}`);

    // 停止監看
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

    // 同源 poll run 至 succeeded（黑箱查狀態），90 秒內
    const tStart = Date.now();
    let run = null;
    for (;;) {
      if (Date.now() - tStart > RUN_POLL_MS) throw new Error(`run 等待超時 id=${runId}`);
      await sleep(POLL_GAP_MS);
      const fr = await page.evaluate(async (id) => {
        const r = await fetch(`/api/runs/${id}`, { headers: { Accept: 'application/json' } });
        return { http: r.status, body: (await r.text()).slice(0, 2000) };
      }, runId);
      if (fr.http !== 200) throw new Error(`GET run HTTP=${fr.http}`);
      const j = JSON.parse(fr.body);
      run = j.run || j;
      console.log(`poll status=${run.status}`);
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status)) break;
    }
    if (run.status !== 'succeeded') throw new Error(`run 終態非 succeeded: ${run.status}`);
    if (!run.reportUrl) throw new Error('缺 reportUrl');

    const summary = {
      runId, framesBefore: v0.frames, framesAfter: v1.frames,
      webrtc: true, jpeg: true, status: run.status, reportUrl: run.reportUrl,
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log(`DONE ${JSON.stringify(summary)}`);
  } catch (e) {
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
  if (!_pwExpect) {
    const testMod = path.join(path.dirname(PW_MODULE), '@playwright', 'test');
    _pwExpect = require(testMod).expect;
  }
  return _pwExpect;
}

async function expectText(page, locator, re, timeout) {
  await getExpect()(locator).toContainText(re, { timeout });
}

main().catch((e) => {
  console.error(`FAIL: ${(e && e.message) || e}`);
  process.exit(process.exitCode || 1);
});
