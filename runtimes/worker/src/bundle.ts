import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RunFile { path: string; content: string; origin: "manual" | "ai" }
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const modulePath = /^lib\/[a-z][a-z0-9-]{0,63}\.ts$/;
export function runBundle(value: { files?: unknown; script?: unknown; scriptOrigin?: unknown }): { files?: RunFile[]; script: string; origin: "manual" | "ai" | "legacy" } {
  if (value.scriptOrigin !== undefined && !["manual", "ai", "legacy"].includes(value.scriptOrigin as string)) throw new Error("invalid_run_script");
  if (value.files === undefined) {
    if (typeof value.script !== "string" || !value.script.trim() || Buffer.byteLength(value.script) > MAX_FILE_BYTES ||
        value.scriptOrigin !== undefined && !["manual", "ai", "legacy"].includes(value.scriptOrigin as string)) throw new Error("invalid_run_script");
    return { script: value.script, origin: value.scriptOrigin as "manual" | "ai" | "legacy" ?? "legacy" };
  }
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 64) throw new Error("invalid_run_bundle");
  const paths = new Set<string>();
  let bytes = 0;
  let entry: RunFile | undefined;
  const files: RunFile[] = [];
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).length !== 3 ||
        !["path", "content", "origin"].every(key => Object.hasOwn(file, key)) || typeof file.path !== "string" ||
        !(file.path === "tests/test.spec.ts" || modulePath.test(file.path)) || paths.has(file.path) ||
        typeof file.content !== "string" || file.content.includes("\0") || Buffer.from(file.content).toString("utf8") !== file.content ||
        Buffer.byteLength(file.content) > MAX_FILE_BYTES || !["manual", "ai"].includes(file.origin)) throw new Error("invalid_run_bundle");
    bytes += Buffer.byteLength(file.content);
    if (bytes > 8 * 1024 * 1024) throw new Error("invalid_run_bundle");
    paths.add(file.path);
    const copy = { path: file.path, content: file.content, origin: file.origin } as RunFile;
    files.push(copy);
    if (file.path === "tests/test.spec.ts") entry = copy;
  }
  if (!entry?.content.trim() || value.script !== undefined && value.script !== entry.content) throw new Error("invalid_run_bundle");
  return { files, script: entry.content, origin: files.every(file => file.origin === "manual") ? "manual" : "ai" };
}

// The caller owns a fresh task directory; refuse pre-existing/symlink targets.
export async function writeRunFiles(root: string, files: RunFile[]): Promise<void> {
  const checked = runBundle({ files }).files!;
  if (!(await lstat(root)).isDirectory()) throw new Error("invalid_bundle_directory");
  for (const file of checked) {
    const path = join(root, file.path);
    const directory = dirname(path);
    try { await mkdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(directory)).isDirectory()) throw new Error("invalid_bundle_directory");
    await writeFile(path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
}
