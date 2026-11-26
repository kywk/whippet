import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = async (file) => ts.transpileModule(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const types = moduleUrl(await compile('types.ts'));
const plan = moduleUrl(await compile('plan.ts'));
const apiSource = (await compile('api.ts')).replace(/from ['"]\.\/types['"]/g, `from '${types}'`).replace(/from ['"]\.\/plan['"]/g, `from '${plan}'`);
const { createHttpApi, resolveMcpEndpoint } = await import(moduleUrl(apiSource));

const wid = '11111111-1111-4111-8111-111111111111';
const aid = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const tokenId = '44444444-4444-4444-8444-444444444444';
const anotherTokenId = '55555555-5555-4555-8555-555555555555';
const now = '2026-11-26T06:10:00Z';
const sampleKey = 'synthetic-model-key';
const sampleToken = 'synthetic-one-time-token';
const agent = { id: aid, workspaceId: wid, name: '合成 Agent', revision: 1, mode: 'managed', engine: 'builtin', provider: 'openai-responses', model: 'fixture-v1',
  profileId: 'fixture', skills: [], status: 'verifying', reason: null, modelKey: { configured: true, version: 1 }, tokenId: null, probeId: null,
  verifiedAt: null, createdAt: now, updatedAt: now };
const resource = { id: 'manager:local/east', name: '本機資源', source: 'manager', agentId: null, revision: 1, workspaceIds: null, control: 'enabled',
  connection: 'online', lastActivityAt: now, interactiveAt: null, claimAt: null, capabilities: { modes: ['managed'], engines: ['builtin'], skills: ['test-author'] },
  capacity: { total: 2, occupied: 1, available: 1 }, attempts: [], browserLeases: [], allowedActions: ['assign'] };
const oldFetch = globalThis.fetch;
const oldWindow = globalThis.window;
let wire;
let inbound;
let status = 200;
let calls = 0;
globalThis.window = { location: { href: 'http://127.0.0.1:8080/whippet/' } };
globalThis.fetch = async (url, init) => {
  calls += 1;
  wire = { url, ...init, body: init.body && JSON.parse(init.body) };
  return Response.json(inbound, { status });
};

try {
  const api = createHttpApi('/whippet/api');
  const admin = api.aiAdmin;
  inbound = { user: { id: 'dev-admin', name: 'Super Admin', role: 'superadmin', permissions: { createWorkspace: true, manageUsers: true, manageSuperAdmins: true } } };
  assert.equal((await api.getMe()).permissions.manageAIResources, false);
  inbound.user.permissions.manageAIResources = true;
  assert.equal((await api.getMe()).permissions.manageAIResources, true);
  assert.equal(resolveMcpEndpoint('/whippet/api/', globalThis.window.location.href), 'http://127.0.0.1:8080/whippet/mcp');
  assert.equal(resolveMcpEndpoint('https://credential@example.test/api', globalThis.window.location.href), null);

  inbound = { items: [resource, { ...resource, id: 'manager:spare', capacity: { total: null, occupied: 0, available: null } }], nextAfter: 'manager:spare' };
  const page = await admin.listResources('manager:earlier');
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1].capacity.available, null);
  assert.equal(new URL(wire.url, globalThis.window.location.href).searchParams.get('after'), 'manager:earlier');
  inbound = resource;
  await admin.changeResource(resource.id, { action: 'assign', revision: 1, workspaceIds: [wid] });
  assert.equal(wire.url, '/whippet/api/admin/ai/resources/manager%3Alocal%2Feast/actions/assign');
  assert.deepEqual(wire.body, { revision: 1, workspaceIds: [wid] });

  const create = { requestId, workspaceId: wid, name: agent.name, mode: agent.mode, engine: agent.engine,
    provider: agent.provider, model: agent.model, profileId: agent.profileId, apiKey: sampleKey };
  status = 201;
  inbound = { agent: { ...agent, apiKey: sampleKey } };
  const created = await admin.createAgent(create);
  assert.equal(Object.hasOwn(created.agent, 'apiKey'), false);
  assert.equal(wire.cache, 'no-store');
  assert.equal(wire.redirect, 'error');
  assert.deepEqual(wire.body, create);
  status = 200;
  assert.equal((await admin.createAgent(create)).agent.id, created.agent.id);

  inbound = { ...agent, revision: 2, modelKey: { configured: true, version: 2 } };
  await admin.rotateKey(aid, 1, sampleKey);
  assert.equal(wire.method, 'PUT');
  assert.deepEqual(wire.body, { expectedSecretVersion: 1, apiKey: sampleKey });
  inbound = { ...agent, revision: 3, status: 'disabled', reason: 'key_missing', modelKey: { configured: false, version: 3 } };
  await admin.revokeKey(aid, 2);
  assert.equal(wire.method, 'DELETE');
  assert.deepEqual(wire.body, { expectedSecretVersion: 2, confirmed: true });
  status = 409;
  inbound = { error: { code: 'stale_revision', message: sampleKey } };
  await assert.rejects(admin.rotateKey(aid, 1, sampleKey), (error) => error.code === 'stale_revision' && !error.message.includes(sampleKey));

  const newResource = { ...resource, source: 'mcp', id: `mcp:${anotherTokenId}`, workspaceIds: [wid] };
  const reissue = { revision: 1, workspaceId: wid, requestId };
  status = 201;
  inbound = { resource: newResource, agent: null, token: sampleToken };
  assert.equal((await admin.reissueAccess(`mcp:${tokenId}`, reissue)).token, sampleToken);
  status = 200;
  await assert.rejects(admin.reissueAccess(`mcp:${tokenId}`, reissue), (error) => error.code === 'INVALID_RESPONSE' && !error.message.includes(sampleToken));
  inbound = { resource: newResource, agent: null };
  assert.equal((await admin.reissueAccess(`mcp:${tokenId}`, reissue)).token, undefined);
  inbound = { resource: { ...newResource, agentId: aid, control: 'revoked' }, agent: {
    ...agent, mode: 'self_managed', engine: 'pi', profileId: null, modelKey: null, tokenId: requestId,
  } };
  const replayed = await admin.reissueAccess(`mcp:${tokenId}`, reissue);
  assert.equal(replayed.resource.id, newResource.id);
  assert.equal(replayed.agent.tokenId, requestId);
  assert.equal(replayed.token, undefined);

  inbound = { workspaceId: wid, revision: 2, agents: { 'test-author': aid } };
  const binding = { revision: 1, skillId: 'test-author', agentId: aid };
  assert.equal((await admin.changeRouting(wid, binding)).agents['test-author'], aid);
  assert.deepEqual(wire.body, binding);
  inbound = { id: requestId, testId: null, workspaceId: wid, status: 'queued', kind: 'author', agentId: aid, createdAt: now };
  assert.equal((await api.getRun(requestId)).agentId, aid);

  const before = calls;
  globalThis.window.location.href = 'http://remote.example/whippet/';
  await assert.rejects(admin.createAgent(create), (error) => error.code === 'INSECURE_TRANSPORT');
  assert.equal(calls, before);
  console.log('ADM AI API boundary PASS (synthetic fetch only).');
} finally {
  globalThis.fetch = oldFetch;
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
}
