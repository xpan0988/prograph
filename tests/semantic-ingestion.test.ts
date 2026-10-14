import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import protobuf from "protobufjs";
import { scanRepository } from "../src/core/repository/repository.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { indexSemanticFoundation } from "../src/core/semantic/typescript.js";
import { discoverProjects } from "../src/core/semantic/projects.js";
import { orderPasses, callPass, executePasses, CALL_PASS_SQL } from "../src/core/semantic/passes.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery, semanticQueryForRepository } from "../src/core/semantic/query.js";
import { importScip, type ScipManifest } from "../src/core/semantic/scip-import.js";
import { scipType, validateDocumentSize } from "../src/core/semantic/scip-wire.js";
import { parseScipSymbol } from "../src/core/semantic/scip-symbol.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";
import { digest } from "../src/core/semantic/model.js";
import { indexClang } from "../src/core/semantic/clang.js";
import { inventoryFromDisk, semanticInventory } from "../src/core/semantic/provider-runs.js";
import { existsSync } from "node:fs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-ingestion-")); roots.push(root); await writeFile(path.join(root, "package.json"), '{"name":"fixture"}'); return root; }
function field(id: number, type: string, value: unknown): Buffer {
  const bytes = scipType(type).encode(scipType(type).fromObject(value as Record<string, unknown>)).finish();
  return Buffer.from(protobuf.Writer.create().uint32(id << 3 | 2).bytes(bytes).finish());
}
const global = "scip-python python fixture 1 module/target().";
async function artifact(root: string, docs: Record<string, unknown>[], extra = Buffer.alloc(0)): Promise<{ filename: string; manifest: ScipManifest }> {
  const sources: Record<string, string> = {};
  for (const doc of docs) {
    const file = String(doc.relative_path);
    if (!file.includes("..")) { const text = "target()\n"; await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); sources[file] = digest(text); }
  }
  const bytes = Buffer.concat([field(1, "Metadata", { version: 0, tool_info: { name: "scip-python", version: "fixture" }, project_root: new URL(`file://${root}/`).href, text_document_encoding: 1 }), ...docs.map(doc => field(2, "Document", doc)), extra]);
  const filename = path.join(root, "index.scip"); await writeFile(filename, bytes);
  return { filename, manifest: { format: 1, id: "test", sourceRoot: root, projectContext: "python-fixture", indexDigest: digest(bytes), sources, provider: { name: "scip-python", version: "fixture", basis: "compiler" } } };
}
const doc = (file = "a.py", local = false) => ({ relative_path: file, language: "Python", position_encoding: 2,
  symbols: [{ symbol: local ? "local 1" : global, kind: 17, display_name: "target", documentation: ["documentation"], relationships: local ? [] : [{ symbol: "scip-python python fixture 1 module/base().", is_implementation: true }] }],
  occurrences: [{ symbol: local ? "local 1" : global, range: [0, 0, 6], symbol_roles: 1 }, { symbol: local ? "local 1" : global, single_line_range: { line: 0, start_character: 0, end_character: 6 }, symbol_roles: 8, syntax_kind: 15 }] });

