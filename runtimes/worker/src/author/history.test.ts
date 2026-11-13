import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CredentialClient, KnownSecrets } from "../login/client.js";
import { attemptIO } from "../attempt-io.js";
import { HistoryClient, HistoryError, validateHistoryPage, type HistoryPage } from "./history.js";
import { runAuthor } from "./loop.js";
import { validateAuthorInput, type AuthorInput } from "./types.js";
import { readAIConfig } from "../ai/config.js";

const id = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
function task(workspace = false): AuthorInput {
  return { kind: "author", runId: id, attemptId: id, workspaceId: id, testId: workspace ? null : id, script: workspace ? "" : "saved spec", timeoutMs: 180000,
    workspaceContext: { schemaVersion: "1", workspaceId: id, settingsRevision: 1, config: { name: "合成站", purpose: "驗收", backgroundSummary: "背景", targets: [{ name: "站", purpose: "測試", origin: "https://example.test" }], dependencies: [], excludedOrigins: [], exclusions: "", loginRoles: [{ roleId: id, name: "角色", loginMethod: "form", loginOrigin: "https://example.test" }], defaultTestUrl: "", timeoutMs: 60000 }, roleRefs: [{ roleId: id, secretRef: id, secretVersion: 1, configured: true }] },
    author: { skillId: workspace ? "workspace-author" : "test-author", skillVersion: "1", allowedTools: ["read_conversation_history"], editingSessionId: workspace ? null : id, conversationId: id, baseRevision: 1, contextRevision: 1, sourceVersion: null, conversationSummary: "已知摘要", messages: [{ role: "user", content: "找回較早的驗測決策" }], history: { maxSequence: "9007199254740993" } } };
}
function page(input = task()): HistoryPage {
  return { workspaceId: id, testId: input.testId!, runId: id, attemptId: id, editingSessionId: input.author.editingSessionId!, conversationId: id, maxSequence: input.author.history!.maxSequence,
    items: [{ sequence: "9007199254740992", role: "user", content: "較早決策：驗測付款失敗提示", offsetBytes: 0, hasMoreContent: false }], nextCursor: null };
}
function io() { const read = new PassThrough(), write = new PassThrough(); const frames: any[] = []; write.on("data", (data) => frames.push(JSON.parse(data.toString()))); return { read, write, frames }; }
function reply(stream: PassThrough, request: any, history: HistoryPage) { stream.write(JSON.stringify({ kind: "history_response", requestId: request.requestId, attemptId: id, history }) + "\n"); }

test("M9 unique stdin demux routes interleaved credential/history frames without sharing credential payload", async () => {
  const pipes = io(), input = task();
  const credentials = new CredentialClient(input, pipes), history = new HistoryClient(input, pipes);
  let historyDeliveries = 0;
  const stopObserve = attemptIO(pipes).subscribe("history_response", (frame) => { historyDeliveries++; assert.equal("credentials" in frame, false); }, () => undefined);
  assert.equal(pipes.read.listenerCount("data"), 1);
  const pendingLogin = credentials.resolve(id), pendingHistory = history.read(null);
  const loginRequest = pipes.frames.find((v) => v.kind === "credential_request"), historyRequest = pipes.frames.find((v) => v.kind === "history_request");
  const values = { workspaceId: id, runId: id, attemptId: id, roleId: id, secretRef: id, secretVersion: 1, loginOrigin: "https://example.test", username: "synthetic-user", password: "synthetic-secret" };
  const lines = Buffer.from(JSON.stringify({ kind: "credential_response", requestId: loginRequest.requestId, attemptId: id, credentials: values }) + "\n" + JSON.stringify({ kind: "history_response", requestId: historyRequest.requestId, attemptId: id, history: page(input) }) + "\n");
  pipes.read.write(lines.subarray(0, 13)); pipes.read.write(lines.subarray(13));
  assert.deepEqual(await pendingLogin, values); assert.deepEqual(await pendingHistory, page(input)); assert.equal(historyDeliveries, 1);
  credentials.close(); assert.equal(pipes.read.listenerCount("data"), 1);
  history.close(); stopObserve(); assert.equal(pipes.read.listenerCount("data"), 0); pipes.read.destroy(); pipes.write.destroy();
});

