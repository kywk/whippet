import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { builtinEngine, type EngineRun } from "../engine.js";
import { AuthorError, type AuthorInput, type AuthorOutput } from "../types.js";
import { runAuthor } from "../loop.js";
import { loadToolRegistry, sha256 } from "../registry.js";
import { KnownSecrets } from "../../login/client.js";
import { readAIConfig, AIError } from "../../ai/config.js";
import { buildResponsesRequest } from "../../ai/responses.js";
import { modelCapacity } from "../../ai/capacity.js";
import { vercelEngine } from "./vercel.js";
import { selectAgentEngine } from "./select.js";
import { estimateInputTokens } from "./context.js";
import { fixture as httpFixture, envelope, call, text, runInput, type Wire } from "../spike/fixture.js";

// Test providers explicitly declare their capacity; do not borrow the production
// OpenCode profile for an unrelated loopback endpoint.
async function fixture(...args: Parameters<typeof httpFixture>) {
  const result = await httpFixture(...args);
  result.config.contextWindowTokens = 1048576;
  return result;
}

const engineInput = (config: Parameters<typeof runInput>[0], overrides: Partial<EngineRun> = {}) => runInput(config, { prepareRequest: body => body, ...overrides });
const script = "import {test,expect} from '@playwright/test';test('draft',async({page})=>{await page.setContent('<button>Run test</button>');await expect(page.getByRole('button')).toBeVisible();});";
function task(requests = 3): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111", registry = loadToolRegistry();
  const root = new URL("../../../skills/test-author/", import.meta.url), bytes = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(bytes.toString());
  return { kind: "author", runId: id, attemptId: id, script: "", timeoutMs: 180000, author: {
    conversationId: id, baseRevision: 1, messages: [{ role: "user", content: "修復按鈕測試並保留所有斷言" }], skillId: "test-author", skillVersion: "1",
    editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null, allowedTools: ["update_draft"],
    skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(bytes), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
    budget: { ...manifest.budget, maxModelRequests: requests }, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256,
  } };
}
const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {}, verifyDraft: async () => ({ passed: true, summary: "synthetic self-test" }) };

test("backend engine/provider selection is explicit, defaults to builtin and never falls back", async () => {
  const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-key" });
  assert.equal(selectAgentEngine(config), builtinEngine);
  assert.equal(config.provider, "opencode");
  for (const env of [{ WHIPPET_AI_ENGINE: "auto" }, { WHIPPET_AI_PROVIDER: "gateway" }, { WHIPPET_AI_PROVIDER: "openai-responses" }, { WHIPPET_AI_CONTEXT_WINDOW_TOKENS: "NaN" }])
    assert.throws(() => readAIConfig(env), AIError);
  const other = readAIConfig({ WHIPPET_AI_ENABLED: "true", WHIPPET_AI_ENGINE: "vercel", WHIPPET_AI_PROVIDER: "openai-responses", WHIPPET_AI_BASE_URL: "https://other.invalid/v1", WHIPPET_AI_MODEL: "synthetic-model", WHIPPET_AI_API_KEY: "synthetic-other", OPENCODE_API_KEY: "must-not-use", WHIPPET_AI_CONTEXT_WINDOW_TOKENS: "131072" });
  const request = buildResponsesRequest(other, { sessionId: "fixed", input: "coding" });
  assert.equal(request.url, "https://other.invalid/v1/responses");
  assert.equal(request.init.headers.Authorization, "Bearer synthetic-other");
  assert.ok(!Object.hasOwn(request.init.headers, "x-opencode-session"));
  assert.equal(modelCapacity(other).contextWindowTokens, 131072);
  const missing = readAIConfig({ WHIPPET_AI_PROVIDER: "openai-responses", WHIPPET_AI_BASE_URL: "https://other.invalid/v1", WHIPPET_AI_MODEL: "synthetic-model", OPENCODE_API_KEY: "must-not-use" });
  assert.equal(missing.apiKey, "");
  assert.throws(() => modelCapacity({ ...other, contextWindowTokens: undefined }), AuthorError);
  assert.throws(() => selectAgentEngine({ ...config, engine: "automatic" as any }), AuthorError);
});

test("production route applies one final body guard to instructions and every tool-result request", async () => {
  const f = await fixture((_body, i) => envelope(i === 1 ? [call("read_draft", "read")] : [text()]));
  let guards = 0;
  try {
    const result = await vercelEngine(f.config).run(engineInput(f.config, { instructions: "secret-marker", context: [{ role: "user", content: "secret-marker" }],
      execute: async () => ({ script: "secret-marker" }), prepareRequest: body => { guards++; return JSON.parse(JSON.stringify(body).replaceAll("secret-marker", "[redacted]")); } }));
    assert.ok(result.finalText); assert.equal(guards, 2); assert.equal(f.bodies.length, 2);
    for (const body of f.bodies) {
      assert.ok(!JSON.stringify(body).includes("secret-marker")); assert.equal(body.reasoning.effort, "xhigh");
      assert.equal(body.max_output_tokens, 8192); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
    }
    await assert.rejects(vercelEngine(f.config).run(runInput(f.config)), AuthorError);
    assert.equal(f.bodies.length, 2);
  } finally { await f.close(); }
});

