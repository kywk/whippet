#!/usr/bin/env node
// Offline author contract probes. All provider and browser responses are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAuthor } from '../../runtimes/worker/dist/author/loop.js';
import { loadToolRegistry, sha256 } from '../../runtimes/worker/dist/author/registry.js';
import { readAIConfig } from '../../runtimes/worker/dist/ai/config.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputPath = '/private/tmp/whippet-m10z-20261115-wave2/odd/worker-contract.json';
const id = '11111111-1111-4111-8111-111111111111';
const script = 'export async function run({page}) { return page.url(); }';
const harness = "import {test,expect} from '@playwright/test'; import {run} from '@lib/search'; test('verified',async({page})=>{expect(await run({page})).toBe(page.url());});";
const moduleData = { slug: 'search', moduleKind: 'step', exportName: 'run', signature: '', inputs: '', returns: '', preconditions: '', postconditions: '', harness };
const metadata = { ...moduleData };
delete metadata.harness;
const config = readAIConfig({ WHIPPET_AI_ENABLED: 'true', WHIPPET_AI_BASE_URL: 'https://synthetic.invalid', OPENCODE_API_KEY: 'synthetic-only-key' });
const fixedBudget = { maxModelRequests: 8, maxToolCalls: 12, maxDurationMs: 180000 };

function input(skill) {
  const skillDir = join(root, 'runtimes/worker/skills', skill);
  const manifestBytes = readFileSync(join(skillDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString());
  const registry = loadToolRegistry();
  assert.equal(manifest.budget.maxModelRequests, fixedBudget.maxModelRequests);
  assert.equal(manifest.budget.maxToolCalls, fixedBudget.maxToolCalls);
  assert.equal(manifest.budget.maxDurationMs, fixedBudget.maxDurationMs);
  const allowedTools = skill === 'module-authoring'
    ? ['stage_module_candidate_part', 'commit_module_candidate', 'request_module_validation', 'browser_snapshot']
    : ['read_draft', 'update_draft', 'request_validation', 'browser_snapshot'];
  return { kind: 'author', runId: id, attemptId: id, script: skill === 'module-authoring' ? script : 'old', timeoutMs: 180000,
    author: { conversationId: id, baseRevision: 1, messages: [{ role: 'user', content: 'synthetic author task' }],
      skillId: skill, skillVersion: manifest.version, editingSessionId: id, contextRevision: 1,
      sourceVersion: null, conversationSummary: null, allowedTools,
      ...(skill === 'module-authoring' ? { platform: { planId: id, stageId: 's2-query', module: moduleData } } : {}),
      skills: [{ id: skill, version: manifest.version, sha256: sha256(readFileSync(join(skillDir, 'SKILL.md'))),
        manifestSha256: sha256(manifestBytes), referenceHashes: Object.fromEntries(manifest.references.map(ref => [ref.id, ref.sha256])) }],
      budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 } };
}

const tool = (name, args, ordinal) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: `synthetic-${ordinal}` });
const final = () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ message: '候選已完成，待正式驗證。' }) }] }] });
function fetcher(sequence) {
  let index = 0;
  return { requestCount: () => index, fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.store, false);
    assert.equal(request.max_output_tokens > 0, true);
    const item = sequence[index++];
    assert.ok(item, 'synthetic response sequence exhausted');
    return Response.json(item);
  } };
}
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
const moduleSequence = (exploreAfterPass) => {
  const list = [
    tool('stage_module_candidate_part', { part: 'script', content: script, stagingRevision: 0 }, 1),
    tool('stage_module_candidate_part', { part: 'harness', content: harness, stagingRevision: 1 }, 2),
    tool('commit_module_candidate', { stagingRevision: 2, metadata }, 3),
    ...(exploreAfterPass ? [tool('browser_snapshot', {}, 4)] : []),
    tool('request_module_validation', {}, exploreAfterPass ? 5 : 4),
  ];
  return [...list.map(item => ({ status: 'completed', output: [item] })), final()];
};

async function moduleProbe(exploreAfterPass) {
  let selfTestPasses = 0;
  let browserAfterPass = 0;
  const browser = {
    verifyDraft: async (candidateHarness, options) => {
      assert.equal(candidateHarness, harness);
      assert.equal(options.moduleFile.content, script);
      selfTestPasses++;
      return { passed: true, summary: 'synthetic pass' };
    },
    snapshot: async () => { if (selfTestPasses) browserAfterPass++; return { url: 'https://synthetic.invalid', snapshot: 'synthetic page' }; },
    navigate: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {},
  };
  const simulated = fetcher(moduleSequence(exploreAfterPass));
  const result = await runAuthor(input('module-authoring'), config, browser, { fetcher: simulated.fetch });
  assert.equal(result.script, script);
  assert.equal(result.module.harness, harness);
  assert.equal(result.requestValidation, true);
  assert.equal(selfTestPasses, 1);
  return { selfTestPasses, browserAfterPass, modelRequests: simulated.requestCount(), formalValidationRequested: result.requestValidation };
}

async function noCheckpointProbe() {
  let snapshots = 0;
  const browser = { snapshot: async () => { snapshots++; return { url: 'https://synthetic.invalid', snapshot: 'same synthetic page' }; },
    navigate: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {} };
  const sequence = Array.from({ length: fixedBudget.maxModelRequests }, (_, n) => ({ status: 'completed', output: [tool('browser_snapshot', {}, n + 1)] }));
  const simulated = fetcher(sequence);
  const result = await runAuthor(input('test-author'), config, browser, { fetcher: simulated.fetch });
  assert.equal(result.partial?.reason, 'budget_exhausted');
  assert.equal(result.requestValidation, false);
  assert.equal(result.partial?.checkpoint, undefined);
  assert.equal(result.script, undefined);
  return { snapshots, modelRequests: simulated.requestCount(), checkpointPresent: false,
    nextStepClaimsPassedCandidate: result.partial.nextStep.includes('最後通過自我試跑的候選稿'),
    messageAcknowledgesNoCandidate: result.message.includes('尚無可保留的已驗證候選稿') };
}

let output;
try {
  const control = await moduleProbe(false);
  const postPass = await moduleProbe(true);
  const noCheckpoint = await noCheckpointProbe();
  const red = {
    moduleExplorationAfterPassingCommit: postPass.browserAfterPass > 0,
    nonexistentCheckpointSuggestedForContinue: noCheckpoint.nextStepClaimsPassedCandidate && !noCheckpoint.checkpointPresent,
  };
  output = { schemaVersion: 1, evidenceClass: 'offline_synthetic_fetcher',
    source: { loopDistSha256: digest(join(root, 'runtimes/worker/dist/author/loop.js')),
      engineDistSha256: digest(join(root, 'runtimes/worker/dist/author/engine.js')) },
    controls: { moduleCandidateAndValidation: control }, probes: { postPass, noCheckpoint }, red,
    limits: ['Synthetic fetcher and browser: no provider, Manager, Docker, PG, or formal validation Run',
      'Earlier true Module commit result is UNKNOWN; this only reproduces a guard path',
      'Earlier true continuation Runs created no checkpoint; no checkpoint loss is inferred'] };
} catch (error) {
  output = { schemaVersion: 1, evidenceClass: 'offline_synthetic_fetcher', controlFailure: true,
    errorClass: error?.code ?? error?.name ?? 'unknown' };
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ evidence: outputPath, controlFailure: !!output.controlFailure,
  red: output.red ?? null }));
if (output.controlFailure || Object.values(output.red).some(Boolean)) process.exitCode = 1;
