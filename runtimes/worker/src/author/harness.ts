import { PLATFORM_SERVER_TOOLS } from "./platform.js";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { attemptIO } from "../attempt-io.js";
import { capabilitySnapshot } from "./manifest.js";
import { loadToolRegistry, validateToolArguments, validateToolResult, exactObject } from "./registry.js";
import type { AuthorInput } from "./types.js";

export class HarnessError extends Error { constructor() { super("tool_unavailable"); } }
export class HarnessClient {
  private readonly transport: ReturnType<typeof attemptIO>;
  private readonly unsubscribe: () => void;
  private readonly registry = loadToolRegistry();
  private readonly calls = new Map<string, { id: string; arguments: string }>();
  private closed = false;
  private pending?: { id: string; name: string; resolve(value: unknown): void; reject(): void; cleanup(): void };
  constructor(private readonly input: AuthorInput, io?: { read: Readable; write: Writable }) {
    const snapshot = capabilitySnapshot(input.author);
    if (!snapshot || snapshot.toolRegistryVersion !== this.registry.version || snapshot.toolRegistrySha256 !== this.registry.sha256) throw new HarnessError();
    this.transport = attemptIO(io);
    this.unsubscribe = this.transport.subscribe("tool_response", this.onFrame, this.fail);
  }
  private fail = (): void => { const pending = this.pending; this.pending = undefined; if (pending) { pending.cleanup(); pending.reject(); } };
  private onFrame = (frame: Record<string, unknown>): void => {
    const pending = this.pending;
    if (!pending || frame.attemptId !== this.input.attemptId || frame.requestId !== pending.id) return;
    try {
      if (!exactObject(frame, ["kind", "requestId", "attemptId", "result"])) throw new HarnessError();
      const tool = this.registry.tools.find(tool => tool.name === pending.name)!;
      validateToolResult(tool, frame.result);
      this.pending = undefined; pending.cleanup(); pending.resolve(frame.result);
    } catch { this.fail(); }
  };
  call(name: string, args: Record<string, unknown>, providerCallId: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const tool = this.registry.tools.find(tool => tool.name === name);
      if (this.closed || this.pending || signal?.aborted || !providerCallId || providerCallId.length > 1024 ||
          !tool || tool.side !== "server" || name !== "read_conversation_history" && !(PLATFORM_SERVER_TOOLS as readonly string[]).includes(name) || !this.input.author.allowedTools?.includes(name)) throw new HarnessError();
      validateToolArguments(tool, args);
      const fingerprint = JSON.stringify({ name, arguments: args });
      let call = this.calls.get(providerCallId);
      if (call && call.arguments !== fingerprint) throw new HarnessError();
      if (!call) {
        if (this.calls.size >= this.input.author.budget!.maxToolCalls) throw new HarnessError();
        call = { id: randomUUID(), arguments: fingerprint }; this.calls.set(providerCallId, call);
      }
      const id = call.id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(this.fail, tool.limits.timeoutMs);
        this.pending = { id, name, resolve, reject: () => reject(new HarnessError()), cleanup: () => { this.transport.forgetTool(id); clearTimeout(timer); signal?.removeEventListener("abort", this.fail); } };
        signal?.addEventListener("abort", this.fail, { once: true });
        this.transport.expectTool(id,name);
        this.transport.send({ kind: "tool_request", requestId: id, attemptId: this.input.attemptId, name, arguments: args }, this.fail);
      });
    } catch { return Promise.reject(new HarnessError()); }
  }
  close(): void { this.closed = true; this.fail(); this.unsubscribe(); }
}
