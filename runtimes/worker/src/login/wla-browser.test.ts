import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { mediaEnvironment } from "../live/files.js";
import { explorationBrowser } from "../author/tools.js";
import type { LoginBinding, WorkspaceConfig, WorkspaceContext } from "../workspace-context.js";
import { CredentialClient } from "./client.js";

const browserOptIn = { skip: process.env.WHIPPET_WLA_BROWSER_TEST !== "1", timeout: 120000 };
const members = [
  { username: "wla-private-member-alpha", password: "wla-private-password-alpha", token: "wla-private-token-alpha", order: "alpha-order" },
  { username: "wla-private-member-beta", password: "wla-private-password-beta", token: "wla-private-token-beta", order: "beta-order" },
];

async function server(t: TestContext, handler: RequestListener): Promise<string> {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function sites(t: TestContext) {
  let outsideHits = 0;
  const outside = await server(t, (_req, res) => { outsideHits++; res.end("outside"); });
  const app = await server(t, (req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/public") { res.end('<div id="member">Visible to all</div>'); return; }
    const member = members.find(item => req.headers.cookie?.includes(`wla_session=${item.token}`));
    if (!member) {
      if (req.url === "/private-hidden") { res.end('<div id="member" hidden>Member area</div>'); return; }
      if (req.url === "/private-redirect") { res.writeHead(302, { Location: `${auth}/login` }); res.end(); return; }
      res.writeHead(403); res.end("Visitor denied"); return;
    }
    res.end(`<div id="member">${member.order}</div><div id="sensitive">${member.username} ${member.password} ${member.token}</div>`);
  });
  const sibling = await server(t, (_req, res) => { res.writeHead(403); res.end("No session for this portal"); });
  const auth = await server(t, async (req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.method !== "POST") {
      res.end('<form method="post"><input id="user" name="user"><input id="pass" name="pass" type="password"><button>Sign in</button></form>');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    if (req.url === "/mfa") { res.end('<div id="mfa">MFA required</div>'); return; }
    if (req.url === "/wrong-site") { res.writeHead(302, { Location: outside }); res.end(); return; }
    if (req.url === "/submit-only") { res.end("Submission recorded"); return; }
    const member = members.find(item => item.username === body.get("user") && item.password === body.get("pass"));
    if (!member) { res.writeHead(401); res.end('<div id="rejected">Invalid password</div>'); return; }
    res.writeHead(302, { "Set-Cookie": `wla_session=${member.token}; Path=/; HttpOnly`, Location: `${app}/protected` });
    res.end();
  });
  const scope: WorkspaceConfig = { name: "WLA fixture", purpose: "Account-scoped login", backgroundSummary: "Synthetic QA portals",
    targets: [app, sibling].map(origin => ({ name: origin, purpose: "protected workspace", origin })),
    dependencies: [{ name: "Common login", purpose: "login", origin: auth }], excludedOrigins: [], exclusions: "", loginRoles: [],
    defaultTestUrl: app, timeoutMs: 30_000 };
  function binding(target: string, entry = "/login", check = "/protected"): LoginBinding {
    return { accountId: randomUUID(), targetOrigin: target, entryUrl: `${auth}${entry}`, form: { usernameSelector: "#user", passwordSelector: "#pass",
      submitSelector: "button", loginRejectedSelector: "#rejected", mfaSelector: "#mfa" }, success: { url: `${target}${check}`, visibleSelector: "#member" },
      loginConfigVersion: randomUUID(), secretRef: randomUUID(), secretVersion: 4 };
  }
  return { app, sibling, auth, scope, binding, outsideHits: () => outsideHits };
}

async function runWorker(t: TestContext, entry: URL, input: Record<string, unknown>, credentials: (frame: Record<string, unknown>) => object | "cancel") {
  const work = await mkdtemp(join(tmpdir(), "whippet-wla-browser-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, "input.json"), JSON.stringify(input));
  const child = spawn(process.execPath, [fileURLToPath(entry)], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work, WHIPPET_LOCAL_TEST_FIXTURES: "1",
  } });
  const requests: Record<string, unknown>[] = [];
  let stdout = "", stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => undefined);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    stdout += line + "\n";
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.kind !== "credential_request") return;
    requests.push(frame);
    const values = credentials(frame);
    if (values === "cancel") child.kill("SIGTERM");
    else child.stdin.write(JSON.stringify({ kind: "credential_response", attemptId: input.attemptId, requestId: frame.requestId, credentials: values }) + "\n");
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  const [exit] = await once(child, "close");
  clearTimeout(timer);
  const output = join(work, "output");
  const rawResult = await readFile(join(output, "result.json"), "utf8");
  for (const member of members) {
    for (const secret of [member.username, member.password, member.token]) assert.ok(!(stdout + stderr + rawResult).includes(secret));
  }
  return { result: JSON.parse(rawResult), exit, output, requests };
}

