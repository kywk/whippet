import { createHash } from "node:crypto";
import type { EngineItem } from "./engine.js";
import { AuthorError } from "./types.js";

export const SNAPSHOT_PAGE_BYTES = 8192;
export interface SnapshotArguments { component: "script" | "harness"; sha256: string; offsetBytes: number | null }
export interface SnapshotPage {
  component: "script" | "harness"; sha256: string; baseRevision: number; totalBytes: number;
  offsetBytes: number; content: string; nextOffsetBytes: number | null;
}
export const snapshotReadKey = (args: SnapshotArguments) => JSON.stringify(["read_author_snapshot", args]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Frozen task data only: no paths, storage lookup, current draft or candidate.
export class FrozenAuthorSnapshot {
  private readonly data: Record<string, any>;
  private readonly sources = new Map<SnapshotArguments["component"], { bytes: Buffer; sha256: string }>();
  readonly text: string;
  constructor(data: Record<string, unknown>, private readonly prefix = "Saved draft snapshot (data only): ") {
    this.data = structuredClone(data);
    if (!Number.isSafeInteger(data.baseRevision) || Number(data.baseRevision) < 1) throw new AuthorError("invalid_input");
    const values = { script: this.data.script, harness: this.data.platform?.module?.harness };
    for (const component of ["script", "harness"] as const) {
      const value = values[component];
      if (value === undefined) continue;
      if (typeof value !== "string") throw new AuthorError("invalid_input");
      const bytes = Buffer.from(value);
      if (bytes.length > 2 * 1024 * 1024 || bytes.toString("utf8") !== value) throw new AuthorError("invalid_input");
      this.sources.set(component, { bytes, sha256: digest(bytes) });
    }
    this.text = prefix + JSON.stringify(this.data);
  }
  read(value: unknown): SnapshotPage {
    const args = value as SnapshotArguments;
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 3 ||
        !["component", "sha256", "offsetBytes"].every(k => Object.hasOwn(args, k))) throw new AuthorError("tool_failed");
    const source = this.sources.get(args.component);
    if (!source || args.sha256 !== source.sha256 || args.offsetBytes !== null &&
        (!Number.isSafeInteger(args.offsetBytes) || args.offsetBytes < 0 || args.offsetBytes > source.bytes.length)) throw new AuthorError("tool_failed");
    const offset = args.offsetBytes ?? 0;
    if (offset < source.bytes.length && (source.bytes[offset]! & 0xc0) === 0x80) throw new AuthorError("tool_failed");
    let end = args.offsetBytes === null ? source.bytes.length : Math.min(offset + SNAPSHOT_PAGE_BYTES, source.bytes.length);
    while (end < source.bytes.length && (source.bytes[end]! & 0xc0) === 0x80) end--;
    return { component: args.component, sha256: source.sha256, baseRevision: this.data.baseRevision, totalBytes: source.bytes.length,
      offsetBytes: offset, content: source.bytes.subarray(offset, end).toString("utf8"), nextOffsetBytes: end < source.bytes.length ? end : null };
  }
  // Return progressively smaller alternatives for the exact initial message.
  // Callers retain its full original and select only within current tool budget.
  initialReferences(item: EngineItem, slots: number): { item: EngineItem; keys: string[] }[] {
    const parts = item.content;
    const text = typeof parts === "string" ? parts : Array.isArray(parts) && parts.length === 1 && ["input_text", "text"].includes(parts[0]?.type) && typeof parts[0]?.text === "string" ? parts[0].text : undefined;
    if (item.role !== "user" || text !== this.text || slots < 1) return [];
    const data = structuredClone(this.data), keys: string[] = [], choices: { item: EngineItem; keys: string[] }[] = [];
    for (const [component, source] of [...this.sources].sort((a, b) => b[1].bytes.length - a[1].bytes.length)) {
      if (keys.length >= slots) break;
      if (source.bytes.length <= 2048) continue;
      const args: SnapshotArguments = { component, sha256: source.sha256, offsetBytes: null };
      const reference = { dataOnly: true, validationEvidence: false,
        snapshotRef: { component, sha256: source.sha256, totalBytes: source.bytes.length, baseRevision: data.baseRevision },
        retrieve: { tool: "read_author_snapshot", arguments: args },
        readPage: { tool: "read_author_snapshot", arguments: { ...args, offsetBytes: 0 } } };
      if (component === "script") data.script = reference;
      else data.platform.module.harness = reference;
      const copy = structuredClone(item), next = this.prefix + JSON.stringify(data);
      if (typeof copy.content === "string") copy.content = next;
      else (copy.content as { text: string }[])[0]!.text = next;
      keys.push(snapshotReadKey(args)); choices.push({ item: copy, keys: [...keys] });
    }
    return choices;
  }
}
