import type { ModelRequestFailureStage } from "./module-diagnostics.js";
import type { AIConfig } from "../ai/config.js";
import type { ModelCapacity } from "../ai/capacity.js";
import type { HistoryPin } from "./history.js";
import type { FrozenAuthorSnapshot } from "./snapshot.js";
import type { ConversationMemory } from "./conversation-memory.js";
import type { ModuleCandidateStore } from "./module-candidate.js";
import { AuthorError } from "./types.js";
import { guardRequest, modelResponseFailureStage, outputTokenLimit, partialResult, requestSettings } from "./engine-policy.js";
import { ContextCapacityError, estimateInputTokens, fitContext } from "./engines/context.js";

export type EngineItem = Record<string, unknown>;
export interface EngineTool { name: string }
export interface EnginePartial {
  reason: "model_budget" | "tool_budget" | "context_capacity" | "output_truncated";
  nextStep: string;
  checkpoint?: { script: string };
}
export interface EngineResult { finalText: string; partial?: EnginePartial }
export interface EngineRun {
  instructions: string;
  context: EngineItem[];
  tools: EngineTool[];
  budget: { modelRequests: number; toolExecutions: number; maxOutputTokens?: number };
  model: Pick<AIConfig, "reasoningEffort">;
  capacity?: ModelCapacity;
  history?: HistoryPin;
  snapshot?: FrozenAuthorSnapshot;
  memory?: ConversationMemory;
  moduleCandidates?: ModuleCandidateStore;
  signal: AbortSignal;
  beforeRequest(context: EngineItem[]): EngineItem[];
  // Final serialized-body guard; called after SDK serialization and compaction.
  prepareRequest?(body: EngineItem): EngineItem;
  onEvent?(event: string): void;
  onModelRequestFailure?(stage: ModelRequestFailureStage): void;
  request(body: Record<string, unknown>): Promise<unknown>;
  execute(call: EngineItem, execution: number): Promise<unknown>;
  completeAfterTool?(call: EngineItem, result: unknown): string | undefined;
  checkpoint(): { script: string } | undefined;
  pendingWork?(): string | undefined;
  maxRequestBytes?: number;
  maxToolOutputBytes?: number;
}
export interface AgentEngine { run(input: EngineRun): Promise<EngineResult> }

// Local binding seam; definitions remain unchanged until the shared registry is fixed.
// Unregistered tools still pass through the harness's sanitized error path.
export function toolDispatcher(tools: EngineTool[], execute: EngineRun["execute"]): EngineRun["execute"] {
  const handlers = new Map<string, EngineRun["execute"]>();
  for (const tool of tools) {
    if (handlers.has(tool.name)) throw new AuthorError("invalid_input");
    handlers.set(tool.name, execute);
  }
  return (call, count) => (handlers.get(String(call.name)) ?? execute)(call, count);
}

// Preserve call IDs and reasoning items; only older browser snapshot payloads shrink.
export function pruneSnapshots(context: EngineItem[]): void {
  let latest = false;
  for (let i = context.length - 1; i >= 0; i--) {
    const item = context[i]!;
    if (item.type !== "function_call_output" || typeof item.output !== "string") continue;
    let value: any;
    try { value = JSON.parse(item.output); } catch { continue; }
    const page = value?.page ?? value;
    if (!page || typeof page.snapshot !== "string") continue;
    if (!latest) { latest = true; continue; }
    const summary = { url: page.url, selectorHints: page.selectorHints, snapshotCompacted: true };
    item.output = JSON.stringify(value?.page ? { ...value, page: summary } : summary);
  }
}

