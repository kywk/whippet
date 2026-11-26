import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const key = readFileSync('/adm-tls/server.key');
const cert = readFileSync('/adm-tls/server.crt');
const bearer = `Bearer ${process.env.ADM4_INTENT_KEY}`;

function proposalResponse(input) {
  const { instruction, options } = input;
  if (Object.keys(input).sort().join(',') !== 'instruction,options' || !instruction.startsWith('ADM-4 ') ||
      instruction.includes('adm-synthetic-key-') || Object.keys(options).sort().join(',') !== 'managed,selfManaged' ||
      options.managed.some((item) => Object.keys(item).sort().join(',') !== 'engine,model,profileId,provider') ||
      options.selfManaged.some((item) => Object.keys(item).sort().join(',') !== 'engine,providers')) {
    throw new Error('fixture proposal contract');
  }
  if (instruction.includes('自管')) {
    const pi = options.selfManaged.find((option) => option.engine === 'pi' && option.providers.includes('openai-responses'));
    if (!pi) throw new Error('fixture Pi option');
    return { name: 'ADM-4 自管提案', mode: 'self_managed', engine: 'pi', provider: 'openai-responses',
      model: 'fixture-model', profileId: null };
  }
  const config = options.managed.find((option) => option.profileId === 'adm-builtin');
  if (!config) throw new Error('fixture Builtin option');
  return { ...config, name: 'ADM-4 代管提案', mode: 'managed',
    profileId: instruction.includes('選項外') ? 'unsupported-fixture' : config.profileId };
}

createServer({ key, cert }, async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.authorization !== bearer) {
    response.writeHead(401).end();
    return;
  }
  try {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 65536) throw new Error('fixture request size');
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tools) || data.tools.length || data.store !== false || data.max_output_tokens !== 1024) {
      throw new Error('fixture model contract');
    }
    const input = JSON.parse(data.input);
    let text;
    if (data.instructions.startsWith('Draft a non-secret Whippet Agent configuration')) {
      text = JSON.stringify(proposalResponse(input));
      appendFileSync('/adm-evidence/proposal-requests.jsonl', JSON.stringify({
        toolCount: data.tools.length, store: data.store, maxOutputTokens: data.max_output_tokens,
      }) + '\n', { mode: 0o600 });
      if (input.instruction.includes('供應商失敗')) { response.writeHead(503).end(); return; }
      if (input.instruction.includes('等待封存')) await delay(1500);
    } else if (data.instructions.startsWith('Classify the latest Whippet request.')) {
      text = input.latestRequest.startsWith('ADM-4 ') ? 'allow' : 'refuse';
    } else {
      throw new Error('fixture instruction contract');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      status: 'completed', output_text: text,
    }));
  } catch {
    response.writeHead(400).end();
  }
}).listen(8443, '0.0.0.0');
