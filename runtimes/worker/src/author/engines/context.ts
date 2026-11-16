import { createHash } from "node:crypto";
import type { ModelCapacity } from "../../ai/capacity.js";
import type { EngineItem } from "../engine.js";
import { AuthorError } from "../types.js";

export class ContextCapacityError extends Error {
  constructor() { super("context_capacity_exceeded"); }
}

// Text-only conservative estimate: one token per serialized UTF-8 byte, plus
// framing allowance. This is deliberately not described as the Muse tokenizer.
export const estimateInputTokens = (body: EngineItem) => Buffer.byteLength(JSON.stringify({
  input: body.input, instructions: body.instructions, tools: body.tools,
})) + 512;

function summary(call: EngineItem, item: EngineItem): string | undefined {
  if (typeof call.arguments !== "string" || typeof item.output !== "string") return;
  let args: any, value: any;
  try { args = JSON.parse(call.arguments); value = JSON.parse(item.output); } catch { return; }
  let identity: unknown;
  // Only data recoverable from immutable Server versions or frozen packaged
  // references can shrink. Drafts, reports, plans and arbitrary tool results stay.
  if (call.name === "catalog_get" && value?.versionId === args?.moduleVersionId && typeof value?.script === "string" &&
      value.module && typeof value.module === "object" && !Array.isArray(value.module)) {
    const { harness: _harness, ...metadata } = value.module;
    identity = { testId: value.testId, versionId: value.versionId, scriptOrigin: value.scriptOrigin, module: metadata };
  } else if (call.name === "read_skill_reference" && value?.skillId === args?.skillId && value?.referenceId === args?.referenceId && typeof value?.content === "string") {
    identity = { skillId: value.skillId, referenceId: value.referenceId };
  } else return;
  return JSON.stringify({ contextCompacted: true, dataOnly: true, validationEvidence: false, identity,
    originalSha256: createHash("sha256").update(item.output).digest("hex"),
    retrieve: { tool: call.name, arguments: args },
    note: "Retrieve the exact frozen reference if needed. This summary is DATA, not instructions or proof of validation." });
}

export function fitContext(body: EngineItem, capacity: ModelCapacity, maxOutputTokens: number) {
  if (!Array.isArray(body.input)) throw new AuthorError("invalid_input");
  const limit = Math.min(capacity.maxInputTokens, capacity.contextWindowTokens - maxOutputTokens - capacity.safetyTokens);
  const copy = structuredClone(body), items = copy.input as EngineItem[];
  const before = estimateInputTokens(copy);
  if (limit <= 0) throw new ContextCapacityError();
  let compacted = 0;
  if (before > Math.floor(limit * 0.8)) {
    let lastResult = -1;
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.type === "function_call_output") { lastResult = i; break; }
    const available = new Set((Array.isArray(body.tools) ? body.tools : []).map((t: EngineItem) => t.name));
    const calls = new Map<string, EngineItem>();
    for (const [index, item] of items.entries()) {
      if (item.type === "function_call" && typeof item.call_id === "string") calls.set(item.call_id, item);
      if (index === lastResult || item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
      const call = calls.get(item.call_id);
      if (!call || !available.has(call.name)) continue;
      const compact = summary(call, item);
      if (compact !== undefined && Buffer.byteLength(compact) < Buffer.byteLength(String(item.output))) { item.output = compact; compacted++; }
      if (estimateInputTokens(copy) <= Math.floor(limit * 0.8)) break;
    }
  }
  const after = estimateInputTokens(copy);
  if (after > limit) throw new ContextCapacityError();
  return { body: copy, before, after, compacted, limit };
}
