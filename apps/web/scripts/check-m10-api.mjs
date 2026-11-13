// Focused M10 transport checks: synthetic responses, no live backend or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const typeUrl = moduleUrl(compile(await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')));
const planUrl = moduleUrl(compile(await readFile(new URL('../src/plan.ts', import.meta.url), 'utf8')));
const { batchPublishReady, editableStage, parseStageEditor } = await import(planUrl);
const code = compile(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')).replace(/from ['"]\.\/types['"]/g, `from '${typeUrl}'`).replace(/from ['"]\.\/plan['"]/g, `from '${planUrl}'`);
const { createHttpApi, ApiError } = await import(moduleUrl(code));
const api = createHttpApi('/api');
const calls = [];
let body, status = 200;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
const source = { id: 'source', workspaceId: 'workspace', testId: 'test', editingSessionId: 'session', kind: 'author', authorMode: 'edit', status: 'succeeded', createdAt: '2026-11-13T00:00:00Z', draftRevision: 3,
  authorPartial: { reason: 'budget_exhausted', nextStep: '補齊斷言', checkpoint: { scriptHash: 'a'.repeat(64), selfTestPassed: true }, appliedRevision: 4 } };
try {
  const metadata = { slug: 'sample', moduleKind: 'step', exportName: 'sample', signature: 'sample()', inputs: '', returns: 'number', preconditions: '', postconditions: '', harness: 'synthetic harness' };
  const moduleDraft = { testId: 'module', editingSessionId: 'session', revision: 2, script: 'synthetic body', module: metadata, updatedAt: '2026-11-13T00:00:00Z' };
  body = { id: 'module', workspaceId: 'workspace', kind: 'module', slug: 'sample', name: 'Sample', description: '', publishedVersionId: null, activeEditingSession: null }; status = 201;
  assert.equal((await api.createTest('workspace', { kind: 'module', slug: 'sample', name: 'Sample', description: '' })).slug, 'sample');
  assert.deepEqual(calls.at(-1).body, { kind: 'module', slug: 'sample', name: 'Sample', description: '' });
  status = 200; body = moduleDraft;
  assert.deepEqual((await api.getDraft('module', 'session')).module, metadata);
  assert.deepEqual((await api.saveDraft('module', 'session', 1, 'synthetic body', undefined, metadata)).module, metadata);
  assert.deepEqual(calls.at(-1).body, { editingSessionId: 'session', revision: 1, script: 'synthetic body', module: metadata });
  for (const invalid of [undefined, null, 5]) {
    body = { ...moduleDraft, module: { ...metadata, harness: invalid } };
    await assert.rejects(api.getDraft('module', 'session'), error => error.code === 'INVALID_RESPONSE');
  }
  body = { ...moduleDraft, module: undefined };
  assert.equal((await api.getDraft('module', 'session')).module, undefined);
  status = 409; body = { error: { code: 'CONFLICT', message: 'stale module' } };
  const moduleCalls = calls.length;
  await assert.rejects(api.saveDraft('module', 'session', 1, 'synthetic body', undefined, metadata), error => error.status === 409);
  assert.equal(calls.length, moduleCalls + 1);
  status = 200;

  body = { items: [{ testId: 'module', versionId: 'v1', name: '登入', description: '', module: { slug: 'login', moduleKind: 'setup', exportName: 'login', signature: 'login({page})', inputs: '', returns: '', preconditions: '', postconditions: '', harness: 'synthetic' }, validationRunId: 'validation', validationStatus: 'succeeded', referencedBy: [{ testId: 'usecase', versionId: 'v2' }] }] };
  assert.equal((await api.listCatalog('workspace/a'))[0].referencedBy[0].versionId, 'v2');
  assert.equal(calls.at(-1).url, '/api/workspaces/workspace%2Fa/catalog');
  body = source;
  const parsed = await api.getRun('source');
  assert.equal(parsed.draftRevision, 3);
  assert.equal(parsed.authorPartial.appliedRevision, 4);
  body = { ...source, authorPartial: { reason: 'budget_exhausted', nextStep: '繼續' } };
  assert.equal((await api.getRun('source')).authorPartial.checkpoint, undefined);
  body = { ...source, authorPartial: { ...source.authorPartial, checkpoint: { scriptHash: 'bad', selfTestPassed: true } } };
  await assert.rejects(api.getRun('source'), (error) => error.code === 'INVALID_RESPONSE');
  body = { run: { ...source, id: 'continued', status: 'queued', authorPartial: undefined }, conversationId: 'conversation' }; status = 202;
  assert.equal((await api.continueAuthor('source/a', 'session', 4)).run.id, 'continued');
  assert.deepEqual(calls.at(-1), { url: '/api/runs/source%2Fa/continue', method: 'POST', body: { editingSessionId: 'session', revision: 4 } });
  status = 200;
  await assert.rejects(api.continueAuthor('source', 'session', 4), (error) => error.code === 'INVALID_RESPONSE');
  status = 409; body = { error: { code: 'conflict', message: 'stale' } };
  const before = calls.length;
  await assert.rejects(api.continueAuthor('source', 'session', 4), (error) => error instanceof ApiError && error.status === 409);
  assert.equal(calls.length, before + 1, '409 must not retry automatically');
  assert.equal(calls.at(-1).body.revision, 4);
  status = 404;
  await assert.rejects(api.listCatalog('workspace'), (error) => error.status === 404);
  status = 200;
  const stage = { id: 'stage-1', title: '登入', action: 'create', module: { slug: 'login', moduleKind: 'setup', description: '登入流程' }, args: {} };
  const plan = { id: 'plan', testId: 'test', editingSessionId: 'session', revision: 1, baseRevision: 4, contextRevision: 2, status: 'draft', stages: [{ ...stage, status: 'pending' }] };
  body = { plan: null };
  assert.equal(await api.getPlan('test', 'session/a'), null);
  assert.equal(calls.at(-1).url, '/api/tests/test/plan?editingSessionId=session%2Fa');
  body = { plan };
  assert.equal((await api.getPlan('test', 'session')).revision, 1);
  assert.equal((await api.savePlan('test', { editingSessionId: 'session', revision: 4, planRevision: 0, stages: [{ ...stage, status: 'ready', authorRunId: 'must-not-send', moduleTestId: 'server-assigned' }] })).id, 'plan');
  assert.deepEqual(calls.at(-1).body, { editingSessionId: 'session', revision: 4, planRevision: 0, stages: [stage] });
  body = { plan: { ...plan, status: 'running', revision: 2 } };
  assert.equal((await api.confirmPlan('plan', 1)).status, 'running');
  assert.deepEqual(calls.at(-1).body, { planRevision: 1, confirmed: true });
  body = { plan: { ...plan, status: 'stopped', revision: 3 } };
  await api.cancelPlan('plan', 2);
  assert.deepEqual(calls.at(-1).body, { planRevision: 2 });
  body = plan; // A direct Plan is not a {plan} envelope.
  await assert.rejects(api.getPlan('test', 'session'), (error) => error.code === 'INVALID_RESPONSE');
  body = { plan: { ...plan, editingSessionId: 'other' } };
  await assert.rejects(api.getPlan('test', 'session'), (error) => error.code === 'INVALID_RESPONSE');
  const batch = { runId: 'summary', planId: 'plan', planRevision: 4, batchHash: 'b'.repeat(64), status: 'succeeded', stale: false, publishReady: true, message: null, name: null, description: '整批驗證範圍', backgroundSummary: '整批背景', candidates: [{ testId: 'module', versionId: 'candidate', name: '登入', slug: 'login', moduleKind: 'setup', revision: 2, bundleHash: 'c'.repeat(64) }] };
  body = { summary: null };
  assert.equal(await api.getPlanSummary('plan'), null);
  body = { summary: batch };
  assert.equal((await api.getPlanSummary('plan')).candidates.length, 1);
  const composed = { ...plan, revision: 4, status: 'composed', validationRunId: 'validation', stages: [{ ...stage, status: 'ready', moduleTestId: 'module', candidateVersionId: 'candidate' }] };
  assert.equal(batchPublishReady(composed, batch), true);
  for (const patch of [{ stale: true }, { planId: 'other' }, { planRevision: 3 }, { publishReady: false }, { status: 'running' }, { candidates: [] }, { candidates: [...batch.candidates, ...batch.candidates] }, { description: null }]) assert.equal(batchPublishReady(composed, { ...batch, ...patch }), false);
  assert.equal(batchPublishReady({ ...composed, stages: [{ ...composed.stages[0], candidateVersionId: undefined }] }, batch), false);
  assert.equal(batchPublishReady({ ...composed, status: 'done' }, batch), false);
  body = { summary: { ...batch, planId: 'other' } };
  await assert.rejects(api.getPlanSummary('plan'), (error) => error.code === 'INVALID_RESPONSE');
  for (const resultStatus of [200, 202]) {
    status = resultStatus; body = { run: { ...source, id: 'summary', authorMode: 'summary', authorPartial: undefined } };
    await api.requestPlanSummary('plan', 4, 'validation');
    assert.deepEqual(calls.at(-1).body, { planRevision: 4, validationRunId: 'validation' });
  }
  status = 200;
  const version = { id: 'published', testId: 'test', editingSessionId: 'session', revision: 4, script: 'synthetic', createdAt: '2026-11-13T00:00:00Z', validationRunId: 'validation', summaryRunId: 'summary' };
  body = { usecaseVersion: version, moduleVersions: [{ ...version, id: 'candidate', testId: 'module' }] };
  assert.equal((await api.publishPlan('plan', 4, 'summary')).moduleVersions[0].id, 'candidate');
  assert.deepEqual(calls.at(-1).body, { planRevision: 4, confirmed: true, summaryRunId: 'summary' });
  // Historical M1 seed versions legitimately have a null validation_run_id
  // (M2 migration 003 + Server Version.ValidationRunID *string).
  body = { items: [{ ...version, validationRunId: null }] };
  assert.equal((await api.listVersions('test'))[0].validationRunId, null);
  body = { items: [version] };
  assert.equal((await api.listVersions('test'))[0].validationRunId, 'validation');
  for (const invalid of [undefined, 123, {}, false]) {
    body = { items: [{ ...version, validationRunId: invalid }] };
    await assert.rejects(api.listVersions('test'), (error) => error.code === 'INVALID_RESPONSE');
  }
  // New publication still requires a real validation Run, including batch results.
  body = { ...version, validationRunId: null };
  await assert.rejects(api.publishTest('test', 'session', 4, 'summary'), (error) => error.code === 'INVALID_RESPONSE');
  body = { usecaseVersion: { ...version, validationRunId: null }, moduleVersions: [] };
  await assert.rejects(api.publishPlan('plan', 4, 'summary'), (error) => error.code === 'INVALID_RESPONSE');
  status = 409; body = { error: { code: 'conflict', message: 'stale' } };
  const planCalls = calls.length;
  await assert.rejects(api.confirmPlan('plan', 4), (error) => error.status === 409);
  assert.equal(calls.length, planCalls + 1);
  assert.equal(calls.at(-1).body.planRevision, 4);
  assert.deepEqual(parseStageEditor(JSON.stringify([stage])), [stage]);
  assert.equal(editableStage({ ...stage, status: 'ready', authorRunId: 'hidden' }).status, undefined);
  for (const stages of [[], [stage, stage], [{ ...stage, status: 'ready' }], [{ ...stage, args: { page: { kind: 'literal', value: 1 } } }], [{ ...stage, args: { user: { kind: 'binding', stageId: stage.id, path: [] } } }]]) assert.throws(() => parseStageEditor(JSON.stringify(stages)));
  status = 200;
  const retrySource = { moduleTestId: 'module', editingSessionId: 'module-session', moduleRevision: 2, moduleContextRevision: 3, authorRunId: 'failed-author', authorStatus: 'failed', validationRunId: null, validationStatus: null, reclaimed: true };
  const retry = { eligible: true, reason: null, planRevision: 4, source: retrySource };
  body = { retry };
  assert.deepEqual(await api.getStageRetry('plan/a', 'stage/b'), retry);
  assert.equal(calls.at(-1).url, '/api/plans/plan%2Fa/stages/stage%2Fb/retry');
  for (const invalid of [{ ...retry, source: null }, { ...retry, reason: 'unknown' }, { ...retry, planRevision: 0 }, { ...retry, source: { ...retrySource, reclaimed: false } }, { ...retry, source: { ...retrySource, moduleContextRevision: undefined } }, { ...retry, source: { ...retrySource, authorStatus: 'cancelled' } }, { ...retry, source: { ...retrySource, validationStatus: 'failed' } }]) {
    body = { retry: invalid }; await assert.rejects(api.getStageRetry('plan','stage'), e => e.code === 'INVALID_RESPONSE');
  }
  for (const reason of ['plan_not_stopped','stage_not_retryable','cancelled','source_unavailable','session_closed','reclaim_pending','snapshot_mismatch','prior_stage_invalid','scope_unavailable']) {
    body = { retry: { eligible: false, reason, planRevision: 4, source: null } }; assert.equal((await api.getStageRetry('plan','stage')).eligible, false);
  }
  const retryInput = { planRevision: 4, moduleRevision: 2, moduleContextRevision: 3, confirmed: true, content: '  人工修復 🐕  ' };
  body = { plan };
  await api.retryStage(plan.id, 'stage', retryInput);
  assert.deepEqual(calls.at(-1).body, retryInput, 'preserve original text and exact three CAS');
  for (const content of ['', '  ', '\0', '\ud800', '🐕'.repeat(16001)]) {
    const count = calls.length; await assert.rejects(api.retryStage(plan.id,'stage',{...retryInput,content}), e => e.code === 'INVALID_REQUEST'); assert.equal(calls.length,count);
  }
  await api.retryStage(plan.id, 'stage', { ...retryInput, content: '🐕'.repeat(16000) });
  for (const failure of [409,503]) { status=failure; body={error:{code:'CONFLICT',message:'synthetic'}}; const count=calls.length; await assert.rejects(api.retryStage(plan.id,'stage',retryInput)); assert.equal(calls.length,count+1); assert.deepEqual(calls.at(-1).body,retryInput); }
  console.log('M10 API checks passed: Module create/full metadata save/strict parse/409; history explicit-null compatibility; Catalog/partial/Continue; Plan envelopes, CAS/write payloads, batch-summary readiness and candidates, publish, 409/no retry, Stage editor guards.');
} finally { globalThis.fetch = originalFetch; }
