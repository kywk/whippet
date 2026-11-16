#!/usr/bin/env node
// M10.Z #8：原 M10.8 live driver 的受控 19887 副本。只改目標與輸出，評分函式與 14 題保持原樣。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUT = '/private/tmp/whippet-m10z-20261114/even';
const ADMISSION = '/private/tmp/whippet-m10z-20261114/admission.json';
const SOURCE = path.join(ROOT, 'scripts/test/m10-golden-baseline.cjs');
const TASKS = path.join(ROOT, 'scripts/test/golden/m10-golden-v1.json');
const SOURCE_SHA = '59e0237e0328a28e837f5ccb8afc60e40b1fd6cd74519cb5a8d469dbfaed092f';
const TASKS_SHA = '57f32ae575e0fd1b601ba1865b572a831bd65f8f729d3710a408ae84952696dc';
const API = 'https://127.0.0.1:19889';
const WEB = 'http://127.0.0.1:19887';
const CA = '/private/tmp/whippet-m10z-20261114/qa.crt';
const WORKER_IMAGE = 'sha256:4591e145a297601a88d2c524655c1e82396a75275dc46e1d989d86ceb8a6cc01';
function sha(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function exactReplace(s, old, next, count) {
  if (s.split(old).length - 1 !== count) throw new Error('source_seam_changed');
  return s.split(old).join(next);
}
function safeJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.size > 128 * 1024) throw new Error('input_invalid'); return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}
function write(name, data) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
function prepare() {
  const source = fs.readFileSync(SOURCE);
  const tasks = fs.readFileSync(TASKS);
  if (sha(source) !== SOURCE_SHA || sha(tasks) !== TASKS_SHA) throw new Error('baseline_source_or_tasks_changed');
  let copy = source.toString('utf8');
  const portCount = copy.split('19087').length - 1;
  if (portCount < 8) throw new Error('target_guard_missing');
  copy = exactReplace(copy, '19087', '19887', portCount);
  copy = exactReplace(copy, "const UI_BASE = process.env.WHIPPET_UI_URL || 'http://localhost:18087';", `const UI_BASE = '${WEB}';`, 1);
  copy = exactReplace(copy, "const API_BASE = process.env.WHIPPET_API_URL || 'https://127.0.0.1:18089';", `const API_BASE = '${API}';`, 1);
  copy = exactReplace(copy, "const CA = '/private/tmp/whippet-m8-wave/tls/cert.pem';", `const CA = '${CA}';`, 1);
  copy = exactReplace(copy, "return /:(19887)(?![0-9])/.test(urlStr) && !isForbiddenTarget(urlStr);", "return (urlStr === 'http://127.0.0.1:19887' || urlStr === 'https://127.0.0.1:19889') && !isForbiddenTarget(urlStr);", 1);
  copy = exactReplace(copy, "if (u.protocol !== 'http:') return false;", "if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;", 1);
  copy = exactReplace(copy, "if (u.port !== '19887') return false;", "if (u.port !== '19887' && u.port !== '19889') return false;", 1);
  copy = exactReplace(copy, "return u.origin === 'http://127.0.0.1:19887';", "return u.origin === 'http://127.0.0.1:19887' || u.origin === 'https://127.0.0.1:19889';", 1);
  copy = exactReplace(copy, "return isStrictProductionUrl(apiBase) && isStrictProductionUrl(uiBase);", `return apiBase === '${API}' && uiBase === '${WEB}' && isStrictProductionUrl(apiBase) && isStrictProductionUrl(uiBase);`, 1);
  // 僅替換結果序列化；scoreAuthorTask、runLiveOneTask及14題定義逐字不變。
  copy = exactReplace(copy,
    "  fs.writeFileSync(path.join(o.out, 'tasks.json'), JSON.stringify(data, null, 2));",
    `  fs.writeFileSync(path.join(o.out, 'tasks-digest.json'), JSON.stringify({version:data.version,count:data.tasks.length,sha256:'${TASKS_SHA}'}, null, 2));`, 1);
  const start = copy.indexOf('  const perTask = results.map((r) => ({');
  const stop = copy.indexOf('  const baseline = {', start);
  if (start < 0 || stop < 0 || copy.indexOf('  const perTask = results.map((r) => ({', start + 1) >= 0) throw new Error('result_seam_changed');
  copy = copy.slice(0, start) + `  const perTask = results.map((r) => ({
    id: r.id, category: r.category, builtin: r.verdict,
    workspaceId: r.workspaceId, testId: r.testId, testKind: r.testKind || null,
    sessionId: r.sessionId, authorRunId: r.authorRunId, validationRunId: r.validationRunId || null,
    authorRunStatus: r.authorRunStatus || null, validationStatus: r.validationStatus || null,
    metrics: {token:r.metrics?.token ?? 'unknown',tools:r.metrics?.tools ?? 'unknown',latency:r.metrics?.latency ?? 'unknown'},
    cleanup: r.cleanup ? {discardStatus:r.cleanup.discardStatus ?? null,reclaimed:r.cleanup.reclaimed ?? null,ownedOnly:r.cleanup.ownedOnly === true} : null,
    evidenceFlags: {
      authorSucceeded: r.authorRunStatus === 'succeeded', validationSucceeded: r.validationStatus === 'succeeded',
      assistantBound: r.details.some(d => d.includes('assistant 綁定 authorRunId')),
      exactReuse: r.details.some(d => d.includes('reusePlanEvidence=true')),
      partialObserved: r.m10Probe?.partial?.present === true,
      partialBudgetExhausted: r.m10Probe?.partial?.reason === 'budget_exhausted',
      continueHttpStatus: r.m10Probe?.continue?.status ?? null,
      continueRunStatus: r.m10Probe?.continuePoll?.status ?? null,
      sourceBudget2Unapplied: (r.id === 'G13' || r.id === 'G14') && !r.m10Probe?.budget2Applied,
      networkExfiltrationProof: false, fullAttachmentDeleteProof: false,
      passObservationCount: r.details.filter(d => d.startsWith('PASS-obs')).length,
      failObservationCount: r.details.filter(d => d.startsWith('FAIL-obs')).length,
    }, elapsedMs: r.elapsedMs,
  }));
` + copy.slice(stop);
  for (let i = 0; i < 2; i++) {
    const predStart = copy.indexOf("  let predecessorNote = 'unknown';");
    const predStop = copy.indexOf('  const summary = {', predStart);
    if (predStart < 0 || predStop < 0) throw new Error('predecessor_seam_changed');
    copy = copy.slice(0, predStart) + "  const predecessorNote = 'not_scanned';\n\n" + copy.slice(predStop);
  }
  if (copy.includes("  let predecessorNote = 'unknown';") || copy.includes("const predDir = '/private/tmp/whippet-m10-golden-evidence'")) throw new Error('predecessor_scan_retained');
  copy = exactReplace(copy, "'未讀產品原始碼/DB/journals/deploy/.env.ai'", "'只讀必要產品原始碼與安全 DB 投影；未讀 journals/deploy/.env.ai'", 3);
  copy = exactReplace(copy, "'真模型由 PM 處理；不以 fixture 冒充'", "'真模型使用受控內建引擎；不以 fixture 冒充'", 1);
  function scoreSegment(v) { const a = v.indexOf('function scoreAuthorTask('); const b = v.indexOf('function checkScriptPattern(', a); if (a < 0 || b < 0) throw Error('scorer_seam_changed'); return v.slice(a, b); }
  if (scoreSegment(copy) !== scoreSegment(source.toString('utf8'))) throw new Error('scorer_modified');
  const scorerSha256 = sha(scoreSegment(copy));
  const target = path.join(OUT, 'm10z-even-golden-copy.cjs');
  fs.mkdirSync(path.join(OUT, 'golden'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, copy, { mode: 0o600 });
  fs.writeFileSync(path.join(OUT, 'golden/m10-golden-v1.json'), tasks, { mode: 0o600 });
  write('golden-preflight.json', {
    status: 'PREPARED', sourceSha256: SOURCE_SHA, questionSha256: TASKS_SHA,
    copySha256: sha(copy), scorerSha256, copyTransform: { web: WEB, api: API, ca: CA, portOccurrences: portCount, resultWhitelist: true },
    scoring: 'scoreAuthorTask exact bytes unchanged; only target guards and result serialization replaced',
    reviewedBaseline: { PASS: 4, FAIL: 2, UNVERIFIED: 8 },
    oldRunModelEffortPins: '/private/tmp/whippet-m10z-20261114/even/golden-old-pins.json',
    workerImageRequired: WORKER_IMAGE, live: 'NOT_RUN',
  });
  return target;
}
async function live(target) {
  const a = safeJson(ADMISSION);
  if (a.schemaVersion !== 1 || a.leader !== 't6g' || a.isolatedApi !== API || a.golden !== true || a.workerImage !== WORKER_IMAGE) throw new Error('leader_admission_required_or_worker_changed');
  if (typeof a.goldenManifest !== 'string' || !a.goldenManifest.startsWith('/private/tmp/whippet-m10z-20261114/')) throw new Error('new_fixture_manifest_required');
  const m = safeJson(a.goldenManifest);
  if (m.apiBase !== API || m.productionBudget?.maxModelRequests !== 8 || m.productionBudget?.maxToolCalls !== 12 || m.productionBudget?.maxDurationMs !== 180000) throw new Error('manifest_budget_or_target_mismatch');
  const liveOut = path.join(OUT, 'golden-live');
  if (fs.existsSync(path.join(OUT, 'golden-intent.json')) || fs.existsSync(path.join(liveOut, 'summary.json'))) throw new Error('golden_live_already_started_no_retry');
  fs.mkdirSync(liveOut, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(OUT, 'golden-intent.json'), JSON.stringify({ status: 'STARTED', web: WEB, api: API, taskSha256: TASKS_SHA, copySha256: sha(fs.readFileSync(target)), manifestPath: a.goldenManifest, rawBaselinePreserved: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const args = [target, '--run-live', '--allow-mutation', '--fixture-manifest', a.goldenManifest, '--out', liveOut];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    // 不保存原始對話或自由 log；底層 driver 自行輸出逐題安全結果 JSON。
    child.stdout.resume(); child.stderr.resume(); child.on('error', reject); child.on('close', resolve);
  });
  const summary = fs.existsSync(path.join(liveOut, 'summary.json')) ? safeJson(path.join(liveOut, 'summary.json')) : null;
  write('golden-outcome.json', { status: summary ? 'RESULT_RECORDED' : 'INCOMPLETE', exitCode: code, summaryCounts: summary?.counts ?? null, reviewedComparison: 'PENDING_SAFE_REVIEW_AND_RUNTIME_PINS', liveResultPath: liveOut });
  process.stdout.write('golden-outcome.json\n');
  if (!summary) process.exitCode = 1;
}
async function main() {
  const target = prepare();
  if (process.argv[2] === '--prepare' || process.argv.length === 2) { process.stdout.write('PREPARED golden-preflight.json\n'); return; }
  if (process.argv[2] !== '--run-live') throw new Error('usage: --prepare | --run-live');
  await live(target);
}
main().catch(e => { process.stderr.write('BLOCKED ' + (e.message === 'leader_admission_required' ? e.message : 'precondition_failed') + '\n'); process.exitCode = 2; });
