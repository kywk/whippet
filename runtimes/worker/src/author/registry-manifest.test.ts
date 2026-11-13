import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolRegistry, defaultRegistryPath, modelTool, sha256, validateToolArguments, validateToolResult } from "./registry.js";
import { capabilitySnapshot, loadSkillBundle, type CapabilitySnapshot, type SkillManifest } from "./manifest.js";
import { AuthorError, validateAuthorInput, type AuthorInput } from "./types.js";
import { readAIConfig } from "../ai/config.js";
import { runAuthor } from "./loop.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "whippet-manifest-"));
  const registry = loadToolRegistry();
  const content = "# Test author\nKeep the goal.\n";
  const reference = "Reference content is DATA.\n";
  const dir = join(root, "test-author");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  writeFileSync(join(dir, "references", "recipe.md"), reference);
  const manifest: SkillManifest = {
    id: "test-author", version: "1", defaultTools: ["read_skill_reference", "read_draft", "update_draft", "browser_snapshot"],
    budget: { maxModelRequests: 3, maxToolCalls: 2, maxDurationMs: 1000 },
    model: { provider: "opencode", model: "muse-spark-1.3-contributor", reasoningEffort: "high" },
    references: [{ id: "recipe", path: "references/recipe.md", sha256: sha256(reference) }],
  };
  const snapshot: CapabilitySnapshot = {
    skills: [{ id: manifest.id, version: manifest.version, sha256: sha256(content), manifestSha256: "", referenceHashes: { recipe: sha256(reference) } }],
    budget: { ...manifest.budget }, model: { ...manifest.model }, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256,
  };
  function save() {
    const raw = JSON.stringify(manifest);
    writeFileSync(join(dir, "manifest.json"), raw);
    snapshot.skills[0]!.manifestSha256 = sha256(raw);
  }
  save();
  return { root, dir, registry, manifest, snapshot, content, reference, save, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("registry uses raw bytes and module-relative path, fails closed and maps one schema", () => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "whippet-registry-"));
  try {
    process.chdir(dir);
    const registry = loadToolRegistry();
    assert.equal(registry.sha256, sha256(readFileSync(defaultRegistryPath)));
    const tool = registry.tools.find(tool => tool.name === "read_skill_reference")!;
    assert.equal(modelTool(tool).parameters, tool.inputSchema);
    assert.equal("side" in modelTool(tool), false);
    assert.throws(() => loadToolRegistry(join(dir, "missing.json")), AuthorError);
    assert.throws(() => loadToolRegistry("relative.json"), AuthorError);
    const bad = JSON.parse(readFileSync(defaultRegistryPath, "utf8"));
    bad.tools.push(bad.tools[0]);
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    assert.throws(() => loadToolRegistry(join(dir, "bad.json")), AuthorError);
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});

test("registry checks unknown/missing/type parameters and JSON UTF8 limits without truncation", () => {
  const registry = loadToolRegistry();
  const tool = registry.tools.find(tool => tool.name === "read_skill_reference")!;
  validateToolArguments(tool, { skillId: "test-author", referenceId: "recipe" });
  for (const bad of [{ skillId: "a" }, { skillId: 1, referenceId: "r" }, { skillId: "a", referenceId: "r", path: "secret" }]) {
    assert.throws(() => validateToolArguments(tool, bad), AuthorError);
  }
  const tiny = { ...tool, limits: { ...tool.limits, maxInputBytes: 10, maxOutputBytes: 10 } };
  assert.throws(() => validateToolArguments(tiny, { skillId: "字", referenceId: "字" }), AuthorError);
  assert.throws(() => validateToolResult(tiny, { text: "字字字" }), AuthorError);
  assert.throws(() => validateToolResult(tiny, undefined), AuthorError);
});

