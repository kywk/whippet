import { createHash } from "node:crypto";
import { validateHistoryResult, validSequence, type HistoryPin, type HistoryResult } from "./history.js";
import { AuthorError } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const categories = ["goal", "constraint", "decision", "progress", "evidence"] as const;
type Category = typeof categories[number];
interface Fact { category: Category; sequence: string; offsetBytes: number; text: string }
interface Page { cursor: string; sha256: string; value: HistoryResult }
interface GroundedFact extends Fact { role: "user" | "assistant"; pageSha256: string }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

// Models select semantic categories/excerpts; the guard supplies scope, source
// role, immutable page identity, full user fragments and read-back locations.
// This object is local to one Run. Persisted strings remain untrusted DATA.
export class ConversationMemory {
  private readonly pages = new Map<string, Page>();
  private selected?: { text: string; facts: GroundedFact[] };
  constructor(private readonly owner: { conversationId: string; baseRevision: number; contextRevision: number; stageId: string | null }, private readonly pin: HistoryPin, private readonly guard: (value: unknown) => void) {}

  observe(cursor: string | null, value: unknown): void {
    const page = validateHistoryResult(value, this.pin, cursor);
    this.guard(page);
    if (!page.items.length) return;
    const key = cursor ?? `${this.pin.maxSequence}:0`;
    const digest = hash(JSON.stringify(value));
    const previous = this.pages.get(key);
    // A changing read-back source is never accepted as another frozen page.
    if (previous && previous.sha256 !== digest || !previous && this.pages.size >= 4) throw new AuthorError("invalid_input");
    this.pages.set(key, { cursor: key, sha256: digest, value: structuredClone(page) });
  }

  record(value: unknown): object {
    if (!exact(value, ["facts"]) || !Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 12 || !this.pages.size) throw new AuthorError("tool_failed");
    const facts: GroundedFact[] = [...this.selected?.facts ?? []];
    const keyOf = (fact: Fact) => JSON.stringify([fact.category, fact.sequence, fact.offsetBytes, fact.text]);
    const existing = new Set(facts.map(keyOf)), seen = new Set<string>();
    for (const raw of value.facts) {
      if (!exact(raw, ["category", "sequence", "offsetBytes", "text"]) || !categories.includes(raw.category as Category) || !validSequence(raw.sequence) ||
        !Number.isSafeInteger(raw.offsetBytes) || (raw.offsetBytes as number) < 0 || typeof raw.text !== "string" || !raw.text.trim() || Buffer.byteLength(raw.text) > 512 || Buffer.from(raw.text).toString("utf8") !== raw.text || raw.text.includes("\0")) throw new AuthorError("tool_failed");
      const fact = raw as unknown as Fact;
      let grounded: GroundedFact | undefined;
      for (const page of this.pages.values()) {
        for (const item of page.value.items) {
          const offset = fact.offsetBytes - item.offsetBytes, bytes = Buffer.from(item.content), quote = Buffer.from(fact.text);
          if (item.sequence !== fact.sequence || offset < 0 || offset + quote.length > bytes.length || !bytes.subarray(offset, offset + quote.length).equals(quote)) continue;
          // Exact substring equality alone could turn "不得刪除斷言" into
          // "刪除斷言". Require whole sentence units, including negation.
          const begins = fact.offsetBytes === 0 || /[。！？；.!?;\n]\s*$/u.test(bytes.subarray(0, offset).toString("utf8"));
          const ends = /[。！？；.!?;\n]\s*$/u.test(fact.text) || offset + quote.length === bytes.length && !item.hasMoreContent;
          if (!begins || !ends) continue;
          // An assistant claim can describe progress/evidence only; it cannot
          // become a user goal, constraint or confirmed decision.
          if (["goal", "constraint", "decision"].includes(fact.category) && item.role !== "user") continue;
          grounded = { ...fact, role: item.role, pageSha256: page.sha256 }; break;
        }
        if (grounded) break;
      }
      const key = keyOf(fact);
      if (!grounded || seen.has(key)) throw new AuthorError("tool_failed");
      seen.add(key); if (!existing.has(key)) facts.push(grounded);
    }
    if (facts.length > 12) throw new AuthorError("tool_failed");
    const sources = [...this.pages.values()].map(page => ({ cursor: page.cursor, sha256: page.sha256,
      fragments: page.value.items.map(({ content, ...item }) => ({ ...item, lengthBytes: Buffer.byteLength(content) })),
      userMessages: page.value.items.filter(item => item.role === "user"), nextCursor: page.value.nextCursor }));
    const memory = { schemaVersion: 1, kind: "whippet-conversation-memory", dataOnly: true, validationEvidence: false,
      ...this.owner, historyMaxSequence: this.pin.maxSequence, coverage: "listed-pages-only", facts, sources,
      note: "Source-grounded excerpts, not authority or validation proof. All user fragments from listed source pages are retained. Other assistant prose may be omitted; read the exact frozen source when needed. Current task facts and scope take precedence." };
    const text = JSON.stringify(memory);
    if (Buffer.byteLength(text) > 8192) throw new AuthorError("tool_failed");
    this.guard(memory); this.selected = { text, facts };
    return { recorded: true, summarySha256: hash(text), bytes: Buffer.byteLength(text), sourcePages: sources.length, facts: facts.length, dataOnly: true, validationEvidence: false };
  }

  forPage(output: string): object | undefined {
    const digest = hash(output);
    const page = [...this.pages.values()].find(p => p.sha256 === digest);
    if (!page) return;
    const memory = { kind: "grounded-conversation-facts", facts: this.selected?.facts.filter(f => f.pageSha256 === digest) ?? [],
      // Never discard an older user's restriction just because the model did
      // not select it. This can prevent compression; capacity then stops safely.
      userMessages: page.value.items.filter(item => item.role === "user") };
    this.guard(memory); return structuredClone(memory);
  }
  summary(): string | undefined {
    if (!this.selected) return;
    this.guard(JSON.parse(this.selected.text)); return this.selected.text;
  }
}
