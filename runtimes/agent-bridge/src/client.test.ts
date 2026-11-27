import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAIConfig } from '../../worker/dist/ai/config.js';
import { loadToolRegistry, sha256 } from '../../worker/dist/author/registry.js';
import { call, envelope, text } from '../../worker/dist/author/spike/fixture.js';
import type { PublicWorkspaceContext } from '../../worker/dist/workspace-context.js';
import { BridgeError, strictJSON } from './safety.js';
import { MCPClient, mcpURL } from './transport.js';
import { PrivateState, readToken } from './state.js';
import { runOnce, type Options } from './client.js';

const token = 'synthetic-agent-token', key = 'synthetic-model-secret';
const config = readAIConfig({ WHIPPET_AI_ENABLED: 'true', WHIPPET_AI_ENGINE: 'vercel', OPENCODE_API_KEY: key, WHIPPET_AI_API_KEY: 'synthetic-inactive-secret' });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'whippet-reference-test-')); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'token'), stateFile = join(dir, 'state.json');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const registry = loadToolRegistry(), root = new URL('../../worker/skills/test-author/', import.meta.url);
  const bytes = readFileSync(new URL('manifest.json', root)), manifest = JSON.parse(bytes.toString());
  const main = readFileSync(new URL('SKILL.md', root), 'utf8'), reference = readFileSync(new URL('references/external-mcp.md', root), 'utf8');
  const deadline = new Date(Date.now() + 180000).toISOString();
  const task = { runId: randomUUID(), attemptId: randomUUID(), leaseId: randomUUID(), testId: randomUUID(), state: 'active', expiresAt: new Date(Date.now() + 120000).toISOString(), deadlineAt: deadline,
    contextBundle: { script: '', workspaceSettings: null, workspaceContext: null as PublicWorkspaceContext | null, skillUri: 'whippet://skill/test-author/main', externalReferenceUri: 'whippet://skill/test-author/references/external-mcp',
      author: { conversationId: randomUUID(), baseRevision: 1, skillId: 'test-author', skillVersion: '1', allowedTools: ['read_draft'], messages: [{ role: 'user', content: 'Write a synthetic spec' }], sourceVersion: null, conversationSummary: null,
        skills: [{ id: manifest.id, version: manifest.version, sha256: sha256(main), manifestSha256: sha256(bytes), referenceHashes: Object.fromEntries(manifest.references.map((r: any) => [r.id, r.sha256])) }],
        budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 },
      toolDefinitions: registry.tools.filter(d => d.name === 'read_draft') } };
  const calls: any[] = [], submissions: any[] = [];
  let heartbeatCount = 0, models = 0, failSubmit = false, failHeartbeat = false, uncertainTool = false;
  const mcpFetch: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    const request = strictJSON(String(init?.body)); calls.push(request);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
    else if (request.method === 'resources/read') result = { contents: [{ uri: request.params.uri, text: request.params.uri.endsWith('/main') ? main : reference }] };
    else {
      const { name, arguments: args } = request.params;
      let value: unknown;
      if (name === 'task_claim') value = { task };
      else if (name === 'task_heartbeat') {
        heartbeatCount++;
        if (failHeartbeat && heartbeatCount > 1) return new Response(null, { status: 401 });
        value = { state: 'active', expiresAt: task.expiresAt, deadlineAt: deadline };
      } else if (name === 'task_tool_call') {
        assert.equal(args.runId, task.runId); assert.equal(args.attemptId, task.attemptId); assert.equal(args.leaseId, task.leaseId);
        if (uncertainTool) return Response.json({ jsonrpc: '2.0', id: request.id, result: { isError: true, structuredContent: { error: 'unknown_result' } } });
        value = { script: '', revision: 1 };
      } else if (name === 'task_submit') {
        submissions.push(args);
        if (failSubmit) { failSubmit = false; throw new TypeError('synthetic lost reply'); }
        value = { state: 'submitted', appliedRevision: args.output.script ? 2 : null, validationRunId: null };
      } else throw new Error('unexpected control tool');
      result = { content: [], structuredContent: value };
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  const modelFetch: typeof fetch = async (_url, init) => {
    const body = strictJSON(String(init?.body));
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(body.model, config.model); assert.equal(body.reasoning.effort, config.reasoningEffort); assert.equal(body.max_output_tokens, 8192);
    assert.ok(body.tools.every((tool: any) => tool.name === 'read_draft'));
    assert.equal(String(init?.body).includes(token), false); assert.equal(String(init?.body).includes(key), false);
    models++;
    return Response.json(envelope(models === 1 ? [call('read_draft', 'draft')] : [text(JSON.stringify({ message: '候選未驗證', script: 'synthetic spec', requestValidation: false }))]));
  };
  const options: Options = { url: 'http://127.0.0.1:19500/mcp', tokenFile, stateFile, config, mcpFetch, modelFetch, mcpIntervalMs: 0 };
  return { dir, tokenFile, stateFile, options, task, calls, submissions, models: () => models, heartbeatCount: () => heartbeatCount,
    loseSubmit: () => { failSubmit = true; }, loseHeartbeat: () => { failHeartbeat = true; }, uncertainTool: () => { uncertainTool = true; } };
}

