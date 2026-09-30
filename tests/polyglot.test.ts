import path from "node:path";
import { mkdtemp, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { QueryService } from "../src/core/query/query-service.js";
import { providerAdapter, capabilities } from "../src/core/adapters/providers.js";
import { emptyAdapterResult } from "../src/core/adapters/contracts.js";
import { boundaryContribution } from "../src/core/graph/boundaries.js";

let root: string;
let result: Awaited<ReturnType<typeof analyzeRepository>>;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "prograph-polyglot-"));
  await cp(path.resolve("tests/fixtures/polyglot"), root, { recursive: true });
  result = await analyzeRepository(root);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("all eight frontends share a graph and expose actual file counts and provider metadata", () => {
  for (const language of ["typescript", "rust", "python", "java", "c", "cpp", "go", "csharp"]) {
    expect(result.graph.nodes.some(n => n.language === language && n.kind === "file"), language).toBe(true);
    const run = result.adapterRuns.find(r => r.adapter === language)!;
    expect(run.detected).toBe(true);
    expect(run.fileCount).toBeLessThan(4);
    expect(run.metadata?.providers).toBeDefined();
  }
  expect(result.graph.diagnostics.filter(d => d.severity === "error")).toEqual([]);
});
test("extracts declarations, inheritance, decorators, types, macros and conservative calls", () => {
  for (const [language, name, kind] of [["python", "Service", "class"], ["python", "load", "method"], ["java", "Item", "class"], ["csharp", "Service", "class"], ["cpp", "Service", "class"], ["go", "Loader", "interface"], ["c", "Item", "struct"]]) {
    expect(result.graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ language, name, kind })]));
  }
  expect(result.graph.edges.some(e => e.kind === "extends" && e.evidence.some(v => v.adapter === "python"))).toBe(true);
  expect(result.graph.nodes.some(n => n.language === "python" && n.kind === "type_alias" && n.name === "Items")).toBe(true);
  expect(result.graph.edges.some(e => e.kind === "uses_type" && e.evidence.some(v => v.matchedSyntax === "decorator"))).toBe(true);
  expect(result.graph.nodes.some(n => n.metadata.macro === true)).toBe(true);
  const fallbackCalls = result.graph.edges.filter(e => e.kind === "calls" && e.evidence.some(v => ["python", "java", "c", "cpp", "go", "csharp"].includes(v.adapter)));
  expect(fallbackCalls.length).toBeGreaterThan(5);
  expect(fallbackCalls.every(e => ["probable", "unresolved"].includes(e.confidence))).toBe(true);
});
test("schema boundaries are namespaced, queryable, and arbitrary JSON stays quiet", () => {
  expect(result.graph.nodes.filter(n => n.kind === "boundary").map(n => n.name)).toEqual(expect.arrayContaining(["GET /items", "example.Store/Load", "Query.item"]));
  expect(result.graph.nodes.filter(n => n.file === "infra/noise.json")).toEqual([]);
  const query = new QueryService(path.join(root, ".prograph", "graph.sqlite"));
  try {
    expect((query.frameworkBindings("http").nodes as unknown[]).length).toBeGreaterThan(0);
    expect(query.adapters()).toEqual(expect.arrayContaining([expect.objectContaining({ adapter: "python", metadata: expect.objectContaining({ semanticProviderAvailable: false }) })]));
  } finally { query.close(); }
});
test("explicit boundary participants match only the same protocol and namespace", () => {
  const observation = { identity: { protocol: "grpc" as const, namespace: "store", operation: "Load" }, participant: "caller", role: "invokes" as const, confidence: "exact" as const, evidence: [{ adapter: "test" }] };
  const caller = boundaryContribution("repo", observation, "test");
  const handler = boundaryContribution("repo", { ...observation, participant: "handler", role: "implements" }, "test");
  expect(caller.node.id).toBe(handler.node.id);
  expect(boundaryContribution("repo", { ...observation, identity: { ...observation.identity, namespace: "other" } }, "test").node.id).not.toBe(caller.node.id);
});
test("deterministic IDs survive a complete reanalysis", async () => {
  const next = await analyzeRepository(root);
  expect(next.graph.nodes.map(n => n.id).sort()).toEqual(result.graph.nodes.map(n => n.id).sort());
  expect(next.graph.edges.map(n => n.id).sort()).toEqual(result.graph.edges.map(n => n.id).sort());
});
test("optional semantic provider availability and failures preserve syntax evidence", async () => {
  const snapshot = (await scanRepository(root)).snapshot;
  const descriptor = { id: "test-semantic", version: "1", kind: "lsp" as const };
  for (const mode of ["available", "unavailable", "failure"]) {
    const adapter = providerAdapter({ name: "test", version: "1", appliesTo: f => f.endsWith(".py"), capabilities: capabilities({ symbols: "syntax" }), syntax: { descriptor: { id: "test-syntax", version: "1", kind: "syntax" }, async extract() { return { ...emptyAdapterResult(), nodes: [result.graph.nodes[0]!] }; } }, semantic: { descriptor, async probe() { return { ...descriptor, available: mode !== "unavailable" }; }, async resolve() { if (mode === "failure") throw Error("provider failed"); return { ...emptyAdapterResult(), nodes: [result.graph.nodes[1]!] }; } } });
    const analyzed = await adapter.analyze(snapshot);
    expect(analyzed.nodes).toHaveLength(mode === "available" ? 2 : 1);
    expect(analyzed.metadata.semanticProviderAvailable).toBe(mode === "available");
    if (mode !== "available") expect(analyzed.diagnostics).toHaveLength(1);
  }
});
test("malformed source is isolated; compile database and provider versions invalidate indexes", async () => {
  await writeFile(path.join(root, "python", "broken.py"), "def broken(:\n return (\n");
  expect((await repositoryStatus(root)).stale).toBe(true);
  const synced = await syncRepository(root);
  expect(synced.incremental).toBe(false);
  expect(synced.statusAfter.stale).toBe(false);
  const exported = JSON.parse(await readFile(path.join(root, ".prograph/exports/graph.json"), "utf8"));
  expect(exported.diagnostics.some((d: { code: string }) => d.code === "syntax-recovery")).toBe(true);
  expect(exported.nodes.some((n: { language: string }) => n.language === "go")).toBe(true);
  await writeFile(path.join(root, "compile_commands.json"), "[]");
  expect((await repositoryStatus(root)).stale).toBe(true);
});

