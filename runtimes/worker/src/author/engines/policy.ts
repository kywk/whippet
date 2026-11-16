// Harness policy for the production Vercel adapter.
import type { AIConfig } from "../../ai/config.js";
import { modelCapacity } from "../../ai/capacity.js";
import { AuthorError } from "../types.js";
import { pruneSnapshots, type EngineItem, type EngineResult, type EngineRun } from "../engine.js";
import { loadToolRegistry, modelTool, validateToolArguments, validateToolResult, type ToolDefinition } from "../registry.js";
import { guardRequest, modelResponseFailureStage, outputTokenLimit, partialResult, requestSettings, withAbort } from "../engine-policy.js";
import { ContextCapacityError, estimateInputTokens, fitContext } from "./context.js";

export class AdapterPolicy {
  readonly definitions: ToolDefinition[];
  requests = 0;
  executions = 0;
  private historyCalls = 0;
  completedText: string | undefined;
  toolExhausted = false;
  failure: AuthorError | undefined;
  truncated = false;
  private readonly seen = new Set<string>();
  constructor(readonly input: EngineRun, readonly config: AIConfig) {
    outputTokenLimit(input);
    modelCapacity(config);
    if (config.reasoningEffort !== input.model.reasoningEffort || !config.enabled || !config.apiKey || !input.prepareRequest) throw new AuthorError("invalid_input");
    const registry = loadToolRegistry();
    this.definitions = input.tools.map(t => {
      const definition = registry.tools.find(d => d.name === t.name);
      if (!definition) throw new AuthorError("invalid_input");
      return definition;
    });
    if (new Set(input.tools.map(t => t.name)).size !== input.tools.length) throw new AuthorError("invalid_input");
    this.checkAbort();
  }
  checkAbort() { if (this.input.signal.aborted) throw new AuthorError("cancelled"); }
  fail(code: ConstructorParameters<typeof AuthorError>[0]): never {
    this.failure = new AuthorError(code); throw this.failure;
  }
  activeTools(): ToolDefinition[] {
    const active = new Set(requestSettings(this.input, this.requests, this.executions).tools.map(t => t.name));
    return this.definitions.filter(d => active.has(d.name));
  }
  prepare(raw: unknown): Record<string, any> {
    this.checkAbort();
    if (this.requests >= this.input.budget.modelRequests) this.fail("limit");
    const body = structuredClone(raw) as Record<string, any>;
    if (!body || !Array.isArray(body.input)) this.fail("invalid_input");
    // SDKs may encode instructions as developer/system messages. Keep one pinned copy.
    body.input = body.input.filter((i: EngineItem) => i.role !== "system" && i.role !== "developer");
    pruneSnapshots(body.input);
    body.instructions = requestSettings(this.input, this.requests, this.executions).instructions;
    body.tools = this.activeTools().map(modelTool);
    body.model = this.config.model;
    body.reasoning = { effort: this.config.reasoningEffort };
    body.max_output_tokens = this.input.budget.maxOutputTokens ?? 8192;
    body.parallel_tool_calls = false;
    body.store = false;
    body.include = ["reasoning.encrypted_content"];
    // Context preparation is separate from the final whole-body guard.
    let clean: Record<string, any> | undefined;
    try {
      body.input = this.input.beforeRequest(body.input);
      const fit = fitContext(body, modelCapacity(this.config), outputTokenLimit(this.input), { toolCalls: this.input.budget.toolExecutions - this.executions, snapshot: this.input.snapshot,
        ...(this.input.history ? { history: { pin: this.input.history, reads: Math.max(0, 4 - this.historyCalls) } } : {}) });
      clean = guardRequest(this.input, fit.body);
      if (fit.compacted) this.input.onEvent?.(`author:context:compacted:${fit.compacted}`);
    }
    catch (error) {
      if (error instanceof AuthorError) this.failure = error;
      throw error;
    }
    if (!clean || clean.model !== body.model || JSON.stringify(clean.reasoning) !== JSON.stringify(body.reasoning) ||
        clean.max_output_tokens !== body.max_output_tokens || JSON.stringify(clean.tools) !== JSON.stringify(body.tools) || clean.store !== false) this.fail("invalid_input");
    if (JSON.stringify(clean).includes(this.config.apiKey)) this.fail("sensitive_output");
    const capacity = modelCapacity(this.config);
    if (estimateInputTokens(clean) > Math.min(capacity.maxInputTokens, capacity.contextWindowTokens - outputTokenLimit(this.input) - capacity.safetyTokens)) throw new ContextCapacityError();
    if (Buffer.byteLength(JSON.stringify(clean)) > (this.input.maxRequestBytes ?? 4 * 1024 * 1024)) this.fail("limit");
    this.requests++;
    this.input.onEvent?.(`author:model:${this.requests}:started`);
    return clean;
  }
  accepted() { this.input.onEvent?.(`author:model:${this.requests}:succeeded`); }
  usage(input: unknown, output: unknown) {
    if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && Number(input) >= 0 && Number(output) >= 0)
      this.input.onEvent?.(`author:usage:${input}:${output}`);
  }
  validateCall(name: string, args: unknown) {
    const definition = this.definitions.find(d => d.name === name);
    if (!definition) this.fail("invalid_response");
    try { validateToolArguments(definition, args); } catch { this.fail("invalid_response"); }
  }
  validateEnvelope(raw: unknown) {
    const data = raw as Record<string, any>;
    if (!data || data.status !== "completed" || data.error || !Array.isArray(data.output)) {
      const stage = modelResponseFailureStage(raw);
      this.truncated = stage === "INCOMPLETE_MAX_OUTPUT_TOKENS" && !data?.error;
      try { this.input.onModelRequestFailure?.(stage); } catch { /* Diagnostics never change semantics. */ }
      this.fail("invalid_response");
    }
    if (JSON.stringify(raw).includes(this.config.apiKey)) this.fail("sensitive_output");
    for (const item of data.output) {
      if (!item || typeof item.type !== "string") this.fail("invalid_response");
      if (item.type === "function_call") {
        let args: unknown;
        try { args = JSON.parse(item.arguments); } catch { this.fail("invalid_response"); }
        this.validateCall(item.name, args);
      }
    }
  }
  async execute(name: string, id: string, args: unknown): Promise<unknown> {
    this.checkAbort();
    if (this.completedText !== undefined) return { stopped: true };
    if (this.executions >= this.input.budget.toolExecutions) { this.toolExhausted = true; return { budgetExhausted: true }; }
    if (!id || this.seen.has(id)) this.fail("invalid_response");
    this.validateCall(name, args);
    this.seen.add(id);
    if (name === "read_conversation_history") this.historyCalls++;
    const call = { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) };
    let result: unknown;
    try { result = await withAbort(this.input.execute(call, ++this.executions), this.input.signal); }
    catch (error) {
      // SDKs turn thrown tool errors into model-visible feedback. Keep that path fixed and safe.
      this.failure = error instanceof AuthorError ? error : new AuthorError("tool_failed");
      throw this.failure;
    }
    this.checkAbort();
    try { validateToolResult(this.definitions.find(d => d.name === name)!, result); } catch { this.fail("limit"); }
    if (Buffer.byteLength(JSON.stringify(result)) > (this.input.maxToolOutputBytes ?? 3 * 1024 * 1024)) this.fail("limit");
    if (JSON.stringify(result).includes(this.config.apiKey)) this.fail("sensitive_output");
    this.completedText = this.input.completeAfterTool?.(call, result);
    return result;
  }
  stop() { return this.completedText !== undefined || this.toolExhausted || this.requests >= this.input.budget.modelRequests || !!this.failure; }
  result(finalText: string, hasCalls: boolean): EngineResult {
    this.checkAbort();
    if (this.failure) throw this.failure;
    if (this.completedText !== undefined) return { finalText: this.completedText };
    if (this.toolExhausted || hasCalls || this.input.pendingWork?.()) {
      return partialResult(this.input, this.toolExhausted ? "tool_budget" : "model_budget");
    }
    return { finalText: finalText.trim() };
  }
}