for (const engine of ["vercel", "pi"] as const) test(`runAuthor selects ${engine}; an unfinished checkpoint resumes within budget`, async () => {
  const f = await fixture((_body, i) => envelope(i === 1 ? [call("update_draft", "partial", { script, nextStep: "尚須加入第二項斷言" })] : i === 2 ? [text('{"message":"已完成"}')] : [call("update_draft", "finish", { script: script + "// final", message: "完成剩餘斷言" })]));
  try {
    const out = await runAuthor(task(), { ...f.config, engine }, browser, { fetcher: async (_url, init) => fetch(f.config.baseURL + "/responses", init) }) as AuthorOutput;
    assert.equal(f.bodies.length, 3); assert.equal(out.partial, undefined); assert.equal(out.script, script + "// final");
    assert.ok(JSON.stringify(f.bodies[2]!.input).includes("explicitly unfinished"));
  } finally { await f.close(); }
});

for (const engine of ["builtin", "vercel", "pi"] as const) test(`${engine} rejects duplicate call IDs before dispatch`, async () => {
  const f = await fixture(() => envelope([call("update_draft", "same", { script }), call("update_draft", "same", { script })]));
  let selfTests = 0;
  try {
    await assert.rejects(runAuthor(task(), { ...f.config, engine }, {
      ...browser, verifyDraft: async () => { selfTests++; return { passed: true, summary: "verified" }; },
    }, { fetcher: async (_url, init) => fetch(f.config.baseURL + "/responses", init) }), { code: "invalid_response" });
    assert.equal(f.bodies.length, 1);
    assert.equal(selfTests, 0);
  } finally { await f.close(); }
});

test("only fixed retrievable versions compact; eight-turn loop preserves protected facts, call/result pairs and encrypted reasoning", async t => {
  const version = "22222222-2222-4222-8222-222222222222";
  const f = await fixture((_body, i) => envelope(i < 8 ? [{ type: "reasoning", id: `rs_${i}`, summary: [], encrypted_content: `opaque-${i}` }, call("catalog_get", String(i), { moduleVersionId: version })] : [text()]));
  const facts = { goal: "驗證訂單", constraints: ["不可刪除斷言", "只用已確認範圍"], decisions: ["使用固定版本"], revision: 7, stage: "verify", evidence: ["run/fixed-validated"] };
  const raw = { testId: "module", versionId: version, scriptOrigin: "ai", script: "x".repeat(9000), module: { slug: "order", signature: "order(page)", inputs: "page", returns: "order id", preconditions: "signed in", postconditions: "created", harness: "y".repeat(1000) } };
  const before = JSON.stringify(raw), config = { ...f.config, contextInputTokens: 24000 };
  const events: string[] = [];
  try {
    const result = await vercelEngine(config).run(engineInput(config, { tools: [{ name: "catalog_get" }], context: [{ role: "user", content: JSON.stringify(facts) }],
      budget: { modelRequests: 8, toolExecutions: 12, maxOutputTokens: 8192 }, execute: async () => raw, onEvent: e => events.push(e) }));
    assert.ok(result.finalText); assert.equal(f.bodies.length, 8); assert.equal(JSON.stringify(raw), before);
    assert.ok(events.some(e => e.startsWith("author:context:compacted:")));
    const last = f.bodies.at(-1)!;
    assert.ok(estimateInputTokens(last) <= 24000);
    const protectedMessage = last.input.find((i: Wire) => i.role === "user");
    assert.ok(protectedMessage);
    assert.deepEqual(JSON.parse(typeof protectedMessage.content === "string" ? protectedMessage.content : protectedMessage.content.map((p: Wire) => p.text).join("")), facts);
    assert.ok(last.input.some((i: Wire) => i.type === "reasoning" && i.encrypted_content === "opaque-1"));
    const outputs = last.input.filter((i: Wire) => i.type === "function_call_output");
    assert.equal(outputs.length, 7);
    for (const output of outputs) assert.ok(last.input.some((i: Wire) => i.type === "function_call" && i.call_id === output.call_id));
    const compacted = outputs.map((i: Wire) => JSON.parse(i.output)).filter((i: Wire) => i.contextCompacted);
    assert.ok(compacted.length > 0);
    for (const c of compacted) { assert.equal(c.retrieve.arguments.moduleVersionId, version); assert.equal(c.validationEvidence, false); assert.equal(c.identity.module.preconditions, "signed in"); }
    assert.equal(JSON.parse(outputs.at(-1).output).script, raw.script);
    t.diagnostic(JSON.stringify({ requests: 8, toolResults: 7, compacted: compacted.length, estimatedInputTokens: estimateInputTokens(last), limit: 24000 }));
  } finally { await f.close(); }
});

