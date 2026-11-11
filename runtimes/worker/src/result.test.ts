import assert from "node:assert/strict";
import test from "node:test";
import { decideResult, type Evidence } from "./result.js";

const passing: Evidence = {
  exitCode: 0, cancelled: false, watchdogExpired: false, reportReady: true,
  json: { stats: { expected: 1, unexpected: 0 }, errors: [] },
  summary: { status: "passed", passed: 1, failed: 0, timedOut: 0, interrupted: 0, errors: [] },
};

test("success requires a real passing run, both reports and zero exit code", () => {
  assert.equal(decideResult(passing).status, "succeeded");
  assert.equal(decideResult({ ...passing, reportReady: false }).status, "failed");
  assert.equal(decideResult({ ...passing, json: undefined }).status, "failed");
  assert.equal(decideResult({ ...passing, exitCode: 1 }).status, "failed");
  assert.equal(decideResult({ ...passing, summary: { ...passing.summary!, passed: 0 } }).status, "failed");
  assert.equal(decideResult({ ...passing, summary: { ...passing.summary!, failed: 1 } }).status, "failed");
});

test("assertion failure, timeout and cancellation never become success", () => {
  assert.equal(decideResult({ ...passing, json: { stats: { expected: 0, unexpected: 1 }, errors: [] } }).status, "failed");
  assert.equal(decideResult({ ...passing, watchdogExpired: true }).status, "timed_out");
  assert.equal(decideResult({ ...passing, cancelled: true }).status, "cancelled");
});
