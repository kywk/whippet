import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAuthor } from "./loop.js";
import { loadToolRegistry, sha256 } from "./registry.js";
import { AuthorError, type AuthorInput, type AuthorOutput } from "./types.js";
import { runtimeDigest, type AuthorRuntime } from "./runtime.js";
import { readAIConfig } from "../ai/config.js";
import { envelope, call, text, type Wire } from "./spike/fixture.js";
import { estimateInputTokens } from "./engines/context.js";
import { validateHistoryPage, type HistoryPage } from "./history.js";
import { KnownSecrets } from "../login/client.js";

const id = "11111111-1111-4111-8111-111111111111";
const user = "目標：驗證付款失敗。限制：不得刪除斷言。決策：沿用原提示。退款限制也不可遺失。";
const progress = "進度：目前 verify，不能跳過驗證。";
const evidence = "證據：run/fixed 是待查核的引用。";
const script = "import {test,expect} from '@playwright/test';test('payment',async({page})=>{await expect(page.getByRole('alert')).toHaveText('付款失敗');});";
const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-memory-runtime-key" });
function task(engine: "builtin" | "vercel"): AuthorInput {
  const registry = loadToolRegistry(), root = new URL("../../skills/test-author/", import.meta.url);
  const raw = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(raw.toString());
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
  Object.assign(runtime, { engine, profileId: engine, contextInputTokens: 32000 }); runtime.sha256 = runtimeDigest(runtime);
  return { kind: "author", runId: id, attemptId: id, workspaceId: id, testId: id, script: "original spec", timeoutMs: 180000,
    author: { conversationId: id, baseRevision: 7, contextRevision: 3, editingSessionId: id, sourceVersion: null, conversationSummary: "保留既定目標／限制／目前Stage verify與證據run/fixed。",
      messages: [{ role: "user", content: "修復付款失敗測試，保留原斷言／限制／Stage與證據，不自動發佈。" }],
      skillId: "test-author", skillVersion: "1", allowedTools: ["read_conversation_history", "record_conversation_memory", "update_draft"], history: { maxSequence: "20" },
      skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
      budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime } };
}
function history(input: AuthorInput) {
  const pages = new Map<string | null, HistoryPage>();
  const base = { workspaceId: id, testId: id, runId: id, attemptId: id, editingSessionId: id, conversationId: id, maxSequence: "20" };
  pages.set(null, { ...base, items: [{ sequence: "20", role: "user", content: user, offsetBytes: 0, hasMoreContent: false }, { sequence: "19", role: "assistant", content: progress + "a".repeat(7400), offsetBytes: 0, hasMoreContent: false }], nextCursor: "18:0" });
  pages.set("18:0", { ...base, items: [{ sequence: "18", role: "assistant", content: evidence + "b".repeat(7500), offsetBytes: 0, hasMoreContent: false }], nextCursor: null });
  const reads: (string | null)[] = [];
  return { pages, reads, read: async (cursor: string | null) => { reads.push(cursor); return validateHistoryPage(structuredClone(pages.get(cursor)), input, cursor); } };
}
const facts = [
  { category: "goal", sequence: "20", offsetBytes: 0, text: "目標：驗證付款失敗。" },
  { category: "constraint", sequence: "20", offsetBytes: Buffer.byteLength("目標：驗證付款失敗。"), text: "限制：不得刪除斷言。" },
  { category: "decision", sequence: "20", offsetBytes: Buffer.byteLength("目標：驗證付款失敗。限制：不得刪除斷言。"), text: "決策：沿用原提示。" },
  { category: "progress", sequence: "19", offsetBytes: 0, text: progress },
  { category: "evidence", sequence: "18", offsetBytes: 0, text: evidence },
];

