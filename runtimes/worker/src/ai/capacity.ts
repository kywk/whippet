import { AI_DEFAULTS, type AIConfig } from "./config.js";
import { AuthorError } from "../author/types.js";

export interface ModelCapacity { contextWindowTokens: number; maxInputTokens: number; safetyTokens: number }

// OpenCode official GET /inference/go/v1/models, checked 2026-11-16.
// Full response SHA256: 131e8cbf66ce19d902eb4c9b822f564c0369cc6fd0a7f08ae2d58fe85e28d567.
// This pins capabilities, not usage budgets: the existing output limit stays unchanged.
export function modelCapacity(config: AIConfig): ModelCapacity {
  const known = (config.provider ?? "opencode") === "opencode" && config.model === AI_DEFAULTS.model && config.baseURL === AI_DEFAULTS.baseURL ? 1048576 : undefined;
  const window = config.contextWindowTokens ?? known;
  const input = config.contextInputTokens ?? 65536;
  if (!Number.isSafeInteger(window) || window! < 1024 || window! > 2097152 || known !== undefined && window! > known ||
      !Number.isSafeInteger(input) || input < 1024 || input > window!) throw new AuthorError("invalid_input");
  return { contextWindowTokens: window!, maxInputTokens: input, safetyTokens: 1024 };
}