test("SCIP grammar handles package spaces, escaped names and scoped locals", () => {
  expect(parseScipSymbol("scheme npm pkg  name 1 `my/file.ts`/Type#method(+1).")).toMatchObject({ manager: "npm", package: "pkg name", name: "method", local: false });
  expect(parseScipSymbol("local 123")).toMatchObject({ local: true });
  for (const value of ["local ", "scheme npm pkg 1", "scheme npm pkg 1 name?", "local-scheme npm pkg 1 name."]) expect(() => parseScipSymbol(value)).toThrow();
});
test("UTF-8/16/32 column conversion is consistent and rejects partial Unicode boundaries", () => {
  const coordinates = new SourceCoordinates("a.py", "🚀beta\r\nβ");
  expect([coordinates.offset(0, 4, 1), coordinates.offset(0, 2, 2), coordinates.offset(0, 1, 3)]).toEqual([2, 2, 2]);
  expect(coordinates.offset(1, 2, 1)).toBe(9);
  expect(() => coordinates.offset(0, 1, 1)).toThrow(); expect(() => coordinates.offset(0, 1, 2)).toThrow(); expect(() => coordinates.offset(0, 7, 2)).toThrow();
});
test("SCIP physical lines do not interpret Unicode string/comment separators as newlines", async () => {
  const root = await temporary(); const input = await artifact(root, [{ relative_path: "a.py", language: "Python", position_encoding: 2, occurrences: [{ symbol: global, range: [1, 0, 6], symbol_roles: 1 }] }]);
  const text = "# before\u2028longword\ntarget()\n"; await writeFile(path.join(root, "a.py"), text); input.manifest.sources["a.py"] = digest(text);
  expect(await importScip(root, input.filename, input.manifest)).toMatchObject({ accepted: 1 });
  const q = await semanticQueryForRepository(root);
  try { const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key; expect(q.execute("definition", target).items).toMatchObject([{ range: { line: 2, column: 1, startByte: Buffer.byteLength(text.slice(0, text.indexOf("target"))) } }]); } finally { q.close(); }
});
test("streamed interchange imports navigation/native facts without turning highlighting into calls", async () => {
  const root = await temporary(); const unknown = Buffer.from(protobuf.Writer.create().uint32(99 << 3 | 2).bytes(Buffer.from("ignored")).finish());
  const input = await artifact(root, [doc()], unknown); const result = await importScip(root, input.filename, input.manifest);
  expect(result).toMatchObject({ accepted: 1, rejected: 0, calls: "unsupported" });
  const q = await semanticQueryForRepository(root);
  try {
    const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key;
    expect(q.execute("definition", target).items).toHaveLength(1); expect(q.execute("references", target).items).toHaveLength(1);
    expect(q.execute("callers", target).items).toHaveLength(0); expect(q.execute("relationships", target).items).toHaveLength(1);
    expect(q.execute("context", target).items).toMatchObject([{ value: { project: "python-fixture", unit: "scip/test", environmentInputs: 0 } }]);
    expect((q.execute("native", target).items as Array<{ predicate: string }>).some(value => value.predicate === "scip.SymbolInformation")).toBe(true);
    expect(q.execute("references", target).analysisComplete).toBe(false);
  } finally { q.close(); }
});
test("inference-backed SCIP targets cannot become compiler-resolved bindings", async () => {
  const root = await temporary(); const input = await artifact(root, [doc()]); await importScip(root, input.filename, { ...input.manifest, provider: { ...input.manifest.provider, basis: "inference" } });
  const q = await semanticQueryForRepository(root);
  try { const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key; expect(q.execute("references", target).items).toMatchObject([{ confidence: "probable" }]); expect(q.execute("relationships", target).items).toMatchObject([{ confidence: "probable" }]); } finally { q.close(); }
});
test("document-local symbols do not unify across files; repeat import is idempotent", async () => {
  const root = await temporary(); const input = await artifact(root, [doc("a.py", true), doc("b.py", true)]);
  await importScip(root, input.filename, input.manifest); const q = await semanticQueryForRepository(root);
  try { expect(q.execute("find", "local 1").items).toHaveLength(2); } finally { q.close(); }
  const before = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); const facts = (before.db.prepare("SELECT COUNT(*) AS n FROM sc_facts").get() as { n: number }).n; before.close();
  await importScip(root, input.filename, input.manifest); const after = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try { expect((after.db.prepare("SELECT COUNT(*) AS n FROM sc_facts").get() as { n: number }).n).toBe(facts); } finally { after.close(); }
});
test("mismatched and unsafe documents are excluded while verified siblings survive", async () => {
  const root = await temporary(); const input = await artifact(root, [doc("a.py"), doc("b.py"), doc("../outside.py")]);
  await writeFile(path.join(root, "b.py"), "different()\n");
  const result = await importScip(root, input.filename, input.manifest); expect(result).toMatchObject({ accepted: 1, rejected: 2 });
  const q = await semanticQueryForRepository(root); try { const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key; expect(q.execute("definition", target).items).toHaveLength(1); } finally { q.close(); }
});
test("mid-document range failure cannot publish earlier successful batches", async () => {
  const root = await temporary(); const broken = doc(); broken.occurrences.push({ symbol: global, range: [99, 0, 6], symbol_roles: 0 } as typeof broken.occurrences[number]);
  const input = await artifact(root, [broken]); const result = await importScip(root, input.filename, input.manifest, undefined, { batch: 1 }); expect(result).toMatchObject({ accepted: 0, rejected: 1 });
  const q = await semanticQueryForRepository(root); try { expect(q.execute("find", "target").items).toHaveLength(0); } finally { q.close(); }
});
test("malformed framing leaves the active snapshot intact, including a truncated document", async () => {
  const root = await temporary(); const input = await artifact(root, [doc()]); const first = await importScip(root, input.filename, input.manifest);
  const bytes = await readFile(input.filename); const broken = bytes.subarray(0, bytes.length - 1); await writeFile(input.filename, broken);
  await expect(importScip(root, input.filename, { ...input.manifest, indexDigest: digest(broken) })).rejects.toThrow("Truncated");
  const q = await semanticQueryForRepository(root); try { expect(q.execute("status").snapshot).toBe(first.snapshot); } finally { q.close(); }
});
test("resource and legacy encoding policies are explicit", async () => {
  const root = await temporary(); const legacy = doc(); legacy.position_encoding = 0; const input = await artifact(root, [legacy]);
  expect(await importScip(root, input.filename, input.manifest)).toMatchObject({ accepted: 0, rejected: 1 });
  expect(await importScip(root, input.filename, { ...input.manifest, legacyPositionEncoding: 2 })).toMatchObject({ accepted: 1 });
  expect(await importScip(root, input.filename, input.manifest, undefined, { maxOccurrencesPerDocument: 1 })).toMatchObject({ accepted: 0, rejected: 1 });
  expect(await importScip(root, input.filename, input.manifest, undefined, { maxDocumentBytes: 8 })).toMatchObject({ accepted: 0, rejected: 1 });
});
test("project discovery preserves ordered compile variants and real extends inputs", async () => {
  const root = await temporary(); await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/a.ts"), "export const a = 1;"); await writeFile(path.join(root, "src/a.h"), "void f();");
  await writeFile(path.join(root, "base.json"), '{"compilerOptions":{"strict":true}}');
  await writeFile(path.join(root, "tsconfig.json"), '{"extends":"./base.json","include":["src/**/*.ts"]}');
  await writeFile(path.join(root, "tsconfig.other.json"), '{"files":["src/a.ts"],"compilerOptions":{"strict":false}}');
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "src/a.h", arguments: ["clang", "-x", "c", "-DONE", "-DTWO"] }, { directory: root, file: "src/a.h", arguments: ["clang++", "-x", "c++", "-DTWO", "-DONE"] }]));
  const plan = discoverProjects((await scanRepository(root)).snapshot);
  expect(plan.units.filter(unit => unit.language === "typescript")).toHaveLength(2);
  expect(plan.units.filter(unit => unit.language !== "typescript").map(unit => unit.language)).toEqual(["c", "cpp"]);
  expect(Object.keys(plan.units.find(unit => unit.language === "typescript")!.inputs).some(file => file.endsWith("base.json"))).toBe(true);
  expect(plan.units.filter(unit => unit.language !== "typescript")[0]!.context).not.toBe(plan.units.filter(unit => unit.language !== "typescript")[1]!.context);
});
test("multiple compiler projects retain separate identities and documentation edits reuse closed units", async () => {
  const root = await temporary();
  for (const folder of ["one", "two"]) { await mkdir(path.join(root, folder)); await writeFile(path.join(root, folder, "tsconfig.json"), '{"files":["a.ts"],"compilerOptions":{"target":"ES2022"}}'); await writeFile(path.join(root, folder, "a.ts"), "export function same() { return 1; }\n"); }
  await analyzeRepository(root); const q = await semanticQueryForRepository(root); let ids: string[];
  try { ids = (q.execute("find", "same").items as Array<{ key: string }>).map(value => value.key); expect(ids).toHaveLength(2); expect(q.execute("native", ids[0]!).items).toHaveLength(1); expect(q.execute("context", ids[0]!).items).toHaveLength(1); } finally { q.close(); }
  const before = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); const selected = before.db.prepare("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'typescript/%' ORDER BY partition_key").all(before.activeSnapshot()); before.close();
  await writeFile(path.join(root, "README.md"), "# Documentation only\n"); await analyzeRepository(root);
  const after = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try { expect(after.db.prepare("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'typescript/%' ORDER BY partition_key").all(after.activeSnapshot())).toEqual(selected); } finally { after.close(); }
});
test("status and sync invalidate compiler configuration inputs outside the scanner catalogue", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build")); await writeFile(path.join(root, "a.ts"), "export function example() { return 1; }\n");
  await writeFile(path.join(root, "build/options.json"), '{"compilerOptions":{"strict":false}}'); await writeFile(path.join(root, "tsconfig.json"), '{"extends":"./build/options.json","files":["a.ts"]}');
  await analyzeRepository(root); expect((await repositoryStatus(root)).state).toBe("fresh");
  await writeFile(path.join(root, "build/options.json"), '{"compilerOptions":{"strict":true}}');
  const status = await repositoryStatus(root); expect(status.modifiedFiles).toEqual([]); expect(status.semanticInputsChanged).toBe(true); expect(status.state).toBe("stale");
  const sync = await syncRepository(root); expect(sync.fallbackReason).toContain("semantic dependency"); expect(sync.statusAfter.state).toBe("fresh");
});
test("JavaScript inferred constructor properties keep their terminal symbol identity", async () => {
  const root = await temporary(); await writeFile(path.join(root, "tokenizer.js"), "function Tokenizer(source) { this.source = source; this.pos = 0; }\nTokenizer.prototype.next = function() { return this.source[this.pos++]; };\nconst token = new Tokenizer('x'); token.source; token.pos;\nmodule.exports = Tokenizer;\n");
  const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe("partial");
  const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try {
    const properties = store.db.prepare("SELECT e.key,s.name,s.qualified_name FROM sc_symbols s JOIN sc_entities e ON e.id=s.entity WHERE s.kind='BinaryExpression' AND s.name IN ('source','pos') ORDER BY s.name").all() as Array<{ key: string; name: string; qualified_name: string }>;
    expect(properties.map(value => [value.name, value.qualified_name])).toEqual([["pos", "tokenizer.js::Tokenizer::pos"], ["source", "tokenizer.js::Tokenizer::source"]]);
    expect(new Set(properties.map(value => value.key)).size).toBe(2);
  } finally { store.close(); }
});
test("oversized legacy evidence remains intact without exceeding bounded fact payloads", async () => {
  const root = await temporary(); const snapshot = (await scanRepository(root)).snapshot;
  const node = { id: "large", name: "large", qualifiedName: "large", kind: "file" as const, adapter: "fixture", metadata: { original: "x".repeat(70000) } };
  const result = await indexSemanticFoundation(snapshot, { schemaVersion: "1.2.0", repository: snapshot.repository, nodes: [node], edges: [], diagnostics: [] }, path.join(root, "semantic.sqlite"));
  const store = new SemanticStore(path.join(root, "semantic.sqlite"));
  try { const row = store.db.prepare("SELECT f.value_json,e.canonical FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject WHERE a.snapshot=?").get(result.snapshot) as { value_json: string; canonical: string }; expect(JSON.parse(row.canonical)).toEqual(node); expect(JSON.parse(row.value_json)).toMatchObject({ legacyId: "large", payloadStorage: "sc_entities.canonical" }); expect(Buffer.byteLength(row.value_json)).toBeLessThan(65536); } finally { store.close(); }
});
test("pass dependency cycles and absent dependencies are rejected", () => {
  expect(() => orderPasses([{ ...callPass, dependencies: [callPass.id] }])).toThrow("cycle");
  expect(() => orderPasses([{ ...callPass, dependencies: ["missing"] }])).toThrow("Missing");
});
test("dependent passes receive sealed owned outputs in topological order", async () => {
  const root = await temporary(); const store = new SemanticStore(path.join(root, "semantic.sqlite"));
  try {
    const base = store.begin("base", "ctx", "input"); store.seal(base, { status: "partial" });
    const producer = { ...callPass, id: "producer", execute() {} };
    let observed = false;
    const consumer = { ...callPass, id: "consumer", dependencies: ["producer"], execute(view: SemanticStore, _input: number, _output: number, _provenance: unknown, _selector: string, dependencies: ReadonlyMap<string, number>) { const row = view.db.prepare("SELECT partition_key,state FROM sc_runs WHERE id=?").get(dependencies.get("producer")); expect(row).toEqual({ partition_key: "base/pass:producer@1", state: "sealed" }); observed = true; } };
    expect(executePasses(store, base, "base", { provider: "test", version: "1", basis: "compiler", method: "test", context: "ctx", inputFingerprint: "input" }, "selector", [consumer, producer])).toHaveLength(2);
    expect(observed).toBe(true);
  } finally { store.close(); }
});
test("call pass uses indexed targets, respects ownership and cannot strengthen confidence", async () => {
  const root = await temporary(); const store = new SemanticStore(path.join(root, "semantic.sqlite"));
  try {
    const run = store.begin("base", "ctx", "input"); const unrelated = store.begin("other", "ctx", "input");
    const provenance = { provider: "test", version: "1", basis: "compiler" as const, method: "test", context: "ctx", inputFingerprint: "input" };
    const occurrence = new SourceCoordinates("a.ts", "call()").range(0, 6, "ctx", "call");
    store.batch(run, () => {
      for (const key of ["caller", "target", "other-target"]) store.addSymbol({ key, name: key, qualifiedName: key, kind: "function", file: "a.ts", context: "ctx" });
      store.addOccurrence(occurrence, 6); store.selector(run, "inventory", "input");
      store.addFact(run, { predicate: "common.CallSite", context: "ctx", subject: "caller", occurrence: occurrence.key, confidence: "probable", provenance });
      store.addFact(run, { predicate: "common.CallTarget", context: "ctx", subject: "caller", object: "target", occurrence: occurrence.key, confidence: "resolved", provenance });
    });
    store.batch(unrelated, () => store.addFact(unrelated, { predicate: "common.CallTarget", context: "ctx", subject: "caller", object: "other-target", occurrence: occurrence.key, confidence: "resolved", provenance }));
    store.seal(run, { status: "partial" }); store.seal(unrelated, { status: "partial" });
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${CALL_PASS_SQL}`).all(run, 0, 0, 0, 1000) as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes("SEARCH t USING") && row.detail.includes("sc_fact_occurrence"))).toBe(true);
    expect(plan.some(row => row.detail.includes("ot") && row.detail.includes("run=? AND claim=?"))).toBe(true);
    const [pass] = executePasses(store, run, "base", provenance, "inventory");
    expect(store.db.prepare("SELECT c.confidence,e.key FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.object WHERE o.run=?").all(pass)).toEqual([{ confidence: "probable", key: "target" }]);
  } finally { store.close(); }
});
test("old semantic schema remains readable and upgrades additively on writer open", async () => {
  const root = await temporary(); const input = await artifact(root, [doc()]); await importScip(root, input.filename, input.manifest);
  const file = path.join(root, ".prograph/semantic.sqlite"); const store = new SemanticStore(file); store.db.prepare("UPDATE sc_meta SET value='2.0.0-step1' WHERE key='schema'").run(); const snapshot = store.activeSnapshot(); store.close();
  const old = new SemanticStore(file); old.db.exec("DROP TABLE sc_context_lookup"); old.db.prepare("UPDATE sc_meta SET value='2.0.0-step1' WHERE key='schema'").run(); old.close();
  const query = new SemanticQuery(file); try { expect(query.execute("status")).toMatchObject({ snapshot, schema: "2.0.0-step1" }); expect(query.execute("context").items).toEqual([]); expect(String(query.execute("context").gaps)).toContain("unavailable"); } finally { query.close(); }
  const upgraded = new SemanticStore(file); try { expect(upgraded.activeSnapshot()).toBe(snapshot); expect(upgraded.db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get()).toEqual({ value: "2.0.0-step2.1" }); } finally { upgraded.close(); }
});
test("nested wire object quotas are checked before protobuf expands messages", () => {
  const bytes = scipType("Document").encode(scipType("Document").fromObject({ symbols: [{ symbol: global, relationships: Array.from({ length: 1100 }, () => ({ symbol: global })) }] })).finish();
  expect(() => validateDocumentSize(bytes, 1)).toThrow("quota");
});
test("known wire fields require correct types and strict UTF-8 before decoding", () => {
  expect(() => validateDocumentSize(Buffer.from([8, 1]), 100)).toThrow("wire type");
  expect(() => validateDocumentSize(Buffer.from([10, 1, 255]), 100)).toThrow();
});
test("negative roles cannot manufacture a definition", async () => {
  const root = await temporary(); const invalid = doc(); invalid.occurrences[0]!.symbol_roles = -1;
  const input = await artifact(root, [invalid]); expect(await importScip(root, input.filename, input.manifest)).toMatchObject({ accepted: 0, rejected: 1 });
});
test("filename-only inventory matches scanner input identity without hydrating source texts", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a.py"), "def example(): return 1\n"); await writeFile(path.join(root, "README.md"), "# Not a semantic input");
  const inventory = await inventoryFromDisk(root, path.join(root, ".prograph"), 100);
  expect(inventory.inventory).toBe(semanticInventory((await scanRepository(root)).snapshot));
  await expect(inventoryFromDisk(root, path.join(root, ".prograph"), 1)).rejects.toThrow("quota");
});
test("cooperative cancellation during document batches leaves the active snapshot intact", async () => {
  const root = await temporary(); const input = await artifact(root, [doc()]); const first = await importScip(root, input.filename, input.manifest);
  const controller = new AbortController(); const batch = SemanticStore.prototype.batch;
  const injected = vi.spyOn(SemanticStore.prototype, "batch").mockImplementation(function(this: SemanticStore, run: number, action: () => unknown) {
    const result = batch.call(this, run, action);
    const row = this.db.prepare("SELECT r.partition_key,COUNT(*) AS n FROM sc_owned o JOIN sc_runs r ON r.id=o.run WHERE o.run=? GROUP BY r.partition_key").get(run) as { partition_key: string; n: number } | undefined;
    if (row?.partition_key.includes("/document:") && row.n >= 3) controller.abort(Error("injected cancellation"));
    return result;
  });
  try { await expect(importScip(root, input.filename, input.manifest, undefined, { batch: 1 }, controller.signal)).rejects.toThrow("cancellation"); } finally { injected.mockRestore(); }
  const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try { expect(store.activeSnapshot()).toBe(first.snapshot); expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); } finally { store.close(); }
});
test("verified native artifacts survive documentation-only analyze and invalidate as a group on source changes", async () => {
  const root = await temporary(); const input = await artifact(root, [doc("a.py"), doc("b.py")]); await importScip(root, input.filename, input.manifest);
  await writeFile(path.join(root, "README.md"), "documentation only"); expect((await analyzeRepository(root)).manifest.semanticCore?.status).toBe("partial");
  let q = await semanticQueryForRepository(root); try { expect(q.execute("find", "target").items).toHaveLength(1); } finally { q.close(); }
  await writeFile(path.join(root, "a.py"), "different()\n"); await analyzeRepository(root);
  q = await semanticQueryForRepository(root); try { expect(q.execute("find", "target").items).toHaveLength(0); } finally { q.close(); }
});
test.skipIf(!existsSync("/usr/bin/clang"))("real Clang resolves C/C++ declarations, overloads and references under distinct build contexts", async () => {
  const root = await temporary();
  await writeFile(path.join(root, "api.h"), "int target(int value);\n#ifdef __cplusplus\ninline double target(double value) { return value; }\n#endif\n");
  await writeFile(path.join(root, "main.c"), '#include "api.h"\nint caller(void) { return target(1); }\n');
  await writeFile(path.join(root, "main.cpp"), '#include "api.h"\nint caller() { target(1); target(2.0); return 0; }\n');
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", "-std=c11", "-c", "main.c", "-o", "ignored.o"] }, { directory: root, file: "main.cpp", arguments: ["clang++", "-std=c++17", "-c", "main.cpp"] }]));
  const plan = discoverProjects((await scanRepository(root)).snapshot); const c = plan.units.find(unit => unit.language === "c")!; const cpp = plan.units.find(unit => unit.language === "cpp")!;
  expect((await indexClang(root, c.key)).coverage).toMatchObject({ language: "c", unresolved: 0 });
  expect((await indexClang(root, cpp.key)).coverage).toMatchObject({ language: "cpp", unresolved: 0 });
  expect(existsSync(path.join(root, "ignored.o"))).toBe(false);
  const q = await semanticQueryForRepository(root);
  try {
    const targets = q.execute("find", "target").items as Array<{ key: string }>; expect(targets).toHaveLength(3);
    for (const target of targets) { expect(q.execute("definition", target.key).items).toHaveLength(1); expect(q.execute("callers", target.key).items).toHaveLength(1); expect(q.execute("native", target.key).items).toHaveLength(1); }
  } finally { q.close(); }
}, 60000);
test.skipIf(!existsSync("/usr/bin/clang"))("Clang command effects and unrecognized flags are refused, and compiler failures do not publish", async () => {
  const root = await temporary(); await writeFile(path.join(root, "main.c"), "int f() { return 1; }\n");
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", "-Xclang", "-load", "untrusted.so", "main.c"] }]));
  const unit = discoverProjects((await scanRepository(root)).snapshot).units[0]!;
  await expect(indexClang(root, unit.key)).rejects.toThrow("Unsupported compiler argument");
}, 60000);
test.skipIf(!existsSync("/usr/bin/clang"))("changed excluded generated headers invalidate native facts through status/sync", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build")); await writeFile(path.join(root, "build/api.h"), "int target(void);\n");
  await writeFile(path.join(root, "main.c"), '#include "api.h"\nint caller() { return target(); }\n');
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", "-Ibuild", "main.c"] }]));
  await analyzeRepository(root); const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(value => value.language === "c")!; await indexClang(root, unit.key);
  expect((await repositoryStatus(root)).state).toBe("fresh"); await writeFile(path.join(root, "build/api.h"), "int replacement(void);\n");
  const status = await repositoryStatus(root); expect(status.modifiedFiles).toEqual([]); expect(status.semanticInputsChanged).toBe(true);
  const sync = await syncRepository(root); expect(sync.fallbackReason).toContain("semantic dependency");
  const q = await semanticQueryForRepository(root); try { expect(q.execute("find", "target").items).toHaveLength(0); } finally { q.close(); }
}, 60000);
test.skipIf(!existsSync("/usr/bin/clang"))("constructor arguments and nested function-pointer factories are not fabricated callees", async () => {
  const root = await temporary(); await writeFile(path.join(root, "main.cpp"), "using Callback = int(*)();\nint target() { return 1; }\nCallback factory() { return &target; }\nstruct Wrapper { Wrapper(Callback callback) {} };\nint caller() { Wrapper value(target); return factory()(); }\n");
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.cpp", arguments: ["clang++", "-std=c++17", "main.cpp"] }]));
  const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(value => value.language === "cpp")!; await indexClang(root, unit.key);
  const q = await semanticQueryForRepository(root);
  try {
    const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key;
    const factory = (q.execute("find", "factory").items as Array<{ key: string }>)[0]!.key;
    expect(q.execute("callers", target).items).toEqual([]);
    expect(q.execute("callers", factory).items).toMatchObject([{ name: "caller", site_count: 1 }]);
  } finally { q.close(); }
}, 60000);
test.skipIf(!existsSync("/usr/bin/clang"))("out-of-line C++ methods and static data retain their declaration scope and identity", async () => {
  const root = await temporary(); await writeFile(path.join(root, "main.cpp"), "namespace N { struct Box { static int value; int read(); }; }\nint N::Box::value = 1;\nint N::Box::read() { return value; }\nint caller() { N::Box box; return box.read(); }\n");
  await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.cpp", arguments: ["clang++", "-std=c++17", "main.cpp"] }]));
  const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(value => value.language === "cpp")!; await indexClang(root, unit.key);
  const q = await semanticQueryForRepository(root);
  try { const methods = q.execute("find", "read").items as Array<{ key: string; qualified_name: string }>; expect(methods).toHaveLength(1); expect(methods[0]!.qualified_name).toBe("N::Box::read"); expect(q.execute("definition", methods[0]!.key).items).toHaveLength(2); expect(q.execute("callers", methods[0]!.key).items).toMatchObject([{ name: "caller", site_count: 1 }]); expect(q.execute("find", "value").items).toHaveLength(1); } finally { q.close(); }
}, 60000);
