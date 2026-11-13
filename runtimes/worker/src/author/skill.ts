import { readFileSync } from "node:fs";
import { AuthorError, type AuthorInput } from "./types.js";

// src/author and dist/author have the same depth beneath the package root.
// Docker COPY preserves skills/ beside dist/; cwd is intentionally irrelevant.
const root = new URL("../../skills/", import.meta.url);
const cache = new Map<string,string>();
const skills = {
  "test-author": { path: "test-author/SKILL.md", heading: "# Test author" },
  "acceptance-summary": { path: "acceptance-summary/SKILL.md", heading: "# Acceptance summary" },
  "workspace-author": { path: "workspace-author/SKILL.md", heading: "# Workspace author" },
} as const;

function read(path: string, heading: string): string {
  const saved = cache.get(path);
  if (saved !== undefined) return saved;
  try {
    const markdown = readFileSync(new URL(path,root), "utf8");
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    if (!body.startsWith(heading) || Buffer.byteLength(body)>4096) throw new Error("invalid packaged skill");
    cache.set(path,body);return body;
  } catch {throw new AuthorError("skill_unavailable");}
}

export function loadPlaywrightAuthoringSkill(): string {
  return `${read("playwright-authoring/SKILL.md","# Playwright authoring")}\n\n${read("playwright-authoring/references/recipe.md","# Playwright recipe")}`;
}

export function loadAuthorSkill(author: AuthorInput["author"]): string {
  if (author.skillId === undefined) return loadPlaywrightAuthoringSkill();
  if (author.skillVersion !== "1" || !Object.hasOwn(skills,author.skillId)) throw new AuthorError("skill_unavailable");
  const skill=skills[author.skillId as keyof typeof skills];
  if(author.skillId==="workspace-author")return read(skill.path,skill.heading);
  return `${read(skill.path,skill.heading)}\n\n${read("playwright-authoring/references/recipe.md","# Playwright recipe")}`;
}
