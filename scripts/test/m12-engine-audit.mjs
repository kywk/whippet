// Run before importing either SDK. Deny settings/skill/extension reads and record
// only counts. Never access or emit host configuration contents.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

let checks = 0;
const denied = [];
const inspectPath = value => {
  let path;
  try { path = value instanceof URL ? fileURLToPath(value) : String(value); } catch { return; }
  checks++;
  if (/node_modules/.test(path)) return;
  if (/(^|\/)(\.pi|\.claude|\.codex|\.env[^/]*|AGENTS\.md|CLAUDE\.md|settings\.json|auth\.json|models\.json|extensions|skills)(\/|$)|application_default_credentials/.test(path)) {
    denied.push('unexpected_implicit_read'); throw new Error('m12_implicit_loading_denied');
  }
};
for (const name of ['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync']) {
  const original = fs[name]; fs[name] = function(path, ...args) { inspectPath(path); return original.call(this, path, ...args); };
}
for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'open', 'access']) {
  const original = fsp[name]; fsp[name] = async function(path, ...args) { inspectPath(path); return original.call(this, path, ...args); };
}
syncBuiltinESMExports();
const { fixture, envelope, text, runInput } = await import('../../runtimes/worker/dist/author/spike/fixture.js');
const { piSpikeEngine } = await import('../../runtimes/worker/dist/author/spike/pi.js');
const { vercelSpikeEngine } = await import('../../runtimes/worker/dist/author/spike/vercel.js');
for (const [name, factory] of [['pi', c => piSpikeEngine(c, 'm12-audit')], ['vercel', vercelSpikeEngine]]) {
  const f = await fixture(() => envelope([text()]));
  try {
    const result = await factory(f.config).run(runInput(f.config, { tools: [] }));
    assert.ok(result.finalText); assert.deepEqual(f.bodies[0].tools, []);
    assert.equal(denied.length, 0);
    console.log(JSON.stringify({ engine: name, implicitReads: denied.length, filesystemChecks: checks, tools: 0, pass: true }));
  } finally { await f.close(); }
}
