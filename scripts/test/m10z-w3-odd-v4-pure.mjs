// Frozen Worker dist only; synthetic Reporter and ModuleDiagnostics, no browser.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import NDJSONReporter from '../../runtimes/worker/dist/reporter.js';
import {ModuleDiagnostics} from '../../runtimes/worker/dist/author/module-diagnostics.js';

const label = process.argv.includes('--green') ? 'green' : 'red';
const evidencePath = `/private/tmp/whippet-m10z-20261115-wave3/odd/v4-pure-${label}.json`;
const sentinel = 'SECRET_SENTINEL_W3_ODD';
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function reporter(steps, diagnostics) {
  const dir = await mkdtemp(join(tmpdir(), 'm10z-w3-odd-v4-'));
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const instance = new NDJSONReporter({summaryPath: join(dir, 'summary.json'), diagnostics});
    const test = {expectedStatus: 'passed', titlePath: () => ['synthetic']};
    const result = {status: 'failed', errors: [{message: sentinel}], duration: 1};
    for (const category of steps) instance.onStepEnd(test, result, {category, error: {message: sentinel}, title: sentinel});
    instance.onTestEnd(test, result);
    await instance.onEnd({status: 'failed'});
    return JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
  } finally {
    process.stdout.write = originalWrite;
    await rm(dir, {recursive: true, force: true});
  }
}

function emitted(diagnostics) {
  let value;
  diagnostics.finish('UNKNOWN', next => {value = next;});
  return value;
}

const started = performance.now();
const summaries = [];
for (const [steps, diagnostics] of [
  [['test.step', 'expect'], true],
  [['test.step', 'pw:api'], true],
  [['test.step'], true],
  [['not-a-category'], true],
  [['expect'], false],
]) summaries.push(await reporter(steps, diagnostics));
const reporterChecks = {
  expectLeaf: summaries[0].failedStepCategory === 'EXPECT',
  apiLeaf: summaries[1].failedStepCategory === 'PW_API',
  testStep: summaries[2].failedStepCategory === 'TEST_STEP',
  unknownCategory: summaries[3].failedStepCategory === 'UNOBSERVED',
  offNoDiagnosticField: !Object.hasOwn(summaries[4], 'failedStepCategory'),
  errorsPreserved: summaries.every(value => value.errors?.length === 1 && value.errors[0] === sentinel),
};
const inherited = Object.create({failedStepCategory: 'EXPECT', mainFrameNavigation: 'OBSERVED'});
inherited.foo = true;
inherited.bar = true;
const strict = new ModuleDiagnostics();
strict.selfTestObservation(inherited);
const strictResult = emitted(strict);
const strictOwnShapeRejected = strictResult.lastSelfTestFailedStepCategory === 'UNOBSERVED' &&
  strictResult.lastSelfTestMainFrameNavigation === 'UNOBSERVED';

const latest = new ModuleDiagnostics();
latest.selfTestFailure('TEST_FAILED');
latest.selfTestObservation({failedStepCategory: 'EXPECT', mainFrameNavigation: 'OBSERVED'});
latest.selfTestFailure('CANCELLED');
const latestResult = emitted(latest);
const latestFailureReset = latestResult.lastSelfTestFailureClass === 'CANCELLED' &&
  latestResult.lastSelfTestFailedStepCategory === 'UNOBSERVED' &&
  latestResult.lastSelfTestMainFrameNavigation === 'UNOBSERVED';

const invalid = new ModuleDiagnostics();
invalid.selfTestObservation({failedStepCategory: 'UNLISTED', mainFrameNavigation: 'OBSERVED'});
const invalidResult = emitted(invalid);
const unknownRejected = invalidResult.lastSelfTestFailedStepCategory === 'UNOBSERVED' &&
  invalidResult.lastSelfTestMainFrameNavigation === 'UNOBSERVED';
const safe = {
  status: Object.values(reporterChecks).every(Boolean) && strictOwnShapeRejected && latestFailureReset && unknownRejected ? 'PASS' : 'RED',
  reporterChecks,
  strictOwnShapeRejected,
  latestFailureReset,
  unknownRejected,
  schemaVersion: strictResult.schemaVersion,
  reporterSummarySha256: sha256(JSON.stringify(summaries.map(value => ({...value, errors: value.errors?.length ?? 0})))),
  caseCount: 8,
  elapsedMs: Math.round(performance.now() - started),
};
assert(!JSON.stringify(safe).includes(sentinel));
await writeFile(evidencePath, JSON.stringify(safe) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify(safe) + '\n');
if (safe.status !== 'PASS') process.exitCode = 1;
