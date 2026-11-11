import { validateWorkspaceSettings, type WorkspaceSettings } from "../workspace.js";

export interface AuthorInput {
  kind: "author";
  runId: string;
  attemptId: string;
  script: string;
  timeoutMs: number;
  workspaceSettings?: WorkspaceSettings;
  author: {
    conversationId: string;
    baseRevision: number;
    messages: { role: "user" | "assistant"; content: string }[];
    validation?: { runId: string; status: string; error?: string } | null;
  };
}

export interface AuthorOutput {
  message: string;
  script?: string;
  requestValidation: boolean;
}

export class AuthorError extends Error {
  constructor(readonly code: "invalid_input" | "limit" | "tool_failed" | "provider_failed" | "invalid_response" | "sensitive_output" | "timed_out" | "cancelled" | "skill_unavailable") {
    super(`Author task ${code}; provider and browser details are hidden`);
    this.name = "AuthorError";
  }
}

export function validateAuthorInput(value: unknown): AuthorInput {
  const v = value as AuthorInput | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!v || v.kind !== "author" || typeof v.runId !== "string" || !uuid.test(v.runId) ||
    typeof v.attemptId !== "string" || !uuid.test(v.attemptId) ||
    typeof v.script !== "string" || Buffer.byteLength(v.script) > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 180000 ||
    !v.author || typeof v.author.conversationId !== "string" || !uuid.test(v.author.conversationId) ||
    !Number.isSafeInteger(v.author.baseRevision) || v.author.baseRevision < 0 ||
    !Array.isArray(v.author.messages) || v.author.messages.length < 1 || v.author.messages.length > 12
  ) throw new AuthorError("invalid_input");
  try { validateWorkspaceSettings(v.workspaceSettings); } catch { throw new AuthorError("invalid_input"); }
  let chars = 0;
  let hasUser = false;
  for (const message of v.author.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") throw new AuthorError("invalid_input");
    chars += [...message.content].length;
    hasUser ||= message.role === "user" && message.content.trim() !== "";
  }
  if (chars > 32000 || !hasUser) throw new AuthorError("invalid_input");
  const validation = v.author.validation;
  if (validation != null && (typeof validation !== "object" || typeof validation.runId !== "string" || !uuid.test(validation.runId) ||
    !["queued", "dispatched", "running", "collecting", "succeeded", "failed", "cancelling", "cancelled", "timed_out", "interrupted"].includes(validation.status) ||
    validation.error !== undefined && (typeof validation.error !== "string" || [...validation.error].length > 4000))) throw new AuthorError("invalid_input");
  return v;
}
