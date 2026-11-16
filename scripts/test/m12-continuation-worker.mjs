// Synthetic transport only: exercise the real Worker loop with Server input.
// stdin/stdout contain the nonsecret Worker input/guarded artifact, never env.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuthor } from '../../runtimes/worker/dist/author/loop.js';
import { readAuthorConfig } from '../../runtimes/worker/dist/author/runtime.js';
import { serializeAuthorArtifact } from '../../runtimes/worker/dist/author/types.js';
import { envelope, call } from '../../runtimes/worker/dist/author/spike/fixture.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const config = readAuthorConfig({ WHIPPET_AI_ENABLED: 'true', OPENCODE_API_KEY: 'synthetic-m12-chain-key' }, input.author.runtime);
let requests = 0;
const output = await runAuthor(input, config, undefined, { fetcher: async () => {
  requests++;
  const count = requests === 2 ? input.author.budget.maxToolCalls - 1 : 1;
  return Response.json(envelope(Array.from({ length: count }, (_, index) => call('read_draft', `read-${requests}-${index}`))));
} });
// The existing engines allow the final response after tools are consumed;
// that third request must also be charged even though no tool can run.
assert.equal(requests, 3);
assert.equal(output.partial?.usage?.modelRequests, 3);
assert.equal(output.partial?.usage?.toolCalls, input.author.budget.maxToolCalls);
process.stdout.write(serializeAuthorArtifact(output));
