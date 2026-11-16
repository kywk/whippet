import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { runAuthor } from "../loop.js";
import { HistoryClient, type HistoryPage } from "../history.js";
import { loadToolRegistry, sha256 } from "../registry.js";
import { runtimeDigest, type AuthorRuntime } from "../runtime.js";
import type { AuthorInput, AuthorOutput } from "../types.js";
import { readAIConfig } from "../../ai/config.js";
import { KnownSecrets } from "../../login/client.js";
import { envelope, call, text, runInput, type Wire } from "../spike/fixture.js";
import { builtinEngine } from "../engine.js";
import { vercelEngine } from "./vercel.js";
import { estimateInputTokens } from "./context.js";

const id = "11111111-1111-4111-8111-111111111111";
const pin = "9007199254740993";
const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-context-runtime-key" });
const facts = { goal: "驗測付款失敗", constraints: ["保留斷言", "不可跨站"], decisions: ["沿用失敗提示"], revision: 7, stage: "verify", evidence: ["run/fixed"] };
const script = "import {test,expect} from '@playwright/test';test('payment',async({page})=>{await expect(page.getByRole('alert')).toHaveText('付款失敗');});";
function task(engine: "builtin" | "vercel", cap = 32000): AuthorInput {
  const registry = loadToolRegistry(), root = new URL("../../../skills/test-author/", import.meta.url);
  const raw = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(raw.toString());
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
  Object.assign(runtime, { engine, profileId: engine, contextInputTokens: cap }); runtime.sha256 = runtimeDigest(runtime);
  return { kind: "author", runId: id, attemptId: id, workspaceId: id, testId: id, script: "original spec", timeoutMs: 180000,
    workspaceContext: { schemaVersion: "1", workspaceId: id, settingsRevision: 1, config: { name: "合成站", purpose: "驗收", backgroundSummary: "背景", targets: [{ name: "站", purpose: "測試", origin: "https://example.test" }], dependencies: [], excludedOrigins: [], exclusions: "", loginRoles: [], defaultTestUrl: "", timeoutMs: 60000 }, roleRefs: [] },
    author: { conversationId: id, baseRevision: 7, contextRevision: 0, editingSessionId: id, sourceVersion: null, conversationSummary: JSON.stringify(facts),
      messages: [{ role: "user", content: JSON.stringify(facts) }, { role: "assistant", content: "earlier dialogue ".repeat(180) }, { role: "user", content: "依原目標與證據修復，不可刪除斷言" }],
      skillId: "test-author", skillVersion: "1", allowedTools: ["read_draft", "read_conversation_history", "update_draft"], history: { maxSequence: pin },
      skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
      budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime,
    } };
}
function history(input: AuthorInput) {
  const read = new PassThrough(), write = new PassThrough(), cursors: (string | null)[] = [];
  const client = new HistoryClient(input, { read, write });
  const pages = new Map<string | null, HistoryPage>();
  for (const [cursor, sequence] of [[null, pin], [`${BigInt(pin) - 1n}:0`, String(BigInt(pin) - 1n)]] as const) {
    pages.set(cursor, { workspaceId: id, testId: id, runId: id, attemptId: id, editingSessionId: id, conversationId: id, maxSequence: pin,
      items: [{ sequence, role: "user", content: "較早決策：付款失敗仍須驗測錯誤提示；證據引用=run/frozen-history。" + "earlier DATA ".repeat(620) + " synthetic-history-secret", offsetBytes: 0, hasMoreContent: false }], nextCursor: cursor === null ? `${BigInt(pin) - 1n}:0` : null });
  }
  write.on("data", bytes => {
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.kind, "tool_request"); assert.equal(frame.name, "read_conversation_history");
    cursors.push(frame.arguments.cursor);
    const page = pages.get(frame.arguments.cursor); assert.ok(page);
    queueMicrotask(() => read.write(JSON.stringify({ kind: "tool_response", requestId: frame.requestId, attemptId: id, result: page }) + "\n"));
  });
  return { client, cursors, pages, close() { client.close(); read.destroy(); write.destroy(); } };
}
function messageText(item: Wire): string { return typeof item.content === "string" ? item.content : item.content.map((p: Wire) => p.text).join(""); }

