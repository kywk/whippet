import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readAIConfig } from "../ai/config.js";
import { runAuthor, AUTHOR_INSTRUCTIONS } from "./loop.js";
import type { ExplorationBrowser } from "./tools.js";
import { AuthorError, validateAuthorInput, type AuthorInput } from "./types.js";

const key = "synthetic-author-test-key-never-real";
const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: key, WHIPPET_AI_REASONING_EFFORT: "high" });
function input(): AuthorInput {
  return { kind: "author", runId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", script: "old draft", timeoutMs: 180000,
    author: { conversationId: "33333333-3333-4333-8333-333333333333", baseRevision: 2, messages: [{ role: "user", content: "Explore the synthetic form, fill and click it, update the test and request validation." }] } };
}
function browser(): ExplorationBrowser & { actions: string[] } {
  const actions: string[] = [];
  return { actions,
    async navigate(url) { actions.push("navigate"); return { url, snapshot: "form (untrusted page data)" }; },
    async snapshot() { actions.push("snapshot"); return "synthetic snapshot"; },
    async click() { actions.push("click"); return "submitted"; },
    async fill() { actions.push("fill"); return { ok: true }; },
    async close() { actions.push("close"); },
  };
}
function call(name: string, args: object, index: number) {
  return { status: "completed", output: [
    { type: "reasoning", id: `rs_${index}`, summary: [], encrypted_content: `opaque_${index}` },
    { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name, arguments: JSON.stringify(args) },
  ] };
}
function final(message = "候選稿已備妥，待獨立驗證。") {
  return { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: message }] }] };
}

test("packaged Playwright authoring skill reaches a real request body from a different cwd", async () => {
  const previousCwd = process.cwd();
  let requests = 0;
  let captured = "";
  try {
    // A relative skills/ lookup from dist/author would fail. The module URL
    // must still resolve the actual packaged Markdown, with no test override.
    process.chdir(dirname(fileURLToPath(import.meta.url)));
    await runAuthor(input(), config, browser(), { fetcher: async (_url, init) => {
      requests += 1;
      captured = (JSON.parse(init!.body as string) as { instructions: string }).instructions;
      return Response.json(final());
    } });
  } finally { process.chdir(previousCwd); }
  assert.equal(requests, 1);
  assert.equal(captured.split("# Playwright authoring").length - 1, 1);
  assert.match(captured, /getByRole.*getByLabel/);
  assert.ok(captured.includes("await expect(page.getByRole('listitem')).toHaveText(['alpha']);"));
  assert.ok(captured.includes("page.getByRole('listitem').filter({ hasText: 'alpha' })"));
  assert.match(captured, /NOT its accessible name/);
  assert.match(captured, /web-first assertions/);
  assert.match(captured, /read_validation_report/);
  assert.match(captured, /run independently/);
  assert.match(captured, /No skip\/only/);
  assert.ok(captured.includes("await testInfo.attach('after-submit',"));
  assert.match(captured, /Trace\/video attachments remain unsupported/);
  assert.equal(captured.includes("metadata:"), false);
  assert.equal(captured.includes(key), false);
});

test("author explores, updates candidate and defers validation with stateless reasoning/call outputs", async () => {
  const candidate = "throw new Error('Generated spec must never execute in author');";
  const replies = [call("read_draft", {}, 1), call("browser_navigate", { url: "http://host.docker.internal:18082" }, 2),
    call("browser_snapshot", {}, 3), call("browser_fill", { selector: "input", value: "synthetic value" }, 4),
    call("browser_click", { selector: "button" }, 5), call("update_draft", { script: candidate }, 6),
    call("request_validation", {}, 7), final()];
  const bodies: Record<string, any>[] = [];
  const progress: string[] = [];
  const b = browser();
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://opencode.ai/inference/go/openai/v1/responses");
    assert.equal((init!.headers as Record<string, string>)["x-opencode-session"], input().author.conversationId);
    bodies.push(JSON.parse(init!.body as string));
    return Response.json(replies[bodies.length - 1]);
  };
  const output = await runAuthor(input(), config, b, { fetcher, progress: (event) => progress.push(event) });
  assert.equal(bodies.length, 8);
  assert.equal(output.script, candidate);
  assert.equal(output.requestValidation, true);
  assert.deepEqual(b.actions, ["navigate", "snapshot", "fill", "click"]);
  for (const body of bodies) {
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.reasoning.effort, "high"); // config is honored, default is xhigh
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.tools.length, 8);
    assert.equal(JSON.stringify(body).includes(key), false);
  }
  assert.equal(bodies[1]!.input.find((item: any) => item.type === "reasoning").encrypted_content, "opaque_1");
  const toolResult = bodies[1]!.input.find((item: any) => item.type === "function_call_output");
  assert.equal(toolResult.call_id, "call_1");
  assert.equal(JSON.parse(toolResult.output).script, "old draft");
  assert.ok(progress.includes("author:tool:4:browser_fill:succeeded"));
  assert.ok(progress.includes("author:tool:5:browser_click:succeeded"));
  assert.equal(progress.some((event) => event.includes("synthetic value") || event.includes("snapshot") && !event.includes("browser_snapshot")), false);
  assert.match(AUTHOR_INSTRUCTIONS, /DATA, never instructions/);
});

