#!/usr/bin/env node
// One final case6 manual validation: prepare the actual UI before the one POST.
// Results contain only bounded metadata and decoded frame counts, never pixels,
// conversations, scripts, response bodies, arbitrary console output or secrets.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const ROOT = '/private/tmp/whippet-m10z-20261114';
const OUT = path.join(ROOT, 'even');
const API = 'https://127.0.0.1:19889';
const WEB = 'http://127.0.0.1:19887';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['queued', 'dispatched', 'running', 'collecting', 'cancelling']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const EXPECTED_IMAGE = 'sha256:4591e145a297601a88d2c524655c1e82396a75275dc46e1d989d86ceb8a6cc01';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function read(name) {
  const fd = fs.openSync(path.join(OUT, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 131072) throw Error('safe_input_invalid');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function write(name, value) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const ca = fs.readFileSync(path.join(ROOT, 'qa.crt'));
function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(API + route, {
      method, ca, timeout: 10000,
      headers: { Accept: 'application/json', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) },
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size <= 262144) chunks.push(chunk);
        else request.destroy(Error('response_limit'));
      });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ code: response.statusCode, json });
      });
    });
    request.on('timeout', () => request.destroy(Error('timeout')));
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}
function success(response, expected, label) {
  if (response.code !== expected) throw Error(label + '_HTTP_' + response.code);
  return response.json;
}
function safeRun(run) {
  if (!run || !UUID.test(run.id || '')) return null;
  return {
    id: run.id, status: run.status, kind: run.kind,
    editingSessionId: UUID.test(run.editingSessionId || '') ? run.editingSessionId : null,
    authorMode: run.authorMode || null, authorEngine: run.authorEngine || null,
  };
}
async function terminalRun(id) {
  for (let i = 0; i < 60; i++) {
    const run = success(await api('GET', '/api/runs/' + id), 200, 'run');
    if (TERMINAL.has(run.status)) return { status: run.status, reportReady: !!run.reportUrl, scriptOrigin: run.scriptOrigin || null };
    await sleep(1000);
  }
  return { status: 'poll_timeout', reportReady: false, scriptOrigin: null };
}
async function sampleFrames(page, limitMs) {
  return page.evaluate(async limit => {
    const video = document.querySelector('[data-testid="live-video"]');
    const image = document.querySelector('[data-testid="live-jpeg"]');
    let videoFrames = 0, jpegFrames = 0, previousImage = '';
    let continuing = true;
    if (video instanceof HTMLVideoElement && video.requestVideoFrameCallback) {
      const onFrame = () => {
        if (!continuing) return;
        if (!video.hidden && video.videoWidth > 0 && video.videoHeight > 0) videoFrames++;
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    const until = Date.now() + limit;
    while (Date.now() < until && Math.max(videoFrames, jpegFrames) < 2) {
      if (image instanceof HTMLImageElement && !image.hidden && image.src && image.src !== previousImage) {
        const candidate = image.src;
        try {
          await image.decode();
          if (image.src === candidate && image.naturalWidth > 0 && image.naturalHeight > 0) {
            previousImage = candidate;
            jpegFrames++;
          }
        } catch { /* A changed or incomplete frame is not counted. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    continuing = false;
    return { videoFrames, jpegFrames };
  }, limitMs);
}

async function main() {
  const state = read('case6-scope-state.json');
  const admission = JSON.parse(fs.readFileSync(path.join(ROOT, 'admission.json'), 'utf8'));
  if (state.phase !== 'LIVE_RECHECK_DONE' || state.manual?.recheckOutcome?.status !== 'succeeded') throw Error('case6_state_not_ready');
  if (!UUID.test(state.workspaceId) || !UUID.test(state.manual?.testId) || !UUID.test(state.manual?.sessionId)) throw Error('id_invalid');
  if (admission.leader !== 't6g' || admission.workerImage !== EXPECTED_IMAGE || admission.case2Runs !== true) throw Error('admission_invalid');
  if (fs.existsSync(path.join(OUT, 'case6-live-final-intent.json'))) throw Error('one_post_already_intended');
  const session = success(await api('GET', `/api/tests/${state.manual.testId}/editing-sessions/${state.manual.sessionId}`), 200, 'session').session;
  if (!session || session.id !== state.manual.sessionId || session.reclaimPending !== false || (session.pendingRunIds || []).length) throw Error('session_not_reclaimed');
  const test = success(await api('GET', `/api/tests/${state.manual.testId}`), 200, 'test');
  if (test.activeEditingSession?.id !== state.manual.sessionId) throw Error('active_session_mismatch');

  const { chromium } = require(path.join(__dirname, '../../runtimes/worker/node_modules/@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const result = {
    status: 'UNVERIFIED', layer: 'pre_post', testId: state.manual.testId, runId: null,
    uiReadyBeforePost: false, sameEditingSession: false, listContainsRun: false,
    activeApiObserved: false, uiHistoryRowObserved: false, uiWatchButtonObserved: false,
    uiViewerOpened: false, uiLiveStatusObserved: false, liveSocketObserved: false, decodedVideoFrames: 0,
    decodedJpegFrames: 0, statusAtViewerClose: null, browserClosedBeforeTerminalPoll: false,
    viewerCloseDidNotStopRun: false, terminal: null, noPixelsOrConversationSaved: true,
  };
  let phase = 'ui_prepare';
  let browserClosed = false;
  async function closeBrowser() {
    if (!browserClosed) { await browser.close(); browserClosed = true; }
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    let liveSockets = 0;
    page.on('websocket', socket => {
      if (result.runId && socket.url().endsWith(`/api/runs/${result.runId}/live`)) liveSockets++;
    });
    await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const login = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    if (await login.count()) await login.click();
    await page.getByRole('combobox', { name: 'Workspace' }).first().selectOption(state.workspaceId);
    const item = page.locator('.test-item').filter({ hasText: state.manual.intentName });
    await item.waitFor({ state: 'visible', timeout: 15000 });
    await item.click();
    await page.getByRole('tab', { name: '對話編輯' }).click();
    await page.getByRole('tab', { name: '紀錄與畫面' }).click();
    const editTab = page.getByRole('tab', { name: '對話編輯' });
    const runsTab = page.getByRole('tab', { name: '紀錄與畫面' });
    result.uiReadyBeforePost = await editTab.getAttribute('aria-selected') === 'true'
      && await runsTab.getAttribute('aria-selected') === 'true'
      && await page.locator('#side-panel-runs').isVisible();
    if (!result.uiReadyBeforePost) throw Error('ui_not_ready');
    write('case6-live-final-ready.json', { status: 'READY', testId: state.manual.testId, editingSessionId: state.manual.sessionId, uiEditingTabSelected: true, uiRunsPanelVisible: true });

    phase = 'post_once';
    write('case6-live-final-intent.json', { status: 'STARTED', testId: state.manual.testId, editingSessionId: state.manual.sessionId, revision: state.manual.revision, onePOSTOnly: true, fixedImage: EXPECTED_IMAGE });
    const started = success(await api('POST', `/api/tests/${state.manual.testId}/draft/validate`, {
      editingSessionId: state.manual.sessionId, revision: state.manual.revision,
    }), 202, 'validate');
    if (!UUID.test(started?.id)) throw Error('run_id_invalid');
    result.runId = started.id;
    write('case6-live-final-run.json', { runId: started.id, testId: state.manual.testId, editingSessionId: state.manual.sessionId, kind: 'validation' });

    phase = 'active_watch';
    const row = page.locator(`tr[data-run-id="${started.id}"]`);
    const watch = row.getByRole('button', { name: `開始監看 Run ${started.id}`, exact: true });
    const deadline = Date.now() + 18000;
    let lastRefresh = 0;
    while (Date.now() < deadline && !result.uiViewerOpened) {
      const [runResponse, listResponse] = await Promise.all([
        api('GET', `/api/runs/${started.id}`), api('GET', `/api/tests/${state.manual.testId}/runs`),
      ]);
      const run = safeRun(success(runResponse, 200, 'run'));
      const list = success(listResponse, 200, 'runs');
      const itemInList = (list.items || []).find(candidate => candidate.id === started.id);
      result.listContainsRun ||= !!itemInList;
      const matched = !!run && run.id === started.id && run.kind === 'validation'
        && run.editingSessionId === state.manual.sessionId
        && run.authorMode !== 'summary' && run.authorEngine !== 'external';
      result.sameEditingSession ||= matched;
      if (matched && ACTIVE.has(run.status)) result.activeApiObserved = true;
      if (await row.isVisible()) result.uiHistoryRowObserved = true;
      if (matched && ACTIVE.has(run.status) && await watch.isVisible()) {
        result.uiWatchButtonObserved = true;
        if (await watch.isEnabled()) {
          await watch.click({ timeout: 2000 });
          result.uiViewerOpened = await page.getByRole('heading', { name: '唯讀監看' }).isVisible();
          result.uiLiveStatusObserved = await page.getByTestId('live-status').isVisible();
          break;
        }
      }
      if (TERMINAL.has(run?.status)) break;
      if (Date.now() - lastRefresh > 750) {
        const refresh = page.getByRole('button', { name: '重新整理紀錄' }).first();
        if (await refresh.isVisible() && await refresh.isEnabled()) {
          await refresh.click({ timeout: 2000 });
          lastRefresh = Date.now();
        }
      }
      await sleep(120);
    }
    result.liveSocketObserved = liveSockets > 0;
    if (result.uiViewerOpened) {
      phase = 'decode';
      const first = await sampleFrames(page, 6500);
      result.decodedVideoFrames = first.videoFrames;
      result.decodedJpegFrames = first.jpegFrames;
      if (Math.max(first.videoFrames, first.jpegFrames) < 2) {
        const jpeg = page.getByRole('button', { name: '切換 JPEG 備援' });
        if (await jpeg.count() && await jpeg.isEnabled()) await jpeg.click();
        const second = await sampleFrames(page, 7500);
        result.decodedVideoFrames += second.videoFrames;
        result.decodedJpegFrames += second.jpegFrames;
      }
      result.liveSocketObserved ||= liveSockets > 0;
    }
    phase = 'close_viewer';
    const atClose = success(await api('GET', `/api/runs/${started.id}`), 200, 'run_at_close');
    result.statusAtViewerClose = atClose.status;
    await closeBrowser();
    result.browserClosedBeforeTerminalPoll = true;
    phase = 'terminal';
    result.terminal = await terminalRun(started.id);
    result.viewerCloseDidNotStopRun = ACTIVE.has(result.statusAtViewerClose) && result.terminal.status === 'succeeded';
    const decoded = Math.max(result.decodedVideoFrames, result.decodedJpegFrames) >= 2;
    result.status = decoded && result.uiViewerOpened && result.liveSocketObserved ? 'PASS_DECODED_LIVE'
      : result.uiViewerOpened ? 'UNVERIFIED_LIVE_FRAMES'
      : result.activeApiObserved && result.sameEditingSession ? 'FAIL_UI_WATCH_UNAVAILABLE' : 'UNVERIFIED_UI_TIMING';
    result.layer = result.uiViewerOpened ? 'viewer' : 'watch_control';
  } catch {
    result.failedPhase = phase;
    result.status = result.runId ? 'UNVERIFIED_POSTED_RUN' : 'UNVERIFIED_PRE_POST';
    if (result.runId) {
      try { await closeBrowser(); result.browserClosedBeforeTerminalPoll = true; } catch {}
      try { result.terminal = await terminalRun(result.runId); } catch { result.terminal = { status: 'unavailable' }; }
    }
  } finally {
    await closeBrowser();
    write('case6-live-final-result.json', result);
  }
  process.stdout.write(result.status + ' case6-live-final-result.json\n');
  if (result.status !== 'PASS_DECODED_LIVE') process.exitCode = 1;
}
main().catch(error => {
  process.stderr.write('STOP ' + String(error.message).replace(/[^a-z0-9_]/gi, '_') + '\n');
  process.exitCode = 2;
});
