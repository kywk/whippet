import { AI_DEFAULTS, AIError, type AIConfig } from "./config.js";

export interface CodingRequest {
  sessionId: string;
  input: string;
}

export const PROBE_PROMPT = [
  "You are a coding agent preparing a Playwright TypeScript test for Whippet.",
  "Return one complete spec importing test and expect from '@playwright/test'.",
  "Use page.setContent('<main><h1>Whippet synthetic probe</h1></main>') and assert the heading text.",
  "Use only the synthetic local HTML above. Do not browse, call tools, read files, or contact external websites.",
  "Return only the TypeScript code. This checks coding output; the code will not be executed automatically.",
].join("\n");

// The caller owns the conversation identity. There is deliberately no random
// session fallback, SDK state, account configuration, or provider failover.
export function buildResponsesRequest(config: AIConfig, request: CodingRequest) {
  if (!config.enabled) throw new AIError("disabled");
  if (config.apiKey === "") throw new AIError("missing_key");
  if (typeof request.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.sessionId)) throw new AIError("invalid_session");
  if (typeof request.input !== "string" || request.input.trim() === "") throw new AIError("invalid_input");
  return {
    url: `${config.baseURL}/responses`,
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": AI_DEFAULTS.userAgent,
        "x-opencode-session": request.sessionId,
      },
      body: JSON.stringify({
        model: config.model,
        input: request.input,
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: 4096,
        stream: false,
      }),
    } satisfies RequestInit,
  };
}

export interface CodingResponse {
  status: "completed";
  text: string;
}

// Native fetch is the only transport dependency and can be replaced in tests.
// Exactly one POST is attempted; redirects, retries and payg fallback are absent.
export async function requestCodingResponse(
  config: AIConfig,
  request: CodingRequest,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CodingResponse> {
  const prepared = buildResponsesRequest(config, request);
  const signal = AbortSignal.timeout(120000);
  let response: Response;
  try {
    response = await fetcher(prepared.url, { ...prepared.init, signal });
  } catch {
    throw new AIError(signal.aborted ? "timeout" : "network_error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
      : response.status === 429 ? "rate_limited" : "http_error";
    throw new AIError(code, response.status);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new AIError("invalid_response"); }
  if (typeof body !== "object" || body === null) throw new AIError("invalid_response");
  const data = body as { status?: unknown; error?: unknown; output_text?: unknown; output?: unknown };
  if (data.status === "incomplete") throw new AIError("incomplete_response");
  if (data.error || data.status !== "completed") throw new AIError("provider_failed");
  const parts: string[] = [];
  if (typeof data.output_text === "string") {
    parts.push(data.output_text);
  } else if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (typeof item !== "object" || item === null || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content === "object" && content !== null && content.type === "output_text" && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }
  }
  const text = parts.join("\n");
  if (text.trim() === "") throw new AIError("empty_response");
  return { status: "completed", text };
}
