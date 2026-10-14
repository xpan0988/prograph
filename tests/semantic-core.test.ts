import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery, semanticQueryForRepository } from "../src/core/semantic/query.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";
import { canonical, semanticKey, type Provenance, type FactInput } from "../src/core/semantic/model.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { startServer } from "../src/server/index.js";
import { createProGraphMcpServer } from "../src/mcp/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { queryServiceForRepository } from "../src/core/query/query-service.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-semantic-")); cleanup.push(root); return root; }
function provenance(provider = "compiler"): Provenance { return { provider, version: "1", basis: "compiler", method: "test", context: "ctx", inputFingerprint: "inputs" }; }
function symbols(store: SemanticStore): void {
  for (const name of ["caller", "callee", "other"]) store.addSymbol({ key: name, name, qualifiedName: name, kind: "function", file: "src.ts", context: "ctx" });
  store.addOccurrence({ ...new SourceCoordinates("src.ts", "callee()").range(0, 6, "ctx", "definition"), key: "occ" }, 8);
}
function baseFact(provider = "compiler", predicate: FactInput["predicate"] = "common.Definition"): FactInput {
  return { predicate, context: "ctx", subject: "callee", object: "callee", occurrence: "occ", confidence: "resolved", provenance: provenance(provider) };
}
function visible(store: SemanticStore, snapshot: number): unknown[] {
  return store.db.prepare("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key").all(snapshot);
}