test("custom in-repository indexes stay fresh and provider changes are detected", async () => {
  const output = path.join(root, "custom-index");
  await analyzeRepository(root, { output });
  expect((await repositoryStatus(root, output)).stale).toBe(false);
  const stateFile = path.join(output, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.adapterVersions.providers = "outdated";
  await writeFile(stateFile, JSON.stringify(state));
  expect((await repositoryStatus(root, output)).adapterVersionsChanged).toBe(true);
});

test("large syntax-only repositories remain deterministic and boundary output is bounded", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "prograph-scale-"));
  try {
    await writeFile(path.join(repository, "prograph.config.json"), JSON.stringify({ adapters: { markdown: false, tests: false, semanticLinker: false } }));
    await Promise.all(Array.from({ length: 150 }, (_, index) => writeFile(path.join(repository, `module_${index}.py`), `class Item:\n    def load(self, key: str) -> str:\n        return missing(key)\n`)));
    await writeFile(path.join(repository, "openapi.json"), JSON.stringify({ openapi: "3.1.0", paths: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`/item/${i}`, { get: {} }])) }));
    const analysis = await analyzeRepository(repository);
    expect(analysis.adapterRuns.find(run => run.adapter === "python")?.fileCount).toBe(150);
    expect(analysis.graph.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const query = new QueryService(path.join(repository, ".prograph/graph.sqlite"));
    try {
      const view = query.frameworkBindings("http");
      expect(view.truncated).toBe(true);
      expect((view.nodes as Array<{ kind: string }>).filter(n => n.kind === "boundary")).toHaveLength(200);
      expect((view.edges as unknown[]).length).toBeLessThanOrEqual(1000);
    } finally { query.close(); }
  } finally { await rm(repository, { recursive: true, force: true }); }
});

test("duplicate declarations never produce a trusted or arbitrarily selected call target", async () => {
  const snapshot = (await scanRepository(root)).snapshot;
  const { polyglotAdapters } = await import("../src/adapters/language/polyglot/index.js");
  const python = polyglotAdapters.find(a => a.name === "python")!;
  const file = "ambiguous.py";
  const output = await python.analyze({ ...snapshot, files: [file], fileContents: new Map([[file, "def run(): pass\ndef run(): pass\ndef caller(): run()\n"]]) });
  expect(output.nodes.filter(n => n.name === "run" && n.kind === "function")).toHaveLength(2);
  expect(output.edges.filter(e => e.kind === "calls").map(e => e.confidence)).toEqual(["unresolved"]);
});

test("compilation databases supply per-translation-unit context without executing commands", async () => {
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "native/api.c", arguments: ["clang", "-DTEST=1", "-c", "native/api.c"] }]));
  const snapshot = (await scanRepository(root)).snapshot;
  const { polyglotAdapters } = await import("../src/adapters/language/polyglot/index.js");
  const result = await polyglotAdapters.find(a => a.name === "c")!.analyze(snapshot);
  expect(result.nodes.find(n => n.kind === "file" && n.file === "native/api.c")?.metadata.compilationContexts).toEqual([{ directory: root, arguments: ["clang", "-DTEST=1", "-c", "native/api.c"] }]);
});

test("a failed syntax provider reports unavailable rather than invented capabilities", async () => {
  const snapshot = (await scanRepository(root)).snapshot;
  const adapter = providerAdapter({ name: "broken", version: "1", appliesTo: () => true, capabilities: capabilities({ syntax: "syntax" }), syntax: { descriptor: { id: "broken", kind: "syntax", version: "1" }, async extract() { throw Error("missing parser"); } } });
  const result = await adapter.analyze(snapshot);
  expect(result.nodes).toEqual([]);
  expect(result.metadata.providers).toEqual([expect.objectContaining({ available: false })]);
  expect(result.diagnostics[0]?.code).toBe("syntax-provider-failure");
});

test("all mixed graph relationship endpoints exist", () => {
  const ids = new Set(result.graph.nodes.map(n => n.id));
  expect(result.graph.edges.filter(e => !ids.has(e.source) || !ids.has(e.target))).toEqual([]);
});
