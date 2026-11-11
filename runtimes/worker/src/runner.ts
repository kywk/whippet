import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decideResult, type RuntimeSummary, type WorkerResult } from "./result.js";
import { exportHTMLReport } from "./report-artifacts.js";
import { fixtureBridge } from "./live/fixture-bridge.js";

interface Input {
  runId: string;
  attemptId: string;
  script: string;
  timeoutMs: number;
}

const workDir = resolve(process.env.WHIPPET_WORK_DIR ?? "/work");
const outputDir = join(workDir, "output");
const require = createRequire(import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let child: ChildProcess | undefined;
let cancelled = false;
let killTimer: NodeJS.Timeout | undefined;

function log(message: string): void {
  process.stdout.write(`${JSON.stringify({ kind: "log", message: message.slice(0, 8192) })}\n`);
}

function stopChild(): void {
  const pid = child?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* Already exited. */ }
  if (killTimer) return;
  killTimer = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ }
  }, 5000);
  killTimer.unref();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { cancelled = true; stopChild(); });
}

function validateInput(value: unknown): Input {
  const input = value as Partial<Input> | null;
  if (
    !input || typeof input.runId !== "string" || !uuid.test(input.runId) ||
    typeof input.attemptId !== "string" || !uuid.test(input.attemptId) ||
    typeof input.script !== "string" || input.script.trim() === "" || Buffer.byteLength(input.script) > 2 * 1024 * 1024 ||
    typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3600000
  ) throw new Error("input.json requires UUID runId/attemptId, a script <=2MiB and timeoutMs in 1..3600000");
  return input as Input;
}

async function readJSON(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size > 0;
  } catch { return false; }
}

function forwardLine(line: string): void {
  // Playwright's custom reporter already emits NDJSON. Loader diagnostics and
  // top-level script console output are wrapped too, so stdout stays NDJSON.
  try {
    const event = JSON.parse(line) as { kind?: string; message?: string };
    if (event.kind === "log" && typeof event.message === "string") {
      log(event.message);
      return;
    }
  } catch { /* Plain CLI output. */ }
  if (line) log(line);
}

async function execute(input: Input, taskDir: string): Promise<WorkerResult> {
  const packageDir = dirname(require.resolve("@playwright/test/package.json"));
  // Keep the generated spec isolated while making its @playwright/test import
  // resolvable. /work is a bind mount, outside the image's node_modules tree.
  await symlink(resolve(packageDir, "../.."), join(taskDir, "node_modules"), "dir");
  await writeFile(join(taskDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  await writeFile(join(taskDir, "run.spec.ts"), input.script, "utf8");
  const bridgePath = join(taskDir, "live-fixture.cjs");
  await writeFile(bridgePath, fixtureBridge(new URL("./live/observer.js", import.meta.url).href), "utf8");
  const tsconfigPath = join(taskDir, "tsconfig.json");
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { baseUrl: taskDir, paths: { "@playwright/test": [bridgePath] } } }), "utf8");
  const summaryPath = join(taskDir, "runtime-summary.json");
  const htmlDir = join(outputDir, "html");
  const reporterPath = fileURLToPath(new URL("./reporter.js", import.meta.url));
  const config = {
    tsconfig: tsconfigPath,
    testDir: taskDir,
    testMatch: "run.spec.ts",
    outputDir: join(outputDir, "test-results"),
    workers: 1,
    fullyParallel: false,
    retries: 0,
    forbidOnly: true,
    timeout: input.timeoutMs,
    globalTimeout: input.timeoutMs,
    reporter: [
      [reporterPath, { summaryPath }],
      ["html", { outputFolder: htmlDir, open: "never", attachmentsBaseURL: "data/" }],
      ["json", { outputFile: join(outputDir, "results.json") }],
    ],
    projects: [{ name: "chromium", use: { browserName: "chromium", headless: true, trace: "off", screenshot: "only-on-failure", video: "off" } }],
  };
  const configPath = join(taskDir, "playwright.config.cjs");
  await writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`, "utf8");
  if (cancelled) return { status: "cancelled", error: "Worker stopped before Playwright launch" };
  log(`Executing run ${input.runId}, attempt ${input.attemptId}`);
  let launchError: string | undefined;
  let watchdogExpired = false;
  child = spawn(process.execPath, [join(packageDir, "cli.js"), "test", "--config", configPath], {
    cwd: taskDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: "data/" },
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout) createInterface({ input: stdout }).on("line", forwardLine);
  if (stderr) createInterface({ input: stderr }).on("line", (line: string) => log(line));
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    stopChild();
  }, input.timeoutMs + 10000);
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((done) => {
      child!.once("error", (error: Error) => { launchError = `Cannot launch Playwright: ${error.message}`; });
      child!.once("close", (code: number | null) => done(code));
    });
  } finally {
    clearTimeout(watchdog);
    if (killTimer) clearTimeout(killTimer);
    child = undefined;
  }
  // This is the actual built-in Playwright HTML reporter output. Never create
  // a placeholder HTML file when Playwright fails to generate one.
  if (await regularFile(join(htmlDir, "index.html"))) {
    await exportHTMLReport(htmlDir, outputDir);
  }
  let json: unknown;
  let summary: RuntimeSummary | undefined;
  try { json = await readJSON(join(outputDir, "results.json")); } catch { /* Evidence missing -> failed. */ }
  try { summary = await readJSON(summaryPath) as RuntimeSummary; } catch { /* Reporter failure -> failed. */ }
  return decideResult({
    exitCode, cancelled, watchdogExpired, reportReady: await regularFile(join(outputDir, "report.html")), json, summary, launchError,
  });
}

async function main(): Promise<void> {
  let taskDir: string | undefined;
  let result: WorkerResult;
  try {
    // Exclusive mkdir prevents stale outputs from making a reused work
    // directory look successful. Manager supplies a fresh mount per attempt.
    await mkdir(outputDir);
    const info = await lstat(join(workDir, "input.json"));
    if (!info.isFile() || info.size > 13 * 1024 * 1024) throw new Error("input.json is not a regular file <=13MiB");
    const input = validateInput(await readJSON(join(workDir, "input.json")));
    taskDir = await mkdtemp(join(tmpdir(), "whippet-playwright-"));
    result = await execute(input, taskDir);
  } catch (error) {
    result = { status: cancelled ? "cancelled" : "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) };
    log(`Worker infrastructure error: ${result.error}`);
  }
  // Manager reads this file only after the container stops. Rename still
  // prevents a partially written manifest if the Worker receives SIGKILL.
  const temporary = join(outputDir, ".result.tmp");
  await writeFile(temporary, `${JSON.stringify(result)}\n`, "utf8");
  await rename(temporary, join(outputDir, "result.json"));
  log(`Worker result: ${result.status}`);
  if (taskDir) await rm(taskDir, { recursive: true, force: true });
  process.exitCode = { succeeded: 0, failed: 1, timed_out: 124, cancelled: 130 }[result.status];
}

main().catch((error: unknown) => {
  log(`Cannot persist Worker result: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
