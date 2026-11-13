import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBundle, writeRunFiles, type RunFile } from "./bundle.js";
import { mediaEnvironment } from "./live/files.js";

function files(): RunFile[] {
  return [{ path: "tests/test.spec.ts", content: "import '@lib/setup';", origin: "manual" }, { path: "lib/setup.ts", content: "export const value=1;", origin: "manual" }];
}
test("bundle requires one entry, distinct safe module paths and matching optional script", () => {
  const source = files();
  assert.deepEqual(runBundle({ files: source }), { files: source, script: source[0]!.content, origin: "manual" });
  assert.equal(runBundle({ files: source, script: source[0]!.content }).script, source[0]!.content);
  for (const invalid of [[], [source[1]], [...source, source[0]], [...source, { ...source[1], path: "lib/../secret.ts" }],
      [...source, { ...source[1], path: "/tmp/secret.ts" }], [...source, { ...source[1], path: "lib\\secret.ts" }],
      [{ ...source[0], origin: "legacy" }], [{ ...source[0], content: "\0" }], [{ ...source[0], extra: 1 }]]) {
    assert.throws(() => runBundle({ files: invalid }), /invalid_run_bundle/);
  }
  assert.throws(() => runBundle({ files: source, script: "different" }), /invalid_run_bundle/);
  assert.throws(() => runBundle({ files: null }), /invalid_run_bundle/);
  assert.equal(runBundle({ script: "legacy" }).origin, "legacy");
});
test("bundle applies AI origin to entire run and enforces file/count/aggregate byte limits", () => {
  const source = files(); source[1]!.origin = "ai";
  assert.equal(runBundle({ files: source, scriptOrigin: "manual" }).origin, "ai");
  const big = "x".repeat(2 * 1024 * 1024);
  assert.ok(runBundle({ files: [{ ...source[0]!, content: big }] }));
  assert.throws(() => runBundle({ files: [{ ...source[0]!, content: big + "x" }] }), /invalid_run_bundle/);
  assert.throws(() => runBundle({ files: [source[0], ...Array.from({ length: 64 }, (_, i) => ({ path: `lib/a${i}.ts`, content: "x", origin: "manual" }))] }), /invalid_run_bundle/);
  assert.throws(() => runBundle({ files: [source[0], ...Array.from({ length: 4 }, (_, i) => ({ path: `lib/a${i}.ts`, content: big, origin: "manual" }))] }), /invalid_run_bundle/);
});
test("bundle materializer rejects symlink directories and never overwrites existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "whippet-bundle-unit-"));
  const outside = await mkdtemp(join(tmpdir(), "whippet-bundle-outside-"));
  try {
    await symlink(outside, join(root, "tests"), "dir");
    await assert.rejects(writeRunFiles(root, files()), /invalid_bundle_directory/);
    await rm(join(root, "tests"));
    await writeRunFiles(root, files());
    assert.equal(await readFile(join(root, "tests/test.spec.ts"), "utf8"), files()[0]!.content);
    await assert.rejects(writeRunFiles(root, files()), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("M10 real manual Module + Use Case pass/fail retain named Stage reports", {
  skip: process.env.WHIPPET_M10_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const runner = fileURLToPath(new URL("./runner.js", import.meta.url));
  for (const pass of [true, false]) {
    const work = await mkdtemp(join(tmpdir(), `whippet-m10-bundle-${pass ? "pass" : "fail"}-`));
    const script = `import { test, expect } from '@playwright/test';
import { prepare } from '@lib/setup';
test('manual module use case', async ({ page }) => {
  const result = await test.step('Stage 1: prepare', async () => prepare({ page }));
  await test.step('Stage 2: verify', async () => {
    await expect(page.getByRole('heading')).toHaveText('alpha');
    expect(result.name).toBe(${JSON.stringify(pass ? "alpha" : "intentional-mismatch")});
  });
});`;
    const bundle: RunFile[] = [
      { path: "tests/test.spec.ts", content: script, origin: "manual" },
      { path: "lib/setup.ts", content: "export async function prepare({page}) { await page.setContent('<h1>alpha</h1>'); return {name:'alpha'}; }", origin: "manual" },
    ];
    await writeFile(join(work, "input.json"), JSON.stringify({ runId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", files: bundle, timeoutMs: 20000 }));
    let exitCode = 0; let stdout = "";
    try {
      const result = await promisify(execFile)(process.execPath, [runner], { timeout: 25000, maxBuffer: 1024 * 1024,
        env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work,
          ...(process.env.WHIPPET_M10_BROWSER_EXECUTABLE_PATH ? { WHIPPET_BROWSER_EXECUTABLE_PATH: process.env.WHIPPET_M10_BROWSER_EXECUTABLE_PATH } : {}) },
      });
      stdout = result.stdout;
    } catch (error) {
      const e = error as { code?: number; stdout?: string }; assert.equal(typeof e.code, "number"); exitCode = e.code!; stdout = e.stdout ?? "";
    }
    const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
    assert.equal(result.status, pass ? "succeeded" : "failed", JSON.stringify(result));
    assert.equal(exitCode, pass ? 0 : 1);
    const report = JSON.parse(await readFile(join(work, "output/results.json"), "utf8"));
    const serialized = JSON.stringify(report);
    assert.ok(serialized.includes("Stage 1: prepare"));
    assert.ok(serialized.includes("Stage 2: verify"));
    const suites = report.suites.flatMap((s: any) => s.specs ?? []);
    const steps = suites[0].tests[0].results[0].steps;
    assert.equal(steps.find((s: any) => s.title === "Stage 2: verify").error !== undefined, !pass);
    assert.ok((await readFile(join(work, "output/report.html"))).length > 0);
    if (!pass) assert.match(stdout, /Stage failed: Stage 2: verify/);
    console.log(JSON.stringify({ pass, status: result.status, work }));
  }
});

test("mixed AI module refuses missing confirmed scope before executing even with manual top-level origin", async () => {
  const work = await mkdtemp(join(tmpdir(), "whippet-m10-mixed-"));
  const source = files(); source[1]!.origin = "ai";
  await writeFile(join(work, "input.json"), JSON.stringify({ runId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", files: source, scriptOrigin: "manual", timeoutMs: 20000 }));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], { env: { ...mediaEnvironment(process.env), WHIPPET_WORK_DIR: work }, timeout: 5000 }));
    const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
    assert.equal(result.status, "failed"); assert.equal(result.error, "scope_confirmation_required");
    await assert.rejects(readFile(join(work, "output/results.json")), /ENOENT/);
  } finally { await rm(work, { recursive: true, force: true }); }
});
