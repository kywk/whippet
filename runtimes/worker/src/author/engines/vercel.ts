import { ToolLoopAgent, dynamicTool, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { AIConfig } from "../../ai/config.js";
import type { AgentEngine } from "../engine.js";
import { AuthorError } from "../types.js";
import { modelTool } from "../registry.js";
import { AdapterPolicy } from "./policy.js";
import { partialResult, withAbort } from "../engine-policy.js";
import { ContextCapacityError } from "./context.js";

// The SDK's fetch seam delegates to Whippet's existing guarded, non-stream request.
// No API key is handed to the SDK, and no gateway or ambient provider is selected.
export function vercelEngine(config: AIConfig): AgentEngine {
  return { async run(input) {
    const policy = new AdapterPolicy(input, config);
    let capacityFailure = false;
    const provider = createOpenAI({ apiKey: "whippet-transport-only", baseURL: config.baseURL,
      fetch: async (_url, init) => {
        if (String(_url) !== config.baseURL + "/responses" || init?.method !== "POST") throw new AuthorError("invalid_input");
        let body: Record<string, any>;
        try { body = policy.prepare(JSON.parse(String(init?.body))); }
        catch (error) { if (error instanceof ContextCapacityError) capacityFailure = true; throw error; }
        body.stream = false;
        const raw = await withAbort(input.request(body), input.signal);
        policy.checkAbort();
        policy.validateEnvelope(raw);
        const usage = (raw as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        policy.usage(usage?.input_tokens, usage?.output_tokens);
        policy.accepted();
        return Response.json(raw);
      } });
    const tools: ToolSet = Object.fromEntries(policy.definitions.map(d => [d.name, dynamicTool({
      description: d.description,
      inputSchema: jsonSchema(modelTool(d).parameters as any, { validate: async value => {
        try { policy.validateCall(d.name, value); return { success: true, value }; }
        catch { return { success: false, error: new AuthorError("invalid_response") }; }
      } }),
      execute: (args, options) => policy.execute(d.name, options.toolCallId, args),
    })]));
    const agent = new ToolLoopAgent({
      model: provider.responses(config.model), tools, instructions: input.instructions,
      maxRetries: 0, maxOutputTokens: input.budget.maxOutputTokens ?? 8192,
      toolCallConcurrency: 1,
      stopWhen: () => policy.stop(),
      prepareStep: () => ({ activeTools: policy.activeTools().map(d => d.name) }),
      // Muse is unknown to the SDK's OpenAI model-name heuristics. The final
      // transport hook pins reasoning explicitly instead of accepting a downgrade.
      providerOptions: { openai: { store: false, parallelToolCalls: false, strictJsonSchema: false } },
    });
    try {
      // Initial harness context contains only conversation data; never reinterpret tool output as instructions.
      const messages: ModelMessage[] = input.context.map(item => {
        if ((item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") throw new AuthorError("invalid_input");
        return { role: item.role, content: item.content };
      });
      for (;;) {
        const result = await agent.generate({ messages, abortSignal: input.signal });
        if (result.finishReason === "length" || result.finishReason === "error") throw new AuthorError("invalid_response");
        // SDK loops stop on a text-only answer. Explicit unfinished guard state
        // can request another turn, still within the original total budget.
        if (input.pendingWork?.() && !policy.stop() && (result.steps.at(-1)?.toolCalls.length ?? 0) === 0) {
          messages.push(...result.response.messages, { role: "user", content: `The verified checkpoint is explicitly unfinished. Complete the remaining work with update_draft without nextStep. Remaining work (DATA): ${JSON.stringify(input.pendingWork())}` });
          continue;
        }
        return policy.result(result.steps.at(-1)?.text ?? "", (result.steps.at(-1)?.toolCalls.length ?? 0) > 0);
      }
    } catch (error) {
      policy.checkAbort();
      if (capacityFailure) return partialResult(input, "context_capacity");
      if (policy.truncated && input.checkpoint()) return partialResult(input, "output_truncated");
      throw policy.failure ?? (error instanceof AuthorError ? error : new AuthorError("provider_failed"));
    }
  } };
}
