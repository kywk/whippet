// M12.0 only. The control plane and Worker guards remain authoritative.
import type { AIConfig } from "../../ai/config.js";
import { AuthorError } from "../types.js";
import { pruneSnapshots, type EngineItem, type EngineResult, type EngineRun } from "../engine.js";
import { loadToolRegistry, modelTool, validateToolArguments, validateToolResult, type ToolDefinition } from "../registry.js";

export class SpikePolicy {
  readonly definitions: ToolDefinition[];
  requests = 0;
  executions = 0;
  completedText: string | undefined;
  toolExhausted = false;
  failure: AuthorError | undefined;
  private readonly seen = new Set<string>();
  constructor(readonly input: EngineRun, readonly config: AIConfig) {
    const b = input.budget;
    if (!Number.isSafeInteger(b.modelRequests) || b.modelRequests < 1 || !Number.isSafeInteger(b.toolExecutions) || b.toolExecutions < 0 ||
        !Number.isSafeInteger(b.maxOutputTokens ?? 8192) || (b.maxOutputTokens ?? 8192) < 1 || (b.maxOutputTokens ?? 8192) > 16384 ||
        config.reasoningEffort !== input.model.reasoningEffort || !config.enabled || !config.apiKey) throw new AuthorError("invalid_input");
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
    const remaining = this.input.budget.modelRequests - this.requests;
    const names = this.definitions.map(d => d.name);
    const delivery = names.includes("update_draft") ? ["update_draft"] : names.includes("propose_plan") ? ["propose_plan"] :
      names.includes("commit_module_candidate") ? ["stage_module_candidate_part", "commit_module_candidate"] : [];
    return delivery.length && !this.input.checkpoint() && remaining <= (delivery.includes("commit_module_candidate") ? 5 : 3)
      ? this.definitions.filter(d => delivery.includes(d.name)) : this.definitions;
  }
  prepare(raw: unknown): Record<string, any> {
    this.checkAbort();
    if (this.requests >= this.input.budget.modelRequests) this.fail("limit");
    const body = structuredClone(raw) as Record<string, any>;
    if (!body || !Array.isArray(body.input)) this.fail("invalid_input");
    // SDKs may encode instructions as developer/system messages. Keep one pinned copy.
    body.input = body.input.filter((i: EngineItem) => i.role !== "system" && i.role !== "developer");
    pruneSnapshots(body.input);
    const remaining = this.input.budget.modelRequests - this.requests;
    const active = this.activeTools();
    const reserve = active.length < this.definitions.length ? `\nCandidate delivery reserve: ${remaining} model requests remaining. Deliver with ${active.map(t => t.name).join(", ")}; preserve assertions and inspect self-test feedback.` : "";
    body.instructions = this.input.instructions + reserve + (remaining === 1 || this.input.budget.toolExecutions - this.executions <= 2
      ? "\nBudget nearly exhausted: finish now with the verified candidate and explain remaining next steps. Do not start new exploration." : "");
    body.tools = active.map(modelTool);
    body.model = this.config.model;
    body.reasoning = { effort: this.config.reasoningEffort };
    body.max_output_tokens = this.input.budget.maxOutputTokens ?? 8192;
    body.parallel_tool_calls = false;
    body.store = false;
    body.include = ["reasoning.encrypted_content"];
    // The spike hook sees the complete serialized body, including instructions/tools.
    let clean: Record<string, any> | undefined;
    try { clean = this.input.beforeRequest([body])[0]; }
    catch (error) {
      this.failure = error instanceof AuthorError ? error : new AuthorError("sensitive_output");
      throw this.failure;
    }
    if (!clean || clean.model !== body.model || JSON.stringify(clean.reasoning) !== JSON.stringify(body.reasoning) ||
        clean.max_output_tokens !== body.max_output_tokens || JSON.stringify(clean.tools) !== JSON.stringify(body.tools) || clean.store !== false) this.fail("invalid_input");
    if (JSON.stringify(clean).includes(this.config.apiKey)) this.fail("sensitive_output");
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
      this.input.onModelRequestFailure?.(data?.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens" ? "INCOMPLETE_MAX_OUTPUT_TOKENS" : "ENVELOPE_INVALID");
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
    const call = { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) };
    let result: unknown;
    try { result = await this.input.execute(call, ++this.executions); }
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
      const checkpoint = this.input.checkpoint();
      return { finalText: "", partial: { reason: this.toolExhausted ? "tool_budget" : "model_budget",
        nextStep: this.input.pendingWork?.() ?? (checkpoint ? "檢查最後通過自我試跑的候選稿，完成剩餘工作與正式驗證。" : "目前沒有通過自我試跑的候選稿；先補齊必要證據再交付。"),
        ...(checkpoint ? { checkpoint } : {}) } };
    }
    return { finalText: finalText.trim() };
  }
}
