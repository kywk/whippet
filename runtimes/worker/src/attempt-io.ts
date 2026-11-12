import type { Readable, Writable } from "node:stream";

export const MAX_ATTEMPT_FRAME = 64 * 1024;
type Kind = "credential_response" | "history_response";
type Listener = { receive: (frame: Record<string, unknown>) => void; fail: () => void };
const readers = new WeakMap<Readable, AttemptIO>();

// One stdin owner, with only the two fixed attempt protocols. A history
// subscriber never receives the credential frame or its raw bytes.
class AttemptIO {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly listeners: Record<Kind, Set<Listener>> = {
    credential_response: new Set(), history_response: new Set(),
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
      if (this.listeners.credential_response.size + this.listeners.history_response.size === 0) this.close();
    };
  }
  send(frame: Record<string, unknown>, fail: () => void): void {
    const line = JSON.stringify(frame) + "\n";
    if (this.closed || Buffer.byteLength(line) > MAX_ATTEMPT_FRAME) { fail(); return; }
    // One write per complete frame; Node's Writable queues concurrent writes.
    this.io.write.write(line, (error) => { if (error) fail(); });
  }
  private onData = (chunk: Buffer): void => {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (this.buffer.length + part.length > MAX_ATTEMPT_FRAME) { this.close(); return; }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      const raw = this.buffer; this.buffer = Buffer.alloc(0); start = end + 1;
      try {
        if (!Buffer.from(raw.toString("utf8")).equals(raw)) throw new Error();
        const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (!frame || Array.isArray(frame)) throw new Error();
        if (frame.kind === "credential_response" || frame.kind === "history_response") {
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
