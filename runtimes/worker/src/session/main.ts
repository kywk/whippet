import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { explorationBrowser } from "../author/tools.js";
import { SessionWorker, validateSessionInput } from "./session.js";
import { runSessionIPC, sessionOutput } from "./ipc.js";
import { SessionCredentialClient } from "./credentials.js";
import { parseUniqueJSON } from "../strict-json.js";

async function main(): Promise<void> {
  const inputPath = join(process.env.WHIPPET_WORK_DIR ?? "/work", "input.json");
  const stat = await lstat(inputPath);
  if (!stat.isFile() || stat.size > 16 << 20) throw new Error("invalid_session_input");
  const input = validateSessionInput(parseUniqueJSON(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(inputPath))));
  const writer = sessionOutput(process.stdout);
  const credentials = new SessionCredentialClient(input, frame => writer.send(frame));
  const browser = explorationBrowser(process.env, { scope: input.workspaceContext.config!, workspaceContext: input.workspaceContext, credentials });
  try {
    await runSessionIPC(new SessionWorker(input, browser, async roleId =>
      input.workspaceContext.roleRefs.some(ref => ref.roleId === roleId && ref.configured)), process.stdin, process.stdout, { writer, credentials });
  } finally { credentials.close(); }
}

main().catch(() => { process.exitCode = 1; });
