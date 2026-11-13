import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAuthor } from "./loop.js";
import { AuthorError, type AuthorInput, type AuthorOutput } from "./types.js";
import { loadToolRegistry, sha256 } from "./registry.js";
import { readAIConfig } from "../ai/config.js";
import { KnownSecrets } from "../login/client.js";

const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-partial-provider" });
function task(v10 = true): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111";
  const input: AuthorInput = { kind: "author", runId: id, attemptId: id, script: "old", timeoutMs: 180000, author: {
    conversationId: id, baseRevision: 1, messages: [{ role: "user", content: "write" }],
    skillId: "test-author", skillVersion: "1", editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null,
    allowedTools: ["update_draft", "request_validation"],
  } };
  if (v10) {
    const root = new URL("../../skills/test-author/", import.meta.url), raw = readFileSync(new URL("manifest.json", root));
    const manifest = JSON.parse(raw.toString()), registry = loadToolRegistry();
    Object.assign(input.author, { skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: {} }], budget: { ...manifest.budget, maxModelRequests: 1 }, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 });
  }
  return input;
}
const script = "import {test} from '@playwright/test'; test('candidate',()=>{});";
test("production v10 budget returns guard-owned checkpoint, never queues validation", async () => {
  const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {}, verifyDraft: async () => ({ passed: true, summary: "passed" }) };
  let requests = 0;
  const output = await runAuthor(task(), config, browser, { onPartial: event => { if (event.checkpoint) event.checkpoint.script = "observer tamper"; }, fetcher: async () => {
    requests++; return Response.json({ status: "completed", output: [
      { type: "function_call", call_id: "save", name: "update_draft", arguments: JSON.stringify({ script }) },
      { type: "function_call", call_id: "validate", name: "request_validation", arguments: "{}" },
    ] });
  } }) as AuthorOutput;
  assert.equal(requests, 1); assert.equal(output.requestValidation, false); assert.equal(output.script, script);
  assert.deepEqual(output.partial?.checkpoint, { scriptHash: sha256(script), selfTestPassed: true });
  assert.equal(output.partial?.reason, "budget_exhausted"); assert.ok(output.partial?.nextStep);
});
test("v10 partial omits script for failed/unverified/redacted candidates and ignores EnginePartial forgeries", async () => {
  for (const mode of ["failed", "unverified", "redacted", "forged"]) {
    const secrets = new KnownSecrets(); secrets.add("candidate");
    const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {}, verifyDraft: async () => ({ passed: mode !== "failed", summary: "checked" }) };
    const output = await runAuthor(task(), config, mode === "unverified" ? undefined : browser, {
      ...(mode === "redacted" ? { secrets } : {}), engine: { run: async run => {
        if (mode !== "forged") await run.execute({ type: "function_call", call_id: "save", name: "update_draft", arguments: JSON.stringify({ script }) }, 1);
        return { finalText: "", partial: { reason: "tool_budget", nextStep: "continue", checkpoint: { script: "forged" } } };
      } },
    }) as AuthorOutput;
    assert.equal(output.partial?.reason, "budget_exhausted"); assert.equal(output.requestValidation, false);
    assert.equal(Object.hasOwn(output, "script"), false); assert.equal(Object.hasOwn(output.partial!, "checkpoint"), false);
  }
});
test("v9 test-author and legacy do not emit new fields; cancellation is not partial", async () => {
  for (const input of [task(false), { ...task(false), author: { conversationId: task(false).author.conversationId, baseRevision: 1, messages: [{ role: "user" as const, content: "write" }] } }]) {
    await assert.rejects(runAuthor(input, config, undefined, { engine: { run: async () => ({ finalText: "", partial: { reason: "model_budget", nextStep: "continue" } }) } }), (error: unknown) => error instanceof AuthorError && error.code === "limit");
  }
  const stop = new AbortController(); stop.abort();
  await assert.rejects(runAuthor(task(), config, undefined, { signal: stop.signal }), (error: unknown) => error instanceof AuthorError && error.code === "cancelled");
});