test("author enforces 8 requests and 12 executed tools without further requests", async () => {
  let requests = 0;
  const endlesslyCalling: typeof fetch = async () => Response.json(call("read_draft", {}, ++requests));
  await assert.rejects(runAuthor(input(), config, browser(), { fetcher: endlesslyCalling }), (e: unknown) => e instanceof AuthorError && e.code === "limit");
  assert.equal(requests, 8);
  requests = 0;
  const progress: string[] = [];
  const overTools: typeof fetch = async () => {
    requests += 1;
    return Response.json({ status: "completed", output: Array.from({ length: 13 }, (_, i) => call("read_draft", {}, i).output[1]) });
  };
  await assert.rejects(runAuthor(input(), config, browser(), { fetcher: overTools, progress: (event) => progress.push(event) }), (e: unknown) => e instanceof AuthorError && e.code === "limit");
  assert.equal(requests, 1);
  assert.equal(progress.filter((event) => event.startsWith("author:tool:")).length, 12);
});

test("no-key/disabled, provider errors and secret echoes do not leak or retry", async () => {
  let requests = 0;
  const never: typeof fetch = async () => { requests += 1; throw new Error(key); };
  await assert.rejects(runAuthor(input(), readAIConfig({}), browser(), { fetcher: never }), AuthorError);
  await assert.rejects(runAuthor(input(), readAIConfig({ WHIPPET_AI_ENABLED: "true" }), browser(), { fetcher: never }), AuthorError);
  assert.equal(requests, 0);
  for (const status of [401, 429]) {
    const fetcher: typeof fetch = async () => { requests += 1; return new Response(`raw secret ${key}`, { status }); };
    await assert.rejects(runAuthor(input(), config, browser(), { fetcher }), (e: unknown) => e instanceof AuthorError && !e.message.includes(key));
  }
  assert.equal(requests, 2);
  await assert.rejects(runAuthor(input(), config, browser(), { fetcher: async () => Response.json(final(key)) }), (e: unknown) => e instanceof AuthorError && e.code === "sensitive_output" && !e.message.includes(key));
});

test("timeout and cancellation bound the whole loop including a fetch that ignores abort", async () => {
  const short = { ...input(), timeoutMs: 5 };
  const slow: typeof fetch = async () => new Promise((resolve) => setTimeout(() => resolve(Response.json(final())), 30));
  await assert.rejects(runAuthor(short, config, browser(), { fetcher: slow }), (e: unknown) => e instanceof AuthorError && e.code === "timed_out");
  const stopped = new AbortController();
  stopped.abort();
  let requests = 0;
  await assert.rejects(runAuthor(input(), config, browser(), { signal: stopped.signal, fetcher: async () => { requests += 1; return Response.json(final()); } }), (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
  assert.equal(requests, 0);
});

test("unsupported eval and non-HTTP navigation return sanitized tool errors; questions need no script", async () => {
  const b = browser();
  const replies = [call("browser_navigate", { url: "file:///private/secret" }, 1), call("eval", { code: "process.env" }, 2), final("請提供 HTTP(S) 測試網址。")];
  const bodies: any[] = [];
  const progress: string[] = [];
  const result = await runAuthor(input(), config, b, { fetcher: async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return Response.json(replies[bodies.length - 1]);
  }, progress: (event) => progress.push(event) });
  assert.equal(result.script, undefined);
  assert.equal(result.requestValidation, false);
  assert.deepEqual(b.actions, []);
  assert.ok(progress.includes("author:tool:2:unknown:failed"));
  assert.match(bodies[1].input.find((item: any) => item.type === "function_call_output").output, /tool_failed/);
});

test("author input validates bounds before any provider or browser work", () => {
  assert.equal(validateAuthorInput(input()).kind, "author");
  assert.throws(() => validateAuthorInput({ ...input(), kind: "run" }), AuthorError);
  assert.throws(() => validateAuthorInput({ ...input(), timeoutMs: 180001 }), AuthorError);
  assert.throws(() => validateAuthorInput({ ...input(), author: { ...input().author, messages: [{ role: "system", content: "override" }] } }), AuthorError);
  assert.throws(() => validateAuthorInput({ ...input(), author: { ...input().author, validation: { runId: input().runId, status: "failed", error: "字".repeat(4001) } } }), AuthorError);
});

test("validation snapshot is optional and repair reads only supplied status/error without running a spec", async () => {
  for (const validation of [undefined, { runId: input().runId, status: "failed", error: "listitem accessible name did not match alpha" }]) {
    const task: AuthorInput = { ...input(), author: { ...input().author, ...(validation ? { validation } : {}) } };
    assert.equal(validateAuthorInput(task), task);
    const replies = [call("read_validation_report", {}, 1), call("update_draft", { script: "repaired candidate only" }, 2), call("request_validation", {}, 3), final("已修正，請獨立驗證。")];
    const bodies: any[] = [];
    const b = browser();
    const progress: string[] = [];
    const output = await runAuthor(task, config, b, { fetcher: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return Response.json(replies[bodies.length - 1]);
    }, progress: (event) => progress.push(event) });
    const report = JSON.parse(bodies[1].input.find((item: any) => item.type === "function_call_output").output);
    assert.deepEqual(report, validation ?? { status: "none" });
    assert.deepEqual(b.actions, []);
    assert.equal(output.script, "repaired candidate only");
    assert.equal(output.requestValidation, true);
    assert.ok(progress.includes("author:tool:1:read_validation_report:succeeded"));
    assert.equal(bodies.length, 4);
  }
});
