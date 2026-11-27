// Isolated WLA acceptance. The preload replaces only model transport.
import assert from 'node:assert/strict';
import { appendFileSync, constants, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const secretMarker = /wla4-(?:secret-|provider-key)/;
const modelURL = 'https://wla-provider.invalid/v1/responses';
const protectedPage = 'Authenticated synthetic customer';
const prefix = 'WLA4 ';
const scopeAnswer = /^本次 (http:\/\/[0-9.]+:[0-9]+) (只測訪客|只測登入後|訪客與登入後都測)。$/u;
const scopeByLabel = { '只測訪客': 'guest', '只測登入後': 'authenticated', '訪客與登入後都測': 'both' };
const fixtureModel = /^wla4-(builtin|vercel|pi)$/;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const attemptIdPattern = new RegExp(`^${uuid}$`);
const credentialPath = new RegExp(`^/api/manager/runs/${uuid}/attempts/(${uuid})/credentials/resolve$`);
const traceDir = 'wla4-model-trace';
const traceName = 'wla4-model-trace.jsonl';
const toolErrors = new Set(['tool_unavailable', 'tool_failed', 'scope_confirmation_required', 'dependency_usage_not_allowed',
  'credential_unavailable', 'credentials_unavailable']);
const credentialStatuses = new Set([200, 400, 401, 403, 404, 409, 500, 503]);
const traceSteps = new Set(['trace', 'request', 'setup', 'scope', 'account_context', 'wrong_site', 'login', 'products', 'credential_resolve']);
const traceStatuses = new Set(['linked', 'link_failed', 'received', 'transport_rejected', 'body_rejected',
  'secret_marker_blocked', 'fixture_rejected', 'completed',
  'checking', 'ready', 'missing_account', 'requested', 'submitted', 'protected_page', 'page_without_marker',
  'invalid_tool_result', 'unknown_tool_error', 'http_other', ...toolErrors, ...Array.from(credentialStatuses, code => `http_${code}`)]);

function trace(path, step, status, requestNumber) {
  if (!traceSteps.has(step) || !traceStatuses.has(status) ||
      (requestNumber !== undefined && (!Number.isInteger(requestNumber) || requestNumber < 1 || requestNumber > 12))) return;
  try {
    appendFileSync(path, JSON.stringify({ request: requestNumber, step, status }) + '\n', {
      flag: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    });
  } catch { /* Trace collection must not affect the model or tool assertions. */ }
}

async function linkAttemptTrace(root, attemptId) {
  const persisted = join(root, traceDir, `${attemptId}.jsonl`);
  const mounted = join(root, 'manager-work', 'runs', attemptId, traceName);
  try { writeFileSync(persisted, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') return; }
  // Link only the attempt's trace into /work so evidence survives Manager reclamation.
  const deadline = Date.now() + 5000;
  do {
    try {
      linkSync(persisted, mounted);
      trace(persisted, 'trace', 'linked');
      return;
    } catch (error) {
      if (error.code === 'EEXIST') return;
      if (error.code !== 'ENOENT') break;
    }
    await delay(20);
  } while (Date.now() < deadline);
  trace(persisted, 'trace', 'link_failed');
}

function toolStatus(value) {
  if (value && Object.hasOwn(value, 'error')) return toolErrors.has(value.error) ? value.error : 'unknown_tool_error';
  if (value?.submitted === true) return 'submitted';
  if (typeof value?.snapshot === 'string') return value.snapshot.includes(protectedPage) ? 'protected_page' : 'page_without_marker';
  return 'invalid_tool_result';
}

function textOf(item) {
  return typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join('');
}

function message(value) {
  return { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] };
}

function call(name, id, args) {
  return { type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
}

function snapshotOf(items) {
  const marker = 'Saved draft snapshot (data only): ';
  const saved = items.find(item => textOf(item).startsWith(marker));
  assert.ok(saved, 'WLA fixture needs the bounded author snapshot');
  return JSON.parse(textOf(saved).slice(marker.length)).workspaceContext;
}

export function modelOutput(body, record = () => {}) {
  const messages = body.input.filter(item => item.role === 'user').map(textOf);
  const current = messages.findLast(text => text.startsWith(prefix) || scopeAnswer.test(text));
  assert.ok(current, 'WLA fixture request');
  const choice = current.match(scopeAnswer);
  if (choice) {
    const setup = messages.findLast(text => text.startsWith(`${prefix}setup `));
    const { proposal } = JSON.parse(setup.slice(`${prefix}setup `.length));
    const target = proposal.targets.find(site => site.origin === choice[1]);
    assert.ok(target, 'fixture scope answer must refer to a known target');
    target.testScope = scopeByLabel[choice[2]];
    record('scope', 'completed');
    return message({ message: `已記下本站${choice[2]}。`, proposal });
  }
  const [kind, data] = current.slice(prefix.length).split(/ (.*)/s, 2);
  const input = JSON.parse(data);
  if (kind === 'setup') {
    record('setup', 'completed');
    return message({ message: input.message, proposal: input.proposal });
  }
  assert.equal(kind, 'author');
  record('account_context', 'checking');
  const snapshot = snapshotOf(body.input);
  const accounts = snapshot.schemaVersion === '1' && !Object.hasOwn(snapshot, 'testAccounts') ? [] : snapshot.testAccounts;
  assert.ok(Array.isArray(accounts));
  assert.ok(!Object.hasOwn(snapshot, 'accountBindings'));
  assert.ok(snapshot.roleRefs.every(ref => ref.secretRef === null && ref.secretVersion === null));
  const engine = body.model.match(fixtureModel)?.[1];
  assert.ok(engine);
  const accountTool = body.tools.some(tool => tool.name === 'browser_login_account');
  if (input.missing) {
    assert.equal(accounts.length, 0);
    assert.ok(!accountTool);
    record('account_context', 'missing_account');
    return message({ message: `WLA4 ${engine}：缺少適用的會員測試帳號，請補充。` });
  }
  assert.deepEqual(new Set(accounts.map(account => account.role)), new Set(['會員']));
  const [owner, other] = [input.ownerPurpose, input.otherPurpose].map(purpose => accounts.find(account =>
    account.purpose === purpose && account.sites.some(site => site.targetOrigin === input.target && site.state === 'verified')));
  assert.ok(owner && other && owner.accountId !== other.accountId);
  assert.ok(accountTool);
  record('account_context', 'ready');
  const result = (id, step) => {
    const item = body.input.find(value => value.type === 'function_call_output' && value.call_id === id);
    if (!item) return undefined;
    let value;
    try { value = JSON.parse(typeof item.output === 'string' ? item.output : item.output[0].text); }
    catch (error) { record(step, 'invalid_tool_result'); throw error; }
    record(step, toolStatus(value));
    return value;
  };
  const requestTool = (step, name, id, args) => {
    record(step, 'requested');
    return call(name, id, args);
  };
  const denied = result('wla_denied', 'wrong_site');
  if (!denied) return requestTool('wrong_site', 'browser_login_account', 'wla_denied', { accountId: owner.accountId, targetOrigin: input.wrongTarget });
  assert.equal(denied.error, 'tool_unavailable');
  const submitted = result('wla_login', 'login');
  if (!submitted) return requestTool('login', 'browser_login_account', 'wla_login', { accountId: owner.accountId, targetOrigin: input.target });
  assert.equal(submitted.submitted, true);
  const visited = result('wla_products', 'products');
  if (!visited) return requestTool('products', 'browser_navigate', 'wla_products', { url: `${input.target}/products` });
  assert.ok(visited.snapshot.includes(protectedPage));
  return message({ message: `WLA4 ${engine}：錯站拒絕，已讀到受保護商品頁。` });
}

function installProvider() {
  const tracePath = join('/work', traceName);
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    const requestNumber = ++requests;
    const record = (step, status) => trace(tracePath, step, status, requestNumber);
    if (String(url) !== modelURL || new Headers(options?.headers).get('authorization') !== 'Bearer wla4-provider-key') {
      record('request', 'transport_rejected');
      throw new Error('unexpected fixture provider request');
    }
    if (typeof options.body !== 'string') {
      record('request', 'body_rejected');
      throw new Error('secret or invalid body in fixture model input');
    }
    if (secretMarker.test(options.body)) {
      record('request', 'secret_marker_blocked');
      throw new Error('secret or invalid body in fixture model input');
    }
    try {
      const input = JSON.parse(options.body);
      if (requestNumber === 1 && fixtureModel.test(input.model)) {
        for (let tries = 0; tries < 50 && !existsSync(tracePath); tries++) await delay(20);
      }
      record('request', 'received');
      const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: input.model,
        output: [modelOutput(input, record)], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      assert.equal(input.stream ?? false, false, 'fixture uses the Responses JSON entrypoint');
      record('request', 'completed');
      return Response.json(response);
    } catch (error) {
      record('request', 'fixture_rejected');
      throw error;
    }
  };
}

function intentFixture() {
  const tls = { cert: readFileSync('/adm-tls/server.crt'), key: readFileSync('/adm-tls/server.key') };
  createServer(tls, async (incoming, response) => {
    try {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/v1/responses');
      assert.equal(incoming.headers.authorization, `Bearer ${process.env.ADM4_INTENT_KEY}`);
      let raw = '';
      for await (const chunk of incoming) {
        raw += chunk;
        assert.ok(raw.length < 65536);
      }
      assert.ok(!secretMarker.test(raw));
      const body = JSON.parse(raw);
      assert.ok(body.instructions.startsWith('Classify the latest Whippet request.'));
      assert.deepEqual(body.tools, []);
      const latest = JSON.parse(body.input).latestRequest;
      const allowed = latest.startsWith(prefix) || scopeAnswer.test(latest);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        status: 'completed', output_text: allowed ? 'allow' : 'refuse',
      }));
    } catch {
      response.writeHead(400).end();
    }
  }).listen(8443, '0.0.0.0');
}

