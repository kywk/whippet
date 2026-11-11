import { writeFile } from "node:fs/promises";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from "@playwright/test/reporter";
import type { RuntimeSummary } from "./result.js";

function log(message: string): void {
  process.stdout.write(`${JSON.stringify({ kind: "log", message: message.slice(0, 8192) })}\n`);
}

export default class NDJSONReporter implements Reporter {
  private summaryPath: string;
  private summary: RuntimeSummary = { status: "unknown", passed: 0, failed: 0, timedOut: 0, interrupted: 0, errors: [] };

  constructor(options: { summaryPath: string }) {
    this.summaryPath = options.summaryPath;
  }

  printsToStdio(): boolean { return true; }

  onBegin(_config: FullConfig, suite: Suite): void {
    log(`Playwright collected ${suite.allTests().length} test(s); workers=1, Chromium`);
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
    log(`${result.status}: ${test.titlePath().join(" > ")} (${result.duration}ms)`);
  }

  onError(error: TestError): void { this.addError(error); }

  async onEnd(result: FullResult): Promise<void> {
    this.summary.status = result.status;
    await writeFile(this.summaryPath, JSON.stringify(this.summary), "utf8");
    log(`Playwright finished: ${result.status}`);
  }

  private addError(error: TestError): void {
    const message = (error.message ?? error.value ?? "Playwright error").slice(0, 8192);
    if (this.summary.errors.length < 20) this.summary.errors.push(message);
    log(message);
  }
}