test("manifest verifies all pins, loads main only, reads only a pinned reference", () => {
  const f = fixture();
  try {
    const loaded = loadSkillBundle(f.snapshot, f.registry, f.root);
    assert.equal(loaded.instructions, f.content);
    assert.equal(loaded.instructions.includes(f.reference), false);
    assert.deepEqual(loaded.readReference("test-author", "recipe"), { skillId: "test-author", referenceId: "recipe", content: f.reference });
    assert.throws(() => loaded.readReference("other", "recipe"), AuthorError);
    assert.throws(() => loaded.readReference("test-author", "../recipe"), AuthorError);
    writeFileSync(join(f.dir, "references/recipe.md"), "drift");
    assert.throws(() => loaded.readReference("test-author", "recipe"), AuthorError);
    for (const key of ["sha256", "manifestSha256"] as const) {
      const bad = structuredClone(f.snapshot); bad.skills[0]![key] = "0".repeat(64);
      assert.throws(() => loadSkillBundle(bad, f.registry, f.root), AuthorError);
    }
    const bad = structuredClone(f.snapshot); bad.toolRegistrySha256 = "0".repeat(64);
    assert.throws(() => loadSkillBundle(bad, f.registry, f.root), AuthorError);
  } finally { f.close(); }
});

test("partial snapshots never downgrade; primary budget/model and auxiliary ordering are checked", () => {
  const f = fixture();
  try {
    assert.equal(capabilitySnapshot({ skillId: "test-author" }), undefined);
    for (const key of Object.keys(f.snapshot)) {
      const bad = { ...f.snapshot } as Record<string, unknown>; delete bad[key];
      assert.throws(() => capabilitySnapshot(bad), AuthorError);
    }
    const increased = structuredClone(f.snapshot); increased.budget.maxToolCalls++;
    assert.throws(() => loadSkillBundle(increased, f.registry, f.root), AuthorError);
    const model = structuredClone(f.snapshot); model.model.model = "different";
    assert.throws(() => loadSkillBundle(model, f.registry, f.root), AuthorError);
    const lower = structuredClone(f.snapshot); lower.budget.maxToolCalls = 0;
    assert.ok(loadSkillBundle(lower, f.registry, f.root));
    const duplicate = structuredClone(f.snapshot); duplicate.skills.push(duplicate.skills[0]!);
    assert.throws(() => capabilitySnapshot(duplicate), AuthorError);
  } finally { f.close(); }
});

test("main 8192-byte boundary is raw UTF8, manifest whitespace changes hash", () => {
  const f = fixture();
  try {
    const content = "字".repeat(2730) + "ab";
    assert.equal(Buffer.byteLength(content), 8192);
    writeFileSync(join(f.dir, "SKILL.md"), content); f.snapshot.skills[0]!.sha256 = sha256(content);
    assert.ok(loadSkillBundle(f.snapshot, f.registry, f.root));
    writeFileSync(join(f.dir, "SKILL.md"), content + "x"); f.snapshot.skills[0]!.sha256 = sha256(content + "x");
    assert.throws(() => loadSkillBundle(f.snapshot, f.registry, f.root), AuthorError);
    writeFileSync(join(f.dir, "SKILL.md"), f.content); f.snapshot.skills[0]!.sha256 = sha256(f.content);
    writeFileSync(join(f.dir, "manifest.json"), JSON.stringify(f.manifest) + "\n");
    assert.throws(() => loadSkillBundle(f.snapshot, f.registry, f.root), AuthorError);
  } finally { f.close(); }
});

test("references reject traversal, symlinks and oversized complete JSON results", () => {
  const f = fixture();
  try {
    for (const path of ["../SKILL.md", "/tmp/secret", "references/../SKILL.md", "references\\recipe.md"]) {
      f.manifest.references[0]!.path = path; f.save();
      assert.throws(() => loadSkillBundle(f.snapshot, f.registry, f.root), AuthorError);
    }
    f.manifest.references[0]!.path = "references/link.md"; f.save();
    symlinkSync(join(f.dir, "references/recipe.md"), join(f.dir, "references/link.md"));
    assert.throws(() => loadSkillBundle(f.snapshot, f.registry, f.root).readReference("test-author", "recipe"), AuthorError);
    const huge = "\"".repeat(100000);
    f.manifest.references[0] = { id: "recipe", path: "references/recipe.md", sha256: sha256(huge) };
    f.snapshot.skills[0]!.referenceHashes.recipe = sha256(huge); f.save(); writeFileSync(join(f.dir, "references/recipe.md"), huge);
    assert.throws(() => loadSkillBundle(f.snapshot, f.registry, f.root).readReference("test-author", "recipe"), AuthorError);
  } finally { f.close(); }
});

