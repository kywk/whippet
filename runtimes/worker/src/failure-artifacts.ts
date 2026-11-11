import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FAILURE_LIMITS = { zipBytes: 64 * 1024 * 1024, mdBytes: 1024 * 1024, count: 32, totalBytes: 128 * 1024 * 1024, scanEntries: 2048, depth: 4 } as const;
type Warning = "scan_limit" | "unsafe_directory" | "invalid_name" | "invalid_file" | "invalid_content" | "hash_mismatch" | "quota" | "write_failed";
const nativeName = /^[0-9a-f]{40}\.(zip|md)$/;

// Optional evidence never changes the assertion result. All warnings are fixed
// codes; no path, file contents, arbitrary error or credentials are printed.
export async function exportFailureArtifacts(htmlDir: string, testResultsDir: string, outputDir: string, warn: (reason: Warning) => void = () => undefined): Promise<void> {
  const seen = new Set<string>();
  let total = 0;
  let scanned = 0;
  let scanWarning = false;
  async function* entries(dir: string, depth = 0): AsyncGenerator<{ path: string; name: string }> {
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) { warn("unsafe_directory"); return; }
      const handle = await opendir(dir);
      for await (const entry of handle) {
        if (++scanned > FAILURE_LIMITS.scanEntries) {
          if (!scanWarning) { warn("scan_limit"); scanWarning = true; }
          return;
        }
        if (seen.size >= FAILURE_LIMITS.count) { warn("quota"); return; }
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < FAILURE_LIMITS.depth && dir !== join(htmlDir, "data")) yield* entries(path, depth + 1);
        else yield { path, name: entry.name };
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warn("unsafe_directory");
    }
  }
  async function copy(path: string, ext: "zip" | "md", expected?: string): Promise<void> {
    let body: Buffer;
    const limit = ext === "zip" ? FAILURE_LIMITS.zipBytes : FAILURE_LIMITS.mdBytes;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size < 1 || info.size > limit) { warn("invalid_file"); return; }
        if (total + info.size > FAILURE_LIMITS.totalBytes) { warn("quota"); return; }
        const buffer = Buffer.alloc(info.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size !== info.size || size > limit) { warn("invalid_file"); return; }
        body = buffer.subarray(0, size);
      } finally { await file.close(); }
    } catch { warn("invalid_file"); return; }
    if (ext === "zip") {
      if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b || !["0304", "0506"].includes(body.subarray(2, 4).toString("hex"))) { warn("invalid_content"); return; }
    } else {
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { warn("invalid_content"); return; }
    }
    const name = `${createHash("sha1").update(body).digest("hex")}.${ext}`;
    if (expected !== undefined && expected !== name) { warn("hash_mismatch"); return; }
    if (seen.has(name)) return;
    if (seen.size >= FAILURE_LIMITS.count || total + body.length > FAILURE_LIMITS.totalBytes) { warn("quota"); return; }
    try {
      const dir = join(outputDir, "data");
      await mkdir(dir, { recursive: true });
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) { warn("unsafe_directory"); return; }
      await writeFile(join(dir, name), body, { flag: "wx", mode: 0o600 });
      seen.add(name); total += body.length;
    } catch { warn("write_failed"); }
  }
  let htmlSafe = false;
  try { const info = await lstat(htmlDir); htmlSafe = info.isDirectory() && !info.isSymbolicLink(); if (!htmlSafe) warn("unsafe_directory"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warn("unsafe_directory"); }
  if (htmlSafe) for await (const entry of entries(join(htmlDir, "data"))) {
      if (!/\.(zip|md)$/i.test(entry.name)) continue;
      if (!nativeName.test(entry.name)) { warn("invalid_name"); continue; }
      await copy(entry.path, entry.name.endsWith(".zip") ? "zip" : "md", entry.name);
  }
  // This root is the current attempt's output/test-results only. Never scan
  // other tasks or unpack trace content; hash-dedup against native HTML data.
  for await (const entry of entries(testResultsDir)) {
    if (entry.name === "trace.zip") await copy(entry.path, "zip");
    else if (entry.name === "error-context.md") await copy(entry.path, "md");
  }
}
