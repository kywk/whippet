import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readAIConfig } from "../ai/config.js";
import { runAuthor } from "../author/loop.js";
import { loadToolRegistry, sha256 } from "../author/registry.js";
import { call, envelope, text } from "../author/spike/fixture.js";
import type { AuthorInput } from "../author/types.js";
import { SessionCredentialClient } from "../session/credentials.js";
import { SessionWorker, type SessionInput } from "../session/session.js";
import { publicWorkspaceContext, validatePublicWorkspaceContext, validateWorkspaceContext, type LoginBinding, type WorkspaceContext } from "../workspace-context.js";

const toolName = "browser_login_account";
const site = "https://orders.example", sibling = "https://support.example", auth = "https://accounts.example";
const workspaceId = randomUUID(), accountId = randomUUID(), aliasId = randomUUID();
const binding: LoginBinding = { accountId, targetOrigin: site, loginConfigVersion: randomUUID(), entryUrl: `${auth}/private/form`,
  form: { usernameSelector: "#wla-user", passwordSelector: "#wla-password", submitSelector: "#wla-submit" },
  success: { url: `${site}/private/order`, visibleSelector: "#wla-signed-in" }, secretRef: randomUUID(), secretVersion: 11 };
const workspaceContext: WorkspaceContext = { schemaVersion: "2", workspaceId, settingsRevision: 5,
  config: { name: "Stores", purpose: "Orders", backgroundSummary: "Synthetic accounts", targets: [site, sibling].map(origin => ({ name: origin, purpose: "orders", origin })),
    dependencies: [{ name: "Identity", purpose: "login", origin: auth }], excludedOrigins: [], exclusions: "", defaultTestUrl: site, timeoutMs: 30000,
    loginRoles: [{ roleId: aliasId, name: "Legacy alias", loginMethod: "form", loginOrigin: auth }] },
  roleRefs: [{ roleId: aliasId, secretRef: randomUUID(), secretVersion: 8, configured: true }], accountBindings: [binding],
  testAccounts: [{ accountId, name: "Member A", role: "member", purpose: "Place orders", sites: [{ targetOrigin: site, state: "verified" }] }],
};
const browser = { navigate: async () => ({}), snapshot: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => {} };
const legacyRegistry = !loadToolRegistry().tools.some(tool => tool.name === toolName);

test("WLA-3 private bindings require a matching verified site and vanish from the public snapshot", () => {
  assert.deepEqual(validateWorkspaceContext(workspaceContext), workspaceContext);
  assert.throws(() => validateWorkspaceContext({ ...workspaceContext, accountBindings: [{ ...binding, targetOrigin: sibling, success: { ...binding.success, url: sibling } }] }));
  const projection = publicWorkspaceContext(workspaceContext);
  assert.deepEqual(validatePublicWorkspaceContext(projection), projection);
  assert.ok(!Object.hasOwn(projection, "accountBindings"));
  assert.deepEqual(projection.roleRefs, [{ roleId: aliasId, secretRef: null, secretVersion: null, configured: true }]);
  assert.throws(() => validatePublicWorkspaceContext(workspaceContext));
});