test("both production engines compact frozen history, read it back through IPC and deliver inside fixed budgets", async t => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine), original = JSON.stringify(input), source = history(input), bodies: Wire[] = [], events: string[] = [];
    const secrets = new KnownSecrets(); secrets.add("synthetic-history-secret");
    let selfTests = 0, retrieved: Wire | undefined;
    try {
      const out = await runAuthor(input, config, { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {},
        verifyDraft: async candidate => { selfTests++; assert.equal(candidate, script); return { passed: true, summary: "synthetic self-test" }; } }, {
        history: source.client, secrets, progress: event => events.push(event), fetcher: async (_url, init) => {
          const body = JSON.parse(String(init?.body)); bodies.push(body);
          assert.ok(estimateInputTokens(body) <= 32000); assert.equal(body.max_output_tokens, 8192); assert.equal(body.reasoning.effort, "xhigh");
          assert.ok(!JSON.stringify(body).includes("synthetic-history-secret"));
          if (bodies.length === 1) return Response.json(envelope([call("read_conversation_history", "first", { cursor: "null" })]));
          if (bodies.length === 2) return Response.json(envelope([{ type: "reasoning", id: "rs_history", summary: [], encrypted_content: "opaque-history" }, call("read_conversation_history", "second", { cursor: `${BigInt(pin) - 1n}:0` })]));
          if (bodies.length === 3) return Response.json(envelope([call("read_draft", "draft")]));
          if (bodies.length === 4) {
            const summaries = body.input.filter((i: Wire) => i.type === "function_call_output").map((i: Wire) => JSON.parse(i.output)).filter((i: Wire) => i.contextCompacted);
            retrieved = summaries.find((s: Wire) => s.retrieve.tool === "read_conversation_history" && s.retrieve.arguments.cursor === null);
            assert.ok(retrieved); assert.equal(retrieved.identity.maxSequence, pin); assert.equal(retrieved.validationEvidence, false);
            const raw = secrets.clean(source.pages.get(null)!);
            assert.equal(retrieved.originalSha256, sha256(Buffer.from(JSON.stringify({ items: raw.items, nextCursor: raw.nextCursor }))));
            return Response.json(envelope([call(retrieved.retrieve.tool, "retrieve", retrieved.retrieve.arguments)]));
          }
          assert.equal(bodies.length, 5);
          const latest = body.input.filter((i: Wire) => i.type === "function_call_output").at(-1);
          assert.equal(latest.call_id, "retrieve"); assert.equal(JSON.parse(latest.output).contextCompacted, undefined);
          assert.deepEqual(JSON.parse(latest.output).items, secrets.clean(source.pages.get(null)!.items));
          assert.ok(body.input.some((i: Wire) => i.type === "reasoning" && i.encrypted_content === "opaque-history"));
          return Response.json(envelope([call("update_draft", "candidate", { script, message: "保留原限制與付款失敗斷言" })]));
        },
      }) as AuthorOutput;
      assert.equal(out.script, script); assert.equal(out.partial, undefined); assert.equal(selfTests, 1); assert.equal(bodies.length, 5);
      assert.deepEqual(source.cursors, [null, `${BigInt(pin) - 1n}:0`, null]);
      assert.ok(events.some(e => e.startsWith("author:context:compacted:")));
      assert.equal(events.filter(e => /^author:tool:\d+:.*:started$/.test(e)).length, 5);
      for (const body of bodies) {
        assert.deepEqual(body.input.slice(1, 4).map(messageText), input.author.messages.map(m => m.content));
        assert.ok(messageText(body.input[0]).includes(JSON.stringify(facts).replaceAll('"', '\\"')));
        for (const result of body.input.filter((i: Wire) => i.type === "function_call_output")) assert.ok(body.input.some((i: Wire) => i.type === "function_call" && i.call_id === result.call_id));
      }
      assert.equal(JSON.stringify(input), original);
      t.diagnostic(JSON.stringify({ engine, requests: bodies.length, tools: 5, historyReads: source.cursors.length, selfTests, peakEstimate: Math.max(...bodies.map(estimateInputTokens)), limit: 32000 }));
    } finally { source.close(); }
  }
});

test("history quota exhaustion stops without an unrecoverable summary or hidden fifth read", async () => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine), source = history(input);
    let requests = 0;
    try {
      const out = await runAuthor(input, config, undefined, { history: source.client, fetcher: async () => {
        return Response.json(envelope([call("read_conversation_history", `read-${++requests}`, { cursor: null })]));
      } }) as AuthorOutput;
      assert.equal(requests, 4); assert.equal(source.cursors.length, 4);
      assert.equal(out.partial?.usage?.modelRequests, 4); assert.equal(out.partial?.usage?.toolCalls, 4);
      assert.match(out.message, /容量/); assert.match(out.partial!.nextStep, /容量/);
      assert.equal(out.script, undefined); assert.equal(out.partial?.checkpoint, undefined); assert.equal(out.requestValidation, false);
    } finally { source.close(); }
  }
});

test("protected oversized context is rejected before HTTP in both engines and records zero model/tool use", async () => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine, 16000); input.script = "protected Stage with original assertions ".repeat(1000);
    let requests = 0;
    const out = await runAuthor(input, config, undefined, { fetcher: async () => { requests++; return Response.json(envelope([text()])); } }) as AuthorOutput;
    assert.equal(requests, 0); assert.equal(out.partial?.usage?.modelRequests, 0); assert.equal(out.partial?.usage?.toolCalls, 0);
    assert.match(out.message, /容量/); assert.equal(out.script, undefined); assert.equal(out.requestValidation, false);
  }
});

test("final body guard cannot bypass capacity after compaction in either engine", async () => {
  const capacity = { contextWindowTokens: 1048576, maxInputTokens: 16000, safetyTokens: 1024 };
  for (const engine of [builtinEngine, vercelEngine({ ...config, contextInputTokens: 16000 })]) {
    let requests = 0;
    const result = await engine.run(runInput(config, { capacity, prepareRequest: body => ({ ...body, input: [{ role: "user", content: "x".repeat(20000) }] }),
      request: async () => { requests++; return envelope([text()]); } }));
    assert.equal(requests, 0); assert.equal(result.partial?.reason, "context_capacity");
  }
});

test("legacy builtin runtime without a declared capacity keeps its original behavior", async () => {
  const input = task("builtin");
  input.author.runtime!.model = "unknown-model"; input.author.runtime!.contextWindowTokens = 0;
  input.author.runtime!.sha256 = runtimeDigest(input.author.runtime!);
  input.script = "legacy draft ".repeat(6000);
  let requests = 0;
  const out = await runAuthor(input, config, undefined, { fetcher: async () => { requests++; return Response.json(envelope([text()])); } }) as AuthorOutput;
  assert.equal(requests, 1); assert.equal(out.partial, undefined); assert.equal(out.message, "完成");
});
