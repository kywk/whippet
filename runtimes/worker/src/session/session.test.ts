import assert from "node:assert/strict";
import test from "node:test";
import { loadToolRegistry } from "../author/registry.js";
import type { ExplorationBrowser } from "../author/tools.js";
import { SessionWorker, type SessionInput } from "./session.js";
import { PassThrough } from "node:stream";
import { runSessionIPC, sessionOutput } from "./ipc.js";
import { SessionCredentialClient } from "./credentials.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const callId = "44444444-4444-4444-8444-444444444444";

function input(): SessionInput {
  const registry = loadToolRegistry();
  return {
    kind: "session", sessionId, leaseId, workspaceId,
    workspaceContext: {
      schemaVersion: "1", workspaceId, settingsRevision: 1, roleRefs: [],
      config: { name: "fixture", purpose: "", backgroundSummary: "", targets: [{ name: "fixture", purpose: "", origin: "https://example.test" }], dependencies: [], excludedOrigins: [], exclusions: "", loginRoles: [], defaultTestUrl: "", timeoutMs: 60000 },
    },
    allowedTools: ["browser_click", "browser_login"], toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256,
  };
}

test("session IPC repeats a click result without clicking twice and rejects changed arguments", async () => {
  let clicks = 0;
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}),
    click: async () => { clicks++; return { snapshot: "clicked" }; },
    fill: async () => ({}), close: async () => {},
  };
  const worker = new SessionWorker(input(), browser);
  const frame = { kind: "tool_call" as const, sessionId, leaseId, callId, name: "browser_click", arguments: { selector: "button" } };
  const first = await worker.call(frame);
  assert.deepEqual(first, { kind: "tool_result", sessionId, leaseId, callId, result: { snapshot: "clicked" } });
  assert.deepEqual(await worker.call(frame), first);
  assert.equal(clicks, 1);
  assert.equal((await worker.call({ ...frame, arguments: { selector: "a" } })).error, "invalid_request");
  assert.equal(clicks, 1);
  await worker.close();
});

test("session login fails closed without a trusted resolver", async () => {
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}),
    login: async () => ({ submitted: true }), close: async () => {},
  };
  const worker = new SessionWorker(input(), browser);
  const reply = await worker.call({ kind: "tool_call", sessionId, leaseId, callId, name: "browser_login", arguments: { roleId: "55555555-5555-4555-8555-555555555555", usernameSelector: "#u", passwordSelector: "#p", submitSelector: "button" } });
  assert.equal(reply.error, "tool_unavailable");
  await worker.close();
});

test("session login resolves over the same stdin without exposing credentials in tool result", async () => {
  const roleId = "55555555-5555-4555-8555-555555555555";
  const sessionInput = input();
  sessionInput.workspaceContext.roleRefs = [{ roleId, secretRef: "66666666-6666-4666-8666-666666666666", secretVersion: 1, configured: true }];
  sessionInput.workspaceContext.config!.loginRoles = [{ roleId, name: "fixture", loginMethod: "form", loginOrigin: "https://example.test" }];
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const writer = sessionOutput(outputStream);
  const credentials = new SessionCredentialClient(sessionInput, frame => writer.send(frame));
  let observedPassword = "";
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}),
    login: async (role, _user, _pass, _submit, call) => {
      const values = await credentials.resolve(role, call);
      observedPassword = values.password;
      return { submitted: true };
    },
    close: async () => {},
  };
  const frames: Record<string, any>[] = [];
  let buffer = "";
  outputStream.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
      if (frame.kind === "credential_request") {
        assert.deepEqual(Object.keys(frame).sort(), ["callId", "kind", "leaseId", "requestId", "roleId", "sessionId"]);
        inputStream.write(JSON.stringify({ kind: "credential_response", sessionId, leaseId, callId, requestId: frame.requestId,
          credentials: { sessionId, leaseId, workspaceId, roleId, loginOrigin: "https://example.test", username: "fixture-user", password: "fixture-pass" } }) + "\n");
      }
      if (frame.kind === "tool_result") inputStream.end();
    }
  });
  const done = runSessionIPC(new SessionWorker(sessionInput, browser, async () => true), inputStream, outputStream, { writer, credentials });
  inputStream.write(JSON.stringify({ kind: "tool_call", sessionId, leaseId, callId, name: "browser_login",
    arguments: { roleId, usernameSelector: "#u", passwordSelector: "#p", submitSelector: "button" } }) + "\n");
  await done;
  assert.equal(observedPassword, "fixture-pass");
  assert.deepEqual(frames.at(-1), { kind: "tool_result", sessionId, leaseId, callId, result: { submitted: true } });
  assert.equal(JSON.stringify(frames.at(-1)).includes("fixture-pass"), false);
});

