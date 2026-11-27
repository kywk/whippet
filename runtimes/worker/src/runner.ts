import { runBundle, writeRunFiles, MAX_INPUT_BYTES, type RunFile } from "./bundle.js";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import {parseUniqueJSON} from './strict-json.js';
import {sanitizeLoginOutputs} from './login/artifacts.js';
import {unconfirmedBrowserScope} from './author/scope.js';
import { installModuleABI, validModuleABI, type ModuleABI } from './module-abi.js';
import { startTestHarness, type TestHarness } from "./test-harness.js";
import { deploymentObservation, validateRetestTarget, watchDeployment, type RetestTarget } from "./deployment-retest.js";
import { boundedRead, mediaEnvironment } from "./live/files.js";

interface Input {
  workspaceId?:string;testId?:string|null;workspaceContext?:WorkspaceContext|null;scriptOrigin?:'ai'|'manual'|'legacy';
  runId: string;
  attemptId: string;
  script: string;
  files?: RunFile[];
  moduleAbi?: ModuleABI;
  timeoutMs: number;
  workspaceSettings?: WorkspaceSettings;
  retest?: RetestTarget;
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
    typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3600000
  ) throw new Error("input.json requires UUID runId/attemptId, a script <=2MiB and timeoutMs in 1..3600000");
  const bundle = runBundle(input);
  if (input.moduleAbi !== undefined && (!validModuleABI(input.moduleAbi) || !bundle.files || bundle.files.length !== 2 ||
      !bundle.files.some(file => file.path === `lib/${input.moduleAbi!.slug}.ts`))) throw new Error('invalid_module_abi');
  if (bundle.files && bundle.origin === "ai" && (!input.workspaceId || !input.workspaceContext?.config?.targets.length)) throw new Error("scope_confirmation_required");
  validateWorkspaceSettings(input.workspaceSettings);
  if(input.scriptOrigin!==undefined&&!['ai','manual','legacy'].includes(input.scriptOrigin))throw new Error('invalid_script_origin');
  if(input.workspaceId!==undefined){
    if(!uuid.test(input.workspaceId)||typeof input.testId!=='string'||!uuid.test(input.testId))throw new Error('invalid_workspace_owner');
    validateWorkspaceContext(input.workspaceContext,input.workspaceId);
    if(bundle.origin!=='manual'&&!input.workspaceContext?.config?.targets.length)throw new Error('scope_confirmation_required');
  }
  if (input.retest !== undefined) validateRetestTarget(input.retest, input.workspaceContext);
  return {...input,script:bundle.script,files:bundle.files,scriptOrigin:bundle.origin} as Input;
}

async function readJSON(path: string): Promise<unknown> {
  return parseUniqueJSON(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)));
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

