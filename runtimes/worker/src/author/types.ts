import { validateWorkspaceSettings, type WorkspaceSettings } from "../workspace.js";
import { createHash } from "node:crypto";
import { validateWorkspaceContext, validateWorkspaceConfig, type WorkspaceContext, type WorkspaceConfig } from "../workspace-context.js";

export const EDIT_TOOLS = ["read_draft", "read_validation_report", "update_draft", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login", "request_validation"] as const;
export interface ValidationEvidence {
  runId: string; attemptId: string; draftRevision: number; scriptHash: string; timeoutMs: number;
  status: "succeeded"; reportsReady: true;
  stats: { expected: number; unexpected: number; flaky: number; skipped: number; duration: number };
}

export interface AuthorInput {
  kind: "author";
  runId: string;
  attemptId: string;
  script: string;
  timeoutMs: number;
  workspaceSettings?: WorkspaceSettings;
  workspaceId?:string;
  testId?:string|null;
  workspaceContext?:WorkspaceContext|null;
  scriptOrigin?:'ai'|'manual'|'legacy';
  author: {
    conversationId: string;
    baseRevision: number;
    messages: { role: "user" | "assistant"; content: string }[];
    validation?: { runId: string; status: string; error?: string } | null;
    skillId?: "test-author" | "acceptance-summary" | "workspace-author";
    skillVersion?: "1";
    allowedTools?: string[];
    editingSessionId?: string|null;
    contextRevision?: number;
    sourceVersion?: { id: string; description: string | null; backgroundSummary: string | null } | null;
    conversationSummary?: string | null;
    validationEvidence?: ValidationEvidence;
  };
}

export interface AuthorOutput {
  message: string;
  script?: string;
  requestValidation: boolean;
  conversationSummary?: string;
}

export interface SummaryOutput {
  message: string; description: string; backgroundSummary: string; name?: string;
  script?: never; requestValidation?: never;
}

export interface WorkspaceAuthorOutput {message:string;proposal?:WorkspaceConfig;conversationSummary?:string;script?:never;requestValidation?:never;}

export function boundedText(value: unknown, bytes: number, nonempty = false): value is string {
  return typeof value === "string" && (!nonempty || value.trim() !== "") && !value.includes("\0") &&
    Buffer.byteLength(value) <= bytes && Buffer.from(value).toString("utf8") === value;
}

export function isSummary(input: AuthorInput): boolean { return input.author.skillId === "acceptance-summary"; }
export function isWorkspaceAuthor(input: AuthorInput): boolean {return input.author.skillId==="workspace-author";}
export function authorNeedsBrowser(input:AuthorInput):boolean{return !isSummary(input)&&(input.author.allowedTools===undefined||input.author.allowedTools.some((t)=>t.startsWith("browser_")));}

export function parseWorkspaceAuthorOutput(value:unknown,context:WorkspaceContext):WorkspaceAuthorOutput {
  const v=value as WorkspaceAuthorOutput|null;
  if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some((k)=>!["message","proposal","conversationSummary"].includes(k))||
    !boundedText(v.message,128000,true)||v.message.length>32000||v.conversationSummary!==undefined&&!boundedText(v.conversationSummary,8192))throw new AuthorError("invalid_response");
  if(v.proposal!==undefined){try{validateWorkspaceConfig(v.proposal,new Set(context.roleRefs.map((r)=>r.roleId)));}catch{throw new AuthorError("invalid_response");}}
  return v;
}

export function parseSummaryOutput(value: unknown): SummaryOutput {
  const v = value as SummaryOutput | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((k) => !["message", "description", "backgroundSummary", "name"].includes(k)) ||
    !boundedText(v.message, 128000, true) || v.message.length > 32000 || !boundedText(v.description, 16384, true) ||
    !boundedText(v.backgroundSummary, 8192, true) || v.name !== undefined && !boundedText(v.name, 200, true)) throw new AuthorError("invalid_response");
  return v;
}

