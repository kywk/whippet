import { ModuleDiagnostics } from "./module-diagnostics.js";
import { HarnessClient } from "./harness.js";
import { moduleAuthor, plannerAuthor } from "./platform.js";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readAIConfig } from "../ai/config.js";
import { runAuthor } from "./loop.js";
import { explorationBrowser, type ExplorationBrowser } from "./tools.js";
import { AuthorError, serializeAuthorArtifact, authorNeedsBrowser, validateAuthorInput } from "./types.js";
import {CredentialClient} from '../login/client.js';
import {unconfirmedBrowserScope} from './scope.js';
import { hasHistory, HistoryClient } from "./history.js";

const workDir = resolve(process.env.WHIPPET_WORK_DIR ?? "/work");
const outputDir = join(workDir, "output");
const stop = new AbortController();
const diagnostics=process.env.WHIPPET_M109_DIAGNOSTICS === '1' ? new ModuleDiagnostics():undefined;
const emitDiagnostic=(value:object)=>process.stdout.write(`${JSON.stringify({kind:'log',message:'m109_diagnostic:'+JSON.stringify(value)})}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop.abort());

async function save(name: string, data: unknown, primary?: string): Promise<void> {
  const temp = join(outputDir, `.${name}.tmp`);
  await writeFile(temp, name === "author.json" ? serializeAuthorArtifact(data,primary) : `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await rename(temp, join(outputDir, name));
}

async function main(): Promise<void> {
  let browser: ExplorationBrowser | undefined;
  let credentials:CredentialClient|undefined;
  let harness: HarnessClient | undefined;
  let history: HistoryClient | undefined;
  let result: { status: "succeeded" | "failed" | "timed_out" | "cancelled"; error?: string };
  try {
    await mkdir(outputDir);
    const info = await lstat(join(workDir, "input.json"));
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new AuthorError("invalid_input");
    const input = validateAuthorInput(JSON.parse(await readFile(join(workDir, "input.json"), "utf8")) as unknown);
    if(input.workspaceId)credentials=new CredentialClient(input);
    if(moduleAuthor(input)||plannerAuthor(input))harness=new HarnessClient(input);
    if(hasHistory(input))history=new HistoryClient(input);
    if (authorNeedsBrowser(input)) browser = explorationBrowser(process.env,{scope:input.workspaceContext?.config??unconfirmedBrowserScope(),credentials,defaultTestUrl:input.workspaceContext?.config?.defaultTestUrl||input.workspaceSettings?.defaultTestUrl,timeoutMs:input.workspaceContext?.config?.timeoutMs||input.workspaceSettings?.timeoutMs});
    const output = await runAuthor(input, readAIConfig(process.env), browser, {
      signal: stop.signal,
      ...(diagnostics?{moduleDiagnostics:diagnostics}:{}),
      ...(diagnostics || process.env.WHIPPET_M106_OBSERVE === "1" ? {observer:(event:string)=>process.stdout.write(`${JSON.stringify({kind:"log",message:event})}\n`)} : {}),
      progress: (message) => process.stdout.write(`${JSON.stringify({ kind: "log", message })}\n`),
      secrets:credentials?.secrets,
      history, harness,
    });
    if (stop.signal.aborted) throw new AuthorError("cancelled");
    try{await save("author.json", output, input.author.skillId);}catch(error){diagnostics?.failure('ARTIFACT_WRITE_FAILED');throw error;}
    result = { status: "succeeded" };
  } catch (error) {
    diagnostics?.failure(stop.signal.aborted || error instanceof AuthorError && error.code==='cancelled'?'CANCELLED':error instanceof AuthorError && error.code==='timed_out'?'TIMEOUT':error instanceof AuthorError && error.code==='invalid_response'?'INVALID_RESPONSE':'UNKNOWN');
    const safe = error instanceof AuthorError ? error : new AuthorError("provider_failed");
    result = { status: stop.signal.aborted || safe.code === "cancelled" ? "cancelled" : safe.code === "timed_out" ? "timed_out" : "failed", error: safe.message };
  } finally {
    credentials?.close();
    history?.close();
    harness?.close();
    // Manager independently reclaims the container even if the browser hangs.
    let timer: NodeJS.Timeout | undefined;
    try { if (browser) await Promise.race([browser.close().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  await save("result.json", result);
  diagnostics?.finish(result.status==='succeeded'?'COMPLETED':'UNKNOWN',emitDiagnostic);
  // Never print model, browser, tool arguments, provider bodies or env values.
  process.stdout.write(`${JSON.stringify({ kind: "log", message: `Author task ${result.status}` })}\n`);
  process.exitCode = { succeeded: 0, failed: 1, timed_out: 124, cancelled: 130 }[result.status];
}

main().catch(() => {
  diagnostics?.finish('ARTIFACT_WRITE_FAILED',emitDiagnostic);
  process.stderr.write("Author output persistence failed; details hidden\n");
  process.exitCode = 1;
});
