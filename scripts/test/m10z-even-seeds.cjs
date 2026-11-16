#!/usr/bin/env node
// M10.Z #8 新隔離 golden seed。僅重用舊安全結果的兩筆 saveRequest 程式／Module metadata。
// --create 無 Run；--request-scope/--publish 等 Leader 模型准入，逐步持久 checkpoint，不自動重送未知 mutation。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const ROOT = '/private/tmp/whippet-m10z-20261114';
const OUT = path.join(ROOT, 'even');
const STATE = path.join(OUT, 'golden-seeds-state.json');
const SEEDS = path.resolve(__dirname, '../../services/server/m10_golden_r102_seeds.result.json');
const API = 'https://127.0.0.1:19889';
const TARGET = 'http://m10-golden.invalid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function safeJson(file, limit = 262144) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > limit) throw Error('input_invalid'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function save(state) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, STATE);
}
function admit(runs = false) {
  const a = safeJson(path.join(ROOT, 'admission.json'));
  if (a.schemaVersion !== 1 || a.leader !== 't6g' || a.isolatedApi !== API || a.pg !== true || (runs && a.goldenSeedRuns !== true)) throw Error('leader_admission_required');
}
function request(cert, method, route, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(API + route, { method, ca: cert, timeout: 20000, headers: { Accept: 'application/json', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, res => {
      let n = 0; const chunks = [];
      res.on('data', b => { n += b.length; if (n <= 256 * 1024) chunks.push(b); else req.destroy(Error('response_limit')); });
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(Error('timeout'))); req.on('error', reject); if (bytes) req.write(bytes); req.end();
  });
}
function ok(r, status, label) { if (r.status !== status) throw Error(label + '_HTTP_' + r.status); return r.json; }
async function pollRun(cert, id) {
  if (!UUID.test(id)) throw Error('run_id_invalid');
  for (let i = 0; i < 90; i++) {
    const run = ok(await request(cert, 'GET', '/api/runs/' + id), 200, 'run');
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) return { status: run.status, reportReady: !!run.reportUrl };
    await sleep(3000);
  }
  return { status: 'poll_timeout', reportReady: false };
}
async function waitReclaim(cert, testId, sessionId) {
  for (let i = 0; i < 30; i++) {
    const r = ok(await request(cert, 'GET', `/api/tests/${testId}/editing-sessions/${sessionId}`), 200, 'session');
    if (r.session?.reclaimPending === false && r.session?.pendingRunIds?.length === 0) return true;
    await sleep(2000);
  }
  return false;
}
function sourceSeeds() {
  const src = safeJson(SEEDS, 1024 * 1024);
  if (!Array.isArray(src.seeds) || src.seeds.length !== 2 || src.seeds.map(s => s.goldenId).join(',') !== 'G05,G06') throw Error('source_seed_shape_changed');
  return src.seeds.map(s => {
    const q = s.saveRequest;
    if (q?.module?.slug !== s.slug || typeof q.script !== 'string' || typeof q.module?.harness !== 'string' || q.module.harness.length < 1) throw Error('source_seed_invalid');
    return { id: s.goldenId, slug: s.slug, script: q.script, module: q.module };
  });
}
async function create() {
  admit(false); if (fs.existsSync(STATE)) throw Error('seed_state_exists_no_retry');
  const cert = fs.readFileSync(path.join(ROOT, 'qa.crt'));
  const seeds = sourceSeeds();
  const name = 'm10z-even-golden-' + crypto.randomUUID().slice(0, 8);
  let state = { status: 'INTENT', name, target: TARGET, seeds: [], noRunScheduled: true };
  save(state);
  const ws = ok(await request(cert, 'POST', '/api/workspaces', { name }), 201, 'workspace');
  if (!UUID.test(ws.id)) throw Error('workspace_id_invalid');
  state = { ...state, status: 'WORKSPACE_CREATED', workspaceId: ws.id, conversationId: ws.conversationId }; save(state);
  for (const seed of seeds) {
    const test = ok(await request(cert, 'POST', `/api/workspaces/${ws.id}/tests`, { kind: 'module', slug: seed.slug, name: seed.slug, description: seed.id + ' synthetic golden seed' }), 201, 'test');
    if (!UUID.test(test.id) || test.workspaceId !== ws.id) throw Error('test_id_invalid');
    state.seeds.push({ id: seed.id, slug: seed.slug, testId: test.id, status: 'TEST_CREATED', scriptSha256: hash(seed.script), moduleSha256: hash(JSON.stringify(seed.module)) }); save(state);
    const started = await request(cert, 'POST', `/api/tests/${test.id}/editing-session`, {});
    if (![200, 201].includes(started.status)) throw Error('session_HTTP_' + started.status);
    const session = started.json?.session;
    if (!UUID.test(session?.id) || !Number.isInteger(session?.draft?.revision)) throw Error('session_invalid');
    state.seeds.at(-1).editingSessionId = session.id; state.seeds.at(-1).revision = session.draft.revision; state.seeds.at(-1).status = 'SESSION_CREATED'; save(state);
    const draft = ok(await request(cert, 'PUT', `/api/tests/${test.id}/draft`, { editingSessionId: session.id, revision: session.draft.revision, script: seed.script, module: seed.module }), 200, 'draft');
    if (draft.script !== seed.script || !Object.keys(seed.module).every(k => draft.module?.[k] === seed.module[k])) throw Error('draft_content_mismatch');
    state.seeds.at(-1).revision = draft.revision; state.seeds.at(-1).status = 'DRAFT_SAVED'; save(state);
  }
  state.status = 'DRAFTS_READY'; save(state);
  process.stdout.write('DRAFTS_READY golden-seeds-state.json\n');
}
async function requestScope() {
  admit(true); const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  if (s.status !== 'DRAFTS_READY') throw Error('scope_source_not_ready');
  // 專用合成 target，只允許 setContent/DOM，不要求真登入或外部網路。
  const prompt = `請為專用合成Golden測試Workspace提出設定提案：名稱保留 ${s.name}，唯一target origin為 ${TARGET}，用途是本機setContent/DOM驗證，不需登入角色、相依站或真網路探索；預設URL同target，timeout 60000ms。先提出設定，不替我確認。`;
  const w = ok(await request(cert, 'GET', `/api/workspaces/${s.workspaceId}`), 200, 'workspace');
  if (w.revision !== 1 || w.scopeStatus !== 'unconfirmed') throw Error('scope_precondition_changed');
  s.status = 'SCOPE_INTENT'; s.scopePromptSha256 = hash(prompt); save(s);
  const submitted = ok(await request(cert, 'POST', `/api/workspaces/${s.workspaceId}/messages`, { content: prompt, revision: 1, contextRevision: 0 }), 202, 'scope_author');
  if (!UUID.test(submitted?.run?.id)) throw Error('scope_run_invalid');
  s.scopeRunId = submitted.run.id; s.status = 'SCOPE_RUN'; save(s);
  const outcome = await pollRun(cert, s.scopeRunId); s.scopeRunStatus = outcome.status; s.status = 'SCOPE_RUN_DONE'; save(s);
  if (outcome.status !== 'succeeded') throw Error('scope_author_failed');
  const current = ok(await request(cert, 'GET', `/api/workspaces/${s.workspaceId}`), 200, 'workspace');
  const p = current.currentProposal;
  if (!UUID.test(p?.id) || p?.baseRevision !== 1 || p.content?.targets?.length !== 1 || p.content.targets[0].origin !== TARGET || (p.content.loginRoles || []).length !== 0) throw Error('scope_proposal_review_required');
  s.proposalId = p.id; s.status = 'SCOPE_PROPOSAL_VERIFIED'; save(s);
  process.stdout.write('SCOPE_PROPOSAL_VERIFIED golden-seeds-state.json\n');
}
async function confirmScope() {
  admit(true); const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  if (s.status !== 'SCOPE_PROPOSAL_VERIFIED') throw Error('proposal_not_reviewed');
  const p = ok(await request(cert, 'POST', `/api/workspaces/${s.workspaceId}/proposals/${s.proposalId}/confirm-scope`, { baseRevision: 1, confirmed: true }), 200, 'confirm_scope');
  if (p.scopeConfirmed !== true) throw Error('scope_not_confirmed'); s.status = 'SCOPE_CONFIRMED'; save(s);
  const applied = ok(await request(cert, 'POST', `/api/workspaces/${s.workspaceId}/proposals/${s.proposalId}/confirm`, { baseRevision: 1, confirmed: true }), 200, 'apply_scope');
  if (applied.workspace?.scopeStatus !== 'confirmed' || applied.workspace?.revision !== 2) throw Error('scope_apply_invalid');
  s.status = 'WORKSPACE_ACTIVE'; s.settingsRevision = applied.workspace.revision; s.authorizationRevision = applied.workspace.authorizationRevision; save(s);
  process.stdout.write('WORKSPACE_ACTIVE golden-seeds-state.json\n');
}
async function publish() {
  admit(true); const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  if (s.status !== 'WORKSPACE_ACTIVE') throw Error('workspace_not_active');
  for (const seed of s.seeds) {
    if (seed.status === 'PUBLISHED') continue;
    if (seed.status !== 'DRAFT_SAVED') throw Error('seed_not_ready');
    seed.status = 'VALIDATION_INTENT'; save(s);
    const validation = ok(await request(cert, 'POST', `/api/tests/${seed.testId}/draft/validate`, { editingSessionId: seed.editingSessionId, revision: seed.revision }), 202, 'validate');
    if (!UUID.test(validation?.id)) throw Error('validation_run_invalid');
    seed.validationRunId = validation.id; seed.status = 'VALIDATION_RUN'; save(s);
    const result = await pollRun(cert, validation.id); seed.validationStatus = result.status; seed.reportReady = result.reportReady; seed.status = 'VALIDATION_DONE'; save(s);
    if (result.status !== 'succeeded' || !result.reportReady) throw Error('validation_failed_or_report_missing');
    if (!await waitReclaim(cert, seed.testId, seed.editingSessionId)) throw Error('validation_reclaim_timeout');
    seed.status = 'SUMMARY_INTENT'; save(s);
    const sum = await request(cert, 'POST', `/api/tests/${seed.testId}/draft/summary`, { editingSessionId: seed.editingSessionId, revision: seed.revision, validationRunId: validation.id });
    seed.summaryHttp = sum.status; save(s);
    if (![200, 202].includes(sum.status) || !UUID.test(sum.json?.run?.id)) throw Error('summary_request_failed');
    seed.summaryRunId = sum.json.run.id; seed.status = 'SUMMARY_RUN'; save(s);
    const summary = await pollRun(cert, seed.summaryRunId); seed.summaryStatus = summary.status; seed.status = 'SUMMARY_DONE'; save(s);
    if (summary.status !== 'succeeded') throw Error('summary_failed');
    if (!await waitReclaim(cert, seed.testId, seed.editingSessionId)) throw Error('summary_reclaim_timeout');
    seed.status = 'PUBLISH_INTENT'; save(s);
    const pub = ok(await request(cert, 'POST', `/api/tests/${seed.testId}/publish`, { editingSessionId: seed.editingSessionId, revision: seed.revision, summaryRunId: seed.summaryRunId, confirmed: true }), 201, 'publish');
    if (!UUID.test(pub?.id)) throw Error('publish_version_invalid');
    seed.versionId = pub.id; seed.publishedName = pub.name; seed.status = 'PUBLISHED'; save(s);
  }
  s.status = 'SEEDS_PUBLISHED'; save(s);
  const manifest = {
    schemaVersion: 1, baselineId: 'm10z-even-20261114', apiBase: API,
    workspace: { id: s.workspaceId, settingsRevision: s.settingsRevision, authorizationRevision: s.authorizationRevision },
    catalogSeeds: s.seeds.map(v => ({ taskIds: [v.id], testId: v.testId, versionId: v.versionId, slug: v.slug, publishedName: v.publishedName || v.slug })),
    ownership: { createdFor: 'm10-golden-r102', workspaceId: s.workspaceId, seedTestIds: s.seeds.map(v => v.testId) },
    productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 },
  };
  fs.writeFileSync(path.join(OUT, 'golden-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write('SEEDS_PUBLISHED golden-manifest.json\n');
}
async function resumePublish() {
  admit(true); const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  const seed = s.seeds[1];
  if (s.status !== 'WORKSPACE_ACTIVE' || seed?.status !== 'PUBLISH_INTENT' || !UUID.test(seed.summaryRunId) || seed.versionId) throw Error('publish_resume_precondition');
  const test = ok(await request(cert, 'GET', `/api/tests/${seed.testId}`), 200, 'test');
  const draft = ok(await request(cert, 'GET', `/api/tests/${seed.testId}/draft`), 200, 'draft');
  const run = ok(await request(cert, 'GET', `/api/runs/${seed.summaryRunId}`), 200, 'summary');
  if (test.publishedVersionId || draft.revision !== seed.revision || run.status !== 'succeeded' || !await waitReclaim(cert, seed.testId, seed.editingSessionId)) throw Error('publish_resume_not_safe');
  fs.writeFileSync(path.join(OUT, 'golden-seeds-publish-attempt1.json'), JSON.stringify({ status: 'NO_VERSION_AFTER_SUMMARY', summaryRunId: seed.summaryRunId, reclaimed: true, draftUnchanged: true }, null, 2) + '\n', { mode: 0o600 });
  const result = await request(cert, 'POST', `/api/tests/${seed.testId}/publish`, { editingSessionId: seed.editingSessionId, revision: seed.revision, summaryRunId: seed.summaryRunId, confirmed: true });
  seed.publishHttp = result.status; save(s);
  if (result.status !== 201 || !UUID.test(result.json?.id)) throw Error('publish_response_invalid');
  seed.versionId = result.json.id; seed.publishedName = result.json.name; seed.status = 'PUBLISHED'; save(s);
  const manifest = {
    schemaVersion: 1, baselineId: 'm10z-even-20261114', apiBase: API,
    workspace: { id: s.workspaceId, settingsRevision: s.settingsRevision, authorizationRevision: s.authorizationRevision },
    catalogSeeds: s.seeds.map(v => ({ taskIds: [v.id], testId: v.testId, versionId: v.versionId, slug: v.slug, publishedName: v.publishedName || v.slug })),
    ownership: { createdFor: 'm10-golden-r102', workspaceId: s.workspaceId, seedTestIds: s.seeds.map(v => v.testId) },
    productionBudget: { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 },
  };
  s.status = 'SEEDS_PUBLISHED'; save(s);
  fs.writeFileSync(path.join(OUT, 'golden-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write('SEEDS_PUBLISHED golden-manifest.json\n');
}
async function resumeSummary() {
  admit(true); const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  const seed = s.seeds[0];
  if (s.status !== 'WORKSPACE_ACTIVE' || seed?.status !== 'SUMMARY_INTENT' || !UUID.test(seed.validationRunId) || seed.summaryRunId) throw Error('summary_resume_precondition');
  const runs = ok(await request(cert, 'GET', `/api/tests/${seed.testId}/runs`), 200, 'runs');
  const draft = ok(await request(cert, 'GET', `/api/tests/${seed.testId}/draft`), 200, 'draft');
  if (runs.items?.some(r => r.kind === 'author') || runs.items?.some(r => r.kind === 'summary') || draft.revision !== seed.revision || draft.validationRunId !== seed.validationRunId || draft.validationStatus !== 'succeeded' || !await waitReclaim(cert, seed.testId, seed.editingSessionId)) throw Error('summary_resume_not_safe');
  fs.writeFileSync(path.join(OUT, 'golden-seeds-summary-attempt1.json'), JSON.stringify({ status: 'NO_SUMMARY_RUN', validationRunId: seed.validationRunId, reclaimed: true, draftUnchanged: true }, null, 2) + '\n', { mode: 0o600 });
  const sum = await request(cert, 'POST', `/api/tests/${seed.testId}/draft/summary`, { editingSessionId: seed.editingSessionId, revision: seed.revision, validationRunId: seed.validationRunId });
  seed.summaryHttp = sum.status; save(s);
  if (![200, 202].includes(sum.status) || !UUID.test(sum.json?.run?.id)) throw Error('summary_request_failed');
  seed.summaryRunId = sum.json.run.id; seed.status = 'SUMMARY_RUN'; save(s);
  const result = await pollRun(cert, seed.summaryRunId); seed.summaryStatus = result.status; seed.status = 'SUMMARY_DONE'; save(s);
  if (result.status !== 'succeeded' || !await waitReclaim(cert, seed.testId, seed.editingSessionId)) throw Error('summary_failed_or_reclaim');
  seed.status = 'PUBLISH_INTENT'; save(s);
  const pub = ok(await request(cert, 'POST', `/api/tests/${seed.testId}/publish`, { editingSessionId: seed.editingSessionId, revision: seed.revision, summaryRunId: seed.summaryRunId, confirmed: true }), 201, 'publish');
  if (!UUID.test(pub?.id)) throw Error('publish_version_invalid');
  seed.versionId = pub.id; seed.publishedName = pub.name; seed.status = 'PUBLISHED'; save(s);
  process.stdout.write('G05_PUBLISHED golden-seeds-state.json\n');
}
async function inspect() {
  const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE);
  const rows = [];
  for (const seed of s.seeds) {
    const runs = await request(cert, 'GET', `/api/tests/${seed.testId}/runs`);
    const draft = await request(cert, 'GET', `/api/tests/${seed.testId}/draft`);
    const session = await request(cert, 'GET', `/api/tests/${seed.testId}/editing-sessions/${seed.editingSessionId}`);
    rows.push({ id: seed.id, runsHttp: runs.status, draftHttp: draft.status,
      runs: Array.isArray(runs.json?.items) ? runs.json.items.map(r => ({ id: r.id, kind: r.kind, status: r.status, draftRevision: r.draftRevision, reportReady: !!r.reportUrl })) : null,
      draftRevision: draft.json?.revision, validationRunId: draft.json?.validationRunId ?? null, validationStatus: draft.json?.validationStatus ?? null,
      sessionHttp: session.status, pendingRunCount: session.json?.session?.pendingRunIds?.length ?? null, reclaimPending: session.json?.session?.reclaimPending ?? null });
  }
  const result = { status: s.status, seeds: rows, noMutation: true };
  fs.writeFileSync(path.join(OUT, 'golden-seeds-inspect.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write('INSPECTED golden-seeds-inspect.json\n');
}
async function reconcileDrafts() {
  const cert = fs.readFileSync(path.join(ROOT, 'qa.crt')); const s = safeJson(STATE); const original = sourceSeeds();
  if (s.status !== 'WORKSPACE_ACTIVE' || s.seeds[0]?.status !== 'VALIDATION_INTENT' || s.seeds[0]?.validationRunId) throw Error('reconcile_precondition');
  const reviewed = [];
  for (const seed of s.seeds) {
    const source = original.find(v => v.id === seed.id);
    const runs = ok(await request(cert, 'GET', `/api/tests/${seed.testId}/runs`), 200, 'runs');
    const draft = ok(await request(cert, 'GET', `/api/tests/${seed.testId}/draft`), 200, 'draft');
    if (runs.items?.length !== 0 || !Number.isInteger(draft.revision) || draft.revision !== seed.revision + 1 || draft.script !== source.script || !Object.keys(source.module).every(k => draft.module?.[k] === source.module[k])) throw Error('reconcile_not_safe');
    reviewed.push({ id: seed.id, priorRevision: seed.revision, currentRevision: draft.revision, noRuns: true, scriptUnchanged: true, moduleUnchanged: true });
  }
  fs.writeFileSync(path.join(OUT, 'golden-seeds-validation-attempt1.json'), JSON.stringify({ status: 'BLOCKED_STALE_REVISION_AFTER_SCOPE', reviewed, noPOSTRun: true }, null, 2) + '\n', { mode: 0o600 });
  for (const seed of s.seeds) { seed.revision += 1; seed.status = 'DRAFT_SAVED'; }
  s.status = 'WORKSPACE_ACTIVE'; save(s);
  process.stdout.write('RECONCILED golden-seeds-validation-attempt1.json\n');
}
async function main() {
  const mode = process.argv[2] || '--prepare';
  if (mode === '--prepare') { sourceSeeds(); process.stdout.write('PREPARED two seed saveRequests; no Run\n'); return; }
  if (mode === '--create') return create();
  if (mode === '--request-scope') return requestScope();
  if (mode === '--confirm-scope') return confirmScope();
  if (mode === '--publish') return publish();
  if (mode === '--resume-summary') return resumeSummary();
  if (mode === '--resume-publish') return resumePublish();
  if (mode === '--inspect') return inspect();
  if (mode === '--reconcile-drafts') return reconcileDrafts();
  throw Error('usage: --prepare | --create | --request-scope | --confirm-scope | --publish | --resume-summary | --resume-publish | --inspect | --reconcile-drafts');
}
main().catch(() => { process.stderr.write('BLOCKED seed_precondition_or_api_failure; inspect safe checkpoint only\n'); process.exitCode = 2; });
