import { pathToFileURL } from 'node:url';
import { readAIConfig } from '../../worker/dist/ai/config.js';
import { runOnce } from './client.js';
import { BridgeError } from './safety.js';

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: npm start -- --mcp-url <HTTPS-or-loopback/mcp> --token-file <private-file> --state-file <private-journal>\nOne test-author task per invocation; explicit Vercel engine; no model/tool retries or publishing.\n');
    return 0;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index], value = args[index + 1];
      if (!name || !['--mcp-url', '--token-file', '--state-file'].includes(name) || values.has(name) || !value) throw new BridgeError('invalid_input');
      values.set(name, value);
    }
    if (values.size !== 3) throw new BridgeError('invalid_input');
    const config = readAIConfig({ ...process.env, WHIPPET_AI_ENGINE: 'vercel' });
    const result = await runOnce({ url: values.get('--mcp-url')!, tokenFile: values.get('--token-file')!, stateFile: values.get('--state-file')!, config, signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    // Never print exception text, stack, task content, env or response bodies.
    process.stdout.write(JSON.stringify({ state: 'stopped', code: error instanceof BridgeError ? error.code : 'worker_failed' }) + '\n');
    return controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
