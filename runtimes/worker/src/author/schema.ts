// Deliberately bounded JSON Schema subset used by the pinned tool registry.
export interface JsonSchema {
  type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[];
  additionalProperties?: boolean | JsonSchema; propertyNames?: JsonSchema; items?: JsonSchema;
  oneOf?: JsonSchema[]; const?: unknown; enum?: unknown[]; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; maxProperties?: number; minLength?: number; maxLength?: number;
  pattern?: string; format?: string; "x-maxUtf8Bytes"?: number; "x-maxJsonBytes"?: number; "x-maxDepth"?: number;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const types = new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
const keys = new Set(["type", "properties", "required", "additionalProperties", "propertyNames", "items", "oneOf", "const", "enum", "minimum", "maximum", "minItems", "maxItems", "maxProperties", "minLength", "maxLength", "pattern", "format", "x-maxUtf8Bytes", "x-maxJsonBytes", "x-maxDepth"]);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function assertSchema(value: unknown, depth = 0): asserts value is JsonSchema {
  if (!object(value) || depth > 64 || Object.keys(value).some(k => !keys.has(k))) throw new Error("unsupported schema");
  if (value.type !== undefined && !(typeof value.type === "string" ? types.has(value.type) : Array.isArray(value.type) && value.type.length > 0 && new Set(value.type).size === value.type.length && value.type.every(t => typeof t === "string" && types.has(t)))) throw new Error("schema type");
  for (const k of ["minimum", "maximum"]) if (value[k] !== undefined && (typeof value[k] !== "number" || !Number.isFinite(value[k]))) throw new Error("schema number");
  for (const k of ["minItems", "maxItems", "maxProperties", "minLength", "maxLength", "x-maxUtf8Bytes", "x-maxJsonBytes", "x-maxDepth"]) if (value[k] !== undefined && (!Number.isSafeInteger(value[k]) || (value[k] as number) < 0)) throw new Error("schema bound");
  if (value.pattern !== undefined) { if (typeof value.pattern !== "string") throw new Error("schema pattern"); new RegExp(value.pattern, "u"); }
  if (value.format !== undefined && value.format !== "uuid") throw new Error("schema format");
  if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length || !value.required.every(k => typeof k === "string" && object(value.properties) && Object.hasOwn(value.properties, k)))) throw new Error("schema required");
  if (value.properties !== undefined) { if (!object(value.properties)) throw new Error("schema properties"); for (const [k, s] of Object.entries(value.properties)) { if (forbidden.has(k)) throw new Error("schema key"); assertSchema(s, depth + 1); } }
  for (const k of ["propertyNames", "items"]) if (value[k] !== undefined) assertSchema(value[k], depth + 1);
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") assertSchema(value.additionalProperties, depth + 1);
  if (value.oneOf !== undefined) { if (!Array.isArray(value.oneOf) || !value.oneOf.length) throw new Error("schema oneOf"); value.oneOf.forEach(s => assertSchema(s, depth + 1)); }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new Error("schema enum");
}
function jsonDepth(v: unknown, seen = new Set<object>(), depth = 0): number {
  if (v === null || typeof v === "boolean" || typeof v === "string" && Buffer.from(v).toString("utf8") === v || typeof v === "number" && Number.isFinite(v)) return depth;
  if (typeof v !== "object" || seen.has(v) || depth > 64 || !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("not JSON");
  seen.add(v);
  let max = depth + 1;
  for (const [k, item] of Object.entries(v)) { if (forbidden.has(k)) throw new Error("unsafe key"); max = Math.max(max, jsonDepth(item, seen, depth + 1)); }
  if (Array.isArray(v) && Object.keys(v).length !== v.length) throw new Error("sparse JSON");
  seen.delete(v); return max;
}
export function matchesSchema(s: JsonSchema, v: unknown): boolean {
  try {
    const depth = jsonDepth(v);
    if (s["x-maxDepth"] !== undefined && depth > s["x-maxDepth"] || s["x-maxJsonBytes"] !== undefined && Buffer.byteLength(JSON.stringify(v)) > s["x-maxJsonBytes"]) return false;
    if (s.oneOf && s.oneOf.filter(branch => matchesSchema(branch, v)).length !== 1) return false;
    if (Object.hasOwn(s, "const") && JSON.stringify(s.const) !== JSON.stringify(v) || s.enum && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(v))) return false;
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => t === actual || t === "integer" && typeof v === "number" && Number.isSafeInteger(v))) return false;
    if (typeof v === "number" && (s.minimum !== undefined && v < s.minimum || s.maximum !== undefined && v > s.maximum)) return false;
    if (typeof v === "string" && (s.minLength !== undefined && [...v].length < s.minLength || s.maxLength !== undefined && [...v].length > s.maxLength || s["x-maxUtf8Bytes"] !== undefined && Buffer.byteLength(v) > s["x-maxUtf8Bytes"] || s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v) || s.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))) return false;
    if (Array.isArray(v) && (s.minItems !== undefined && v.length < s.minItems || s.maxItems !== undefined && v.length > s.maxItems || s.items && !v.every(item => matchesSchema(s.items!, item)))) return false;
    if (object(v)) {
      if (s.maxProperties !== undefined && Object.keys(v).length > s.maxProperties || s.required?.some(k => !Object.hasOwn(v, k))) return false;
      for (const [k, item] of Object.entries(v)) {
        if (s.propertyNames && !matchesSchema(s.propertyNames, k)) return false;
        const child = s.properties && Object.hasOwn(s.properties,k) ? s.properties[k] : undefined;
        if (child ? !matchesSchema(child, item) : s.additionalProperties === false || typeof s.additionalProperties === "object" && !matchesSchema(s.additionalProperties, item)) return false;
      }
    }
    return true;
  } catch { return false; }
}
