import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { analysisPasses } from "../src/core/semantic/analysis-passes.js";
import { orderPasses } from "../src/core/semantic/passes.js";
import { OwnedWriter } from "../src/core/semantic/owned-projection.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { readOwnedProjection, readSyntaxProjection, writeSyntaxBase } from "../src/core/semantic/owned-projection.js";
import { runAdapter } from "../src/core/analysis/adapter-run.js";
import { partitionProjection } from "../src/core/semantic/projection-shards.js";
import { GraphBuilder } from "../src/core/graph/builder.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(file => rm(file, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-passes-")); cleanup.push(root); return root; }
async function files(root: string, entries: Record<string, string>) { for (const [file, text] of Object.entries(entries)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } }
function facts(store: SemanticStore, predicate: string, snapshot = store.activeSnapshot()) {
  return store.sql(`SELECT c.key,c.confidence,c.support_group,f.predicate,f.value_json,e.key AS subject,o.key AS object,occ.key AS occurrence
    FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject
    LEFT JOIN sc_entities o ON o.id=f.object LEFT JOIN sc_entities occ ON occ.id=f.occurrence WHERE a.snapshot=? AND f.predicate=? ORDER BY c.key`).all(snapshot, predicate) as Record<string, unknown>[];
}

describe("owned semantic derivations", () => {
  test("DAG rejects missing dependencies and cycles before execution", () => {
    expect(orderPasses([...analysisPasses].reverse()).map(pass => pass.id).indexOf("boundary-binding")).toBeGreaterThan(orderPasses([...analysisPasses].reverse()).map(pass => pass.id).indexOf("framework-tauri"));
    expect(() => orderPasses([{ id: "a", dependencies: ["b"] }])).toThrow("Missing");
    expect(() => orderPasses([{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }])).toThrow("cycle");
  });
  test("sealed compatibility order follows its run rather than historical claim allocation", async () => {
    const root = await directory(); await files(root, { "a.ts": "export const a=1;" }); const { snapshot } = await scanRepository(root);
    const store = new SemanticStore(path.join(root, "facts.sqlite"));
    try {
      const a = { id: "a", name: "a", qualifiedName: "a", kind: "file" as const, adapter: "test", metadata: {} }; const b = { ...a, id: "b", name: "b", qualifiedName: "b" };
      writeSyntaxBase(store, snapshot, { nodes: [a, b], edges: [], diagnostics: [], metadata: {} }, "ctx", "inputs");
      const replacement = writeSyntaxBase(store, snapshot, { nodes: [b, a], edges: [], diagnostics: [], metadata: {} }, "ctx", "inputs");
      expect(readOwnedProjection(store, replacement.run).result.nodes.map(node => node.id)).toEqual(["b", "a"]);
    } finally { store.close(); }
  });
  test("shard fingerprints follow persisted JSON optional-field semantics", async () => {
    const root = await directory(); await files(root, { "a.ts": "export const a=1;" }); const { snapshot } = await scanRepository(root);
    const store = new SemanticStore(path.join(root, "facts.sqlite"));
    try {
      const baseNode = { id: "base", name: "base", qualifiedName: "base", kind: "file" as const, file: "a.ts", adapter: "test", metadata: {} };
      const base = writeSyntaxBase(store, snapshot, { nodes: [baseNode], edges: [], diagnostics: [{ code: "optional", message: "test", severity: "info", file: undefined, metadata: {} }], metadata: {} }, "ctx", "inputs");
      const run = store.begin("pass-index", "ctx", "inputs");
      const provenance = { provider: "pass:test", version: "2", basis: "inference" as const, method: "test", context: "ctx", inputFingerprint: "inputs" };
      const pass = { ...analysisPasses.find(pass => pass.id === "package-config")!, configurationFingerprint: "test" };
      const projection = partitionProjection(store, run, "pass-index", pass, snapshot, provenance, base.fileClaims, base.nodeClaims, [baseNode], {
        nodes: [{ ...baseNode, id: "derived", metadata: { optional: undefined } }], edges: [{ id: "edge", source: "derived", target: "base", kind: "contains", confidence: "exact", evidence: [{ adapter: "test", file: "a.ts", line: undefined }], metadata: {} }], diagnostics: [], metadata: {},
      }, base.selector);
      store.seal(run, {}); const sealed = projection.seal(); store.publish([...base.runs, run, ...projection.runs]);
      expect(sealed.result.nodes[0]!.metadata).toEqual({}); expect(sealed.result.edges[0]!.evidence[0]).toEqual({ adapter: "test", file: "a.ts" });
    } finally { store.close(); }
  });
  test("mixed framework and Knowledge output is sealed, declared, supported and not duplicated in legacy/full", async () => {
    const output = await directory(); const result = await analyzeRepository(path.resolve("tests/fixtures/mixed"), { output });
    expect(result.manifest.semanticCore?.status).toBe("partial");
    const store = new SemanticStore(path.join(output, "semantic.sqlite"));
    try {
      const runs = store.sql("SELECT r.* FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=?").all(store.activeSnapshot()) as { id: number; partition_key: string; state: string; coverage_json: string }[];
      expect(runs.some(run => run.partition_key === "legacy/full")).toBe(false);
      const passes = runs.filter(run => run.partition_key.startsWith("analysis/pass:")); expect(passes.filter(run => /^analysis\/pass:[^/]+$/.test(run.partition_key))).toHaveLength(analysisPasses.length);
      for (const run of passes) {
        expect(run.state).toBe("sealed"); const contract = JSON.parse(run.coverage_json);
        for (const key of ["pass", "version", "configurationFingerprint", "requiredCapabilities", "inputDomains", "dependencies", "selectorDependencies", "negativeDependencies", "writes", "ownershipShard", "invalidation", "coverageBehavior"]) expect(contract).toHaveProperty(key);
        expect(store.sql("SELECT COUNT(*) AS n FROM sc_owned o JOIN sc_claims c ON c.id=o.claim WHERE o.run=? AND c.support_group IS NULL").get(run.id)).toEqual({ n: 0 });
      }
      expect(facts(store, "framework.Component").length).toBeGreaterThan(0);
      expect(facts(store, "knowledge.Link").length).toBeGreaterThan(0);
      expect(facts(store, "projection.Dependency").length).toBeGreaterThan(0);
      expect(facts(store, "boundary.Invokes").length).toBeGreaterThan(0);
      expect(facts(store, "boundary.Implements").length).toBeGreaterThan(0);
      expect(facts(store, "boundary.Path").length).toBeGreaterThan(0);
      expect(facts(store, "boundary.Emits").length).toBeGreaterThan(0); expect(facts(store, "boundary.Listens").length).toBeGreaterThan(0);
      for (const item of facts(store, "boundary.Invokes")) expect(item.occurrence).toBeTruthy();
      const query = new SemanticQuery(store.filename);
      try {
        const operations = query.execute("boundaries", "", { limit: 1 }); expect(operations.truncated).toBe(true);
        const first = (operations.items as Record<string, unknown>[])[0]!;
        expect((query.execute("boundary-participants", String(first.operation)).items as unknown[]).length).toBeGreaterThan(0);
      } finally { query.close(); }
      expect(store.sql("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      // The former ordered algorithms remain a compatibility oracle, not a second writer.
      const { snapshot } = await scanRepository(path.resolve("tests/fixtures/mixed"));
      const legacy = new GraphBuilder(); legacy.merge(readSyntaxProjection(store, store.activeSnapshot()!)!.result);
      for (const pass of analysisPasses) if (pass.adapter) legacy.merge((await runAdapter(pass.adapter, snapshot, legacy.result(), true)).result);
      const normalizedNodes = (nodes: typeof result.graph.nodes) => nodes.map(node => node.kind === "repository" ? { ...node, metadata: {} } : node).sort((a, b) => a.id.localeCompare(b.id));
      expect(normalizedNodes(result.graph.nodes)).toEqual(normalizedNodes([...legacy.nodes.values()]));
      expect([...result.graph.edges].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...legacy.edges.values()].sort((a, b) => a.id.localeCompare(b.id)));
    } finally { store.close(); }
  }, 60000);
  test("HTTP, GraphQL and Protobuf explicit namespaces qualify syntax calls and unique handlers without cross-service joins", async () => {
    const root = await directory();
    const boundaries = [
      { protocol: "http", namespace: "service-a", contracts: ["a.yaml", "a-copy.yaml"], operation: "GET /users" },
      { protocol: "graphql", namespace: "service-a-graphql", contracts: ["schema.graphql"], operation: "Query.users" },
      { protocol: "grpc", namespace: "service-a-grpc", contracts: ["api.proto"], operation: "api.Users/List" },
    ];
    const config = { boundaries: boundaries.map(({ operation, ...entry }) => ({ ...entry, bindings: [
      { file: "client.ts", symbol: "client", role: "invokes", operation, line: 1, column: 35 },
      { file: "handler.ts", symbol: "handler", role: "implements", operation },
    ] })) };
    await files(root, { "client.ts": "export function client() { return fetch('/users'); }\n", "handler.ts": "export function handler() { return 1; }\n",
      "a.yaml": "openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n", "a-copy.yaml": "openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n",
      "b.yaml": "openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n", "schema.graphql": "type Query { users: String }\n",
      "api.proto": 'syntax = "proto3"; package api; service Users { rpc List (Request) returns (Request); } message Request {}\n', "prograph.config.json": JSON.stringify(config) });
    const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status).toBe("partial");
    let store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); let first: number; let oldRuns: number[];
    try {
      first = store.activeSnapshot()!; expect(facts(store, "boundary.Operation")).toHaveLength(4);
      expect(facts(store, "boundary.Invokes")).toHaveLength(3); expect(facts(store, "boundary.Implements")).toHaveLength(3); expect(facts(store, "boundary.Path")).toHaveLength(3);
      const orphan = facts(store, "boundary.Operation").find(row => JSON.parse(String(row.value_json)).namespace === "b.yaml")!;
      expect(facts(store, "boundary.Implements").some(row => row.object === orphan.subject)).toBe(false);
      expect(facts(store, "common.CallSummary").every(row => !String(row.subject).includes("boundary"))).toBe(true);
      oldRuns = (store.sql("SELECT run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/pass:%'").all(first) as { run: number }[]).map(row => row.run);
    } finally { store.close(); }
    // Negative candidate change: an additional same-name declaration invalidates a unique binding.
    await writeFile(path.join(root, "handler.ts"), "export function handler() { return 1; }\nnamespace extra { export function handler() { return 2; } }\n");
    await syncRepository(root);
    store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try {
      expect(facts(store, "boundary.Implements")).toHaveLength(0); expect(facts(store, "boundary.Path")).toHaveLength(0);
      const source = store.sql("SELECT run FROM sc_partitions WHERE snapshot=? AND partition_key='analysis/source'").get(store.activeSnapshot()) as { run: number };
      const invalidated = store.publish([source.run, ...oldRuns], store.activeSnapshot());
      expect(facts(store, "boundary.Operation", invalidated)).toHaveLength(0); // Retaining an old pass cannot resurrect its stale selector.
      expect(facts(store, "boundary.Path", first!)).toHaveLength(3); // Historical readers remain pinned.
    } finally { store.close(); }
  }, 60000);
  test("owned pass output reuse preserves unrelated Knowledge and boundary partitions and rejects stale admissions", async () => {
    const root = await directory();
    await files(root, {
      "client.ts": "export function client(){return fetch('/users')}\n",
      "handler.ts": "export function handler(){return 1}\n",
      "unrelated.ts": "export function independent(){return 1}\n",
      "README.md": "# Handler\nThe `handler` symbol handles requests.\n",
      "api.yaml": "openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n",
      "prograph.config.json": JSON.stringify({ boundaries: [{ protocol: "http", namespace: "users", contracts: ["api.yaml"], bindings: [
        { file: "client.ts", symbol: "client", role: "invokes", operation: "GET /users", line: 1, column: 33 },
        { file: "handler.ts", symbol: "handler", role: "implements", operation: "GET /users" },
      ] }] }),
    });
    const selected = () => {
      const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
      try { return store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? ORDER BY partition_key").all(store.activeSnapshot()) as Array<{ partition_key: string; run: number }>; } finally { store.close(); }
    };
    await analyzeRepository(root); const first = selected();
    expect(first.some(row => row.partition_key.includes("/operation:"))).toBe(true);
    expect(first.some(row => row.partition_key.includes("pass:knowledge-links@4/file:"))).toBe(true);
    await writeFile(path.join(root, "unrelated.ts"), "export function independent(){return 2}\n"); await syncRepository(root);
    const second = selected();
    const outputs = first.filter(row => row.partition_key.includes("/operation:") || row.partition_key.includes("pass:knowledge-links@4/file:") || row.partition_key.includes("pass:documentation@4/file:"));
    expect(outputs.length).toBeGreaterThan(2);
    expect(second.filter(row => outputs.some(old => old.partition_key === row.partition_key))).toEqual(outputs);
    await writeFile(path.join(root, "shadow.ts"), "export function handler(){return 3}\n"); await syncRepository(root);
    const shadowed = selected(); const oldKnowledge = first.find(row => row.partition_key.includes("pass:knowledge-links@4/file:README.md"))!;
    const negative = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try {
      expect(facts(negative, "knowledge.Link")).toHaveLength(0); expect(facts(negative, "boundary.Implements")).toHaveLength(1);
      const oldIndex = first.find(row => row.partition_key === "analysis/pass:knowledge-links@4")!;
      const stale = negative.publish([...shadowed.filter(row => ![oldKnowledge.partition_key, oldIndex.partition_key].includes(row.partition_key)).map(row => row.run), oldIndex.run, oldKnowledge.run], negative.activeSnapshot());
      expect(facts(negative, "knowledge.Link", stale)).toHaveLength(0); // Original doc/target and the entire old pass index remain; its input qualification rejects stale admission.
    } finally { negative.close(); }
    await writeFile(path.join(root, "handler.ts"), "export function handler(){return 1}\nnamespace extra { export function handler(){return 2} }\n"); await syncRepository(root);
    const third = selected(); const oldBoundary = first.find(row => row.partition_key.includes("/operation:"))!;
    const replacement = third.find(row => row.partition_key === oldBoundary.partition_key)!; expect(replacement.run).not.toBe(oldBoundary.run);
    const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try {
      expect(facts(store, "boundary.Implements")).toHaveLength(0); expect(facts(store, "knowledge.Link")).toHaveLength(0);
      const stale = store.publish([...third.filter(row => row.run !== replacement.run).map(row => row.run), oldBoundary.run], store.activeSnapshot());
      expect(facts(store, "boundary.Operation", stale)).toHaveLength(0); // Current index rejects the old output seal, even when old positive source claims survive.
      expect(store.db.pragma("foreign_key_check")).toEqual([]);
    } finally { store.close(); }
  }, 60000);

  test("alternative proof paths survive support removal and disappear after their last support is removed", async () => {
    const root = await directory(); await files(root, { "a.ts": "export const a=1;" }); const { snapshot } = await scanRepository(root);
    const store = new SemanticStore(path.join(root, "facts.sqlite"));
    try {
      const provenance = { provider: "pass:boundary-binding", version: "1", basis: "inference" as const, method: "proof-test", context: "ctx", inputFingerprint: "inputs" };
      const bases = [store.begin("a", "ctx", "inputs"), store.begin("b", "ctx", "inputs")];
      const supports = bases.map((run, index) => store.batch(run, () => { const key = `source-${index}`; store.addEntity(key, "artifact", { key }); return store.addFact(run, { predicate: "source.File", context: "ctx", subject: key, confidence: "exact", provenance }); }));
      bases.forEach(run => store.seal(run, { status: "partial" }));
      const selector = store.begin("catalogue", "ctx", "inputs"); store.selector(selector, "catalogue", "same"); store.seal(selector, { status: "partial" });
      const run = store.begin("boundary", "ctx", "inputs"); const writer = new OwnedWriter(store, run, snapshot, provenance, { key: "catalogue", digest: "same" }, new Map(), new Map());
      store.batch(run, () => { const key = "operation"; store.addEntity(key, "artifact", { key, protocol: "http", namespace: "a", operation: "GET /x" }); writer.fact({ predicate: "boundary.Operation", subject: key, value: { protocol: "http", namespace: "a", operation: "GET /x" }, confidence: "exact" }, supports.map(claim => [claim])); });
      store.seal(run, { status: "partial" }); const first = store.publish([...bases, selector, run]);
      const second = store.publish([bases[1]!, selector, run], first); expect(facts(store, "boundary.Operation", second)).toHaveLength(1);
      const third = store.publish([selector, run], second); expect(facts(store, "boundary.Operation", third)).toHaveLength(0);
    } finally { store.close(); }
  });
  test("Tauri calls require actual imported bindings and reject comments, strings and shadowed names", async () => {
    const root = await directory();
    await files(root, { "src-tauri/tauri.conf.json": "{}", "src-tauri/src/lib.rs": '#[tauri::command]\npub fn ping() {}\npub fn run() { tauri::generate_handler![ping]; }\n',
      "app.ts": `import { invoke } from '@tauri-apps/api/core';
export function good() { invoke('ping'); }
export function shadowed(invoke: (s:string)=>void) { invoke('ping'); }
// invoke('ping')
export const text = "invoke('ping')";
` });
    await analyzeRepository(root); const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try {
      const calls = facts(store, "boundary.Invokes"); expect(calls).toHaveLength(1);
      expect(store.sql("SELECT name FROM sc_symbols WHERE entity=?").get(store.entity(String(calls[0]!.subject)))).toEqual({ name: "good" });
    } finally { store.close(); }
    await writeFile(path.join(root, "src-tauri/src/lib.rs"), '#[tauri::command]\npub fn ping() {}\n// tauri::generate_handler![ping]\n');
    await syncRepository(root); const replaced = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try { expect(facts(replaced, "boundary.Implements")).toHaveLength(0); expect(facts(replaced, "boundary.Registers")).toHaveLength(0); }
    finally { replaced.close(); }
  }, 60000);
  test("Tauri applications with equal operation names retain distinct namespaces", async () => {
    const root = await directory();
    await cp(path.resolve("tests/fixtures/mixed"), path.join(root, "apps/a"), { recursive: true });
    await cp(path.resolve("tests/fixtures/mixed"), path.join(root, "apps/b"), { recursive: true });
    const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status).toBe("partial");
    const commands = result.graph.nodes.filter(node => node.kind === "framework_command" && node.name === "greet"); expect(commands).toHaveLength(2);
    expect(new Set(commands.map(node => JSON.stringify(node.metadata.boundary))).size).toBe(2);
    const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try {
      const operations = facts(store, "boundary.Operation").filter(row => JSON.parse(String(row.value_json)).operation === "greet"); expect(operations).toHaveLength(2);
      for (const row of facts(store, "boundary.Path")) {
        const caller = store.sql("SELECT file FROM sc_symbols WHERE entity=?").get(store.entity(String(row.subject))) as { file: string };
        const handler = store.sql("SELECT file FROM sc_symbols WHERE entity=?").get(store.entity(String(row.object))) as { file: string };
        expect(caller.file.split("/").slice(0, 2)).toEqual(handler.file.split("/").slice(0, 2));
      }
    } finally { store.close(); }
  }, 60000);
});