describe("semantic immutable foundation", () => {
  test("canonical identities, Unicode/CRLF conversion and invalid boundaries", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(semanticKey("x", { a: 1, b: 2 })).toBe(semanticKey("x", { b: 2, a: 1 }));
    expect(() => canonical({ x: undefined })).toThrow();
    const source = new SourceCoordinates("a.ts", "🚀a\r\nβ");
    const range = source.range(2, 3, "ctx", "reference");
    expect([range.startByte, range.endByte, range.line, range.column]).toEqual([4, 5, 1, 3]);
    expect(source.position(5)).toEqual({ byte: 7, line: 2, column: 1 });
    expect(source.range(5, 6, "ctx", "reference").endByte).toBe(9);
    expect(() => source.position(1)).toThrow(); expect(() => source.range(6, 2, "ctx", "x")).toThrow();
    expect(new SourceCoordinates("a.ts", "a\rb\u2028c\u2029d").position(6)).toEqual({ byte: 10, line: 4, column: 1 });
  });
  test("provider claims coexist, repeated batches deduplicate and entities detect collisions", async () => {
    const store = new SemanticStore(path.join(await directory(), "semantic.sqlite"));
    try {
      symbols(store); const a = store.begin("a", "ctx", "inputs"); const b = store.begin("b", "ctx", "inputs");
      store.batch(a, () => { store.addFact(a, baseFact("a")); store.addFact(a, baseFact("a")); });
      store.batch(b, () => store.addFact(b, baseFact("b")));
      store.seal(a, { status: "complete" }); store.seal(b, { status: "partial" }); const snapshot = store.publish([a, b]);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_facts").get()).toEqual({ n: 1 });
      expect(visible(store, snapshot)).toHaveLength(2);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_provenance").get()).toEqual({ n: 2 });
      expect(() => store.addSymbol({ key: "callee", name: "bad", qualifiedName: "bad", kind: "function", file: "src.ts", context: "ctx" })).toThrow("collision");
      expect(() => store.batch(a, () => store.addFact(a, baseFact()))).toThrow("staging");
    } finally { store.close(); }
  });
  test("AND support, OR alternatives, interning, selector invalidation and identity-shell lifetime", async () => {
    const store = new SemanticStore(path.join(await directory(), "semantic.sqlite"));
    try {
      symbols(store);
      const a = store.begin("a", "ctx", "inputs"); const b = store.begin("b", "ctx", "inputs"); const derived = store.begin("derived", "ctx", "inputs");
      const ca = store.batch(a, () => store.addFact(a, baseFact("a"))); const cb = store.batch(b, () => store.addFact(b, baseFact("b")));
      store.selector(a, "candidates", "one");
      const value: FactInput = { ...baseFact("pass", "common.CallSummary"), subject: "caller", object: "callee", supports: [[{ claim: ca }, { selector: "candidates", digest: "one" }], [{ claim: cb }]] };
      store.batch(derived, () => { store.addFact(derived, value); store.addFact(derived, { ...value, provenance: provenance("pass2"), supports: [[{ claim: cb }], [{ selector: "candidates", digest: "one" }, { claim: ca }]] }); });
      store.seal(a, { status: "complete" }); store.seal(b, { status: "complete" }); store.seal(derived, { status: "partial" });
      const first = store.publish([a, b, derived]);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_groups").get()).toEqual({ n: 1 });
      const replacement = store.begin("a", "ctx", "inputs"); store.selector(replacement, "candidates", "two"); store.seal(replacement, { status: "complete" });
      const second = store.publish([replacement, b, derived], first);
      expect(visible(store, second)).toHaveLength(3); // Alternative B keeps both independent derived claims.
      const third = store.publish([replacement, derived], second); expect(visible(store, third)).toHaveLength(0);
      expect(store.entity("callee")).toBeGreaterThan(0); // Shell survives; definition assertions do not.
      expect(visible(store, first)).toHaveLength(4); // Pinned history never consults current membership.
      store.pruneHistory(2); expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 2 });
    } finally { store.close(); }
  });
  test("invalid/unsealed batches, competing publishers and publication fault rollback", async () => {
    const file = path.join(await directory(), "semantic.sqlite"); let fail = "";
    const store = new SemanticStore(file, { fault(point) { if (point === fail) throw Error("injected"); } });
    try {
      symbols(store); const run = store.begin("base", "ctx", "inputs");
      expect(() => store.publish([run])).toThrow("unsealed");
      expect(() => store.batch(run, () => store.addFact(run, { ...baseFact(), subject: "occ" }))).toThrow("symbol");
      expect(() => store.batch(run, () => store.addFact(run, { ...baseFact(), context: "other" }))).toThrow("context");
      store.batch(run, () => store.addFact(run, baseFact()));
      fail = "before-seal"; expect(() => store.seal(run, {})).toThrow("injected"); fail = ""; store.seal(run, { status: "complete" });
      const first = store.publish([run]); const before = visible(store, first);
      fail = "during-publish"; expect(() => store.publish([run], first)).toThrow("injected"); expect(store.activeSnapshot()).toBe(first); expect(visible(store, first)).toEqual(before);
      fail = ""; expect(() => store.publish([run], undefined)).toThrow("parent changed");
      expect(() => store.publish([run])).not.toThrow();
      expect(() => store.publish([run], first)).toThrow("parent changed");
      const active = store.activeSnapshot();
      const child = spawnSync(process.execPath, ["-e", "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.exec('BEGIN IMMEDIATE');d.prepare(\"UPDATE sc_meta SET value='999999' WHERE key='active'\").run();process.exit(57)", file]);
      expect(child.status).toBe(57); expect(store.activeSnapshot()).toBe(active);
      expect(store.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { store.close(); }
  });
  test("unknown schemas are refused without modifying the database; query plans use adjacency indexes", async () => {
    const file = path.join(await directory(), "semantic.sqlite"); const store = new SemanticStore(file);
    symbols(store); const run = store.begin("base", "ctx", "inputs"); store.batch(run, () => store.addFact(run, baseFact())); store.seal(run, { status: "partial" }); const snapshot = store.publish([run]);
    const plans = store.db.prepare("EXPLAIN QUERY PLAN SELECT occurrence,claim FROM sc_navigation WHERE snapshot=? AND relation=? AND object=? AND occurrence>? ORDER BY occurrence LIMIT ?").all(snapshot, "reference", store.entity("callee"), 0, 51) as Array<{ detail: string }>;
    expect(plans.some(p => p.detail.includes("sc_nav_object"))).toBe(true); expect(plans.some(p => p.detail.includes("TEMP B-TREE"))).toBe(false);
    store.db.prepare("UPDATE sc_meta SET value='999' WHERE key='schema'").run(); store.close();
    const before = await readFile(file); expect(() => new SemanticStore(file)).toThrow("Unsupported"); expect(() => new SemanticQuery(file)).toThrow("Unsupported"); expect(await readFile(file)).toEqual(before);
  });
  test("status pagination visits every partition without expanding coverage metadata", async () => {
    const file = path.join(await directory(), "semantic.sqlite"); const store = new SemanticStore(file);
    const runs = Array.from({ length: 14 }, (_, i) => { const run = store.begin(`unit-${i}`, "ctx", "inputs"); store.seal(run, { status: "partial" }); return run; });
    store.publish(runs); store.close(); const query = new SemanticQuery(file);
    try {
      const names: string[] = []; let cursor: string | undefined;
      do { const page = query.execute("status", "", { limit: 3, ...(cursor ? { cursor } : {}) });
        names.push(...(page.items as Array<{ partition: string }>).map(item => item.partition)); cursor = page.nextCursor as string | undefined;
        expect(page.work).toMatchObject({ metadataRows: 9 }); expect(page.coverageTruncated).toBe(true);
      } while (cursor);
      expect(new Set(names).size).toBe(14);
    } finally { query.close(); }
  });
  test("sealing caches deterministic content including coverage; digest writes roll back atomically", async () => {
    const store = new SemanticStore(path.join(await directory(), "semantic.sqlite"));
    try {
      symbols(store); const run = store.begin("base", "ctx", "inputs"); store.batch(run, () => store.addFact(run, baseFact()));
      store.db.exec("CREATE TEMP TRIGGER digest_failure BEFORE INSERT ON sc_run_digests BEGIN SELECT RAISE(ABORT,'digest failure'); END");
      expect(() => store.seal(run, { status: "partial" })).toThrow("digest failure");
      expect(store.db.prepare("SELECT state FROM sc_runs WHERE id=?").get(run)).toEqual({ state: "staging" });
      store.db.exec("DROP TRIGGER digest_failure"); store.seal(run, { status: "partial" });
      expect(store.db.pragma("synchronous", { simple: true })).toBe(2);
      const first = store.publish([run]); const same = store.publish([run]);
      const key = (id: number) => (store.db.prepare("SELECT key FROM sc_snapshots WHERE id=?").get(id) as { key: string }).key;
      expect(key(first)).toBe(key(same));
      const secondRun = store.begin("base", "ctx", "inputs"); store.batch(secondRun, () => store.addFact(secondRun, baseFact())); store.seal(secondRun, { status: "complete" });
      expect(key(store.publish([secondRun]))).not.toBe(key(first));
    } finally { store.close(); }
  });
  test("conflicting trusted call targets remain claims but are excluded from trusted summaries", async () => {
    const store = new SemanticStore(path.join(await directory(), "semantic.sqlite"));
    try {
      symbols(store); const run = store.begin("base", "ctx", "inputs"); const derived = store.begin("pass", "ctx", "inputs");
      const [site, target] = store.batch(run, () => [store.addFact(run, { ...baseFact("a", "common.CallSite"), subject: "caller" }), store.addFact(run, { ...baseFact("a", "common.CallTarget"), subject: "caller" })]);
      store.batch(run, () => store.addFact(run, { ...baseFact("b", "common.CallTarget"), subject: "caller", object: "other" }));
      store.batch(derived, () => store.addFact(derived, { ...baseFact("pass", "common.CallSummary"), subject: "caller", supports: [[{ claim: site! }, { claim: target! }]] }));
      store.seal(run, { status: "partial" }); store.seal(derived, { status: "partial" }); const snapshot = store.publish([run, derived]);
      expect(visible(store, snapshot)).toHaveLength(4); expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_calls WHERE snapshot=?").get(snapshot)).toEqual({ n: 0 });
    } finally { store.close(); }
  });
});