export class AuthorError extends Error {
  constructor(readonly code: "invalid_input" | "limit" | "tool_failed" | "provider_failed" | "invalid_response" | "sensitive_output" | "timed_out" | "cancelled" | "skill_unavailable" | "security_unavailable") {
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
    !Array.isArray(v.author.messages) || v.author.messages.length > 12
  ) throw new AuthorError("invalid_input");
  if(Object.keys(v).some((k)=>!["kind","runId","attemptId","script","timeoutMs","workspaceSettings","workspaceId","testId","workspaceContext","scriptOrigin","author"].includes(k))||v.scriptOrigin!==undefined&&!['ai','manual','legacy'].includes(v.scriptOrigin))throw new AuthorError("invalid_input");
  try {
    validateWorkspaceSettings(v.workspaceSettings);
    if(v.workspaceId!==undefined&&v.testId===undefined||v.workspaceId===undefined&&v.testId!==undefined)throw new Error();
    if(v.workspaceId!==undefined&&(typeof v.workspaceId!=="string"||!uuid.test(v.workspaceId))||v.testId!==undefined&&v.testId!==null&&(typeof v.testId!=="string"||!uuid.test(v.testId)))throw new Error();
    if(v.workspaceContext!=null&&v.workspaceId===undefined)throw new Error();
    validateWorkspaceContext(v.workspaceContext,v.workspaceId);
  } catch { throw new AuthorError("invalid_input"); }
  const a = v.author;
  if (Object.keys(a).some((k) => !["conversationId", "baseRevision", "messages", "validation", "skillId", "skillVersion", "allowedTools", "editingSessionId", "contextRevision", "sourceVersion", "conversationSummary", "validationEvidence"].includes(k))) throw new AuthorError("invalid_input");
  const modern = ["skillId", "skillVersion", "allowedTools", "editingSessionId", "contextRevision", "sourceVersion", "conversationSummary", "validationEvidence"].some((k) => Object.hasOwn(a, k));
  if (modern) {
    if (!["test-author", "acceptance-summary","workspace-author"].includes(a.skillId ?? "") || a.skillVersion !== "1" || (!isWorkspaceAuthor(v)&&!uuid.test(a.editingSessionId ?? "")) ||
      !Number.isSafeInteger(a.contextRevision) || a.contextRevision! < 0 || a.baseRevision < 1 || !Object.hasOwn(a,"sourceVersion") || !Object.hasOwn(a,"conversationSummary") ||
      a.conversationSummary !== null && !boundedText(a.conversationSummary,8192) || !Array.isArray(a.allowedTools) || new Set(a.allowedTools).size !== a.allowedTools.length ||
      a.allowedTools.some((name) => !(EDIT_TOOLS as readonly string[]).includes(name))) throw new AuthorError("invalid_input");
    const s = a.sourceVersion;
    if (s !== null && (!s || typeof s !== "object" || Array.isArray(s) || !uuid.test(s.id) ||
      Object.keys(s).some((k) => !["id","description","backgroundSummary"].includes(k)) ||
      s.description !== null && !boundedText(s.description,16384) || s.backgroundSummary !== null && !boundedText(s.backgroundSummary,8192))) throw new AuthorError("invalid_input");
    if(isWorkspaceAuthor(v)){
      if(v.script!==""||!v.workspaceId||v.testId!==null||!v.workspaceContext||v.workspaceContext.settingsRevision!==a.baseRevision||
        a.editingSessionId!==null||s!==null||a.allowedTools.some((t)=>!t.startsWith('browser_'))||a.validation!=null||a.validationEvidence!==undefined)throw new AuthorError("invalid_input");
    }
    if (isSummary(v)) {
      const e = a.validationEvidence;
      if (v.script.trim() === "" || a.allowedTools.length !== 0 || !e || Object.keys(e).some((k) => !["runId","attemptId","draftRevision","scriptHash","timeoutMs","status","reportsReady","stats"].includes(k)) ||
        !uuid.test(e.runId) || !uuid.test(e.attemptId) || e.draftRevision !== a.baseRevision ||
        e.scriptHash !== createHash("sha256").update(v.script).digest("hex") || e.status !== "succeeded" || e.reportsReady !== true ||
        !Number.isInteger(e.timeoutMs) || e.timeoutMs < 1 || e.timeoutMs > 3600000 || !e.stats ||
        Object.keys(e.stats).some((k) => !["expected","unexpected","flaky","skipped","duration"].includes(k)) ||
        ![e.stats.expected,e.stats.unexpected,e.stats.flaky,e.stats.skipped].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        e.stats.expected < 1 || e.stats.unexpected !== 0 || !Number.isFinite(e.stats.duration) || e.stats.duration < 0) throw new AuthorError("invalid_input");
    } else if (a.validationEvidence !== undefined) throw new AuthorError("invalid_input");
  }
  if(!isWorkspaceAuthor(v)&&v.testId===null)throw new AuthorError("invalid_input");
  if(v.workspaceId!==undefined&&authorNeedsBrowser(v)&&(!v.workspaceContext?.config||v.workspaceContext.config.targets.length===0))throw new AuthorError("security_unavailable");
  let chars = 0;
  let hasUser = false;
  for (const message of v.author.messages) {
    if (!message || Object.keys(message).some((k)=>!["role","content"].includes(k)) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") throw new AuthorError("invalid_input");
    chars += [...message.content].length;
    hasUser ||= message.role === "user" && message.content.trim() !== "";
  }
  if (chars > 32000 || !hasUser && !isSummary(v)) throw new AuthorError("invalid_input");
  const validation = v.author.validation;
  if (validation != null && (typeof validation !== "object" || typeof validation.runId !== "string" || !uuid.test(validation.runId) ||
    !["queued", "dispatched", "running", "collecting", "succeeded", "failed", "cancelling", "cancelled", "timed_out", "interrupted"].includes(validation.status) ||
    validation.error !== undefined && (typeof validation.error !== "string" || [...validation.error].length > 4000))) throw new AuthorError("invalid_input");
  return v;
}
