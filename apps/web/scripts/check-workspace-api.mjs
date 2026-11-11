// Focused API boundary check. Synthetic responses only; no network or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const typeUrl = moduleUrl(compile(await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')));
const apiCode = compile(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')).replace(/from ['"]\.\/types['"]/g, `from '${typeUrl}'`);
const { createHttpApi, isProtectedCredentialTransport, ApiError } = await import(moduleUrl(apiCode));
const { executionCapabilityForScript, scriptOriginLabel } = await import(moduleUrl(compile(await readFile(new URL('../src/capabilities.ts', import.meta.url), 'utf8'))));
let checks = 0;
const check = (condition) => { assert.ok(condition); checks++; };
for (const [api, page, allowed] of [
  ['/api', 'https://platform.example/', true],
  ['/api', 'http://localhost:18086/', true],
  ['/api', 'http://127.0.0.1:18086/', true],
  ['/api', 'http://[::1]:18086/', true],
  ['/api', 'http://platform.example/', false],
  ['/api', 'http://localhost.evil.example/', false],
  ['http://remote.example/api', 'http://localhost/', false],
  ['https://user:pass@api.example/api', 'https://platform.example/', false],
]) check(isProtectedCredentialTransport(api, page) === allowed);

const wid = '00000000-0000-4000-8000-000000000101';
const cid = '00000000-0000-4000-8000-000000000102';
const rid = '00000000-0000-4000-8000-000000000103';
const pid = '00000000-0000-4000-8000-000000000104';
const roleId = '00000000-0000-4000-8000-000000000105';
const config = { name: '合成工作區', purpose: '驗測用途', backgroundSummary: '非機密背景', targets: [{ name: '合成網站', purpose: '驗測', origin: 'https://target.example' }], dependencies: [], excludedOrigins: [], exclusions: '', loginRoles: [], defaultTestUrl: 'https://target.example/', timeoutMs: 60000 };
const proposal = { id: pid, workspaceId: wid, conversationId: cid, sourceRunId: rid, baseRevision: 1, contextRevision: 2, status: 'pending', content: config, scopeHash: 'synthetic-scope', scopeConfirmed: false, invalidationReason: null, appliedRevision: null, createdAt: '2026-11-12T00:00:00Z' };
const capabilities = { aiExploration: { available: false, reason: 'scope_confirmation_required' }, aiExecution: { available: false, reason: 'scope_confirmation_required' }, manualExecution: { available: true, reason: null }, credentialLogin: { available: false, reason: 'credentials_required' } };
const workspace = { id: wid, name: '合成工作區', revision: 1, sites: [], defaultTestUrl: '', timeoutMs: 60000, lifecycle: 'draft', authorizationRevision: 0, scopeStatus: 'unconfirmed', settings: null, conversationId: cid, activeRunId: null, currentProposal: proposal, roles: [{ roleId, secretRef: null, secretVersion: null, configured: false }], secretsAvailable: true, executionAvailable: true, unavailableReason: null, capabilities };
const run = { id: rid, workspaceId: wid, testId: null, kind: 'author', authorMode: 'workspace', status: 'queued', createdAt: '2026-11-12T00:00:00Z', editingSessionId: null };
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const calls = [];
let responseBody;
let status = 200;
globalThis.window = { location: { href: 'http://localhost:18086/' } };
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect, cache: init.cache });
  return new Response(JSON.stringify(responseBody), { status, headers: { 'Content-Type': 'application/json' } });
};
const api = createHttpApi('/api');
try {
  responseBody = { items: [workspace] };
  const listed = (await api.listWorkspaces())[0];
  check(listed.executionAvailable === true);
  check(executionCapabilityForScript(listed.capabilities, 'manual')?.available === true);
  check(executionCapabilityForScript(listed.capabilities, 'ai')?.available === false);
  check(executionCapabilityForScript(listed.capabilities, 'legacy')?.available === false);
  check(executionCapabilityForScript(listed.capabilities, undefined) === undefined);
  check(executionCapabilityForScript(undefined, 'manual') === undefined);
  check(executionCapabilityForScript({ aiExploration: { available: true, reason: null } }, 'ai') === undefined);
  check(scriptOriginLabel('legacy').includes('不視為人工'));
  responseBody = { ...workspace, capabilities: undefined };
  check((await api.getWorkspace(wid)).capabilities === undefined);
  responseBody = { ...workspace, capabilities: { manualExecution: capabilities.manualExecution } };
  const partial = await api.getWorkspace(wid);
  check(partial.capabilities.aiExecution === undefined && partial.capabilities.manualExecution.available);
  responseBody = { ...workspace, capabilities: { manualExecution: { available: true } } };
  check((await api.getWorkspace(wid)).capabilities.manualExecution === undefined);
  const testId = '00000000-0000-4000-8000-000000000106';
  const sessionId = '00000000-0000-4000-8000-000000000107';
  const draft = { testId, editingSessionId: sessionId, revision: 7, script: 'same script', updatedAt: '2026-11-12T00:00:00Z', scriptOrigin: 'ai' };
  responseBody = draft;
  check((await api.getDraft(testId, sessionId)).scriptOrigin === 'ai');
  const unchanged = await api.saveDraft(testId, sessionId, 7, 'same script');
  check(unchanged.revision === 7 && unchanged.scriptOrigin === 'ai');
  assert.deepEqual(calls.at(-1).body, { editingSessionId: sessionId, revision: 7, script: 'same script' }); checks++;
  responseBody = { ...draft, revision: 8, script: 'changed script', scriptOrigin: 'manual' };
  const saved = await api.saveDraft(testId, sessionId, 7, 'changed script');
  check(saved.scriptOrigin === 'manual' && saved.revision === 8);
  check(!Object.hasOwn(calls.at(-1).body, 'scriptOrigin'));
  const version = { id: 'version-fixture', testId, revision: 8, script: saved.script, validationRunId: rid, createdAt: draft.updatedAt, description: null, backgroundSummary: null, summaryRunId: null, editingSessionId: sessionId, scriptOrigin: 'legacy' };
  responseBody = { items: [version] };
  check((await api.listVersions(testId))[0].scriptOrigin === 'legacy');
  responseBody = { ...run, scriptOrigin: 'legacy' };
  check((await api.getRun(rid)).scriptOrigin === 'legacy');
  responseBody = run;
  check((await api.getRun(rid)).scriptOrigin === undefined);
  responseBody = { ...run, scriptOrigin: 'human' };
  await assert.rejects(api.getRun(rid), (error) => error.code === 'INVALID_RESPONSE'); checks++;
  responseBody = workspace;
  check((await api.createWorkspace(' 合成工作區 ')).id === wid);
  assert.deepEqual(calls.at(-1).body, { name: '合成工作區' }); checks++;
  responseBody = { id: cid, workspaceId: wid, ownerType: 'workspace', contextRevision: 2, conversationSummary: null, messages: [], activeRunId: null };
  check((await api.getWorkspaceConversation(wid)).messages.length === 0);
  responseBody = { run, conversationId: cid };
  check((await api.sendWorkspaceMessage(wid, { content: '合成一般需求', revision: 1, contextRevision: 2 })).run.testId === null);
  assert.deepEqual(calls.at(-1).body, { content: '合成一般需求', revision: 1, contextRevision: 2 }); checks++;
  responseBody = { ...proposal, scopeConfirmed: true };
  check((await api.confirmWorkspaceScope(wid, pid, 1)).scopeConfirmed);
  assert.deepEqual(calls.at(-1).body, { baseRevision: 1, confirmed: true }); checks++;
  responseBody = { workspace: { ...workspace, settings: config, revision: 2, lifecycle: 'active' }, proposal: { ...proposal, status: 'applied', appliedRevision: 2 } };
  check((await api.confirmWorkspaceProposal(wid, pid, 1)).workspace.settings.purpose === '驗測用途');
  responseBody = { ...proposal, status: 'cancelled' };
  check((await api.cancelWorkspaceProposal(wid, pid, 1)).status === 'cancelled');
  responseBody = { proposal };
  await assert.rejects(api.getWorkspaceProposal(wid, pid), (error) => error instanceof ApiError && error.code === 'INVALID_RESPONSE'); checks++;
  responseBody = { ...workspace, executionAvailable: undefined };
  await assert.rejects(api.getWorkspace(wid), (error) => error instanceof ApiError && error.code === 'INVALID_RESPONSE'); checks++;
  responseBody = { run: { ...run, workspaceId: 'other' }, conversationId: cid };
  await assert.rejects(api.sendWorkspaceMessage(wid, { content: '合成一般需求', revision: 1, contextRevision: 2 }), (error) => error.code === 'WORKSPACE_CONFLICT'); checks++;

  globalThis.window.location.href = 'http://remote.example/';
  const before = calls.length;
  await assert.rejects(api.saveWorkspaceCredentials(wid, roleId, { expectedSecretVersion: 0, username: 'fixture-user', password: 'fixture-password' }), (error) => error.code === 'INSECURE_TRANSPORT');
  check(calls.length === before);
  globalThis.window.location.href = 'http://localhost:18086/';
  await assert.rejects(api.saveWorkspaceCredentials(wid, roleId, { expectedSecretVersion: null, username: 'fixture-user', password: 'fixture-password' }), (error) => error.code === 'INVALID_CREDENTIAL_VERSION'); checks++;
  responseBody = { roleId, secretRef: 'synthetic-ref', secretVersion: 1, configured: true };
  check((await api.saveWorkspaceCredentials(wid, roleId, { expectedSecretVersion: 0, username: 'fixture-user', password: 'fixture-password' })).configured);
  assert.deepEqual(calls.at(-1).body, { expectedSecretVersion: 0, username: 'fixture-user', password: 'fixture-password' }); checks++;
  check(calls.at(-1).redirect === 'error' && calls.at(-1).cache === 'no-store');
  responseBody = { roleId, secretRef: 'synthetic-ref', secretVersion: 1, configured: false };
  check(!(await api.revokeWorkspaceCredentials(wid, roleId, 1)).configured);
  assert.deepEqual(calls.at(-1).body, { expectedSecretVersion: 1, confirmed: true }); checks++;
  status = 409; responseBody = { error: { code: 'conflict', message: 'fixture-password must never be displayed' } };
  const beforeConflict = calls.length;
  await assert.rejects(api.saveWorkspaceCredentials(wid, roleId, { expectedSecretVersion: 1, username: 'fixture-user', password: 'fixture-password' }), (error) => error.status === 409 && !error.message.includes('fixture-password'));
  check(calls.length === beforeConflict + 1);
  console.log(`Workspace API boundary PASS (${checks} checks; synthetic fetch only).`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
}
