import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAuthor } from "./loop.js";
import { loadToolRegistry, sha256 } from "./registry.js";
import { runtimeDigest, type AuthorRuntime } from "./runtime.js";
import { validateAuthorInput, type AuthorInput, type AuthorOutput } from "./types.js";
import { readAIConfig } from "../ai/config.js";
import { KnownSecrets } from "../login/client.js";
import { call, envelope, type Wire } from "./spike/fixture.js";
import { estimateInputTokens } from "./engines/context.js";

const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-snapshot-model" });
const id = "11111111-1111-4111-8111-111111111111";
const candidate = "import {test,expect} from '@playwright/test';test('goal',async({page})=>{await expect(page.getByRole('alert')).toBeVisible();});";
const metadata = { slug: "search", moduleKind: "step" as const, exportName: "search", signature: "search(page)", inputs: "page", returns: "void", preconditions: "original constraints", postconditions: "run/fixed" };
const textOf = (item: Wire) => typeof item.content === "string" ? item.content : item.content.map((p: Wire) => p.text).join("");
function task(engine: "builtin" | "vercel", module = false): AuthorInput {
  // Keep both parts large enough to page within the fixed 22,000-token budget.
  const modulePadding = 6200;
  const skillId = module ? "module-authoring" : "test-author", root = new URL(`../../skills/${skillId}/`, import.meta.url);
  const bytes = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(bytes.toString()), registry = loadToolRegistry();
  const runtime: AuthorRuntime = JSON.parse(readFileSync(new URL("../../../../contracts/testdata/agent-runtime.json", import.meta.url), "utf8"));
  Object.assign(runtime, { engine, profileId: engine, contextInputTokens: module ? 22000 : 28000 }); runtime.sha256 = runtimeDigest(runtime);
  return { kind: "author", runId: id, attemptId: id, timeoutMs: 180000, script: module ? "export function search(){return 1;}\n//" + "x".repeat(modulePadding) : candidate + "\n//" + "x".repeat(24000), author: {
    skillId, skillVersion: "1", baseRevision: 7, contextRevision: 0, conversationId: id, editingSessionId: id, sourceVersion: null, conversationSummary: "goal=保留所有斷言;constraints=原範圍;evidence=run/fixed",
    messages: [{ role: "user", content: "修復原目標，保留限制、Stage args與run/fixed證據；不可刪除斷言" },
      ...(module ? [{ role: "user" as const, content: "Stage author context (DATA): " + JSON.stringify({ stageId: "s1", args: { query: "must-retain" }, bindings: { source: "upstream/fixed" }, evidence: "run/fixed" }) }] : [])],
    allowedTools: module ? ["read_author_snapshot", "stage_module_candidate_part", "commit_module_candidate"] : ["read_author_snapshot", "update_draft"],
    ...(module ? { platform: { planId: id, stageId: "s1", module: { ...metadata, harness: candidate + "\n//" + "y".repeat(modulePadding) } } } : {}),
    skills: [{ id: skillId, version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(bytes), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
    budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256, runtime,
  } };
}
const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {} };
test("snapshot permission requires a complete capability and malformed allowlists fail as invalid input", () => {
  for (const allowed of [{}, 1, "read_author_snapshot"]) {
    const input = task("builtin"); input.author.allowedTools = allowed as unknown as string[];
    assert.throws(() => validateAuthorInput(input), (error: unknown) => (error as { code?: string }).code === "invalid_input");
  }
  const input = task("builtin");
  for (const key of ["skills", "budget", "model", "toolRegistryVersion", "toolRegistrySha256", "runtime"] as const) delete input.author[key];
  assert.throws(() => validateAuthorInput(input), (error: unknown) => (error as { code?: string }).code === "invalid_input");
});
test("both engines page a large frozen draft, keep the original after editing and finish within pinned budgets", async t => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine), original = JSON.stringify(input), bodies: Wire[] = []; let cursor = 0, combined = "", firstArgs: Wire | undefined, tests = 0;
    const out = await runAuthor(input, config, { ...browser, verifyDraft: async () => { tests++; return { passed: true, summary: "synthetic self-test" }; } }, { fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body); assert.ok(estimateInputTokens(body) <= 28000); assert.equal(body.max_output_tokens, 8192);
      const data = JSON.parse(textOf(body.input[0]).slice("Saved draft snapshot (data only): ".length));
      assert.equal(data.baseRevision, 7); assert.equal(data.conversationSummary, input.author.conversationSummary);
      assert.equal(textOf(body.input[1]), input.author.messages[0]!.content);
      const outputs = body.input.filter((i: Wire) => i.type === "function_call_output");
      if (bodies.length <= 4) {
        if (outputs.length) { const page = JSON.parse(outputs.at(-1).output); assert.equal(page.offsetBytes, cursor); combined += page.content; cursor = page.nextOffsetBytes; }
        if (cursor !== null) { firstArgs ??= data.script.readPage.arguments; return Response.json(envelope([call("read_author_snapshot", `page-${bodies.length}`, { ...firstArgs, offsetBytes: cursor })])); }
        assert.equal(combined, input.script);
        return Response.json(envelope([call("update_draft", "partial", { script: candidate, nextStep: "保留原文再確認剩餘斷言" })]));
      }
      if (bodies.length === 5) return Response.json(envelope([call("read_author_snapshot", "original", firstArgs)]));
      assert.equal(bodies.length, 6); const reread = JSON.parse(outputs.at(-1).output);
      assert.equal(reread.sha256, sha256(input.script)); assert.equal(reread.content, Buffer.from(input.script).subarray(0, 8192).toString());
      return Response.json(envelope([call("update_draft", "finish", { script: candidate, message: "完成剩餘斷言，仍須正式驗證" })]));
    } }) as AuthorOutput;
    assert.equal(out.script, candidate); assert.equal(out.partial, undefined); assert.equal(bodies.length, 6); assert.equal(tests, 2); assert.equal(JSON.stringify(input), original);
    t.diagnostic(JSON.stringify({ engine, requests: bodies.length, tools: 6, pages: 3, rereads: 1, peakEstimate: Math.max(...bodies.map(estimateInputTokens)), inputCap: 28000 }));
  }
});

