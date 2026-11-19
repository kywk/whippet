import { AI_DEFAULTS, type AIConfig } from "./config.js";
import { AuthorError } from "../author/types.js";

export interface ModelCapacity { contextWindowTokens: number; maxInputTokens: number; safetyTokens: number }

function knownWindow(config: AIConfig): number | undefined {
  return (config.provider ?? "opencode") === "opencode" && config.model === AI_DEFAULTS.model && config.baseURL === AI_DEFAULTS.baseURL ? 1048576 : undefined;
}

// Legacy builtin profiles may have no declared capability. Do not invent one;
// explicit or known capabilities use the same checks as the Vercel adapter.
export function availableModelCapacity(config: AIConfig): ModelCapacity | undefined {
  if (config.contextWindowTokens === undefined && knownWindow(config) === undefined) return undefined;
  return modelCapacity(config);
}

// OpenCode official GET /inference/go/v1/models, checked 2026-11-16.
// Full response SHA256: 131e8cbf66ce19d902eb4c9b822f564c0369cc6fd0a7f08ae2d58fe85e28d567.
// This pins capabilities, not usage budgets: the existing output limit stays unchanged.
export function modelCapacity(config: AIConfig): ModelCapacity {
  const known = knownWindow(config);
  const window = config.contextWindowTokens ?? known;
  if (window === undefined || !Number.isSafeInteger(window) || window < 1024 || window > 2097152 ||
      known !== undefined && window > known) throw new AuthorError("invalid_input");
  const input = config.contextInputTokens ?? Math.min(256 * 1024, window);
  if (!Number.isSafeInteger(input) || input < 1024 || input > window) throw new AuthorError("invalid_input");
  return { contextWindowTokens: window, maxInputTokens: input, safetyTokens: 1024 };
}