test("WLA-3 builtin, Vercel and Pi use the same directory and refuse unavailable accounts", { skip: legacyRegistry }, async t => {
  const registry = loadToolRegistry();
  const root = new URL("../../skills/test-author/", import.meta.url);
  const manifestBytes = readFileSync(new URL("manifest.json", root));
  const manifest = JSON.parse(manifestBytes.toString());
  const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "wla-synthetic-model" });
  const input: AuthorInput = { kind: "author", runId: randomUUID(), attemptId: randomUUID(), workspaceId, testId: randomUUID(),
    timeoutMs: 30000, script: "", workspaceContext, author: { skillId: "test-author", skillVersion: "1", conversationId: randomUUID(), editingSessionId: randomUUID(),
      baseRevision: 1, contextRevision: 0, sourceVersion: null, conversationSummary: null, messages: [{ role: "user", content: "檢視訂單登入前置" }], allowedTools: [toolName],
      skills: [{ id: "test-author", version: "1", sha256: sha256(readFileSync(new URL("SKILL.md", root))), manifestSha256: sha256(manifestBytes),
        referenceHashes: { "external-mcp": manifest.references[0].sha256 } }],
      budget: manifest.budget, model: manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 } };
  for (const engine of ["builtin", "vercel", "pi"] as const) {
    await t.test(engine, async () => {
      let sequence = 0, logins = 0;
      const result = await runAuthor(input, { ...config, engine }, { ...browser, async loginAccount(id, target) {
        assert.equal(id, accountId); assert.equal(target, site); logins++;
        return { submitted: true };
      } }, {
        fetcher: async (_url, init) => {
          const raw = String(init?.body), body = JSON.parse(raw);
          for (const secret of [binding.secretRef, binding.loginConfigVersion, binding.entryUrl, binding.form.passwordSelector, workspaceContext.roleRefs[0]!.secretRef!]) {
            assert.ok(!raw.includes(secret));
          }
          assert.ok(raw.includes("Place orders"));
          assert.ok(raw.includes(accountId));
          assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), [toolName]);
          sequence++;
          if (sequence === 1) return Response.json(envelope([call(toolName, "wrong-site", { accountId, targetOrigin: sibling })]));
          const feedback = body.input.filter((item: { type: string }) => item.type === "function_call_output").at(-1);
          if (sequence === 2) {
            assert.deepEqual(JSON.parse(feedback.output), { error: "tool_unavailable" });
            return Response.json(envelope([call(toolName, "valid", { accountId, targetOrigin: site })]));
          }
          assert.deepEqual(JSON.parse(feedback.output), { submitted: true });
          return Response.json(envelope([text('{"message":"登入表單已送出"}')]));
        },
      });
      assert.equal(result.message, "登入表單已送出");
      assert.equal(logins, 1);
    });
  }
});

test("WLA-3 Session Worker binds the credential exchange to lease, call, account and target", { skip: legacyRegistry }, async () => {
  const registry = loadToolRegistry();
  const input: SessionInput = { kind: "session", sessionId: randomUUID(), leaseId: randomUUID(), workspaceId, workspaceContext,
    allowedTools: [toolName], toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 };
  const sent: Record<string, unknown>[] = [];
  let wrongCall = false;
  const creds = new SessionCredentialClient(input, async value => {
    const frame = value as Record<string, unknown>;
    sent.push(frame);
    queueMicrotask(() => creds.receive({ kind: "credential_response", requestId: frame.requestId, sessionId: input.sessionId, leaseId: input.leaseId, callId: frame.callId,
      credentials: { sessionId: input.sessionId, leaseId: input.leaseId, workspaceId, callId: wrongCall ? randomUUID() : frame.callId,
        accountId, targetOrigin: site, loginOrigin: auth, username: "synthetic-user", password: "synthetic-password" } }));
  });
  const worker = new SessionWorker(input, { ...browser, async loginAccount(id, target, callId) {
    await creds.resolveAccount(id, target, callId);
    return { submitted: true };
  } });
  function invoke(targetOrigin: string, callId = randomUUID()) {
    return worker.call({ kind: "tool_call", sessionId: input.sessionId, leaseId: input.leaseId, callId, name: toolName, arguments: { accountId, targetOrigin } });
  }
  try {
    assert.equal((await invoke(sibling)).error, "tool_unavailable");
    assert.equal(sent.length, 0);
    const id = randomUUID();
    assert.deepEqual((await invoke(site, id)).result, { submitted: true });
    assert.deepEqual((await invoke(site, id)).result, { submitted: true });
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]!).sort(), ["kind", "sessionId", "leaseId", "callId", "requestId", "accountId", "targetOrigin"].sort());
    wrongCall = true;
    const denied = await invoke(site);
    assert.equal(denied.error, "tool_unavailable");
    assert.ok(!JSON.stringify(denied).includes("synthetic-password"));
  } finally { creds.close(); await worker.close(); }
});