test("M9 history validates owner/cutoff, UTF-8 byte fragments and continuation without numeric sequence loss", () => {
  const input = task(), good = page(input);
  assert.deepEqual(validateHistoryPage(good, input, null), good);
  const first = page(input); first.items[0] = { sequence: "9007199254740992", role: "assistant", content: "繁體", offsetBytes: 0, hasMoreContent: true }; first.nextCursor = "9007199254740992:6";
  validateHistoryPage(first, input, null);
  const second = page(input); second.items[0] = { ...first.items[0]!, content: "中文", offsetBytes: 6, hasMoreContent: false };
  validateHistoryPage(second, input, first.nextCursor);
  const mutations = [
    (v: any) => v.workspaceId = foreign, (v: any) => v.testId = foreign, (v: any) => v.runId = foreign,
    (v: any) => v.attemptId = foreign, (v: any) => v.editingSessionId = foreign, (v: any) => v.conversationId = foreign,
    (v: any) => v.maxSequence = "9007199254740994", (v: any) => v.items[0].sequence = "9007199254740994",
    (v: any) => v.items[0].offsetBytes = 1, (v: any) => v.items[0].content = "測".repeat(2731),
    (v: any) => v.items[0].baseScript = "unrequested", (v: any) => v.items[0].content = "\ud800", (v: any) => v.items = Array(7).fill(v.items[0]),
    (v: any) => v.nextCursor = "9007199254740992:0", (v: any) => v.items[0].hasMoreContent = true,
  ];
  for (const mutate of mutations) { const value = structuredClone(good); mutate(value); assert.throws(() => validateHistoryPage(value, input, null), HistoryError); }
  assert.throws(() => validateHistoryPage(second, input, "9007199254740992:3"), HistoryError);
  assert.throws(() => validateHistoryPage(good, input, "9007199254740994:0"), HistoryError);
  const ws = task(true); validateAuthorInput(ws); validateHistoryPage(page(ws), ws, null);
  for (const alter of [(v: any) => delete v.author.history, (v: any) => v.author.history = null, (v: any) => v.author.history.url = "https://evil.test", (v: any) => v.author.skillId = "acceptance-summary"]) {
    const value = task(); alter(value); assert.throws(() => validateAuthorInput(value));
  }
});

test("M9 history failure quota, timeout, cancel, wrong-attempt and late reply stay attempt-local", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pipes = io(), history = new HistoryClient(task(), pipes);
  const first = history.read(null); const firstRejected = assert.rejects(first, HistoryError);
  pipes.read.write(JSON.stringify({ kind: "history_response", requestId: pipes.frames[0].requestId, attemptId: foreign, history: page() }) + "\n");
  t.mock.timers.tick(15000); await firstRejected;
  const second = history.read(null), secondRejected = assert.rejects(second, HistoryError);
  // Old reply must not settle a later request.
  reply(pipes.read, pipes.frames[0], page());
  pipes.read.write(JSON.stringify({ kind: "history_response", requestId: pipes.frames[1].requestId, attemptId: id, error: "history_unavailable" }) + "\n"); await secondRejected;
  const abort = new AbortController(), third = history.read(null, abort.signal), thirdRejected = assert.rejects(third, HistoryError); abort.abort(); await thirdRejected;
  const fourth = history.read(null), fourthRejected = assert.rejects(fourth, HistoryError); history.close(); await fourthRejected;
  reply(pipes.read, pipes.frames[3], page()); await assert.rejects(history.read(null), HistoryError); assert.equal(pipes.frames.length, 4);
  const nextPipes = io(), next = new HistoryClient(task(), nextPipes);
  for (let n = 0; n < 4; n++) { const pending = next.read(null); reply(nextPipes.read, nextPipes.frames[n], page()); await pending; }
  await assert.rejects(next.read(null), HistoryError); assert.equal(nextPipes.frames.length, 4); next.close();
  for (const p of [pipes, nextPipes]) { p.read.destroy(); p.write.destroy(); }
});