for (const engine of ['vercel', 'pi'] as const) test(`MCP reference worker on ${engine} completes one task and persists no keys`, async t => {
  const f = fixture(t);
  const result = await runOnce({ ...f.options, config: { ...f.options.config, engine } });
  assert.equal(result.state, 'submitted'); assert.equal(result.appliedRevision, 2); assert.equal(f.models(), 2);
  assert.equal(f.submissions.length, 1); assert.equal(f.calls.filter(c => c.params?.name === 'task_tool_call').length, 1);
  assert.ok(f.heartbeatCount() >= 2);
  const journal = readFileSync(f.stateFile, 'utf8');
  for (const secret of [token, key, 'synthetic-inactive-secret']) assert.equal(journal.includes(secret), false);
});
test('MCP reference worker forwards the saved test and submits a new test recommendation as a conversation reply', async t => {
  const f = fixture(t);
  const revision = f.task.contextBundle;
  revision.script = 'existing cart test';
  Object.assign(revision.author, {
    testName: '購物車品項數量',
    validation: { runId: randomUUID(), status: 'failed' },
  });
  const output = { message: '這次要驗證密碼重設。', requestValidation: false, newTestNeeded: true };
  const result = await runOnce({ ...f.options, modelFetch: async (_url, init) => {
    const body = strictJSON(String(init?.body));
    const content = body.input[0].content;
    const textContent = typeof content === 'string' ? content : content.map((part: any) => part.text).join('');
    const saved = JSON.parse(textContent.slice('Saved task snapshot (DATA): '.length));
    assert.equal(saved.script, revision.script);
    assert.equal(saved.testName, '購物車品項數量');
    assert.equal(saved.validation.status, 'failed');
    assert.match(body.instructions, /newTestNeeded:true and requestValidation:false/);
    return Response.json(envelope([text(JSON.stringify(output))]));
  } });
  assert.equal(result.appliedRevision, null);
  assert.equal(result.validationRunId, null);
  assert.deepEqual(f.submissions.map(item => item.output), [output]);
  assert.equal(f.calls.filter(c => c.params?.name === 'task_tool_call').length, 0);
});

