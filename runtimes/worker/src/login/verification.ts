import { chromium, errors, type Browser, type Locator, type Page } from "@playwright/test";
import { AIOriginGate, installAIOriginGate } from "../author/scope.js";
import { mediaEnvironment } from "../live/files.js";
import { startScopeProxy } from "../scope-proxy.js";
import { validateWorkspaceSettings } from "../workspace.js";
import { origin, validateLoginVerification, validateWorkspaceContext, type LoginVerification, type VerificationFailure, type WorkspaceContext } from "../workspace-context.js";
import type { LoginValues } from "./client.js";
import { submitAccountForm } from "./helper.js";
import { installLoginPrivacy } from "./privacy.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerificationInput {
  kind: "workspace_login_verification";
  workspaceId: string;
  runId: string;
  attemptId: string;
  timeoutMs: number;
  workspaceContext: WorkspaceContext;
  loginVerification: LoginVerification;
}

type GuestBaseline = "denied" | "login_redirect" | "selector_hidden";
export type VerificationResult =
  | { status: "succeeded"; loginVerification: { observedOrigin: string; guest: GuestBaseline; submitted: true; authenticated: "selector_visible" } }
  | { status: "failed"; loginVerification: { reason: VerificationFailure } }
  | { status: "timed_out" | "cancelled" };

export function verificationFailure(reason: VerificationFailure): VerificationResult {
  return { status: "failed", loginVerification: { reason } };
}

export function validateVerificationInput(value: unknown): VerificationInput {
  const keys = ["kind", "workspaceId", "testId", "runId", "attemptId", "timeoutMs", "workspaceContext", "loginVerification", "script", "scriptOrigin"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_evidence");
  const input = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !keys.includes(key) && key !== "workspaceSettings") ||
      input.kind !== "workspace_login_verification" || input.scriptOrigin !== "legacy" || input.script !== "" || input.testId !== null ||
      ![input.workspaceId, input.runId, input.attemptId].every(id => typeof id === "string" && uuid.test(id)) ||
      typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3600000) {
    throw new Error("invalid_evidence");
  }
  validateWorkspaceSettings(input.workspaceSettings);
  const context = validateWorkspaceContext(input.workspaceContext, input.workspaceId as string);
  if (!context) throw new Error("invalid_evidence");
  validateLoginVerification(input.loginVerification, context);
  return input as unknown as VerificationInput;
}

async function visibleWithin(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

async function guestBaseline(page: Page, entryURL: string, checkURL: string, check: Locator): Promise<GuestBaseline | "guest_accessible" | undefined> {
  const response = await page.goto(checkURL, { waitUntil: "domcontentloaded" });
  if (!response) return undefined;
  if (page.url() === entryURL && entryURL !== checkURL && response.url() === entryURL && response.ok()) return "login_redirect";
  if (page.url() !== checkURL || response.url() !== checkURL) return undefined;
  if (response.status() === 401 || response.status() === 403) return "denied";
  if (!response.ok()) return undefined;
  const visible = await visibleWithin(check, 1000);
  if (page.url() !== checkURL) return undefined;
  return visible ? "guest_accessible" : "selector_hidden";
}

export async function verifyWorkspaceLogin(
  input: VerificationInput,
  resolve: (accountId: string, targetOrigin: string) => Promise<LoginValues>,
  signal: AbortSignal,
  executablePath?: string,
): Promise<VerificationResult> {
  const config = input.workspaceContext.config!;
  const binding = input.loginVerification.binding;
  const target = origin(binding.targetOrigin);
  const entryURL = new URL(binding.entryUrl).href;
  const checkURL = new URL(binding.success.url).href;
  let browser: Browser | undefined;
  let proxy: Awaited<ReturnType<typeof startScopeProxy>> | undefined;
  let privacy: ReturnType<typeof installLoginPrivacy> | undefined;
  const stop = () => { void browser?.close().catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    proxy = await startScopeProxy(config);
    signal.throwIfAborted();
    browser = await chromium.launch({ headless: true, env: mediaEnvironment(process.env), timeout: Math.min(input.timeoutMs, 15000),
      ...(executablePath ? { executablePath } : {}), proxy: { server: proxy.url },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    signal.throwIfAborted();
    privacy = installLoginPrivacy(browser);
    const context = await browser.newContext({ serviceWorkers: "block" });
    const gate = new AIOriginGate(config);
    const controller = await installAIOriginGate(context, gate);
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(input.timeoutMs, 10000));
    page.setDefaultNavigationTimeout(Math.min(input.timeoutMs, 15000));
    await controller.ready(page);
    return await gate.duringAccountLogin(page, target, entryURL, async () => {
      const checkpoint = gate.checkpoint();
      const check = page.locator(binding.success.visibleSelector);
      const guest = await guestBaseline(page, entryURL, checkURL, check);
      gate.throwNavigationSince(checkpoint);
      if (!guest) return verificationFailure("login_not_verified");
      if (guest === "guest_accessible") return verificationFailure(guest);
      signal.throwIfAborted();

      let values: LoginValues;
      try { values = await resolve(binding.accountId, target); }
      catch { return verificationFailure("credential_unavailable"); }
      try {
        signal.throwIfAborted();
        await submitAccountForm(page, binding, values);
      } finally { values.username = ""; values.password = ""; }
      gate.throwNavigationSince(checkpoint);

      const { mfaSelector, loginRejectedSelector } = binding.form;
      const mfa = mfaSelector ? page.locator(mfaSelector) : undefined;
      const rejected = loginRejectedSelector ? page.locator(loginRejectedSelector) : undefined;
      const failure = mfa && rejected ? mfa.or(rejected).first() : mfa ?? rejected;
      if (failure && await visibleWithin(failure, 1000)) {
        if (await mfa?.isVisible()) return verificationFailure("mfa_required");
        if (await rejected?.isVisible()) return verificationFailure("login_rejected");
      }

      const response = await page.goto(checkURL, { waitUntil: "domcontentloaded" });
      const authenticated = response?.ok() && response.url() === checkURL && page.url() === checkURL && await visibleWithin(check, 5000);
      gate.throwNavigationSince(checkpoint);
      signal.throwIfAborted();
      if (!authenticated || page.url() !== checkURL || origin(new URL(page.url()).origin) !== target) return verificationFailure("login_not_verified");
      return { status: "succeeded", loginVerification: { observedOrigin: target, guest, submitted: true, authenticated: "selector_visible" } };
    });
  } catch { return verificationFailure("login_not_verified"); }
  finally {
    signal.removeEventListener("abort", stop);
    privacy?.close();
    await browser?.close().catch(() => undefined);
    await proxy?.close();
  }
}