test("session credential client rejects mismatched lease and late reply", async () => {
  const roleId = "55555555-5555-4555-8555-555555555555";
  const sessionInput = input();
  sessionInput.workspaceContext.roleRefs = [{ roleId, secretRef: "66666666-6666-4666-8666-666666666666", secretVersion: 1, configured: true }];
  sessionInput.workspaceContext.config!.loginRoles = [{ roleId, name: "fixture", loginMethod: "form", loginOrigin: "https://example.test" }];
  let request: any;
  const credentials = new SessionCredentialClient(sessionInput, async frame => { request = frame; });
  const pending = credentials.resolve(roleId, callId);
  await Promise.resolve();
  credentials.receive({ kind: "credential_response", sessionId, leaseId: "77777777-7777-4777-8777-777777777777", callId,
    requestId: request.requestId, credentials: { sessionId, leaseId, workspaceId, roleId, loginOrigin: "https://example.test", username: "fixture-user", password: "fixture-pass" } });
  await assert.rejects(pending);
  credentials.close();
  credentials.receive({ kind: "credential_response", sessionId, leaseId, callId, requestId: request.requestId,
    credentials: { sessionId, leaseId, workspaceId, roleId, loginOrigin: "https://example.test", username: "fixture-user", password: "fixture-pass" } });
  assert.deepEqual(credentials.secrets.list(), []);
});

test("session stdin and stdout carry bounded lease-bound frames", async () => {
  let clicks = 0;
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}), click: async () => { clicks++; return { ok: true }; },
    fill: async () => ({}), close: async () => {},
  };
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let output = "";
  outputStream.on("data", chunk => { output += chunk.toString(); });
  const done = runSessionIPC(new SessionWorker(input(), browser), inputStream, outputStream);
  const frame = { kind: "tool_call", sessionId, leaseId, callId, name: "browser_click", arguments: { selector: "button" } };
  inputStream.end(`${JSON.stringify(frame)}\n${JSON.stringify(frame)}\n`);
  await done;
  const frames = output.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(frames, [
    { kind: "session_ready", sessionId, leaseId },
    { kind: "tool_result", sessionId, leaseId, callId, result: { ok: true } },
    { kind: "tool_result", sessionId, leaseId, callId, result: { ok: true } },
  ]);
  assert.equal(clicks, 1);
});

test("closed lease rejects a late browser success", async () => {
  let finish!: (value: unknown) => void;
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}),
    click: async () => new Promise(resolve => { finish = resolve; }),
    fill: async () => ({}), close: async () => {},
  };
  const worker = new SessionWorker(input(), browser);
  const pending = worker.call({ kind: "tool_call", sessionId, leaseId, callId, name: "browser_click", arguments: { selector: "button" } });
  await worker.close();
  finish({ ok: true });
  assert.equal((await pending).error, "cancelled");
});

test("equivalent argument key order reuses one result", async () => {
  let fills = 0;
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}),
    fill: async () => { fills++; return { ok: true }; }, close: async () => {},
  };
  const worker = new SessionWorker({ ...input(), allowedTools: ["browser_fill"] }, browser);
  const base = { kind: "tool_call" as const, sessionId, leaseId, callId, name: "browser_fill" };
  await worker.call({ ...base, arguments: { selector: "#name", value: "A" } });
  assert.deepEqual(await worker.call({ ...base, arguments: { value: "A", selector: "#name" } }), { kind: "tool_result", sessionId, leaseId, callId, result: { ok: true } });
  assert.equal(fills, 1);
  await worker.close();
});

test("bounded result cache closes the lease without replaying an old call", async () => {
  let snapshots = 0;
  const browser: ExplorationBrowser = {
    navigate: async () => ({}), snapshot: async () => { snapshots++; return { snapshot: "x".repeat(120000) }; },
    click: async () => ({}), fill: async () => ({}), close: async () => {},
  };
  const worker = new SessionWorker({ ...input(), allowedTools: ["browser_snapshot"] }, browser);
  let lastError: string | undefined;
  for (let index = 0; index < 22; index++) {
    const nextId = `44444444-4444-4444-8444-${index.toString().padStart(12, "0")}`;
    const reply = await worker.call({ kind: "tool_call", sessionId, leaseId, callId: nextId, name: "browser_snapshot", arguments: {} });
    if (reply.error) { lastError = reply.error; break; }
  }
  assert.equal(lastError, "unknown_result");
  const beforeReplay = snapshots;
  assert.equal((await worker.call({ kind: "tool_call", sessionId, leaseId, callId: "44444444-4444-4444-8444-000000000000", name: "browser_snapshot", arguments: {} })).error, "session_unavailable");
  assert.equal(snapshots, beforeReplay);
});
