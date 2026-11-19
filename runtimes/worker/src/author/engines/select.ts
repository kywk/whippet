import type { AIConfig } from "../../ai/config.js";
import { builtinEngine, type AgentEngine } from "../engine.js";
import { AuthorError } from "../types.js";
import { vercelEngine } from "./vercel.js";

// Explicit backend selection. There is no provider/model/engine fallback.
export function selectAgentEngine(config: AIConfig): AgentEngine {
  if ((config.engine ?? "builtin") === "builtin") return builtinEngine;
  if (config.engine === "vercel") return vercelEngine(config);
  if (config.engine === "pi") return { run: async input => (await import("./pi.js")).piEngine(config).run(input) };
  throw new AuthorError("invalid_input");
}