async function execute(input: Input, taskDir: string, harness: TestHarness): Promise<WorkerResult> {
  const packageDir = dirname(require.resolve("@playwright/test/package.json"));
  // Keep the generated spec isolated while making its @playwright/test import
  // resolvable. /work is a bind mount, outside the image's node_modules tree.
  await symlink(resolve(packageDir, "../.."), join(taskDir, "node_modules"), "dir");
  await writeFile(join(taskDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  if (input.files) await writeRunFiles(taskDir, input.files);
  else await writeFile(join(taskDir, "run.spec.ts"), input.script, "utf8");
  if (input.moduleAbi) await installModuleABI(taskDir, input.moduleAbi);
  if (input.files && harness.networkIsolated) {
    for (const directory of ["tests", "lib"]) {
      const root = join(taskDir, directory);
      for (const file of await readdir(root).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) await harness.grantAccess(join(root, file));
    }
  }
  const bridgePath = join(taskDir, "live-fixture.cjs");
  await writeFile(bridgePath, fixtureBridge(new URL("./live/observer.js", import.meta.url).href, {
    scopeURL: new URL("./author/scope.js", import.meta.url).href,
    scope: input.workspaceContext?.config ?? unconfirmedBrowserScope(),
    privacyURL: new URL("./login/privacy.js", import.meta.url).href,
    jpegOnly: harness.networkIsolated,
  }), "utf8");
  const loginShim=join(taskDir,'login.cjs');await writeFile(loginShim,`const helper=()=>import(${JSON.stringify(new URL('./login/helper.js',import.meta.url).href)});\nexports.loginAs=async(...args)=>(await helper()).loginAs(...args);\nexports.loginAsAccount=async(...args)=>(await helper()).loginAsAccount(...args);\n`,'utf8');
  const tsconfigPath = join(taskDir, "tsconfig.json");
  await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { baseUrl: taskDir, paths: { "@playwright/test": [bridgePath],"whippet/login":[loginShim], ...(input.files ? { "@lib/*": ["lib/*"] } : {}) } } }), "utf8");
  const summaryPath = join(taskDir, "runtime-summary.json");
  const htmlDir = join(taskDir, "html");
  const resultsPath = join(taskDir, "results.json");
  const playwrightOutput = join(taskDir, "test-results");
  const reporterPath = fileURLToPath(new URL("./reporter.js", import.meta.url));
  const baseURL = input.workspaceContext?.config?.defaultTestUrl || input.workspaceSettings?.defaultTestUrl;
  const config = {
    tsconfig: tsconfigPath,
    testDir: taskDir,
    testMatch: input.files ? "tests/test.spec.ts" : "run.spec.ts",
    outputDir: playwrightOutput,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    forbidOnly: true,
    timeout: input.timeoutMs,
    globalTimeout: input.timeoutMs,
    reporter: [
      [reporterPath, { summaryPath, retest: !!input.retest }],
      ["html", { outputFolder: htmlDir, open: "never", attachmentsBaseURL: "data/", noCopyPrompt: true }],
      ["json", { outputFile: resultsPath }],
    ],
    projects: [{ name: "chromium", use: {
      browserName: "chromium", headless: true, proxy: harness.proxy,
      ...(process.env.WHIPPET_BROWSER_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.WHIPPET_BROWSER_EXECUTABLE_PATH } } : {}),
      trace: "retain-on-failure", screenshot: "only-on-failure", video: "off",
      ...(baseURL ? { baseURL } : {}),
    } }],
  };
  const configPath = join(taskDir, "playwright.config.cjs");
  await writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`, "utf8");
  if (cancelled) return { status: "cancelled", error: "Worker stopped before Playwright launch" };
  log(`Executing run ${input.runId}, attempt ${input.attemptId}`);
  let launchError: string | undefined;
  let watchdogExpired = false;
  child = harness.spawn([join(packageDir, "cli.js"), "test", "--config", configPath], {
    cwd: taskDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  }, {
    ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: workDir,
    ...(broker ? { WHIPPET_LOGIN_SOCKET: broker.path } : {}),
    CI: "1", FORCE_COLOR: "0", PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: "data/", PLAYWRIGHT_HTML_NO_COPY_PROMPT: "1",
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
    await harness.stopScripts();
  }
  // This is the actual built-in Playwright HTML reporter output. Never create
  // a placeholder HTML file when Playwright fails to generate one.
  await exportFailureArtifacts(htmlDir, playwrightOutput, outputDir,
    (reason) => log(`Optional failure evidence skipped: ${reason}`));
  if ((await lstat(htmlDir).catch(() => undefined))?.isDirectory() && await regularFile(join(htmlDir, "index.html"))) {
    await exportHTMLReport(htmlDir, outputDir);
  }
  let json: unknown;
  let summary: RuntimeSummary | undefined;
  try {
    const report = await boundedRead(resultsPath, MAX_INPUT_BYTES);
    const parsed: unknown = JSON.parse(report.toString());
    await writeFile(join(outputDir, "results.json"), report);
    json = parsed;
  } catch { /* Evidence missing -> failed. */ }
  try { summary = JSON.parse((await boundedRead(summaryPath, 1024 * 1024)).toString()) as RuntimeSummary; } catch { /* Reporter failure -> failed. */ }
  const result = decideResult({
    exitCode, cancelled, watchdogExpired, reportReady: await regularFile(join(outputDir, "report.html")), json, summary, launchError,
  });
  const targetOrigin = harness.networkIsolated ? harness.reachedTargetOrigin() : undefined;
  if (input.retest) {
    result.retest = deploymentObservation(input.retest, false);
    if (summary?.retestChecks) result.retest.checks = summary.retestChecks;
  }
  return targetOrigin ? { ...result, targetOrigin } : result;
}

async function main(): Promise<void> {
  let taskRoot: string | undefined;
  let harness: TestHarness | undefined;
  let deploymentWatch: Awaited<ReturnType<typeof watchDeployment>> | undefined;
  let result: WorkerResult;
  try {
    // Exclusive mkdir prevents stale outputs from making a reused work
    // directory look successful. Manager supplies a fresh mount per attempt.
    await mkdir(outputDir);
    const info = await lstat(join(workDir, "input.json"));
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error("input.json is not a regular file <=64MiB");
    const input = validateInput(await readJSON(join(workDir, "input.json")));
    harness = await startTestHarness(input.workspaceContext?.config ?? unconfirmedBrowserScope(), input.retest);
    if (input.workspaceId) {
      credentials = new CredentialClient(input);
      broker = await loginBroker(credentials, harness.credentialUID);
    }
    if (harness.networkIsolated && (await lstat(join(workDir, "live")).catch(() => undefined))?.isDirectory()) {
      await chmod(workDir, 0o711);
      await harness.grantAccess(join(workDir, "live"));
    }
    taskRoot = await mkdtemp(join(tmpdir(), "whippet-playwright-"));
    const taskDir = join(taskRoot, "test");
    await mkdir(taskDir, { mode: 0o700 });
    await harness.configureTask(taskRoot, taskDir);
    if (input.retest) {
      deploymentWatch = await watchDeployment(input.retest);
      if (deploymentWatch.ready) {
        result = await execute(input, taskDir, harness);
        const stable = await deploymentWatch.finish();
        result.retest = deploymentObservation(input.retest,
          stable && harness.networkIsolated && harness.verifiedDeploymentTraffic(), result.retest?.checks);
      } else {
        result = { status: "failed", error: "Target deployment could not be verified",
          retest: deploymentObservation(input.retest, false) };
      }
    } else {
      result = await execute(input, taskDir, harness);
    }
  } catch (error) {
    result = { status: cancelled ? "cancelled" : "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) };
    log(`Worker infrastructure error: ${result.error}`);
  }
  deploymentWatch?.close();
  await harness?.close();
  credentials?.close();if(broker)await broker.close();
  if(credentials){try{await sanitizeLoginOutputs(outputDir,credentials.secrets,log);}catch{result={status:cancelled?'cancelled':'failed',error:'Credential evidence could not be safely retained'};for(const name of ['report.html','results.json','data'])await rm(join(outputDir,name),{recursive:true,force:true});}}
  // Manager reads this file only after the container stops. Rename still
  // prevents a partially written manifest if the Worker receives SIGKILL.
  const temporary = join(outputDir, ".result.tmp");
  await writeFile(temporary, `${JSON.stringify(result)}\n`, "utf8");
  await rename(temporary, join(outputDir, "result.json"));
  log(`Worker result: ${result.status}`);
  if (taskRoot) await rm(taskRoot, { recursive: true, force: true });
  process.exitCode = { succeeded: 0, failed: 1, timed_out: 124, cancelled: 130 }[result.status];
}

main().catch((error: unknown) => {
  log(`Cannot persist Worker result: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
