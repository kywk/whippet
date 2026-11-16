import test from "node:test";
import assert from "node:assert/strict";
import { fitContext, ContextCapacityError } from "./context.js";
import { availableModelCapacity, modelCapacity } from "../../ai/capacity.js";
import { createHash } from "node:crypto";

const version = "22222222-2222-4222-8222-222222222222";
const config = { enabled: true, baseURL: "https://opencode.ai/inference/go/openai/v1", apiKey: "synthetic", model: "muse-spark-1.3-contributor", reasoningEffort: "xhigh" as const };
test("unrecoverable, mutable or inaccessible data cannot be silently compacted", () => {
  for (const mode of ["draft", "report", "plan", "mismatched-version", "hidden-tool"]) {
    const name = mode === "draft" ? "read_draft" : mode === "report" ? "read_validation_report" : mode === "plan" ? "read_plan" : "catalog_get";
    const value = { script: "x".repeat(10000), versionId: mode === "mismatched-version" ? "wrong" : version, module: { slug: "known" } };
    const body = { instructions: "goal, constraints, decisions and evidence must remain", tools: mode === "hidden-tool" ? [] : [{ name }], input: [
      { role: "user", content: "revision=7, Stage=verify, evidence=run/fixed" },
      { type: "function_call", name, call_id: "old", arguments: JSON.stringify({ moduleVersionId: version }) },
      { type: "function_call_output", call_id: "old", output: JSON.stringify(value) },
      { type: "function_call", name: "read_draft", call_id: "latest", arguments: "{}" },
      { type: "function_call_output", call_id: "latest", output: "{}" },
    ] };
    const original = JSON.stringify(body);
    assert.throws(() => fitContext(body, { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 }, 8192, { toolCalls: 12 }), ContextCapacityError, mode);
    assert.equal(JSON.stringify(body), original, mode);
  }
});
test("frozen skill references compact with exact read-back arguments and never become validation evidence", () => {
  const args = { skillId: "test-author", referenceId: "external-mcp" };
  const body = { instructions: "protected", tools: [{ name: "read_skill_reference" }], input: [
    { type: "function_call", name: "read_skill_reference", call_id: "ref", arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: "ref", output: JSON.stringify({ ...args, content: "x".repeat(10000) }) },
    { type: "function_call", name: "read_draft", call_id: "new", arguments: "{}" },
    { type: "function_call_output", call_id: "new", output: "{\"script\":\"current\"}" },
  ] };
  const fitted = fitContext(body, { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 }, 8192, { toolCalls: 1 });
  const result = JSON.parse((fitted.body.input as { output?: string }[])[1]!.output!);
  assert.equal(fitted.compacted, 1); assert.deepEqual(result.retrieve, { tool: "read_skill_reference", arguments: args });
  assert.equal(result.validationEvidence, false); assert.equal(fitted.body.instructions, "protected");
});
test("unknown model capacity fails closed; an override cannot exceed known provider capacity", () => {
  assert.equal(modelCapacity(config).contextWindowTokens, 1048576);
  assert.throws(() => modelCapacity({ ...config, model: "unknown" }));
  assert.throws(() => modelCapacity({ ...config, baseURL: "https://different.invalid/v1" }));
  assert.throws(() => modelCapacity({ ...config, contextWindowTokens: 2097152 }));
  assert.equal(availableModelCapacity({ ...config, model: "unknown" }), undefined);
  assert.equal(availableModelCapacity(config)?.maxInputTokens, 65536);
  assert.throws(() => availableModelCapacity({ ...config, contextWindowTokens: 2097152 }));
  assert.equal(modelCapacity({ ...config, model: "unknown", contextWindowTokens: 131072 }).contextWindowTokens, 131072);
  assert.throws(() => fitContext({ instructions: "fixed", tools: [], input: [] }, { contextWindowTokens: 8192, maxInputTokens: 8192, safetyTokens: 1024 }, 8192), ContextCapacityError);
});

