#!/usr/bin/env node
// One coordinated case6 live probe: prepare UI before one manual validation POST.
// Only fixed WS message types, binary counts, IDs, enums, times and decoded frame
// counts leave memory. Never persist SDP, payload, pixels, scripts or free logs.
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
const CONTROL_TYPES = new Set(['ready', 'pong', 'offer', 'state', 'error', 'ping', 'mode', 'answer']);
const STATE_TYPES = new Set(['waiting', 'streaming', 'connecting', 'ended', 'unavailable']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString();

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
function replaceCoord(value) {
  const target = path.join(OUT, 'case6-live-probe-coordination.json');
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
}
function observedAttempt(runId, acceptedAt) {
  try {
    const file = path.join(ROOT, 'observation-latest.json');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let observation;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1048576) return null;
      observation = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (observation.observationStatus === 'UNAVAILABLE' || Date.parse(observation.observedAt || '') < Date.parse(acceptedAt)) return null;
    const attemptId = (observation.runs || []).find(run => run.id === runId)?.attemptId;
    return UUID.test(attemptId || '') ? attemptId : null;
  } catch { return null; }
}
async function waitPeerReady() {
  const file = path.join(ROOT, 'fix/live-probe-ready.json');
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let peer, modifiedAt;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) throw Error('peer_ready_invalid');
        modifiedAt = stat.mtimeMs;
        peer = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
      if (peer.status === 'READY' && peer.noRunStarted === true && Date.now() - modifiedAt < 300000) return true;
    } catch { /* The watcher has not written its bounded READY file yet. */ }
    await sleep(150);
  }
  return false;
}
function countType(bucket, value) {
  const type = CONTROL_TYPES.has(value) ? value : 'other';
  bucket[type] = (bucket[type] || 0) + 1;
  return type;
}
function fixedPrefixField(payload, key) {
  // Go LiveMessage and browser commands put these fixed fields before sensitive
  // iceServers/SDP. Stop before either key; never parse or save their values.
  const stopKeys = ['"iceServers"', '"sdp"'];
  let stop = Math.min(payload.length, 1024);
  for (const sensitive of stopKeys) {
    const position = payload.indexOf(sensitive);
    if (position >= 0) stop = Math.min(stop, position);
  }
  const prefix = payload.slice(0, stop);
  const match = new RegExp('"' + key + '"\\s*:\\s*"([A-Za-z0-9_-]{1,80})"').exec(prefix);
  return match ? match[1] : null;
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
  if (fs.existsSync(path.join(OUT, 'case6-live-probe-intent.json'))) throw Error('one_post_already_intended');
  const session = success(await api('GET', `/api/tests/${state.manual.testId}/editing-sessions/${state.manual.sessionId}`), 200, 'session').session;
  if (!session || session.id !== state.manual.sessionId || session.reclaimPending !== false || (session.pendingRunIds || []).length) throw Error('session_not_reclaimed');
  const test = success(await api('GET', `/api/tests/${state.manual.testId}`), 200, 'test');
  if (test.activeEditingSession?.id !== state.manual.sessionId) throw Error('active_session_mismatch');

  const { chromium } = require(path.join(__dirname, '../../runtimes/worker/node_modules/@playwright/test'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const result = {
    status: 'UNVERIFIED', layer: 'pre_post', testId: state.manual.testId, runId: null,
    uiReadyBeforePost: false, peerWatcherReadyBeforePost: false, sameEditingSession: false, listContainsRun: false,
    activeApiObserved: false, uiHistoryRowObserved: false, uiWatchButtonObserved: false,
    uiViewerOpened: false, uiLiveStatusObserved: false, liveSocketObserved: false, decodedVideoFrames: 0,
    decodedJpegFrames: 0, statusAtViewerClose: null, browserClosedBeforeTerminalPoll: false,
    viewerCloseDidNotStopRun: false, terminal: null,
    ws: { socketCount: 0, socketOpenedAt: null, socketClosedAt: null, sentTypes: {}, receivedTypes: {}, receivedStates: {}, receivedTransports: {}, binaryFramesReceived: 0, firstBinaryAt: null, lastBinaryAt: null },
    noPixelsOrConversationSaved: true, noSdpOrWsPayloadSaved: true,
  };
  const coord = { status: 'PREPARED', runId: null, postAt: null, attemptId: null, viewerId: null,
    readyAt: null, runningObservedAt: null, jpegSwitchAt: null, viewerClosedAt: null, terminalAt: null };
  let phase = 'ui_prepare';
  let browserClosed = false;
  let metadataTimer = null;
  async function closeBrowser() {
    if (!browserClosed) { await browser.close(); browserClosed = true; }
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    let liveSockets = 0;
    page.on('websocket', socket => {
      if (!result.runId || !socket.url().endsWith(`/api/runs/${result.runId}/live`)) return;
      liveSockets++;
      result.ws.socketCount++;
      result.ws.socketOpenedAt ||= timestamp();
      socket.on('framereceived', frame => {
        if (typeof frame.payload !== 'string') {
          result.ws.binaryFramesReceived++;
          result.ws.firstBinaryAt ||= timestamp();
          result.ws.lastBinaryAt = timestamp();
          return;
        }
        const type = countType(result.ws.receivedTypes, fixedPrefixField(frame.payload, 'type'));
        const viewerId = fixedPrefixField(frame.payload, 'viewerId');
        if (type === 'ready' && UUID.test(viewerId || '') && !coord.viewerId) {
          coord.viewerId = viewerId;
          coord.readyAt = timestamp();
          coord.status = 'VIEWER_READY';
          replaceCoord(coord);
        }
        if (type === 'state') {
          const stateValue = fixedPrefixField(frame.payload, 'state');
          const transportValue = fixedPrefixField(frame.payload, 'transport');
          const state = STATE_TYPES.has(stateValue) ? stateValue : 'other';
          const transport = ['webrtc', 'jpeg'].includes(transportValue) ? transportValue : 'other';
          result.ws.receivedStates[state] = (result.ws.receivedStates[state] || 0) + 1;
          result.ws.receivedTransports[transport] = (result.ws.receivedTransports[transport] || 0) + 1;
        }
      });
      socket.on('framesent', frame => {
        if (typeof frame.payload !== 'string') { countType(result.ws.sentTypes, 'other'); return; }
        countType(result.ws.sentTypes, fixedPrefixField(frame.payload, 'type'));
      });
      socket.on('close', () => { result.ws.socketClosedAt = timestamp(); });
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
    write('case6-live-probe-ready.json', { status: 'READY', testId: state.manual.testId, editingSessionId: state.manual.sessionId, uiEditingTabSelected: true, uiRunsPanelVisible: true });
    coord.status = 'UI_READY';
    replaceCoord(coord);
    phase = 'peer_ready';
    result.peerWatcherReadyBeforePost = await waitPeerReady();
    if (!result.peerWatcherReadyBeforePost) throw Error('peer_watcher_not_ready');

    phase = 'post_once';
    write('case6-live-probe-intent.json', { status: 'STARTED', testId: state.manual.testId, editingSessionId: state.manual.sessionId, revision: state.manual.revision, onePOSTOnly: true, fixedImage: EXPECTED_IMAGE });
    const started = success(await api('POST', `/api/tests/${state.manual.testId}/draft/validate`, {
      editingSessionId: state.manual.sessionId, revision: state.manual.revision,
    }), 202, 'validate');
    if (!UUID.test(started?.id)) throw Error('run_id_invalid');
    result.runId = started.id;
    coord.runId = started.id;
    coord.postAt = timestamp();
    coord.status = 'POST_ACCEPTED';
    replaceCoord(coord);
    write('case6-live-probe-run.json', { runId: started.id, testId: state.manual.testId, editingSessionId: state.manual.sessionId, kind: 'validation' });
    let metadataBusy = false;
    metadataTimer = setInterval(async () => {
      if (metadataBusy || !coord.runId || coord.viewerClosedAt) return;
      metadataBusy = true;
      try {
        const response = await api('GET', `/api/runs/${coord.runId}`);
        if (response.code === 200 && response.json?.status === 'running' && !coord.runningObservedAt) {
          coord.runningObservedAt = timestamp();
          replaceCoord(coord);
        }
        if (!coord.attemptId) {
          const attemptId = observedAttempt(coord.runId, coord.postAt);
          if (attemptId) { coord.attemptId = attemptId; replaceCoord(coord); }
        }
      } catch { /* Probe metadata is best effort; never log a response body. */ }
      finally { metadataBusy = false; }
    }, 400);

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
      if (run?.status === 'running' && !coord.runningObservedAt) {
        coord.runningObservedAt = timestamp();
        replaceCoord(coord);
      }
      if (!coord.attemptId) {
        const attemptId = observedAttempt(started.id, coord.postAt);
        if (attemptId) { coord.attemptId = attemptId; replaceCoord(coord); }
      }
      if (matched && ACTIVE.has(run.status)) result.activeApiObserved = true;
      if (await row.isVisible()) result.uiHistoryRowObserved = true;
      // A queued/dispatched Run has no attached Worker media endpoint yet.
      // Require the same running attempt before opening the viewer, otherwise
      // an early socket error can consume the entire 18-second live window.
      if (matched && run.status === 'running' && coord.attemptId && await watch.isVisible()) {
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
        if (await jpeg.count() && await jpeg.isEnabled()) {
          await jpeg.click();
          coord.jpegSwitchAt = timestamp();
          replaceCoord(coord);
        }
        const second = await sampleFrames(page, 7500);
        result.decodedVideoFrames += second.videoFrames;
        result.decodedJpegFrames += second.jpegFrames;
      }
      result.liveSocketObserved ||= liveSockets > 0;
    }
    phase = 'close_viewer';
    const atClose = success(await api('GET', `/api/runs/${started.id}`), 200, 'run_at_close');
    result.statusAtViewerClose = atClose.status;
    if (atClose.status === 'running' && !coord.runningObservedAt) {
      coord.runningObservedAt = timestamp();
      replaceCoord(coord);
    }
    await closeBrowser();
    result.browserClosedBeforeTerminalPoll = true;
    coord.viewerClosedAt = timestamp();
    coord.status = 'VIEWER_CLOSED';
    replaceCoord(coord);
    if (metadataTimer) { clearInterval(metadataTimer); metadataTimer = null; }
    phase = 'terminal';
    result.terminal = await terminalRun(started.id);
    if (TERMINAL.has(result.terminal.status)) {
      coord.terminalAt = timestamp();
      coord.status = 'TERMINAL';
      replaceCoord(coord);
    }
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
      coord.viewerClosedAt ||= timestamp();
      coord.status = 'VIEWER_CLOSED';
      try { replaceCoord(coord); } catch {}
      if (metadataTimer) { clearInterval(metadataTimer); metadataTimer = null; }
      try { result.terminal = await terminalRun(result.runId); } catch { result.terminal = { status: 'unavailable' }; }
      if (TERMINAL.has(result.terminal.status)) {
        coord.terminalAt = timestamp();
        coord.status = 'TERMINAL';
        try { replaceCoord(coord); } catch {}
      }
    }
  } finally {
    if (metadataTimer) clearInterval(metadataTimer);
    await closeBrowser();
    write('case6-live-probe-result.json', result);
  }
  process.stdout.write(result.status + ' case6-live-probe-result.json\n');
  if (result.status !== 'PASS_DECODED_LIVE') process.exitCode = 1;
}
main().catch(error => {
  process.stderr.write('STOP ' + String(error.message).replace(/[^a-z0-9_]/gi, '_') + '\n');
  process.exitCode = 2;
});
