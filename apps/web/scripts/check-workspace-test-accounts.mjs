// v15 Web API checks. All responses are synthetic and fetch is replaced in memory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function moduleSource(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const [typesUrl, planUrl] = await Promise.all([moduleSource('types').then(moduleUrl), moduleSource('plan').then(moduleUrl)]);
const source = (await moduleSource('api')).replace(/from ['"]\.\/types['"]/g, `from '${typesUrl}'`).replace(/from ['"]\.\/plan['"]/g, `from '${planUrl}'`);
const { createHttpApi } = await import(moduleUrl(source));

const workspaceId = '11000000-0000-4000-8000-000000000001';
const proposalId = '12000000-0000-4000-8000-000000000001';
const accountId = '15000000-0000-4000-8000-000000000001';
const runId = '16000000-0000-4000-8000-000000000001';
const requestId = '17000000-0000-4000-8000-000000000001';
const targetOrigin = 'https://members.example';
const proposalPath = `/api/workspaces/${workspaceId}/proposals/${proposalId}`;
const credentialsPath = `${proposalPath}/test-accounts/${accountId}/credentials`;
const api = createHttpApi('/api');
const calls = [];
let response;
let status = 200;
globalThis.window = { location: { href: 'https://whippet.example/' } };
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), cache: init.cache, redirect: init.redirect });
  return Response.json(response, { status });
};

const input = { baseRevision: 3, expectedSecretVersion: 0, username: 'fixture-user', password: 'fixture-password' };
response = { accountId, configured: true, secretVersion: 1, password: input.password };
assert.deepEqual(await api.saveWorkspaceProposalCredentials(workspaceId, proposalId, accountId, input), { accountId, configured: true, secretVersion: 1 });
assert.deepEqual(calls.at(-1), { url: credentialsPath, method: 'PUT', body: input, cache: 'no-store', redirect: 'error' });

response = { accountId, configured: false, secretVersion: 2 };
await api.revokeWorkspaceProposalCredentials(workspaceId, proposalId, accountId, { baseRevision: 3, expectedSecretVersion: 1 });
assert.deepEqual(calls.at(-1), { url: credentialsPath, method: 'DELETE', body: { baseRevision: 3, expectedSecretVersion: 1, confirmed: true }, cache: 'no-store', redirect: 'error' });

const before = calls.length;
globalThis.window.location.href = 'http://whippet.example/';
await assert.rejects(api.saveWorkspaceProposalCredentials(workspaceId, proposalId, accountId, input), { code: 'INSECURE_TRANSPORT' });
await assert.rejects(api.revokeWorkspaceProposalCredentials(workspaceId, proposalId, accountId, input), { code: 'INSECURE_TRANSPORT' });
globalThis.window.location.href = 'https://whippet.example/';
await assert.rejects(api.saveWorkspaceProposalCredentials(workspaceId, proposalId, accountId, { ...input, password: '密'.repeat(1366) }), { code: 'INVALID_CREDENTIAL_LENGTH' });
await assert.rejects(api.revokeWorkspaceProposalCredentials(workspaceId, proposalId, accountId, { ...input, expectedSecretVersion: -1 }), { code: 'INVALID_CREDENTIAL_VERSION' });
assert.equal(calls.length, before);

status = 409;
response = { error: { code: 'conflict', message: `${input.username} ${input.password}` } };
await assert.rejects(api.saveWorkspaceProposalCredentials(workspaceId, proposalId, accountId, input), error => error.status === 409 && !error.message.includes(input.username) && !error.message.includes(input.password));
assert.equal(calls.length, before + 1);

status = 202;
const run = { id: runId, workspaceId, testId: null, kind: 'workspace_login_verification', status: 'queued', createdAt: '2026-11-27T00:00:00Z' };
const verification = { baseRevision: 3, requestId, accountId, targetOrigin };
response = { run };
assert.equal((await api.verifyWorkspaceProposalLogin(workspaceId, proposalId, verification)).id, runId);
assert.deepEqual(calls.at(-1), { url: `${proposalPath}/verify-login`, method: 'POST', body: verification, cache: 'default', redirect: 'follow' });
for (const invalid of [{ workspaceId: 'other-workspace' }, { testId: 'test' }, { kind: 'validation' }]) {
  response = { run: { ...run, ...invalid } };
  await assert.rejects(api.verifyWorkspaceProposalLogin(workspaceId, proposalId, verification), { code: 'WORKSPACE_CONFLICT' });
}

status = 200;
response = { ...run, status: 'cancelled' };
assert.equal((await api.cancelRun(runId)).kind, 'workspace_login_verification');
assert.equal(calls.at(-1).url, `/api/runs/${runId}/cancel`);
console.log('PASS WLA-2 proposal credentials, verification Run and cancellation API');
