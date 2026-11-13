import type { ModelRequestFailureStage } from "./module-diagnostics.js";
import type { AIConfig } from "../ai/config.js";
import { AuthorError } from "./types.js";

export type EngineItem = Record<string, unknown>;
export interface EngineTool { name: string }
export interface EnginePartial {
  reason: "model_budget" | "tool_budget";
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
  signal: AbortSignal;
  beforeRequest(context: EngineItem[]): EngineItem[];
  onEvent?(event: string): void;
  onModelRequestFailure?(stage: ModelRequestFailureStage): void;
  request(body: Record<string, unknown>): Promise<unknown>;
  execute(call: EngineItem, execution: number): Promise<unknown>;
  checkpoint(): { script: string } | undefined;
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
    if (!Number.isInteger(budget.modelRequests) || budget.modelRequests < 1 || !Number.isInteger(budget.toolExecutions) || budget.toolExecutions < 0) throw new AuthorError("invalid_input");
    const maxOutputTokens = budget.maxOutputTokens === undefined ? 8192 : budget.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) throw new AuthorError('invalid_input');
    const context = structuredClone(input.context);
    const execute = toolDispatcher(input.tools, input.execute);
    const invalidEnvelope = (raw: unknown): never => {
      // Only exact structural values enter diagnostics; no provider text is retained.
      let stage: ModelRequestFailureStage = 'ENVELOPE_INVALID';
      if (raw && typeof raw === 'object' && (raw as EngineItem).status === 'incomplete') {
        const details = (raw as EngineItem).incomplete_details;
        const reason = details && typeof details === 'object' && !Array.isArray(details) ? (details as EngineItem).reason : undefined;
        stage = reason === 'max_output_tokens' ? 'INCOMPLETE_MAX_OUTPUT_TOKENS' : reason === 'content_filter' ? 'INCOMPLETE_CONTENT_FILTER' : 'INCOMPLETE_UNKNOWN';
      }
      try { input.onModelRequestFailure?.(stage); } catch { /* Evidence never changes engine semantics. */ }
      throw new AuthorError('invalid_response');
    };
    let count = 0;
    const partial = (reason: EnginePartial["reason"]): EngineResult => {
      const checkpoint = input.checkpoint();
      return { finalText: "", partial: {
        reason, nextStep: "繼續目前任務，先檢查最後通過自我試跑的候選稿，再完成剩餘驗證。",
        ...(checkpoint ? { checkpoint } : {}),
      } };
    };
    for (let request = 0; request < budget.modelRequests; request++) {
      if (signal.aborted) throw new AuthorError("cancelled");
      pruneSnapshots(context);
      const finish = request === budget.modelRequests - 1 || budget.toolExecutions - count <= 2;
      const body = {
        input: input.beforeRequest(context),
        instructions: input.instructions + (finish ? "\nBudget nearly exhausted: finish now with the verified candidate and explain remaining next steps. Do not start new exploration." : ""),
        tools: input.tools, reasoning: { effort: input.model.reasoningEffort }, parallel_tool_calls: false,
        max_output_tokens: maxOutputTokens, store: false, include: ["reasoning.encrypted_content"],
      };
      if (Buffer.byteLength(JSON.stringify(body)) > (input.maxRequestBytes ?? 4 * 1024 * 1024)) throw new AuthorError("limit");
      input.onEvent?.(`author:model:${request + 1}:started`);
      const raw = await input.request(body);
      if (signal.aborted) throw new AuthorError("cancelled");
      if (!raw || typeof raw !== "object") invalidEnvelope(raw);
      const data = raw as EngineItem;
      if (data.status !== "completed" || data.error || !Array.isArray(data.output)) invalidEnvelope(raw);
      const output = data.output as EngineItem[];
      if (output.some(item => !item || typeof item !== "object" || typeof item.type !== "string")) invalidEnvelope(raw);
      input.onEvent?.(`author:model:${request + 1}:succeeded`);
      const calls = output.filter(item => item.type === "function_call");
      if (!calls.length) {
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
        const result = await execute(call, ++count);
        const serialized = JSON.stringify(result);
        if (serialized === undefined || Buffer.byteLength(serialized) > (input.maxToolOutputBytes ?? 3 * 1024 * 1024)) throw new AuthorError("limit");
        context.push({ type: "function_call_output", call_id: call.call_id, output: serialized });
      }
    }
    return partial("model_budget");
  },
};
