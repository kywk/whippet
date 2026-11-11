import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readAIConfig } from "../ai/config.js";
import { runAuthor } from "./loop.js";
import { explorationBrowser, type ExplorationBrowser } from "./tools.js";
import { AuthorError, authorNeedsBrowser, validateAuthorInput } from "./types.js";
import {CredentialClient} from '../login/client.js';
import {unconfirmedBrowserScope} from './scope.js';

const workDir = resolve(process.env.WHIPPET_WORK_DIR ?? "/work");
const outputDir = join(workDir, "output");
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop.abort());

async function save(name: string, data: unknown): Promise<void> {
  const temp = join(outputDir, `.${name}.tmp`);
  await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await rename(temp, join(outputDir, name));
}

async function main(): Promise<void> {
  let browser: ExplorationBrowser | undefined;
  let credentials:CredentialClient|undefined;
  let result: { status: "succeeded" | "failed" | "timed_out" | "cancelled"; error?: string };
  try {
    await mkdir(outputDir);
    const info = await lstat(join(workDir, "input.json"));
    if (!info.isFile() || info.size > 13 * 1024 * 1024) throw new AuthorError("invalid_input");
    const input = validateAuthorInput(JSON.parse(await readFile(join(workDir, "input.json"), "utf8")) as unknown);
    if(input.workspaceId)credentials=new CredentialClient(input);
    if (authorNeedsBrowser(input)) browser = explorationBrowser(process.env,{scope:input.workspaceContext?.config??unconfirmedBrowserScope(),credentials});
    const output = await runAuthor(input, readAIConfig(process.env), browser, {
      signal: stop.signal,
      progress: (message) => process.stdout.write(`${JSON.stringify({ kind: "log", message })}\n`),
      secrets:credentials?.secrets,
    });
    if (stop.signal.aborted) throw new AuthorError("cancelled");
    await save("author.json", output);
    result = { status: "succeeded" };
  } catch (error) {
    const safe = error instanceof AuthorError ? error : new AuthorError("provider_failed");
    result = { status: stop.signal.aborted || safe.code === "cancelled" ? "cancelled" : safe.code === "timed_out" ? "timed_out" : "failed", error: safe.message };
  } finally {
    credentials?.close();
    // Manager independently reclaims the container even if the browser hangs.
    let timer: NodeJS.Timeout | undefined;
    try { if (browser) await Promise.race([browser.close().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  await save("result.json", result);
  // Never print model, browser, tool arguments, provider bodies or env values.
  process.stdout.write(`${JSON.stringify({ kind: "log", message: `Author task ${result.status}` })}\n`);
  process.exitCode = { succeeded: 0, failed: 1, timed_out: 124, cancelled: 130 }[result.status];
}

main().catch(() => {
  process.stderr.write("Author output persistence failed; details hidden\n");
  process.exitCode = 1;
});