test("M9 model retrieves an older decision on demand, sees only bounded data and never expands defaults", async () => {
  const input = task(), pipes = io(), history = new HistoryClient(input, pipes);
  let modelRequests = 0;
  pipes.write.on("data", (bytes) => { const request = JSON.parse(bytes.toString()); queueMicrotask(() => reply(pipes.read, request, page(input))); });
  const cfg = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-m9-key" });
  const result = await runAuthor(input, cfg, undefined, { history, fetcher: async (_url, init) => {
    const body = JSON.parse(init!.body as string); modelRequests++;
    assert.deepEqual(body.tools.map((v: any) => v.name), ["read_conversation_history"]);
    if (modelRequests === 1) {
      assert.doesNotMatch(JSON.stringify(body), /驗測付款失敗提示/);
      return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "history-1", name: "read_conversation_history", arguments: '{"cursor":null}' }] });
    }
    const output = JSON.parse(body.input.find((v: any) => v.type === "function_call_output").output);
    assert.deepEqual(Object.keys(output).sort(), ["items", "nextCursor"]); assert.match(output.items[0].content, /驗測付款失敗提示/);
    assert.equal(body.instructions.includes("驗測付款失敗提示"), false);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"message":"依先前付款失敗決策接續","conversationSummary":"保留付款失敗驗測"}' }] }] });
  } });
  assert.equal(modelRequests, 2); assert.equal(result.message, "依先前付款失敗決策接續"); history.close(); pipes.read.destroy(); pipes.write.destroy();
  delete input.author.history; input.author.allowedTools = [];
  let calls = 0;
  await runAuthor(input, cfg, undefined, { fetcher: async (_url, init) => { calls++; assert.deepEqual(JSON.parse(init!.body as string).tools, []); return Response.json({ status: "completed", output_text: '{"message":"只用已知摘要"}', output: [] }); } });
  assert.equal(calls, 1);
});

test("M9 workspace history stays browser-free, cleans known secrets and counts failed calls toward four pages", async () => {
  const input = task(true), cfg = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-m9-key" });
  const secrets = new KnownSecrets(); secrets.add("synthetic-history-secret");
  let reads = 0, models = 0;
  const result = await runAuthor(input, cfg, undefined, { secrets, history: { async read() { reads++; const value = page(input); value.items[0]!.content = "保留決策 synthetic-history-secret"; if (reads > 1) throw new HistoryError(); return value; } }, fetcher: async (_url, init) => {
    const body = JSON.parse(init!.body as string); models++;
    assert.deepEqual(body.tools.map((v: any) => v.name), ["read_conversation_history"]);
    if (models > 1) {
      const outputs = body.input.filter((v: any) => v.type === "function_call_output");
      assert.match(outputs[0].output, /\[redacted\]/); assert.doesNotMatch(JSON.stringify(body), /synthetic-history-secret/);
      if (models === 6) assert.equal(JSON.parse(outputs[4].output).error, "history_unavailable");
    }
    return models <= 5 ? Response.json({ status: "completed", output: [{ type: "function_call", call_id: `call-${models}`, name: "read_conversation_history", arguments: '{"cursor":null}' }] }) : Response.json({ status: "completed", output: [], output_text: '{"message":"需要補充的決策已確認"}' });
  } });
  assert.equal(reads, 4); assert.equal(models, 6); assert.equal(result.message, "需要補充的決策已確認");
});

