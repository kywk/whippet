import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkspaceSettings } from "./workspace.js";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mediaEnvironment } from "./live/files.js";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { unconfirmedBrowserScope } from "./author/scope.js";
import { startScopeProxy } from "./scope-proxy.js";
import { explorationBrowser } from "./author/tools.js";

test("test Harness proxy blocks unlisted origins before forwarding a request or CONNECT", async t => {
  let hits = 0;
  const fixture = createServer((_req, res) => { hits++; res.end("fixture"); });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const address = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  const proxy = await startScopeProxy({
    ...unconfirmedBrowserScope(),
    targets: [{ name: "核准站點", origin: address, purpose: "test" }],
  });
  t.after(() => proxy.close());
  const status = (path: string, method = "GET") => new Promise<number | undefined>((resolve, reject) => {
    const client = request(proxy.url, { path, method }, response => { response.resume(); resolve(response.statusCode); });
    client.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    client.on("error", reject);
    client.end();
  });
  assert.equal(await status(address + "/"), 200);
  const unlisted = address.replace("127.0.0.1", "localhost");
  assert.equal(await status(unlisted), 403);
  assert.equal(await status(new URL(unlisted).host, "CONNECT"), 403);
  assert.equal(hits, 1);
});

test("Docker formal runs and author self-tests stay within three approved origins", {
  skip: process.env.WHIPPET_SCOPE_HARNESS_DOCKER_TEST !== "1", timeout: 45000,
}, async t => {
  const hits = [0, 0, 0, 0];
  const origins: string[] = [];
  for (const index of hits.keys()) {
    const site = createServer((req, res) => {
      hits[index]!++;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: origins[3] }).end();
      } else {
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>Workspace target</h1>");
      }
    });
    await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
    origins.push(`http://127.0.0.1:${(site.address() as AddressInfo).port}`);
    t.after(() => { site.closeAllConnections(); site.close(); });
  }
  const scope = {
    ...unconfirmedBrowserScope(), timeoutMs: 25000, defaultTestUrl: origins[0]!,
    targets: origins.slice(0, 3).map((origin, index) => ({ name: `Target ${index}`, origin, purpose: "test" })),
  };
  const work = await mkdtemp(join(tmpdir(), "harness-formal-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const id = "11111111-1111-4111-8111-111111111111";
  const script = `
    import { test, expect } from '@playwright/test';
    import { createConnection } from 'node:net';
    test('Workspace approved targets', async ({ page, request }) => {
      const sites = ${JSON.stringify(origins)};
      await page.goto('/');
      await expect(page.getByRole('heading')).toHaveText('Workspace target');
      await expect(await request.get(sites[1])).toBeOK();
      await expect(await request.get(sites[2])).toBeOK();
      await expect(page.goto(sites[0] + '/redirect')).rejects.toThrow();
      expect((await request.get(sites[3], { timeout: 4000 })).status()).toBe(403);
      expect((await fetch(sites[0])).ok).toBe(true);
      expect((await fetch(sites[3]).catch(() => null))?.ok ?? false).toBe(false);
      await expect(new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(sites[3]).port) });
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('scope blocked')); });
        socket.once('error', reject);
        socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      })).rejects.toThrow();
    });
  `;
  await writeFile(join(work, "input.json"), JSON.stringify({
    runId: id, attemptId: id, workspaceId: id, testId: id, scriptOrigin: "manual", script, timeoutMs: 25000,
    workspaceContext: { schemaVersion: "1", workspaceId: id, settingsRevision: 1, roleRefs: [], config: scope },
  }), { mode: 0o600 });
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], {
    env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work, WHIPPET_LOCAL_TEST_FIXTURES: "0" }, timeout: 40000,
  });
  const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
  assert.equal(result.status, "succeeded");
  assert.ok(hits.slice(0, 3).every(h => h > 0));
  const author = explorationBrowser(process.env, { scope, timeoutMs: 10000 });
  try {
    const selfTest = await author.verifyDraft!(script);
    assert.equal(selfTest.passed, true, selfTest.error);
    const rejected = await author.verifyDraft!(`
      import { test, expect } from '@playwright/test';
      test('an unapproved target cannot pass', async ({ request }) => {
        await expect(await request.get(${JSON.stringify(origins[3])})).toBeOK();
      });
    `);
    assert.equal(rejected.passed, false);
  } finally {
    await author.close();
  }
  assert.equal(hits[3], 0);
});

test("Workspace snapshot validates without changing content and permits legacy absence", () => {
  const snapshot = { revision: 7, sites: [{ name: "固定站", url: "https://example.test/base/" }], defaultTestUrl: "https://example.test/base/", timeoutMs: 60000 };
  const before = JSON.stringify(snapshot);
  assert.equal(validateWorkspaceSettings(snapshot), snapshot);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(validateWorkspaceSettings(undefined), undefined);
  assert.equal(validateWorkspaceSettings({ ...snapshot, defaultTestUrl: "https://example.test?email=a@b" })?.defaultTestUrl, "https://example.test?email=a@b");
  assert.deepEqual(validateWorkspaceSettings({ ...snapshot, sites: [], defaultTestUrl: "", timeoutMs: 3600000 }), { ...snapshot, sites: [], defaultTestUrl: "", timeoutMs: 3600000 });
});

