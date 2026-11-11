import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decideResult, type RuntimeSummary, type WorkerResult } from "./result.js";
import { exportHTMLReport } from "./report-artifacts.js";
import { exportFailureArtifacts } from "./failure-artifacts.js";
import { fixtureBridge } from "./live/fixture-bridge.js";
import { validateWorkspaceSettings, type WorkspaceSettings } from "./workspace.js";
import {validateWorkspaceContext,type WorkspaceContext} from './workspace-context.js';
import {CredentialClient} from './login/client.js';
import {loginBroker} from './login/broker.js';
import {sanitizeLoginOutputs} from './login/artifacts.js';
import {unconfirmedBrowserScope} from './author/scope.js';

interface Input {
  workspaceId?:string;testId?:string|null;workspaceContext?:WorkspaceContext|null;scriptOrigin?:'ai'|'manual'|'legacy';
  runId: string;
  attemptId: string;
  script: string;
  timeoutMs: number;
  workspaceSettings?: WorkspaceSettings;
}

const workDir = resolve(process.env.WHIPPET_WORK_DIR ?? "/work");
const outputDir = join(workDir, "output");
const require = createRequire(import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let child: ChildProcess | undefined;
let cancelled = false;
let killTimer: NodeJS.Timeout | undefined;
let credentials:CredentialClient|undefined;
let broker:Awaited<ReturnType<typeof loginBroker>>|undefined;

function log(message: string): void {
  process.stdout.write(`${JSON.stringify({ kind: "log", message: (credentials?.secrets.redact(message)??message).slice(0, 8192) })}\n`);
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
  validateWorkspaceSettings(input.workspaceSettings);
  if(input.scriptOrigin!==undefined&&!['ai','manual','legacy'].includes(input.scriptOrigin))throw new Error('invalid_script_origin');
  if(input.workspaceId!==undefined){
    if(!uuid.test(input.workspaceId)||typeof input.testId!=='string'||!uuid.test(input.testId))throw new Error('invalid_workspace_owner');
    validateWorkspaceContext(input.workspaceContext,input.workspaceId);
    if(input.scriptOrigin!=='manual'&&!input.workspaceContext?.config?.targets.length)throw new Error('scope_confirmation_required');
  }
  return {...input,scriptOrigin:input.scriptOrigin??'legacy'} as Input;
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
  await writeFile(bridgePath, fixtureBridge(new URL("./live/observer.js", import.meta.url).href,{scopeURL:new URL('./author/scope.js',import.meta.url).href,scope:input.scriptOrigin!=='manual'?input.workspaceContext?.config??unconfirmedBrowserScope():null,privacyURL:new URL('./login/privacy.js',import.meta.url).href}), "utf8");
  const loginShim=join(taskDir,'login.cjs');await writeFile(loginShim,`exports.loginAs=async(...args)=>(await import(${JSON.stringify(new URL('./login/helper.js',import.meta.url).href)})).loginAs(...args);\n`,'utf8');
  const tsconfigPath = join(taskDir, "tsconfig.json");
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { baseUrl: taskDir, paths: { "@playwright/test": [bridgePath],"whippet/login":[loginShim] } } }), "utf8");
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
      ["html", { outputFolder: htmlDir, open: "never", attachmentsBaseURL: "data/", noCopyPrompt: true }],
      ["json", { outputFile: join(outputDir, "results.json") }],
    ],
    projects: [{ name: "chromium", use: {
      browserName: "chromium", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off",
      ...(input.workspaceSettings?.defaultTestUrl ? { baseURL: input.workspaceSettings.defaultTestUrl } : {}),
    } }],
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
    env: { ...process.env,...(broker?{WHIPPET_LOGIN_SOCKET:broker.path}:{}), CI: "1", FORCE_COLOR: "0", PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: "data/", PLAYWRIGHT_HTML_NO_COPY_PROMPT: "1" },
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
  await exportFailureArtifacts(htmlDir, join(outputDir, "test-results"), outputDir,
    (reason) => log(`Optional failure evidence skipped: ${reason}`));
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
    if(input.workspaceId){credentials=new CredentialClient(input);broker=await loginBroker(credentials);}
    taskDir = await mkdtemp(join(tmpdir(), "whippet-playwright-"));
    result = await execute(input, taskDir);
  } catch (error) {
    result = { status: cancelled ? "cancelled" : "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) };
    log(`Worker infrastructure error: ${result.error}`);
  }
  credentials?.close();if(broker)await broker.close();
  if(credentials){try{await sanitizeLoginOutputs(outputDir,credentials.secrets,log);}catch{result={status:cancelled?'cancelled':'failed',error:'Credential evidence could not be safely retained'};for(const name of ['report.html','results.json','data'])await rm(join(outputDir,name),{recursive:true,force:true});}}
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
