export type BridgeCode = 'invalid_input' | 'invalid_response' | 'secret_file_unavailable' | 'state_unavailable' | 'state_busy' | 'state_mismatch' | 'interrupted_task' | 'mcp_unavailable' | 'mcp_unauthorized' | 'rate_limited' | 'tool_unavailable' | 'busy' | 'unknown_result' | 'lease_lost' | 'unsupported_skill' | 'sensitive_data' | 'incomplete_task' | 'worker_failed';
export class BridgeError extends Error {
  constructor(readonly code: BridgeCode) { super(code); }
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('invalid_response');
  return value as Record<string, any>;
}
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function strictJSON(text: string): any {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new BridgeError('invalid_response'); }
  // JSON.parse validates syntax first. Scan only the already-valid tokens to
  // reject duplicate keys, including keys escaped differently in model output.
  const stack: { object: boolean; key: boolean; seen: Set<string> }[] = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0], frame = stack.at(-1);
    if (token === '{' || token === '[') stack.push({ object: token === '{', key: token === '{', seen: new Set() });
    else if (token === '}' || token === ']') stack.pop();
    else if (frame?.object && token === ',') frame.key = true;
    else if (frame?.object && token === ':') frame.key = false;
    else if (frame?.object && frame.key && token.startsWith('"')) {
      const key = JSON.parse(token) as string;
      if (frame.seen.has(key)) throw new BridgeError('invalid_response');
      frame.seen.add(key);
    }
  }
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function secretGuard(secrets: string[]) {
  return (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (secrets.some(secret => secret && text?.includes(secret))) throw new BridgeError('sensitive_data');
  };
}
export async function boundedJSON(response: Response, maximum = 4 * 1024 * 1024): Promise<any> {
  if (!response.body) throw new BridgeError('invalid_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > maximum) throw new BridgeError('invalid_response');
      chunks.push(next.value);
    }
    return strictJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => undefined); }
}
