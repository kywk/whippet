import type { SelfTestFailureClass } from './module-diagnostics.js';
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { AuthorError } from "./types.js";
import { LiveObserver } from "../live/observer.js";
import { fixtureBridge } from "../live/fixture-bridge.js";
import {AIOriginGate,installAIOriginGate} from "./scope.js";
import type {WorkspaceConfig} from "../workspace-context.js";
import {CredentialClient,KnownSecrets,type CredentialResolver} from '../login/client.js';
import {loginBroker} from '../login/broker.js';
import {submitLogin} from '../login/helper.js';
import {installLoginPrivacy} from '../login/privacy.js';
import type { RuntimeSummary } from "../result.js";

const require = createRequire(import.meta.url);

export interface DraftSelfTestResult {
  passed: boolean;
  category?: "environment" | "script_or_assertion" | "invalid_spec";
  summary: string;
  error?: string;
}

export function isValidPlaywrightSpec(script: string): boolean {
  const trimmed = script.trim();
  if (!trimmed) return false;
  const hasImport = trimmed.includes("@playwright/test") || trimmed.includes("whippet/login");
  const hasTestBlock = /\btest(?:\.describe)?\s*\(/.test(trimmed);
  return hasImport && hasTestBlock;
}

export function classifyDiagnosticError(raw: string): "environment" | "script_or_assertion" {
  return /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|scope_confirmation_required|Origin is outside allowed Workspace scope/i.test(raw)
    ? "environment"
    : "script_or_assertion";
}

export interface ExplorationBrowser {
  navigate(url: string): Promise<unknown>;
  snapshot(): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  login?(roleId:string,usernameSelector:string,passwordSelector:string,submitSelector:string,callId?:string):Promise<unknown>;
  verifyDraft?(script: string, options?: { signal?: AbortSignal; moduleFile?: {slug:string;content:string}; onSelfTestFailure?: (value:SelfTestFailureClass)=>void }): Promise<DraftSelfTestResult>;
  close(): Promise<void>;
}

export function explorationBrowser(env: Readonly<Record<string, string | undefined>>,options:{scope?:WorkspaceConfig;executablePath?:string;credentials?:CredentialResolver;knownSecrets?:Pick<KnownSecrets,"add"|"clean">;defaultTestUrl?:string;timeoutMs?:number}={}): ExplorationBrowser {
  let browser: Browser | undefined;
  let context:BrowserContext|undefined;
  let page: Page | undefined;
  let closed = false;
  const live = new LiveObserver();
  const gate=options.scope?new AIOriginGate(options.scope):undefined;
  const secrets=options.credentials?.secrets??options.knownSecrets??new KnownSecrets();
  let privacy:ReturnType<typeof installLoginPrivacy>|undefined;
  // Browser subprocesses do not inherit the AI key or Manager credentials.
  const browserEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"]) {
    if (env[name] !== undefined) browserEnv[name] = env[name]!;
  }
  async function getPage(): Promise<Page> {
    if (closed) throw new AuthorError("cancelled");
    if(page?.isClosed())page=context?.pages().filter((p)=>!p.isClosed()).at(-1);
    if (!browser) {
      browser = await chromium.launch({ headless: true, env: browserEnv, timeout: 15000,...(options.executablePath?{executablePath:options.executablePath}:{}) });
      live.observeBrowser(browser);
      privacy=installLoginPrivacy(browser,live);
      if (closed) { await browser.close(); throw new AuthorError("cancelled"); }
      context=await browser.newContext(gate?{serviceWorkers:'block'}:{});
      const controller=gate?await installAIOriginGate(context,gate):undefined;
      context.on('page',(next)=>{page=next;next.setDefaultTimeout(10000);next.setDefaultNavigationTimeout(15000);});
      page = await context.newPage();
      if(controller)await controller.ready(page);
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(15000);
    }
    if(!page)page=await context!.newPage();
    return page;
  }
  async function snapshot(): Promise<unknown> {
    const p = await getPage();
    if(gate)gate.require(p.url(),'observation');
    {
      for(const cookie of await p.context().cookies())secrets.add(cookie.value);
      const hidden=await p.locator('input[type="hidden"],input[type="password"]').evaluateAll((nodes)=>nodes.slice(0,100).map((n)=>(n as HTMLInputElement).value).filter((s)=>s.length<=4096));
      for(const value of hidden)secrets.add(value);
      privacy?.secrets.list().forEach((value)=>secrets.add(value));
    }
    // This DOM extractor is fixed application code, never model-provided code.
    // It reads metadata only (not input values), and exposes no eval tool.
    const selectorHints = await p.locator("input,button,a,textarea,select").evaluateAll((nodes) => {
      function selectorFor(element: Element): string {
        const id = element.getAttribute("id");
        if (id) {
          const selector = `#${CSS.escape(id)}`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        const name = element.getAttribute("name");
        if (name) {
          const selector = `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current) {
          const tag = current.tagName.toLowerCase();
          const siblings: Element[] = current.parentElement ? Array.from(current.parentElement.children).filter((node) => node.tagName === current!.tagName) : [current];
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
          current = current.parentElement;
        }
        return parts.join(" > ");
      }
      return nodes.slice(0, 30).map((node) => ({
        tag: node.tagName.toLowerCase(),
        id: (node.getAttribute("id") ?? "").slice(0, 160),
        name: (node.getAttribute("name") ?? "").slice(0, 160),
        type: (node.getAttribute("type") ?? "").slice(0, 80),
        text: (node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.textContent || "").trim().slice(0, 160),
        selector: selectorFor(node),
      }));
    });
    const safeURL=new URL(p.url());safeURL.search='';safeURL.hash='';
    const result={ url: safeURL.href, snapshot: (await p.locator("body").ariaSnapshot({ timeout: 10000 })).slice(0, 12000), selectorHints,...(gate?{scopeIssues:gate.takeIssues()}:{}) };
    return secrets.clean(result);
  }
  return {
    async navigate(url) {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new AuthorError("tool_failed");
      gate?.require(url,'navigation');
      const checkpoint=gate?.checkpoint()??0;
      try{await (await getPage()).goto(parsed.toString(), { waitUntil: "domcontentloaded" });}
      catch(error){gate?.throwNavigationSince(checkpoint);throw error;}
      gate?.throwNavigationSince(checkpoint);
      return snapshot();
    },
    snapshot,
    async click(selector) {
      const checkpoint=gate?.checkpoint()??0;
      try{await (await getPage()).locator(selector).click();}catch(error){gate?.throwNavigationSince(checkpoint);throw error;}
      gate?.throwNavigationSince(checkpoint);return snapshot();
    },
    async fill(selector, value) {
      const input=(await getPage()).locator(selector);
      if(await input.getAttribute('type')==='password')throw new AuthorError('tool_failed');
      await input.fill(value);return {ok:true};
    },
    async login(roleId,usernameSelector,passwordSelector,submitSelector,callId){
      if(!options.credentials||!gate)throw new AuthorError('tool_failed');
      const values=await options.credentials.resolve(roleId,callId);
      try{return await gate.duringLogin(values.loginOrigin,async()=>{const p=await getPage();if(new URL(p.url()).origin!==new URL(values.loginOrigin).origin)await p.goto(values.loginOrigin,{waitUntil:'domcontentloaded'});const result=await submitLogin(p,values,usernameSelector,passwordSelector,submitSelector);return {...result,page:await snapshot()};});}
      finally{values.username='';values.password='';}
    },
    async verifyDraft(script, runOptions = {}) {
      const failure=(value:SelfTestFailureClass)=>{try{runOptions.onSelfTestFailure?.(value);}catch{/* Diagnostic observers never change execution. */}};
      if (closed || runOptions.signal?.aborted) { failure('CANCELLED'); throw new AuthorError("cancelled"); }
      if (!isValidPlaywrightSpec(script)) {
        failure('INVALID_SPEC');
        return {
          passed: false,
          category: "invalid_spec",
          summary: "草稿必須是完整的 Playwright TypeScript 測試腳本（需引用 @playwright/test 並包含 test(...)）。",
          error: "Invalid Playwright test spec: missing @playwright/test import or test(...) block.",
        };
      }
      if (options.scope && options.scope.targets.length === 0) {
        failure('GUARD');
        return {
          passed: false,
          category: "environment",
          summary: "Workspace 尚未確認允許的目標網站範圍（targets 為空），無法執行自我試跑，請先回報使用者完成範圍設定。",
          error: "scope_confirmation_required",
        };
      }
      const redact = (text: string) => (options.credentials ? options.credentials.secrets.redact(text) : text);
      let taskDir: string | undefined;
      let broker: Awaited<ReturnType<typeof loginBroker>> | undefined;
      try {
        taskDir = await mkdtemp(join(tmpdir(), "whippet-self-test-"));
        const packageDir = dirname(require.resolve("@playwright/test/package.json"));
        await symlink(resolve(packageDir, "../.."), join(taskDir, "node_modules"), "dir");
        await writeFile(join(taskDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
        await writeFile(join(taskDir, "run.spec.ts"), script, "utf8");
        if(runOptions.moduleFile){
          if(!/^[a-z][a-z0-9-]{0,63}$/.test(runOptions.moduleFile.slug))throw new AuthorError("invalid_input");
          await mkdir(join(taskDir,"lib"));
          await writeFile(join(taskDir,"lib",runOptions.moduleFile.slug+".ts"),runOptions.moduleFile.content,{flag:"wx"});
        }
        const bridgePath = join(taskDir, "live-fixture.cjs");
        await writeFile(
          bridgePath,
          fixtureBridge(new URL("../live/observer.js", import.meta.url).href, {
            scopeURL: new URL("./scope.js", import.meta.url).href,
            scope: options.scope ?? null,
            privacyURL: new URL("../login/privacy.js", import.meta.url).href,
          }),
          "utf8",
        );
        const loginShim = join(taskDir, "login.cjs");
        await writeFile(
          loginShim,
          `exports.loginAs=async(...args)=>(await import(${JSON.stringify(new URL("../login/helper.js", import.meta.url).href)})).loginAs(...args);\n`,
          "utf8",
        );
        const tsconfigPath = join(taskDir, "tsconfig.json");
        await writeFile(
          tsconfigPath,
          JSON.stringify({ compilerOptions: { baseUrl: taskDir, paths: { "@playwright/test": [bridgePath], "whippet/login": [loginShim], "@lib/*": [join(taskDir,"lib/*")] } } }),
          "utf8",
        );
        const summaryPath = join(taskDir, "runtime-summary.json");
        const resultsPath = join(taskDir, "results.json");
        const reporterPath = fileURLToPath(new URL("../reporter.js", import.meta.url));
        const selfTestTimeout = Math.max(5000, Math.min(options.timeoutMs ?? 25000, 25000));
        const baseURL = options.defaultTestUrl || options.scope?.defaultTestUrl;
        const config = {
          tsconfig: tsconfigPath,
          testDir: taskDir,
          testMatch: "run.spec.ts",
          outputDir: join(taskDir, "test-results"),
          workers: 1,
          fullyParallel: false,
          retries: 0,
          forbidOnly: true,
          timeout: selfTestTimeout,
          globalTimeout: selfTestTimeout,
          reporter: [
            [reporterPath, { summaryPath }],
            ["json", { outputFile: resultsPath }],
          ],
          projects: [{
            name: "chromium",
            use: {
              browserName: "chromium",
              headless: true,
              trace: "off",
              screenshot: "off",
              video: "off",
              ...(baseURL ? { baseURL } : {}),
              ...(options.executablePath ? { launchOptions: { executablePath: options.executablePath } } : {}),
            },
          }],
        };
        const configPath = join(taskDir, "playwright.config.cjs");
        await writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`, "utf8");
        if (options.credentials instanceof CredentialClient) {
          broker = await loginBroker(options.credentials);
        }
        const stderrLines: string[] = [];
        const child = spawn(process.execPath, [join(packageDir, "cli.js"), "test", "--config", configPath], {
          cwd: taskDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...browserEnv,
            ...(broker ? { WHIPPET_LOGIN_SOCKET: broker.path } : {}),
            CI: "1",
            FORCE_COLOR: "0",
            NODE_ENV: "production",
          },
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrLines.length < 20) stderrLines.push(chunk.toString("utf8"));
        });
        const stopChild = () => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
          }
        };
        const onAbort = () => stopChild();
        runOptions.signal?.addEventListener("abort", onAbort, { once: true });
        let watchdogExpired=false;
        const watchdog = setTimeout(()=>{watchdogExpired=true;stopChild();}, selfTestTimeout + 3000);
        let exitCode: number | null = null;
        try {
          exitCode = await new Promise<number | null>((done) => {
            child.once("error", () => done(1));
            child.once("close", (code) => done(code));
          });
        } finally {
          clearTimeout(watchdog);
          runOptions.signal?.removeEventListener("abort", onAbort);
        }
        if (closed || runOptions.signal?.aborted) {failure('CANCELLED');throw new AuthorError("cancelled");}
        let summary: RuntimeSummary | undefined;
        let json: { stats?: { expected?: number; unexpected?: number }; errors?: { message?: string }[] } | undefined;
        try { summary = JSON.parse(await readFile(summaryPath, "utf8")) as RuntimeSummary; } catch { /* ignore */ }
        try { json = JSON.parse(await readFile(resultsPath, "utf8")) as typeof json; } catch { /* ignore */ }
        const passed =
          exitCode === 0 &&
          summary?.status === "passed" &&
          summary.passed > 0 &&
          summary.failed === 0 &&
          summary.interrupted === 0 &&
          summary.errors.length === 0 &&
          typeof json?.stats?.expected === "number" &&
          json.stats.expected > 0 &&
          json.stats.unexpected === 0;
        if (passed) {
          return {
            passed: true,
            summary: `自我試跑通過（${summary!.passed} 項測試通過），已寫入草稿並排入正式驗證。`,
          };
        }
        // Only structured reporter status/counts or the actual watchdog are evidence.
        const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
        failure(watchdogExpired || summary?.status==='timedout' || count(summary?.timedOut) ? 'TIMEOUT' :
          summary?.status==='failed' && count(summary?.failed) ? 'TEST_FAILED' : 'UNKNOWN');
        const rawErr = redact(
          summary?.errors?.[0] ??
          json?.errors?.[0]?.message ??
          (stderrLines.join("\n").trim() || `Playwright exit=${String(exitCode)}`),
        ).slice(0, 1600);
        const category = classifyDiagnosticError(rawErr);
        return {
          passed: false,
          category,
          summary:
            category === "environment"
              ? "自我試跑失敗：目標測試環境無法連線或不在允許範圍內。請勿猜測或盲目儲存草稿，請向使用者回報環境問題。"
              : "自我試跑未通過：請根據下方錯誤訊息檢查定位器、斷言或頁面狀態並修正後再試；若為待測網站異常請據實回報使用者。",
          error: rawErr,
        };
      } finally {
        if (broker) await broker.close().catch(() => undefined);
        if (taskDir) await rm(taskDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async close() { closed = true;options.credentials?.close();privacy?.close();await live.close().catch(() => undefined); await browser?.close(); },
  };
}
