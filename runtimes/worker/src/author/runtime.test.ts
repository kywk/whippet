import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { AIError, readAIConfig } from "../ai/config.js";
import { runAuthor } from "./loop.js";
import { loadToolRegistry, sha256 } from "./registry.js";
import { AuthorError, type AuthorInput } from "./types.js";
import { managedModelConfig, readAuthorConfig, runtimeConfig, runtimeDigest, validRuntime, type AuthorRuntime } from "./runtime.js";
import { fixture, envelope, text } from "./spike/fixture.js";
import { requestModelKey } from "./model-key.js";
import { runModelProbe } from "./model-probe.js";

const golden: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
function task(runtime = golden): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111", registry = loadToolRegistry();
  const root = new URL("../../skills/test-author/", import.meta.url), bytes = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(bytes.toString());
  return { kind: "author", runId: id, attemptId: id, script: "", timeoutMs: 180000, author: {
    conversationId: id, baseRevision: 1, messages: [{ role: "user", content: "說明目前測試" }], skillId: "test-author", skillVersion: "1",
    editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null, allowedTools: ["read_draft"],
    skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(bytes), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
    budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime,
  } };
}
function signed(overrides: Partial<AuthorRuntime>): AuthorRuntime {
  const r = { ...golden, ...overrides }; return { ...r, sha256: runtimeDigest(r) };
}

test("v12 golden digest survives jsonb order; malformed/expanded runtime fails closed", () => {
  assert.ok(validRuntime(golden));
  assert.ok(validRuntime(Object.fromEntries(Object.entries(golden).reverse())));
  for (const bad of [null, { ...golden, model: "drift" }, { ...golden, apiKey: "forbidden" }, signed({ engine: "vercel", contextWindowTokens: 0 }), signed({ contextWindowTokens: 2097152 }), signed({ baseURL: "https://provider.example/v1?" }), signed({ baseURL: "https://user:pass@provider.example/v1" })]) assert.equal(validRuntime(bad), false);
});

test("each queued runtime ignores later env drift and keeps skill budgets and tools", async () => {
  for (const engine of ["builtin", "vercel", "pi"] as const) {
    const r = signed({ engine, profileId: engine });
    const input = task(r), before = JSON.stringify(input);
    const config = readAuthorConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-opencode-key",
      WHIPPET_AI_ENGINE: "invalid-later", WHIPPET_AI_PROVIDER: "invalid-later", WHIPPET_AI_MODEL: "changed",
      WHIPPET_AI_REASONING_EFFORT: "invalid-later", WHIPPET_AI_BASE_URL: "invalid-later",
      WHIPPET_AI_CONTEXT_WINDOW_TOKENS: "NaN", WHIPPET_AI_CONTEXT_INPUT_TOKENS: "NaN" }, r);
    const f = await fixture(() => envelope([text()]));
    try {
      let selectedURL = "";
      const out = await runAuthor(input, config, undefined, { fetcher: async (url, init) => {
        selectedURL = String(url); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-opencode-key");
        return fetch(f.config.baseURL + "/responses", init);
      } });
      assert.equal(out.message, "完成"); assert.equal(selectedURL, golden.baseURL + "/responses");
      assert.equal(f.bodies.length, 1);
      const body = f.bodies[0]!;
      assert.equal(body.model, golden.model); assert.equal(body.reasoning.effort, golden.reasoningEffort);
      assert.equal(body.max_output_tokens, 8192); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["read_draft"]);
      assert.equal(JSON.stringify(input), before);
    } finally { await f.close(); }
  }
});

