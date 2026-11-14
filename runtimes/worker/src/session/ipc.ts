import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { maxSessionFrameBytes, SessionWorker, type SessionCall } from "./session.js";
import type { SessionCredentialClient } from "./credentials.js";

export function sessionOutput(output: Writable): { send(frame: unknown): Promise<void> } {
  let tail = Promise.resolve();
  return { send(frame) {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > maxSessionFrameBytes) return Promise.reject(new Error("session_frame_too_large"));
    const next = tail.then(async () => { if (!output.write(line)) await once(output, "drain"); });
    tail = next.catch(() => undefined);
    return next;
  } };
}

export async function runSessionIPC(worker: SessionWorker, input: Readable, output: Writable,
  options: { writer?: ReturnType<typeof sessionOutput>; credentials?: SessionCredentialClient } = {}): Promise<void> {
  const writer = options.writer ?? sessionOutput(output);
  let pending = Buffer.alloc(0);
  let calls = Promise.resolve();
  try {
    await writer.send(worker.ready());
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = Buffer.concat([pending, bytes]);
      if (pending.length > maxSessionFrameBytes && !pending.includes(10)) throw new Error("session_frame_too_large");
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        const frameBytes = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (frameBytes.length + 1 > maxSessionFrameBytes || !Buffer.from(frameBytes.toString("utf8"), "utf8").equals(frameBytes)) throw new Error("invalid_session_frame");
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(frameBytes.toString("utf8")) as Record<string, unknown>; } catch { throw new Error("invalid_session_frame"); }
        if (!frame || Array.isArray(frame) || typeof frame !== "object") throw new Error("invalid_session_frame");
        if (frame.kind === "credential_response" && options.credentials && frameBytes.length + 1 <= (64 << 10)) {
          options.credentials.receive(frame);
        } else if (frame.kind === "tool_call") {
          calls = calls.then(async () => { await writer.send(await worker.call(frame as unknown as SessionCall)); });
        } else throw new Error("invalid_session_frame");
      }
      if (pending.length > maxSessionFrameBytes) throw new Error("session_frame_too_large");
    }
    if (pending.length !== 0) throw new Error("incomplete_session_frame");
    options.credentials?.close();
    await calls;
  } finally { options.credentials?.close(); await worker.close(); await calls.catch(() => undefined); }
}
