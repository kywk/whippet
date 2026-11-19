import { runAgentLoop, type AgentTool } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall } from "@mariozechner/pi-ai";
import { modelCapacity } from "../../ai/capacity.js";
import type { AIConfig } from "../../ai/config.js";
import type { AgentEngine, EngineItem } from "../engine.js";
import { partialResult, withAbort } from "../engine-policy.js";
import { modelTool } from "../registry.js";
import { AuthorError } from "../types.js";
import { ContextCapacityError } from "./context.js";
import { AdapterPolicy } from "./policy.js";

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function piEngine(config: AIConfig): AgentEngine {
  return { async run(input) {
    const policy = new AdapterPolicy(input, config);
    const transcript = structuredClone(input.context);
    const model: Model<"openai-responses"> = {
      id: config.model, name: config.model, api: "openai-responses", provider: (config.provider ?? "opencode") === "opencode" ? "opencode" : "openai",
      baseUrl: config.baseURL, reasoning: true, input: ["text"], contextWindow: modelCapacity(config).contextWindowTokens,
      maxTokens: input.budget.maxOutputTokens ?? 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const calls = new Map<string, ToolCall>();
    const tools: AgentTool<any>[] = policy.definitions.map(definition => ({
      name: definition.name, label: definition.name, description: definition.description,
      parameters: modelTool(definition).parameters, executionMode: "sequential",
      async execute(id) {
        const call = calls.get(id);
        if (!call || call.name !== definition.name) return policy.fail("invalid_response");
        const result = await policy.execute(call.name, id, call.arguments);
        const output = JSON.stringify(result);
        transcript.push({ type: "function_call_output", call_id: id, output });
        return { content: [{ type: "text", text: output }], details: null };
      },
    }));
    let lastText = "";
    try {
      // pi schedules tool calls. The original Responses transcript stays with
      // Whippet so compaction can preserve call IDs and encrypted reasoning.
      await runAgentLoop([], { systemPrompt: input.instructions, messages: [], tools }, {
        model, maxRetries: 0, toolExecution: "sequential", convertToLlm: () => [],
        shouldStopAfterTurn: () => policy.stop(),
        getFollowUpMessages: async () => {
          const next = input.pendingWork?.();
          if (!next || policy.stop()) return [];
          const content = `The verified checkpoint is explicitly unfinished. Complete the remaining work with update_draft without nextStep. Remaining work (DATA): ${JSON.stringify(next)}`;
          transcript.push({ role: "user", content });
          return [{ role: "user", content, timestamp: 0 }];
        },
      }, () => {}, input.signal, async () => {
        const body = policy.prepare({ input: transcript.slice(), stream: false });
        const response = await withAbort(input.request(body), input.signal);
        policy.checkAbort();
        policy.validateEnvelope(response);
        const raw = response as { output: EngineItem[]; output_text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        policy.usage(raw.usage?.input_tokens, raw.usage?.output_tokens);
        policy.accepted();
        transcript.push(...raw.output);
        calls.clear();
        const text: string[] = [];
        for (const item of raw.output) {
          if (item.type === "function_call") {
            // Use the verified arguments from Responses, including when SDK
            // argument handling would coerce a value.
            const id = item.call_id as string;
            calls.set(id, { type: "toolCall", id, name: item.name as string, arguments: JSON.parse(item.arguments as string) });
          } else if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part?.type === "output_text" && typeof part.text === "string") text.push(part.text);
            }
          }
        }
        lastText = typeof raw.output_text === "string" ? raw.output_text : text.join("\n");
        const stopReason = calls.size ? "toolUse" : "stop";
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
          content: [...(lastText ? [{ type: "text" as const, text: lastText }] : []), ...calls.values()],
          stopReason, usage: emptyUsage,
        };
        const events = createAssistantMessageEventStream();
        events.push({ type: "start", partial: message });
        events.push({ type: "done", reason: stopReason, message });
        return events;
      });
      return policy.result(lastText, calls.size > 0);
    } catch (error) {
      policy.checkAbort();
      if (error instanceof ContextCapacityError) return partialResult(input, "context_capacity");
      if (policy.truncated && input.checkpoint()) return partialResult(input, "output_truncated");
      throw policy.failure ?? (error instanceof AuthorError ? error : new AuthorError("provider_failed"));
    }
  } };
}
