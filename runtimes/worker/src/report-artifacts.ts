import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pngName = /^[0-9a-f]{40}\.png$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const SCREENSHOT_LIMITS = { fileBytes: 10 * 1024 * 1024, count: 32, totalBytes: 64 * 1024 * 1024 } as const;

// Preserve the HTML reporter's native data/<sha1>.png references. Publish the
// HTML only after every supported PNG has been copied successfully.
export async function exportHTMLReport(htmlDir: string, outputDir: string): Promise<void> {
  const source = join(htmlDir, "data");
  let entries: string[] = [];
  try {
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Report data must be a regular directory");
    entries = (await readdir(source)).sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const pngs = entries.filter((name) => /\.png$/i.test(name));
  if (pngs.length > SCREENSHOT_LIMITS.count || pngs.some((name) => !pngName.test(name))) throw new Error("Screenshot filename/count limit exceeded");
  let total = 0;
  for (const name of pngs) {
    const info = await lstat(join(source, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 8 || info.size > SCREENSHOT_LIMITS.fileBytes) throw new Error("Screenshot must be a bounded regular PNG file");
    total += info.size;
    if (total > SCREENSHOT_LIMITS.totalBytes) throw new Error("Screenshot total size limit exceeded");
  }
  if (pngs.length) await mkdir(join(outputDir, "data"), { recursive: true });
  for (const name of pngs) {
    const body = await readFile(join(source, name));
    if (body.length > SCREENSHOT_LIMITS.fileBytes || !body.subarray(0, 8).equals(pngSignature) || `${createHash("sha1").update(body).digest("hex")}.png` !== name) throw new Error("Screenshot signature/hash mismatch");
    await writeFile(join(outputDir, "data", name), body, { flag: "wx", mode: 0o600 });
  }
  await copyFile(join(htmlDir, "index.html"), join(outputDir, "report.html"));
}
