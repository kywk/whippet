import { ToolLoopAgent, dynamicTool, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { AIConfig } from "../../ai/config.js";
import type { AgentEngine } from "../engine.js";
import { AuthorError } from "../types.js";
import { modelTool } from "../registry.js";
import { SpikePolicy } from "./policy.js";

// The SDK's fetch seam delegates to Whippet's existing guarded, non-stream request.
// No API key is handed to the SDK, and no gateway or ambient provider is selected.
export function vercelSpikeEngine(config: AIConfig): AgentEngine {
  return { async run(input) {
    const policy = new SpikePolicy(input, config);
    const provider = createOpenAI({ apiKey: "whippet-transport-only", baseURL: config.baseURL,
      fetch: async (_url, init) => {
        const body = policy.prepare(JSON.parse(String(init?.body)));
        body.stream = false;
        const raw = await input.request(body);
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
      const result = await agent.generate({ messages, abortSignal: input.signal });
      if (result.finishReason === "length" || result.finishReason === "error") throw new AuthorError("invalid_response");
      // v7 aggregates toolCalls across all steps; completion uses the final step.
      return policy.result(result.text, (result.steps.at(-1)?.toolCalls.length ?? 0) > 0);
    } catch (error) {
      policy.checkAbort();
      throw policy.failure ?? (error instanceof AuthorError ? error : new AuthorError("provider_failed"));
    }
  } };
}
