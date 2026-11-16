import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAuthor } from "../loop.js";
import { AuthorError, serializeAuthorArtifact, type AuthorInput, type AuthorOutput } from "../types.js";
import { loadToolRegistry, sha256 } from "../registry.js";
import { runtimeDigest, type AuthorRuntime } from "../runtime.js";
import { readAIConfig } from "../../ai/config.js";
import { KnownSecrets } from "../../login/client.js";
import { envelope, call, type Wire } from "../spike/fixture.js";

const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-truncation-runtime" });
const script = "import {test,expect} from '@playwright/test';test('guard',async({page})=>{await expect(page.getByRole('alert')).toHaveText('付款失敗');});";
const repair = script + "// rejected repair";
function task(engine: "builtin" | "vercel"): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111", registry = loadToolRegistry();
  const root = new URL("../../../skills/test-author/", import.meta.url), raw = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(raw.toString());
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
  runtime.engine = engine; runtime.profileId = engine; runtime.sha256 = runtimeDigest(runtime);
  return { kind: "author", runId: id, attemptId: id, timeoutMs: 180000, script: "original saved draft", author: {
    conversationId: id, baseRevision: 7, messages: [{ role: "user", content: "修復付款失敗提示，保留所有斷言、原本限制與證據引用" }],
    skillId: "test-author", skillVersion: "1", editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null,
    allowedTools: ["update_draft"],
    skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
    budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime,
  } };
}
const truncated = (output: Wire[]) => envelope(output, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {} };

test("both production engines keep the last passing guard checkpoint after failed repair and truncated output", async t => {
  for (const engine of ["builtin", "vercel"] as const) for (const halfJSON of [true, false]) {
    const input = task(engine), original = JSON.stringify(input); let requests = 0, selfTests = 0, reason: string | undefined;
    const out = await runAuthor(input, config, { ...browser, verifyDraft: async candidate => { selfTests++; return { passed: candidate === script, summary: "synthetic self-test" }; } }, {
      onPartial: partial => { reason = partial.reason; assert.deepEqual(partial.checkpoint, { script }); },
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_output_tokens, 8192); assert.equal(body.reasoning.effort, "xhigh"); assert.equal(body.store, false);
        assert.match(body.instructions, /8 model requests, 12 tool executions, and 180000 milliseconds/);
        requests++;
        if (requests === 1) return Response.json(envelope([call("update_draft", "passing", { script, nextStep: "還須完成第二個斷言；保留run/fixed證據" })]));
        if (requests === 2) return Response.json(envelope([call("update_draft", "rejected", { script: repair })]));
        assert.equal(requests, 3);
        const prefix = call("update_draft", "incomplete", { script: repair, message: "不可採信的成功訊息" });
        if (halfJSON) prefix.arguments = '{"script":';
        return Response.json(truncated([prefix]));
      },
    }) as AuthorOutput;
    assert.equal(reason, "output_truncated"); assert.equal(out.script, script); assert.equal(selfTests, 2); assert.equal(requests, 3);
    assert.equal(out.partial?.reason, "budget_exhausted"); assert.equal(out.partial?.usage?.modelRequests, 3); assert.equal(out.partial?.usage?.toolCalls, 2);
    assert.ok(out.partial!.usage!.durationMs >= 1 && out.partial!.usage!.durationMs <= 180000);
    assert.deepEqual(out.partial?.checkpoint, { scriptHash: sha256(Buffer.from(script)), selfTestPassed: true });
    assert.match(out.message, /3\/8/); assert.match(out.message, /截斷/); assert.match(out.partial!.nextStep, /第二個斷言/); assert.match(out.partial!.nextStep, /run\/fixed/);
    assert.equal(out.requestValidation, false); assert.ok(!JSON.stringify(out).includes("不可採信的成功訊息"));
    assert.deepEqual(JSON.parse(String(serializeAuthorArtifact(out, "test-author"))), out); assert.equal(JSON.stringify(input), original);
    t.diagnostic(JSON.stringify({ engine, halfJSON, requests, selfTests, toolCalls: out.partial!.usage!.toolCalls, checkpointRetained: true }));
  }
});

test("an unsuccessful self-test and model-provided checkpoint cannot manufacture recovery", async () => {
  for (const engine of ["builtin", "vercel"] as const) {
    let requests = 0, selfTests = 0, partials = 0;
    await assert.rejects(runAuthor(task(engine), config, { ...browser, verifyDraft: async () => { selfTests++; return { passed: false, summary: "synthetic rejected self-test" }; } }, {
      onPartial: () => { partials++; }, fetcher: async () => {
        if (++requests === 1) return Response.json(envelope([call("update_draft", "failed", { script, nextStep: "未通過" })]));
        return Response.json({ ...truncated([call("update_draft", "prefix", { script })]), partial: { checkpoint: { script }, selfTestPassed: true } });
      },
    }), (error: unknown) => error instanceof AuthorError && error.code === "invalid_response");
    assert.equal(requests, 2); assert.equal(selfTests, 1); assert.equal(partials, 0);
  }
});

test("secret guard invalidation discards a saved checkpoint before truncated partial serialization", async () => {
  for (const engine of ["builtin", "vercel"] as const) {
    const secrets = new KnownSecrets(), candidate = script + "// redact-after-checkpoint";
    let requests = 0, selfTests = 0;
    const out = await runAuthor(task(engine), config, { ...browser, verifyDraft: async () => { selfTests++; return { passed: true, summary: "synthetic self-test" }; } }, {
      secrets, fetcher: async () => {
        if (++requests === 1) return Response.json(envelope([call("update_draft", "saved", { script: candidate, nextStep: "仍有剩餘斷言" })]));
        secrets.add("redact-after-checkpoint");
        return Response.json(truncated([{ ...call("update_draft", "half"), arguments: '{"script":' }]));
      },
    }) as AuthorOutput;
    assert.equal(requests, 2); assert.equal(selfTests, 1); assert.equal(out.partial?.usage?.modelRequests, 2); assert.equal(out.partial?.usage?.toolCalls, 1);
    assert.equal(out.script, undefined); assert.equal(out.partial?.checkpoint, undefined); assert.equal(out.requestValidation, false);
    assert.match(out.message, /尚無可保留/); assert.ok(!String(serializeAuthorArtifact(out, "test-author")).includes("redact-after-checkpoint"));
  }
});
