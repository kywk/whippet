// Pure synthetic red probe. It never starts Playwright or a browser.
// Legacy summary.errors is retained by contract; this probe only records its
// inability to carry the new fixed observation before the Wave3 implementation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import NDJSONReporter from '../../runtimes/worker/dist/reporter.js';
import {ModuleDiagnostics} from '../../runtimes/worker/dist/author/module-diagnostics.js';

const evidencePath = '/private/tmp/whippet-m10z-20261115-wave3/odd/reporter-red.json';
const sentinel = 'SECRET_SENTINEL_W3_ODD';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function report(stepCategory) {
  const dir = await mkdtemp(join(tmpdir(), 'm10z-w3-odd-reporter-'));
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const reporter = new NDJSONReporter({summaryPath: join(dir, 'summary.json')});
    const test = {expectedStatus: 'passed', titlePath: () => ['synthetic']};
    const result = {status: 'failed', errors: [{message: sentinel}], duration: 1};
    reporter.onTestEnd(test, result);
    reporter.onStepEnd(test, result, {category: stepCategory, title: sentinel, error: {message: sentinel}});
    await reporter.onEnd({status: 'failed'});
    return JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
  } finally {
    process.stdout.write = originalWrite;
    await rm(dir, {recursive: true, force: true});
  }
}

const started = performance.now();
const assertion = await report('expect');
const apiStep = await report('test.step');
assert.deepEqual(assertion, apiStep);
const diagnostic = new ModuleDiagnostics();
diagnostic.selfTestFailure('UNSUPPORTED_' + sentinel);
let emitted;
diagnostic.finish('UNKNOWN', value => {emitted = value;});
assert.equal(emitted.lastSelfTestFailureClass, 'UNKNOWN');
assert.equal(emitted.schemaVersion, 3);
assert.equal(assertion.failed, 1);

const safe = {
  status: 'RED',
  cases: 2,
  reporterScenariosIndistinguishable: true,
  structuredFailurePresent: Object.hasOwn(assertion, 'failureClass') || Object.hasOwn(assertion, 'failureKind'),
  rawErrorInReporterSummary: JSON.stringify(assertion).includes(sentinel),
  strictUnknownRejected: emitted.lastSelfTestFailureClass === 'UNKNOWN',
  diagnosticSchemaVersion: emitted.schemaVersion,
  summarySha256: sha256(JSON.stringify(assertion)),
  elapsedMs: Math.round(performance.now() - started),
};
assert.equal(JSON.stringify(safe).includes(sentinel), false);
await writeFile(evidencePath, JSON.stringify(safe) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify(safe) + '\n');
if (safe.reporterScenariosIndistinguishable && !safe.structuredFailurePresent) process.exitCode = 1;
