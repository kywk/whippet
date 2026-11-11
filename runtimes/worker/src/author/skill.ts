import { readFileSync } from "node:fs";
import { AuthorError } from "./types.js";

// src/author and dist/author have the same depth beneath the package root.
// Docker COPY preserves skills/ beside dist/; cwd is intentionally irrelevant.
const skillURL = new URL("../../skills/playwright-authoring/SKILL.md", import.meta.url);
let cached: string | undefined;

export function loadPlaywrightAuthoringSkill(): string {
  if (cached !== undefined) return cached;
  try {
    const markdown = readFileSync(skillURL, "utf8");
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    if (!body.startsWith("# Playwright authoring") || Buffer.byteLength(body) > 4096) throw new Error("invalid packaged skill");
    cached = body;
    return body;
  } catch {
    throw new AuthorError("skill_unavailable");
  }
}
