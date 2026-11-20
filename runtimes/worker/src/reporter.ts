import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from "@playwright/test/reporter";
import type { RuntimeSummary } from "./result.js";
import type { FailedStepCategory } from "./author/module-diagnostics.js";

type DiagnosticSummary = RuntimeSummary & { failedStepCategory?: FailedStepCategory };

function log(message: string): void {
  process.stdout.write(`${JSON.stringify({ kind: "log", message: message.slice(0, 8192) })}\n`);
}

export default class NDJSONReporter implements Reporter {
  private summaryPath: string;
  private summary: DiagnosticSummary = { status: "unknown", passed: 0, failed: 0, timedOut: 0, interrupted: 0, errors: [] };
  private diagnostics: boolean;
  private failedLeaf?: FailedStepCategory;
  private failedParent = false;
  private ambiguous = false;
  private caseCount = 0;
  private suiteError = false;
  private failedAssertion: { test: TestCase; title: string } | undefined;
  private otherFailedStep = false;
  private assertionDigest: string | undefined;

  constructor(options: { summaryPath: string; diagnostics?: boolean }) {
    this.summaryPath = options.summaryPath;
    this.diagnostics = options.diagnostics === true;
  }

  printsToStdio(): boolean { return true; }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.caseCount = suite.allTests().length;
    log(`Playwright collected ${this.caseCount} test(s); workers=1, Chromium`);
  }

  onTestBegin(test: TestCase): void {
    log(`Starting: ${test.titlePath().join(" > ")}`);
  }

  onStdOut(chunk: string | Buffer): void { log(chunk.toString()); }
  onStdErr(chunk: string | Buffer): void { log(chunk.toString()); }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "passed" && test.expectedStatus === "passed") this.summary.passed += 1;
    if (result.status === "failed") this.summary.failed += 1;
    if (result.status === "timedOut") this.summary.timedOut += 1;
    if (result.status === "interrupted") this.summary.interrupted += 1;
    for (const error of result.errors) this.addError(error);
    if (this.caseCount === 1 && result.status === "failed" && result.errors.length === 1 &&
        test.expectedStatus === "passed" && this.failedAssertion?.test === test && !this.otherFailedStep) {
      this.assertionDigest = createHash("sha256").update(test.title).update("\0").update(this.failedAssertion.title).digest("hex");
    }
    log(`${result.status}: ${test.titlePath().join(" > ")} (${result.duration}ms)`);
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category === "test.step" && step.error) log(`Stage failed: ${step.title}`);
    if (step.error && step.category !== "test.step") {
      if (step.category === "expect" && !this.failedAssertion) this.failedAssertion = { test, title: step.title };
      else this.otherFailedStep = true;
    }
    if (!this.diagnostics || !step.error) return;
    if (step.category === "test.step") { this.failedParent = true; return; }
    const category: FailedStepCategory = step.category === "expect" ? "EXPECT" :
      step.category === "pw:api" ? "PW_API" :
      step.category === "hook" || step.category === "fixture" || step.category === "test.attach" ? "OTHER" : "UNOBSERVED";
    if (category === "UNOBSERVED" || this.failedLeaf && this.failedLeaf !== category) this.ambiguous = true;
    else this.failedLeaf = category;
  }

  onError(error: TestError): void {
    this.suiteError = true;
    this.addError(error);
  }

  async onEnd(result: FullResult): Promise<void> {
    this.summary.status = result.status;
    if (result.status === "failed" && !this.suiteError && this.assertionDigest) {
      this.summary.assertion = this.assertionDigest;
    }
    if (this.diagnostics) this.summary.failedStepCategory = this.ambiguous ? "UNOBSERVED" : this.failedLeaf ?? (this.failedParent ? "TEST_STEP" : "UNOBSERVED");
    await writeFile(this.summaryPath, JSON.stringify(this.summary), "utf8");
    log(`Playwright finished: ${result.status}`);
  }

  private addError(error: TestError): void {
    const message = (error.message ?? error.value ?? "Playwright error").slice(0, 8192);
    if (this.summary.errors.length < 20) this.summary.errors.push(message);
    log(message);
  }
}
