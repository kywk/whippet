#!/usr/bin/env node
// M10.Z #4 專用公開 API Plan 準備。--create 只建立 Test/session/draft Plan，不 confirm、不排 Run。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const OUT = '/private/tmp/whippet-m10z-20261114/even';
const ROOT = '/private/tmp/whippet-m10z-20261114';
const API = 'https://127.0.0.1:19889';
const CA = path.join(ROOT, 'qa.crt');
const STATE = path.join(OUT, 'case4-plan-setup.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeJson(file, max = 131072) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > max) throw Error('invalid_input'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function write(v) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const temp = STATE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, STATE);
}
function writeEvidence(name, value) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function admission() {
  const a = safeJson(path.join(ROOT, 'admission.json'));
  if (a.schemaVersion !== 1 || a.leader !== 't6g' || a.isolatedApi !== API || a.pg !== true) throw Error('leader_admission_required');
  return a;
}
function call(method, route, body, cert) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(route, API);
    const req = https.request(u, { method, ca: cert, timeout: 15000, headers: {
      Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    } }, res => {
      const chunks = []; let n = 0;
      res.on('data', b => { n += b.length; if (n <= 256 * 1024) chunks.push(b); else req.destroy(Error('response_limit')); });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Error('timeout'))); req.on('error', reject);
    if (payload) req.write(payload); req.end();
  });
}
function requireStatus(result, expected, code) { if (result.status !== expected) throw Error(code + '_HTTP_' + result.status); return result.json; }
function command(binary, args, input = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', errSize = 0;
    p.stdout.on('data', b => { out += b.toString(); if (out.length > 65536) p.kill('SIGKILL'); });
    p.stderr.on('data', b => { errSize += b.length; if (errSize > 65536) p.kill('SIGKILL'); });
    p.on('error', reject); p.on('close', code => resolve({ code, out })); p.stdin.end(input || '');
  });
}
async function containerCount(runId) {
  const r = await command('docker', ['ps', '-a', '--filter', 'label=whippet.manager.id=m10z-20261114', '--filter', 'label=whippet.run.id=' + runId, '--format', '{{.ID}}']);
  if (r.code !== 0) return null;
  return r.out.split('\n').filter(Boolean).length;
}
async function slotReleased(runId) {
  const sql = `BEGIN TRANSACTION READ ONLY; SELECT slot_released FROM runs WHERE id='${runId}'::uuid; COMMIT;\n`;
  const r = await command('docker', ['exec', '-i', 'whippet-m10z-20261114-pg', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], sql);
  if (r.code !== 0) return null;
  const values = r.out.split('\n').filter(x => x === 't' || x === 'f');
  return values.length === 1 ? values[0] === 't' : null;
}
async function confirmCancel() {
  const a = admission();
  if (a.case4Runs !== true) throw Error('leader_case4_run_admission_required');
  const s = safeJson(STATE);
  if (s.status !== 'PLAN_DRAFT_READY' || !UUID.test(s.planId)) throw Error('plan_draft_required');
  const cert = fs.readFileSync(CA);
  const readPlan = async () => requireStatus(await call('GET', `/api/tests/${s.testId}/plan?editingSessionId=${s.sessionId}`, undefined, cert), 200, 'plan_read')?.plan;
  const before = await readPlan();
  if (before?.id !== s.planId || before.status !== 'draft' || before.revision !== s.planRevision || before.stages?.[0]?.status !== 'pending') throw Error('plan_changed');
  writeEvidence('case4-confirm-intent.json', { planId: s.planId, planRevision: before.revision, testId: s.testId, sessionId: s.sessionId, onePOSTOnly: true });
  const confirmed = requireStatus(await call('POST', `/api/plans/${s.planId}/confirm`, { planRevision: before.revision, confirmed: true }, cert), 200, 'confirm')?.plan;
  const runId = confirmed?.stages?.[0]?.authorRunId;
  if (!UUID.test(runId) || confirmed.status !== 'running') throw Error('confirm_result_invalid');
  writeEvidence('case4-confirm-result.json', { planId: s.planId, planRevision: confirmed.revision, status: confirmed.status, authorRunId: runId, firstStageStatus: confirmed.stages[0].status, laterStageStatus: confirmed.stages[1].status });
  let containerObserved = false;
  for (let i = 0; i < 120; i++) {
    const n = await containerCount(runId);
    if (n !== null && n > 0) { containerObserved = true; break; }
    const run = requireStatus(await call('GET', `/api/runs/${runId}`, undefined, cert), 200, 'run_read');
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  writeEvidence('case4-container-before-cancel.json', { authorRunId: runId, exactManagerAndRunLabelObserved: containerObserved });
  if (!containerObserved) throw Error('container_not_observed_no_cancel');
  const current = await readPlan();
  if (current?.status !== 'running' || current.stages?.[0]?.authorRunId !== runId) throw Error('plan_changed_before_cancel');
  writeEvidence('case4-cancel-intent.json', { planId: s.planId, planRevision: current.revision, authorRunId: runId, onePOSTOnly: true });
  const cancelled = requireStatus(await call('POST', `/api/plans/${s.planId}/cancel`, { planRevision: current.revision }, cert), 200, 'cancel')?.plan;
  writeEvidence('case4-cancel-response.json', { planId: s.planId, status: cancelled?.status ?? null, planRevision: cancelled?.revision ?? null, authorRunId: runId });
  let final = null;
  for (let i = 0; i < 90; i++) {
    const plan = await readPlan(); const run = requireStatus(await call('GET', `/api/runs/${runId}`, undefined, cert), 200, 'run_read');
    const count = await containerCount(runId); const released = await slotReleased(runId);
    if (plan?.status === 'stopped' && ['cancelled', 'failed', 'interrupted', 'timed_out', 'succeeded'].includes(run.status) && count === 0 && released === true) {
      final = { status: 'PASS_CANCEL_RECLAIM', planStatus: plan.status, firstStageStatus: plan.stages?.[0]?.status, laterStageStatus: plan.stages?.[1]?.status, runStatus: run.status, containerObserved, exactLabelContainersNow: count, slotReleased: released, nextTaskStarted: false, authorRunId: runId }; break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!final) final = { status: 'UNVERIFIED_RECLAIM', authorRunId: runId, containerObserved };
  fs.writeFileSync(path.join(OUT, 'case4-cancel-final.json'), JSON.stringify(final, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(final.status + ' case4-cancel-final.json\n');
  if (final.status !== 'PASS_CANCEL_RECLAIM') process.exitCode = 1;
}
async function main() {
  const mode = process.argv[2] || '--prepare';
  if (mode === '--prepare') { process.stdout.write('PREPARED case4 Plan API setup; --create does not confirm or enqueue\n'); return; }
  if (mode === '--confirm-cancel') return confirmCancel();
  if (mode !== '--create') throw Error('usage: --prepare | --create | --confirm-cancel');
  admission();
  if (fs.existsSync(STATE)) throw Error('setup_exists_no_retry');
  const fixture = safeJson(path.join(ROOT, 'business-fixture.json'));
  if (!UUID.test(fixture.workspaceId) || fixture.scopeConfirmed !== true || fixture.target !== 'http://host.docker.internal:19888') throw Error('fixture_mismatch');
  const cert = fs.readFileSync(CA);
  const workspace = requireStatus(await call('GET', '/api/workspaces/' + fixture.workspaceId, undefined, cert), 200, 'workspace');
  if (workspace.id !== fixture.workspaceId || workspace.scopeStatus !== 'confirmed') throw Error('workspace_scope_not_confirmed');
  const name = 'm10z-even-cancel-' + crypto.randomUUID().slice(0, 8);
  let state = { status: 'INTENT', workspaceId: workspace.id, name, noRunScheduled: true, source: 'public-API' };
  write(state);
  try {
    const test = requireStatus(await call('POST', `/api/workspaces/${workspace.id}/tests`, { kind: 'usecase', name, description: 'M10.Z isolated Stage stop and cancel QA' }, cert), 201, 'test');
    if (!UUID.test(test.id) || test.workspaceId !== workspace.id) throw Error('test_response_invalid');
    state = { ...state, status: 'TEST_CREATED', testId: test.id }; write(state);
    const started = await call('POST', `/api/tests/${test.id}/editing-session`, {}, cert);
    if (![200, 201].includes(started.status)) throw Error('session_HTTP_' + started.status);
    const session = started.json?.session;
    if (!UUID.test(session?.id) || session.testId !== test.id || !Number.isInteger(session.draft?.revision)) throw Error('session_response_invalid');
    state = { ...state, status: 'SESSION_CREATED', sessionId: session.id, draftRevision: session.draft.revision }; write(state);
    const slug = 'qa-even-cancel-' + crypto.randomUUID().slice(0, 8);
    const stages = [
      { id: 'first', title: 'First synthetic stage', action: 'create', module: { slug, moduleKind: 'step', description: 'Use the confirmed synthetic shop only; verify known order W3-OK total 320.' }, args: {} },
      { id: 'later', title: 'Later must remain pending on stop', action: 'create', module: { slug: slug + '-later', moduleKind: 'step', description: 'Check missing order remains absent.' }, args: {} },
    ];
    const saved = requireStatus(await call('PUT', `/api/tests/${test.id}/plan`, { editingSessionId: session.id, revision: session.draft.revision, planRevision: 0, stages }, cert), 200, 'plan');
    const plan = saved?.plan;
    if (!UUID.test(plan?.id) || plan.status !== 'draft' || plan.stages?.length !== 2 || plan.stages[0]?.status !== 'pending') throw Error('plan_response_invalid');
    state = { ...state, status: 'PLAN_DRAFT_READY', planId: plan.id, planRevision: plan.revision, stageIds: ['first', 'later'], noRunScheduled: true };
    write(state);
    process.stdout.write('PLAN_DRAFT_READY case4-plan-setup.json\n');
  } catch (e) { write({ ...state, lastErrorCode: String(e.message).replace(/[^A-Z0-9_]/gi, '_').slice(0, 80) }); throw e; }
}
main().catch(e => { process.stderr.write('BLOCKED ' + (e.message === 'setup_exists_no_retry' ? e.message : 'precondition_or_api_failure') + '\n'); process.exitCode = 2; });
