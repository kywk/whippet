// Deterministic client state-machine tests: no browser, network, or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/live.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createLiveSession, createLiveOfferHistory, sessionLiveSocketUrl } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const originals = new Map(['window', 'document', 'WebSocket', 'RTCPeerConnection', 'MediaStream', 'HTMLMediaElement', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((key) => [key, globalThis[key]]));
const originalNow = Date.now;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let now = 1_000, nextTimer = 1, nextUrl = 1, assertions = 0, passed = 0;
const timers = new Map(), revoked = [], urls = [], sessions = [];
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const viewer = id(900);

function timer(callback, delay = 0, interval = false) {
  const key = nextTimer++; timers.set(key, { callback, at: now + delay, interval: interval ? delay : 0 }); return key;
}
async function advance(milliseconds) {
  const end = now + milliseconds;
  let steps = 0;
  while (true) {
    const entry = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!entry) break;
    assert.ok(++steps < 2000, 'timer loop');
    const [key, item] = entry; now = item.at;
    if (item.interval) item.at += item.interval; else timers.delete(key);
    item.callback(); await flush();
  }
  now = end; await flush();
}

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  autoPong = true;
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  json(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  bytes() { this.onmessage?.({ data: new Uint8Array([1, 2, 3, 4]).buffer }); }
  send(raw) { const message = JSON.parse(raw); this.sent.push(message); if (message.type === 'ping' && this.autoPong) this.json({ type: 'pong' }); }
  close() { this.readyState = 3; this.onclose?.({}); }
}

class FakePeer extends EventTarget {
  static instances = [];
  static plans = [];
  connectionState = 'new';
  localDescription = null;
  localCalls = 0;
  remoteCalls = 0;
  answerCalls = 0;
  closed = false;
  listeners = new Set();
  constructor() { super(); this.plan = FakePeer.plans.shift() ?? {}; this.iceGatheringState = this.plan.ice ? 'gathering' : 'complete'; FakePeer.instances.push(this); }
  addEventListener(type, listener, options) { this.listeners.add(listener); super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { this.listeners.delete(listener); super.removeEventListener(type, listener, options); }
  async setRemoteDescription() { this.remoteCalls++; if (this.plan.remote) await this.plan.remote.promise; }
  async createAnswer() { this.answerCalls++; return this.plan.answer ? await this.plan.answer.promise : { type: 'answer', sdp: 'synthetic-answer' }; }
  async setLocalDescription(description) { this.localCalls++; if (this.plan.local) await this.plan.local.promise; this.localDescription = description; }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

class FakeTrack { kind = 'video'; readyState = 'live'; stopped = 0; stop() { this.stopped++; this.readyState = 'ended'; } }
class FakeStream { tracks = []; addTrack(track) { this.tracks.push(track); } getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); } }
class FakeVideo {
  srcObject = null; hidden = false; paused = true; videoWidth = 0; videoHeight = 0; readyState = 0;
  callbacks = new Map(); nextCallback = 1; cancelled = []; playCalls = 0; loadCalls = 0;
  pause() { this.paused = true; }
  removeAttribute() {}
  load() { this.loadCalls++; this.videoWidth = 0; this.videoHeight = 0; this.readyState = 0; }
  play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
  requestVideoFrameCallback(callback) { const key = this.nextCallback++; this.callbacks.set(key, callback); return key; }
  cancelVideoFrameCallback(key) { this.cancelled.push(key); this.callbacks.delete(key); }
  frame() { const [key, callback] = this.callbacks.entries().next().value; this.callbacks.delete(key); callback(now, {}); }
}
class FakeImage { src = ''; hidden = false; complete = true; naturalWidth = 1280; removeAttribute() { this.src = ''; } }

function reset() {
  now = 1_000; timers.clear(); urls.length = 0; revoked.length = 0; FakeSocket.instances = []; FakePeer.instances = []; FakePeer.plans = [];
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  globalThis.window = Object.assign(new EventTarget(), { location: { href: 'https://platform.example/' } });
  globalThis.WebSocket = FakeSocket; globalThis.RTCPeerConnection = FakePeer;
  globalThis.MediaStream = FakeStream; globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.setTimeout = (callback, delay) => timer(callback, delay);
  globalThis.clearTimeout = (key) => timers.delete(key);
  globalThis.setInterval = (callback, delay) => timer(callback, delay, true);
  globalThis.clearInterval = (key) => timers.delete(key);
  Date.now = () => now;
  URL.createObjectURL = () => { const url = `blob:synthetic-${nextUrl++}`; urls.push(url); return url; };
  URL.revokeObjectURL = (url) => revoked.push(url);
}

