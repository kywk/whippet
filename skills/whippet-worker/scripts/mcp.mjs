import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const protocolVersions = ['2025-11-25', '2025-06-18'];
const taskTools = ['task_claim', 'task_heartbeat', 'task_tool_call', 'task_submit'];
const skillURI = /^whippet:\/\/skill\/[a-z0-9-]+\/(main|references\/external-mcp)$/;
const sha256 = /^[a-f0-9]{64}$/;

class CheckError extends Error {}

function connection() {
  const token = process.env.WHIPPET_AGENT_TOKEN;
  if (!token || /\s/.test(token)) throw new CheckError('請由秘密儲存設定 WHIPPET_AGENT_TOKEN');

  let url;
  try {
    url = new URL(process.env.WHIPPET_MCP_URL);
  } catch {
    throw new CheckError('請設定完整的 WHIPPET_MCP_URL');
  }
  const localHTTP = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localHTTP && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new CheckError('MCP URL 須為 HTTPS 或本機測試用的 loopback HTTP，且僅含主機和路徑');
  }
  return { token, url };
}

function mcpClient({ url, token }) {
  let nextID = 1;
  let protocol;
  let session;
  let lastRequest = 0;

  return async function request(method, params = {}, notification = false) {
    // Whippet's per-token limit replenishes one request per second.
    const delay = 1000 - (Date.now() - lastRequest);
    if (delay > 0) await wait(delay);
    lastRequest = Date.now();

    const id = notification ? undefined : nextID++;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    if (session) headers['Mcp-Session-Id'] = session;
    const response = await fetch(url, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After');
      const retry = response.status === 429 && /^\d+$/.test(retryAfter) ? `，${retryAfter} 秒後再試` : '';
      throw new CheckError(`HTTP ${response.status}${retry}`);
    }
    if (notification && response.status === 202) return;
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
      throw new CheckError('預期 Whippet 回傳 JSON 格式的 MCP 回應');
    }
    const reply = await response.json();
    if (reply?.jsonrpc !== '2.0' || reply.id !== id || reply.error || !reply.result) {
      throw new CheckError(`MCP ${method} 回應無效或遭拒`);
    }
    if (method === 'initialize') {
      protocol = reply.result.protocolVersion;
      if (!protocolVersions.includes(protocol)) throw new CheckError('MCP 協定版本不相容');
      session = response.headers.get('Mcp-Session-Id');
    }
    return reply.result;
  };
}

async function main([command, ...args]) {
  const reads = [];
  for (let index = 0; index < args.length; index += 2) {
    reads.push([args[index], args[index + 1]]);
  }
  const checking = command === 'check' && args.length === 0;
  const reading = command === 'read-skill' && [2, 4].includes(args.length) &&
    reads.every(([uri, hash]) => skillURI.test(uri) && sha256.test(hash));
  if (!checking && !reading) {
    throw new CheckError('用法：node scripts/mcp.mjs check | read-skill <URI> <SHA256> [<URI> <SHA256>]');
  }

  const target = connection();
  const request = mcpClient(target);
  await request('initialize', {
    protocolVersion: protocolVersions[0], capabilities: {},
    clientInfo: { name: 'whippet-worker-skill', version: '1' },
  });
  await request('notifications/initialized', {}, true);

  if (checking) {
    const { tools } = await request('tools/list');
    const { resources } = await request('resources/list');
    const uris = new Set(Array.isArray(resources) ? resources.map(resource => resource.uri) : []);
    const taskSkill = [...uris].find(uri => skillURI.test(uri) && uri.endsWith('/main') &&
      uris.has(uri.replace(/\/main$/, '/references/external-mcp')));
    if (!Array.isArray(tools) || !taskTools.every(name => tools.some(tool => tool.name === name)) || !taskSkill) {
      throw new CheckError('此 MCP 入口缺少接單工具或任務技能資源');
    }
    console.log('ready');
    return;
  }

  const documents = [];
  for (const [uri, expected] of reads) {
    const { contents } = await request('resources/read', { uri });
    const content = Array.isArray(contents) && contents.length === 1 ? contents[0] : null;
    if (content?.uri !== uri || typeof content.text !== 'string' || content.text.includes(target.token) ||
      createHash('sha256').update(content.text, 'utf8').digest('hex') !== expected) {
      throw new CheckError('技能資源與任務固定的 SHA-256 不符或回應無效');
    }
    documents.push(content.text);
  }
  process.stdout.write(documents.join('\n\n'));
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof CheckError ? error.message : '無法讀取 MCP，請檢查 URL、網路與 TLS 信任');
  process.exitCode = 1;
});
