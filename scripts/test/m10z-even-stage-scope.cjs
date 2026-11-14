#!/usr/bin/env node
// M10.Z #4/#6 定向真產品接縫：隔離 PG 的 Server HTTP/Plan 測試與真 Docker Chromium 負例。
// 預設只產生計畫；--run-pg / --run-docker 均須 Leader 准入檔，且不讀取或輸出 env/憑證/原始 log。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUT = '/private/tmp/whippet-m10z-20261114/even';
const ADMISSION = '/private/tmp/whippet-m10z-20261114/admission.json';
const GO_TESTS = [
  'TestM10PostgresPlanConfirmCancelAndLateResult',
  'TestM10PostgresPlanFailureAndClosedCapabilities',
  'TestM109StageRetryAtomicAndIdempotent',
  'TestM109StageRetryGuardsAndRollback',
  'TestM109StageRetryHTTP',
  'TestM10PlanPureComputeRequiresScope',
];
const DOCKER_TESTS = [
  'M8 synthetic origin/redirect/popup guard and full login spec keep real reports and redact ZIP content',
  'M10 real manual Module + Use Case pass/fail retain named Stage reports',
  'mixed AI module refuses missing confirmed scope before executing even with manual top-level origin',
];

function safeRead(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 128 * 1024) throw new Error('admission_invalid');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function admitted(kind) {
  const a = safeRead(ADMISSION);
  if (a.schemaVersion !== 1 || a.leader !== 't6g' || a.isolatedApi !== 'https://127.0.0.1:19889' || a[kind] !== true) {
    throw new Error('leader_admission_required');
  }
  return a;
}
function write(name, value) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function capture(binary, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderrBytes = 0;
    child.stdout.on('data', b => { stdout += b.toString(); if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes > 2 * 1024 * 1024) child.kill('SIGKILL'); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
  });
}
function goResults(output) {
  const found = new Map();
  for (const line of output.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (!GO_TESTS.includes(event.Test)) continue;
    if (['pass', 'fail', 'skip'].includes(event.Action)) found.set(event.Test, event.Action.toUpperCase());
  }
  return Object.fromEntries(GO_TESTS.map(name => [name, found.get(name) || 'MISSING']));
}
function tapResults(output) {
  const found = new Map();
  for (const line of output.split('\n')) {
    const m = /^(not )?ok \d+ - (.+?)(?: # SKIP.*)?$/.exec(line);
    if (!m || !DOCKER_TESTS.includes(m[2])) continue;
    found.set(m[2], line.includes('# SKIP') ? 'SKIP' : m[1] ? 'FAIL' : 'PASS');
  }
  return Object.fromEntries(DOCKER_TESTS.map(name => [name, found.get(name) || 'MISSING']));
}
async function main() {
  const mode = process.argv[2] || '--prepare';
  if (mode === '--prepare') {
    write('stage-scope-plan.json', {
      mode: 'PREPARED', isolatedApi: 'https://127.0.0.1:19889', web: 'http://127.0.0.1:19887', pgPort: 32782,
      pgTests: GO_TESTS, dockerTests: DOCKER_TESTS,
      remaining: ['新環境 Stage 真失敗/修復與取消 API 旅程', 'Manager 精確 label 容器移除、DB slotReleased/occupied/active/unreclaimed 及後續任務啟動'],
    });
    process.stdout.write('PREPARED stage-scope-plan.json\n'); return;
  }
  if (mode === '--run-pg') {
    admitted('pg');
    const re = '^(' + GO_TESTS.join('|') + ')$';
    const r = await capture('go', ['test', '-json', '-tags=integration', '-count=1', '-timeout=180s', './internal/server', '-run', re], path.join(ROOT, 'services/server'));
    const tests = goResults(r.stdout);
    const status = r.code === 0 && Object.values(tests).every(v => v === 'PASS') ? 'PASS' : 'FAIL';
    write('stage-scope-pg.json', { status, exitCode: r.code, tests, source: 'isolated-PG-real-Go-HTTP', noRawOutputSaved: true });
    process.stdout.write(status + ' stage-scope-pg.json\n'); if (status !== 'PASS') process.exitCode = 1; return;
  }
  if (mode === '--run-docker') {
    const a = admitted('docker');
    if (typeof a.workerImage !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a.workerImage)) throw new Error('pinned_worker_image_required');
    const label = 'whippet.m10z.even=stage-scope';
    const name = 'whippet-m10z-even-scope-' + process.pid;
    const pattern = DOCKER_TESTS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const args = ['run', '--rm', '--network', 'none', '--name', name, '--label', label,
      '-e', 'WHIPPET_M8_BROWSER_TEST=1', '-e', 'WHIPPET_M10_BROWSER_TEST=1', a.workerImage,
      'node', '--test', '--test-reporter=tap', '--test-name-pattern=' + pattern,
      'dist/login/m8-browser.test.js', 'dist/bundle.test.js'];
    const r = await capture('docker', args, ROOT);
    const tests = tapResults(r.stdout);
    const containers = await capture('docker', ['ps', '-a', '--filter', 'label=' + label, '--format', '{{.ID}}'], ROOT);
    const removed = containers.code === 0 && containers.stdout.trim() === '';
    const status = r.code === 0 && removed && Object.values(tests).every(v => v === 'PASS') ? 'PASS' : 'FAIL';
    write('stage-scope-docker.json', { status, exitCode: r.code, tests, image: a.workerImage, exactLabelContainersRemoved: removed, noRawOutputSaved: true });
    process.stdout.write(status + ' stage-scope-docker.json\n'); if (status !== 'PASS') process.exitCode = 1; return;
  }
  throw new Error('usage: --prepare | --run-pg | --run-docker');
}
main().catch(e => { process.stderr.write('BLOCKED ' + (e.message === 'leader_admission_required' ? e.message : 'precondition_failed') + '\n'); process.exitCode = 2; });
