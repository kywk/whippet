import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { piSpikeEngine } from "./pi.js";
import { vercelSpikeEngine } from "./vercel.js";
import { fixture, envelope, call, text, runInput, type Wire } from "./fixture.js";
import { AuthorError } from "../types.js";
import { runAuthor } from "../loop.js";
import { readFileSync } from "node:fs";
import { loadToolRegistry, sha256 } from "../registry.js";

const factories = { pi: (config: Parameters<typeof vercelSpikeEngine>[0]) => piSpikeEngine(config, "m12-fixture"), vercel: vercelSpikeEngine };
test("pi: a rejected malformed stream closes transport without waiting for provider completion", async () => {
  let closed!: () => void;
  const closure = new Promise<void>(r => { closed = r; });
  const f = await fixture((_body, _index, response) => {
    response.on("close", closed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = call("read_draft", "malformed");
    const send = (event: Wire) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{" });
    send({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: "{" } });
    return undefined; // Provider deliberately never completes the response.
  });
  try {
    await assert.rejects(piSpikeEngine(f.config, "m12-malformed").run(runInput(f.config)), AuthorError);
    await Promise.race([closure, delay(950).then(() => { throw new Error("rejected stream still open"); })]);
    assert.equal(f.bodies.length, 1);
  } finally { await f.close(); }
});
for (const [name, factory] of Object.entries(factories)) {
  test(`${name}: every serialized request is masked; pins, registry and optional schema preserved`, async () => {
    const f = await fixture((_body, i) => envelope(i === 1 ? [call("read_draft", "read")] : [text()]));
    let hooks = 0;
    try {
      const result = await factory(f.config).run(runInput(f.config, {
        instructions: "fixture-sensitive-value", context: [{ role: "user", content: "fixture-sensitive-value" }],
        beforeRequest: context => { hooks++; return JSON.parse(JSON.stringify(context).replaceAll("fixture-sensitive-value", "[REDACTED]")); },
        execute: async () => ({ script: "fixture-sensitive-value" }),
      }));
      assert.equal(hooks, 2); assert.equal(f.bodies.length, 2); assert.ok(result.finalText);
      for (const body of f.bodies) {
        assert.ok(!JSON.stringify(body).includes("fixture-sensitive-value"));
        assert.equal(body.model, f.config.model); assert.equal(body.reasoning.effort, "xhigh");
        assert.equal(body.max_output_tokens, 8192); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
        assert.deepEqual(body.tools.map((t: Wire) => t.name), ["read_draft"]);
      }
      assert.match(f.bodies[1]!.instructions, /Budget nearly exhausted/);
    } finally { await f.close(); }
  });
  test(`${name}: rejects unregistered tools, malformed/half JSON, truncation and coerced types before execution`, async () => {
    for (const mode of ["unknown", "half-json", "truncated", "coerce"]) {
      const f = await fixture(() => {
        const item = call(mode === "unknown" ? "shell" : "catalog_search", "bad", { query: "q", limit: mode === "coerce" ? "1" : 1 });
        if (mode === "half-json") item.arguments = '{"query":"q","limit":1';
        return envelope([item], mode === "truncated" ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : {});
      });
      let executions = 0;
      try {
        await assert.rejects(factory(f.config).run(runInput(f.config, { tools: [{ name: "catalog_search" }], execute: async () => { executions++; return {}; } })), AuthorError);
        assert.equal(executions, 0, mode); assert.equal(f.bodies.length, 1, mode);
      } finally { await f.close(); }
    }
  });
  test(`${name}: exact model/tool budgets, last passing checkpoint and no forged completion`, async () => {
    const f = await fixture((_body, i) => envelope([call("read_draft", String(i))]));
    let candidate: { script: string } | undefined;
    try {
      const result = await factory(f.config).run(runInput(f.config, { checkpoint: () => candidate,
        execute: async () => { candidate ??= { script: "last-passing" }; return { selfTestPassed: false }; } }));
      assert.equal(result.partial?.reason, "model_budget"); assert.deepEqual(result.partial?.checkpoint, { script: "last-passing" });
      assert.equal(f.bodies.length, 2);
    } finally { await f.close(); }
    const b = await fixture(() => envelope([call("read_draft", "1"), call("read_draft", "2")]));
    let executions = 0;
    try {
      const result = await factory(b.config).run(runInput(b.config, { budget: { modelRequests: 8, toolExecutions: 1 }, execute: async () => { executions++; return {}; } }));
      assert.equal(result.partial?.reason, "tool_budget"); assert.equal(executions, 1); assert.equal(b.bodies.length, 1);
    } finally { await b.close(); }
  });
  test(`${name}: provider abort settles and closes HTTP connection within one second`, async t => {
    let arrived!: () => void, closed!: () => void;
    const arrival = new Promise<void>(r => { arrived = r; }), closure = new Promise<void>(r => { closed = r; });
    const f = await fixture((_body, _i, response) => { response.on("close", closed); arrived(); return undefined; });
    const controller = new AbortController();
    try {
      const running = factory(f.config).run(runInput(f.config, { signal: controller.signal }));
      await arrival;
      const started = performance.now(); controller.abort();
      await assert.rejects(running, (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
      await Promise.race([closure, delay(950).then(() => { throw new Error("HTTP cancellation did not close"); })]);
      const abortSettleAndCloseMs = performance.now() - started;
      assert.ok(abortSettleAndCloseMs < 1000);
      t.diagnostic(JSON.stringify({ engine: name, abortSettleAndCloseMs: Number(abortSettleAndCloseMs.toFixed(3)), thresholdMs: 1000 }));
      assert.equal(f.bodies.length, 1);
    } finally { await f.close(); }
  });
  test(`${name}: snapshot compaction preserves pairs, newest full snapshot and encrypted reasoning`, async () => {
    const f = await fixture((_body, i) => envelope(i <= 2 ? [{ type: "reasoning", id: `rs_${i}`, summary: [], encrypted_content: `opaque-${i}` }, call("browser_snapshot", String(i))] : [text()]));
    let executions = 0;
    try {
      await factory(f.config).run(runInput(f.config, { tools: [{ name: "browser_snapshot" }], budget: { modelRequests: 3, toolExecutions: 3 },
        execute: async () => ({ url: "https://fixture.invalid", snapshot: `full-${++executions}`, selectorHints: ["#safe"] }) }));
      const outputs = f.bodies[2]!.input.filter((i: Wire) => i.type === "function_call_output");
      assert.ok(f.bodies[2]!.input.some((i: Wire) => i.type === "reasoning" && i.encrypted_content === "opaque-1"));
      assert.equal(outputs.length, 2); assert.equal(JSON.parse(outputs[0].output).snapshotCompacted, true);
      assert.equal(JSON.parse(outputs[1].output).snapshot, "full-2");
      for (const o of outputs) assert.ok(f.bodies[2]!.input.some((i: Wire) => i.type === "function_call" && i.call_id === o.call_id));
    } finally { await f.close(); }
  });
  test(`${name}: masking rejection sends nothing, HTTP failure does not retry, request bytes fail closed`, async () => {
    const f = await fixture((_body, _i, response) => { response.writeHead(500); response.end('{}'); return undefined; });
    try {
      await assert.rejects(factory(f.config).run(runInput(f.config, { beforeRequest: () => { throw new AuthorError("sensitive_output"); } })), AuthorError);
      assert.equal(f.bodies.length, 0);
      await assert.rejects(factory(f.config).run(runInput(f.config, { maxRequestBytes: 1 })), AuthorError);
      assert.equal(f.bodies.length, 0);
      await assert.rejects(factory(f.config).run(runInput(f.config)), AuthorError);
      assert.equal(f.bodies.length, 1);
    } finally { await f.close(); }
  });
  test(`${name}: duplicate IDs cannot repeat side effects; cancellation during a tool cannot issue a follow-up`, async () => {
    const f = await fixture(() => envelope([call("read_draft", "duplicate"), call("read_draft", "duplicate")]));
    let executions = 0;
    try {
      await assert.rejects(factory(f.config).run(runInput(f.config, { execute: async () => { executions++; return {}; } })), AuthorError);
      assert.equal(executions, 1); assert.equal(f.bodies.length, 1);
    } finally { await f.close(); }
    const c = new AbortController();
    const t = await fixture(() => envelope([call("read_draft", "cancel-tool")]));
    try {
      await assert.rejects(factory(t.config).run(runInput(t.config, { signal: c.signal, execute: async () => {
        c.abort(); throw new AuthorError("cancelled");
      } })), (e: unknown) => e instanceof AuthorError && e.code === "cancelled");
      assert.equal(t.bodies.length, 1);
    } finally { await t.close(); }
  });
  test(`${name}: guard completion stops without a follow-up model request; no implicit tools`, async () => {
    const f = await fixture(() => envelope([call("update_draft", "saved", { script: "verified", message: "說明" })]));
    try {
      const result = await factory(f.config).run(runInput(f.config, { tools: [{ name: "update_draft" }], completeAfterTool: () => "guard-verified" }));
      assert.equal(result.finalText, "guard-verified"); assert.equal(f.bodies.length, 1);
      assert.equal(f.bodies[0]!.tools[0].strict, false);
      await assert.rejects(factory(f.config).run(runInput(f.config, { tools: [{ name: "shell" }] })), AuthorError);
      assert.equal(f.bodies.length, 1);
    } finally { await f.close(); }
  });
  test(`${name}: real Worker parser owns partial checkpoint; failed repair cannot replace it`, async () => {
    const script = "import {test,expect} from '@playwright/test'; test('checkpoint',async({page})=>{await page.setContent('<button>Run test</button>');await expect(page.getByRole('button')).toBeVisible();});";
    const f = await fixture((_body, i) => envelope([call("update_draft", `candidate-${i}`, { script: i === 1 ? script : script + '// failed repair', nextStep: "剩餘報告與截圖待完成" })]));
    try {
      const id = "11111111-1111-4111-8111-111111111111", registry = loadToolRegistry();
      const root = new URL("../../../skills/test-author/", import.meta.url), manifestBytes = readFileSync(new URL("manifest.json", root)), manifest = JSON.parse(manifestBytes.toString());
      const input = { kind: "author" as const, runId: id, attemptId: id, script: "", timeoutMs: 180000, author: {
        conversationId: id, baseRevision: 1, messages: [{ role: "user" as const, content: "write checkpoint" }], skillId: "test-author" as const, skillVersion: "1" as const,
        editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null, allowedTools: ["update_draft"],
        skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(manifestBytes), referenceHashes: Object.fromEntries(manifest.references.map((r: { id: string; sha256: string }) => [r.id, r.sha256])) }],
        budget: { ...manifest.budget, maxModelRequests: 2 }, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256,
      } };
      const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {},
        verifyDraft: async (candidate: string) => ({ passed: candidate === script, summary: "fixture self-test result" }) };
      const output = await runAuthor(input, f.config, browser, { engine: factory(f.config), fetcher: async (_url, init) => fetch(f.config.baseURL + "/responses", init) });
      assert.ok("partial" in output); assert.equal(output.partial?.reason, "budget_exhausted");
      assert.equal(output.script, script); assert.equal(output.requestValidation, false);
      assert.deepEqual(output.partial?.checkpoint, { scriptHash: sha256(script), selfTestPassed: true });
      assert.equal(f.bodies.length, 2);
    } finally { await f.close(); }
  });
}
