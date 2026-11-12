#!/usr/bin/env node
// M9 有界歷史黑箱（parent=t3v crew1，全新黑箱QA）。
// 唯一 owner：scripts/test/m9-history-live.cjs 與 /private/tmp/whippet-m9-history-evidence。
// 固定對象：Workspace 95296031-b243-4bb6-b964-e90dd8af4bb5、新專用 Test（env 提供，不動原 Test cea8a396…）、新 editingSession（經公開 API 建立）。
// 真 Muse/xhigh 由 Server 端提供（PM 已部署 18087，本腳本不直連模型、不設模型參數，只記錄 effective 證據）。
// PM 可用 WHIPPET_CANCEL_FIXTURE=1：先停無活躍Run的專用Manager，以 WHIPPET_PREPARE_ONLY=1 建12筆queued→cancelled訊息，恢復Manager後同checkpoint跑最後真模型；不與其他Run併行。
// 流程：首輪合成決策隨機 marker（明示只答收到、不寫稿不更新 summary/background）；後續至少6輪只答收到填充把首輪移出 recent12（禁 history/summary 工具直至最後）；
//   最後一輪僅要求找回首輪合成決策（提示內不含 marker 答案，要求用 read_conversation_history 分頁、最多4頁）。
// 每輪先排 Run 即存 id 再 poll，resume 不得重 POST；失敗立即停固定 code。全部真 AI 串行（MAX_WORKERS1 概念：單迴圈串行）。
// 不動原 Test/Version/role；不 validate/publish/正式 Run/監看；不呼叫 /manager/history（僅模型經 Worker 用）。
// 公開 conversation 只驗最後 assistant/runId 答 marker 及首訊息距離>=12；單靠此不聲稱 history 成功，PM 另核對預設 payload 不含 marker 與工具事件。
// Test 建立缺口：允許契約（v7/v8/v9）+ continuity 腳本均未給出 POST /api/tests 形狀，故本腳本不猜建立 API；
//   需 PM 經公開 API 預建專用 Test 並以 WHIPPET_TEST_ID 傳入，缺失或 404 即報 E_TEST_CREATE_GAP。
// 只用公開 API＋Node 內建 fetch/fs/crypto/path；不讀產品源碼/DB/journal/deploy/.env.ai/機密；不安装/部署/Git。
// 執行：WEB_URL=http://127.0.0.1:18087 WHIPPET_TEST_ID=<新專用Test> node scripts/test/m9-history-live.cjs（本交付未跑）。
// 端點來源：contracts/mvp-v7.md、v8.md、v9.md 與 scripts/test/m9-settings-continuity.cjs 已證實端點。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WS_ID = '95296031-b243-4bb6-b964-e90dd8af4bb5';
const ORIG_TEST_ID = 'cea8a396-da05-4517-b877-47add4733cfb';
const TEST_ID = (process.env.WHIPPET_TEST_ID || '').trim();
const BASE_CANDIDATES = [];
{
  const b = (process.env.BASE_URL || process.env.WHIPPET_BASE_URL || process.env.WEB_URL || 'http://127.0.0.1:18087').replace(/\/$/, '');
  BASE_CANDIDATES.push(b);
  if (b.includes('127.0.0.1')) BASE_CANDIDATES.push(b.replace('127.0.0.1', 'localhost'));
}
for (const bad of ['18080', '18085', '18086']) {
  if ((BASE_CANDIDATES[0] || '').includes(bad)) throw new Error('FAIL E_BASE_URL 舊環境拒跑');
}
let EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/private/tmp/whippet-m9-history-evidence';
try { fs.mkdirSync(EV_DIR, { recursive: true }); } catch { EV_DIR = '/tmp/whippet-m9-history-evidence'; fs.mkdirSync(EV_DIR, { recursive: true }); }
const CKPT_PATH = path.join(EV_DIR, 'm9-history-checkpoint.json');
const RESULT_PATH = path.join(EV_DIR, 'm9-history-result.json');
const RUNS_PATH = path.join(EV_DIR, 'm9-history-runs.json');
const OVERALL_MS = Number(process.env.WHIPPET_M9_OVERALL_MS || 30 * 60 * 1000);
const RUN_MS = Number(process.env.WHIPPET_M9_RUN_MS || 600 * 1000);
const POLL_MS = 5000;
const CANCEL_FIXTURE = process.env.WHIPPET_CANCEL_FIXTURE === '1';
const FILLER_COUNT = CANCEL_FIXTURE ? 11 : 6;
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) throw coded('E_OVERALL_TIMEOUT', step);
}
function coded(code, detail) {
  const e = new Error(`FAIL ${code}${detail ? ' ' + String(detail).slice(0, 160) : ''}`);
  e.code = code;
  return e;
}
function sha256(s) { return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex'); }

let BASE = BASE_CANDIDATES[0];
async function rawGet(p) {
  checkOverall(`GET ${p}`);
  const r = await fetch(BASE + p, { method: 'GET', headers: { Accept: 'application/json' } });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { http: r.status, json: j };
}
async function rawPost(p, body) {
  checkOverall(`POST ${p}`);
  const r = await fetch(BASE + p, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { http: r.status, json: j };
}
function needHttp(res, ok, code, label) {
  if (!ok.includes(res.http)) throw coded(code, `${label} http=${res.http}`);
}
const sessOf = (j) => (j && (j.session !== undefined ? j.session : (j.data || j))) || null;
const runOf = (j) => (j && (j.run || j.data || j)) || null;
const convOf = (j) => (j && (j.conversation || j.data || j)) || null;

function loadCkpt() {
  try {
    if (!fs.existsSync(CKPT_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
    if (!c || c.wsId !== WS_ID || c.testId !== TEST_ID) return null;
    return c;
  } catch { return null; }
}
function saveCkpt(c) { const tmp = CKPT_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n'); fs.renameSync(tmp, CKPT_PATH); }
function markerOf(ckpt) {
  const m = (process.env.WHIPPET_M9_MARKER || (ckpt && ckpt.marker) || '').trim();
  if (m) return m.slice(0, 120);
  const rand = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `[M9-HIST-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${rand}]`;
}
async function pickBase() {
  for (const b of [...new Set(BASE_CANDIDATES)]) {
    try {
      const r = await fetch(b.replace(/\/$/, '') + `/api/workspaces/${WS_ID}`, { method: 'GET', headers: { Accept: 'application/json' } });
      if (r.status === 200) { BASE = b.replace(/\/$/, ''); return; }
    } catch {}
  }
}
function recordEffective(ckpt, run) {
  if (!run || !run.id) return;
  ckpt.models = ckpt.models || {};
  ckpt.models[run.id] = {
    id: run.id,
    status: run.status ?? null,
    effectiveModel: run.effectiveModel ?? run.effective_model ?? null,
    model: run.model ?? null,
    provider: run.provider ?? null,
    authorMode: run.authorMode ?? run.author_mode ?? null,
    skillId: (run.author && run.author.skillId) ?? run.skillId ?? null,
    workspaceId: run.workspaceId ?? run.workspace_id ?? null,
    testId: run.testId ?? run.test_id ?? null,
    editingSessionId: run.editingSessionId ?? run.editing_session_id ?? run.sessionId ?? null,
    rawKeys: Object.keys(run).sort().slice(0, 60),
  };
}
async function pollRun(ckpt, runId, label) {
  const start = Date.now();
  for (;;) {
    checkOverall(`poll-${label}`);
    if (Date.now() - start > RUN_MS) throw coded('E_RUN_TIMEOUT', `${label} run=${runId}`);
    await sleep(POLL_MS);
    const r = await rawGet(`/api/runs/${encodeURIComponent(runId)}`);
    needHttp(r, [200], 'E_RUN_HTTP', label);
    const run = runOf(r.json);
    if (!run || !run.status) throw coded('E_RUN_STATUS', label);
    recordEffective(ckpt, run);
    saveCkpt(ckpt);
    console.log(`${label} run=${runId} status=${run.status}`);
    if (['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(run.status)) return run;
  }
}
async function getDraftRevision() {
  const r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
  needHttp(r, [200], 'E_SESSION_HTTP', 'editing-session');
  const sess = sessOf(r.json);
  const d = (sess && sess.draft) || null;
  if (!sess || !sess.id || !d || typeof d.revision !== 'number') throw coded('E_SESSION_SHAPE', 'draft.revision');
  return { sess, rev: d.revision };
}
// 每輪：已有 runId 則只 GET+poll（不重 POST）；否則取新 revision POST 後即存 id 再 poll。串行呼叫。
async function roundOnce(ckpt, key, content) {
  if (ckpt.runs[key]) {
    console.log(`[${key}] resume run=${ckpt.runs[key]} (no re-POST)`);
    const run = await pollRun(ckpt, ckpt.runs[key], key);
    if (run.status !== (CANCEL_FIXTURE && key !== 'final' ? 'cancelled' : 'succeeded')) throw coded('E_RUN_FAILED', `${key} status=${run.status}`);
    return run;
  }
  const { rev } = await getDraftRevision();
  if (ckpt.sessionId) {
    const s = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    const cur = sessOf(s.json);
    if (!cur || cur.id !== ckpt.sessionId) throw coded('E_SESSION_MISMATCH', key);
  }
  const r = await rawPost(`/api/tests/${encodeURIComponent(TEST_ID)}/messages`, { editingSessionId: ckpt.sessionId, revision: rev, content });
  needHttp(r, [200, 202], 'E_MSG_HTTP', key);
  const prun = runOf(r.json);
  const runId = (prun && prun.id) || r.json.runId || r.json.id;
  if (!runId) throw coded('E_MSG_NORUN', key);
  ckpt.runs[key] = runId;
  saveCkpt(ckpt);
  console.log(`[${key}] queued run=${runId} rev=${rev}`);
  if (CANCEL_FIXTURE && key !== 'final') {
    if (prun.status !== 'queued') throw coded('E_FIXTURE_DISPATCHED', key);
    const cancelled = await rawPost(`/api/runs/${runId}/cancel`, {});
    needHttp(cancelled, [200, 202], 'E_CANCEL_HTTP', key);
    if (runOf(cancelled.json).status !== 'cancelled') throw coded('E_CANCEL_STATE', key);
  }
  const run = await pollRun(ckpt, runId, key);
  if (run.status !== (CANCEL_FIXTURE && key !== 'final' ? 'cancelled' : 'succeeded')) throw coded('E_RUN_FAILED', `${key} status=${run.status}`);
  return run;
}

async function main() {
  if (!TEST_ID) throw coded('E_TEST_CREATE_GAP', 'WHIPPET_TEST_ID 缺失：Test 建立 API 不在 v7/v8/v9＋continuity 已證實端點內，不猜 POST /api/tests；請 PM 經公開 API 預建專用 Test 後傳入');
  if (TEST_ID === ORIG_TEST_ID) throw coded('E_ORIGINAL_TEST_REFUSE', '不得動原 Test');
  await pickBase();
  console.log(`[m9-history] base=${BASE} out=${EV_DIR} ws=${WS_ID} test=${TEST_ID}`);
  let ckpt = loadCkpt();
  if (ckpt) console.log(`[m9-history] resume marker=${ckpt.marker} runs=${JSON.stringify(Object.keys(ckpt.runs || {}))}`);
  if (!ckpt) { ckpt = { wsId: WS_ID, testId: TEST_ID, marker: markerOf(null), runs: {}, models: {}, stages: {} }; saveCkpt(ckpt); }
  if (!ckpt.marker) { ckpt.marker = markerOf(ckpt); saveCkpt(ckpt); }
  if (!ckpt.runs) ckpt.runs = {};
  if (!ckpt.models) ckpt.models = {};
  if (!ckpt.stages) ckpt.stages = {};
  const MARKER = ckpt.marker;
  console.log(`[m9-history] marker=${MARKER}`);

  if (!ckpt.stages.baseline) {
    let r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(r, [200], 'E_WORKSPACE_HTTP', 'workspace');
    const w = (r.json && (r.json.workspace || r.json.data || r.json)) || null;
    if (!w || w.id !== WS_ID) throw coded('E_WORKSPACE_SHAPE', 'workspace');
    r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}`);
    if (r.http === 404) throw coded('E_TEST_CREATE_GAP', 'Test 不存在且建立 API 不明，不猜建 Test；請 PM 經公開 API 建專用 Test');
    needHttp(r, [200], 'E_TEST_HTTP', 'test');
    const t = (r.json && (r.json.test || r.json.data || r.json)) || null;
    if (!t || !t.id) throw coded('E_TEST_SHAPE', 'test');
    const ownerWs = t.workspaceId ?? t.workspace_id ?? t.workspaceID ?? null;
    if (ownerWs && ownerWs !== WS_ID) throw coded('E_TEST_OWNER', 'workspace');
    r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    let sess = null;
    if (r.http === 200) sess = sessOf(r.json);
    if (r.http === 404 || (r.http === 200 && !sess)) {
      const c = await rawPost(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`, {});
      needHttp(c, [200, 201], 'E_SESSION_START_HTTP', 'editing-session');
      sess = sessOf(c.json);
    } else if (r.http !== 200) throw coded('E_SESSION_GET_HTTP', `http=${r.http}`);
    if (!sess || !sess.id) throw coded('E_SESSION_SHAPE', 'editing-session');
    ckpt.sessionId = sess.id;
    ckpt.baseline = { sessionId: sess.id, draftRevision: sess.draft ? sess.draft.revision : null, workspaceRevision: w.revision ?? null };
    ckpt.stages.baseline = true;
    saveCkpt(ckpt);
    console.log(`[m9-history] PASS baseline session=${sess.id}`);
  }
  const SESSION_ID = ckpt.sessionId;

  if (!ckpt.stages.r0) {
    const content = `記住合成決策 ${MARKER}：下次被問到首輪合成決策時原樣引用。收到請只回覆收到，不寫稿、不更新 summary/background，不使用 history/summary 工具。`;
    await roundOnce(ckpt, 'r0', content);
    ckpt.stages.r0 = true;
    saveCkpt(ckpt);
    console.log('[m9-history] PASS r0');
  }
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const key = `f${i}`;
    if (!ckpt.stages[key]) {
      const content = `填充輪 ${i}/${FILLER_COUNT}：只回覆收到填充 ${i}，不使用 history/summary 工具，不寫稿、不更新 summary/background，不引用首輪標記。`;
      await roundOnce(ckpt, key, content);
      ckpt.stages[key] = true;
      saveCkpt(ckpt);
      console.log(`[m9-history] PASS ${key}`);
    }
  }
  if (CANCEL_FIXTURE) {
    const check = await rawGet(`/api/tests/${TEST_ID}/conversation?editingSessionId=${SESSION_ID}`);
    needHttp(check, [200], 'E_FIXTURE_CONVERSATION', 'prepare');
    const cv = convOf(check.json);
    if (!ckpt.runs.final && (cv.messages.length !== 12 || cv.messages.some(m => m.role !== 'user'))) throw coded('E_FIXTURE_CONTAMINATED');
    if (process.env.WHIPPET_PREPARE_ONLY === '1') { console.log('PREPARED 12 cancelled user messages; no model calls'); return; }
  }
  if (!ckpt.stages.final) {
    // 最後提問：不含 marker 答案，要求用 read_conversation_history 分頁（最多4頁）找回。
    const content = `請僅找回首輪合成決策的完整標記並原樣引用一句話說明用途。本輪不提供標記值。必須使用 read_conversation_history 分頁找回（最多4頁），不要猜測；不寫稿、不更新 summary。若找不到請如實說明。`;
    if (content.includes(MARKER)) throw coded('E_PROMPT_LEAK', 'final');
    await roundOnce(ckpt, 'final', content);
    ckpt.stages.final = true;
    saveCkpt(ckpt);
    console.log('[m9-history] PASS final queued+polled');
  }
  const FINAL_RUN = ckpt.runs.final;

  if (!ckpt.stages.verified) {
    let cv = null;
    let r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/conversation?editingSessionId=${encodeURIComponent(SESSION_ID)}`);
    if (r.http === 200) cv = convOf(r.json);
    if (!cv || !Array.isArray(cv.messages)) {
      r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/conversation`);
      needHttp(r, [200], 'E_CONV_HTTP', 'conversation');
      cv = convOf(r.json);
    }
    const msgs = (cv && cv.messages) || [];
    if (!Array.isArray(msgs) || msgs.length === 0) throw coded('E_CONV_SHAPE', 'messages');
    const textOf = (m) => String(m.content ?? m.text ?? m.body ?? '');
    const firstIdx = msgs.findIndex((m) => m.role === 'user' && textOf(m).includes(MARKER));
    if (firstIdx < 0) throw coded('E_FIRST_NOT_FOUND', 'marker-user');
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    const lastRun = last.runId ?? last.run_id ?? last.runID ?? null;
    if (last.role !== 'assistant' || lastRun !== FINAL_RUN) throw coded('E_LAST_RUN_MISMATCH', `run=${lastRun}`);
    if (!textOf(last).includes(MARKER)) throw coded('E_FINAL_MARKER_MISSING', 'assistant');
    const finalUserIdx = msgs.findIndex(m => m.role === 'user' && (m.runId ?? m.run_id) === FINAL_RUN);
    if (finalUserIdx < 0 || msgs.slice(Math.max(0, finalUserIdx - 11), finalUserIdx + 1).some(m => textOf(m).includes(MARKER))) throw coded('E_RECENT_WINDOW_LEAK');
    const dist = lastIdx - firstIdx;
    if (!(dist >= 12)) throw coded('E_DISTANCE_SHORT', `dist=${dist}`);
    ckpt.verified = { firstIdx, lastIdx, dist, finalRunId: FINAL_RUN, conversationLen: msgs.length, firstSeq: msgs[firstIdx].sequence ?? null, lastSeq: last.sequence ?? null };
    ckpt.stages.verified = true;
    saveCkpt(ckpt);
    console.log(`[m9-history] PASS verify dist=${dist} len=${msgs.length}`);
  }

  const runsEvidence = { base: BASE, workspaceId: WS_ID, testId: TEST_ID, sessionId: SESSION_ID, marker: MARKER, runs: ckpt.runs, models: ckpt.models, verified: ckpt.verified || null };
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runsEvidence, null, 2) + '\n');
  const summary = {
    pass: true, verdict: 'public_checks_pass', scope: 'public_conversation_only', historyIntegrationVerified: false, base: BASE, workspaceId: WS_ID, testId: TEST_ID, sessionId: SESSION_ID,
    marker: MARKER, runs: ckpt.runs, models: ckpt.models, verified: ckpt.verified,
    disclaimer: '公開 conversation 僅驗最後 assistant/runId 答 marker 及首訊息距離>=12；單靠此不聲稱 history 成功。預設 payload 不含 marker 與工具事件由 PM 另行核對。',
    evidenceDir: EV_DIR, checkpoint: CKPT_PATH, runsEvidence: RUNS_PATH,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
  console.log(`DONE pass session=${SESSION_ID} dist=${ckpt.verified.dist} finalRun=${FINAL_RUN}`);
}

main().catch((e) => {
  const code = (e && e.code) || 'E_UNKNOWN';
  try {
    const diag = { pass: false, verdict: 'fail', code, workspaceId: WS_ID, testId: TEST_ID || null, base: BASE, evidenceDir: EV_DIR, checkpoint: CKPT_PATH };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(diag, null, 2) + '\n');
  } catch {}
  console.error(`FAIL: ${code}`);
  process.exit(1);
});
