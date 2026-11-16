import test from "node:test";
import assert from "node:assert/strict";
import { builtinEngine } from "../engine.js";
import { readAIConfig } from "../../ai/config.js";
import { envelope, call, runInput } from "../spike/fixture.js";
import { vercelEngine } from "./vercel.js";
import { AuthorError } from "../types.js";

const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-truncation-key" });

for (const [name, engine] of [["builtin", builtinEngine], ["vercel", vercelEngine(config)]] as const) test(`${name} retains a trusted checkpoint when an incomplete response contains a truncated tool prefix`, async t => {
  let requests = 0, executions = 0;
  const stages: string[] = [];
  t.after(() => t.diagnostic(JSON.stringify({ engine: name, requests, executions, stages })));
  const result = await engine.run(runInput(config, {
    prepareRequest: body => body,
    checkpoint: () => ({ script: "verified checkpoint" }),
    request: async () => { requests++; return envelope([{ ...call("update_draft", "half"), arguments: '{"script":' }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }); },
    execute: async () => { executions++; return {}; },
    onModelRequestFailure: stage => stages.push(stage),
  }));
  assert.equal(result.partial?.reason, "output_truncated");
  assert.deepEqual(result.partial?.checkpoint, { script: "verified checkpoint" });
  assert.deepEqual(stages, ["INCOMPLETE_MAX_OUTPUT_TOKENS"]);
  assert.equal(requests, 1); assert.equal(executions, 0);
});

test("provider errors, filtering and malformed envelopes cannot become recovered truncations", async () => {
  const cases = [
    { raw: envelope([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, error: { code: "synthetic_error" } }), stage: "INCOMPLETE_MAX_OUTPUT_TOKENS" },
    { raw: envelope([], { status: "incomplete", incomplete_details: { reason: "content_filter" } }), stage: "INCOMPLETE_CONTENT_FILTER" },
    { raw: envelope([], { status: "incomplete", incomplete_details: { reason: "unknown" } }), stage: "INCOMPLETE_UNKNOWN" },
    { raw: envelope([], { status: "incomplete", incomplete_details: [] }), stage: "INCOMPLETE_UNKNOWN" },
    { raw: envelope([], { error: { code: "synthetic_error" } }), stage: "ENVELOPE_INVALID" },
    { raw: envelope([], { status: "failed", incomplete_details: { reason: "max_output_tokens" } }), stage: "ENVELOPE_INVALID" },
    { raw: null, stage: "ENVELOPE_INVALID" },
  ];
  for (const engine of [builtinEngine, vercelEngine(config)]) for (const example of cases) {
    let requests = 0, executions = 0;
    const stages: string[] = [];
    await assert.rejects(engine.run(runInput(config, {
      prepareRequest: body => body, checkpoint: () => ({ script: "verified checkpoint" }),
      request: async () => { requests++; return example.raw; },
      execute: async () => { executions++; return {}; }, onModelRequestFailure: stage => stages.push(stage),
    })), (error: unknown) => error instanceof AuthorError && error.code === "invalid_response");
    assert.equal(requests, 1); assert.equal(executions, 0); assert.deepEqual(stages, [example.stage]);
  }
});

test("truncation without a trusted checkpoint fails and cancellation takes precedence over recovery", async () => {
  for (const engine of [builtinEngine, vercelEngine(config)]) for (const cancelled of [false, true]) {
    const abort = new AbortController(); let requests = 0, executions = 0;
    await assert.rejects(engine.run(runInput(config, {
      prepareRequest: body => body, signal: abort.signal,
      checkpoint: () => cancelled ? { script: "verified checkpoint" } : undefined,
      request: async () => { requests++; if (cancelled) abort.abort(); return envelope([call("update_draft", "ignored", { script: "untrusted prefix" })], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }); },
      execute: async () => { executions++; return {}; },
    })), (error: unknown) => error instanceof AuthorError && error.code === (cancelled ? "cancelled" : "invalid_response"));
    assert.equal(requests, 1); assert.equal(executions, 0);
  }
});