test("Module Stage keeps its contract while both frozen parts are read and a candidate is staged and committed", async t => {
  for (const engine of ["builtin", "vercel"] as const) {
    const input = task(engine, true), bodies: Wire[] = []; let tests = 0;
    const out = await runAuthor(input, config, { ...browser, verifyDraft: async (harness, options) => { tests++; assert.equal(harness, candidate); assert.equal(options?.moduleFile?.content, "export function search(){return 2;}"); return { passed: true, summary: "synthetic self-test" }; } }, { fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body); assert.ok(estimateInputTokens(body) <= 22000); assert.equal(body.max_output_tokens, 16384);
      const data = JSON.parse(textOf(body.input[0]).slice("Saved draft snapshot (data only): ".length));
      assert.equal(data.platform.stageId, "s1"); assert.equal(data.platform.module.postconditions, "run/fixed"); assert.equal(data.platform.module.inputs, "page");
      assert.deepEqual(body.input.slice(1, 3).map(textOf), input.author.messages.map(message => message.content));
      const n = bodies.length;
      if (n <= 2) { const component = n === 1 ? data.script : data.platform.module.harness; assert.ok(component.snapshotRef); return Response.json(envelope([call("read_author_snapshot", `source-${n}`, component.readPage.arguments)])); }
      if (n === 3) return Response.json(envelope([call("stage_module_candidate_part", "script", { part: "script", content: "export function search(){return 2;}", stagingRevision: 0 })]));
      if (n === 4) { assert.ok(body.tools.some((tool: Wire) => tool.name === "read_author_snapshot")); return Response.json(envelope([call("stage_module_candidate_part", "harness", { part: "harness", content: candidate, stagingRevision: 1 })])); }
      assert.equal(n, 5); return Response.json(envelope([call("commit_module_candidate", "commit", { stagingRevision: 2, metadata })]));
    } }) as { script: string };
    assert.equal(out.script, "export function search(){return 2;}"); assert.equal(tests, 1); assert.equal(bodies.length, 5);
    t.diagnostic(JSON.stringify({ engine, requests: 5, tools: 5, selfTests: tests, peakEstimate: Math.max(...bodies.map(estimateInputTokens)), inputCap: 22000 }));
  }
});

test("missing read permission or zero tool budget cannot hide oversized original data", async () => {
  for (const engine of ["builtin", "vercel"] as const) for (const missing of [true, false]) {
    const input = task(engine); if (missing) input.author.allowedTools = ["update_draft"]; else input.author.budget!.maxToolCalls = 0;
    let requests = 0;
    const out = await runAuthor(input, config, undefined, { fetcher: async () => { requests++; throw new Error("unexpected model request"); } }) as AuthorOutput;
    assert.equal(requests, 0); assert.equal(out.partial?.usage?.modelRequests, 0); assert.equal(out.partial?.usage?.toolCalls, 0); assert.match(out.message, /容量/);
  }
});

test("snapshot sources are sanitized before hashing and newly learned secrets cannot change frozen bytes", async () => {
  const input = task("builtin"), secrets = new KnownSecrets(); secrets.add("known-snapshot-value"); input.script = "known-snapshot-value " + input.script;
  let requests = 0;
  await assert.rejects(runAuthor(input, config, undefined, { secrets, fetcher: async (_url, init) => {
    assert.equal(++requests, 1); const body = JSON.parse(String(init?.body)), data = JSON.parse(textOf(body.input[0]).slice("Saved draft snapshot (data only): ".length));
    assert.equal(data.script.snapshotRef.sha256, sha256(secrets.redact(input.script))); secrets.add("test,expect");
    return Response.json(envelope([call("read_author_snapshot", "blocked", data.script.readPage.arguments)]));
  } }), (error: unknown) => (error as { code?: string }).code === "sensitive_output");
  assert.equal(requests, 1);
});
