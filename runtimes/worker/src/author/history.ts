import { HarnessClient } from "./harness.js";
import { capabilitySnapshot } from "./manifest.js";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { attemptIO } from "../attempt-io.js";
import type { AuthorInput } from "./types.js";

export interface HistoryPin { maxSequence: string }
export interface HistoryItem { sequence: string; role: "user" | "assistant"; content: string; offsetBytes: number; hasMoreContent: boolean }
export interface HistoryPage {
  workspaceId: string; testId: string | null; runId: string; attemptId: string;
  editingSessionId: string | null; conversationId: string; maxSequence: string;
  items: HistoryItem[]; nextCursor: string | null;
}
export class HistoryError extends Error { constructor() { super("history_unavailable"); } }
const decimal = /^(0|[1-9][0-9]*)$/;
export function validSequence(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && decimal.test(value) && BigInt(value) <= 9223372036854775807n;
}
export function historyCursor(value: unknown): { sequence: bigint; offset: number } | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const [sequence, offset, extra] = value.split(":");
  if (!validSequence(sequence) || !offset || !decimal.test(offset) || extra !== undefined || !Number.isSafeInteger(Number(offset))) return null;
  return { sequence: BigInt(sequence), offset: Number(offset) };
}
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
export function hasHistory(input: AuthorInput): boolean {
  return !!input.author.history && ["test-author", "workspace-author", "module-authoring", "usecase-planner"].includes(input.author.skillId ?? "") && input.author.allowedTools?.includes("read_conversation_history") === true;
}

// Scope and pagination are checked before anything can become model data.
export function validateHistoryPage(value: unknown, input: AuthorInput, cursor: string | null): HistoryPage {
  if (!hasHistory(input) || !exact(value, ["workspaceId", "testId", "runId", "attemptId", "editingSessionId", "conversationId", "maxSequence", "items", "nextCursor"]) ||
    value.workspaceId !== input.workspaceId || value.testId !== input.testId || value.runId !== input.runId || value.attemptId !== input.attemptId ||
    value.editingSessionId !== (input.author.editingSessionId ?? null) || value.conversationId !== input.author.conversationId || value.maxSequence !== input.author.history!.maxSequence ||
    !Array.isArray(value.items) || value.items.length > 6 || value.nextCursor !== null && !historyCursor(value.nextCursor)) throw new HistoryError();
  const start = cursor === null ? { sequence: BigInt(input.author.history!.maxSequence), offset: 0 } : historyCursor(cursor);
  if (!start || start.sequence > BigInt(input.author.history!.maxSequence)) throw new HistoryError();
  let bytes = 0;
  let previous: HistoryItem | undefined;
  for (const raw of value.items) {
    if (!exact(raw, ["sequence", "role", "content", "offsetBytes", "hasMoreContent"]) || !validSequence(raw.sequence) || raw.sequence === "0" ||
      !["user", "assistant"].includes(raw.role as string) || typeof raw.content !== "string" || !raw.content || raw.content.includes("\0") ||
      Buffer.from(raw.content).toString("utf8") !== raw.content || !Number.isSafeInteger(raw.offsetBytes) || (raw.offsetBytes as number) < 0 || typeof raw.hasMoreContent !== "boolean") throw new HistoryError();
    const item = raw as unknown as HistoryItem;
    const expected = previous ? previous.hasMoreContent ? { sequence: BigInt(previous.sequence), offset: previous.offsetBytes + Buffer.byteLength(previous.content) } : { sequence: BigInt(previous.sequence) - 1n, offset: 0 } : start;
    const seq = BigInt(item.sequence);
    if (seq > expected.sequence || item.offsetBytes !== (seq === expected.sequence ? expected.offset : 0) || expected.offset > 0 && seq !== expected.sequence) throw new HistoryError();
    bytes += Buffer.byteLength(item.content);
    if (bytes > 8192 || !Number.isSafeInteger(item.offsetBytes + Buffer.byteLength(item.content))) throw new HistoryError();
    previous = item;
  }
  const next = value.nextCursor === null ? null : historyCursor(value.nextCursor);
  if (!previous) { if (next) throw new HistoryError(); }
  else if (previous.hasMoreContent) {
    if (!next || next.sequence !== BigInt(previous.sequence) || next.offset !== previous.offsetBytes + Buffer.byteLength(previous.content)) throw new HistoryError();
  } else if (next && (next.sequence >= BigInt(previous.sequence) || next.offset !== 0)) throw new HistoryError();
  return value as unknown as HistoryPage;
}

export class HistoryClient {
  private readonly transport?: ReturnType<typeof attemptIO>;
  private readonly harness?: HarnessClient;
  private readonly unsubscribe: () => void;
  private closed = false;
  private count = 0;
  private pending?: { id: string; cursor: string | null; resolve: (value: HistoryPage) => void; reject: () => void; cleanup: () => void };
  constructor(private readonly input: AuthorInput, io?: { read: Readable; write: Writable }) {
    if (capabilitySnapshot(input.author)) {
      this.harness = new HarnessClient(input, io);
      this.unsubscribe = () => this.harness!.close();
    } else {
      this.transport = attemptIO(io);
      this.unsubscribe = this.transport.subscribe("history_response", this.onFrame, this.fail);
    }
  }
  private fail = (): void => { const p = this.pending; this.pending = undefined; if (p) { p.cleanup(); p.reject(); } };
  private onFrame = (frame: Record<string, unknown>): void => {
    const p = this.pending;
    if (!p || frame.requestId !== p.id || frame.attemptId !== this.input.attemptId) return;
    try {
      if (!exact(frame, ["kind", "requestId", "attemptId", "history"])) throw new HistoryError();
      const page = validateHistoryPage(frame.history, this.input, p.cursor);
      this.pending = undefined; p.cleanup(); p.resolve(page);
    } catch { this.fail(); }
  };
  read(cursor: string | null, signal?: AbortSignal, providerCallId?: string): Promise<HistoryPage> {
    if (this.closed || this.pending || ++this.count > 4 || !hasHistory(this.input) || signal?.aborted ||
      cursor !== null && (!historyCursor(cursor) || historyCursor(cursor)!.sequence > BigInt(this.input.author.history!.maxSequence))) return Promise.reject(new HistoryError());
    if (this.harness) {
      return this.harness.call("read_conversation_history", { cursor }, providerCallId ?? randomUUID(), signal)
        .then(value => validateHistoryPage(value, this.input, cursor)).catch(() => { throw new HistoryError(); });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(this.fail, 15000);
      const id = randomUUID();
      this.pending = { id, cursor, resolve, reject: () => reject(new HistoryError()), cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", this.fail); } };
      signal?.addEventListener("abort", this.fail, { once: true });
      this.transport!.send({ kind: "history_request", requestId: id, attemptId: this.input.attemptId, cursor }, this.fail);
    });
  }
  close(): void { this.closed = true; this.fail(); this.unsubscribe(); }
}
