// Isolated verifyDraft observation driver. Run only after Leader admits browser capacity
// and the Worker owner freezes shared dist. Never records scripts or free-form errors.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const sentinel = 'SECRET_SENTINEL_W3_ODD';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const prefix = "import {test,expect} from '@playwright/test';";
const allowedFailure = new Set(['INVALID_SPEC', 'GUARD', 'TIMEOUT', 'CANCELLED', 'TEST_FAILED', 'UNKNOWN']);
const allowedStep = new Set(['EXPECT', 'PW_API', 'TEST_STEP', 'OTHER', 'UNOBSERVED']);
const allowedNavigation = new Set(['OBSERVED', 'NOT_OBSERVED', 'UNOBSERVED']);
const allowedModelStage = new Set(['UNKNOWN', 'FETCH_REJECTED', 'HTTP_NON_OK', 'BODY_JSON_REJECTED', 'RESPONSE_GUARD_REJECTED', 'INCOMPLETE_MAX_OUTPUT_TOKENS', 'INCOMPLETE_CONTENT_FILTER', 'INCOMPLETE_UNKNOWN', 'ENVELOPE_INVALID']);
const allowedTerminal = new Set(['LIMIT', 'INVALID_RESPONSE', 'FINAL_JSON_PARSE', 'FINAL_SHAPE', 'CHECKPOINT_MISSING', 'CHECKPOINT_REJECTED', 'PROVIDER_FAILED', 'TIMEOUT', 'CANCELLED', 'ARTIFACT_SERIALIZE_LIMIT', 'ARTIFACT_WRITE_FAILED', 'COMPLETED', 'UNKNOWN']);
const payloadKeys = ['checkpointCreated', 'checkpointPresentAtFinalize', 'checkpointRetainedAfterSecretGuard', 'lastSelfTestFailedStepCategory', 'lastSelfTestFailureClass', 'lastSelfTestMainFrameNavigation', 'modelRequestFailureStage', 'schemaVersion', 'selfTestFailedCount', 'selfTestPassedCount', 'terminalClass'];
function validPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== payloadKeys.join(',')) return false;
  if (Buffer.byteLength(JSON.stringify(value)) > 2048 || value.schemaVersion !== 4) return false;
  if (!allowedFailure.has(value.lastSelfTestFailureClass) || !allowedStep.has(value.lastSelfTestFailedStepCategory) || !allowedNavigation.has(value.lastSelfTestMainFrameNavigation) || !allowedModelStage.has(value.modelRequestFailureStage) || !allowedTerminal.has(value.terminalClass)) return false;
  for (const key of ['checkpointCreated', 'checkpointPresentAtFinalize', 'checkpointRetainedAfterSecretGuard']) if (typeof value[key] !== 'boolean') return false;
  for (const key of ['selfTestPassedCount', 'selfTestFailedCount']) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 12) return false;
  return true;
}
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!process.argv.includes('--run-once')) {
  process.stdout.write(JSON.stringify({status: 'PREPARED', browserRun: false}) + '\n');
} else {
  const workerRoot = option('--worker-root');
  const outDir = option('--out');
  assert(workerRoot && isAbsolute(workerRoot) && outDir && isAbsolute(outDir), 'absolute --worker-root and --out are required');
  assert((await stat(outDir)).isDirectory(), '--out must be an existing mounted directory');
  const {explorationBrowser} = await import(pathToFileURL(join(workerRoot, 'dist/author/tools.js')).href);
  const {ModuleDiagnostics} = await import(pathToFileURL(join(workerRoot, 'dist/author/module-diagnostics.js')).href);
  const evidencePath = join(outDir, 'selftest.json');
  const browserEnv = {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH};
  const server = createServer((request, response) => {
    if (request.url === '/api-hang') return;
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end('fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  assert(![19287, 19587, 19787, 19889].includes(address.port));
  const origin = `http://127.0.0.1:${address.port}`;
  const scenarios = [
    {id: 'reporter_assertion', step: 'EXPECT', navigation: 'UNOBSERVED', script: prefix + `test('case',async()=>{expect(1,'${sentinel}').toBe(2);});`},
    {id: 'api_step_failure', step: 'PW_API', navigation: 'UNOBSERVED', script: prefix + `test('case',async({request})=>{await test.step('api',async()=>{await request.get('${origin}/api-hang',{timeout:500});});});`},
    {id: 'test_step_failure', step: 'TEST_STEP', navigation: 'UNOBSERVED', script: prefix + `test('case',async()=>{await test.step('synthetic',async()=>{throw new Error('${sentinel}');});});`},
    {id: 'no_navigation', step: 'EXPECT', navigation: 'NOT_OBSERVED', script: prefix + `test('case',async({page})=>{await expect(page,'${sentinel}').toHaveURL('${origin}/never',{timeout:150});});`},
    {id: 'navigation', step: 'EXPECT', navigation: 'OBSERVED', script: prefix + `test('case',async({page})=>{await page.goto('${origin}/ok');await expect(page,'${sentinel}').toHaveTitle('never',{timeout:150});});`},
    {id: 'unavailable_data', step: 'UNOBSERVED', navigation: 'UNOBSERVED', script: prefix + "test('case',async()=>{ syntax ??? });"},
  ];
  const started = performance.now();
  const records = [];
  const payloadSamples = [];
  try {
    for (const scenario of scenarios) {
      const runs = [];
      for (const enabled of [false, true]) {
        const diagnostics = new ModuleDiagnostics();
        const failures = [];
        const observations = [];
        let observationSecret = false;
        const browser = explorationBrowser(browserEnv, {timeoutMs: 5000});
        const t0 = performance.now();
        let result;
        try {
          result = await browser.verifyDraft(scenario.script, {
            ...(enabled ? {
              onSelfTestFailure(value) { failures.push(allowedFailure.has(value) ? value : 'UNKNOWN'); diagnostics.selfTestFailure(value); },
              onSelfTestObservation(value) {
                observationSecret ||= JSON.stringify(value).includes(sentinel);
                const exact = value && typeof value === 'object' && !Array.isArray(value) &&
                  Object.keys(value).sort().join(',') === 'failedStepCategory,mainFrameNavigation';
                observations.push({
                  exact,
                  failedStepCategory: allowedStep.has(value?.failedStepCategory) ? value.failedStepCategory : 'UNOBSERVED',
                  mainFrameNavigation: allowedNavigation.has(value?.mainFrameNavigation) ? value.mainFrameNavigation : 'UNOBSERVED',
                });
                diagnostics.selfTestObservation?.(value);
              },
            } : {}),
          });
          diagnostics.selfTest(result.passed);
        } finally {
          await browser.close();
        }
        let diagnostic;
        diagnostics.finish('UNKNOWN', value => { diagnostic = value; });
        if (enabled) payloadSamples.push({scenarioId: scenario.id, payload: diagnostic});
        const leaked = observationSecret || JSON.stringify(diagnostic).includes(sentinel);
        const observed = observations.at(-1);
        runs.push({
          enabled,
          passed: result.passed,
          category: result.category ?? 'UNKNOWN',
          summarySha256: sha256(result.summary),
          failureClass: diagnostic.lastSelfTestFailureClass,
          failureCount: failures.length,
          observationCount: observations.length,
          observationExact: observed?.exact ?? false,
          failedStepCategory: observed?.failedStepCategory ?? 'UNOBSERVED',
          mainFrameNavigation: observed?.mainFrameNavigation ?? 'UNOBSERVED',
          diagnosticStepCategory: diagnostic.lastSelfTestFailedStepCategory ?? 'UNOBSERVED',
          diagnosticNavigation: diagnostic.lastSelfTestMainFrameNavigation ?? 'UNOBSERVED',
          secretInEmittedFields: leaked,
          elapsedMs: Math.round(performance.now() - t0),
        });
      }
      const equivalent = runs[0].passed === runs[1].passed && runs[0].category === runs[1].category && runs[0].summarySha256 === runs[1].summarySha256;
      const expected = runs[1].failedStepCategory === scenario.step && runs[1].mainFrameNavigation === scenario.navigation &&
        runs[1].diagnosticStepCategory === scenario.step && runs[1].diagnosticNavigation === scenario.navigation;
      records.push({id: scenario.id, equivalent, expected, off: runs[0], on: runs[1]});
    }
    const controller = new AbortController();
    const browser = explorationBrowser(browserEnv, {timeoutMs: 5000});
    const failures = [];
    const cancellation = prefix + "test('case',async()=>{await new Promise(()=>{});});";
    const pending = browser.verifyDraft(cancellation, {signal: controller.signal, onSelfTestFailure(value) {failures.push(allowedFailure.has(value) ? value : 'UNKNOWN');}});
    await delay(500);
    controller.abort();
    let cancelled = false;
    try { await pending; } catch (error) { cancelled = error?.code === 'cancelled'; }
    await browser.close();
    const safe = {
      status: records.every(value => value.equivalent && value.expected && !value.on.secretInEmittedFields && value.on.observationCount === 1 && value.on.observationExact) && cancelled && failures.length === 1 && failures[0] === 'CANCELLED' ? 'PASS' : 'FAIL',
      scenarioCount: records.length,
      records,
      cancellation: {cancelled, failureClass: failures[0] ?? 'UNKNOWN', observationCount: failures.length},
      elapsedMs: Math.round(performance.now() - started),
    };
    assert(!JSON.stringify(safe).includes(sentinel));
    await writeFile(evidencePath, JSON.stringify(safe) + '\n', {flag: 'wx'});
    assert.equal(payloadSamples.length, scenarios.length);
    assert(payloadSamples.every(sample => scenarios.some(scenario => scenario.id === sample.scenarioId) && validPayload(sample.payload)));
    const sampleRecord = {schemaVersion: 1, samples: payloadSamples};
    assert(!JSON.stringify(sampleRecord).includes(sentinel));
    await writeFile(join(outDir, 'payload-samples.json'), JSON.stringify(sampleRecord) + '\n', {flag: 'wx'});
    process.stdout.write(JSON.stringify({status: safe.status, scenarioCount: safe.scenarioCount, cancellation: safe.cancellation, elapsedMs: safe.elapsedMs}) + '\n');
    if (safe.status !== 'PASS') process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
