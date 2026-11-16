// Real guarded Worker, supplied frozen Server history, synthetic model only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuthor } from '../../runtimes/worker/dist/author/loop.js';
import { readAuthorConfig } from '../../runtimes/worker/dist/author/runtime.js';
import { validateHistoryPage } from '../../runtimes/worker/dist/author/history.js';
import { serializeAuthorArtifact } from '../../runtimes/worker/dist/author/types.js';
import { envelope, call, text } from '../../runtimes/worker/dist/author/spike/fixture.js';

const { input, page } = JSON.parse(readFileSync(0, 'utf8'));
const user = page.items.find(item => item.role === 'user');
const assistant = page.items.find(item => item.role === 'assistant');
const fact = (category, item, quote) => ({ category, sequence: item.sequence, offsetBytes: item.offsetBytes + Buffer.byteLength(item.content.slice(0, item.content.indexOf(quote))), text: quote });
const facts = [fact('goal', user, '目標：驗證付款失敗。'), fact('constraint', user, '限制：不得刪除斷言。'), fact('progress', assistant, '進度：目前 verify。'), fact('evidence', assistant, '證據：run/fixed 仍須查核。')];
const config = readAuthorConfig({ WHIPPET_AI_ENABLED: 'true', OPENCODE_API_KEY: 'synthetic-memory-bridge-key' }, input.author.runtime);
let requests = 0, reads = 0;
const out = await runAuthor(input, config, undefined, {
  history: { read: async cursor => { reads++; assert.equal(cursor, null); return validateHistoryPage(page, input, cursor); } },
  fetcher: async () => {
    if (++requests === 1) return Response.json(envelope([call('read_conversation_history', 'history', { cursor: null })]));
    if (requests === 2) return Response.json(envelope([call('record_conversation_memory', 'memory', { facts })]));
    assert.equal(requests, 3); return Response.json(envelope([text('{"message":"已整理來源事實，尚未驗證或發佈"}')]));
  },
});
assert.equal(reads, 1); assert.equal(requests, 3); assert.equal(out.script, undefined);
assert.equal(JSON.parse(out.conversationSummary).facts.length, 4);
process.stdout.write(serializeAuthorArtifact(out));
