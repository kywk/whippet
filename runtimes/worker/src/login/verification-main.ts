import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUniqueJSON } from "../strict-json.js";
import { CredentialClient } from "./client.js";
import { validateVerificationInput, verificationFailure, verifyWorkspaceLogin, type VerificationResult } from "./verification.js";

const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop.abort());

async function main(): Promise<void> {
  const work = process.env.WHIPPET_WORK_DIR ?? "/work";
  const output = join(work, "output");
  await mkdir(output, { mode: 0o700 });
  let result: VerificationResult = verificationFailure("invalid_evidence");
  let deadline: AbortSignal | undefined;
  let credentials: CredentialClient | undefined;
  let cancel: (() => void) | undefined;
  try {
    const path = join(work, "input.json");
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2 << 20) throw new Error("invalid_evidence");
    const input = validateVerificationInput(parseUniqueJSON(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path))));
    deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = AbortSignal.any([stop.signal, deadline]);
    const client = new CredentialClient(input);
    credentials = client;
    cancel = () => client.close();
    signal.addEventListener("abort", cancel, { once: true });
    // The packaged Chromium is the default. Tests can use the same approved
    // executable override as the ordinary Worker.
    result = await verifyWorkspaceLogin(input, (accountId, target) => client.resolveAccount(accountId, target), signal, process.env.WHIPPET_BROWSER_EXECUTABLE_PATH);
    signal.removeEventListener("abort", cancel);
  } catch { /* Keep fixed evidence for invalid input or infrastructure failure. */ }
  finally { credentials?.close(); credentials?.secrets.clear(); }
  if (stop.signal.aborted) result = { status: "cancelled" };
  else if (deadline?.aborted) result = { status: "timed_out" };
  const temporary = join(output, ".result.tmp");
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, join(output, "result.json"));
  process.exitCode = { succeeded: 0, failed: 1, timed_out: 124, cancelled: 130 }[result.status];
}

main().catch(() => { process.exitCode = 1; });
