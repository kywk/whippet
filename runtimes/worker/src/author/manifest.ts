import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorError } from "./types.js";
import { exactObject, sha256, type ToolRegistry } from "./registry.js";

export interface SkillBudget { maxModelRequests: number; maxToolCalls: number; maxDurationMs: number }
export interface SkillModel { provider: string; model: string; reasoningEffort: "low" | "medium" | "high" | "xhigh" }
export interface SkillSnapshot {
  id: string; version: string; sha256: string; manifestSha256: string; referenceHashes: Record<string, string>;
}
export interface SkillManifest {
  id: string; version: string; defaultTools: string[]; budget: SkillBudget; model: SkillModel;
  references: { id: string; path: string; sha256: string }[];
}
export interface CapabilitySnapshot {
  skills: SkillSnapshot[]; budget: SkillBudget; model: SkillModel; toolRegistryVersion: string; toolRegistrySha256: string;
}
const snapshotKeys = ["skills", "budget", "model", "toolRegistryVersion", "toolRegistrySha256"] as const;
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const hash = /^[a-f0-9]{64}$/;
export const defaultSkillsPath = fileURLToPath(new URL("../../skills/", import.meta.url));
function validBudget(v: unknown): v is SkillBudget {
  return exactObject(v, ["maxModelRequests", "maxToolCalls", "maxDurationMs"]) &&
    [v.maxModelRequests, v.maxDurationMs].every(n => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(v.maxToolCalls) && v.maxToolCalls >= 0;
}
function validModel(v: unknown): v is SkillModel {
  return exactObject(v, ["provider", "model", "reasoningEffort"]) && typeof v.provider === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v.provider) &&
    typeof v.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(v.model) && ["low", "medium", "high", "xhigh"].includes(v.reasoningEffort);
}
export function capabilitySnapshot(author: object): CapabilitySnapshot | undefined {
  const value = author as Record<string, unknown>;
  const present = snapshotKeys.filter(key => Object.hasOwn(value, key));
  if (!present.length) return undefined;
  if (present.length !== snapshotKeys.length || !Array.isArray(value.skills) || !value.skills.length || value.skills.length > 16 ||
      !validBudget(value.budget) || !validModel(value.model) || typeof value.toolRegistryVersion !== "string" || !value.toolRegistryVersion ||
      typeof value.toolRegistrySha256 !== "string" || !hash.test(value.toolRegistrySha256)) throw new AuthorError("invalid_input");
  const seen = new Set<string>();
  let previous = "";
  for (let i = 0; i < value.skills.length; i++) {
    const pin = value.skills[i];
    if (!exactObject(pin, ["id", "version", "sha256", "manifestSha256", "referenceHashes"]) ||
        typeof pin.id !== "string" || !identifier.test(pin.id) || seen.has(pin.id) || typeof pin.version !== "string" || !pin.version ||
        typeof pin.sha256 !== "string" || !hash.test(pin.sha256) || typeof pin.manifestSha256 !== "string" || !hash.test(pin.manifestSha256) ||
        !pin.referenceHashes || typeof pin.referenceHashes !== "object" || Array.isArray(pin.referenceHashes) ||
        !Object.entries(pin.referenceHashes).every(([id, digest]) => identifier.test(id) && typeof digest === "string" && hash.test(digest))) throw new AuthorError("invalid_input");
    if (i > 0) { if (pin.id <= previous) throw new AuthorError("invalid_input"); previous = pin.id; }
    seen.add(pin.id);
  }
  return value as unknown as CapabilitySnapshot;
}
function packaged(root: string, relative: string, maxBytes: number): Buffer {
  if (!isAbsolute(root) || relative.includes("\\") || !relative.split("/").every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) throw new Error();
  let path = root;
  if (!lstatSync(root).isDirectory()) throw new Error();
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const stat = lstatSync(path);
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size > maxBytes) throw new Error();
  }
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes || !Buffer.from(bytes.toString("utf8")).equals(bytes) || bytes.includes(0)) throw new Error();
  return bytes;
}
export function loadSkillBundle(snapshot: CapabilitySnapshot, registry: ToolRegistry, root = process.env.WHIPPET_SKILLS_PATH ?? defaultSkillsPath) {
  try {
    // Public loader also validates direct callers, not only author input.
    capabilitySnapshot(snapshot);
    if (snapshot.toolRegistryVersion !== registry.version || snapshot.toolRegistrySha256 !== registry.sha256) throw new Error();
    const loaded = snapshot.skills.map(pin => {
      const bytes = packaged(root, `${pin.id}/manifest.json`, 64 * 1024);
      const main = packaged(root, `${pin.id}/SKILL.md`, 8192);
      if (sha256(bytes) !== pin.manifestSha256 || sha256(main) !== pin.sha256) throw new Error();
      const m: unknown = JSON.parse(bytes.toString("utf8"));
      if (!exactObject(m, ["id", "version", "defaultTools", "budget", "model", "references"]) || m.id !== pin.id || m.version !== pin.version ||
          !validBudget(m.budget) || !validModel(m.model) || !Array.isArray(m.defaultTools) || new Set(m.defaultTools).size !== m.defaultTools.length ||
          !m.defaultTools.every((name: unknown) => typeof name === "string" && registry.tools.some(tool => tool.name === name)) || !Array.isArray(m.references)) throw new Error();
      const ids = new Set<string>();
      for (const ref of m.references) {
        if (!exactObject(ref, ["id", "path", "sha256"]) || typeof ref.id !== "string" || !identifier.test(ref.id) || ids.has(ref.id) ||
            typeof ref.path !== "string" || !/^references\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(ref.path) ||
            typeof ref.sha256 !== "string" || !hash.test(ref.sha256) || pin.referenceHashes[ref.id] !== ref.sha256) throw new Error();
        ids.add(ref.id);
      }
      if (Object.keys(pin.referenceHashes).length !== ids.size) throw new Error();
      return { manifest: m as unknown as SkillManifest, content: main.toString("utf8"), pin };
    });
    const primary = loaded[0]!.manifest;
    if (Object.keys(snapshot.budget).some(key => snapshot.budget[key as keyof SkillBudget] > primary.budget[key as keyof SkillBudget]) ||
        Object.keys(snapshot.model).some(key => snapshot.model[key as keyof SkillModel] !== primary.model[key as keyof SkillModel])) throw new Error();
    return {
      instructions: loaded.map(skill => skill.content).join("\n\n"),
      references: loaded.flatMap(skill => skill.manifest.references.map(ref => ({ skillId: skill.pin.id, referenceId: ref.id }))),
      defaultTools: new Set(loaded.flatMap(skill => skill.manifest.defaultTools)),
      readReference(skillId: string, referenceId: string) {
        try {
          const skill = loaded.find(skill => skill.pin.id === skillId);
          const ref = skill?.manifest.references.find(ref => ref.id === referenceId);
          if (!skill || !ref) throw new Error();
          const bytes = packaged(root, `${skillId}/${ref.path}`, 128 * 1024);
          if (sha256(bytes) !== ref.sha256) throw new Error();
          const result = { skillId, referenceId, content: bytes.toString("utf8") };
          const tool = registry.tools.find(tool => tool.name === "read_skill_reference");
          if (!tool || Buffer.byteLength(JSON.stringify(result)) > tool.limits.maxOutputBytes) throw new Error();
          return result;
        } catch { throw new AuthorError("tool_failed"); }
      },
    };
  } catch { throw new AuthorError("skill_unavailable"); }
}