export const builtinEngine: AgentEngine = {
  async run(input) {
    const { signal, budget } = input;
    const maxOutputTokens = outputTokenLimit(input);
    const context = structuredClone(input.context);
    const execute = toolDispatcher(input.tools, input.execute);
    const invalidEnvelope = (raw: unknown): EngineResult => {
      const stage = modelResponseFailureStage(raw);
      try { input.onModelRequestFailure?.(stage); } catch { /* Evidence never changes engine semantics. */ }
      if (stage === "INCOMPLETE_MAX_OUTPUT_TOKENS" && !(raw as EngineItem).error && input.checkpoint()) return partialResult(input, "output_truncated");
      throw new AuthorError('invalid_response');
    };
    let count = 0, historyCalls = 0;
    const partial = (reason: EnginePartial["reason"]): EngineResult => partialResult(input, reason);
    for (let request = 0; request < budget.modelRequests; request++) {
      if (signal.aborted) throw new AuthorError("cancelled");
      pruneSnapshots(context);
      const settings = requestSettings(input, request, count);
      let body = {
        input: input.beforeRequest(context),
        ...settings,
        reasoning: { effort: input.model.reasoningEffort }, parallel_tool_calls: false,
        max_output_tokens: maxOutputTokens, store: false, include: ["reasoning.encrypted_content"],
      } as EngineItem;
      try {
        if (input.capacity) {
          const fit = fitContext(body, input.capacity, maxOutputTokens, { toolCalls: budget.toolExecutions - count, snapshot: input.snapshot, memory: input.memory, moduleCandidates: input.moduleCandidates,
            ...(input.history ? { history: { pin: input.history, reads: Math.max(0, 4 - historyCalls) } } : {}) });
          body = fit.body;
          if (fit.compacted) input.onEvent?.(`author:context:compacted:${fit.compacted}`);
        }
        body = guardRequest(input, body);
        if (input.capacity && estimateInputTokens(body) > Math.min(input.capacity.maxInputTokens, input.capacity.contextWindowTokens - maxOutputTokens - input.capacity.safetyTokens)) throw new ContextCapacityError();
      } catch (error) {
        if (error instanceof ContextCapacityError) return partial("context_capacity");
        throw error;
      }
      if (Buffer.byteLength(JSON.stringify(body)) > (input.maxRequestBytes ?? 4 * 1024 * 1024)) throw new AuthorError("limit");
      input.onEvent?.(`author:model:${request + 1}:started`);
      const raw = await input.request(body);
      if (signal.aborted) throw new AuthorError("cancelled");
      if (!raw || typeof raw !== "object") return invalidEnvelope(raw);
      const data = raw as EngineItem;
      if (data.status !== "completed" || data.error || !Array.isArray(data.output)) return invalidEnvelope(raw);
      const output = data.output as EngineItem[];
      if (output.some(item => !item || typeof item !== "object" || typeof item.type !== "string")) return invalidEnvelope(raw);
      input.onEvent?.(`author:model:${request + 1}:succeeded`);
      const calls = output.filter(item => item.type === "function_call");
      if (!calls.length) {
        const pending = input.pendingWork?.();
        if (pending) {
          if (request === budget.modelRequests - 1) return partial("model_budget");
          context.push(...output, { role: "user", content: `The verified checkpoint is explicitly unfinished. Complete the remaining work with a successful update_draft without nextStep; do not claim completion from final text alone. Remaining work (data): ${JSON.stringify(pending)}` });
          continue;
        }
        const text = typeof data.output_text === "string" ? data.output_text : output.flatMap(item => {
          if (item.type !== "message" || !Array.isArray(item.content)) return [];
          return item.content.filter((part: EngineItem) => part?.type === "output_text" && typeof part.text === "string").map((part: EngineItem) => part.text as string);
        }).join("\n");
        return { finalText: text.trim() };
      }
      if (!input.tools.length) throw new AuthorError("invalid_response");
      context.push(...output);
      for (const call of calls) {
        if (signal.aborted) throw new AuthorError("cancelled");
        if (count >= budget.toolExecutions) return partial("tool_budget");
        if (call.name === "read_conversation_history") historyCalls++;
        const result = await execute(call, ++count);
        const serialized = JSON.stringify(result);
        if (serialized === undefined || Buffer.byteLength(serialized) > (input.maxToolOutputBytes ?? 3 * 1024 * 1024)) throw new AuthorError("limit");
        context.push({ type: "function_call_output", call_id: call.call_id, output: serialized });
        if (signal.aborted) throw new AuthorError("cancelled");
        const completedText = input.completeAfterTool?.(call, result);
        if (completedText !== undefined) return { finalText: completedText };
      }
    }
    return partial("model_budget");
  },
};
