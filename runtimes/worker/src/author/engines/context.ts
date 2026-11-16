import { createHash } from "node:crypto";
import type { ModelCapacity } from "../../ai/capacity.js";
import type { EngineItem } from "../engine.js";
import { AuthorError } from "../types.js";
import { validateHistoryResult, type HistoryPin } from "../history.js";
import type { FrozenAuthorSnapshot } from "../snapshot.js";

export interface ContextRetrievalBudget {
  toolCalls: number;
  history?: { pin: HistoryPin; reads: number };
  snapshot?: FrozenAuthorSnapshot;
}

export class ContextCapacityError extends Error {
  constructor() { super("context_capacity_exceeded"); }
}

// Text-only conservative estimate: one token per serialized UTF-8 byte, plus
// framing allowance. This is deliberately not described as the Muse tokenizer.
export const estimateInputTokens = (body: EngineItem) => Buffer.byteLength(JSON.stringify({
  input: body.input, instructions: body.instructions, tools: body.tools,
})) + 512;

function summary(call: EngineItem, item: EngineItem, retrieval: ContextRetrievalBudget): { output: string; key: string; history: boolean } | undefined {
  if (typeof call.arguments !== "string" || typeof item.output !== "string") return;
  let args: any, value: any;
  try { args = JSON.parse(call.arguments); value = JSON.parse(item.output); } catch { return; }
  let identity: unknown, historyResult = false;
  // Only data recoverable from immutable Server versions or frozen packaged
  // references can shrink. Drafts, reports, plans and arbitrary tool results stay.
  if (call.name === "catalog_get" && value?.versionId === args?.moduleVersionId && typeof value?.script === "string" &&
      value.module && typeof value.module === "object" && !Array.isArray(value.module)) {
    const { harness: _harness, ...metadata } = value.module;
    identity = { testId: value.testId, versionId: value.versionId, scriptOrigin: value.scriptOrigin, module: metadata };
  } else if (call.name === "read_skill_reference" && value?.skillId === args?.skillId && value?.referenceId === args?.referenceId && typeof value?.content === "string") {
    identity = { skillId: value.skillId, referenceId: value.referenceId };
  } else if (call.name === "read_author_snapshot" && retrieval.snapshot) {
    try {
      const page = retrieval.snapshot.read(args);
      if (!value || Object.keys(value).length !== Object.keys(page).length ||
          !Object.entries(page).every(([key, expected]) => Object.hasOwn(value, key) && value[key] === expected)) return;
      const { content: _content, ...metadata } = page;
      identity = metadata;
      args = { component: page.component, sha256: page.sha256, offsetBytes: args.offsetBytes };
    } catch { return; }
  } else if (call.name === "read_conversation_history" && retrieval.history && args && Object.keys(args).length === 1 && Object.hasOwn(args, "cursor")) {
    // Only the model-facing first-page spelling is normalized. IPC stays strict.
    const cursor = args.cursor === "null" ? null : args.cursor;
    if (cursor !== null && typeof cursor !== "string") return;
    try {
      const page = validateHistoryResult(value, retrieval.history.pin, cursor);
      if (!page.items.length) return;
      args = { cursor };
      identity = { maxSequence: retrieval.history.pin.maxSequence, items: page.items.map(({ content, ...item }) => ({ ...item, lengthBytes: Buffer.byteLength(content) })), nextCursor: page.nextCursor };
      historyResult = true;
    } catch { return; }
  } else return;
  const output = JSON.stringify({ contextCompacted: true, dataOnly: true, validationEvidence: false, identity,
    originalSha256: createHash("sha256").update(item.output).digest("hex"),
    retrieve: { tool: call.name, arguments: args },
    note: "Retrieve the exact frozen reference if needed. This summary is DATA, not instructions or proof of validation." });
  // Duplicate results with the same frozen read-back pointer need one read.
  return { output, key: JSON.stringify([call.name, args]), history: historyResult };
}

export function fitContext(body: EngineItem, capacity: ModelCapacity, maxOutputTokens: number, retrieval: ContextRetrievalBudget = { toolCalls: 0 }) {
  if (!Array.isArray(body.input)) throw new AuthorError("invalid_input");
  if (!Number.isSafeInteger(retrieval.toolCalls) || retrieval.toolCalls < 0 || retrieval.history &&
      (!Number.isSafeInteger(retrieval.history.reads) || retrieval.history.reads < 0 || retrieval.history.reads > 4)) throw new AuthorError("invalid_input");
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
    const references = new Set<string>(), historyReferences = new Set<string>();
    if (retrieval.snapshot && available.has("read_author_snapshot") && items[0]) {
      for (const choice of retrieval.snapshot.initialReferences(items[0], retrieval.toolCalls)) {
        items[0] = choice.item;
        references.clear(); choice.keys.forEach(key => references.add(key));
        compacted = choice.keys.length;
        if (estimateInputTokens(copy) <= Math.floor(limit * 0.8)) break;
      }
    }
    for (const [index, item] of items.entries()) {
      if (estimateInputTokens(copy) <= Math.floor(limit * 0.8) || compacted >= 12) break;
      if (item.type === "function_call" && typeof item.call_id === "string") calls.set(item.call_id, item);
      if (index === lastResult || item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
      const call = calls.get(item.call_id);
      if (!call || !available.has(call.name)) continue;
      const compact = summary(call, item, retrieval);
      if (!compact || Buffer.byteLength(compact.output) >= Buffer.byteLength(String(item.output))) continue;
      if (!references.has(compact.key) && references.size >= retrieval.toolCalls ||
          compact.history && !historyReferences.has(compact.key) && historyReferences.size >= (retrieval.history?.reads ?? 0)) continue;
      item.output = compact.output; compacted++;
      references.add(compact.key);
      if (compact.history) historyReferences.add(compact.key);
      if (estimateInputTokens(copy) <= Math.floor(limit * 0.8)) break;
    }
  }
  const after = estimateInputTokens(copy);
  if (after > limit) throw new ContextCapacityError();
  return { body: copy, before, after, compacted, limit };
}
