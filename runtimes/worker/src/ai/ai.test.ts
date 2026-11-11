import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AI_DEFAULTS, AIError, checkAIConfig, readAIConfig } from "./config.js";
import { buildResponsesRequest, PROBE_PROMPT, requestCodingResponse } from "./responses.js";

// Synthetic credentials only. Tests never read process.env or provider files.
const syntheticKey = "synthetic-test-only-not-a-real-key";
const configured = () => readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: syntheticKey });
const request = { sessionId: "conversation-test-1", input: PROBE_PROMPT };

test("offline check accepts disabled/no-key setup and never exposes credentials", () => {
  const empty = checkAIConfig(readAIConfig({}));
  assert.equal(empty.ready, false);
  assert.equal(empty.enabled, false);
  assert.equal(empty.keyConfigured, false);
  assert.equal(empty.network, "not_used");
  assert.equal(JSON.stringify(checkAIConfig(configured())).includes(syntheticKey), false);
});

test("request uses exact native Responses endpoint, model, reasoning and stable caller session", () => {
  const first = buildResponsesRequest(configured(), request);
  const second = buildResponsesRequest(configured(), request);
  assert.equal(first.url, "https://opencode.ai/inference/go/openai/v1/responses");
  assert.equal(first.init.headers.Authorization, `Bearer ${syntheticKey}`);
  assert.equal(first.init.headers["User-Agent"], "whippet-worker/0.1");
  assert.equal(first.init.headers["x-opencode-session"], request.sessionId);
  assert.equal(second.init.headers["x-opencode-session"], request.sessionId);
  assert.equal(first.init.redirect, "error");
  const body = JSON.parse(first.init.body) as { model: string; reasoning: { effort: string }; input: string };
  assert.equal(body.model, "muse-spark-1.3-contributor");
  assert.equal(body.reasoning.effort, "xhigh");
  assert.equal(body.input, PROBE_PROMPT);
  assert.equal(first.init.body.includes(syntheticKey), false);
});

test("disabled, missing key and invalid session stop before fetch", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls += 1; throw new Error("must not call fetch"); };
  for (const [config, input, code] of [
    [readAIConfig({ OPENCODE_API_KEY: syntheticKey }), request, "disabled"],
    [readAIConfig({ WHIPPET_AI_ENABLED: "true" }), request, "missing_key"],
    [configured(), { ...request, sessionId: "" }, "invalid_session"],
  ] as const) {
    await assert.rejects(requestCodingResponse(config, input, fetcher), (error: unknown) => error instanceof AIError && error.code === code);
  }
  assert.equal(calls, 0);
});

test("configuration rejects endpoint credentials, CLI model syntax and unknown reasoning effort", () => {
  for (const env of [
    { WHIPPET_AI_BASE_URL: "https://user:secret@example.invalid/v1" },
    { WHIPPET_AI_MODEL: "opencode-go/muse-spark-1.3-contributor" },
    { WHIPPET_AI_MODEL: `${AI_DEFAULTS.model}#xhigh` },
    { WHIPPET_AI_REASONING_EFFORT: "automatic" },
  ]) assert.throws(() => readAIConfig(env), (error: unknown) => error instanceof AIError && error.code === "invalid_config");
});

test("Responses success extracts text using one mocked POST", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "synthetic test code" }] }] });
  };
  assert.equal((await requestCodingResponse(configured(), request, fetcher)).text, "synthetic test code");
  assert.equal(calls, 1);
});

test("401/403/429/5xx fail once without body/header disclosure or fallback", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [503, "http_error"]] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls += 1; return new Response(syntheticKey, { status }); };
    await assert.rejects(requestCodingResponse(configured(), request, fetcher), (error: unknown) => {
      assert.ok(error instanceof AIError);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("network, incomplete and invalid replies remain explicit sanitized failures", async () => {
  for (const [fetcher, code] of [
    [async () => { throw new Error(syntheticKey); }, "network_error"],
    [async () => Response.json({ status: "incomplete", error: syntheticKey }), "incomplete_response"],
    [async () => new Response(syntheticKey), "invalid_response"],
    [async () => Response.json({ status: "completed", output: [] }), "empty_response"],
  ] as const) {
    await assert.rejects(requestCodingResponse(configured(), request, fetcher), (error: unknown) => error instanceof AIError && error.code === code && !error.message.includes(syntheticKey));
  }
});

test("probe without --live stops before config/key use; offline CLI is usable without key", () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const probe = spawnSync(process.execPath, [cli, "probe", "--session=synthetic-session"], { env: {}, encoding: "utf8" });
  assert.equal(probe.status, 1);
  assert.equal(JSON.parse(probe.stderr).error.code, "live_required");
  const check = spawnSync(process.execPath, [cli, "check"], { env: {}, encoding: "utf8" });
  assert.equal(check.status, 0);
  assert.equal(JSON.parse(check.stdout).keyConfigured, false);
});