test("both engines preserve grounded facts and full user constraints, reread frozen source and persist a bounded summary", async t => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine), before = JSON.stringify(input), source = history(input), bodies: Wire[] = [];
    let verified = 0;
    const out = await runAuthor(input, config, { verifyDraft: async (candidate: string) => { verified++; assert.equal(candidate, script); return { passed: true, summary: "synthetic self-test" }; } } as any, {
      history: source, fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        assert.ok(estimateInputTokens(body) <= 32000); assert.equal(body.max_output_tokens, 8192); assert.equal(body.reasoning.effort, "xhigh");
        const i = bodies.length;
        if (i === 1) return Response.json(envelope([call("read_conversation_history", "h1", { cursor: null })]));
        if (i === 2) return Response.json(envelope([{ type: "reasoning", id: "rs_memory", summary: [], encrypted_content: "opaque-memory" }, call("read_conversation_history", "h2", { cursor: "18:0" })]));
        if (i === 3) return Response.json(envelope([call("record_conversation_memory", "memory", { facts })]));
        if (i === 4) return Response.json(envelope([call("read_conversation_history", "reread", { cursor: "18:0" })]));
        if (i === 5) return Response.json(envelope([call("update_draft", "candidate", { script, message: "保留原限制並完成候選" })]));
        throw new Error("guarded candidate completion must not add another model request");
      },
    }) as AuthorOutput;
    assert.equal(verified, 1); assert.equal(out.script, script); assert.equal(out.partial, undefined); assert.equal(bodies.length, 5);
    assert.deepEqual(source.reads, [null, "18:0", "18:0"]);
    const memory = JSON.parse(out.conversationSummary!);
    assert.equal(memory.facts.length, 5); assert.equal(memory.baseRevision, 7); assert.equal(memory.contextRevision, 3); assert.equal(memory.validationEvidence, false);
    assert.deepEqual(memory.sources[0].userMessages, [source.pages.get(null)!.items[0]]); assert.ok(Buffer.byteLength(out.conversationSummary!) <= 8192);
    const compact = bodies.flatMap(body => body.input.filter((i: Wire) => i.type === "function_call_output").map((i: Wire) => JSON.parse(i.output))).filter((v: Wire) => v.conversationFacts?.facts.length);
    assert.ok(compact.length, "semantic categories must reach an actual compacted model request");
    assert.ok(compact.some((v: Wire) => v.conversationFacts.userMessages.some((u: Wire) => u.content === user)));
    assert.ok(bodies.every(body => body.input.some((i: Wire) => i.role === "user" && JSON.stringify(i.content).includes("不自動發佈"))));
    for (const body of bodies.slice(2)) {
      assert.ok(body.input.some((i: Wire) => i.type === "reasoning" && i.encrypted_content === "opaque-memory"));
      for (const result of body.input.filter((i: Wire) => i.type === "function_call_output")) assert.ok(body.input.some((i: Wire) => i.type === "function_call" && i.call_id === result.call_id));
    }
    assert.equal(JSON.stringify(input), before);
    t.diagnostic(JSON.stringify({ engine, requests: bodies.length, tools: 5, reads: source.reads.length, selfTests: verified, peakEstimate: Math.max(...bodies.map(estimateInputTokens)), limit: 32000, summaryBytes: Buffer.byteLength(out.conversationSummary!) }));
  }
});

test("cancellation after recording does not return a summary artifact or execute candidate work", async () => {
  const input = task("builtin"), source = history(input), stop = new AbortController(); let requests = 0;
  await assert.rejects(runAuthor(input, config, undefined, { signal: stop.signal, history: source, fetcher: async () => {
    if (++requests === 1) return Response.json(envelope([call("read_conversation_history", "h", { cursor: null })]));
    if (requests === 2) return Response.json(envelope([call("record_conversation_memory", "m", { facts: facts.slice(0, 3) })]));
    stop.abort(); return Response.json(envelope([text()]));
  } }), (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
  assert.equal(requests, 3); assert.equal(source.reads.length, 1);
});

test("redaction-modified pages cannot mint misleading canonical byte offsets or a persisted memory", async () => {
  const input = task("builtin"), source = history(input), secrets = new KnownSecrets(); secrets.add("secret-token");
  const content = "secret-token。限制：不得刪除斷言。";
  source.pages.set(null, { ...source.pages.get(null)!, items: [{ sequence: "20", role: "user", content, offsetBytes: 0, hasMoreContent: false }], nextCursor: null });
  const clean = secrets.redact(content), offsetBytes = Buffer.byteLength(clean.slice(0, clean.indexOf("限制")));
  let requests = 0, result: Wire | undefined;
  const out = await runAuthor(input, config, undefined, { history: source, secrets, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.ok(!JSON.stringify(body).includes("secret-token"));
    if (++requests === 1) return Response.json(envelope([call("read_conversation_history", "h", { cursor: null })]));
    if (requests === 2) return Response.json(envelope([call("record_conversation_memory", "m", { facts: [{ category: "constraint", sequence: "20", offsetBytes, text: "限制：不得刪除斷言。" }] })]));
    result = JSON.parse(body.input.find((i: Wire) => i.type === "function_call_output" && i.call_id === "m").output);
    assert.equal(requests, 3); return Response.json(envelope([text()]));
  } });
  assert.equal((out as AuthorOutput).conversationSummary, undefined); assert.equal(result?.recorded, undefined);
  assert.equal(source.reads.length, 1); assert.equal(requests, 3);
});
