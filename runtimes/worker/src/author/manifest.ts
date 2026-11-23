import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorError, boundedText } from "./types.js";
import { exactObject, sha256, type ToolRegistry } from "./registry.js";

export interface SkillBudget { maxModelRequests: number; maxToolCalls: number; maxDurationMs: number; maxOutputTokens?: number }
export interface SkillModel { provider: string; model: string; reasoningEffort: "low" | "medium" | "high" | "xhigh" }
export interface SkillSnapshot {
  id: string; version: string; sha256: string; manifestSha256: string; referenceHashes: Record<string, string>;
}
export interface SkillManifest {
  id: string; version: string; defaultTools: string[]; budget: SkillBudget; model: SkillModel;
  references: { id: string; path: string; sha256: string }[];
}
interface SkillFiles {
  manifest: string;
  main: string;
  references: Record<string, string>;
}
export interface CapabilitySnapshot {
  skills: SkillSnapshot[]; budget: SkillBudget; model: SkillModel; toolRegistryVersion: string; toolRegistrySha256: string;
  skillFiles?: Record<string, SkillFiles>;
}
const snapshotKeys = ["skills", "budget", "model", "toolRegistryVersion", "toolRegistrySha256"] as const;
const manifestLimit = 64 * 1024;
const mainLimit = 8192;
const referenceLimit = 128 * 1024;
const skillFilesLimit = 512 * 1024;
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const hash = /^[a-f0-9]{64}$/;
export const defaultSkillsPath = fileURLToPath(new URL("../../skills/", import.meta.url));
function validBudget(v: unknown): v is SkillBudget {
  return (exactObject(v, ["maxModelRequests", "maxToolCalls", "maxDurationMs"]) ||
    exactObject(v, ["maxModelRequests", "maxToolCalls", "maxDurationMs", "maxOutputTokens"]) &&
    Number.isSafeInteger(v.maxOutputTokens) && v.maxOutputTokens >= 1 && v.maxOutputTokens <= 16384) &&
    [v.maxModelRequests, v.maxDurationMs].every(n => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(v.maxToolCalls) && v.maxToolCalls >= 0;
}
function validModel(v: unknown): v is SkillModel {
  return exactObject(v, ["provider", "model", "reasoningEffort"]) && typeof v.provider === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v.provider) &&
    typeof v.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(v.model) && ["low", "medium", "high", "xhigh"].includes(v.reasoningEffort);
}
export function capabilitySnapshot(author: object): CapabilitySnapshot | undefined {
  const value = author as Record<string, unknown>;
  const present = snapshotKeys.filter(key => Object.hasOwn(value, key));
  if (!present.length && !Object.hasOwn(value, "skillFiles")) return undefined;
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
  if ((value.budget.maxOutputTokens ?? 8192) > 8192 && value.skills[0].id !== 'module-authoring') throw new AuthorError('invalid_input');
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
    const supplied = snapshot.skillFiles;
    if (Object.hasOwn(snapshot, "skillFiles") &&
        (!exactObject(supplied, snapshot.skills.map(pin => pin.id)) || Buffer.byteLength(JSON.stringify(supplied)) > skillFilesLimit)) throw new Error();
    const loaded = snapshot.skills.map(pin => {
      const files = supplied?.[pin.id];
      if (supplied && (!exactObject(files, ["manifest", "main", "references"]) ||
          !boundedText(files.manifest, manifestLimit) || !boundedText(files.main, mainLimit) ||
          !exactObject(files.references, Object.keys(pin.referenceHashes)))) throw new Error();
      const bytes = files ? files.manifest : packaged(root, `${pin.id}/manifest.json`, manifestLimit).toString("utf8");
      const main = files ? files.main : packaged(root, `${pin.id}/SKILL.md`, mainLimit).toString("utf8");
      if (sha256(bytes) !== pin.manifestSha256 || sha256(main) !== pin.sha256) throw new Error();
      const m: unknown = JSON.parse(bytes);
      if (!exactObject(m, ["id", "version", "defaultTools", "budget", "model", "references"]) || m.id !== pin.id || m.version !== pin.version ||
          !validBudget(m.budget) || ((m.budget.maxOutputTokens ?? 8192) > 8192 && m.id !== 'module-authoring') || !validModel(m.model) || !Array.isArray(m.defaultTools) || new Set(m.defaultTools).size !== m.defaultTools.length ||
          !m.defaultTools.every((name: unknown) => typeof name === "string" && registry.tools.some(tool => tool.name === name)) || !Array.isArray(m.references)) throw new Error();
      const ids = new Set<string>();
      for (const ref of m.references) {
        if (!exactObject(ref, ["id", "path", "sha256"]) || typeof ref.id !== "string" || !identifier.test(ref.id) || ids.has(ref.id) ||
            typeof ref.path !== "string" || !/^references\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(ref.path) ||
            typeof ref.sha256 !== "string" || !hash.test(ref.sha256) || pin.referenceHashes[ref.id] !== ref.sha256) throw new Error();
        if (files) {
          const content = files.references[ref.id];
          if (!boundedText(content, referenceLimit) || sha256(content) !== ref.sha256) throw new Error();
        }
        ids.add(ref.id);
      }
      if (Object.keys(pin.referenceHashes).length !== ids.size) throw new Error();
      return { manifest: m as unknown as SkillManifest, content: main, pin, files };
    });
    const primary = loaded[0]!.manifest;
    if ((['maxModelRequests','maxToolCalls','maxDurationMs'] as const).some(key => snapshot.budget[key] > primary.budget[key]) ||
        (snapshot.budget.maxOutputTokens ?? 8192) > (primary.budget.maxOutputTokens ?? 8192) ||
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
          const content = skill.files ? skill.files.references[referenceId] : packaged(root, `${skillId}/${ref.path}`, referenceLimit).toString("utf8");
          if (!boundedText(content, referenceLimit) || sha256(content) !== ref.sha256) throw new Error();
          const result = { skillId, referenceId, content };
          const tool = registry.tools.find(tool => tool.name === "read_skill_reference");
          if (!tool || Buffer.byteLength(JSON.stringify(result)) > tool.limits.maxOutputBytes) throw new Error();
          return result;
        } catch { throw new AuthorError("tool_failed"); }
      },
    };
  } catch { throw new AuthorError("skill_unavailable"); }
}
