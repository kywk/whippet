// A5 self-managed claim against a fresh real Server, PostgreSQL and Docker Worker.
// Usage: node scripts/test/adm5-mcp-claim.mjs <source> <linux-server> <local-manager> <worker-image> <feature-commit>
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { readAIConfig } from '../../runtimes/worker/dist/ai/config.js';
import { call, envelope, text } from '../../runtimes/worker/dist/author/spike/fixture.js';
import { runOnce } from '../../runtimes/agent-bridge/dist/client.js';
import { BridgeError, secretGuard, uuid } from '../../runtimes/agent-bridge/dist/safety.js';
import { MCPClient } from '../../runtimes/agent-bridge/dist/transport.js';

const [source, serverBinary, managerBinary, image, commit] = process.argv.slice(2);
const evidence = { featureCommit: commit, runtime: 'pi', provider: 'synthetic', checks: {}, ids: {}, paidProviderCalls: 0 };
const admin = '/api/admin/ai';
const heading = 'ADM-5 claim ready';
const candidate = `import { test, expect } from '@playwright/test';
test('A5 self-managed candidate', async ({ page }) => {
  await page.setContent('<h1>${heading}</h1>');
  await expect(page.getByRole('heading')).toHaveText('${heading}');
});
`;

let stage = 'arguments';
let workDir, network, database, intentServer, server, manager;
const codes = { lastHTTP: null, lastMCP: null };

function mark(name, condition, actual = true) {
  assert.ok(condition, name);
  evidence.checks[name] = actual;
}

function docker(args, { input, env } = {}) {
  return execFileSync('docker', args, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).trim();
}

function container(options, env, image, command = []) {
  const keys = Object.keys(env).flatMap(key => ['--env', key]);
  return docker(['run', '--detach', '--rm', '--pull=never', ...options, ...keys, image, ...command], { env: { ...process.env, ...env } });
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const socket = createSocket();
  const port = await listen(socket);
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function until(label, read, accept, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(200);
  }
  assert.fail(label);
}

