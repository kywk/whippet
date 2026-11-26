import { AIError, type AIConfig } from "../ai/config.js";
import { buildResponsesRequest } from "../ai/responses.js";
import { selectAgentEngine } from "./engines/select.js";
import { withAbort } from "./engine-policy.js";
import { containsModelKey, modelOperationID } from "./model-key.js";
import { AuthorError } from "./types.js";

export type ProbeOutcome = "passed" | "provider_auth_failed" | "provider_unavailable" | "probe_failed";

async function readProbeResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new AuthorError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal).catch(() => { throw new AIError("network_error"); });
      if (done) break;
      size += value.length;
      if (size > 128 * 1024) throw new AuthorError("invalid_response");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function runModelProbe(config: AIConfig, id: string, options: { signal?: AbortSignal; fetcher?: typeof fetch; guard?: (value: unknown) => void } = {}): Promise<ProbeOutcome> {
  if (!modelOperationID.test(id)) return "probe_failed";
  const timeout = AbortSignal.timeout(30000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const challenge = `WHIPPET_PROBE:${id}`;
  const instructions = "Return exactly the challenge in the user message. Output only the challenge, without quotes or formatting.";
  let calls = 0;
  let failure: ProbeOutcome = "probe_failed";
  const guard = (value: unknown) => {
    const serialized = JSON.stringify(value) ?? "";
    if (containsModelKey(serialized, config.apiKey)) throw new AuthorError("sensitive_output");
    options.guard?.(value);
  };
  try {
    const output = await withAbort(selectAgentEngine(config).run({
      instructions, context: [{ role: "user", content: challenge }], tools: [],
      budget: { modelRequests: 1, toolExecutions: 0, maxOutputTokens: 128 }, model: config, signal,
      beforeRequest: value => { guard(value); return value; },
      prepareRequest: body => { const fixed = { ...body, instructions }; guard(fixed); return fixed; },
      checkpoint: () => undefined,
      execute: async () => { throw new AuthorError("invalid_response"); },
      request: async body => {
        signal.throwIfAborted();
        if (++calls !== 1 || body.max_output_tokens !== 128 || !Array.isArray(body.tools) || body.tools.length !== 0) throw new AuthorError("invalid_input");
        const prepared = buildResponsesRequest(config, { sessionId: id, input: challenge });
        const outgoing = { ...JSON.parse(prepared.init.body), ...body, model: config.model, stream: false };
        guard(outgoing);
        let response: Response;
        try {
          response = await withAbort((options.fetcher ?? fetch)(prepared.url, { ...prepared.init, body: JSON.stringify(outgoing), signal }), signal);
        } catch {
          failure = "provider_unavailable";
          throw new AuthorError("provider_failed");
        }
        if (!response.ok) {
          failure = response.status === 401 || response.status === 403 ? "provider_auth_failed" : "provider_unavailable";
          void response.body?.cancel().catch(() => undefined);
          throw new AuthorError("provider_failed");
        }
        const value = await readProbeResponse(response, signal).catch((error: unknown) => {
          if (error instanceof AIError && error.code === "network_error") failure = "provider_unavailable";
          throw error;
        });
        guard(value);
        const reply = value as { output?: { type?: string }[]; usage?: { output_tokens?: number } } | null;
        if (!Array.isArray(reply?.output) || reply.output.some(item => item?.type !== "message" && item?.type !== "reasoning") ||
          (reply.usage?.output_tokens ?? 0) > 128) throw new AuthorError("invalid_response");
        return value;
      },
    }), signal);
    return calls === 1 && !signal.aborted && !output.partial && output.finalText.trim() === challenge ? "passed" : "probe_failed";
  } catch {
    return failure;
  }
}
