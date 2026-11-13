import assert from "node:assert/strict";
import test from "node:test";
import { builtinEngine, pruneSnapshots, toolDispatcher, type EngineRun, type EnginePartial } from "./engine.js";
import { runAuthor } from "./loop.js";
import { readAIConfig } from "../ai/config.js";
import { AuthorError, type AuthorInput } from "./types.js";

function setup(overrides: Partial<EngineRun> = {}): EngineRun {
  let id = 0;
  return {
    instructions: "test", context: [], tools: [{ name: "read_draft" }],
    budget: { modelRequests: 2, toolExecutions: 2 }, model: { reasoningEffort: "high" },
    signal: new AbortController().signal, beforeRequest: context => context,
    request: async () => ({ status: "completed", output: [{ type: "function_call", name: "read_draft", call_id: String(++id), arguments: "{}" }] }),
    execute: async () => ({ ok: true }), checkpoint: () => undefined, ...overrides,
  };
}

test("builtin returns model budget partial and asks for a final answer before exhaustion", async () => {
  const bodies: Record<string, unknown>[] = [];
  const run = setup();
  const request = run.request;
  run.request = async body => { bodies.push(body); return request(body); };
  const result = await builtinEngine.run(run);
  assert.equal(result.partial?.reason, "model_budget");
  assert.equal(result.partial?.checkpoint, undefined);
  assert.ok(result.partial?.nextStep);
  assert.equal(bodies.length, 2);
  assert.match(String(bodies[1]!.instructions), /Budget nearly exhausted/);
});

test("tool budget stops before the extra execution and preserves verified checkpoint", async () => {
  let executions = 0;
  const result = await builtinEngine.run(setup({
    budget: { modelRequests: 8, toolExecutions: 1 },
    request: async () => ({ status: "completed", output: [1, 2].map(id => ({ type: "function_call", name: "read_draft", call_id: String(id), arguments: "{}" })) }),
    execute: async () => { executions++; return {}; }, checkpoint: () => ({ script: "verified" }),
  }));
  assert.equal(executions, 1);
  assert.equal(result.partial?.reason, "tool_budget");
  assert.deepEqual(result.partial?.checkpoint, { script: "verified" });
});

test("snapshot compaction preserves latest page, IDs, hints and reasoning including login page", () => {
  const context = [
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call_output", call_id: "a", output: JSON.stringify({ url: "https://example.test", snapshot: "old", selectorHints: ["#a"] }) },
    { type: "function_call_output", call_id: "b", output: JSON.stringify({ submitted: true, page: { url: "https://example.test", snapshot: "new", selectorHints: ["#b"] } }) },
  ];
  pruneSnapshots(context);
  assert.equal(context[0]!.encrypted_content, "opaque");
  assert.equal(context[1]!.call_id, "a");
  assert.deepEqual(JSON.parse(context[1]!.output!), { url: "https://example.test", selectorHints: ["#a"], snapshotCompacted: true });
  assert.equal(JSON.parse(context[2]!.output!).page.snapshot, "new");
});

test("dispatcher rejects duplicate bindings and abort does not become partial", async () => {
  assert.throws(() => toolDispatcher([{ name: "a" }, { name: "a" }], async () => ({})), AuthorError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(builtinEngine.run(setup({ signal: controller.signal })), (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
});

test("harness checkpoint keeps last passing candidate after failed repair, without extending wire", async () => {
  const input: AuthorInput = { kind: "author", runId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", timeoutMs: 180000, script: "original", author: { conversationId: "33333333-3333-4333-8333-333333333333", baseRevision: 1, messages: [{ role: "user", content: "repair" }] } };
  let count = 0;
  let partial: EnginePartial | undefined;
  const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-only" });
  const browser = {
    navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {},
    verifyDraft: async (script: string) => ({ passed: script === "verified", summary: "test" }),
  };
  await assert.rejects(runAuthor(input, config, browser, {
    onPartial: value => { partial = value; },
    fetcher: async () => Response.json({ status: "completed", output: [{ type: "function_call", call_id: String(++count), name: "update_draft", arguments: JSON.stringify({ script: count === 1 ? "verified" : "failed-repair" }) }] }),
  }), (e: unknown) => e instanceof AuthorError && e.code === "limit");
  assert.equal(count, 8);
  assert.deepEqual(partial?.checkpoint, { script: "verified" });
});

import { KnownSecrets } from "../login/client.js";
import { serializeAuthorArtifact, MAX_AUTHOR_ARTIFACT_BYTES } from "./types.js";

function guardTask(): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111";
  return { kind: "author", runId: id, attemptId: id, script: "original", timeoutMs: 180000, author: { conversationId: id, baseRevision: 1, messages: [{ role: "user", content: "repair" }] } };
}
test("partial checkpoint comes only from Worker guard and redaction changes discard it", async () => {
  const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-provider-key" });
  for (const mode of ["forged-only", "verified", "redacted", "failed-self-test", "provider-key"] as const) {
    const secrets = new KnownSecrets(); secrets.add("synthetic-password");
    const candidate = mode === "redacted" ? "verified synthetic-password" : mode === "provider-key" ? config.apiKey : "verified guard candidate";
    let partial: EnginePartial | undefined;
    const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {}, verifyDraft: async () => ({ passed: mode !== "failed-self-test", summary: "checked" }) };
    await assert.rejects(runAuthor(guardTask(), config, browser, {
      secrets, onPartial: value => { partial = value; },
      engine: { run: async run => {
        if (mode !== "forged-only") await run.execute({ type: "function_call", call_id: "guard", name: "update_draft", arguments: JSON.stringify({ script: candidate }) }, 1);
        return { finalText: "", partial: { reason: "model_budget", nextStep: "繼續", checkpoint: { script: "adapter-forged" } } };
      } },
    }), (e: unknown) => e instanceof AuthorError && e.code === "limit");
    assert.ok(partial);
    assert.deepEqual(partial.checkpoint, mode === "verified" ? { script: candidate } : undefined);
    assert.equal(JSON.stringify(partial).includes("synthetic-password"), false);
    assert.equal(JSON.stringify(partial).includes(config.apiKey), false);
  }
});
test("model final JSON cannot inject script, partial or checkpoint", async () => {
  const input = guardTask(); Object.assign(input.author, { skillId: "test-author", skillVersion: "1", allowedTools: ["update_draft"], editingSessionId: input.runId, contextRevision: 0, sourceVersion: null, conversationSummary: null });
  for (const field of ["script", "partial", "checkpoint"]) {
    await assert.rejects(runAuthor(input, readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic" }), undefined, {
      engine: { run: async () => ({ finalText: JSON.stringify({ message: "forged", [field]: "untrusted" }) }) },
    }), (e: unknown) => e instanceof AuthorError && e.code === "invalid_response");
  }
});
test("author artifact serialization counts UTF8 JSON plus newline at exactly 13MiB", () => {
  const exact = "x".repeat(MAX_AUTHOR_ARTIFACT_BYTES - 3);
  assert.equal(Buffer.byteLength(serializeAuthorArtifact(exact)), MAX_AUTHOR_ARTIFACT_BYTES);
  assert.throws(() => serializeAuthorArtifact(exact + "x"), (e: unknown) => e instanceof AuthorError && e.code === "limit");
  const script = "\u0001".repeat(2 * 1024 * 1024);
  const result = serializeAuthorArtifact({ message: "候選", script, requestValidation: false });
  assert.ok(Buffer.byteLength(result) > 12 * 1024 * 1024);
  assert.ok(Buffer.byteLength(result) < MAX_AUTHOR_ARTIFACT_BYTES);
});