test("capacity failure protects conversation/draft/evidence without sending and returns truthful partial", async () => {
  const f = await fixture(() => envelope([text()]));
  try {
    const config = { ...f.config, contextWindowTokens: 16384, contextInputTokens: 16000 };
    const result = await vercelEngine(config).run(engineInput(config, { context: [{ role: "user", content: "protected-".repeat(2000) }], checkpoint: () => ({ script: "verified" }) }));
    assert.equal(result.partial?.reason, "context_capacity"); assert.equal(result.partial?.checkpoint?.script, "verified");
    assert.match(result.partial!.nextStep, /容量/); assert.equal(f.bodies.length, 0);
    await assert.rejects(vercelEngine(f.config).run(engineInput(f.config, { prepareRequest: body => ({ ...body, tools: [] }) })), AuthorError);
    assert.equal(f.bodies.length, 0);
  } finally { await f.close(); }
});

test("truncated output never executes partial arguments; only a guard-owned checkpoint allows partial", async () => {
  for (const checkpoint of [false, true]) {
    const f = await fixture((_body, i) => envelope(checkpoint && i === 1 ? [call("update_draft", "saved", { script, nextStep: "尚須完成" })] : [{ ...call("update_draft", "half"), arguments: '{"script":' }], checkpoint && i === 1 ? {} : { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    let selfTests = 0;
    try {
      const running = runAuthor(task(8), { ...f.config, engine: "vercel" }, { ...browser, verifyDraft: async () => { selfTests++; return { passed: true, summary: "verified" }; } }, { fetcher: async (_url, init) => fetch(f.config.baseURL + "/responses", init) });
      if (!checkpoint) await assert.rejects(running, AuthorError);
      else {
        const out = await running as AuthorOutput;
        assert.equal(out.script, script); assert.equal(out.partial?.checkpoint?.scriptHash, sha256(script));
        assert.match(out.message, /截斷/); assert.equal(out.requestValidation, false);
        assert.match(out.partial!.nextStep, /尚須完成/);
      }
      assert.equal(selfTests, checkpoint ? 1 : 0); assert.equal(f.bodies.length, checkpoint ? 2 : 1);
    } finally { await f.close(); }
  }
});

for (const engine of ["vercel", "pi"] as const) test(`${engine} provider abort settles and closes the socket within 1 second`, async t => {
  let arrived!: () => void, closed!: () => void;
  const arrival = new Promise<void>(r => { arrived = r; }), closure = new Promise<void>(r => { closed = r; });
  const f = await fixture((_body, _i, res) => { res.on("close", closed); arrived(); return undefined; });
  const abort = new AbortController();
  try {
    const running = selectAgentEngine({ ...f.config, engine }).run(engineInput(f.config, { signal: abort.signal }));
    await arrival; const started = performance.now(); abort.abort();
    await assert.rejects(running, (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
    await Promise.race([closure, delay(950).then(() => { throw new Error("socket still open"); })]);
    const ms = performance.now() - started; assert.ok(ms < 1000);
    t.diagnostic(JSON.stringify({ abortSettleAndCloseMs: Number(ms.toFixed(3)), thresholdMs: 1000 }));
  } finally { await f.close(); }
});

for (const engine of ["vercel", "pi"] as const) test(`${engine} stops after unknown tools, duplicate IDs, HTTP failures and output limits`, async () => {
  for (const mode of ["unknown", "duplicate", "http", "bytes"]) {
    let executions = 0;
    const f = await fixture((_b, _i, res) => {
      if (mode === "http") { res.writeHead(500); res.end('{}'); return undefined; }
      return envelope(mode === "duplicate" ? [call("read_draft", "same"), call("read_draft", "same")] : [call(mode === "unknown" ? "shell" : "read_draft", "id")]);
    });
    try {
      await assert.rejects(selectAgentEngine({ ...f.config, engine }).run(engineInput(f.config, { ...(mode === "bytes" ? { maxToolOutputBytes: 1 } : {}), execute: async () => { executions++; return { content: "tool output" }; } })), AuthorError);
      assert.equal(f.bodies.length, 1, mode); assert.equal(executions, mode === "bytes" ? 1 : 0, mode);
    } finally { await f.close(); }
  }
});
