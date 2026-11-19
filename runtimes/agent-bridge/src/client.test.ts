import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAIConfig } from '../../worker/dist/ai/config.js';
import { loadToolRegistry, sha256 } from '../../worker/dist/author/registry.js';
import { call, envelope, text } from '../../worker/dist/author/spike/fixture.js';
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
    contextBundle: { script: '', workspaceSettings: null, workspaceContext: null, skillUri: 'whippet://skill/test-author/main', externalReferenceUri: 'whippet://skill/test-author/references/external-mcp',
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

test('MCP reference worker completes one task and persists no keys', async t => {
  const f = fixture(t);
  const result = await runOnce(f.options);
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
  const output = { message: '這次要驗證密碼重設。請選「新增測試」。', requestValidation: false };
  const result = await runOnce({ ...f.options, modelFetch: async (_url, init) => {
    const body = strictJSON(String(init?.body));
    const content = body.input[0].content;
    const textContent = typeof content === 'string' ? content : content.map((part: any) => part.text).join('');
    const saved = JSON.parse(textContent.slice('Saved task snapshot (DATA): '.length));
    assert.equal(saved.script, revision.script);
    assert.equal(saved.testName, '購物車品項數量');
    assert.equal(saved.validation.status, 'failed');
    assert.match(body.instructions, /requestValidation:false/);
    return Response.json(envelope([text(JSON.stringify(output))]));
  } });
  assert.equal(result.appliedRevision, null);
  assert.equal(result.validationRunId, null);
  assert.deepEqual(f.submissions.map(item => item.output), [output]);
  assert.equal(f.calls.filter(c => c.params?.name === 'task_tool_call').length, 0);
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
});
test('429 is explicit and never automatically resends a control operation', async () => {
  let requests = 0;
  const client = new MCPClient('http://127.0.0.1:19500/mcp', token, () => {}, async () => { requests++; return new Response(null, { status: 429 }); }, 0);
  await assert.rejects(client.call('task_claim', { requestId: randomUUID() }), (error: unknown) => error instanceof BridgeError && error.code === 'rate_limited');
  assert.equal(requests, 1);
});