const accountLogin = 'browser_login_account';
const accountTool = loadToolRegistry().tools.find(tool => tool.name === accountLogin);
test('WLA-3 reference claim exposes the public account directory and forwards authorized and refused login calls', { skip: !accountTool }, async t => {
  const f = fixture(t);
  const id = randomUUID(), target = 'https://orders.example', other = 'https://help.example';
  const workspace: PublicWorkspaceContext = { schemaVersion: '2', workspaceId: randomUUID(), settingsRevision: 1, roleRefs: [], config: {
    name: 'Fixture', purpose: 'Orders', backgroundSummary: '', targets: [target, other].map(origin => ({ name: origin, purpose: '', origin })),
    dependencies: [], excludedOrigins: [], exclusions: '', defaultTestUrl: target, timeoutMs: 30000, loginRoles: [],
  }, testAccounts: [{ accountId: id, name: 'Member', role: 'member', purpose: 'Inspect an order', sites: [{ targetOrigin: target, state: 'verified' }] }] };
  f.task.contextBundle.workspaceContext = workspace;
  f.task.contextBundle.author.allowedTools = [accountLogin];
  f.task.contextBundle.toolDefinitions = [accountTool!];
  let calls = 0, modelRequests = 0;
  const result = await runOnce({ ...f.options,
    async mcpFetch(url, init) {
      const request = strictJSON(String(init?.body));
      if (request.params?.name !== 'task_tool_call') return f.options.mcpFetch!(url, init);
      const args = request.params.arguments;
      assert.equal(args.runId, f.task.runId); assert.equal(args.attemptId, f.task.attemptId); assert.equal(args.leaseId, f.task.leaseId);
      assert.equal(args.name, accountLogin);
      assert.deepEqual(args.arguments, { accountId: id, targetOrigin: calls++ ? target : other });
      const allowed = args.arguments.targetOrigin === target;
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { isError: !allowed, structuredContent: allowed ? { submitted: true } : { error: 'tool_unavailable' } } });
    },
    async modelFetch(_url, init) {
      const body = strictJSON(String(init?.body));
      const raw = JSON.stringify(body);
      assert.ok(raw.includes('Inspect an order'));
      assert.ok(!raw.includes('accountBindings'));
      assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), [accountLogin]);
      modelRequests++;
      if (modelRequests === 1) return Response.json(envelope([call(accountLogin, 'wrong-target', { accountId: id, targetOrigin: other })]));
      const feedback = body.input.filter((item: { type: string }) => item.type === 'function_call_output').at(-1);
      if (modelRequests === 2) {
        assert.deepEqual(JSON.parse(feedback.output), { error: 'tool_unavailable' });
        return Response.json(envelope([call(accountLogin, 'correct-target', { accountId: id, targetOrigin: target })]));
      }
      assert.deepEqual(JSON.parse(feedback.output), { submitted: true });
      return Response.json(envelope([text('{"message":"表單已送出","requestValidation":false}') ]));
    },
  });
  assert.equal(result.state, 'submitted');
  assert.equal(calls, 2);
  const bad = fixture(t);
  bad.task.contextBundle.workspaceContext = { ...workspace, accountBindings: [] } as PublicWorkspaceContext;
  await assert.rejects(runOnce(bad.options), { code: 'invalid_response' });
  assert.equal(bad.models(), 0);
});
test('lost submit resumes identical body without model or tool replay', async t => {
  const f = fixture(t); f.loseSubmit();
  await assert.rejects(runOnce(f.options), BridgeError);
  assert.equal(strictJSON(readFileSync(f.stateFile, 'utf8')).phase, 'submitting');
  const result = await runOnce(f.options);
  assert.equal(result.state, 'submitted'); assert.equal(f.models(), 2);
  assert.equal(f.submissions.length, 2); assert.deepEqual(f.submissions[0], f.submissions[1]);
  assert.equal(f.calls.filter(c => c.params?.name === 'task_tool_call').length, 1);
});
test('unknown tool result stops without new call ID, submit or automatic restart', async t => {
  const f = fixture(t); f.uncertainTool();
  await assert.rejects(runOnce(f.options), (e: unknown) => e instanceof BridgeError && e.code === 'unknown_result');
  assert.equal(f.submissions.length, 0);
  assert.equal(f.calls.filter(c => c.params?.name === 'task_tool_call').length, 1);
  await assert.rejects(runOnce(f.options), (e: unknown) => e instanceof BridgeError && e.code === 'interrupted_task');
  assert.equal(f.models(), 1);
});
test('lease loss interrupts a pending model response and never submits', async t => {
  const f = fixture(t); f.loseHeartbeat();
  const started = performance.now();
  await assert.rejects(runOnce({ ...f.options, heartbeatMs: 10, modelFetch: async () => new Promise(() => {}) }), BridgeError);
  assert.ok(performance.now() - started < 1000); assert.equal(f.submissions.length, 0);
});
test('pin, tool and secret drift fail closed before model or submit', async t => {
  for (const kind of ['pin', 'tool', 'secret', 'skill'] as const) {
    const f = fixture(t);
    if (kind === 'pin') f.task.contextBundle.author.skills[0]!.sha256 = '0'.repeat(64);
    if (kind === 'tool') f.task.contextBundle.toolDefinitions[0]!.description = 'untrusted replacement';
    if (kind === 'secret') f.task.contextBundle.author.messages[0]!.content = key;
    if (kind === 'skill') f.task.contextBundle.author.skillId = 'module-authoring';
    await assert.rejects(runOnce(f.options)); assert.equal(f.models(), 0); assert.equal(f.submissions.length, 0);
  }
});
test('model output cannot contain proof, partial, duplicate fields or either credential', async t => {
  for (const value of ['{"message":"x","requestValidation":false,"proof":true}', '{"message":"x","requestValidation":false,"partial":{}}', '{"message":"a","message":"b","requestValidation":false}', JSON.stringify({ message: token, requestValidation: false }), JSON.stringify({ message: 'synthetic-inactive-secret', requestValidation: false })]) {
    const f = fixture(t);
    await assert.rejects(runOnce({ ...f.options, modelFetch: async () => Response.json(envelope([text(value)])) }));
    assert.equal(f.submissions.length, 0);
  }
});
test('private files, exclusive state, URL and duplicate-key boundaries', t => {
  const f = fixture(t);
  assert.equal(readToken(f.tokenFile), token);
  chmodSync(f.tokenFile, 0o644); assert.throws(() => readToken(f.tokenFile), BridgeError); chmodSync(f.tokenFile, 0o600);
  symlinkSync(f.tokenFile, join(f.dir, 'link')); assert.throws(() => readToken(join(f.dir, 'link')), BridgeError);
  linkSync(f.tokenFile, join(f.dir, 'hard')); assert.throws(() => readToken(f.tokenFile), BridgeError);
  const first = new PrivateState(f.stateFile), second = new PrivateState(f.stateFile); first.lock();
  assert.throws(() => second.lock(), BridgeError); first.unlock();
  const withCredentials = new URL('https://example.com/mcp');
  withCredentials.username = 'user'; withCredentials.password = 'pass';
  for (const url of ['http://example.com/mcp', withCredentials.href, 'https://example.com/mcp?key=x']) assert.throws(() => mcpURL(url), BridgeError);
  assert.throws(() => strictJSON('{"a":1,"\\u0061":2}'), BridgeError);
  assert.deepEqual(strictJSON('{"a":[{"x":1},{"x":2}],"b":"a,{}"}'), { a: [{ x: 1 }, { x: 2 }], b: 'a,{}' });
  const large = { script: '"\\'.repeat(2 * 1024 * 1024) };
  assert.deepEqual(strictJSON(JSON.stringify(large)), large);
});
test('429 is explicit and never automatically resends a control operation', async () => {
  let requests = 0;
  const client = new MCPClient('http://127.0.0.1:19500/mcp', token, () => {}, async () => { requests++; return new Response(null, { status: 429 }); }, 0);
  await assert.rejects(client.call('task_claim', { requestId: randomUUID() }), (error: unknown) => error instanceof BridgeError && error.code === 'rate_limited');
  assert.equal(requests, 1);
});