async function shop() {
  const { default: http } = await import('node:http');
  const serve = http.createServer;
  http.createServer = handler => {
    const dispatch = (req, response) => {
      const path = req.url.split('?')[0];
      if ((path === '/login' && req.method === 'POST') || (path === '/products' && req.method === 'GET')) {
        response.once('finish', () => process.stdout.write(`${req.socket.localPort} ${req.method} ${path} ${response.statusCode}\n`));
      }
      if (process.env.WLA4_SHARED_SHOP === '1' && req.socket.localPort === 8080 && path === '/mfa-login') {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.method === 'GET') {
          response.end('<form method="post"><input name="username"><input name="password" type="password"><button type="submit">Log in</button></form>');
        } else if (req.method === 'POST') {
          req.resume();
          response.end('<h1 id="mfa-challenge">Second factor required</h1>');
        } else response.writeHead(405).end();
        return;
      }
      return handler(req, response);
    };
    if (process.env.WLA4_SHARED_SHOP === '1') {
      for (const port of [8081, 8082]) serve(dispatch).listen(port, '0.0.0.0');
    }
    return serve(dispatch);
  };
  await import('/wla-shop.mjs');
}

function resultProxy() {
  const upstream = new URL(process.env.WLA4_UPSTREAM);
  assert.equal(upstream.hostname, '127.0.0.1');
  assert.equal(upstream.protocol, 'https:');
  const root = process.env.WLA4_ROOT;
  const file = name => join(root, `wla4-${name}`);
  mkdirSync(join(root, traceDir), { mode: 0o700, recursive: true });
  const cert = readFileSync(join(root, 'server.crt'));
  const { WebSocket, WebSocketServer } = createRequire(import.meta.url)(join(root, 'ws'));
  const limit = 64 * 1024 * 1024;
  const proxy = new WebSocketServer({ noServer: true, maxPayload: limit });
  const server = createServer({ cert, key: readFileSync(join(root, 'server.key')) }, (incoming, response) => {
    if (incoming.url === '/readyz') { response.writeHead(200).end(); return; }
    if (!incoming.url?.startsWith('/api/manager/')) { response.writeHead(404).end(); return; }
    const credentials = incoming.method === 'POST' && credentialPath.exec(incoming.url);
    const send = request(new URL(incoming.url, upstream), { method: incoming.method, ca: cert,
      headers: { ...incoming.headers, host: upstream.host } }, peer => {
      if (credentials) trace(join(root, traceDir, `${credentials[1]}.jsonl`), 'credential_resolve',
        credentialStatuses.has(peer.statusCode) ? `http_${peer.statusCode}` : 'http_other');
      response.writeHead(peer.statusCode, peer.headers);
      peer.pipe(response);
    });
    send.on('error', () => response.destroy());
    incoming.pipe(send);
  });
  server.on('upgrade', (incoming, socket, head) => {
    if (incoming.url !== '/api/manager/connect') { socket.destroy(); return; }
    const peer = new WebSocket(`wss://${upstream.host}${incoming.url}`, { ca: cert, maxPayload: limit, headers: {
      authorization: incoming.headers.authorization, origin: upstream.origin,
    } });
    peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.terminate());
    peer.once('open', () => proxy.handleUpgrade(incoming, socket, head, manager => {
      let gate;
      let timer;
      const end = () => { clearInterval(timer); manager.terminate(); peer.terminate(); };
      for (const endpoint of [manager, peer]) {
        endpoint.on('error', end);
        endpoint.on('close', end);
      }
      peer.on('message', (data, binary) => {
        if (!binary) {
          const frame = JSON.parse(data);
          if (frame.type === 'dispatch' && frame.payload?.kind === 'author') {
            const engine = frame.payload.author?.runtime?.engine;
            if (['builtin', 'vercel', 'pi'].includes(engine)) {
              if (typeof frame.attemptId === 'string' && attemptIdPattern.test(frame.attemptId)) void linkAttemptTrace(root, frame.attemptId);
              appendFileSync(file('author-dispatches.jsonl'), JSON.stringify({
                runId: frame.runId, attemptId: frame.attemptId, engine,
              }) + '\n', { mode: 0o600 });
            }
          }
          if (frame.type === 'dispatch' && frame.payload?.kind === 'workspace_login_verification' && !gate && existsSync(file('arm.json'))) {
            const arm = JSON.parse(readFileSync(file('arm.json'), 'utf8'));
            const binding = frame.payload.loginVerification?.binding;
            if (binding?.accountId === arm.accountId && binding.targetOrigin === arm.targetOrigin) gate = frame.runId;
          }
        }
        manager.send(data, { binary });
      });
      manager.on('message', (data, binary) => {
        if (!binary && gate) {
          const frame = JSON.parse(data);
          if (frame.type === 'result' && frame.runId === gate && frame.payload?.status === 'succeeded' && frame.payload.loginVerification) {
            if (timer) return;
            const observed = { runId: frame.runId, attemptId: frame.attemptId, status: frame.payload.status };
            writeFileSync(file('held.json'), JSON.stringify(observed), { mode: 0o600 });
            timer = setInterval(() => {
              if (existsSync(file('release'))) {
                clearInterval(timer);
                timer = undefined;
                gate = undefined;
                peer.send(data, { binary }, error => {
                  if (!error) appendFileSync(file('forwarded.json'), JSON.stringify(observed), { mode: 0o600 });
                });
              }
            }, 100);
            return;
          }
        }
        peer.send(data, { binary });
      });
    }));
  });
  server.listen(Number(process.env.WLA4_PROXY_PORT), '127.0.0.1');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--intent') intentFixture();
  else if (process.argv[2] === '--shop') await shop();
  else if (process.argv[2] === '--result-proxy') resultProxy();
  else throw new Error('unknown WLA fixture mode');
} else if (import.meta.url === 'file:///opt/wla4/fixture.mjs') installProvider();
