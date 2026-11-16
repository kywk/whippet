import { runAgentLoop, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { type Model, type Message, type AssistantMessage } from "@mariozechner/pi-ai";
import { streamOpenAIResponses } from "@mariozechner/pi-ai/openai-responses";
import type { AIConfig } from "../../ai/config.js";
import type { AgentEngine } from "../engine.js";
import { AuthorError } from "../types.js";
import { modelTool } from "../registry.js";
import { SpikePolicy } from "./policy.js";

// Native pi-ai transport: intentionally isolated to the spike, not production-selected.
// Unlike Vercel, this provider requires SSE and cannot reuse EngineRun.request as-is.
export function piSpikeEngine(config: AIConfig, sessionId: string): AgentEngine {
  return { async run(input) {
    const policy = new SpikePolicy(input, config);
    const model: Model<"openai-responses"> = {
      id: config.model, name: config.model, api: "openai-responses", provider: "opencode",
      // pi requires this metadata field. Zero means unknown here; the spike does
      // not estimate or claim Muse context capacity (M12.1 must supply evidence).
      baseUrl: config.baseURL, reasoning: true, input: ["text"], contextWindow: 0, maxTokens: input.budget.maxOutputTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      headers: { "x-opencode-session": sessionId, "User-Agent": "whippet-worker/0.1" },
    };
    const tools: AgentTool<any>[] = policy.definitions.map(d => ({
      name: d.name, label: d.name, description: d.description, parameters: modelTool(d).parameters,
      executionMode: "sequential", execute: async (id, args) => {
        const result = await policy.execute(d.name, id, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: null, terminate: policy.stop() };
      },
    }));
    const messages: AgentMessage[] = input.context.map(item => {
      if ((item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") throw new AuthorError("invalid_input");
      if (item.role === "user") return { role: "user", content: item.content, timestamp: 0 };
      return { role: "assistant", content: [{ type: "text", text: item.content }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: "stop", timestamp: 0 };
    });
    let last: AssistantMessage | undefined;
    const rawArguments = new Map<number, string>();
    const transport = new AbortController();
    try {
      await runAgentLoop([], { systemPrompt: input.instructions, messages, tools }, {
        model, apiKey: config.apiKey, reasoning: config.reasoningEffort, maxTokens: input.budget.maxOutputTokens ?? 8192,
        cacheRetention: "none", maxRetries: 0, toolExecution: "sequential",
        convertToLlm: items => items as Message[],
        shouldStopAfterTurn: () => policy.stop(),
      }, async event => {
        if (event.type === "message_start" && event.message.role === "assistant") rawArguments.clear();
        if (event.type === "message_update") {
          const e = event.assistantMessageEvent;
          if (e.type === "toolcall_delta") rawArguments.set(e.contentIndex, (rawArguments.get(e.contentIndex) ?? "") + e.delta);
          if (e.type === "toolcall_end") {
            let args: unknown;
            // pi's partial-json parser is permissive. Validate the exact full delta before any coercion/execution.
            try { args = JSON.parse(rawArguments.get(e.contentIndex) ?? ""); } catch { policy.fail("invalid_response"); }
            policy.validateCall(e.toolCall.name, args);
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          last = event.message;
          if (last.stopReason === "length" || last.stopReason === "error") policy.fail("invalid_response");
          if (JSON.stringify(last).includes(config.apiKey)) policy.fail("sensitive_output");
          policy.checkAbort();
          policy.usage(last.usage.input + last.usage.cacheRead, last.usage.output);
          for (const part of last.content) if (part.type === "toolCall") policy.validateCall(part.name, part.arguments);
          policy.accepted();
        }
      }, AbortSignal.any([input.signal, transport.signal]), (m, context, options) => streamOpenAIResponses(m as Model<"openai-responses">, context, {
        ...options, reasoningEffort: config.reasoningEffort, maxRetries: 0,
        onPayload: raw => policy.prepare(raw),
      }));
      return policy.result(last?.content.filter(p => p.type === "text").map(p => p.text).join("\n") ?? "", last?.content.some(p => p.type === "toolCall") ?? false);
    } catch (error) {
      policy.checkAbort();
      throw policy.failure ?? (error instanceof AuthorError ? error : new AuthorError("provider_failed"));
    } finally { transport.abort(); }
  } };
}
