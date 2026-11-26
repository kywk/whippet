import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelOperationID, requestModelKey, validModelCredential } from "./model-key.js";
import { runModelProbe } from "./model-probe.js";
import { managedModelConfig, validRuntime } from "./runtime.js";

type Outcome = { status: "succeeded" | "cancelled"; code: null } |
  { status: "timed_out"; code: "probe_timed_out" } |
  { status: "failed"; code: "key_missing" | "provider_auth_failed" | "provider_unavailable" | "probe_failed" };
const workDir = process.env.WHIPPET_WORK_DIR ?? "/work";

async function provision(stop: AbortSignal): Promise<Outcome> {
  if (!process.argv.includes("--managed-model-key")) return { status: "failed", code: "key_missing" };
  const path = join(workDir, "input.json");
  const info = await lstat(path);
  if (!info.isFile() || info.size > 16 * 1024) return { status: "failed", code: "probe_failed" };
  const input = JSON.parse(await readFile(path, "utf8"));
  if (!input || typeof input.operationId !== "string" || !modelOperationID.test(input.operationId) ||
    typeof input.workspaceId !== "string" || !modelOperationID.test(input.workspaceId) || typeof input.deadlineAt !== "string" ||
    Object.keys(input).length !== 6 || !validRuntime(input.runtime)) return { status: "failed", code: "probe_failed" };
  const credential = { agentId: input.agentId, secretVersion: input.secretVersion };
  const remaining = Date.parse(input.deadlineAt) - Date.now();
  if (!validModelCredential(credential) || !Number.isFinite(remaining)) return { status: "failed", code: "probe_failed" };
  if (remaining <= 0) return { status: "timed_out", code: "probe_timed_out" };
  const timeout = AbortSignal.timeout(Math.min(30000, remaining));
  const signal = AbortSignal.any([stop, timeout]);
  const key = await requestModelKey(credential, signal).catch(() => "").finally(() => process.stdin.destroy());
  const config = key ? managedModelConfig(input.runtime, key) : undefined;
  try {
    const result = config ? await runModelProbe(config, input.operationId, { signal }) : "key_missing";
    if (stop.aborted) return { status: "cancelled", code: null };
    if (timeout.aborted) return { status: "timed_out", code: "probe_timed_out" };
    return result === "passed" ? { status: "succeeded", code: null } : { status: "failed", code: result };
  } finally {
    if (config) config.apiKey = "";
  }
}

const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
try {
  const outcome = await provision(stop.signal).catch((): Outcome => ({ status: "failed", code: "probe_failed" }));
  const output = join(workDir, "output");
  await mkdir(output);
  const temporary = join(output, ".probe.json.tmp");
  await writeFile(temporary, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  await rename(temporary, join(output, "probe.json"));
} catch {
  process.exitCode = 1;
}