async function start(mode = 'webrtc', history) {
  const video = new FakeVideo(), image = new FakeImage(), states = [];
  const controller = createLiveSession({ runId: id(800), apiBase: '/api', video, image, initialMode: mode, offerHistory: history, waitingForAttempt: () => false, onChange: (state) => states.push(state) });
  sessions.push(controller); await advance(0);
  const ws = FakeSocket.instances.at(-1); ws.open(); ws.json({ type: 'ready', viewerId: viewer, iceServers: [] }); await flush();
  const state = () => states.at(-1);
  const offer = async (offerId, overrides = {}) => { ws.json({ type: 'offer', viewerId: viewer, offerId, sdp: 'synthetic-offer', ...overrides }); await flush(); };
  const pause = () => ws.json({ type: 'state', viewerId: viewer, state: 'waiting', reason: 'sensitive_input', transport: mode });
  const complete = (transport = mode, overrides = {}) => ws.json({ type: 'state', viewerId: viewer, state: 'waiting', reason: 'sensitive_input_complete', transport, ...overrides });
  return { controller, video, image, ws, states, state, offer, pause, complete };
}

async function startBrowserSession() {
  const video = new FakeVideo(), image = new FakeImage(), states = [];
  const controller = createLiveSession({ browserSession: { sessionId: id(801), leaseId: id(802) }, apiBase: '/api', video, image, initialMode: 'webrtc', waitingForAttempt: () => false, onChange: (state) => states.push(state) });
  sessions.push(controller); await advance(0);
  const ws = FakeSocket.instances.at(-1); ws.open(); ws.json({ type: 'ready', viewerId: viewer, iceServers: [] }); await flush();
  return { controller, video, image, ws, states };
}

