#!/usr/bin/env node
'use strict';

// W7 integrated session acceptance. Never prints RPC bodies or browser data.
// Run only after the PM explicitly announces both W7 push and READY.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let stage = 'INPUT';
let sequence = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = value => { if (!value) throw Error('check'); };
const pass = name => console.log(`${name}=true`);
const uuid = () => crypto.randomUUID();

function readJSON(file, limit = 65536) {
  const info = fs.lstatSync(file);
  check(info.isFile() && info.size <= limit);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function loopbackURL(value, port) {
  const u = new URL(value);
  check(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  check(u.port === String(port) && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password);
  return u.origin;
}
function writeIntent(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function rpc(socketPath, method, params) {
  const id = ++sequence;
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setTimeout(35000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1048576) { socket.destroy(); reject(Error('frame')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        check(reply.privacyViolation === false && reply.httpStatus === 200);
        check(reply.body && reply.body.jsonrpc === '2.0' && reply.body.id === id && !reply.body.error);
        resolve(reply.body.result);
      } catch { reject(Error('rpc')); }
    });
    socket.on('timeout', () => { socket.destroy(); reject(Error('timeout')); });
    socket.on('error', () => reject(Error('socket')));
    socket.on('end', () => reject(Error('closed')));
  });
}
async function call(socketPath, name, args, lease, expectError = false, callId) {
  const params = { name, arguments: args };
  if (lease) params._meta = { whippet: { ...lease, callId: callId || uuid() } };
  const result = await rpc(socketPath, 'tools/call', params);
  check(result && (expectError ? result.isError === true : result.isError !== true));
  if (expectError) return;
  check(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent;
}
function asLease(data) {
  check(data && UUID.test(data.sessionId) && UUID.test(data.leaseId));
  check(['opening', 'ready', 'closing', 'reclaim_pending', 'closed'].includes(data.state));
  check(typeof data.reclaimed === 'boolean');
  return { sessionId: data.sessionId, leaseId: data.leaseId };
}
async function waitStatus(socketPath, lease, predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const status = await call(socketPath, 'browser_session_status', lease);
    check(status.sessionId === lease.sessionId && status.leaseId === lease.leaseId);
    if (predicate(status)) return;
    await sleep(700);
  }
  throw Error('status');
}
async function waitTarget(file, baseline, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const state = readJSON(file, 4096);
      if (baseline.count !== undefined) {
        check(Number.isSafeInteger(state.loginCount) && state.loginCount >= baseline.count && state.loginCount <= baseline.count + 1);
        if (state.loginCount === baseline.count + 1) return;
      } else if (state.loginSucceeded === true) return;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(250);
  }
  throw Error('target');
}
async function waitForDOM(page, predicate, timeout = 30000) {
  await page.waitForFunction(predicate, null, { timeout, polling: 100 });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/test/m11-final-session-ui.cjs --ready-dir /absolute/PM/root --intent-dir /absolute/owned/dir --w7-push-ready [--viewer-only|--resume|--resume-viewer|--resume-waiting]');
    return;
  }
  const args = process.argv.slice(2);
  check((args.length === 5 || args.length === 6 && ['--viewer-only', '--resume', '--resume-viewer', '--resume-waiting'].includes(args[5])) && args[0] === '--ready-dir' && args[2] === '--intent-dir' && args[4] === '--w7-push-ready');
  const resume = ['--resume', '--resume-viewer', '--resume-waiting'].includes(args[5]);
  const viewerOnly = args[5] === '--viewer-only';
  const waiting = args[5] === '--resume-waiting';
  const existingViewer = waiting || args[5] === '--resume-viewer';
  const [root, intentDir] = [args[1], args[3]];
  check(path.isAbsolute(root) && path.isAbsolute(intentDir));
  const dir = fs.lstatSync(intentDir);
  check(dir.isDirectory() && dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700 && (resume || fs.readdirSync(intentDir).length === 0));
  const ready = readJSON(path.join(root, 'ready.json'));
  check(ready.ready === true && typeof ready.workspaceName === 'string' && ready.workspaceName.length > 0 && UUID.test(ready.roleId));
  const web = loopbackURL(ready.webURL, 19787);
  const cdp = loopbackURL(ready.cdpURL, 19790);
  const target = new URL(ready.targetURL);
  check(target.protocol === 'http:' && target.hostname === 'host.docker.internal' && target.port === '19788' && !target.username && !target.password && !target.search && !target.hash);
  const socketPath = path.join(root, 'session-rpc.sock');
  check(fs.lstatSync(socketPath).isSocket());
  const { chromium } = require('../../runtimes/worker/node_modules/playwright');
  let page, browser;
  try {
    stage = 'MCP_INITIALIZE';
    const initial = await rpc(socketPath, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm11-final-session-qa', version: '1' } });
    check(initial && typeof initial.protocolVersion === 'string');
    const tools = await rpc(socketPath, 'tools/list', {});
    check(Array.isArray(tools.tools) && ['browser_session_open', 'browser_session_status', 'browser_session_close', 'browser_navigate', 'browser_snapshot', 'browser_login'].every(name => tools.tools.some(tool => tool.name === name)));
    pass('MCP_TOOLS');

    stage = 'OPEN';
    let lease;
    if (resume) {
      lease = readJSON(path.join(intentDir, 'lease-1.json'));
      check(UUID.test(lease.sessionId) && UUID.test(lease.leaseId));
      check(!fs.existsSync(path.join(intentDir, 'close-1.json')));
      check(!fs.existsSync(path.join(intentDir, 'login-1.json')));
    } else {
      const requestId = uuid();
      writeIntent(path.join(intentDir, 'open-1.json'), { requestId });
      const opened = await call(socketPath, 'browser_session_open', { requestId });
      lease = asLease(opened);
      writeIntent(path.join(intentDir, 'lease-1.json'), lease);
    }
    await waitStatus(socketPath, lease, s => s.state === 'ready' && s.reclaimed === false, 45000);
    pass('SESSION_READY');
    stage = 'NAVIGATE';
    if (!resume) {
      await call(socketPath, 'browser_navigate', { url: new URL('/login', target).href }, lease);
      await call(socketPath, 'browser_snapshot', {}, lease);
      pass('NAVIGATE_AND_SNAPSHOT_PRIVATE');
    }

    stage = 'UI_VIEWER';
    browser = await chromium.connectOverCDP(cdp);
    const pages = browser.contexts().flatMap(ctx => ctx.pages());
    const matches = [];
    const marked = [];
    for (const candidate of pages) {
      try {
        if (new URL(candidate.url()).origin === web && await candidate.getByRole('combobox', { name: 'Workspace' }).count() === 1) {
          matches.push(candidate);
          if (await candidate.evaluate(() => window.name === 'm11-session-qa-t67')) marked.push(candidate);
        }
      } catch { /* A closed unrelated page is ignored. */ }
    }
    check(marked.length === 1 || marked.length === 0 && matches.length === 1);
    page = marked[0] || matches[0];
    await page.evaluate(() => { window.name = 'm11-session-qa-t67'; });
    check(await page.locator('.mock-banner, .mock-note').count() === 0);
    if (!existingViewer) await page.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: ready.workspaceName });
    if (!existingViewer) {
      await page.getByRole('button', { name: 'Workspace 設定' }).click();
      await page.getByRole('tab', { name: '正式設定與能力' }).click();
    }
    const section = page.locator('.workspace-browser-sessions');
    const row = section.locator('li').filter({ hasText: lease.sessionId.slice(0, 8) });
    await page.evaluate(() => {
      const history = { connecting: false, waiting: false, unavailable: false, error: false, streaming: false };
      window.__m11ViewerStates = history;
      const observe = () => {
        const status = document.querySelector('.workspace-browser-sessions [data-testid="live-status"]');
        if (!status) return;
        const value = status.textContent || '';
        if (value.includes('監看連線中') || value.includes('監看重新連線中')) history.connecting = true;
        if (value.includes('等待監看畫面')) history.waiting = true;
        if (value.includes('目前無法監看')) history.unavailable = true;
        if (value.includes('監看連線失敗')) history.error = true;
        if (value.includes('監看中：')) history.streaming = true;
      };
      new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      observe();
    });
    if (existingViewer) check(await section.locator('.live-panel').count() === 1);
    else await row.getByRole('button', { name: '開始監看' }).click({ timeout: 30000 });
    if (!waiting) {
      try {
        await waitForDOM(page, () => {
          const s = document.querySelector('[data-testid="live-status"]');
          const v = document.querySelector('[data-testid="live-video"]');
          const i = document.querySelector('[data-testid="live-jpeg"]');
          return !!s && /監看中：/.test(s.textContent || '') && (!!v && !v.hidden && v.videoWidth > 0 && v.videoHeight > 0 || !!i && !i.hidden && i.naturalWidth > 0);
        }, 45000);
      } catch (error) {
        const states = await page.evaluate(() => window.__m11ViewerStates);
        for (const key of ['connecting', 'waiting', 'unavailable', 'error', 'streaming']) console.log(`UI_${key.toUpperCase()}=${states[key] === true}`);
        throw error;
      }
    }
    if (!waiting) pass('LIVE_VISIBLE');
    if (viewerOnly) { console.log('RESULT=VIEWER_OBSERVED_LOGIN_NOT_ATTEMPTED'); return; }

    if (args[5] === '--resume-viewer') {
      stage = 'WEBRTC_FRAMES';
      const livePanel = section.locator('.live-panel');
      const webrtc = livePanel.getByRole('button', { name: '嘗試 WebRTC' });
      if (await webrtc.isEnabled()) await webrtc.click();
      await waitForDOM(page, () => {
        const media = document.querySelector('.workspace-browser-sessions .live-media');
        const video = document.querySelector('.workspace-browser-sessions [data-testid="live-video"]');
        return !!media && media.getAttribute('data-transport') === 'webrtc' && !!video && !video.hidden && video.videoWidth > 0 && !video.paused && typeof video.getVideoPlaybackQuality === 'function';
      }, 45000);
      const beforeFrames = await page.evaluate(() => document.querySelector('.workspace-browser-sessions [data-testid="live-video"]').getVideoPlaybackQuality().totalVideoFrames);
      await page.waitForFunction(before => {
        const video = document.querySelector('.workspace-browser-sessions [data-testid="live-video"]');
        return !!video && !video.hidden && video.getVideoPlaybackQuality().totalVideoFrames > before;
      }, beforeFrames, { timeout: 15000, polling: 100 });
      pass('WEBRTC_DECODED_FRAMES_ADVANCE');

      stage = 'JPEG_DECODE';
      const jpeg = livePanel.getByRole('button', { name: '切換 JPEG 備援' });
      if (await jpeg.isEnabled()) await jpeg.click();
      await waitForDOM(page, () => {
        const media = document.querySelector('.workspace-browser-sessions .live-media');
        const image = document.querySelector('.workspace-browser-sessions [data-testid="live-jpeg"]');
        return !!media && media.getAttribute('data-transport') === 'jpeg' && !!image && !image.hidden && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }, 45000);
      let decoded = false;
      const end = Date.now() + 10000;
      while (!decoded && Date.now() < end) {
        decoded = await page.evaluate(async () => {
          const image = document.querySelector('.workspace-browser-sessions [data-testid="live-jpeg"]');
          if (!image || image.hidden || !image.complete || !image.naturalWidth) return false;
          try { await image.decode(); return !image.hidden && image.naturalWidth > 0; } catch { return false; }
        });
        if (!decoded) await sleep(100);
      }
      check(decoded);
      pass('JPEG_DECODED');
    }

    // Observe DOM synchronously while the independent MCP call is in flight.
    await page.evaluate(() => {
      const evidence = { pause: false, hidden: false, exposed: false };
      window.__m11SessionEvidence = evidence;
      new MutationObserver(() => {
        const status = document.querySelector('[data-testid="live-status"]');
        if (!status || !status.textContent.includes('敏感輸入暫停')) return;
        evidence.pause = true;
        const video = document.querySelector('[data-testid="live-video"]');
        const image = document.querySelector('[data-testid="live-jpeg"]');
        if (video && image && video.hidden && image.hidden) evidence.hidden = true;
        else evidence.exposed = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    stage = 'LOGIN';
    const initialTarget = readJSON(path.join(root, 'target-state.json'), 4096);
    const baseline = {};
    if (Number.isSafeInteger(initialTarget.loginCount) && initialTarget.loginCount >= 0) baseline.count = initialTarget.loginCount;
    else check(initialTarget.loginSucceeded === false);
    const loginId = uuid();
    writeIntent(path.join(intentDir, 'login-1.json'), { ...lease, callId: loginId });
    const login = await call(socketPath, 'browser_login', { roleId: ready.roleId, usernameSelector: '#username', passwordSelector: '#password', submitSelector: '#submit' }, lease, false, loginId);
    // submitted reports the act of submission, never authentication success.
    // Existing tools may also include a broker-scanned page snapshot.
    const submitted = login.submitted === true;
    console.log(`LOGIN_SUBMITTED=${submitted}`);
    console.log(`LOGIN_HAS_PAGE=${Object.hasOwn(login, 'page')}`);
    console.log(`LOGIN_HAS_OTHER_KEYS=${Object.keys(login).some(key => key !== 'submitted' && key !== 'page')}`);
    if (!waiting) check(submitted);
    await waitTarget(path.join(root, 'target-state.json'), baseline, 15000);
    pass('TARGET_LOGIN_SUCCEEDED');
    const observed = await page.evaluate(() => window.__m11SessionEvidence);
    const pauseHidden = Boolean(observed && observed.pause === true && observed.hidden === true && observed.exposed === false);
    console.log(`SENSITIVE_PAUSE_MEDIA_HIDDEN=${pauseHidden}`);
    if (!waiting) check(pauseHidden);
    await call(socketPath, 'browser_snapshot', {}, lease);
    pass('POST_LOGIN_SNAPSHOT_PRIVATE');
    if (!waiting) await waitForDOM(page, () => {
      const s = document.querySelector('[data-testid="live-status"]');
      const v = document.querySelector('[data-testid="live-video"]');
      const i = document.querySelector('[data-testid="live-jpeg"]');
      return !!s && /監看中：/.test(s.textContent || '') && (!!v && !v.hidden && v.videoWidth > 0 || !!i && !i.hidden && i.naturalWidth > 0);
    }, 45000);
    if (!waiting) pass('LIVE_RESUMED');

    stage = 'CLOSE';
    writeIntent(path.join(intentDir, 'close-1.json'), lease);
    await call(socketPath, 'browser_session_close', lease);
    await waitStatus(socketPath, lease, s => s.state === 'closed' && s.reclaimed === true, 45000);
    pass('RECLAIM_REPORTED');
    await call(socketPath, 'browser_snapshot', {}, lease, true);
    pass('CLOSED_SESSION_REJECTED');
    await page.waitForFunction(shortId => {
      const section = document.querySelector('.workspace-browser-sessions');
      if (!section) return false;
      const row = Array.from(section.querySelectorAll('li')).find(el => el.textContent.includes(shortId));
      const status = section.querySelector('[data-testid="live-status"]');
      return !row && (!status || /監看已結束|目前無法監看|監看連線失敗/.test(status.textContent));
    }, lease.sessionId.slice(0, 8), { timeout: 30000, polling: 200 });
    pass('VIEWER_INVALIDATED_UI');

    if (waiting) {
      console.log(`RESULT=${submitted && pauseHidden ? 'PARTIAL_NO_FIRST_FRAME' : 'FAIL'}`);
      if (!submitted || !pauseHidden) process.exitCode = 1;
      return;
    }
    if (args[5] === '--resume-viewer') {
      console.log('RESULT=PARTIAL_DOCKER_AND_CAPACITY_ORACLE_REQUIRED');
      return;
    }

    stage = 'CAPACITY';
    const requestId2 = uuid();
    writeIntent(path.join(intentDir, 'open-2.json'), { requestId: requestId2 });
    const second = asLease(await call(socketPath, 'browser_session_open', { requestId: requestId2 }));
    check(second.sessionId !== lease.sessionId && second.leaseId !== lease.leaseId);
    writeIntent(path.join(intentDir, 'lease-2.json'), second);
    await waitStatus(socketPath, second, s => s.state === 'ready' && s.reclaimed === false, 45000);
    pass('SECOND_SESSION_READY');
    writeIntent(path.join(intentDir, 'close-2.json'), second);
    await call(socketPath, 'browser_session_close', second);
    await waitStatus(socketPath, second, s => s.state === 'closed' && s.reclaimed === true, 45000);
    pass('SECOND_RECLAIM_REPORTED');
    console.log('RESULT=PASS_PARTIAL_DOCKER_ORACLE_REQUIRED');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch(() => { console.log(`RESULT=FAIL\nSTAGE=${stage}`); process.exitCode = 1; });
