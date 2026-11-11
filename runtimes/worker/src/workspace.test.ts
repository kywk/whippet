import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkspaceSettings } from "./workspace.js";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mediaEnvironment } from "./live/files.js";

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
    const input = { runId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", script, timeoutMs: 20000,
      ...(name === "workspace-relative" ? { workspaceSettings: { revision: 7, sites: [{ name: "固定站", url: "http://127.0.0.1:18765/base/" }], defaultTestUrl: "http://127.0.0.1:18765/base/", timeoutMs: 20000 } } : {}),
    };
    await writeFile(join(work, "input.json"), JSON.stringify(input));
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], {
      env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work }, timeout: 25000, maxBuffer: 512 * 1024,
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
