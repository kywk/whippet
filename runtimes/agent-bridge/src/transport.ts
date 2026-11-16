import { BridgeError, boundedJSON, object } from './safety.js';
import { setTimeout as delay } from 'node:timers/promises';

export function mcpURL(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/mcp' ||
      !(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error();
    return u.href;
  } catch { throw new BridgeError('invalid_input'); }
}

// Deliberately targets Whippet's stateless JSON Streamable HTTP endpoint.
// No redirects, implicit browser session, transport retry or model-selected URL.
export class MCPClient {
  private sequence = 0;
  private version: string | undefined;
  private nextStart = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly url: string;
  constructor(url: string, private readonly token: string, private readonly guard: (value: unknown) => void, private readonly fetcher: typeof fetch = fetch, private readonly intervalMs = 1000) {
    this.url = mcpURL(url);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 30000) throw new BridgeError('invalid_input');
  }
  async initialize(signal?: AbortSignal) {
    const result = object(await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'whippet-reference-worker', version: '0.1.0' } }, signal));
    if (!['2025-06-18', '2025-11-25'].includes(result.protocolVersion)) throw new BridgeError('invalid_response');
    this.version = result.protocolVersion;
    await this.rpc('notifications/initialized', undefined, signal, true);
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const result = object(await this.rpc('tools/call', { name, arguments: args }, signal));
    if (result.isError) {
      const code = result.structuredContent?.error;
      if (code === 'busy' || code?.code === 'busy') throw new BridgeError('busy');
      if (code === 'unknown_result' || code?.code === 'unknown_result') throw new BridgeError('unknown_result');
      throw new BridgeError('tool_unavailable');
    }
    return object(result.structuredContent);
  }
  async resource(uri: string, signal: AbortSignal): Promise<string> {
    const result = object(await this.rpc('resources/read', { uri }, signal));
    if (!Array.isArray(result.contents) || result.contents.length !== 1 || result.contents[0]?.uri !== uri || typeof result.contents[0].text !== 'string') throw new BridgeError('invalid_response');
    return result.contents[0].text;
  }
  private async rpc(method: string, params?: unknown, signal?: AbortSignal, notification = false): Promise<unknown> {
    // Pace request starts to Whippet's 1/sec replenishment. This is not a retry:
    // every operation is still sent once and an ambiguous result stops work.
    const slot = this.queue.then(async () => {
      const remaining = this.nextStart - performance.now();
      if (remaining > 0) await delay(remaining, undefined, { signal });
      signal?.throwIfAborted();
      this.nextStart = performance.now() + this.intervalMs;
    });
    this.queue = slot.catch(() => undefined);
    await slot;
    const id = ++this.sequence;
    const body = { jsonrpc: '2.0', ...(!notification ? { id } : {}), method, ...(params === undefined ? {} : { params }) };
    this.guard(body);
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 13 * 1024 * 1024) throw new BridgeError('invalid_input');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let response: Response;
    try {
      response = await this.fetcher(this.url, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.version ? { 'MCP-Protocol-Version': this.version } : {}) }, body: encoded });
    } catch { throw new BridgeError('mcp_unavailable'); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new BridgeError(response.status === 401 || response.status === 403 ? 'mcp_unauthorized' : response.status === 429 ? 'rate_limited' : 'mcp_unavailable'); }
    if (notification && response.status === 202) { await response.body?.cancel().catch(() => undefined); return; }
    if (!response.headers.get('content-type')?.startsWith('application/json')) { await response.body?.cancel().catch(() => undefined); throw new BridgeError('invalid_response'); }
    const reply = object(await boundedJSON(response, 13 * 1024 * 1024));
    this.guard(reply);
    if (reply.jsonrpc !== '2.0' || reply.id !== id || reply.error || !Object.hasOwn(reply, 'result')) throw new BridgeError('invalid_response');
    return reply.result;
  }
}