test("WLA-2 dedicated Worker proves per-site login and rejects submission-only, wrong origin, MFA and cancellation", browserOptIn, async t => {
  const f = await sites(t);
  const workspaceId = randomUUID();
  const workspaceContext = { schemaVersion: "1", workspaceId, settingsRevision: 3, config: f.scope, roleRefs: [] };
  for (const trial of [
    { name: "protected", target: f.app, code: 0, guest: "denied" },
    { name: "protected-by-hidden-selector", target: f.app, check: "/private-hidden", code: 0, guest: "selector_hidden" },
    { name: "protected-by-login-redirect", target: f.app, check: "/private-redirect", code: 0, guest: "login_redirect" },
    { name: "visitor-visible", target: f.app, check: "/public", code: 1, reason: "guest_accessible", noCredentials: true },
    { name: "wrong-password", target: f.app, code: 1, reason: "login_rejected", wrongPassword: true },
    { name: "mfa", target: f.app, entry: "/mfa", code: 1, reason: "mfa_required" },
    { name: "submitted-without-session", target: f.sibling, entry: "/submit-only", code: 1, reason: "login_not_verified" },
    { name: "wrong-origin", target: f.app, entry: "/wrong-site", code: 1, reason: "login_not_verified" },
    { name: "cancelled", target: f.app, code: 130, cancel: true },
  ]) {
    await t.test(trial.name, async t => {
      const binding = f.binding(trial.target, trial.entry, trial.check);
      const runId = randomUUID(), attemptId = randomUUID();
      const input = { kind: "workspace_login_verification", workspaceId, runId, attemptId, testId: null, script: "", scriptOrigin: "legacy", timeoutMs: 30000,
        workspaceContext, loginVerification: { proposalId: randomUUID(), baseRevision: 3, contextRevision: 5, scopeHash: "a".repeat(64), binding } };
      const run = await runWorker(t, new URL("./verification-main.js", import.meta.url), input, frame => {
        if (trial.cancel) return "cancel";
        return { workspaceId, runId, attemptId, accountId: frame.accountId, targetOrigin: frame.targetOrigin, secretRef: frame.secretRef,
          secretVersion: frame.secretVersion, loginOrigin: f.auth, username: members[0]!.username, password: trial.wrongPassword ? "wrong-fixture-value" : members[0]!.password };
      });
      assert.equal(run.exit, trial.code);
      assert.deepEqual(await readdir(run.output), ["result.json"]);
      assert.equal(run.requests.length, trial.noCredentials ? 0 : 1);
      if (trial.guest) assert.deepEqual(run.result, { status: "succeeded", loginVerification: { observedOrigin: trial.target, guest: trial.guest, submitted: true, authenticated: "selector_visible" } });
      else if (trial.cancel) assert.deepEqual(run.result, { status: "cancelled" });
      else assert.deepEqual(run.result, { status: "failed", loginVerification: { reason: trial.reason } });
      assert.equal(f.outsideHits(), 0);
    });
  }
});