function launch(binary, env) {
  return spawn(binary, [], { cwd: source, env, stdio: 'ignore' });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 12000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const toolName = request => request.method === 'tools/call' ? request.params.name : request.method;

function toolFailure(error, expected) {
  return error instanceof BridgeError && error.code === expected;
}

async function main() {
  assert.ok(source && serverBinary && managerBinary && image && /^[0-9a-f]{40}$/.test(commit ?? ''), 'arguments');
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'whippet-adm5-claim-')));
  const adminKey = randomBytes(32).toString('hex');
  const managerKey = randomBytes(32).toString('hex');
  const intentKey = randomBytes(32).toString('hex');
  const modelKey = randomBytes(32).toString('hex');
  const dbPassword = randomBytes(32).toString('hex');
  const isolatedID = randomUUID().replaceAll('-', '');
  const managerID = `adm5-${isolatedID.slice(0, 16)}`;
  const registry = join(source, 'contracts/tools/registry.json');
  const skills = join(source, 'runtimes/worker/skills');
  const model = 'fixture-model';
  const testedImage = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  evidence.workerRevision = testedImage;

  stage = 'database';
  network = docker(['network', 'create', `whippet-adm5-${isolatedID}`]);
  database = container(['--network', network, '--network-alias', 'adm5-db'], { POSTGRES_PASSWORD: dbPassword }, 'postgres:16.11-bookworm');
  await until('postgres_ready', () => {
    try { docker(['exec', database, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres']); return true; }
    catch { return false; }
  }, Boolean);

  stage = 'classifier';
  const ca = join(workDir, 'intent.pem'), privateKey = join(workDir, 'intent-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=ADM5 fixture',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:adm5-intent', '-keyout', privateKey, '-out', ca], { stdio: 'ignore', timeout: 20000 });
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(ca, 'utf8')]);
  writeFileSync(join(workDir, 'intent.mjs'), `
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
createServer({ cert: readFileSync('/fixture/intent.pem'), key: readFileSync('/fixture/intent-key.pem') }, async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.authorization !== 'Bearer ' + process.env.FIXTURE_INTENT_KEY ||
          body.model !== 'fixture-model' || !Array.isArray(body.tools) || body.tools.length !== 0) throw new Error('fixture_classifier_request');
      process.stdout.write('intent_accepted\\n');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output_text: 'allow' }));
    } catch { response.writeHead(400).end(); }
}).listen(8443, '0.0.0.0', () => process.stdout.write('ready\\n'));
`, { mode: 0o600 });
  intentServer = container(['--network', network, '--network-alias', 'adm5-intent', '--publish', '127.0.0.1::8443', '--mount', `type=bind,source=${workDir},target=/fixture,readonly`],
    { FIXTURE_INTENT_KEY: intentKey }, 'node:24.21.0-alpine', ['node', '/fixture/intent.mjs']);
  await until('intent_ready', () => docker(['logs', intentServer]), logs => logs === 'ready');

  stage = 'server';
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const mcpURL = `${origin}/mcp`;
  const vault = join(workDir, 'vault.key');
  writeFileSync(vault, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  server = container(['--network', network, '--publish', `127.0.0.1:${port}:8080`, '--entrypoint', `/bin-fixture/${basename(serverBinary)}`,
    '--mount', `type=bind,source=${dirname(serverBinary)},target=/bin-fixture,readonly`, '--mount', `type=bind,source=${source},target=/feature,readonly`,
    '--mount', `type=bind,source=${workDir},target=/fixture`], {
    SSL_CERT_FILE: '/fixture/intent.pem', TLS_CERT_FILE: '/fixture/intent.pem', TLS_KEY_FILE: '/fixture/intent-key.pem',
    DATABASE_URL: `postgres://postgres:${dbPassword}@adm5-db/postgres?sslmode=disable`,
    MANAGER_TOKEN: managerKey, WHIPPET_ADMIN_TOKEN: adminKey, WHIPPET_PUBLIC_ORIGIN: origin, PORT: '8080',
    WHIPPET_SECRET_MASTER_KEY_FILE: '/fixture/vault.key', ARTIFACT_DIR: '/fixture/artifacts',
    WHIPPET_TOOL_REGISTRY_PATH: '/feature/contracts/tools/registry.json', WHIPPET_SKILLS_PATH: '/feature/runtimes/worker/skills',
  }, 'postgres:16.11-bookworm');
  await until('server_ready', async () => {
    try { return (await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, Boolean);

  let cookie = '';
  async function rest(method, path, expected, body) {
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    if (path === '/api/dev-login') headers['X-Whippet-Admin-Token'] = adminKey;
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (path === '/api/dev-login') cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const value = response.status === 204 ? null : await response.json();
    codes.lastHTTP = { status: response.status, code: value?.error?.code ?? null };
    assert.equal(response.status, expected, 'platform_http_status');
    return value;
  }
  await rest('POST', '/api/dev-login', 200, { userId: 'dev-admin' });
  mark('adminSession', cookie !== '');

  stage = 'manager';
  const dockerHost = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  mkdirSync(join(workDir, 'manager'), { mode: 0o700 });
  manager = launch(managerBinary, {
    WHIPPET_AUTHOR_INTENT_CA_FILE: ca,
    WHIPPET_AUTHOR_INTENT_BASE_URL: `https://${docker(['port', intentServer, '8443/tcp'])}/v1`, WHIPPET_AUTHOR_INTENT_MODEL: model, WHIPPET_AUTHOR_INTENT_API_KEY: intentKey,
    PATH: process.env.PATH, DOCKER_HOST: dockerHost, SERVER_URL: origin, SERVER_CA_FILE: ca, MANAGER_TOKEN: managerKey, MANAGER_ID: managerID,
    WORKER_IMAGE: testedImage, WORK_DIR: join(workDir, 'manager'), MAX_WORKERS: '1', WHIPPET_TOOL_REGISTRY_PATH: registry, WHIPPET_SKILLS_PATH: skills,
  });
  await until('manager_online', () => rest('GET', `${admin}/resources`, 200), value => value.items.some(item => item.id === `manager:${managerID}` && item.connection === 'online'));
  mark('validationManager', true, managerID);

  stage = 'fixture_scope';
  const workspace = await rest('POST', '/api/workspaces', 201, { name: 'ADM-5 claim' });
  const other = await rest('POST', '/api/workspaces', 201, { name: 'ADM-5 other' });
  assert.ok(uuid(workspace.id) && uuid(other.id), 'workspace_ids');
  evidence.ids.workspaceId = workspace.id;
  evidence.ids.otherWorkspaceId = other.id;
  // Seed only the synthetic site's already-confirmed scope in the disposable DB.
  const scope = { name: 'ADM-5 claim', purpose: 'Synthetic title verification', backgroundSummary: '', targets: [{ name: 'fixture', purpose: 'Synthetic title', origin: 'https://adm5-fixture.invalid' }],
    dependencies: [], excludedOrigins: [], exclusions: '', loginRoles: [], defaultTestUrl: '', timeoutMs: 60000 };
  const encodedScope = JSON.stringify(scope).replaceAll("'", "''");
  docker(['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `UPDATE workspaces SET canonical_config='${encodedScope}'::jsonb,lifecycle='active',scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id IN ('${workspace.id}'::uuid,'${other.id}'::uuid);`,
  });
  const testCase = await rest('POST', `/api/workspaces/${workspace.id}/tests`, 201, { name: 'ADM-5 reference candidate', description: '' });
  const editing = (await rest('POST', `/api/tests/${testCase.id}/editing-session`, 201, {})).session;
  evidence.ids.testId = testCase.id;

  stage = 'unverified';
  const created = await rest('POST', `${admin}/agents`, 201, { requestId: randomUUID(), workspaceId: workspace.id, name: 'ADM-5 Pi', mode: 'self_managed', engine: 'pi', provider: 'openai-responses', model });
  const tokenID = created.agent.tokenId;
  evidence.ids.agentId = created.agent.id;
  mark('initialAgent', created.agent.status === 'waiting_connection' && !!created.token && uuid(tokenID), created.agent.status);
  const otherToken = (await rest('POST', `/api/workspaces/${other.id}/agent-tokens`, 201, { name: 'ADM-5 outside Workspace' })).token;
  const guard = secretGuard([created.token, otherToken, modelKey, intentKey, adminKey, managerKey, dbPassword]);
  const traceFetch = async (url, init) => {
    const response = await fetch(url, init);
    const payload = response.status === 200 ? await response.clone().json() : null;
    codes.lastMCP = { http: response.status, isError: payload?.result?.isError === true,
      error: payload?.result?.structuredContent?.error ?? payload?.error?.data?.code ?? null };
    return response;
  };
  const own = new MCPClient(mcpURL, created.token, guard, traceFetch);
  const outside = new MCPClient(mcpURL, otherToken, guard, traceFetch);
  await Promise.all([own.initialize(), outside.initialize()]);
  await assert.rejects(own.call('task_claim', { requestId: randomUUID() }), error => toolFailure(error, 'agent_not_ready'));
  mark('unverifiedClaimDenied', codes.lastMCP?.error === 'agent_not_ready', codes.lastMCP);

  const tokenFile = join(workDir, 'agent-token'), stateFile = join(workDir, 'bridge.json');
  writeFileSync(tokenFile, `${created.token}\n`, { mode: 0o600 });
  const modelURL = 'https://adm5-provider.invalid/v1';
  const config = readAIConfig({ WHIPPET_AI_ENABLED: 'true', WHIPPET_AI_ENGINE: 'pi', WHIPPET_AI_PROVIDER: 'openai-responses',
    WHIPPET_AI_BASE_URL: modelURL, WHIPPET_AI_MODEL: model, WHIPPET_AI_API_KEY: modelKey, WHIPPET_AI_REASONING_EFFORT: 'low', WHIPPET_AI_CONTEXT_WINDOW_TOKENS: '32768' });
  let challenge, registrationId, queued, task, firstSubmit, receipt;
  let probeCalls = 0, modelCalls = 0, claims = 0, acceptedTools = 0, taskHeartbeats = 0, submitCalls = 0;
  const resource = `${admin}/resources/${encodeURIComponent(`mcp:${tokenID}`)}`;
  const options = { url: mcpURL, tokenFile, stateFile, config, selfManaged: true, signal: AbortSignal.timeout(90000),
    mcpFetch: async (url, init) => {
      const request = JSON.parse(String(init.body));
      const response = await traceFetch(url, init);
      if (response.status !== 200) return response;
      const reply = await response.clone().json();
      const name = toolName(request);
      if (name === 'whippet/agent/register') {
        stage = 'register';
        ({ registrationId, challenge } = reply.result);
        mark('registered', uuid(registrationId) && uuid(challenge.id) && reply.result.heartbeatIntervalMs === 30000);
      } else if (name === 'whippet/agent/probe') {
        stage = 'queue';
        mark('probeAccepted', request.params.status === 'passed' && reply.result.status === 'ready', reply.result.status);
        const expiry = await own.agent('heartbeat', { registrationId });
        mark('registrationHeartbeat', Date.parse(expiry.expiresAt) > Date.now());
        await rest('PATCH', `${admin}/workspaces/${workspace.id}/agent-routing`, 200, { revision: 1, skillId: 'test-author', agentId: created.agent.id });
        queued = (await rest('POST', `/api/tests/${testCase.id}/messages`, 202, { editingSessionId: editing.id, revision: editing.draft.revision,
          content: '請用 Playwright 建立一個驗證合成頁面標題的測試。' })).run;
        mark('routedAuthor', queued.agentId === created.agent.id && queued.workspaceId === workspace.id && queued.authorEngine === 'external', queued.status);
      } else if (name === 'task_claim') {
        stage = 'claim';
        claims++;
        task = reply.result?.structuredContent?.task;
        mark('claimed', task?.runId === queued.id && task.testId === testCase.id && uuid(task.attemptId) && uuid(task.leaseId));
        Object.assign(evidence.ids, { runId: task.runId, attemptId: task.attemptId, leaseId: task.leaseId });
        const identity = { runId: task.runId, attemptId: task.attemptId, leaseId: task.leaseId };
        await assert.rejects(outside.call('task_heartbeat', identity), error => toolFailure(error, 'tool_unavailable'));
        mark('crossWorkspaceHeartbeatDenied', codes.lastMCP?.http === 200 && codes.lastMCP.isError, codes.lastMCP);
        await assert.rejects(outside.call('task_submit', { ...identity, submitId: randomUUID(), output: { message: 'Fixture denied', requestValidation: false } }),
          error => toolFailure(error, 'tool_unavailable'));
        mark('crossWorkspaceSubmitDenied', codes.lastMCP?.http === 200 && codes.lastMCP.isError, codes.lastMCP);
        const r = await rest('GET', resource, 200);
        const paused = await rest('POST', `${resource}/actions/pause_claim`, 200, { revision: r.revision });
        mark('claimPaused', paused.control === 'paused' && paused.capacity.occupied === 1, paused.control);
        await assert.rejects(own.call('task_claim', { requestId: randomUUID() }), error => toolFailure(error, 'claim_paused'));
        mark('newClaimDeniedWhilePaused', codes.lastMCP?.error === 'claim_paused', codes.lastMCP);
      } else if (name === 'task_heartbeat') {
        stage = 'active_heartbeat';
        assert.equal(reply.result?.structuredContent?.state, 'active', 'active_task_heartbeat');
        taskHeartbeats++;
      } else if (name === 'task_tool_call') {
        stage = 'tool';
        assert.equal(request.params.arguments.name, 'read_draft', 'expected_draft_tool');
        assert.ok(!reply.result?.isError && reply.result?.structuredContent?.baseRevision === editing.draft.revision, 'read_draft_result');
        acceptedTools++;
      } else if (name === 'task_submit') {
        stage = 'submit';
        submitCalls++;
        const args = request.params.arguments;
        const result = reply.result?.structuredContent;
        mark('candidateAccepted', result?.state === 'submitted' && result.appliedRevision > editing.draft.revision && uuid(result.validationRunId), result?.state);
        if (submitCalls === 1) {
          firstSubmit = args;
          receipt = result;
          throw new TypeError('synthetic lost submit delivery');
        }
        assert.deepEqual(args, firstSubmit, 'identical_submit');
        assert.deepEqual(result, receipt, 'identical_receipt');
      }
      return response;
    },
    modelFetch: async (url, init) => {
      assert.ok(url === `${modelURL}/responses` && new Headers(init.headers).get('authorization') === `Bearer ${modelKey}`, 'model_transport');
      const body = JSON.parse(String(init.body));
      guard(body);
      assert.equal(body.model, model, 'model_pin');
      if (body.max_output_tokens === 128) {
        probeCalls++;
        assert.ok(body.tools.length === 0 && JSON.stringify(body.input).includes(`WHIPPET_PROBE:${challenge.id}`), 'probe_constraints');
        return Response.json(envelope([text(`WHIPPET_PROBE:${challenge.id}`)], { model }));
      }
      modelCalls++;
      assert.ok(modelCalls <= 2 && body.tools.some(tool => tool.name === 'read_draft'), 'author_model_budget');
      const output = modelCalls === 1 ? call('read_draft', 'adm5-read-draft') : text(JSON.stringify({ message: '已提交候選稿並要求正式驗證。', script: candidate, requestValidation: true }));
      return Response.json(envelope([output], { model }));
    },
  };

  stage = 'bridge';
  await assert.rejects(runOnce(options), error => toolFailure(error, 'mcp_unavailable') && submitCalls === 1);
  const result = await runOnce(options);
  mark('sameSubmitReceipt', result.state === 'submitted' && result.runId === queued.id && submitCalls === 2 && claims === 1 && probeCalls === 1 && modelCalls === 2, result.state);
  mark('inFlightClaimContinued', taskHeartbeats >= 2 && acceptedTools === 1, { taskHeartbeats, acceptedTools });
  const classifierRequests = docker(['logs', intentServer]).split('\n').filter(line => line === 'intent_accepted').length;
  mark('intentGate', classifierRequests === 1, classifierRequests);
  guard(readFileSync(stateFile, 'utf8'));
  evidence.ids.validationRunId = result.validationRunId;

  stage = 'formal_validation';
  const validation = await until('validation_terminal', () => rest('GET', `/api/runs/${result.validationRunId}`, 200), r => ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(r.status), 90000);
  evidence.validation = { kind: validation.kind, status: validation.status, origin: validation.scriptOrigin, report: !!validation.reportUrl };
  mark('formalValidationSucceeded', validation.status === 'succeeded' && validation.kind === 'validation' && validation.scriptOrigin === 'ai' && !!validation.reportUrl);
  const report = await rest('GET', `/api/runs/${validation.id}/artifacts/results.json`, 200);
  mark('playwrightResult', report.stats.expected === 1 && report.stats.unexpected === 0, { passed: report.stats.expected, failed: report.stats.unexpected });
  const draft = await rest('GET', `/api/tests/${testCase.id}/draft`, 200);
  mark('candidateStored', draft.script === candidate && draft.revision === result.appliedRevision && draft.validationRunId === validation.id);

  stage = 'revoke';
  await rest('DELETE', `/api/workspaces/${workspace.id}/agent-tokens/${tokenID}`, 204);
  await assert.rejects(own.call('task_heartbeat', { runId: task.runId, attemptId: task.attemptId, leaseId: task.leaseId }), error => toolFailure(error, 'mcp_unauthorized'));
  mark('revokedTokenDenied', codes.lastMCP?.http === 401, codes.lastMCP);
  evidence.passed = true;
}

try {
  await main();
} catch (error) {
  evidence.passed = false;
  evidence.stage = stage;
  evidence.failure = error instanceof BridgeError ? error.code : error?.code ?? error?.name ?? 'unknown';
  evidence.last = codes;
} finally {
  await stop(manager);
  for (const id of [server, intentServer, database].filter(Boolean)) {
    try { docker(['stop', '--time', '2', id]); }
    catch { evidence.passed = false; evidence.cleanup = 'container_stop_failed'; }
  }
  if (network) {
    try { docker(['network', 'rm', network]); }
    catch { evidence.passed = false; evidence.cleanup = 'network_remove_failed'; }
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}