async function fixture(): Promise<string> {
  const root = await directory(); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", jsx: "preserve" } }));
  await writeFile(path.join(root, "src/lib.ts"), `export function target(x: string): string;\nexport function target(x: number): number;\nexport function target(x: string | number) { return x; }\nexport function obsolete() { return 1; }\n`);
  await writeFile(path.join(root, "src/main.ts"), `import { target, obsolete } from './lib';\nexport const callback = target;\nexport function caller() { target('🚀'); target(1); const nested = () => target('inner'); nested(); return obsolete(); }\nexport function referenceOnly() { return target; }\n`);
  return root;
}
describe("TypeScript semantic vertical slice", () => {
  test("definitions/references/call sites/overloads/nested scopes and legacy compatibility", async () => {
    const root = await fixture(); const result = await analyzeRepository(root);
    expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe("partial");
    expect(result.graph.schemaVersion).toBe("1.2.0"); expect(result.graph.edges.some(e => e.kind === "calls")).toBe(true);
    const q = await semanticQueryForRepository(root);
    try {
      const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!;
      const defs = q.execute("definition", target.key); expect(defs.items).toHaveLength(3); expect(defs.analysisComplete).toBe(false);
      const refs = q.execute("references", target.key); expect((refs.items as unknown[]).length).toBeGreaterThan(4);
      const callers = q.execute("callers", target.key).items as Array<{ name: string; site_count: number }>;
      expect(callers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "caller", site_count: 2 }), expect.objectContaining({ name: "nested", site_count: 1 })]));
      expect(callers.some(c => c.name === "referenceOnly")).toBe(false); expect(callers.some(c => c.name === "callback")).toBe(false);
      const first = q.execute("references", target.key, { limit: 1 }); const second = q.execute("references", target.key, { limit: 1, cursor: String(first.nextCursor) });
      expect(second.snapshot).toBe(first.snapshot); expect(second.items).not.toEqual(first.items); expect(first.work).toMatchObject({ candidateRows: 2, globalGraphMaterialized: false });
      expect(() => q.execute("references", "wrong", { cursor: String(first.nextCursor) })).toThrow("Cursor");
      const ref = (refs.items as Array<{ occurrence: string; evidenceClaim: string }>)[0]!;
      expect(q.execute("occurrence", ref.occurrence).items).toHaveLength(1); expect(q.execute("explain", ref.evidenceClaim).items).toHaveLength(1);
      const unknown = q.execute("definition", "missing"); expect(unknown.noResult).toBe(true); expect(unknown.analysisComplete).toBe(false); expect(unknown.gaps).not.toEqual([]);
    } finally { q.close(); }
    const again = await analyzeRepository(root);
    const db = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
    try { expect(visible(db, result.manifest.semanticCore!.snapshot!)).toEqual(visible(db, again.manifest.semanticCore!.snapshot!)); } finally { db.close(); }
  }, 60000);
  test("deletion leaves unresolved identity shells, pinned history, fresh snapshots and custom paths", async () => {
    const root = await fixture(); const output = path.join(root, "my-index"); const first = await analyzeRepository(root, { output });
    const q = await semanticQueryForRepository(root, path.join(output, "graph.sqlite"));
    const obsolete = (q.execute("find", "obsolete").items as Array<{ key: string }>)[0]!.key;
    await writeFile(path.join(root, "src/lib.ts"), `export function target(x: string | number) { return x; }\n`);
    const synced = await syncRepository(root, output); expect(synced.statusAfter.stale).toBe(false);
    try {
      expect(q.execute("definition", obsolete).items).toHaveLength(0);
      expect(q.execute("definition", obsolete, { snapshot: first.manifest.semanticCore!.snapshot! }).items).toHaveLength(1);
    } finally { q.close(); }
    expect(synced.manifest?.semanticCore?.status, synced.manifest?.semanticCore?.reason).toBe("partial");
  }, 60000);
  test("HTTP semantic navigation works beside legacy API", async () => {
    const root = await fixture(); await analyzeRepository(root); const { server } = await startServer(root, { port: 0 });
    const port = (server.address() as { port: number }).port;
    try {
      const legacy = await fetch(`http://127.0.0.1:${port}/api/overview`); expect(legacy.status).toBe(200);
      const semantic = await fetch(`http://127.0.0.1:${port}/api/semantic/find?input=target`); expect(semantic.status).toBe(200); expect((await semantic.json() as { items: unknown[] }).items).toHaveLength(1);
      const contexts = await fetch(`http://127.0.0.1:${port}/api/semantic/context?limit=1`); expect(contexts.status).toBe(200); expect((await contexts.json() as { items: unknown[] }).items).toHaveLength(1);
      const invalid = await fetch(`http://127.0.0.1:${port}/api/semantic/invalid`); expect(invalid.status).toBe(409);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  }, 60000);
  test("no TypeScript and malformed project keep legacy behavior with honest coverage", async () => {
    const root = await directory(); await writeFile(path.join(root, "hello.py"), "def hello(): return 1\n");
    const first = await analyzeRepository(root); expect(first.manifest.semanticCore?.status).toBe("unavailable");
    await writeFile(path.join(root, "hello.ts"), "export const hello = () => 1;\n"); await writeFile(path.join(root, "tsconfig.json"), "{ broken");
    const result = await analyzeRepository(root); expect(result.graph.nodes.some(n => n.language === "python")).toBe(true); expect(result.manifest.semanticCore?.status).toBe("failed");
    expect(await readFile(path.join(root, ".prograph/manifest.json"), "utf8")).toContain('"failed"');
  }, 60000);
  test("compiler recovery calls stay unresolved, React facets use AST, failed attempts expose historical snapshots", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/view.tsx"), `import { target } from './lib';\nexport function View() { target(true); return <div/>; }\n`);
    const first = await analyzeRepository(root); expect(first.manifest.semanticCore?.status, first.manifest.semanticCore?.reason).toBe("partial");
    const q = await semanticQueryForRepository(root);
    try {
      const target = (q.execute("find", "target").items as Array<{ key: string }>)[0]!.key;
      expect((q.execute("callers", target).items as Array<{ name: string }>).some(r => r.name === "View")).toBe(false);
      const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
      try { expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_navigation WHERE snapshot=? AND relation='facet'").get(first.manifest.semanticCore!.snapshot)).toEqual({ n: 1 }); } finally { store.close(); }
      expect(Buffer.byteLength(JSON.stringify(q.execute("references", target, { maxBytes: 4096 })))).toBeLessThanOrEqual(4096);
      await writeFile(path.join(root, "tsconfig.json"), "{ broken"); await analyzeRepository(root);
      expect(q.execute("status").latestAttempt).toMatchObject({ status: "failed", matchesSnapshot: false });
      expect(q.execute("definition", target).snapshot).toBe(first.manifest.semanticCore!.snapshot);
    } finally { q.close(); }
  }, 60000);
  test("MCP semantic evidence and legacy overview remain usable together", async () => {
    const root = await fixture(); await analyzeRepository(root);
    const server = createProGraphMcpServer(root); const client = new Client({ name: "step1-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const result = await client.callTool({ name: "query_semantic", arguments: { operation: "find", input: "target", limit: 1 } });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { items: unknown[]; format: number };
      expect(payload.format).toBe(2); expect(payload.items).toHaveLength(1);
      const contexts = await client.callTool({ name: "query_semantic", arguments: { operation: "context", limit: 1 } });
      expect(JSON.parse((contexts.content as Array<{ text: string }>)[0]!.text).items).toHaveLength(1);
      expect((await client.callTool({ name: "get_repository_overview", arguments: {} })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  }, 60000);
  test("same-spelling block declarations and static/instance methods do not unify", async () => {
    const root = await fixture(); await writeFile(path.join(root, "src/shadows.ts"), `export function scopes() { { function same() {} same(); } { function same() {} same(); } }\nexport class C { method() {} static method() {} }\nexport function methods() { new C().method(); C.method(); }\n`);
    const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe("partial"); const q = await semanticQueryForRepository(root);
    try { expect(q.execute("find", "same").items).toHaveLength(2); expect(q.execute("find", "method").items).toHaveLength(2); } finally { q.close(); }
  }, 60000);
  test("a graph-only index remains readable and additive reanalysis preserves legacy IDs", async () => {
    const root = await fixture(); const before = await analyzeRepository(root);
    await rm(path.join(root, ".prograph/semantic.sqlite"));
    const legacyBytes = await readFile(path.join(root, ".prograph/graph.sqlite"));
    const legacy = await queryServiceForRepository(root);
    try { expect(legacy.searchSymbols("target").length).toBeGreaterThan(0); } finally { legacy.close(); }
    await expect(semanticQueryForRepository(root)).rejects.toThrow();
    expect(await readFile(path.join(root, ".prograph/graph.sqlite"))).toEqual(legacyBytes);
    const upgraded = await analyzeRepository(root); expect(upgraded.manifest.semanticCore?.status).toBe("partial");
    expect(upgraded.graph.nodes.map(n => n.id).sort()).toEqual(before.graph.nodes.map(n => n.id).sort());
    expect(upgraded.graph.edges.map(e => e.id).sort()).toEqual(before.graph.edges.map(e => e.id).sort());
  }, 60000);
  test("conservative semantic replacement agrees with clean rebuild through edits, delete, rename and config", async () => {
    const root = await fixture(); const oracle = await directory(); await analyzeRepository(root);
    const canonicalSnapshot = async (index: string) => {
      const store = new SemanticStore(path.join(index, "semantic.sqlite"));
      try {
        const snapshot = store.activeSnapshot()!;
        return { claims: store.db.prepare("SELECT c.key,f.predicate,f.value_json FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE a.snapshot=? ORDER BY c.key").all(snapshot), calls: store.db.prepare("SELECT a.key AS caller,b.key AS callee,c.site_count,c.confidence FROM sc_calls c JOIN sc_entities a ON a.id=c.caller JOIN sc_entities b ON b.id=c.callee WHERE c.snapshot=? ORDER BY a.key,b.key").all(snapshot),
          coverage: store.db.prepare("SELECT r.partition_key,r.context,r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? ORDER BY r.partition_key").all(snapshot) };
      } finally { store.close(); }
    };
    const actions = [
      () => writeFile(path.join(root, "src/added.ts"), "export function added() { return 3; }\n"),
      () => writeFile(path.join(root, "src/lib.ts"), "export function target(x: string | number) { return x; }\n"),
      () => rename(path.join(root, "src/added.ts"), path.join(root, "src/renamed.ts")),
      () => rm(path.join(root, "src/renamed.ts")),
      () => writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2021", module: "ESNext" } })),
    ];
    for (const change of actions) {
      await change(); await syncRepository(root); await rm(oracle, { recursive: true, force: true }); await analyzeRepository(root, { output: oracle });
      expect(await canonicalSnapshot(path.join(root, ".prograph"))).toEqual(await canonicalSnapshot(oracle));
    }
  }, 60000);
});
