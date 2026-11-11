export type Status = "succeeded" | "failed" | "timed_out" | "cancelled";

export interface WorkerResult {
  status: Status;
  error?: string;
}

export interface RuntimeSummary {
  status: string;
  passed: number;
  failed: number;
  timedOut: number;
  interrupted: number;
  errors: string[];
}

export interface Evidence {
  exitCode: number | null;
  cancelled: boolean;
  watchdogExpired: boolean;
  reportReady: boolean;
  json: unknown;
  summary?: RuntimeSummary;
  launchError?: string;
}

export function decideResult(evidence: Evidence): WorkerResult {
  if (evidence.cancelled) {
    return { status: "cancelled", error: "Worker received a termination signal" };
  }
  const summary = evidence.summary;
  if (evidence.watchdogExpired || summary?.status === "timedout" || (summary?.timedOut ?? 0) > 0) {
    return { status: "timed_out", error: "Playwright exceeded the execution timeout" };
  }
  if (evidence.launchError) {
    return { status: "failed", error: evidence.launchError };
  }
  const json = evidence.json as { stats?: { expected?: number; unexpected?: number }; errors?: unknown[] } | undefined;
  if (
    evidence.exitCode === 0 &&
    evidence.reportReady &&
    summary?.status === "passed" &&
    summary.passed > 0 &&
    summary.failed === 0 &&
    summary.interrupted === 0 &&
    summary.errors.length === 0 &&
    typeof json?.stats?.expected === "number" &&
    json.stats.expected > 0 &&
    json.stats.unexpected === 0 &&
    Array.isArray(json.errors) &&
    json.errors.length === 0
  ) {
    return { status: "succeeded" };
  }
  const detail = summary?.errors[0] ?? "A passing, nonempty Playwright run and both real reports are required";
  return { status: "failed", error: `Playwright exit=${String(evidence.exitCode)}: ${detail}`.slice(0, 8192) };
}
