import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { exportHTMLReport } from "./report-artifacts.js";

test("PNG export preserves native HTML relative links and withholds HTML for unsafe data", async () => {
  const root = await mkdtemp(join(tmpdir(), "whippet-png-export-"));
  try {
    const htmlDir = join(root, "html");
    const outputDir = join(root, "output");
    await mkdir(join(htmlDir, "data"), { recursive: true });
    await mkdir(outputDir);
    // Transport fixture only; real screenshot/UI verification belongs to the
    // integration cases. No model or browser is invoked by this unit test.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const name = `${createHash("sha1").update(png).digest("hex")}.png`;
    const html = `<html><img src="data/${name}"></html>`;
    await writeFile(join(htmlDir, "index.html"), html);
    await writeFile(join(htmlDir, "data", name), png);
    await exportHTMLReport(htmlDir, outputDir);
    assert.equal(await readFile(join(outputDir, "report.html"), "utf8"), html);
    assert.deepEqual(await readFile(join(outputDir, "data", name)), png);

    await rm(outputDir, { recursive: true });
    await mkdir(outputDir);
    await rm(join(htmlDir, "data", name));
    await symlink(join(htmlDir, "index.html"), join(htmlDir, "data", name));
    await assert.rejects(exportHTMLReport(htmlDir, outputDir), /regular PNG/);
    await assert.rejects(readFile(join(outputDir, "report.html")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
