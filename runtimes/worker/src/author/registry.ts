import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorError } from "./types.js";

import { assertSchema, matchesSchema, type JsonSchema } from "./schema.js";
export interface ToolSchema extends JsonSchema { type: "object"; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false }
export interface ToolDefinition {
  name: string; description: string; inputSchema: ToolSchema;
  side: "server" | "worker"; effect: "read" | "candidate" | "browser" | "queue";
  limits: { timeoutMs: number; maxInputBytes: number; maxOutputBytes: number };
}
export interface ToolRegistry { schemaVersion: 1; version: string; tools: ToolDefinition[]; sha256: string }
export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export const defaultRegistryPath = fileURLToPath(new URL("../../../../contracts/tools/registry.json", import.meta.url));
export function exactObject(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function loadToolRegistry(path = process.env.WHIPPET_TOOL_REGISTRY_PATH ?? defaultRegistryPath): ToolRegistry {
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    const bytes = readFileSync(path);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!exactObject(value, ["schemaVersion", "version", "tools"]) || value.schemaVersion !== 1 || typeof value.version !== "string" || !value.version || !Array.isArray(value.tools)) throw new Error();
    const names = new Set<string>();
    for (const tool of value.tools) {
      if (!exactObject(tool, ["name", "description", "inputSchema", "side", "effect", "limits"]) ||
          typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name) || names.has(tool.name) ||
          typeof tool.description !== "string" || !tool.description || !["server", "worker"].includes(tool.side) || !["read", "candidate", "browser", "queue"].includes(tool.effect) ||
          !exactObject(tool.limits, ["timeoutMs", "maxInputBytes", "maxOutputBytes"]) || !Object.values(tool.limits).every(n => Number.isSafeInteger(n) && (n as number) > 0)) throw new Error();
      const schema = tool.inputSchema;
      assertSchema(schema);
      if (schema.type !== "object" || schema.additionalProperties !== false || !schema.properties || !schema.required) throw new Error();
      names.add(tool.name);
    }
    return { ...(value as unknown as Omit<ToolRegistry, "sha256">), sha256: sha256(bytes) };
  } catch { throw new AuthorError("invalid_input"); }
}
export function modelTool(tool: ToolDefinition) {
  // Dynamic object keys and optional union fields cannot use strict Responses mode.
  // Only provider representation drops extension keywords; guard uses original schema.
  const extended = JSON.stringify(tool.inputSchema).includes('"x-max') || JSON.stringify(tool.inputSchema).includes('"oneOf"');
  const parameters = extended ? JSON.parse(JSON.stringify(tool.inputSchema, (key,value) => key.startsWith("x-") ? undefined : value)) as ToolSchema : tool.inputSchema;
  return { type: "function", name: tool.name, description: tool.description, strict: !extended, parameters };
}
export function validateToolArguments(tool: ToolDefinition, value: unknown): asserts value is Record<string, unknown> {
  if (!matchesSchema(tool.inputSchema, value) || Buffer.byteLength(JSON.stringify(value)) > tool.limits.maxInputBytes) throw new AuthorError("tool_failed");
  // Reserved page injection is a semantic rule for the Plan's argument map.
  if (tool.name === "propose_plan" && (value as { stages: { args: Record<string, unknown> }[] }).stages.some(stage => Object.hasOwn(stage.args, "page"))) throw new AuthorError("tool_failed");
}
export function validateToolResult(tool: ToolDefinition, value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > tool.limits.maxOutputBytes) throw new AuthorError("tool_failed");
}