test("WLA-3 Run browser uses two same-role accounts in separate contexts and redacts credential output", browserOptIn, async t => {
  const f = await sites(t);
  const workspaceId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
  const bindings = members.map(() => f.binding(f.app));
  const workspaceContext: WorkspaceContext = { schemaVersion: "2", workspaceId, settingsRevision: 4, config: f.scope, roleRefs: [], accountBindings: bindings,
    testAccounts: bindings.map((binding, i) => ({ accountId: binding.accountId, name: `Member ${i}`, role: "member", purpose: i ? "verify isolation" : "place order",
      sites: [{ targetOrigin: f.app, state: "verified" }] })) };
  const script = `import { test, expect } from '@playwright/test';
import { loginAsAccount } from 'whippet/login';
test('orders belong to separate identities', async ({ browser }) => {
  const visitor = await browser.newContext();
  try {
    const page = await visitor.newPage();
    expect((await page.goto(${JSON.stringify(`${f.app}/protected`)}))?.status()).toBe(403);
    await expect(loginAsAccount(page, ${JSON.stringify(bindings[0]!.accountId)}, ${JSON.stringify(f.sibling)})).rejects.toThrow('credential_unavailable');
  } finally { await visitor.close(); }
  for (const [id, order] of ${JSON.stringify(bindings.map((binding, i) => [binding.accountId, members[i]!.order]))}) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      expect(await loginAsAccount(page, id, ${JSON.stringify(f.app)})).toEqual({ submitted: true });
      await page.goto(${JSON.stringify(`${f.app}/protected`)});
      await expect(page.locator('#member')).toHaveText(order);
      console.log(await page.locator('#sensitive').textContent());
    } finally { await context.close(); }
  }
});`;
  const input = { kind: "run", workspaceId, runId, attemptId, testId: randomUUID(), script, scriptOrigin: "ai", timeoutMs: 30000, workspaceContext };
  function credentials(frame: Record<string, unknown>) {
    const index = bindings.findIndex(binding => binding.accountId === frame.accountId);
    const member = members[index];
    return { workspaceId, runId, attemptId, accountId: frame.accountId, targetOrigin: frame.targetOrigin, secretRef: frame.secretRef,
      secretVersion: frame.secretVersion, loginOrigin: f.auth, username: member?.username, password: member?.password };
  }
  const run = await runWorker(t, new URL("../runner.js", import.meta.url), input, credentials);
  assert.equal(run.result.status, "succeeded");
  assert.deepEqual(run.requests.map(frame => frame.accountId), bindings.map(binding => binding.accountId));
  const results = await readFile(join(run.output, "results.json"), "utf8");
  for (const member of members) for (const value of [member.username, member.password, member.token]) assert.ok(!results.includes(value));
  assert.equal(JSON.parse(results).stats.expected, 1);

  const before = process.env.WHIPPET_LOCAL_TEST_FIXTURES;
  process.env.WHIPPET_LOCAL_TEST_FIXTURES = "1";
  const read = new PassThrough(), write = new PassThrough(), requests: unknown[] = [];
  const client = new CredentialClient(input, { read, write });
  const selfTest = explorationBrowser(process.env, { scope: f.scope, workspaceContext, credentials: client });
  write.on("data", bytes => {
    const frame = JSON.parse(bytes.toString());
    requests.push(frame.accountId);
    read.write(JSON.stringify({ kind: "credential_response", attemptId, requestId: frame.requestId, credentials: credentials(frame) }) + "\n");
  });
  try {
    assert.equal((await selfTest.verifyDraft!(script)).passed, true);
    assert.deepEqual(requests, bindings.map(binding => binding.accountId));
  } finally {
    client.close(); read.destroy(); write.destroy(); await selfTest.close();
    if (before === undefined) delete process.env.WHIPPET_LOCAL_TEST_FIXTURES;
    else process.env.WHIPPET_LOCAL_TEST_FIXTURES = before;
  }
});