async function decoded(harness, peer = FakePeer.instances.at(-1)) {
  const track = new FakeTrack(); peer.ontrack({ track }); await flush();
  harness.video.readyState = 2; harness.video.videoWidth = 1280; harness.video.videoHeight = 720;
  harness.video.frame(); return track;
}
const answers = (ws) => ws.sent.filter((message) => message.type === 'answer');
async function test(name, body) {
  reset();
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}: ${error.message}`); }
  finally { while (sessions.length) sessions.pop().close(); await flush(); eq(timers.size, 0, 'session close clears all timers'); }
}

try {
  await test('UUID echo, real-frame status, invalid/duplicate/downgrade rejection', async () => {
    const h = await start(); await h.offer('not-a-uuid'); eq(FakePeer.instances.length, 0);
    await h.offer(id(1)); eq(answers(h.ws).at(-1).offerId, id(1)); eq(answers(h.ws).at(-1).viewerId, viewer);
    eq(h.state().phase, 'waiting');
    h.ws.json({ type: 'state', state: 'streaming', transport: 'webrtc' }); eq(h.state().phase, 'waiting');
    await decoded(h); eq(h.state().phase, 'streaming');
    const count = FakePeer.instances.length;
    await h.offer(id(1)); await h.offer(undefined); await h.offer(id(2), { sdp: '' }); await h.offer(id(3), { viewerId: id(999) });
    eq(FakePeer.instances.length, count); eq(h.state().phase, 'streaming');
  });

  await test('legacy initial-only compatibility and protocol history survives controller restart', async () => {
    const history = createLiveOfferHistory(); const h = await start('webrtc', history);
    await h.offer(undefined); eq(answers(h.ws).length, 1); eq(Object.hasOwn(answers(h.ws)[0], 'offerId'), false);
    await h.offer(undefined); eq(answers(h.ws).length, 1);
    await h.offer(id(10)); eq(answers(h.ws).at(-1).offerId, id(10)); h.controller.close();
    const next = await start('webrtc', history); const count = FakePeer.instances.length;
    await next.offer(undefined); await next.offer(id(10)); eq(FakePeer.instances.length, count);
    await next.offer(id(11)); eq(answers(next.ws).at(-1).offerId, id(11));
  });

  await test('streaming pause clears video, tracks, callbacks and prevents fallback/retry/play/mode', async () => {
    const h = await start(); await h.offer(id(20)); const peer = FakePeer.instances.at(-1); const track = await decoded(h, peer);
    const oldFrame = [...h.video.callbacks.values()][0], oldPlaying = h.video.onplaying, oldState = peer.onconnectionstatechange, oldTrack = peer.ontrack;
    h.ws.json({ type: 'state', viewerId: id(999), state: 'waiting', reason: 'sensitive_input' }); eq(h.state().phase, 'streaming');
    h.ws.json({ type: 'state', state: 'waiting', reason: 'sensitive_input' });
    eq(h.state().phase, 'paused'); eq(h.state().sensitivePaused, true); eq(h.video.srcObject, null); eq(peer.closed, true); ok(track.stopped > 0);
    eq(h.video.callbacks.size, 0); eq(h.video.onplaying, null); eq(h.video.onwaiting, null); eq(h.video.hidden, true); eq(h.image.hidden, true); ok(h.video.loadCalls > 0);
    oldFrame(); oldPlaying(); oldState(); const lateTrack = new FakeTrack(); oldTrack({ track: lateTrack }); ok(lateTrack.stopped > 0);
    const sent = h.ws.sent.length, plays = h.video.playCalls;
    h.controller.switchMode('jpeg'); h.controller.play(); eq(h.ws.sent.length, sent); eq(h.video.playCalls, plays);
    h.ws.json({ type: 'ready', viewerId: viewer, iceServers: [] });
    for (const state of ['waiting', 'connecting', 'streaming']) h.ws.json({ type: 'state', viewerId: viewer, state, transport: 'webrtc' });
    h.ws.autoPong = false; await advance(65_000);
    eq(h.state().phase, 'paused'); eq(h.state().mode, 'webrtc'); eq(FakeSocket.instances.length, 1); eq(h.ws.sent.filter((item) => item.type === 'mode').length, 0);
    h.ws.close(); await advance(30_000); eq(FakeSocket.instances.length, 1); eq(h.state().phase, 'paused');
  });

  await test('WebRTC requires current-viewer complete then an unseen matching UUID and new frame', async () => {
    const h = await start(); await h.offer(id(30)); await decoded(h); h.pause();
    await h.offer(id(31)); eq(FakePeer.instances.length, 1);
    h.complete('webrtc', { viewerId: id(999) }); await h.offer(id(32)); eq(FakePeer.instances.length, 1);
    h.complete('jpeg'); await h.offer(id(33)); eq(FakePeer.instances.length, 1);
    h.complete('webrtc', { offerId: id(34) }); eq(h.state().phase, 'paused'); eq(h.state().sensitivePaused, true);
    await h.offer(id(31)); await h.offer(undefined); await h.offer(id(35)); eq(FakePeer.instances.length, 1);
    await h.offer(id(34)); eq(FakePeer.instances.length, 2); eq(h.state().phase, 'waiting'); eq(h.state().sensitivePaused, false); eq(answers(h.ws).at(-1).offerId, id(34));
    await decoded(h); eq(h.state().phase, 'streaming'); eq(h.video.hidden, false);
  });

  await test('JPEG pause revokes old/pending image; only current-viewer explicit completion admits new image', async () => {
    const h = await start('jpeg'); h.ws.bytes(); h.image.onload(); eq(h.state().phase, 'streaming');
    const oldUrl = h.image.src, oldLoad = h.image.onload, oldError = h.image.onerror;
    h.pause(); eq(h.state().phase, 'paused'); eq(h.image.src, ''); eq(h.image.onload, null); ok(revoked.includes(oldUrl)); eq(h.image.hidden, true);
    const before = urls.length; h.ws.bytes(); oldLoad(); oldError(); eq(urls.length, before); eq(h.state().phase, 'paused');
    for (const state of ['waiting', 'connecting', 'streaming']) h.ws.json({ type: 'state', viewerId: viewer, state, transport: 'jpeg' });
    h.complete('jpeg', { viewerId: undefined }); h.complete('jpeg', { viewerId: id(999) }); h.complete('webrtc');
    eq(h.state().sensitivePaused, true); h.ws.bytes(); eq(urls.length, before);
    h.complete(); eq(h.state().phase, 'waiting'); eq(h.state().sensitivePaused, false); eq(h.image.src, '');
    oldLoad(); oldError(); eq(h.state().phase, 'waiting');
    h.ws.bytes(); const newUrl = h.image.src; ok(newUrl && newUrl !== oldUrl); eq(h.state().phase, 'waiting');
    h.image.onload(); eq(h.state().phase, 'streaming'); eq(h.image.hidden, false); oldError(); eq(h.state().phase, 'streaming');
    h.pause(); eq(h.image.src, ''); ok(revoked.includes(newUrl));
  });

  for (const mode of ['webrtc', 'jpeg']) {
    await test(`${mode} stale resume epoch cannot unlock a later sensitive phase`, async () => {
      const h = await start(mode); h.pause(); h.ws.autoPong = false; await advance(65_000);
      h.complete(mode, { offerId: id(70) });
      if (mode === 'webrtc') { await h.offer(id(70)); await decoded(h); }
      else { h.ws.bytes(); h.image.onload(); }
      eq(h.state().phase, 'streaming');
      h.pause(); h.complete(mode, { offerId: id(70) }); eq(h.state().sensitivePaused, true);
      if (mode === 'webrtc') { const count = FakePeer.instances.length; await h.offer(id(71)); eq(FakePeer.instances.length, count); }
      else { const count = urls.length; h.ws.bytes(); eq(urls.length, count); }
      h.complete(mode, { offerId: id(72) });
      if (mode === 'webrtc') { await h.offer(id(72)); await decoded(h); }
      else { h.ws.bytes(); h.image.onload(); }
      h.ws.autoPong = true; await advance(5_001); eq(FakeSocket.instances.length, 1); eq(h.state().phase, 'streaming');
    });
  }

  for (const stage of ['remote', 'answer', 'local', 'ice']) {
    await test(`pause invalidates negotiation at ${stage} await`, async () => {
      const h = await start(), held = deferred(); FakePeer.plans.push(stage === 'ice' ? { ice: true } : { [stage]: held });
      await h.offer(id(40)); const peer = FakePeer.instances.at(-1);
      h.pause(); held.resolve({ type: 'answer', sdp: 'late-answer' }); await flush();
      eq(peer.closed, true); eq(answers(h.ws).length, 0); eq(peer.listeners.size, 0);
      if (stage === 'remote' || stage === 'answer') eq(peer.localCalls, 0);
      await advance(25_000); eq(h.state().phase, 'paused'); eq(h.state().mode, 'webrtc');
    });
  }

  await test('superseded async answer and rejection cannot mutate newer negotiation', async () => {
    const h = await start(), held = deferred(); FakePeer.plans.push({ answer: held });
    await h.offer(id(50)); const old = FakePeer.instances.at(-1); await h.offer(id(51));
    held.resolve({ type: 'answer', sdp: 'obsolete' }); await flush(); eq(old.localCalls, 0); eq(answers(h.ws).map((item) => item.offerId), [id(51)]);
    const rejected = deferred(); FakePeer.plans.push({ remote: rejected }); await h.offer(id(52)); await h.offer(id(53));
    rejected.reject(new Error('obsolete failure')); await flush(); eq(h.state().mode, 'webrtc'); eq(answers(h.ws).map((item) => item.offerId), [id(51), id(53)]);
  });

  await test('mode boundary rejects offers observed in old mode and cancels old async answer', async () => {
    const h = await start(), held = deferred(); FakePeer.plans.push({ answer: held }); await h.offer(id(60));
    h.controller.switchMode('jpeg'); await h.offer(id(61)); held.resolve({ type: 'answer', sdp: 'obsolete' }); await flush(); eq(answers(h.ws).length, 0);
    h.controller.switchMode('webrtc'); const count = FakePeer.instances.length;
    await h.offer(id(60)); await h.offer(id(61)); await h.offer(undefined); eq(FakePeer.instances.length, count);
    await h.offer(id(62)); eq(answers(h.ws).at(-1).offerId, id(62));
  });

  await test('non-sensitive fallback remains available and close revokes pending media', async () => {
    const h = await start(); await advance(20_001); eq(h.state().mode, 'jpeg');
    h.ws.bytes(); const url = h.image.src, pending = h.image.onload; h.controller.close();
    eq(h.image.src, ''); ok(revoked.includes(url)); eq(h.video.srcObject, null); pending();
    eq(timers.size, 0); eq(h.image.onload, null);
  });
  await test('browser session uses its own same-origin socket and retains sensitive masking', async () => {
    const expected = `wss://platform.example/api/browser-sessions/${id(801)}/leases/${id(802)}/live`;
    eq(sessionLiveSocketUrl('/api', id(801), id(802), 'https://platform.example/'), expected);
    assert.throws(() => sessionLiveSocketUrl('https://other.example/api', id(801), id(802), 'https://platform.example/'));
    const h = await startBrowserSession(); eq(h.ws.url, expected);
    h.ws.json({ type: 'state', viewerId: viewer, state: 'waiting', reason: 'sensitive_input', transport: 'webrtc' });
    eq(h.states.at(-1).sensitivePaused, true); eq(h.states.at(-1).phase, 'paused');
    h.controller.close(); eq(h.video.srcObject, null); eq(h.image.src, '');
  });
  console.log(`Live sensitive checks: ${passed}/15 scenarios PASS; ${assertions} assertions. Browser/real media integration not run.`);
} finally {
  for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  Date.now = originalNow; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
}
