import { rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface ModuleABI { slug: string; exportName: string }

const slugPattern = /^[a-z][a-z0-9-]{0,63}$/;
const exportPattern = /^[$_\p{L}][$_\p{L}\p{N}\p{Mn}\p{Mc}\u200c\u200d]*$/u;
const reserved = new Set("arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(" "));

export function validModuleABI(value: unknown): value is ModuleABI {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && Object.hasOwn(item, "slug") && Object.hasOwn(item, "exportName") &&
    typeof item.slug === "string" && slugPattern.test(item.slug) && typeof item.exportName === "string" &&
    exportPattern.test(item.exportName) && !reserved.has(item.exportName);
}

// Install only in a private execution directory. The immutable bundle and harness
// remain byte-for-byte unchanged; @lib/<slug> resolves through this facade.
export async function installModuleABI(taskDir: string, abi: ModuleABI): Promise<void> {
  if (!validModuleABI(abi)) throw new Error("invalid_module_abi");
  const original = join(taskDir, "lib", `${abi.slug}.ts`);
  // Keep the implementation out of the predictable @lib/<slug> namespace.
  const sourceName = `.whippet-abi-source-${randomBytes(16).toString("hex")}`;
  await rename(original, join(taskDir, "lib", `${sourceName}.ts`));
  const source = JSON.stringify(`./${sourceName}`);
  const wrapper = `import { ${abi.exportName} as __whippetOriginal } from ${source};\n` +
    `export * from ${source};\n` +
    `export const ${abi.exportName} = (...args: unknown[]) => {\n` +
    `  const value = args[0] as Record<string, unknown> | undefined;\n` +
    `  if (args.length !== 1 || value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "page") || value.page === null || typeof value.page !== "object") throw new Error("module_abi_mismatch");\n` +
    `  return __whippetOriginal(value);\n` +
    `};\n`;
  await writeFile(original, wrapper, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
