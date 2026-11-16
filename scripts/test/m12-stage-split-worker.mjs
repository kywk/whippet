// Nonsecret Server assignment -> real guarded Worker -> synthetic model/self-test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuthor } from '../../runtimes/worker/dist/author/loop.js';
import { readAuthorConfig } from '../../runtimes/worker/dist/author/runtime.js';
import { serializeAuthorArtifact } from '../../runtimes/worker/dist/author/types.js';
import { envelope, call } from '../../runtimes/worker/dist/author/spike/fixture.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const config = readAuthorConfig({ WHIPPET_AI_ENABLED: 'true', OPENCODE_API_KEY: 'synthetic-split-only-key' }, input.author.runtime);
const source = input.author.platform.module;
const script = 'export function run(){return {order:1}}';
const harness = `import {test,expect} from '@playwright/test';import {run} from '@lib/${source.slug}';test('order',()=>{expect(run()).toEqual({order:1})});`;
const metadata = { slug: source.slug, moduleKind: source.moduleKind, exportName: 'run', signature: 'run()', inputs: 'none', returns: 'order', preconditions: 'prepared', postconditions: 'assertions preserved' };
const sequence = [
  ['stage_module_candidate_part', { part: 'script', content: script, stagingRevision: 0 }],
  ['stage_module_candidate_part', { part: 'harness', content: harness, stagingRevision: 1 }],
  ['commit_module_candidate', { stagingRevision: 2, metadata }],
];
let requests = 0, verified = 0;
const output = await runAuthor(input, config, { verifyDraft: async () => { verified++; return { passed: true, summary: 'synthetic self-test' }; } }, {
  fetcher: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.max_output_tokens, 16384);
    assert.equal(body.model, input.author.runtime.model);
    assert.equal(body.reasoning.effort, input.author.runtime.reasoningEffort);
    const [name, args] = sequence[requests++];
    return Response.json(envelope([call(name, `split-${requests}`, args)]));
  },
});
assert.equal(requests, 3); assert.equal(verified, 1);
assert.ok(requests <= input.author.budget.maxModelRequests);
assert.equal(output.script, script); assert.equal(output.requestValidation, true);
process.stdout.write(serializeAuthorArtifact(output, 'module-authoring'));
