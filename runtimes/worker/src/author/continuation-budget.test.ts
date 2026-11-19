import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAuthor } from "./loop.js";
import { AuthorError, type AuthorInput, type AuthorOutput } from "./types.js";
import { readAIConfig, type EngineId } from "../ai/config.js";
import { runtimeDigest, type AuthorRuntime } from "./runtime.js";
import { loadToolRegistry, sha256 } from "./registry.js";
import { envelope, call as fixtureCall } from "./spike/fixture.js";

const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-continuation-key" });
function task(engine: EngineId = "builtin"): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111", registry = loadToolRegistry();
  const root = new URL("../../skills/test-author/", import.meta.url), raw = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(raw.toString());
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
  runtime.engine = engine; runtime.profileId = engine; runtime.sha256 = runtimeDigest(runtime);
  return { kind: "author", runId: id, attemptId: id, script: "old", timeoutMs: 180000, author: {
    conversationId: id, baseRevision: 1, messages: [{ role: "user", content: "finish assertions" }],
    skillId: "test-author", skillVersion: "1", editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null, allowedTools: ["read_draft"],
    skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
    budget: { ...manifest.budget, maxModelRequests: 2, maxToolCalls: 2 }, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime,
  } };
}
const call = (id: string) => ({ type: "function_call", call_id: id, name: "read_draft", arguments: "{}" });

test("all production engines preserve reduced budgets and issue guarded partial receipts", async () => {
  for (const engine of ["builtin", "vercel", "pi"] as const) {
    let requests = 0;
    const input = task(engine), before = JSON.stringify(input);
    const out = await runAuthor(input, config, undefined, { fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens, 8192);
      requests++;
      return Response.json(envelope([fixtureCall("read_draft", `read-${requests}`)]));
    } }) as AuthorOutput;
    assert.ok(out.partial?.usage);
    assert.equal(requests, 2); assert.equal(out.partial.usage.modelRequests, 2); assert.equal(out.partial.usage.toolCalls, 2);
    assert.ok(out.partial.usage.durationMs >= 1 && out.partial.usage.durationMs <= 180000);
    assert.equal(JSON.stringify(input), before); assert.equal(out.requestValidation, false);
  }
});

test("receipt ignores forged engine events, ordinals and model-reported usage", async () => {
  const input = task(); input.author.budget!.maxToolCalls = 2;
  let requests = 0;
  const out = await runAuthor(input, config, undefined, {
    fetcher: async () => { requests++; return Response.json({}); },
    engine: { async run(run) {
      run.onEvent?.("author:model:0:started");
      await run.request({}); await run.request({});
      await run.execute(call("one"), 0); await run.execute(call("two"), 0);
      return { finalText: "", partial: { reason: "model_budget", nextStep: "remaining", usage: { modelRequests: 0 } } as never };
    } },
  }) as AuthorOutput;
  assert.equal(requests, 2); assert.equal(out.partial?.usage?.modelRequests, 2); assert.equal(out.partial?.usage?.toolCalls, 2);
});

test("guarded boundaries reject extra requests and tools even when engine resets counts", async () => {
  for (const boundary of ["model", "tool"] as const) {
    const input = task(); input.author.budget!.maxModelRequests = 1; input.author.budget!.maxToolCalls = 1;
    let requests = 0;
    await assert.rejects(runAuthor(input, config, undefined, {
      fetcher: async () => { requests++; return Response.json({}); },
      engine: { async run(run) {
        if (boundary === "model") { await run.request({}); await run.request({}); }
        else { await run.execute(call("one"), 1); await run.execute(call("two"), 1); }
        return { finalText: "" };
      } },
    }), AuthorError);
    assert.equal(requests, boundary === "model" ? 1 : 0);
  }
});

test("zero-request capacity partial still charges execution time", async () => {
  const out = await runAuthor(task(), config, undefined, { engine: { async run() {
    return { finalText: "", partial: { reason: "context_capacity", nextStep: "remaining" } };
  } } }) as AuthorOutput;
  assert.equal(out.partial?.usage?.modelRequests, 0); assert.equal(out.partial?.usage?.toolCalls, 0);
  assert.ok(out.partial!.usage!.durationMs >= 1);
});
