import { randomUUID } from "node:crypto";
import { attemptIO } from "../attempt-io.js";
import { AIError } from "../ai/config.js";

export const modelOperationID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ModelCredential { agentId: string; secretVersion: number }

export function validModelCredential(value: unknown): value is ModelCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as ModelCredential;
  return Object.keys(credential).length === 2 && typeof credential.agentId === "string" && modelOperationID.test(credential.agentId) &&
    Number.isSafeInteger(credential.secretVersion) && credential.secretVersion > 0;
}

export function validModelKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

export function containsModelKey(serialized: string, key: string): boolean {
  return key !== "" && [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)].some(value => serialized.includes(value));
}

export function requestModelKey(credential: ModelCredential, signal: AbortSignal, io?: Parameters<typeof attemptIO>[0]): Promise<string> {
  const failure = () => new AIError("missing_key");
  if (!validModelCredential(credential) || signal.aborted) return Promise.reject(failure());
  const requestId = randomUUID();
  const transport = attemptIO(io);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(fail, 15000);
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    function finish(key?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
      unsubscribe?.();
      if (key === undefined || signal.aborted) reject(failure());
      else resolve(key);
    }
    function fail() { finish(); }
    signal.addEventListener("abort", fail, { once: true });
    unsubscribe = transport.subscribe("model_key_response", frame => {
      if (frame.requestId !== requestId) return;
      if (Object.keys(frame).length !== 5 || frame.agentId !== credential.agentId || frame.secretVersion !== credential.secretVersion || !validModelKey(frame.apiKey)) fail();
      else finish(frame.apiKey);
    }, fail);
    if (settled || signal.aborted) { unsubscribe(); fail(); return; }
    transport.send({ kind: "model_key_request", requestId, ...credential }, fail);
  });
}
