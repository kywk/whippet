#!/usr/bin/env node
// M9 設定變更與續編黑箱（parent=t3v，全新黑箱QA）。
// 唯一 owner：scripts/test/m9-settings-continuity.cjs 與 /private/tmp/whippet-m9-settings-evidence。
// 固定對象：Workspace 95296031-b243-4bb6-b964-e90dd8af4bb5、Test cea8a396-da05-4517-b877-47add4733cfb、已發布 Version fac81dbf-d7d1-4ace-a4c5-8c902828556f。
// 真 AI 探索/產稿/驗證/摘要/UI 發布/正式 Run/監看/刪除已 PASS 不重跑；不撤銷 M8 既有 role；撤銷許可另交 PM 隔離案例。
// 本腳本只做一筆可恢復合成 backgroundSummary marker 變更提案（其餘 origin/角色/timeout/defaultURL 不變）：
//   先正常開始新 editingSession 存 baseline；公開 workspace messages 要求只改背景帶 marker→等真提案→核對不擴 scope→confirm；
//   斷言既有 active draft revision 遞增、workspaceContext 採新背景/新 revision、validation/summary 失效，而原 Version 內容不變；
//   再以同 session 真 AI 對話問 marker，核對 run 使用新背景（可選不產稿，只驗背景接線）。
// 只用公開 API＋Node 內建 fetch，不安裝/部署/Git/子 agent；不讀產品源碼/DB/journal/deploy/.env.ai/真憑證；錯誤只記固定 code，不印完整 body 或帳密。
// PM 在 18087 既有容器執行：WEB_URL=http://127.0.0.1:18087 WHIPPET_EVIDENCE_DIR=/private/tmp/whippet-m9-settings-evidence node scripts/test/m9-settings-continuity.cjs
// 模型：Muse/xhigh（Server 端真 AI，本腳本不直連模型）。可 resume：同 evidence 下 m9-checkpoint.json，避免重複模型呼叫/變更。
// 端點來源：contracts/mvp-v7.md、v8.md、v9.md 與既有 scripts/test（m7-editing-ui、m8-workspace-ui、m8-workspace-author-live、m8-real-publish-ui 等）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WS_ID = (process.env.WHIPPET_WORKSPACE_ID || '95296031-b243-4bb6-b964-e90dd8af4bb5').trim();
const TEST_ID = (process.env.WHIPPET_TEST_ID || 'cea8a396-da05-4517-b877-47add4733cfb').trim();
const VERSION_ID = (process.env.WHIPPET_VERSION_ID || 'fac81dbf-d7d1-4ace-a4c5-8c902828556f').trim();
const BASE_CANDIDATES = [];
{
  const b = (process.env.BASE_URL || process.env.WHIPPET_BASE_URL || process.env.WEB_URL || 'http://127.0.0.1:18087').replace(/\/$/, '');
  BASE_CANDIDATES.push(b);
  if (b.includes('127.0.0.1')) BASE_CANDIDATES.push(b.replace('127.0.0.1', 'localhost'));
  if (b.includes('localhost')) BASE_CANDIDATES.push(b.replace('localhost', 'host.docker.internal'));
  if (!b.includes('host.docker.internal')) BASE_CANDIDATES.push('http://host.docker.internal:18087');
}
for (const bad of ['18080', '18085', '18086']) {
  if ((BASE_CANDIDATES[0] || '').includes(bad)) throw new Error('FAIL E_BASE_URL 舊環境拒跑');
}
let EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || process.env.OUT_DIR || '/private/tmp/whippet-m9-settings-evidence';
try { fs.mkdirSync(EV_DIR, { recursive: true }); } catch { EV_DIR = '/tmp/whippet-m9-settings-evidence'; fs.mkdirSync(EV_DIR, { recursive: true }); }
const CKPT_PATH = path.join(EV_DIR, 'm9-checkpoint.json');
const RESULT_PATH = path.join(EV_DIR, 'm9-result.json');
const OVERALL_MS = Number(process.env.WHIPPET_M9_OVERALL_MS || 30 * 60 * 1000);
const RUN_MS = Number(process.env.WHIPPET_M9_RUN_MS || 600 * 1000);
const PROPOSAL_MS = Number(process.env.WHIPPET_M9_PROPOSAL_MS || 300 * 1000);
const POLL_MS = 5000;
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
function stable(o) {
  if (o === null || o === undefined) return 'null';
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
function hashObj(o) { return sha256(stable(o)); }
function normSet(arr) { return [...new Set((arr || []).map((s) => String(s ?? '').trim()))].sort(); }

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
const wsOf = (j) => (j && (j.workspace || j.data || j)) || null;
const sessOf = (j) => (j && (j.session !== undefined ? j.session : (j.data || j))) || null;
const runOf = (j) => (j && (j.run || j.data || j)) || null;
const convOf = (j) => (j && (j.conversation || j.data || j)) || null;
const propOf = (j) => (j && (j.proposal || j.data || j)) || null;

function loadCkpt() {
  try {
    if (!fs.existsSync(CKPT_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
    if (!c || c.wsId !== WS_ID || c.testId !== TEST_ID || c.versionId !== VERSION_ID) return null;
    return c;
  } catch { return null; }
}
function saveCkpt(c) { fs.writeFileSync(CKPT_PATH, JSON.stringify(c, null, 2) + '\n'); }
function markerOf(ckpt) {
  const m = (process.env.WHIPPET_M9_MARKER || (ckpt && ckpt.marker) || '').trim();
  if (m) return m.slice(0, 120);
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `[M9-CONT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${rand}]`;
}

async function pickBase() {
  for (const b of [...new Set(BASE_CANDIDATES)]) {
    try {
      const r = await fetch(b.replace(/\/$/, '') + `/api/workspaces/${WS_ID}`, { method: 'GET', headers: { Accept: 'application/json' } });
      if (r.status === 200) { BASE = b.replace(/\/$/, ''); return; }
    } catch {}
  }
}

async function pollRun(runId, label, maxMs) {
  const start = Date.now();
  for (;;) {
    checkOverall(`poll-${label}`);
    if (Date.now() - start > maxMs) throw coded('E_RUN_TIMEOUT', `${label} run=${runId}`);
    await sleep(POLL_MS);
    const r = await rawGet(`/api/runs/${encodeURIComponent(runId)}`);
    needHttp(r, [200], 'E_RUN_HTTP', label);
    const run = runOf(r.json);
    const st = run && run.status;
    if (!st) throw coded('E_RUN_STATUS', label);
    console.log(`${label} run=${runId} status=${st}`);
    if (['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(st)) return run;
  }
}
async function pollProposalWithMarker(marker, maxMs) {
  const start = Date.now();
  let last = null;
  for (;;) {
    checkOverall('poll-proposal');
    if (Date.now() - start > maxMs) throw coded('E_PROPOSAL_TIMEOUT', `marker=${marker.slice(0, 40)}`);
    await sleep(POLL_MS);
    const r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(r, [200], 'E_WORKSPACE_HTTP', 'poll-proposal');
    const w = wsOf(r.json);
    const cp = w && (w.currentProposal || w.proposal || null);
    last = cp && cp.id ? cp.id : last;
    if (cp && cp.id && cp.content && typeof cp.content.backgroundSummary === 'string' && cp.content.backgroundSummary.includes(marker)) {
      return { workspace: w, proposal: cp };
    }
  }
}

function assertScopeUnchanged(baseCfg, propCfg, marker) {
  const diff = (k) => { throw coded('E_SCOPE_EXPANDED', k); };
  if (!propCfg || typeof propCfg !== 'object') throw coded('E_PROPOSAL_SHAPE', 'content');
  const strip = ({backgroundSummary,...rest}) => rest;
  if(stable(strip(baseCfg))!==stable(strip(propCfg))) throw coded('E_SCOPE_EXPANDED','non-background fields differ');
  if ((baseCfg.name || '') !== (propCfg.name || '')) diff('name');
  if ((baseCfg.purpose || '') !== (propCfg.purpose || '')) diff('purpose');
  const tgt = (c) => normSet((c.targets || []).map((t) => t.origin));
  const dep = (c) => normSet((c.dependencies || []).map((t) => t.origin));
  if (JSON.stringify(tgt(baseCfg)) !== JSON.stringify(tgt(propCfg))) diff('targets');
  if (JSON.stringify(dep(baseCfg)) !== JSON.stringify(dep(propCfg))) diff('dependencies');
  if (JSON.stringify(normSet(baseCfg.excludedOrigins)) !== JSON.stringify(normSet(propCfg.excludedOrigins))) diff('excludedOrigins');
  if ((baseCfg.exclusions || '') !== (propCfg.exclusions || '')) diff('exclusions');
  if ((baseCfg.defaultTestUrl || '') !== (propCfg.defaultTestUrl || '')) diff('defaultTestUrl');
  if (Number(baseCfg.timeoutMs) !== Number(propCfg.timeoutMs)) diff('timeoutMs');
  const lrBase = normSet((baseCfg.loginRoles || []).map((r) => r.loginOrigin));
  const lrProp = normSet((propCfg.loginRoles || []).map((r) => r.loginOrigin));
  if ((baseCfg.loginRoles || []).length !== (propCfg.loginRoles || []).length) diff('loginRoles-count');
  if (JSON.stringify(lrBase) !== JSON.stringify(lrProp)) diff('loginRoles-origin');
  const bg = String(propCfg.backgroundSummary || '');
  if (!bg.includes(marker)) throw coded('E_PROPOSAL_MARKER', 'backgroundSummary');
  if (Buffer.byteLength(bg, 'utf8') > 8192) throw coded('E_PROPOSAL_LIMIT', 'backgroundSummary-bytes');
}

function draftInfoFromSession(sess) {
  const d = (sess && sess.draft) || null;
  return d;
}

async function main() {
  await pickBase();
  console.log(`[m9] base=${BASE} out=${EV_DIR} ws=${WS_ID} test=${TEST_ID} ver=${VERSION_ID}`);
  let ckpt = loadCkpt();
  if (ckpt) console.log(`[m9] resume checkpoint stages=${JSON.stringify(ckpt.stages || {})} marker=${ckpt.marker}`);
  if (!ckpt) { ckpt = { wsId: WS_ID, testId: TEST_ID, versionId: VERSION_ID, marker: markerOf(null), stages: {} }; saveCkpt(ckpt); }
  if (!ckpt.marker) { ckpt.marker = markerOf(ckpt); saveCkpt(ckpt); }
  const MARKER = ckpt.marker;
  console.log(`[m9] marker=${MARKER}`);

  // 0. baseline：公開 GET＋正常 start 新 editingSession（冪等 resume），保存 hashes。
  if (!ckpt.stages.baseline) {
    let r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(r, [200], 'E_BASELINE_WORKSPACE_HTTP', 'workspace');
    const w0 = wsOf(r.json);
    if (!w0 || !w0.id) throw coded('E_BASELINE_WORKSPACE_SHAPE', 'workspace');
    const baseWsRev = w0.revision;
    const baseCfg = w0.settings || w0.config || null;
    if (!baseCfg) throw coded('E_BASELINE_SETTINGS_NULL', `rev=${baseWsRev}`);
    r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}`);
    needHttp(r, [200], 'E_BASELINE_TEST_HTTP', 'test');
    const t0b = (r.json && (r.json.test || r.json)) || null;
    if (!t0b || !t0b.id) throw coded('E_BASELINE_TEST_SHAPE', 'test');
    r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/versions`);
    needHttp(r, [200], 'E_BASELINE_VERSIONS_HTTP', 'versions');
    const items = (r.json && r.json.items) || [];
    const ver = items.find((v) => v.id === VERSION_ID);
    if (!ver) throw coded('E_VERSION_NOT_FOUND', `count=${items.length}`);
    const verSnap = {
      scriptHash: sha256(ver.script || ''),
      scriptLen: String(ver.script || '').length,
      settingsHash: hashObj(ver.workspaceSettings ?? ver.settings ?? ver.workspace_settings ?? null),
      contextHash: hashObj(ver.workspaceContext ?? ver.workspace_context ?? null),
      description: ver.description ?? null,
      backgroundSummary: ver.backgroundSummary ?? ver.background_summary ?? null,
    };
    let sess = null;
    r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    if (r.http === 200) sess = sessOf(r.json);
    else if (r.http !== 404) throw coded('E_SESSION_GET_HTTP', `http=${r.http}`);
    if (sess && sess.id) {
      console.log(`[m9] reuse active session id=${sess.id}`);
    } else {
      r = await rawPost(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`, {});
      needHttp(r, [200, 201], 'E_SESSION_START_HTTP', 'editing-session');
      sess = sessOf(r.json);
      if (!sess || !sess.id) throw coded('E_SESSION_SHAPE', 'editing-session');
      console.log(`[m9] start session id=${sess.id} http=${r.http}`);
    }
    const d0 = draftInfoFromSession(sess);
    if (!d0 || typeof d0.revision !== 'number') throw coded('E_BASELINE_DRAFT_SHAPE', 'draft.revision');
    ckpt.baseline = {
      workspaceRevision: baseWsRev,
      settingsHash: hashObj(baseCfg),
      backgroundLen: String(baseCfg.backgroundSummary || '').length,
      sessionId: sess.id,
      draftRevision: d0.revision,
      draftScriptHash: sha256(d0.script || ''),
      versionSnap: verSnap,
    };
    ckpt.sessionId = sess.id;
    ckpt.stages.baseline = true;
    saveCkpt(ckpt);
    console.log(`[m9] PASS baseline wsRev=${baseWsRev} draftRev=${d0.revision} ver=${VERSION_ID}`);
  }
  const BASE_WS_REV = ckpt.baseline.workspaceRevision;
  const BASE_DRAFT_REV = ckpt.baseline.draftRevision;
  const SESSION_ID = ckpt.sessionId || ckpt.baseline.sessionId;

  // 1. workspace 提案：公開 messages 一筆（若已做則跳過，避免重複模型呼叫）。
  if (!ckpt.stages.proposed) {
    let r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(r, [200], 'E_WORKSPACE_HTTP', 'workspace-pre');
    const w = wsOf(r.json);
    const rev = w.revision;
    let ctxRev = 0;
    try {
      const c = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}/conversation`);
      if (c.http === 200) { const cv = convOf(c.json); if (cv && typeof cv.contextRevision === 'number') ctxRev = cv.contextRevision; }
    } catch {}
    const content = `請提出新的 WorkspaceConfig 候選，唯一變更為 backgroundSummary 尾端換行追加下列 marker 行，其餘逐字保留（name、purpose、targets、dependencies、excludedOrigins、exclusions、loginRoles、defaultTestUrl、timeoutMs 皆不變，不新增 origin/角色）：\nMARKER: ${MARKER}\n背景原文保留，僅追加「[M9 接續標記 ${MARKER}] 合成驗證用，不改範圍。」若無法只改背景，請回覆說明而不產生提案。帳密由專用欄位保存，不在訊息中提供。`;
    r = ckpt.workspaceRunId ? await rawGet(`/api/runs/${ckpt.workspaceRunId}`) : await rawPost(`/api/workspaces/${encodeURIComponent(WS_ID)}/messages`, { content, revision: rev, contextRevision: ctxRev });
    needHttp(r, [200, 202], 'E_WORKSPACE_MSG_HTTP', 'workspace-messages');
    const prun = runOf(r.json);
    const runId = (prun && prun.id) || r.json.runId || r.json.id;
    if (!runId) throw coded('E_WORKSPACE_MSG_NORUN', 'messages');
    ckpt.workspaceRunId = runId;
    saveCkpt(ckpt);
    console.log(`[m9] workspace run=${runId} rev=${rev} ctxRev=${ctxRev}`);
    const wrun = await pollRun(runId, 'workspace-author', RUN_MS);
    if (wrun.status !== 'succeeded') throw coded('E_WORKSPACE_RUN_FAILED', `status=${wrun.status}`);
    if (wrun.testId !== null && wrun.testId !== undefined) throw coded('E_WORKSPACE_RUN_OWNER', 'testId');
    const { proposal } = await pollProposalWithMarker(MARKER, PROPOSAL_MS);
    if (!proposal || !proposal.id) throw coded('E_PROPOSAL_MISSING', 'proposal');
    ckpt.proposalId = proposal.id;
    ckpt.proposalBaseRevision = proposal.baseRevision ?? rev;
    ckpt.stages.proposed = true;
    saveCkpt(ckpt);
    console.log(`[m9] PASS proposal id=${proposal.id}`);
  }
  const PROPOSAL_ID = ckpt.proposalId;

  // 2. 核對不擴 scope→confirm（若已做則跳過，避免重複變更）。
  if (!ckpt.stages.confirmed) {
    let r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(r, [200], 'E_WORKSPACE_HTTP', 'workspace-confirm-pre');
    const wPre = wsOf(r.json);
    // 取當前 settings（尚未 confirm 故仍為舊值）作逐欄比對；若已被外部變更則直接 FAIL，不自動合併
    if (wPre.revision !== BASE_WS_REV) throw coded('E_WORKSPACE_CHANGED', `rev=${wPre.revision}`);
    let prop = (wPre.currentProposal && wPre.currentProposal.id === PROPOSAL_ID) ? wPre.currentProposal : null;
    if (!prop) {
      r = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}/proposals/${encodeURIComponent(PROPOSAL_ID)}`);
      needHttp(r, [200], 'E_PROPOSAL_HTTP', 'proposal');
      prop = propOf(r.json);
    }
    if (!prop || !prop.content) throw coded('E_PROPOSAL_SHAPE', 'proposal');
    // 以提案前 workspace 設定為基準（若 revision 已前進則取當前 settings 仍須通過 marker 檢查＋scope 比對由 baseline hashes 輔助）
    const baseR = await rawGet(`/api/workspaces/${encodeURIComponent(WS_ID)}`);
    needHttp(baseR, [200], 'E_WORKSPACE_HTTP', 'workspace-base');
    const wBase = wsOf(baseR.json);
    // baseline settings 已在 checkpoint 以 hash 保存；此處取當前 settings（尚未 confirm 故仍為舊值）作逐欄比對
    assertScopeUnchanged(wBase.settings || wBase.config, prop.content, MARKER);
    console.log('[m9] PASS scope-unchanged');
    const baseRev = prop.baseRevision ?? BASE_WS_REV;
    r = await rawPost(`/api/workspaces/${encodeURIComponent(WS_ID)}/proposals/${encodeURIComponent(PROPOSAL_ID)}/confirm`, { baseRevision: baseRev, confirmed: true });
    needHttp(r, [200], 'E_CONFIRM_HTTP', 'proposal-confirm');
    const cw = wsOf((r.json && (r.json.workspace || r.json)) || r.json);
    const newRev = (cw && cw.revision) || (wBase.revision + 1);
    if (!(newRev === BASE_WS_REV + 1)) throw coded('E_CONFIRM_REVISION', `rev=${newRev}`);
    ckpt.confirmedWorkspaceRevision = newRev;
    ckpt.stages.confirmed = true;
    saveCkpt(ckpt);
    console.log(`[m9] PASS confirm rev=${newRev}`);
  }
  const NEW_WS_REV = ckpt.confirmedWorkspaceRevision;

  // 3. 續編斷言：draft 遞增、context 採新背景/新 revision、validation/summary 失效；原 Version 不變。
  if (!ckpt.stages.continuity) {
    const r = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    needHttp(r, [200], 'E_SESSION_HTTP', 'editing-session');
    const sess = sessOf(r.json);
    if (!sess || sess.id !== SESSION_ID) throw coded('E_SESSION_MISMATCH', 'session');
    const d = draftInfoFromSession(sess);
    if (!d || typeof d.revision !== 'number') throw coded('E_DRAFT_SHAPE', 'draft');
    if (!(d.revision === BASE_DRAFT_REV + 1)) throw coded('E_DRAFT_REVISION', `rev=${d.revision}`);
    const wctx = d.workspaceContext || d.workspace_context || sess.workspaceContext || sess.workspace_context || null;
    const cfg = (wctx && (wctx.config || wctx.workspaceConfig)) || d.workspaceConfig || null;
    const bg = cfg ? String(cfg.backgroundSummary ?? cfg.background_summary ?? '') : '';
    const srev = wctx ? (wctx.settingsRevision ?? wctx.settings_revision) : (d.settingsRevision ?? d.settings_revision ?? d.workspaceRevision ?? null);
    if (!bg.includes(MARKER)) throw coded('E_WORKSPACE_CONTEXT', 'background');
    if (Number(srev) !== Number(NEW_WS_REV)) throw coded('E_WORKSPACE_CONTEXT', 'settingsRevision');
    const sum = sess.summary || sess.draftSummary || null;
    const sumValid = sum ? (sum.validForCurrentDraft ?? sum.valid_for_current_draft ?? sum.valid) : false;
    if (d.validationRunId != null || d.validationStatus != null) throw coded('E_VALIDATION_NOT_INVALID','draft');
    if (sumValid === true) throw coded('E_SUMMARY_NOT_INVALID', 'summary');
    const vr = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/versions`);
    needHttp(vr, [200], 'E_VERSIONS_HTTP', 'versions');
    const vitems = (vr.json && vr.json.items) || [];
    const vv = vitems.find((v) => v.id === VERSION_ID);
    if (!vv) throw coded('E_VERSION_NOT_FOUND', 'versions');
    const nowSnap = {
      scriptHash: sha256(vv.script || ''),
      settingsHash: hashObj(vv.workspaceSettings ?? vv.settings ?? vv.workspace_settings ?? null),
      contextHash: hashObj(vv.workspaceContext ?? vv.workspace_context ?? null),
    };
    const baseSnap = ckpt.baseline.versionSnap;
    if (nowSnap.scriptHash !== baseSnap.scriptHash) throw coded('E_VERSION_CHANGED', 'script');
    if (nowSnap.settingsHash !== baseSnap.settingsHash) throw coded('E_VERSION_CHANGED', 'settings');
    if (nowSnap.contextHash !== baseSnap.contextHash) throw coded('E_VERSION_CHANGED', 'context');
    ckpt.stages.continuity = true;
    ckpt.continuityDraftRevision = d.revision;
    saveCkpt(ckpt);
    console.log(`[m9] PASS continuity draftRev=${d.revision} wsRev=${srev}`);
  }

  // 4. 同 session 真 AI 對話問 marker：核對 run 使用新背景（可選不產稿，只驗接線）。
  if (!ckpt.stages.dialog) {
    const pre = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    needHttp(pre, [200], 'E_SESSION_HTTP', 'editing-session-pre');
    const preSess = sessOf(pre.json);
    const preRev = draftInfoFromSession(preSess).revision;
    const content = `請從目前 Workspace 背景找出 M9 接續標記，原樣引用完整標記並用一句話說明其用途。本訊息不提供標記值。不修改腳本、不請求驗證、不產生新提案。`;
    const r = ckpt.continuityRunId ? await rawGet(`/api/runs/${ckpt.continuityRunId}`) : await rawPost(`/api/tests/${encodeURIComponent(TEST_ID)}/messages`, { editingSessionId: SESSION_ID, revision: preRev, content });
    needHttp(r, [200, 202], 'E_DIALOG_MSG_HTTP', 'test-messages');
    const drun = runOf(r.json);
    const runId = (drun && drun.id) || r.json.runId || r.json.id;
    if (!runId) throw coded('E_DIALOG_NORUN', 'messages');
    ckpt.continuityRunId = runId;
    saveCkpt(ckpt);
    console.log(`[m9] dialog run=${runId} rev=${preRev}`);
    const run = await pollRun(runId, 'test-author', RUN_MS);
    if (run.status !== 'succeeded') throw coded('E_DIALOG_RUN_FAILED', `status=${run.status}`);
    const rctx = run.workspaceContext || run.workspace_context || run.context || null;
    const rcfg = (rctx && (rctx.config || rctx.workspaceConfig)) || null;
    const rbg = rcfg ? String(rcfg.backgroundSummary ?? rcfg.background_summary ?? '') : '';
    const rr = rctx ? (rctx.settingsRevision ?? rctx.settings_revision) : null;
    if (!rbg.includes(MARKER)) throw coded('E_DIALOG_CONTEXT', 'background');
    if (Number(rr) !== Number(NEW_WS_REV)) throw coded('E_DIALOG_CONTEXT', 'settingsRevision');
    const runSess = run.editingSessionId ?? run.editing_session_id ?? run.sessionId ?? run.session_id ?? null;
    if (runSess && runSess !== SESSION_ID) throw coded('E_DIALOG_OWNER', 'session');
    // 訊息含 marker（背景接線證據；只記有無，不印全文）
    let hasMarkerMsg = false;
    try {
      const c = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/conversation?editingSessionId=${encodeURIComponent(SESSION_ID)}`);
      if (c.http === 200) {
        const cv = convOf(c.json);
        const msgs = (cv && cv.messages) || [];
        hasMarkerMsg = msgs.some((m) => m.role === 'assistant' && m.runId === runId && String(m.content || m.text || '').includes(MARKER));
      }
    } catch {}
    if (!hasMarkerMsg) {
      try {
        const c2 = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/conversation`);
        if (c2.http === 200) {
          const cv2 = convOf(c2.json);
          const msgs2 = (cv2 && cv2.messages) || [];
          hasMarkerMsg = msgs2.some((m) => m.role === 'assistant' && m.runId === runId && String(m.content || m.text || '').includes(MARKER));
        }
      } catch {}
    }
    if (!hasMarkerMsg) throw coded('E_DIALOG_MARKER_MISSING', 'conversation');
    const post = await rawGet(`/api/tests/${encodeURIComponent(TEST_ID)}/editing-session`);
    needHttp(post, [200], 'E_SESSION_HTTP', 'editing-session-post');
    const postRev = draftInfoFromSession(sessOf(post.json)).revision;
    ckpt.stages.dialog = true;
    ckpt.dialogDraftRevision = postRev;
    ckpt.dialogMarkerInMessage = hasMarkerMsg;
    saveCkpt(ckpt);
    console.log(`[m9] PASS dialog run=${runId} markerInMessage=true draftRev=${preRev}->${postRev}`);
  }

  const summary = {
    pass: true, verdict: 'pass', base: BASE, workspaceId: WS_ID, testId: TEST_ID, versionId: VERSION_ID,
    marker: MARKER, sessionId: SESSION_ID, workspaceRunId: ckpt.workspaceRunId || null, proposalId: PROPOSAL_ID || null,
    baselineWorkspaceRevision: BASE_WS_REV, confirmedWorkspaceRevision: NEW_WS_REV,
    baselineDraftRevision: BASE_DRAFT_REV, continuityDraftRevision: ckpt.continuityDraftRevision || null,
    dialogRunId: ckpt.continuityRunId || null, dialogDraftRevision: ckpt.dialogDraftRevision ?? null,
    evidenceDir: EV_DIR, checkpoint: CKPT_PATH,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2) + '\n');
  console.log(`DONE pass session=${SESSION_ID} wsRev=${BASE_WS_REV}->${NEW_WS_REV} draftRev=${BASE_DRAFT_REV}->${summary.continuityDraftRevision} dialogRun=${summary.dialogRunId}`);
}

main().catch((e) => {
  const code = (e && e.code) || 'E_UNKNOWN';
  try {
    const diag = { pass: false, verdict: 'fail', code, workspaceId: WS_ID, testId: TEST_ID, versionId: VERSION_ID, base: BASE, evidenceDir: EV_DIR, checkpoint: CKPT_PATH };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(diag, null, 2) + '\n');
  } catch {}
  console.error(`FAIL: ${code}`);
  process.exit(1);
});