test("M9 model cursor accepts JSON null and exact literal null while rejecting empty whitespace and invalid strings", async () => {
  const cases: { label: string; cursor: string | null; accepted: boolean }[] = [
    {label:"JSON-null",cursor:null,accepted:true},
    {label:"literal-null",cursor:"null",accepted:true},
    {label:"empty",cursor:"",accepted:false},
    {label:"whitespace",cursor:" ",accepted:false},
    {label:"padded-null",cursor:" null ",accepted:false},
    {label:"uppercase-null",cursor:"NULL",accepted:false},
    {label:"invalid-position",cursor:"not-a-position",accepted:false},
  ];
  for (const example of cases) {
    const input=task(),pipes=io(),history=new HistoryClient(input,pipes),progress:string[]=[];
    let requests=0,retrieved=false;
    pipes.write.on("data",bytes=>{const frame=JSON.parse(bytes.toString());queueMicrotask(()=>reply(pipes.read,frame,page(input)));});
    try {
      await runAuthor(input,readAIConfig({WHIPPET_AI_ENABLED:"true",OPENCODE_API_KEY:"synthetic-cursor-regression"}),undefined,{history,progress:v=>progress.push(v),fetcher:async(_url,init)=>{
        requests++;
        if(requests===1)return Response.json({status:"completed",output:[{type:"function_call",call_id:"cursor-regression",name:"read_conversation_history",arguments:JSON.stringify({cursor:example.cursor})}]});
        const body=JSON.parse(init!.body as string),output=JSON.parse(body.input.find((v:any)=>v.type==="function_call_output").output);
        retrieved=Array.isArray(output.items)&&output.items.length===1;
        if(!retrieved)assert.equal(output.error,"history_unavailable");
        return Response.json({status:"completed",output:[],output_text:'{"message":"定向 cursor 檢查完成"}'});
      }});
    } finally {history.close();pipes.read.destroy();pipes.write.destroy();}
    assert.equal(pipes.frames.length,example.accepted?1:0,`${example.label}: actual IPC request count`);
    if(example.accepted)assert.equal(pipes.frames[0].cursor,null,`${example.label}: IPC must contain JSON null`);
    assert.equal(retrieved,example.accepted,`${example.label}: older decision retrieved`);
    assert.equal(progress.some(v=>v.endsWith(":read_conversation_history:succeeded")),example.accepted,`${example.label}: tool result`);
    assert.equal(requests,2);
  }
  const strictPipes=io(),strictClient=new HistoryClient(task(),strictPipes);
  await assert.rejects(strictClient.read("null"),HistoryError);
  assert.equal(strictPipes.frames.length,0,"literal null remains invalid at the strict client seam");
  strictClient.close();strictPipes.read.destroy();strictPipes.write.destroy();
});

import { readFileSync } from "node:fs";
import { loadToolRegistry, sha256 } from "./registry.js";
import { HarnessClient } from "./harness.js";
import { MAX_ATTEMPT_FRAME, MAX_TOOL_FRAME, MAX_MODULE_TOOL_FRAME } from "../attempt-io.js";

function v10Task(): AuthorInput {
  const input = task();
  const registry = loadToolRegistry();
  const root = new URL("../../skills/test-author/", import.meta.url);
  const raw = readFileSync(new URL("manifest.json", root));
  const manifest = JSON.parse(raw.toString());
  Object.assign(input.author, { skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(raw), referenceHashes: {} }], budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 });
  return input;
}
function toolReply(stream: PassThrough, request: any, result: unknown, attemptId = id) {
  stream.write(JSON.stringify({ kind: "tool_response", requestId: request.requestId, attemptId, result }) + "\n");
}

test("M10 v10 history uses generic IPC and stable transport UUID independent of provider opaque ID", async () => {
  const input = v10Task(), pipes = io(), client = new HarnessClient(input, pipes);
  try {
    for (let n = 0; n < 2; n++) {
      const pending = client.call("read_conversation_history", { cursor: null }, "provider:opaque/not-a-uuid");
      const frame = pipes.frames[n];
      assert.equal(frame.kind, "tool_request"); assert.equal(frame.name, "read_conversation_history");
      assert.match(frame.requestId, /^[a-f0-9-]{36}$/); assert.notEqual(frame.requestId, "provider:opaque/not-a-uuid");
      assert.deepEqual(frame.arguments, { cursor: null });
      toolReply(pipes.read, frame, page(input)); await pending;
    }
    assert.equal(pipes.frames[0].requestId, pipes.frames[1].requestId);
    await assert.rejects(client.call("read_conversation_history", { cursor: "1:0" }, "provider:opaque/not-a-uuid"));
    await assert.rejects(client.call("read_draft", {}, "other"));
  } finally { client.close(); pipes.read.destroy(); pipes.write.destroy(); }
});

