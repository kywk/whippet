import { loadToolRegistry, sha256, validateToolArguments, validateToolResult, exactObject, type ToolDefinition } from "../author/registry.js";
import type { ExplorationBrowser } from "../author/tools.js";
import { validateWorkspaceContext, type WorkspaceContext } from "../workspace-context.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxCalls = 256;
const maxCachedResultBytes = 2 << 20;
export const maxSessionFrameBytes = 14 << 20;
export type SessionError = "session_unavailable" | "tool_unavailable" | "invalid_request" | "busy" | "unknown_result" | "cancelled" | "timeout";

export interface SessionInput {
  kind: "session";
  sessionId: string;
  leaseId: string;
  workspaceId: string;
  workspaceContext: WorkspaceContext;
  allowedTools: string[];
  toolRegistryVersion: string;
  toolRegistrySha256: string;
}
export interface SessionCall {
  kind: "tool_call";
  sessionId: string;
  leaseId: string;
  callId: string;
  name: string;
  arguments: unknown;
}
export type SessionReply = {
  kind: "tool_result"; sessionId: string; leaseId: string; callId: string;
  result?: unknown; error?: SessionError;
};
type LoginAuthorization = (roleId: string) => Promise<boolean>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function validateSessionInput(value: unknown): SessionInput {
  if (!exactObject(value, ["kind", "sessionId", "leaseId", "workspaceId", "workspaceContext", "allowedTools", "toolRegistryVersion", "toolRegistrySha256"]) ||
      value.kind !== "session" || !uuid.test(value.sessionId) || !uuid.test(value.leaseId) || !uuid.test(value.workspaceId) ||
      !Array.isArray(value.allowedTools) || new Set(value.allowedTools).size !== value.allowedTools.length ||
      typeof value.toolRegistryVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.toolRegistrySha256)) throw new Error("invalid_session_input");
  const context = validateWorkspaceContext(value.workspaceContext, value.workspaceId);
  if (!context?.config?.targets.length) throw new Error("invalid_session_input");
  const registry = loadToolRegistry();
  if (value.toolRegistryVersion !== registry.version || value.toolRegistrySha256 !== registry.sha256 ||
      value.allowedTools.some((name: unknown) => typeof name !== "string" || !registry.tools.some(tool => tool.name === name && tool.side === "worker" && tool.effect === "browser"))) throw new Error("invalid_session_input");
  return value as unknown as SessionInput;
}

export class SessionWorker {
  private readonly input: SessionInput;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly seen = new Map<string, { hash: string; reply?: SessionReply }>();
  private active = false;
  private closed = false;
  private cachedResultBytes = 0;

  constructor(input: SessionInput, private readonly browser: ExplorationBrowser, private readonly authorizeLogin?: LoginAuthorization) {
    this.input = validateSessionInput(input);
    this.tools = new Map(loadToolRegistry().tools.map(tool => [tool.name, tool]));
  }

  ready(): { kind: "session_ready"; sessionId: string; leaseId: string } {
    return { kind: "session_ready", sessionId: this.input.sessionId, leaseId: this.input.leaseId };
  }

  async call(frame: SessionCall): Promise<SessionReply> {
    const base = { kind: "tool_result" as const, sessionId: this.input.sessionId, leaseId: this.input.leaseId, callId: typeof frame?.callId === "string" ? frame.callId : "" };
    const error = (value: SessionError): SessionReply => ({ ...base, error: value });
    if (!exactObject(frame, ["kind", "sessionId", "leaseId", "callId", "name", "arguments"]) || frame.kind !== "tool_call" ||
        frame.sessionId !== this.input.sessionId || frame.leaseId !== this.input.leaseId || !uuid.test(frame.callId) || typeof frame.name !== "string") return error("invalid_request");
    if (this.closed) return error("session_unavailable");
    const tool = this.tools.get(frame.name);
    if (!tool || tool.side !== "worker" || tool.effect !== "browser" || !this.input.allowedTools.includes(frame.name)) return error("tool_unavailable");
    const raw = JSON.stringify(frame.arguments);
    if (!raw || Buffer.byteLength(raw) > tool.limits.maxInputBytes || Buffer.byteLength(JSON.stringify(frame)) > maxSessionFrameBytes) return error("invalid_request");
    try { validateToolArguments(tool, frame.arguments); } catch { return error("invalid_request"); }
    const hash = sha256(`${frame.name}\n${JSON.stringify(canonical(frame.arguments))}`);
    const prior = this.seen.get(frame.callId);
    if (prior) return prior.hash !== hash ? error("invalid_request") : prior.reply ?? error("busy");
    if (this.active) return error("busy");
    if (this.seen.size >= maxCalls) { await this.close(); return error("cancelled"); }
    this.seen.set(frame.callId, { hash });
    this.active = true;
    let reply: SessionReply;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.execute(frame),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("timeout")), tool.limits.timeoutMs); timeout.unref?.(); }),
      ]);
      validateToolResult(tool, result);
      reply = this.closed ? error("cancelled") : { ...base, result };
    } catch (cause) {
      reply = error(cause instanceof Error && cause.message === "timeout" ? "timeout" : "tool_unavailable");
      if (reply.error === "timeout") void this.close();
    } finally { if (timeout) clearTimeout(timeout); this.active = false; }
    const replyBytes = Buffer.byteLength(JSON.stringify(reply));
    if (this.cachedResultBytes + replyBytes > maxCachedResultBytes) {
      await this.close();
      reply = error("unknown_result");
    }
    this.cachedResultBytes += Buffer.byteLength(JSON.stringify(reply));
    this.seen.get(frame.callId)!.reply = reply;
    return reply;
  }

  private execute(frame: SessionCall): Promise<unknown> {
    const args = frame.arguments as Record<string, string>;
    switch (frame.name) {
      case "browser_navigate": return this.browser.navigate(args.url!);
      case "browser_snapshot": return this.browser.snapshot();
      case "browser_click": return this.browser.click(args.selector!);
      case "browser_fill": return this.browser.fill(args.selector!, args.value!);
      case "browser_login":
        if (!this.authorizeLogin || !this.browser.login) return Promise.reject(new Error("login_unavailable"));
        return this.authorizeLogin(args.roleId!).then(allowed => {
          if (!allowed) throw new Error("login_unavailable");
          return this.browser.login!(args.roleId!, args.usernameSelector!, args.passwordSelector!, args.submitSelector!, frame.callId);
        });
      default: return Promise.reject(new Error("tool_unavailable"));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.browser.close(); } catch { /* Manager owns final container removal. */ }
  }
}