test("Workspace snapshot rejects malformed, secret/unknown fields and userinfo without echoing input", () => {
  const valid = { revision: 7, sites: [], defaultTestUrl: "", timeoutMs: 60000 };
  for (const value of [null, { ...valid, revision: 0 }, { ...valid, timeoutMs: 0 }, { ...valid, timeoutMs: 3600001 },
    { ...valid, defaultTestUrl: "file:///private" }, { ...valid, defaultTestUrl: "https://user:synthetic-only@example.test" },
    { ...valid, defaultTestUrl: "http:example.test" }, { ...valid, defaultTestUrl: "https://@example.test/" },
    { ...valid, defaultTestUrl: "https://example.test:0/" }, { ...valid, defaultTestUrl: "https://example.test:/" },
    { ...valid, defaultTestUrl: "https://example.test/a b" },
    { ...valid, OPENCODE_API_KEY: "synthetic-only" }, { ...valid, sites: [{ name: "site", url: "https://example.test", env: "synthetic-only" }] },
    { ...valid, sites: [{ name: " ", url: "https://example.test" }] }, { ...valid, sites: Array(21).fill({ name: "site", url: "https://example.test" }) }]) {
    assert.throws(() => validateWorkspaceSettings(value), (e: unknown) => e instanceof Error && e.message === "Invalid workspaceSettings snapshot");
  }
});

test("M5 real Worker runner uses snapshot baseURL and accepts legacy input", {
  skip: process.env.WHIPPET_WORKSPACE_BROWSER_TEST !== "1", timeout: 45000,
}, async () => {
  const fixtures = process.env.WHIPPET_WORKSPACE_FIXTURES ?? fileURLToPath(new URL("../examples/", import.meta.url));
  const evidence = process.env.WHIPPET_WORKSPACE_EVIDENCE_DIR ?? tmpdir();
  await mkdir(evidence, { recursive: true });
  for (const name of ["workspace-relative", "legacy-input"]) {
    const work = await mkdtemp(join(evidence, `${name}-`));
    const script = await readFile(join(fixtures, `${name}.spec.ts`), "utf8");
    const id = "11111111-1111-4111-8111-111111111111";
    const input = { runId: id, attemptId: "22222222-2222-4222-8222-222222222222", script, timeoutMs: 20000,
      ...(name === "workspace-relative" ? { workspaceId: id, testId: id, scriptOrigin: "manual",
        workspaceContext: { schemaVersion: "1", workspaceId: id, settingsRevision: 7, roleRefs: [],
          config: { ...unconfirmedBrowserScope(), defaultTestUrl: "http://127.0.0.1:18765/base/", timeoutMs: 20000,
            targets: [{ name: "固定站", origin: "http://127.0.0.1:18765", purpose: "test" }] },
        },
      } : {}),
    };
    await writeFile(join(work, "input.json"), JSON.stringify(input));
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], {
      env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work, WHIPPET_LOCAL_TEST_FIXTURES: "1" }, timeout: 25000, maxBuffer: 512 * 1024,
    });
    const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
    assert.equal(result.status, "succeeded");
    const report = await readFile(join(work, "output/report.html"), "utf8");
    assert.ok(report.length > 0);
    if (name === "workspace-relative") {
      const images = await readdir(join(work, "output/data"));
      assert.equal(images.filter((v) => /^[0-9a-f]{40}\.png$/.test(v)).length, 1, "Real runner must still export its PNG report attachment");
    }
    console.log(JSON.stringify({ fixture: name, status: result.status, work }));
  }
});

test("canonical Workspace snapshot supplies formal runner baseURL ahead of legacy settings", {
  skip: process.env.WHIPPET_WORKSPACE_BROWSER_TEST !== "1", timeout: 45000,
}, async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const work = await mkdtemp(join(tmpdir(), "canonical-relative-"));
  const fixtures = process.env.WHIPPET_WORKSPACE_FIXTURES ?? fileURLToPath(new URL("../examples/", import.meta.url));
  const script = await readFile(join(fixtures, "workspace-relative.spec.ts"), "utf8");
  const input = { runId: id, attemptId: id, workspaceId: id, testId: id, scriptOrigin: "manual", script, timeoutMs: 20000,
    workspaceSettings: { revision: 1, sites: [], defaultTestUrl: "http://127.0.0.1:1/wrong/", timeoutMs: 20000 },
    workspaceContext: { schemaVersion: "1", workspaceId: id, settingsRevision: 2, roleRefs: [], config: {
      name: "canonical fixture", purpose: "", backgroundSummary: "", targets: [{name: "fixture", purpose: "", origin: "http://127.0.0.1:18765"}],
      dependencies: [], excludedOrigins: [], exclusions: "", loginRoles: [], defaultTestUrl: "http://127.0.0.1:18765/base/", timeoutMs: 20000,
    } },
  };
  await writeFile(join(work, "input.json"), JSON.stringify(input));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], {
    env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work, WHIPPET_LOCAL_TEST_FIXTURES: "1" }, timeout: 25000, maxBuffer: 512 * 1024,
  }).catch(() => undefined);
  const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
  assert.equal(result.status, "succeeded");
});
