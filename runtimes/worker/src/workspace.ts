export interface WorkspaceSettings {
  revision: number;
  sites: { name: string; url: string }[];
  defaultTestUrl: string;
  timeoutMs: number;
}

function httpURL(value: unknown, empty = false): boolean {
  if (typeof value !== "string" || [...value].length > 2048) return false;
  if (empty && value === "") return true;
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const authority = value.match(/^https?:\/\/([^/?#]*)/i)![1]!;
  if (authority.includes("@") || authority.endsWith(":")) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname !== "" && !url.username && !url.password && url.port !== "0";
  } catch { return false; }
}

// The Server owns normalization. Validate without changing this task snapshot.
export function validateWorkspaceSettings(value: unknown): WorkspaceSettings | undefined {
  if (value === undefined) return undefined; // Pre-M5 inputs remain supported.
  const v = value as WorkspaceSettings | null;
  const invalid = () => { throw new Error("Invalid workspaceSettings snapshot"); };
  if (!v || typeof v !== "object" || Array.isArray(v) ||
    Object.keys(v).some((key) => !["revision", "sites", "defaultTestUrl", "timeoutMs"].includes(key)) ||
    !Number.isSafeInteger(v.revision) || v.revision < 1 ||
    !Number.isInteger(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 3600000 ||
    !httpURL(v.defaultTestUrl, true) || !Array.isArray(v.sites) || v.sites.length > 20) return invalid();
  for (const site of v.sites) {
    if (!site || typeof site !== "object" || Array.isArray(site) ||
      Object.keys(site).some((key) => !["name", "url"].includes(key)) ||
      typeof site.name !== "string" || site.name.trim() === "" || [...site.name.trim()].length > 100 || !httpURL(site.url)) return invalid();
  }
  return v;
}
