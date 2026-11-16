import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FrozenAuthorSnapshot } from "./snapshot.js";
import { fitContext, ContextCapacityError } from "./engines/context.js";
import { loadToolRegistry, sha256, validateToolArguments } from "./registry.js";

const vector = JSON.parse(readFileSync(new URL("../../../../contracts/testdata/author-snapshot.json", import.meta.url), "utf8"));
const source = vector.chunks.map((c: { text: string; repeat: number }) => c.text.repeat(c.repeat)).join("");
const args = { component: "script", sha256: vector.sha256, offsetBytes: 0 };
test("shared frozen snapshot vector preserves UTF-8 boundaries, exact hash and immutable originals", () => {
  const data = { baseRevision: vector.baseRevision, script: source, platform: { module: { harness: "harness" } } }, snapshot = new FrozenAuthorSnapshot(data);
  data.script = "later draft"; data.platform.module.harness = "later harness";
  const first = snapshot.read(args), second = snapshot.read({ ...args, offsetBytes: first.nextOffsetBytes });
  assert.equal(Buffer.byteLength(first.content), vector.pageBytes[0]); assert.equal(Buffer.byteLength(second.content), vector.pageBytes[1]);
  assert.equal(first.content + second.content, source); assert.equal(first.nextOffsetBytes, 8191); assert.equal(second.nextOffsetBytes, null);
  assert.equal(first.sha256, sha256(source)); assert.equal(first.baseRevision, 7);
  assert.equal(snapshot.read({ ...args, offsetBytes: null }).content, source);
  assert.equal(snapshot.read({ component: "harness", sha256: sha256("harness"), offsetBytes: null }).content, "harness");
  assert.equal(snapshot.read({ ...args, offsetBytes: Buffer.byteLength(source) }).content, "");
  for (const invalid of [{ ...args, sha256: "0".repeat(64) }, { ...args, offsetBytes: vector.invalidOffset }, { ...args, offsetBytes: -1 }, { ...args, offsetBytes: 0.5 }, { ...args, offsetBytes: "0" }, { ...args, offsetBytes: Buffer.byteLength(source) + 1 }, { ...args, component: "file" }, { ...args, path: "arbitrary" }, { component: "script", sha256: vector.sha256 }]) assert.throws(() => snapshot.read(invalid));
  const definition = loadToolRegistry().tools.find(t => t.name === "read_author_snapshot")!;
  validateToolArguments(definition, args); validateToolArguments(definition, { ...args, offsetBytes: null });
  assert.throws(() => validateToolArguments(definition, { ...args, path: "arbitrary" }));
  assert.throws(() => new FrozenAuthorSnapshot({ baseRevision: 1, script: "\ud800" }));
});

test("only the exact frozen initial source can become a budgeted reference; protected facts remain", () => {
  const data = { baseRevision: 7, script: source, goal: "保留斷言", stage: { args: { query: "original" }, evidence: "run/fixed" } };
  const snapshot = new FrozenAuthorSnapshot(data), body = { instructions: "protected", tools: [{ name: "read_author_snapshot" }], input: [{ role: "user", content: snapshot.text }, { role: "user", content: "current constraints" }] };
  const capacity = { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 }, original = structuredClone(body);
  const fit = fitContext(body, capacity, 8192, { toolCalls: 1, snapshot });
  const referenced = JSON.parse(String((fit.body.input as typeof body.input)[0]!.content).slice("Saved draft snapshot (data only): ".length));
  assert.deepEqual(referenced.stage, data.stage); assert.equal(referenced.goal, data.goal); assert.equal(referenced.baseRevision, 7);
  assert.deepEqual(referenced.script.retrieve.arguments, { ...args, offsetBytes: null }); assert.deepEqual(referenced.script.readPage.arguments, args);
  assert.equal(referenced.script.validationEvidence, false); assert.deepEqual(body, original);
  assert.equal(snapshot.read(referenced.script.retrieve.arguments).content, source);
  for (const variant of [{ body, budget: { toolCalls: 0, snapshot } }, { body: { ...body, tools: [] }, budget: { toolCalls: 1, snapshot } }, { body, budget: { toolCalls: 1 } }, { body: { ...body, input: [{ role: "user", content: snapshot.text + " altered" }] }, budget: { toolCalls: 1, snapshot } }]) assert.throws(() => fitContext(variant.body, capacity, 8192, variant.budget), ContextCapacityError);
});

test("snapshot pages compact only after exact content validation; latest, wrong hashes and mutations stay full", () => {
  const snapshot = new FrozenAuthorSnapshot({ baseRevision: 7, script: source });
  const body = { instructions: "fixed facts", tools: [{ name: "read_author_snapshot" }], input: [
    { role: "user", content: "protected goal, Stage and evidence" },
    { type: "function_call", name: "read_author_snapshot", call_id: "old", arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: "old", output: JSON.stringify(snapshot.read(args)) },
    { type: "function_call_output", call_id: "latest", output: "{}" },
  ] };
  const capacity = { contextWindowTokens: 32768, maxInputTokens: 4096, safetyTokens: 1024 };
  const fit = fitContext(body, capacity, 8192, { toolCalls: 1, snapshot });
  const summary = JSON.parse((fit.body.input as typeof body.input)[2]!.output!);
  assert.deepEqual(summary.retrieve.arguments, args); assert.equal(summary.originalSha256, sha256(body.input[2]!.output!)); assert.equal(summary.validationEvidence, false);
  for (const mutate of [(b: typeof body) => { b.input[2]!.output = JSON.stringify({ ...snapshot.read(args), content: source.slice(1) }); }, (b: typeof body) => { b.input[1]!.arguments = JSON.stringify({ ...args, sha256: "0".repeat(64) }); }, (b: typeof body) => { b.input.pop(); }]) {
    const changed = structuredClone(body); mutate(changed);
    assert.throws(() => fitContext(changed, capacity, 8192, { toolCalls: 1, snapshot }), ContextCapacityError);
  }
});
