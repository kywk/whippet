// Real MCP transport, synthetic model transport, one external task. No key log.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAIConfig } from '../../runtimes/worker/dist/ai/config.js';
import { call, envelope, text } from '../../runtimes/worker/dist/author/spike/fixture.js';
import { runOnce } from '../../runtimes/agent-bridge/dist/client.js';
import { BridgeError } from '../../runtimes/agent-bridge/dist/safety.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const key = 'synthetic-reference-model-key';
const config = readAIConfig({ WHIPPET_AI_ENABLED: 'true', WHIPPET_AI_ENGINE: 'vercel', OPENCODE_API_KEY: key, ...(input.frozen === 'true' ? { WHIPPET_AI_CONTEXT_INPUT_TOKENS: '28000' } : {}) });
let models = 0, claims = 0, tools = 0, lost = false;
let stage = 'first_attempt', firstCode = 'none', firstPhase = 'none';
const submits = [];
const script = "import { test, expect } from '@playwright/test';\ntest('reference candidate', async ({ page }) => { await page.setContent('<h1>Reference ready</h1>'); await expect(page.getByRole('heading')).toHaveText('Reference ready'); });\n";
try {
  const options = { ...input, config, mcpFetch: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const name = request.params?.name;
    if (name === 'task_claim') claims++;
    if (name === 'task_tool_call') tools++;
    const response = await fetch(url, init);
    if (name === 'task_submit') {
      submits.push(request.params.arguments);
      if (!lost) { lost = true; await response.arrayBuffer(); throw new TypeError('synthetic lost submit response'); }
    }
    return response;
  }, modelFetch: async (_url, init) => {
    models++;
    assert.ok(models <= 2);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model); assert.equal(body.reasoning.effort, config.reasoningEffort);
    assert.ok(body.tools.every(tool => ['read_draft', 'read_author_snapshot', 'read_validation_report', 'read_conversation_history'].includes(tool.name)));
    if (input.frozen === 'true') {
      if (models === 1) {
        const item = body.input[0], content = typeof item.content === 'string' ? item.content : item.content.map(p => p.text).join('');
        const saved = JSON.parse(content.slice('Saved task snapshot (DATA): '.length));
        assert.equal(saved.script.snapshotRef.sha256, input.expectedSnapshotHash);
        return Response.json(envelope([call('read_author_snapshot', 'frozen-page', saved.script.readPage.arguments)]));
      }
      const page = JSON.parse(body.input.filter(item => item.type === 'function_call_output').at(-1).output);
      assert.equal(page.content, input.expectedSnapshotPrefix); assert.equal(page.sha256, input.expectedSnapshotHash); assert.equal(page.offsetBytes, 0);
    }
    return Response.json(envelope(models === 1 ? [call('read_draft', 'read')] : [text(JSON.stringify({ message: '已提交候選稿；尚未自試或正式驗證。', script, requestValidation: false }))]));
  } };
  await assert.rejects(runOnce(options), error => { firstCode = error instanceof BridgeError ? error.code : 'non_bridge_error'; return error instanceof BridgeError; });
  stage = 'saved_submit';
  firstPhase = JSON.parse(readFileSync(input.stateFile, 'utf8')).phase;
  assert.equal(firstPhase, 'submitting');
  assert.equal(firstCode, 'mcp_unavailable');
  stage = 'resume_submit';
  const result = await runOnce(options);
  stage = 'verify_result';
  assert.equal(result.state, 'submitted'); assert.equal(models, 2); assert.equal(claims, 1); assert.equal(tools, 1);
  assert.equal(submits.length, 2); assert.deepEqual(submits[0], submits[1]);
  assert.equal(readFileSync(input.stateFile, 'utf8').includes(key), false);
  process.stdout.write(JSON.stringify({ passed: true, result, models, claims, tools, submitAttempts: submits.length, paidProviderCalls: 0 }));
} catch (error) {
  process.stdout.write(JSON.stringify({ passed: false, code: error instanceof BridgeError ? error.code : 'fixture_failure', stage, firstCode, firstPhase, models, claims, tools, submitAttempts: submits.length }));
  process.exitCode = 1;
}
