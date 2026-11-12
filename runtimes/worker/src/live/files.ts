import { open, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export const MAX_SDP = 128 * 1024;
export const MAX_JPEG = 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface LiveControl {
  viewerId: string;
  mode: "webrtc" | "jpeg";
  expiresAt: number;
  iceServers: RTCIceServer[];
  answer?: string;
  answerOfferId?: string;
}
export async function boundedRead(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) throw new Error("Invalid live file");
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) throw new Error("Live file too large");
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Live operation timed out")), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function readControl(dir: string, now = Date.now()): Promise<LiveControl | undefined> {
  try {
    const v = JSON.parse((await boundedRead(join(dir, "control.json"), 192 * 1024)).toString()) as LiveControl;
    if (!UUID.test(v.viewerId) || !["webrtc", "jpeg"].includes(v.mode) || !Number.isFinite(v.expiresAt) ||
      v.expiresAt <= now || v.expiresAt > now + 35000 || !Array.isArray(v.iceServers) || v.iceServers.length > 8 ||
      (v.answer !== undefined && (typeof v.answer !== "string" || Buffer.byteLength(v.answer) > MAX_SDP)) ||
      (v.answerOfferId!==undefined&&(typeof v.answerOfferId!=="string"||!UUID.test(v.answerOfferId)))) return undefined;
    return v;
  } catch { return undefined; }
}
export async function replaceFile(path: string, data: string | Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}

// Explicit allowlist: helper browser subprocesses never inherit AI/Manager keys.
export function mediaEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"])
    if (env[key] !== undefined) out[key] = env[key]!;
  return out;
}
