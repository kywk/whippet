import type { AIConfig } from "../../ai/config.js";
import { builtinEngine, type AgentEngine } from "../engine.js";
import { AuthorError } from "../types.js";
import { vercelEngine } from "./vercel.js";

// Explicit backend selection. There is no provider/model/engine fallback.
export function selectAgentEngine(config: AIConfig): AgentEngine {
  if ((config.engine ?? "builtin") === "builtin") return builtinEngine;
  if (config.engine === "vercel") return vercelEngine(config);
  throw new AuthorError("invalid_input");
}