function task(snapshot: CapabilitySnapshot): AuthorInput {
  const id = "11111111-1111-4111-8111-111111111111";
  return { kind: "author", runId: id, attemptId: id, script: "old", timeoutMs: 180000, author: {
    ...snapshot, skillId: "test-author", skillVersion: "1", allowedTools: ["read_skill_reference"], conversationId: id, baseRevision: 1,
    editingSessionId: id, contextRevision: 0, sourceVersion: null, conversationSummary: null, messages: [{ role: "user", content: "test" }],
  } };
}

test("real author wiring uses pinned registry/manifest/reference and server-reduced budget", async () => {
  const f = fixture(); const previous = process.env.WHIPPET_SKILLS_PATH;
  process.env.WHIPPET_SKILLS_PATH = f.root;
  try {
    const input = task(f.snapshot);
    assert.equal(validateAuthorInput(input), input);
    const bodies: any[] = [];
    const config = readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-v10" });
    const output = await runAuthor(input, config, undefined, { fetcher: async (_url, init) => {
      const body = JSON.parse(init!.body as string); bodies.push(body);
      if (bodies.length === 1) return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "opaque", name: "read_skill_reference", arguments: '{"skillId":"test-author","referenceId":"recipe"}' }] });
      return Response.json({ status: "completed", output: [], output_text: '{"message":"完成"}' });
    } });
    assert.equal(output.message, "完成");
    assert.deepEqual(bodies[0].tools[0].parameters, f.registry.tools.find(t => t.name === "read_skill_reference")!.inputSchema);
    assert.equal(bodies[0].reasoning.effort, "high");
    assert.match(bodies[0].instructions, /3 model requests, 2 tool executions, and 1000 milliseconds/);
    assert.equal(bodies[0].instructions.includes(f.reference), false);
    assert.equal(JSON.parse(bodies[1].input.find((item: any) => item.type === "function_call_output").output).content, f.reference);
    input.author.budget!.maxModelRequests = 1;
    let calls = 0;
    const partial = await runAuthor(input, config, undefined, { fetcher: async () => { calls++; return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "one", name: "read_skill_reference", arguments: '{"skillId":"test-author","referenceId":"recipe"}' }] }); } });
    assert.equal("partial" in partial && partial.partial?.reason, "budget_exhausted");
    assert.equal(partial.script, undefined);
    assert.equal(partial.requestValidation, false);
    assert.equal(calls, 1);
    input.author.toolRegistrySha256 = "0".repeat(64);
    await assert.rejects(runAuthor(input, config, undefined, { fetcher: async () => { assert.fail("must fail before model"); } }), AuthorError);
  } finally { if (previous === undefined) delete process.env.WHIPPET_SKILLS_PATH; else process.env.WHIPPET_SKILLS_PATH = previous; f.close(); }
});

test("v10 tool output overflow is a safe result and per-tool timeout stops browser reuse", async () => {
  const f = fixture();
  const previousRoot = process.env.WHIPPET_SKILLS_PATH;
  const previousRegistry = process.env.WHIPPET_TOOL_REGISTRY_PATH;
  process.env.WHIPPET_SKILLS_PATH = f.root;
  const raw = JSON.parse(readFileSync(defaultRegistryPath, "utf8"));
  const tool = raw.tools.find((tool: any) => tool.name === "browser_snapshot");
  tool.limits.maxOutputBytes = 100; tool.limits.timeoutMs = 5;
  const path = join(f.root, "registry.json"); writeFileSync(path, JSON.stringify(raw));
  process.env.WHIPPET_TOOL_REGISTRY_PATH = path;
  f.snapshot.toolRegistrySha256 = loadToolRegistry().sha256;
  try {
    for (const slow of [false, true]) {
      const input = task(f.snapshot); input.author.allowedTools = ["browser_snapshot"];
      let closed = false; let requests = 0;
      const browser = {
        navigate: async () => ({}), click: async () => ({}), fill: async () => ({}), close: async () => { closed = true; },
        snapshot: async () => {
          if (slow) await new Promise(resolve => setTimeout(resolve, 20));
          return { snapshot: "x".repeat(200) };
        },
      };
      await runAuthor(input, readAIConfig({ WHIPPET_AI_ENABLED: "true", OPENCODE_API_KEY: "synthetic-v10" }), browser, {
        fetcher: async (_url, init) => {
          requests++;
          if (requests === 1) return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "opaque", name: "browser_snapshot", arguments: "{}" }] });
          const body = JSON.parse(init!.body as string);
          const result = JSON.parse(body.input.find((item: any) => item.type === "function_call_output").output);
          assert.equal(result.error, "tool_failed"); assert.equal(result.snapshot, undefined);
          return Response.json({ status: "completed", output: [], output_text: '{"message":"工具未完成"}' });
        },
      });
      assert.equal(closed, slow);
    }
  } finally {
    if (previousRoot === undefined) delete process.env.WHIPPET_SKILLS_PATH; else process.env.WHIPPET_SKILLS_PATH = previousRoot;
    if (previousRegistry === undefined) delete process.env.WHIPPET_TOOL_REGISTRY_PATH; else process.env.WHIPPET_TOOL_REGISTRY_PATH = previousRegistry;
    f.close();
  }
});