test("frozen history keeps exact UTF-8 fragment references and canonical read-back cursor", () => {
  const pin = { maxSequence: "9007199254740993" };
  const content = "決策與原始證據".repeat(300);
  const raw = { items: [{ sequence: pin.maxSequence, role: "user", content, offsetBytes: 0, hasMoreContent: true }], nextCursor: `${pin.maxSequence}:${Buffer.byteLength(content)}` };
  const result = JSON.stringify(raw);
  const body = { instructions: "goal and constraints", tools: [{ name: "read_conversation_history" }], input: [
    { role: "user", content: "revision=7;Stage=verify;evidence=run/fixed;不可刪除斷言" },
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call", name: "read_conversation_history", call_id: "old", arguments: '{"cursor":"null"}' },
    { type: "function_call_output", call_id: "old", output: result },
    { type: "function_call", name: "read_draft", call_id: "last", arguments: "{}" },
    { type: "function_call_output", call_id: "last", output: "{}" },
  ] };
  const original = structuredClone(body), capacity = { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 };
  const fitted = fitContext(body, capacity, 8192, { toolCalls: 1, history: { pin, reads: 1 } });
  const summary = JSON.parse((fitted.body.input as typeof body.input)[3]!.output!);
  assert.equal(fitted.compacted, 1); assert.deepEqual(body, original);
  assert.deepEqual(summary.retrieve, { tool: "read_conversation_history", arguments: { cursor: null } });
  assert.equal(summary.identity.maxSequence, pin.maxSequence); assert.equal(summary.identity.items[0].lengthBytes, Buffer.byteLength(raw.items[0]!.content));
  assert.equal(summary.originalSha256, createHash("sha256").update(result).digest("hex"));
  assert.equal(summary.dataOnly, true); assert.equal(summary.validationEvidence, false);
  assert.deepEqual((fitted.body.input as typeof body.input)[0], body.input[0]);
  assert.deepEqual((fitted.body.input as typeof body.input)[1], body.input[1]);
  assert.deepEqual((fitted.body.input as typeof body.input).at(-1), body.input.at(-1));
  for (const mutation of [
    (b: typeof body) => { b.tools = []; },
    (b: typeof body) => { b.input[2]!.arguments = '{"cursor":"9007199254740994:0"}'; },
    (b: typeof body) => { b.input[2]!.arguments = '{"cursor":"9007199254740993:3"}'; },
    (b: typeof body) => { b.input[2]!.arguments = '{"cursor":null,"other":true}'; },
    (b: typeof body) => { b.input[3]!.output = JSON.stringify({ ...raw, nextCursor: "1:0" }); },
    (b: typeof body) => { b.input[3]!.output = JSON.stringify({ ...raw, extra: "not a history page" }); },
    (b: typeof body) => { b.input.splice(4); },
  ]) {
    const changed = structuredClone(body); mutation(changed);
    assert.throws(() => fitContext(changed, capacity, 8192, { toolCalls: 1, history: { pin, reads: 1 } }), ContextCapacityError);
  }
  for (const budget of [{ toolCalls: 0, history: { pin, reads: 1 } }, { toolCalls: 1, history: { pin, reads: 0 } }, { toolCalls: 1 }]) {
    assert.throws(() => fitContext(body, capacity, 8192, budget), ContextCapacityError);
  }
});

test("all compacted references must fit remaining distinct read-back calls", () => {
  const capacity = { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 };
  const body = { instructions: "fixed facts", tools: [{ name: "read_skill_reference" }], input: ["one", "two"].flatMap(id => [
    { type: "function_call", name: "read_skill_reference", call_id: id, arguments: JSON.stringify({ skillId: "test-author", referenceId: id }) },
    { type: "function_call_output", call_id: id, output: JSON.stringify({ skillId: "test-author", referenceId: id, content: "x".repeat(6000) }) },
  ]).concat([{ type: "function_call_output", call_id: "last", output: "{}" }]) };
  assert.throws(() => fitContext(body, capacity, 8192), ContextCapacityError);
  assert.throws(() => fitContext(body, capacity, 8192, { toolCalls: 1 }), ContextCapacityError);
  assert.equal(fitContext(body, capacity, 8192, { toolCalls: 2 }).compacted, 2);
  body.input[2]!.arguments = body.input[0]!.arguments;
  body.input[3]!.output = body.input[1]!.output;
  assert.equal(fitContext(body, capacity, 8192, { toolCalls: 1 }).compacted, 2);
});
