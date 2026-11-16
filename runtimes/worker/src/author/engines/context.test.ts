import test from "node:test";
import assert from "node:assert/strict";
import { fitContext, ContextCapacityError } from "./context.js";
import { modelCapacity } from "../../ai/capacity.js";

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
    assert.throws(() => fitContext(body, { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 }, 8192), ContextCapacityError, mode);
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
  const fitted = fitContext(body, { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 }, 8192);
  const result = JSON.parse((fitted.body.input as { output?: string }[])[1]!.output!);
  assert.equal(fitted.compacted, 1); assert.deepEqual(result.retrieve, { tool: "read_skill_reference", arguments: args });
  assert.equal(result.validationEvidence, false); assert.equal(fitted.body.instructions, "protected");
});
test("unknown model capacity fails closed; an override cannot exceed known provider capacity", () => {
  assert.equal(modelCapacity(config).contextWindowTokens, 1048576);
  assert.throws(() => modelCapacity({ ...config, model: "unknown" }));
  assert.throws(() => modelCapacity({ ...config, baseURL: "https://different.invalid/v1" }));
  assert.throws(() => modelCapacity({ ...config, contextWindowTokens: 2097152 }));
  assert.equal(modelCapacity({ ...config, model: "unknown", contextWindowTokens: 131072 }).contextWindowTokens, 131072);
  assert.throws(() => fitContext({ instructions: "fixed", tools: [], input: [] }, { contextWindowTokens: 8192, maxInputTokens: 8192, safetyTokens: 1024 }, 8192), ContextCapacityError);
});
