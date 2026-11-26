// Forward the isolated Manager's HTTPS and WSS unchanged. Record only the checks performed on live attempts.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.env.ADM4_BROKER_UPSTREAM);
if (origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1') throw new Error('expected local HTTPS');
const root = process.env.ADM4_BROKER_ROOT;
const cert = readFileSync(join(root, 'server.crt'));
const key = readFileSync(join(root, 'server.key'));
const resolvePath = '/api/manager/agent-keys/resolve';
const attempts = new Map();

async function body(stream, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('fixture request size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function outbound(path, method, headers, onReply, onError) {
  const outgoing = request(new URL(path, origin), {
    method, ca: cert, headers: { ...headers, host: origin.host },
  }, onReply);
  outgoing.setTimeout(8000, () => outgoing.destroy());
  outgoing.on('error', onError);
  return outgoing;
}

async function probe(path, headers, input) {
  const raw = Buffer.from(JSON.stringify(input));
  const reply = await new Promise((resolve, reject) => {
    outbound(path, 'POST', { ...headers, 'content-length': raw.length, 'content-type': 'application/json' },
      resolve, reject).end(raw);
  });
  const data = await body(reply, 1024 * 1024);
  const result = { status: reply.statusCode };
  if (reply.statusCode >= 400) result.code = JSON.parse(data).error.code;
  return result;
}

const server = createServer({ cert, key }, async (incoming, outgoing) => {
  try {
    if (incoming.url === '/readyz') { outgoing.writeHead(200).end(); return; }
    if (incoming.url === '/fixture/recheck' && incoming.method === 'POST') {
      const { runId } = JSON.parse(await body(incoming));
      const record = attempts.get(runId);
      if (!record) { outgoing.writeHead(404).end(); return; }
      const result = await probe(resolvePath, record.headers, record.input);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      return;
    }
    if (!incoming.url?.startsWith('/api/manager/')) { outgoing.writeHead(404).end(); return; }
    if (incoming.method !== 'POST' || incoming.url !== resolvePath) {
      incoming.pipe(outbound(incoming.url, incoming.method, incoming.headers, (reply) => {
        outgoing.writeHead(reply.statusCode, reply.headers); reply.pipe(outgoing);
      }, () => outgoing.destroy()));
      return;
    }

    const raw = await body(incoming);
    const input = JSON.parse(raw);
    const path = join(root, 'broker-case.json');
    const test = existsSync(path) ? JSON.parse(readFileSync(path)) : {};
    const { authorization, 'x-whippet-manager-session': nonce } = incoming.headers;
    const headers = { authorization, 'x-whippet-manager-session': nonce };
    let record;
    if (input.purpose === 'run') {
      attempts.set(input.runId, { headers, input });
      if (input.agentId === test.agentId) {
        const toolPath = `/api/manager/runs/${input.runId}/attempts/${input.attemptId}/tools`;
        const checks = {
          foreignAgent: probe(resolvePath, headers, { ...input, agentId: test.foreignAgentId }),
          allowedTool: probe(toolPath, headers, { name: 'read_conversation_history', arguments: { cursor: null }, callId: randomUUID() }),
          deniedTool: probe(toolPath, headers, { name: 'read_plan', arguments: {}, callId: randomUUID() }),
        };
        if (input.secretVersion > 1) {
          checks.staleVersion = probe(resolvePath, headers, { ...input, secretVersion: input.secretVersion - 1 });
        }
        record = { runId: input.runId, attemptId: input.attemptId, agentId: input.agentId,
          ...Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([name, result]) => [name, await result]))) };
      }
      if (input.agentId === test.holdAgentId) {
        const { runId, attemptId } = input;
        writeFileSync(join(root, 'broker-held.json'), JSON.stringify({ runId, attemptId }) + '\n', { mode: 0o600 });
        const deadline = Date.now() + 10000;
        while (!outgoing.destroyed && !existsSync(join(root, 'broker-release')) && Date.now() < deadline) await delay(100);
      }
    }
    if (outgoing.destroyed) return;
    outbound(resolvePath, 'POST', incoming.headers, (reply) => {
      if (record) {
        record.ownKey = { status: reply.statusCode, noStore: reply.headers['cache-control'] === 'no-store' };
        appendFileSync(join(root, 'broker-checks.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      }
      outgoing.writeHead(reply.statusCode, reply.headers);
      reply.pipe(outgoing);
    }, () => outgoing.destroy()).end(raw);
  } catch {
    outgoing.writeHead(502).end();
  }
});

server.on('upgrade', (incoming, browser, first) => {
  if (incoming.url !== '/api/manager/connect') { browser.destroy(); return; }
  const headers = { ...incoming.headers, origin: origin.origin };
  const peer = outbound(incoming.url, incoming.method, headers, (reply) => {
    process.stderr.write(`Manager upgrade HTTP ${reply.statusCode}\n`);
    browser.destroy();
  }, () => browser.destroy());
  peer.once('upgrade', (reply, manager, initial) => {
    manager.setTimeout(0);
    const response = [`HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}`];
    for (let index = 0; index < reply.rawHeaders.length; index += 2) {
      response.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`);
    }
    browser.write(response.join('\r\n') + '\r\n\r\n');
    if (first.length) manager.write(first);
    if (initial.length) browser.write(initial);
    manager.on('error', () => browser.destroy());
    browser.on('error', () => manager.destroy());
    manager.on('close', () => browser.destroy());
    browser.on('close', () => manager.destroy());
    browser.pipe(manager).pipe(browser);
  });
  peer.end();
});

server.listen(Number(process.env.ADM4_BROKER_PORT), '127.0.0.1');