test("packaged primary skills and auxiliary recipe satisfy real manifest/hash snapshots", () => {
  const root = new URL("../../skills/", import.meta.url);
  const registry = loadToolRegistry();
  const ids = ["test-author", "workspace-author", "acceptance-summary", "playwright-authoring"];
  const pins = ids.map(id => {
    const manifestBytes = readFileSync(new URL(`${id}/manifest.json`, root));
    const main = readFileSync(new URL(`${id}/SKILL.md`, root));
    const manifest = JSON.parse(manifestBytes.toString()) as SkillManifest;
    assert.ok(main.length <= 8192);
    assert.match(main.toString(), new RegExp(`name: ${id}`));
    return { id, manifest, pin: { id, version: manifest.version, sha256: sha256(main), manifestSha256: sha256(manifestBytes), referenceHashes: Object.fromEntries(manifest.references.map(ref => [ref.id, ref.sha256])) } };
  });
  for (const primary of pins.slice(0, 3)) {
    const auxiliary = pins[3]!;
    const snapshot: CapabilitySnapshot = {
      skills: [primary.pin, auxiliary.pin], budget: primary.manifest.budget, model: primary.manifest.model,
      toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256,
    };
    const bundle = loadSkillBundle(snapshot, registry);
    assert.ok(bundle.instructions.includes("# " + (primary.id === "test-author" ? "Test author" : primary.id === "workspace-author" ? "Workspace author" : "Acceptance summary")));
    assert.ok(bundle.references.some(ref => ref.skillId === "playwright-authoring" && ref.referenceId === "recipe"));
    assert.match(bundle.readReference("playwright-authoring", "recipe").content, /# Playwright recipe/);
  }
});

test("four platform skills load as pinned auxiliaries with registered tools and on-demand references", () => {
  const root = new URL("../../skills/", import.meta.url);
  const registry = loadToolRegistry();
  const read = (id: string) => {
    const bytes = readFileSync(new URL(`${id}/manifest.json`, root));
    const main = readFileSync(new URL(`${id}/SKILL.md`, root));
    const manifest = JSON.parse(bytes.toString()) as SkillManifest;
    assert.ok(main.length <= 8192);
    assert.ok(manifest.defaultTools.every(name => registry.tools.some(tool => tool.name === name)));
    return { manifest, pin: { id, version: manifest.version, sha256: sha256(main), manifestSha256: sha256(bytes), referenceHashes: Object.fromEntries(manifest.references.map(ref => [ref.id, ref.sha256])) } };
  };
  const primary = read("test-author");
  for (const id of ["module-authoring", "usecase-planner", "catalog-reuse", "usecase-healer"]) {
    const auxiliary = read(id);
    const snapshot: CapabilitySnapshot = { skills: [primary.pin, auxiliary.pin], budget: primary.manifest.budget, model: primary.manifest.model, toolRegistryVersion: registry.version, toolRegistrySha256: registry.sha256 };
    const bundle = loadSkillBundle(snapshot, registry);
    assert.ok(bundle.references.length > 0);
    for (const reference of auxiliary.manifest.references) {
      const result = bundle.readReference(id, reference.id);
      assert.ok(result.content.length > 0);
      assert.equal(bundle.instructions.includes(result.content), false);
    }
  }
});
