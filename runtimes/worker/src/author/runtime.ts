import { createHash } from "node:crypto";
import { AIError, readAIConfig, type AIConfig, type EngineId, type ProviderId, type ReasoningEffort } from "../ai/config.js";
import { validModelKey } from "./model-key.js";

export interface AuthorRuntime {
  schemaVersion: 1;
  profileId: string;
  engine: EngineId;
  provider: ProviderId;
  baseURL: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  contextWindowTokens: number;
  contextInputTokens: number;
  sha256: string;
}

// The order is part of the v12 contract, independent of PostgreSQL jsonb order.
export function runtimeDigest(r: Omit<AuthorRuntime, "sha256">): string {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: r.schemaVersion, profileId: r.profileId, engine: r.engine,
    provider: r.provider, baseURL: r.baseURL, model: r.model, reasoningEffort: r.reasoningEffort,
    contextWindowTokens: r.contextWindowTokens, contextInputTokens: r.contextInputTokens })).digest("hex");
}

export function validRuntime(value: unknown): value is AuthorRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as AuthorRuntime;
  if (Object.keys(r).length !== 10 || Object.keys(r).some(k => !["schemaVersion", "profileId", "engine", "provider", "baseURL", "model", "reasoningEffort", "contextWindowTokens", "contextInputTokens", "sha256"].includes(k)) ||
    r.schemaVersion !== 1 || typeof r.profileId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(r.profileId) || !["builtin", "vercel", "pi"].includes(r.engine) || !["opencode", "openai-responses"].includes(r.provider) ||
    typeof r.baseURL !== "string" || r.baseURL.length > 2048 || !/^[\x21-\x7e]+$/.test(r.baseURL) || /[\\"<>]/.test(r.baseURL) || r.baseURL.endsWith("/") ||
    typeof r.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(r.model) || r.model.startsWith("opencode-go/") || !["low", "medium", "high", "xhigh"].includes(r.reasoningEffort) ||
    !(Number.isSafeInteger(r.contextWindowTokens) && r.contextWindowTokens >= 1024 && r.contextWindowTokens <= 2097152 || r.contextWindowTokens === 0 && r.engine === "builtin") ||
    !Number.isSafeInteger(r.contextInputTokens) || r.contextInputTokens < 1024 || r.contextInputTokens > 2097152 || r.contextWindowTokens > 0 && r.contextInputTokens > r.contextWindowTokens) return false;
  try {
    const u = new URL(r.baseURL);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash || r.baseURL.includes("?") || r.baseURL.includes("#") || u.pathname.endsWith("/responses")) return false;
  } catch { return false; }
  if (r.provider === "opencode" && r.model === "muse-spark-1.3-contributor" && r.baseURL === "https://opencode.ai/inference/go/openai/v1" && r.contextWindowTokens > 1048576) return false;
  return typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256) && r.sha256 === runtimeDigest(r);
}

export function runtimeConfig(config: AIConfig, r: AuthorRuntime): AIConfig {
  if (!validRuntime(r)) throw new AIError("invalid_config");
  const apiKey = config.providerKeys?.[r.provider] ?? ((config.provider ?? "opencode") === r.provider ? config.apiKey : "");
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new AIError("missing_key");
  return { ...config, apiKey, engine: r.engine, provider: r.provider, baseURL: r.baseURL, model: r.model,
    reasoningEffort: r.reasoningEffort, contextWindowTokens: r.contextWindowTokens || undefined, contextInputTokens: r.contextInputTokens };
}

export function managedModelConfig(runtime: AuthorRuntime, key: string): AIConfig {
  if (!validRuntime(runtime) || !validModelKey(key)) throw new AIError("invalid_config");
  return { enabled: true, apiKey: key, engine: runtime.engine, provider: runtime.provider,
    baseURL: runtime.baseURL, model: runtime.model, reasoningEffort: runtime.reasoningEffort,
    contextWindowTokens: runtime.contextWindowTokens || undefined, contextInputTokens: runtime.contextInputTokens };
}

// Resolve nonsecret policy before parsing env, so queued snapshots ignore even
// malformed later model/engine/capacity environment settings. Enable/key stay local.
export function readAuthorConfig(env: Readonly<Record<string, string | undefined>>, runtime?: AuthorRuntime): AIConfig {
  if (!runtime) return readAIConfig(env);
  if (!validRuntime(runtime)) throw new AIError("invalid_config");
  const config = readAIConfig({ ...env, WHIPPET_AI_ENGINE: runtime.engine, WHIPPET_AI_PROVIDER: runtime.provider,
    WHIPPET_AI_BASE_URL: runtime.baseURL, WHIPPET_AI_MODEL: runtime.model, WHIPPET_AI_REASONING_EFFORT: runtime.reasoningEffort,
    WHIPPET_AI_CONTEXT_WINDOW_TOKENS: runtime.contextWindowTokens ? String(runtime.contextWindowTokens) : undefined,
    WHIPPET_AI_CONTEXT_INPUT_TOKENS: String(runtime.contextInputTokens) });
  return runtimeConfig(config, runtime);
}
