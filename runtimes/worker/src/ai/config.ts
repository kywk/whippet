export const AI_DEFAULTS = {
  baseURL: "https://opencode.ai/inference/go/openai/v1",
  model: "muse-spark-1.3-contributor",
  reasoningEffort: "xhigh",
  userAgent: "whippet-worker/0.1",
} as const;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface AIConfig {
  enabled: boolean;
  baseURL: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
}

export type AIErrorCode =
  | "invalid_config" | "disabled" | "missing_key" | "invalid_session"
  | "invalid_input" | "live_required" | "invalid_arguments"
  | "unauthorized" | "forbidden" | "rate_limited" | "http_error"
  | "network_error" | "timeout" | "invalid_response" | "provider_failed"
  | "incomplete_response" | "empty_response" | "internal_error";

const errorMessages: Record<AIErrorCode, string> = {
  invalid_config: "AI 設定無效；請核對 HTTPS base URL、model、reasoning effort 與啟用值。",
  disabled: "AI 尚未明確啟用；需要 WHIPPET_AI_ENABLED=true。",
  missing_key: "OPENCODE_API_KEY 尚未設定。",
  invalid_session: "需要由呼叫者提供固定 session ID（1..128 個英數字、點、底線、冒號或連字號）。",
  invalid_input: "Responses 輸入必須是非空文字。",
  live_required: "probe 需要明確指定 --live；本次未發送請求。",
  invalid_arguments: "只接受 check，或 probe --live --session=<id>。",
  unauthorized: "HTTP 401：API key 未獲授權；不重試、不切換端點。",
  forbidden: "HTTP 403：請檢查訂閱資格、地區與 Contributor 隱私權設定；不重試。",
  rate_limited: "HTTP 429：請求受限或訂閱額度不足；不重試、不改用 pay-as-you-go。",
  http_error: "模型服務回傳非成功 HTTP 狀態；不重試、不切換端點。",
  network_error: "模型服務連線失敗；未自動重試。",
  timeout: "模型請求逾時；未自動重試，服務端可能已收到本次請求。",
  invalid_response: "模型服務回傳格式無效。",
  provider_failed: "Responses 回應未成功完成。",
  incomplete_response: "Responses 回應不完整；不追加請求。",
  empty_response: "Responses 已完成但沒有可用的文字輸出。",
  internal_error: "AI 指令執行失敗；已隱藏底層錯誤內容。",
};

// Only these fixed messages may reach CLI output. Never include raw errors,
// provider bodies, headers, URLs supplied by users, or credentials in errors.
export class AIError extends Error {
  constructor(readonly code: AIErrorCode, readonly httpStatus?: number) {
    super(errorMessages[code]);
    this.name = "AIError";
  }
}

export function readAIConfig(env: Readonly<Record<string, string | undefined>>): AIConfig {
  const enabled = env.WHIPPET_AI_ENABLED ?? "false";
  const baseURL = env.WHIPPET_AI_BASE_URL ?? AI_DEFAULTS.baseURL;
  const model = env.WHIPPET_AI_MODEL ?? AI_DEFAULTS.model;
  const effort = env.WHIPPET_AI_REASONING_EFFORT ?? AI_DEFAULTS.reasoningEffort;
  const apiKey = env.OPENCODE_API_KEY?.trim() ?? "";
  let parsed: URL;
  try { parsed = new URL(baseURL); } catch { throw new AIError("invalid_config"); }
  if (
    !["true", "false"].includes(enabled) || parsed.protocol !== "https:" ||
    parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
    parsed.pathname.replace(/\/+$/, "").endsWith("/responses") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(model) || model.startsWith("opencode-go/") ||
    !["low", "medium", "high", "xhigh"].includes(effort) || /[\r\n]/.test(apiKey)
  ) throw new AIError("invalid_config");
  return {
    enabled: enabled === "true", baseURL: parsed.toString().replace(/\/+$/, ""),
    model, reasoningEffort: effort as ReasoningEffort, apiKey,
  };
}

export function checkAIConfig(config: AIConfig) {
  return {
    ok: true,
    network: "not_used",
    enabled: config.enabled,
    keyConfigured: config.apiKey !== "",
    ready: config.enabled && config.apiKey !== "",
    message: config.apiKey === "" ? "API key 尚未設定；未連線。" : "API key 已設定；未連線、未驗證 key 或訂閱資格。",
  } as const;
}
