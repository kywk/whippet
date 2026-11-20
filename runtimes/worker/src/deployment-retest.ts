import { createHash } from "node:crypto";
import type { TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import type { WorkspaceContext } from "./workspace-context.js";

export interface RetestTarget {
  projectSlug: string;
  environment: string;
  deploymentId: string;
  artifactRevision: string;
  origin: string;
  proofPath: string;
}

export interface RetestObservation {
  deploymentId: string;
  artifactRevision: string;
  verified: boolean;
  checks?: Record<string, CheckStatus>;
}

type CheckStatus = "passed" | "failed";
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const safeProofPath = /^\/[A-Za-z0-9._/-]{1,255}$/;
const maxProofBytes = 4096;
const maxObservedChecks = 128;

export function validateRetestTarget(value: unknown, context?: WorkspaceContext | null): RetestTarget {
  if (!value || typeof value !== "object") throw new Error("invalid_deployment_retest");
  const target = value as Partial<RetestTarget>;
  const config = context?.config;
  if (typeof target.origin !== "string" || typeof target.proofPath !== "string" || !safeProofPath.test(target.proofPath) ||
      target.proofPath.split("/").slice(1).some(part => !part || part === "." || part === "..") ||
      ![target.projectSlug, target.environment, target.deploymentId, target.artifactRevision].every(
        value => typeof value === "string" && identifier.test(value)) ||
      config?.targets.length !== 1 || config.targets[0]?.origin !== target.origin || !config.defaultTestUrl ||
      new URL(config.defaultTestUrl).origin !== target.origin) {
    throw new Error("invalid_deployment_retest");
  }
  return target as RetestTarget;
}

export function deploymentHeadersMatch(target: RetestTarget, deploymentId: unknown, artifact: unknown): boolean {
  return deploymentId === target.deploymentId && artifact === target.artifactRevision;
}

export function deploymentObservation(target: RetestTarget, verified: boolean, checks?: Record<string, CheckStatus>): RetestObservation {
  return {
    deploymentId: target.deploymentId, artifactRevision: target.artifactRevision, verified,
    ...(verified && checks ? { checks } : {}),
  };
}

async function readProof(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxProofBytes) return undefined;
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function deploymentProbe(target: RetestTarget): Promise<boolean> {
  // Plain HTTP application responses can be checked by the scope proxy.
  // HTTPS CONNECT is opaque, so it cannot supply the same deployment evidence.
  if (!target.origin.startsWith("http://")) return false;
  try {
    const response = await fetch(target.origin + target.proofPath, {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(1500),
    });
    if (!response.ok || !deploymentHeadersMatch(target, response.headers.get("x-whippet-deployment-id"),
        response.headers.get("x-whippet-artifact-revision"))) {
      await response.body?.cancel();
      return false;
    }
    const probe = await readProof(response) as Partial<RetestTarget> | undefined;
    return probe?.deploymentId === target.deploymentId && probe?.artifactRevision === target.artifactRevision &&
      probe?.environment === target.environment && probe?.projectSlug === target.projectSlug;
  } catch {
    return false;
  }
}

export async function watchDeployment(target: RetestTarget) {
  const ready = await deploymentProbe(target);
  let consistent = ready;
  let pending: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  if (ready) {
    timer = setInterval(() => {
      if (!consistent || pending) return;
      pending = deploymentProbe(target).then(matches => { consistent &&= matches; }).finally(() => { pending = undefined; });
    }, 500);
    timer.unref();
  }
  function close() {
    if (timer) clearInterval(timer);
  }
  return {
    ready,
    close,
    async finish(): Promise<boolean> {
      close();
      await pending;
      return consistent && await deploymentProbe(target);
    },
  };
}

export function assertionDigest(testTitle: string, assertionTitle: string): string {
  return createHash("sha256").update(testTitle).update("\0").update(assertionTitle).digest("hex");
}

type ObservedTest = Pick<TestCase, "title" | "expectedStatus">;
type ObservedStep = Pick<TestStep, "category" | "title" | "error">;
type ObservedResult = Pick<TestResult, "status" | "errors">;

type ObservedStatus = CheckStatus | "ambiguous";
interface CheckAttempt {
  checks: Map<string, ObservedStatus>;
  failedExpectations: number;
  otherFailure: boolean;
}

// The approved, immutable source maps native Playwright expectation titles to
// stable check keys. Record only digests and verified per-case terminal steps.
export class RetestChecks {
  private readonly attempts = new Map<ObservedTest, CheckAttempt>();
  private readonly checks = new Map<string, ObservedStatus>();
  private invalid = false;
  private steps = 0;

  step(test: ObservedTest, step: ObservedStep): void {
    if (this.invalid || step.category !== "expect" && (!step.error || step.category === "test.step")) return;
    if (++this.steps > maxObservedChecks) {
      this.invalid = true;
      return;
    }
    let attempt = this.attempts.get(test);
    if (!attempt) {
      attempt = { checks: new Map(), failedExpectations: 0, otherFailure: false };
      this.attempts.set(test, attempt);
    }
    if (step.category !== "expect") {
      attempt.otherFailure = true;
      return;
    }
    if (step.error) attempt.failedExpectations++;
    const digest = assertionDigest(test.title, step.title);
    attempt.checks.set(digest, attempt.checks.has(digest) ? "ambiguous" : step.error ? "failed" : "passed");
  }

  finishTest(test: ObservedTest, result: ObservedResult): void {
    const attempt = this.attempts.get(test);
    this.attempts.delete(test);
    if (this.invalid || test.expectedStatus !== "passed" || result.status === "skipped") return;
    if (!["passed", "failed"].includes(result.status) ||
        result.status === "failed" && (result.errors.length !== 1 || attempt?.failedExpectations !== 1 || attempt.otherFailure)) {
      this.invalid = true;
      return;
    }
    if (!attempt) return;
    for (const [digest, status] of attempt.checks) {
      this.checks.set(digest, this.checks.has(digest) ? "ambiguous" : status);
    }
  }

  observations(): Record<string, CheckStatus> | undefined {
    if (this.invalid) return undefined;
    return Object.fromEntries([...this.checks].filter(
      (entry): entry is [string, CheckStatus] => entry[1] !== "ambiguous"));
  }
}
