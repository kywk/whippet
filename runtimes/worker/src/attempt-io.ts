import type { Readable, Writable } from "node:stream";

export const MAX_ATTEMPT_FRAME = 64 * 1024;
export const MAX_TOOL_FRAME = 14 * 1024 * 1024;
export const MAX_MODULE_TOOL_FRAME = 26 * 1024 * 1024;
export const toolFrameLimit = (name: string):number => ["catalog_get","read_module_draft","update_module_candidate"].includes(name) ? MAX_MODULE_TOOL_FRAME : MAX_TOOL_FRAME;
type Kind = "credential_response" | "history_response" | "tool_response";
type Listener = { receive: (frame: Record<string, unknown>) => void; fail: () => void };
const readers = new WeakMap<Readable, AttemptIO>();

// One stdin owner with distinct credential/history and generic-tool limits. A history
// subscriber never receives the credential frame or its raw bytes.
class AttemptIO {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private pending = new Map<string,string>();
  expectTool(id:string,name:string):void {this.pending.set(id,name);}
  forgetTool(id:string):void {this.pending.delete(id);}
  private readonly listeners: Record<Kind, Set<Listener>> = {
    credential_response: new Set(), history_response: new Set(), tool_response: new Set(),
  };
  constructor(private readonly io: { read: Readable; write: Writable }) {
    io.read.on("data", this.onData);
    io.read.on("end", this.close);
    io.read.on("error", this.close);
  }
  subscribe(kind: Kind, receive: Listener["receive"], fail: Listener["fail"]): () => void {
    const listener = { receive, fail };
    this.listeners[kind].add(listener);
    if (this.closed) fail();
    return () => {
      this.listeners[kind].delete(listener);
      if (Object.values(this.listeners).every(listeners => listeners.size === 0)) this.close();
    };
  }
  send(frame: Record<string, unknown>, fail: () => void): void {
    const line = JSON.stringify(frame) + "\n";
    if (this.closed || Buffer.byteLength(line) > (frame.kind === "tool_request" ? toolFrameLimit(String(frame.name)) : MAX_ATTEMPT_FRAME)) { fail(); return; }
    // One write per complete frame; Node's Writable queues concurrent writes.
    this.io.write.write(line, (error) => { if (error) fail(); });
  }
  private onData = (chunk: Buffer): void => {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (this.buffer.length + part.length + 1 > (this.listeners.tool_response.size ? MAX_MODULE_TOOL_FRAME : MAX_ATTEMPT_FRAME)) { this.close(); return; }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      const raw = this.buffer; this.buffer = Buffer.alloc(0); start = end + 1;
      try {
        if (!Buffer.from(raw.toString("utf8")).equals(raw)) throw new Error();
        const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (!frame || Array.isArray(frame)) throw new Error();
        if(frame.kind === "tool_response") {
          const name=this.pending.get(String(frame.requestId));
          if(!name)continue;
          if(raw.length+1>toolFrameLimit(name))throw new Error();
        } else if(raw.length+1>MAX_ATTEMPT_FRAME)throw new Error();
        if (frame.kind === "credential_response" || frame.kind === "history_response" || frame.kind === "tool_response") {
          for (const listener of this.listeners[frame.kind]) listener.receive(frame);
        }
      } catch { this.close(); return; }
    }
  };
  private close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.io.read.off("data", this.onData); this.io.read.off("end", this.close); this.io.read.off("error", this.close);
    this.io.read.pause(); this.buffer = Buffer.alloc(0); readers.delete(this.io.read);
    for (const listeners of Object.values(this.listeners)) for (const listener of listeners) listener.fail();
  };
}

export function attemptIO(io: { read: Readable; write: Writable } = { read: process.stdin, write: process.stdout }): AttemptIO {
  let transport = readers.get(io.read);
  if (!transport) { transport = new AttemptIO(io); readers.set(io.read, transport); }
  return transport;
}
