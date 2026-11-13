import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { explorationBrowser } from "../author/tools.js";
import { SessionWorker, validateSessionInput } from "./session.js";
import { runSessionIPC } from "./ipc.js";

async function main(): Promise<void> {
  const inputPath = join(process.env.WHIPPET_WORK_DIR ?? "/work", "input.json");
  const stat = await lstat(inputPath);
  if (!stat.isFile() || stat.size > 1 << 20) throw new Error("invalid_session_input");
  const input = validateSessionInput(JSON.parse(await readFile(inputPath, "utf8")) as unknown);
  const browser = explorationBrowser(process.env, { scope: input.workspaceContext.config! });
  await runSessionIPC(new SessionWorker(input, browser), process.stdin, process.stdout);
}

main().catch(() => { process.exitCode = 1; });