test("M10 v10 history rejects foreign scope, ignores late replies and cancels attempt-local pending calls", async () => {
  const input = v10Task(), pipes = io(), history = new HistoryClient(input, pipes);
  try {
    const wrongScope = history.read(null, undefined, "scope"); const rejectedScope = assert.rejects(wrongScope, HistoryError);
    toolReply(pipes.read, pipes.frames[0], { ...page(input), workspaceId: foreign }); await rejectedScope;
    const abort = new AbortController(); const cancelled = history.read(null, abort.signal, "cancelled"); const rejected = assert.rejects(cancelled, HistoryError);
    toolReply(pipes.read, pipes.frames[1], page(input), foreign); abort.abort(); await rejected;
    const pending = history.read(null, undefined, "next");
    toolReply(pipes.read, pipes.frames[1], page(input));
    toolReply(pipes.read, pipes.frames[2], page(input)); assert.deepEqual(await pending, page(input));
    const closed = history.read(null, undefined, "closed"); const closedRejected = assert.rejects(closed, HistoryError); history.close(); await closedRejected;
    toolReply(pipes.read, pipes.frames[3], page(input));
    assert.equal(pipes.frames.every(frame => frame.kind === "tool_request"), true);
  } finally { history.close(); pipes.read.destroy(); pipes.write.destroy(); }
});

test("M10 demux retains separate 64KiB history/credential and 14MiB tool frame limits", () => {
  const pipes = io(), transport = attemptIO(pipes); let tools = 0, history = 0, failures = 0;
  transport.subscribe("tool_response", () => { tools++; }, () => { failures++; });
  transport.subscribe("history_response", () => { history++; }, () => { failures++; });
  transport.expectTool("pending", "read_plan");
  pipes.read.write(JSON.stringify({ kind: "tool_response", requestId:"pending", result: "x".repeat(MAX_ATTEMPT_FRAME) }) + "\n");
  assert.equal(tools, 1); assert.equal(history, 0);
  let rejected = false;
  transport.send({ kind: "credential_request", data: "x".repeat(MAX_ATTEMPT_FRAME) }, () => { rejected = true; });
  assert.equal(rejected, true); assert.equal(pipes.frames.length, 0);
  pipes.read.write(JSON.stringify({ kind: "history_response", history: "x".repeat(MAX_ATTEMPT_FRAME) }) + "\n");
  assert.equal(history, 0); assert.equal(failures, 2);
  pipes.read.destroy(); pipes.write.destroy();
  const large = io(), separate = attemptIO(large); let largeFailure = 0;
  separate.subscribe("tool_response", () => assert.fail("oversized tool frame delivered"), () => { largeFailure++; });
  large.read.write(Buffer.alloc(MAX_MODULE_TOOL_FRAME + 1, 120)); assert.equal(largeFailure, 1);
  large.read.destroy(); large.write.destroy();
});

test("M10 actual author loop maps generic history back to original model call ID", async () => {
  const input = v10Task(), pipes = io(), history = new HistoryClient(input, pipes);
  let requests = 0;
  pipes.write.on("data", bytes => {
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.kind, "tool_request"); assert.notEqual(frame.requestId, "opaque-provider-call");
    queueMicrotask(() => toolReply(pipes.read, frame, page(input)));
  });
  try {
    const result = await runAuthor(input, readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-v10" }), undefined, {
      history, fetcher: async (_url, init) => {
        if (++requests === 1) return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "opaque-provider-call", name: "read_conversation_history", arguments: '{"cursor":null}' }] });
        const body = JSON.parse(init!.body as string); const output = body.input.find((item: any) => item.type === "function_call_output");
        assert.equal(output.call_id, "opaque-provider-call"); assert.equal(JSON.parse(output.output).items.length, 1);
        return Response.json({ status: "completed", output: [], output_text: '{"message":"generic history verified"}' });
      },
    });
    assert.equal(result.message, "generic history verified");
  } finally { history.close(); pipes.read.destroy(); pipes.write.destroy(); }
});
