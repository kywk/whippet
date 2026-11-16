import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let checks = 0;
const denied = [];
const inspect = value => {
  let path;
  try { path = value instanceof URL ? fileURLToPath(value) : String(value); } catch { return; }
  checks++;
  if (/node_modules/.test(path)) return;
  if (/(^|\/)(\.pi|\.claude|\.codex|\.env[^/]*|AGENTS\.md|CLAUDE\.md|settings\.json|auth\.json|models\.json|extensions|skills)(\/|$)|application_default_credentials/.test(path)) {
    denied.push('implicit_read'); throw new Error('implicit_loading_denied');
  }
};
for (const name of ['readFileSync','existsSync','readdirSync','statSync','lstatSync','openSync']) {
  const original = fs[name]; fs[name] = function(path, ...args) { inspect(path); return original.call(this, path, ...args); };
}
for (const name of ['readFile','readdir','stat','lstat','open','access']) {
  const original = fsp[name]; fsp[name] = async function(path, ...args) { inspect(path); return original.call(this, path, ...args); };
}
syncBuiltinESMExports();
const { selectAgentEngine } = await import('../../runtimes/worker/dist/author/engines/select.js');
const { fixture, envelope, text, runInput } = await import('../../runtimes/worker/dist/author/spike/fixture.js');
const f = await fixture(() => envelope([text()]));
try {
  const config = { ...f.config, engine: 'vercel', contextWindowTokens: 1048576 };
  const result = await selectAgentEngine(config).run(runInput(config, { tools: [], prepareRequest: body => body }));
  assert.ok(result.finalText); assert.deepEqual(f.bodies[0].tools, []); assert.equal(denied.length, 0);
  console.log(JSON.stringify({ engine: 'vercel', passed: true, implicitReads: denied.length, filesystemChecks: checks, registeredTools: 0 }));
} finally { await f.close(); }