for (const engine of ['vercel', 'pi'] as const) test(`ADM v14 ${engine} registers, replays the probe and claims one task`, async t => {
  const f = fixture(t);
  const registrationId = randomUUID(), challengeId = randomUUID();
  const probes: unknown[] = [];
  let probeCalls = 0, registrationHeartbeats = 0;
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  const options: Options = { ...f.options, selfManaged: true, agentHeartbeatMs: 5, config: { ...f.options.config, engine },
    mcpFetch: async (url, init) => {
      const request = strictJSON(String(init?.body));
      if (!request.method.startsWith('whippet/agent/')) return f.options.mcpFetch!(url, init);
      assert.equal(new Headers(init?.headers).get('mcp-protocol-version'), '2025-06-18');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      let result: unknown;
      if (request.method === 'whippet/agent/register') {
        assert.deepEqual(request.params, { engine, provider: 'opencode', model: config.model, skillIds: ['test-author'] });
        result = { registrationId, heartbeatIntervalMs: 30000, expiresAt: future(90000), challenge: { id: challengeId, expiresAt: future(30000) } };
      } else if (request.method === 'whippet/agent/probe') {
        probes.push(request.params);
        if (probes.length === 1) throw new TypeError('synthetic lost probe reply');
        result = { status: 'ready', reason: null };
      } else {
        assert.equal(request.method, 'whippet/agent/heartbeat');
        registrationHeartbeats++;
        assert.deepEqual(request.params, { registrationId });
        result = { expiresAt: future(90000) };
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
    modelFetch: async (url, init) => {
      const body = strictJSON(String(init?.body));
      if (body.max_output_tokens === 128) {
        probeCalls++;
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
        assert.deepEqual(body.tools, []);
        return Response.json(envelope([text(`WHIPPET_PROBE:${challengeId}`)]));
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      return f.options.modelFetch!(url, init);
    },
  };
  await assert.rejects(runOnce(options), { code: 'mcp_unavailable' });
  assert.equal(f.calls.filter(call => call.params?.name === 'task_claim').length, 0);
  assert.equal((await runOnce(options)).state, 'submitted');
  assert.deepEqual(probes, Array(2).fill({ registrationId, challengeId, status: 'passed' }));
  assert.equal(probeCalls, 1);
  assert.ok(registrationHeartbeats > 0);
  assert.ok(!readFileSync(f.stateFile, 'utf8').includes(key));
});

test('ADM v14 a failed self-managed probe reports the fixed reason before stopping', async t => {
  const f = fixture(t);
  const registrationId = randomUUID(), challengeId = randomUUID();
  let probes = 0;
  const options: Options = { ...f.options, selfManaged: true,
    modelFetch: async () => new Response(null, { status: 401 }),
    mcpFetch: async (url, init) => {
      const request = strictJSON(String(init?.body));
      let result: unknown;
      if (request.method === 'whippet/agent/register') {
        result = { registrationId, heartbeatIntervalMs: 30000, expiresAt: new Date(Date.now() + 90000).toISOString(), challenge: { id: challengeId, expiresAt: new Date(Date.now() + 30000).toISOString() } };
      } else if (request.method === 'whippet/agent/probe') {
        probes++;
        assert.deepEqual(request.params, { registrationId, challengeId, status: 'provider_auth_failed' });
        result = { status: 'failed', reason: 'provider_auth_failed' };
      } else return f.options.mcpFetch!(url, init);
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  };
  await assert.rejects(runOnce(options), { code: 'agent_not_ready' });
  assert.equal(probes, 1);
  assert.ok(!f.calls.some(call => call.params?.name === 'task_claim'));
});
