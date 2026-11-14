#!/usr/bin/env node
// 舊 G01–G14 的唯讀 DB 精確欄位投影；不 SELECT author_payload 全文、對話、script、error 或 env。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = '/private/tmp/whippet-m10z-20261114/even';
const BASE = '/private/tmp/whippet-m10-golden-live-r102-20261113/baseline.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function save(v) { fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(ROOT, 'golden-old-pins.json'), JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); }
async function main() {
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const ids = baseline.perTask.map(x => x.authorRunId);
  if (ids.length !== 14 || !ids.every(x => UUID.test(x)) || new Set(ids).size !== 14) throw Error('baseline_ids_invalid');
  const projection = `jsonb_build_object('runId',r.id,'kind',r.kind,'status',r.status,'skillId',r.author_payload->>'skillId','skillVersion',r.author_payload->>'skillVersion','provider',r.author_payload->'model'->>'provider','model',r.author_payload->'model'->>'model','effort',r.author_payload->'model'->>'reasoningEffort','maxModelRequests',r.author_payload->'budget'->>'maxModelRequests','maxToolCalls',r.author_payload->'budget'->>'maxToolCalls','maxDurationMs',r.author_payload->'budget'->>'maxDurationMs','maxOutputTokens',r.author_payload->'budget'->>'maxOutputTokens','registryVersion',r.author_payload->>'toolRegistryVersion','registrySha256',r.author_payload->>'toolRegistrySha256','skills',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s->>'id','version',s->>'version','sha256',s->>'sha256','manifestSha256',s->>'manifestSha256') ORDER BY s->>'id'),'[]'::jsonb) FROM jsonb_array_elements(coalesce(r.author_payload->'skills','[]'::jsonb)) s))`;
  const sql = `BEGIN TRANSACTION READ ONLY; SELECT ${projection} FROM runs r WHERE r.id IN (${ids.map(x => `'${x}'::uuid`).join(',')}) ORDER BY r.id; COMMIT;\n`;
  const command = ['exec', '-i', 'whippet-m10-acceptance-postgres', 'psql', '-X', '-U', 'whippet', '-d', 'whippet_m10', '-v', 'ON_ERROR_STOP=1', '-At'];
  const result = await new Promise((resolve, reject) => {
    const p = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', errBytes = 0;
    p.stdout.on('data', b => { out += b.toString(); if (out.length > 128 * 1024) p.kill('SIGKILL'); });
    p.stderr.on('data', b => { errBytes += b.length; if (errBytes > 128 * 1024) p.kill('SIGKILL'); });
    p.on('error', reject); p.on('close', code => resolve({ code, out })); p.stdin.end(sql);
  });
  if (result.code !== 0) { save({ status: 'UNAVAILABLE', reason: 'read_only_query_failed', count: 0 }); process.stdout.write('UNAVAILABLE golden-old-pins.json\n'); return; }
  const rows = result.out.split('\n').filter(x => x.startsWith('{')).map(x => JSON.parse(x));
  const found = new Map(rows.map(x => [x.runId, x]));
  const perTask = baseline.perTask.map(x => ({ id: x.id, ...(found.get(x.authorRunId) || { runId: x.authorRunId, missing: true }) }));
  save({ status: rows.length === 14 ? 'COMPLETE' : 'INCOMPLETE', source: 'old_DB_read_only_explicit_projection', count: rows.length, perTask });
  process.stdout.write((rows.length === 14 ? 'COMPLETE' : 'INCOMPLETE') + ' golden-old-pins.json\n');
}
main().catch(() => { save({ status: 'UNAVAILABLE', reason: 'precondition_failed', count: 0 }); process.stderr.write('UNAVAILABLE golden-old-pins.json\n'); process.exitCode = 1; });
