import test from "node:test";
import assert from "node:assert/strict";
import { ConversationMemory } from "./conversation-memory.js";
import { AuthorError } from "./types.js";
import { KnownSecrets } from "../login/client.js";
import { sha256 } from "./registry.js";
import { fitContext, ContextCapacityError } from "./engines/context.js";

const user = "目標：驗證付款失敗。限制：不得刪除斷言。決策：沿用原提示。還要保留未被選取的退款限制。";
const assistant = "進度：目前 Stage verify。證據：run/fixed 只是對話中的引用。" + "old assistant explanation ".repeat(240);
const page = { items: [
  { sequence: "20", role: "user" as const, content: user, offsetBytes: 0, hasMoreContent: false },
  { sequence: "19", role: "assistant" as const, content: assistant, offsetBytes: 0, hasMoreContent: false },
], nextCursor: null };
const owner = { conversationId: "11111111-1111-4111-8111-111111111111", baseRevision: 7, contextRevision: 3, stageId: "verify" };
const facts = [
  { category: "goal", sequence: "20", offsetBytes: 0, text: "目標：驗證付款失敗。" },
  { category: "constraint", sequence: "20", offsetBytes: Buffer.byteLength("目標：驗證付款失敗。"), text: "限制：不得刪除斷言。" },
  { category: "progress", sequence: "19", offsetBytes: 0, text: "進度：目前 Stage verify。" },
];
const memory = (guard: (value: unknown) => void = () => {}) => new ConversationMemory(owner, { maxSequence: "20" }, guard);

test("grounded memory retains all user fragments, categories, scope and frozen read-back; updates cannot erase facts", () => {
  const m = memory(), before = JSON.stringify(page); m.observe(null, page);
  const receipt = m.record({ facts }) as { recorded: boolean; bytes: number };
  assert.equal(receipt.recorded, true); assert.ok(receipt.bytes <= 8192);
  m.record({ facts: [facts[0]] });
  const saved = JSON.parse(m.summary()!);
  assert.equal(saved.facts.length, 3); assert.equal(saved.conversationId, owner.conversationId);
  assert.equal(saved.baseRevision, 7); assert.equal(saved.stageId, "verify"); assert.equal(saved.validationEvidence, false);
  assert.equal(saved.sources[0].cursor, "20:0"); assert.equal(saved.sources[0].sha256, sha256(before));
  assert.deepEqual(saved.sources[0].userMessages, [page.items[0]]);
  const copy = m.forPage(before) as { facts: { text: string }[] };
  copy.facts[0]!.text = "mutated"; assert.equal(JSON.parse(m.summary()!).facts[0].text, facts[0]!.text);
  assert.equal(JSON.stringify(page), before);
});

test("unread, invented, inverted-role, invalid UTF-8-offset, unknown fields and drifting sources fail closed", () => {
  const m = memory(); assert.throws(() => m.record({ facts }), AuthorError); m.observe(null, page);
  for (const bad of [
    { facts, baseRevision: 99 }, { facts: [{ ...facts[0], text: "自動發佈" }] },
    { facts: [{ ...facts[0], sequence: "21" }] }, { facts: [{ ...facts[0], offsetBytes: 1 }] },
    { facts: [{ category: "constraint", sequence: "20", offsetBytes: Buffer.byteLength(user.slice(0, user.indexOf("刪除斷言。"))), text: "刪除斷言。" }] },
    { facts: [{ ...facts[2], category: "decision" }] }, { facts: [facts[0], facts[0]] },
  ]) assert.throws(() => m.record(bad), AuthorError);
  assert.equal(m.summary(), undefined);
  m.record({ facts }); const saved = m.summary();
  assert.throws(() => m.observe(null, { ...page, items: [{ ...page.items[0]!, content: "drift" }] }), AuthorError);
  assert.equal(m.summary(), saved);
});

test("overlarge user content prevents compaction; no truncation or silent loss buys capacity", () => {
  const m = memory(); const large = { items: [{ sequence: "20", role: "user" as const, content: "goal." + "x".repeat(8187), offsetBytes: 0, hasMoreContent: false }], nextCursor: null };
  m.observe(null, large);
  assert.throws(() => m.record({ facts: [{ category: "goal", sequence: "20", offsetBytes: 0, text: "goal." }] }), AuthorError);
  const body = { input: [{ type: "function_call", name: "read_conversation_history", call_id: "h", arguments: '{"cursor":null}' }, { type: "function_call_output", call_id: "h", output: JSON.stringify(large) }, { type: "function_call_output", call_id: "later", output: "{}" }], tools: [{ name: "read_conversation_history" }], instructions: "" };
  assert.throws(() => fitContext(body, { contextWindowTokens: 16384, maxInputTokens: 6000, safetyTokens: 1024 }, 8192, { toolCalls: 4, history: { pin: { maxSequence: "20" }, reads: 4 }, memory: m }), ContextCapacityError);
  assert.ok(JSON.stringify(body).includes(large.items[0]!.content));
});

test("newly classified secrets revoke derived pages and persisted strings before reuse", () => {
  const secrets = new KnownSecrets();
  const m = memory(value => { if (JSON.stringify(secrets.clean(value)) !== JSON.stringify(value)) throw new AuthorError("sensitive_output"); });
  m.observe(null, page); m.record({ facts }); secrets.add("退款限制");
  assert.throws(() => m.forPage(JSON.stringify(page)), (e: unknown) => e instanceof AuthorError && e.code === "sensitive_output");
  assert.throws(() => m.summary(), (e: unknown) => e instanceof AuthorError && e.code === "sensitive_output");
});

test("exact source already present in the latest output does not double-reserve history reads; drift and missing budget still stop", () => {
  const a = { items: [{ sequence: "20", role: "assistant", content: "a".repeat(6000), offsetBytes: 0, hasMoreContent: false }], nextCursor: "19:0" };
  const b = { items: [{ sequence: "19", role: "assistant", content: "b".repeat(6000), offsetBytes: 0, hasMoreContent: false }], nextCursor: null };
  const input = [a, b, a].flatMap((page, i) => [{ type: "function_call", name: "read_conversation_history", call_id: String(i), arguments: JSON.stringify({ cursor: i === 1 ? "19:0" : null }) }, { type: "function_call_output", call_id: String(i), output: JSON.stringify(page) }]);
  const body = { input, tools: [{ name: "read_conversation_history" }], instructions: "" }, before = JSON.stringify(body);
  const capacity = { contextWindowTokens: 65536, maxInputTokens: 10000, safetyTokens: 1024 };
  const fit = fitContext(body, capacity, 8192, { toolCalls: 1, history: { pin: { maxSequence: "20" }, reads: 1 } });
  assert.equal(fit.compacted, 2); assert.equal((fit.body.input as Record<string, unknown>[]).at(-1)!.output, JSON.stringify(a)); assert.equal(JSON.stringify(body), before);
  for (const [tools, reads] of [[0, 1], [1, 0]]) assert.throws(() => fitContext(body, capacity, 8192, { toolCalls: tools!, history: { pin: { maxSequence: "20" }, reads: reads! } }), ContextCapacityError);
  const changed = structuredClone(body); changed.input.at(-1)!.output = JSON.stringify({ ...a, items: [{ ...a.items[0], content: "c".repeat(6000) }] });
  assert.throws(() => fitContext(changed, capacity, 8192, { toolCalls: 1, history: { pin: { maxSequence: "20" }, reads: 1 } }), ContextCapacityError);
});
