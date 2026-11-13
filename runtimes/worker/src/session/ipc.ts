import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { maxSessionFrameBytes, SessionWorker, type SessionCall } from "./session.js";

async function send(output: Writable, frame: unknown): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line) > maxSessionFrameBytes) throw new Error("session_frame_too_large");
  if (!output.write(line)) await once(output, "drain");
}

export async function runSessionIPC(worker: SessionWorker, input: Readable, output: Writable): Promise<void> {
  let pending = Buffer.alloc(0);
  try {
    await send(output, worker.ready());
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
        let frame: SessionCall;
        try { frame = JSON.parse(frameBytes.toString("utf8")) as SessionCall; } catch { throw new Error("invalid_session_frame"); }
        await send(output, await worker.call(frame));
      }
      if (pending.length > maxSessionFrameBytes) throw new Error("session_frame_too_large");
    }
    if (pending.length !== 0) throw new Error("incomplete_session_frame");
  } finally { await worker.close(); }
}