test("backend custom provider uses its fixed secret slot; no borrowing or malformed request", async () => {
  const r = signed({ profileId: "alternate", provider: "openai-responses", baseURL: "https://provider.example/v1", model: "configured-model", reasoningEffort: "high", contextWindowTokens: 131072, contextInputTokens: 32768 });
  const env = { WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-opencode-key", WHIPPET_AI_API_KEY: "synthetic-alternate-key" };
  const config = readAIConfig(env);
  assert.equal(runtimeConfig(config, r).apiKey, env.WHIPPET_AI_API_KEY);
  assert.throws(() => readAuthorConfig({ ...env, WHIPPET_AI_API_KEY: undefined }, r), (error: unknown) => error instanceof AIError && error.code === "missing_key");
  const f = await fixture(() => envelope([text()]));
  try {
    const out = await runAuthor(task(r), config, undefined, { fetcher: async (url, init) => {
      assert.equal(String(url), r.baseURL + "/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-alternate-key");
      return fetch(f.config.baseURL + "/responses", init);
    } });
    assert.equal(out.message, "完成"); assert.equal(f.bodies[0]!.model, "configured-model"); assert.equal(f.bodies[0]!.reasoning.effort, "high");
    let requests = 0;
    const fetcher = async () => { requests++; throw new Error("must not request"); };
    await assert.rejects(runAuthor(task({ ...r, model: "tampered" }), config, undefined, { fetcher }), AuthorError);
    await assert.rejects(runAuthor(task(r), readAIConfig({ ...env, WHIPPET_AI_API_KEY: undefined }), undefined, { fetcher }), AIError);
    assert.equal(requests, 0);
  } finally { await f.close(); }
});

test("final guard also rejects an inactive provider's secret in synthetic output", async () => {
  const config = readAuthorConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-opencode-key", WHIPPET_AI_API_KEY: "synthetic-inactive-secret" }, golden);
  const f = await fixture(() => envelope([text('{"message":"synthetic-inactive-secret"}')]));
  try {
    await assert.rejects(runAuthor(task(), config, undefined, { fetcher: async (_url, init) => fetch(f.config.baseURL + "/responses", init) }), (error: unknown) => error instanceof AuthorError && error.code === "sensitive_output");
    assert.equal(f.bodies.length, 1);
  } finally { await f.close(); }
});

for (const engine of ["builtin", "vercel", "pi"] as const) test(`ADM v14 ${engine} probe and author use the pinned key`, async () => {
  const runtime = signed({ engine, profileId: engine });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const key = `isolated-${engine}-fixture-key`;
  const credential = { agentId: id, secretVersion: 2 };
  const read = new PassThrough(), write = new PassThrough();
  write.on("data", data => {
    const request = JSON.parse(String(data));
    assert.deepEqual(request, { kind: "model_key_request", requestId: request.requestId, ...credential });
    read.write(JSON.stringify({ kind: "model_key_response", requestId: request.requestId, ...credential, apiKey: key }) + "\n");
  });
  const config = managedModelConfig(runtime, await requestModelKey(credential, new AbortController().signal, { read, write }));
  let probes = 0;
  assert.equal(await runModelProbe(config, id, { fetcher: async (url, init) => {
    probes++;
    assert.equal(url, `${runtime.baseURL}/responses`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools, []);
    assert.equal(body.max_output_tokens, 128);
    assert.equal(body.model, runtime.model);
    assert.ok(!String(init?.body).includes(key));
    return Response.json(envelope([text(`  WHIPPET_PROBE:${id}  `)]));
  } }), "passed");
  assert.equal(probes, 1);
  assert.equal(await runModelProbe(config, id, { fetcher: async () => new Response(null, { status: 401 }) }), "provider_auth_failed");
  const input = { ...task(runtime), workspaceId: id, testId: id, modelCredential: credential };
  const authored = await runAuthor(input, config, undefined, { fetcher: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    assert.ok(!String(init?.body).includes(key));
    return Response.json(envelope([text()]));
  } });
  assert.equal(authored.message, "完成");
  assert.ok(!JSON.stringify(authored).includes(key));
});

test("ADM v14 cannot use a different agent or secret version from stdin", async () => {
  const credential = { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secretVersion: 2 };
  for (const override of [{ secretVersion: 1 }, { agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]) {
    const read = new PassThrough(), write = new PassThrough();
    write.on("data", data => {
      const { requestId } = JSON.parse(String(data));
      read.write(JSON.stringify({ kind: "model_key_response", requestId, ...credential, ...override, apiKey: "other-fixture-key" }) + "\n");
    });
    await assert.rejects(requestModelKey(credential, new AbortController().signal, { read, write }), { code: "missing_key" });
  }
});
