import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SemanticStore } from "../src/core/semantic/store.js";
import { canonical } from "../src/core/semantic/model.js";
import { writeSyntaxBase } from "../src/core/semantic/owned-projection.js";
import { partitionProjection } from "../src/core/semantic/projection-shards.js";
import { analysisPasses } from "../src/core/semantic/analysis-passes.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { markdownAdapter } from "../src/adapters/artifact/markdown/index.js";
import type { Diagnostic, GraphNode } from "../src/core/graph/schema.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-owned-diagnostic-")); roots.push(root); return root; }
const normalized = (items: Diagnostic[]) => JSON.parse(JSON.stringify(items)) as Diagnostic[];
const multiset = (items: Diagnostic[]) => normalized(items).map(canonical).sort();
function reports(store: SemanticStore, snapshot = store.activeSnapshot()!) {
  const rows = store.sql(`SELECT f.value_json FROM sc_partitions p JOIN sc_projection_rows r ON r.run=p.run JOIN sc_claims c ON c.id=r.claim JOIN sc_facts f ON f.id=c.fact
    JOIN sc_active a ON a.snapshot=p.snapshot AND a.claim=c.id WHERE p.snapshot=? AND f.predicate='projection.Diagnostic' ORDER BY p.partition_key,r.ordinal`).all(snapshot) as Array<{ value_json: string }>;
  return rows.map(row => {
    let value = JSON.parse(row.value_json) as { diagnostic: Diagnostic; payloadEntity?: string };
    if (value.payloadEntity) value = JSON.parse((store.sql("SELECT canonical FROM sc_entities WHERE key=?").get(value.payloadEntity) as { canonical: string }).canonical);
    return value.diagnostic;
  });
}

test("diagnostic-only shards preserve complete payloads, duplicates, support invalidation, reuse, pinned history and GC", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a.ts"), "export const a=1"); await writeFile(path.join(root, "b.ts"), "export const b=1");
  const store = new SemanticStore(path.join(root, "facts.sqlite"));
  const nodes: GraphNode[] = ["a.ts", "b.ts"].map(file => ({ id: file, kind: "file", name: file, qualifiedName: file, file, adapter: "test", metadata: {} }));
  const a: Diagnostic = { code: "reported-a", severity: "warning", message: "位置 🚀", file: "a.ts", line: 3, column: 4, adapter: "fixture-report", metadata: { basis: "fixture", nested: { optional: undefined, evidence: ["α", "β"] } } };
  const b: Diagnostic = { ...a, code: "reported-b", file: "b.ts", message: "original" }, global: Diagnostic = { code: "reported-global", severity: "info", message: "report", adapter: "fixture-report", metadata: { long: "🚀".repeat(20000) } };
  const pass = { ...analysisPasses.find(p => p.id === "documentation")!, configurationFingerprint: "test" };
  const build = async (fingerprint: string, diagnostics: Diagnostic[]) => {
    const { snapshot } = await scanRepository(root), base = writeSyntaxBase(store, snapshot, { nodes, edges: [], diagnostics: [], metadata: {} }, "ctx", fingerprint);
    const index = store.begin("diagnostic-pass", "ctx", fingerprint), provenance = { provider: "pass:documentation", version: pass.version, basis: "inference" as const, method: "test-report", context: "ctx", inputFingerprint: fingerprint };
    const output = partitionProjection(store, index, "diagnostic-pass", pass, snapshot, provenance, base.fileClaims, base.nodeClaims, nodes, { nodes: [], edges: [], diagnostics, metadata: {} }, base.selector);
    store.seal(index, {}); const sealed = output.seal(); expect(multiset(sealed.result.diagnostics)).toEqual(multiset(diagnostics));
    return { base, index, output, snapshot: store.publish([...base.runs, index, ...output.runs]) };
  };
  try {
    const first = await build("one", [b, a, b, global]); store.pinSnapshot(first.snapshot, "diagnostic-history");
    expect(multiset(reports(store))).toEqual(multiset([b, a, b, global]));
    expect(store.sql("SELECT COUNT(*) n FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE f.predicate='projection.Diagnostic' AND c.support_group IS NULL").get()).toEqual({ n: 0 });
    const owned = (runs: number[]) => runs.map(run => store.sql("SELECT id,partition_key FROM sc_runs WHERE id=?").get(run) as { id: number; partition_key: string });
    const previous = owned(first.output.runs);
    await writeFile(path.join(root, "b.ts"), "export const b=2"); const changed = { ...b, message: "replacement" };
    const second = await build("two", [changed, a, changed, global]); const next = owned(second.output.runs);
    expect(next.find(run => run.partition_key.endsWith("file:a.ts"))).toEqual(previous.find(run => run.partition_key.endsWith("file:a.ts")));
    expect(next.find(run => run.partition_key.endsWith("file:<structure>"))).toEqual(previous.find(run => run.partition_key.endsWith("file:<structure>")));
    expect(next.find(run => run.partition_key.endsWith("file:b.ts"))!.id).not.toBe(previous.find(run => run.partition_key.endsWith("file:b.ts"))!.id);
    expect(multiset(reports(store))).toEqual(multiset([changed, a, changed, global]));
    expect(multiset(reports(store, first.snapshot))).toEqual(multiset([b, a, b, global]));
    const withoutB = second.base.runs.filter(run => !(store.sql("SELECT partition_key FROM sc_runs WHERE id=?").get(run) as { partition_key: string }).partition_key.endsWith("file:b.ts"));
    store.publish([...withoutB, second.index, ...second.output.runs]); expect(multiset(reports(store))).toEqual(multiset([a, global]));
    store.publish([...second.base.runs, ...second.output.runs]); expect(reports(store)).toEqual([]); // Child selectors cannot admit themselves.
    store.collectGarbage({ keep: 1 }); expect(multiset(reports(store, first.snapshot))).toEqual(multiset([b, a, b, global]));
    store.unpinSnapshot(first.snapshot, "diagnostic-history"); store.publish([]); store.collectGarbage({ keep: 1 });
    expect(store.sql("SELECT COUNT(*) n FROM sc_facts").get()).toEqual({ n: 0 }); expect(store.sql("SELECT COUNT(*) n FROM sc_entities").get()).toEqual({ n: 0 });
    expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]);
  } finally { store.close(); }
});

test("pass reports preserve their established order using sealed payloads across diagnostic-only cached shards", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a.ts"), "export const a=1"); await writeFile(path.join(root, "b.ts"), "export const b=1"); await writeFile(path.join(root, "README.md"), "# Diagnostics\n");
  const expected: Diagnostic[] = [{ code: "owned-report-b", severity: "warning", message: "B", file: "b.ts", line: 3, column: 7, adapter: "markdown", metadata: { source: "fixture", optional: undefined } }, { code: "owned-report-a", severity: "info", message: "A 🚀", file: "a.ts", adapter: "markdown", metadata: { evidence: ["fixture"] } }]; expected.push(expected[0]!);
  vi.spyOn(markdownAdapter, "analyze").mockResolvedValue({ nodes: [], edges: [], diagnostics: expected, metadata: { fileCount: 1 } });
  const selected = () => { const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); try { return s.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/pass:documentation@4/file:%' ORDER BY partition_key").all(s.activeSnapshot()); } finally { s.close(); } };
  for (let i = 0; i < 2; i++) {
    const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status).toBe("partial");
    expect(result.graph.diagnostics.filter(d => d.code.startsWith("owned-report-"))).toEqual(normalized(expected));
    const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); try { expect(multiset(reports(s).filter(d => d.code.startsWith("owned-report-")))).toEqual(multiset(expected)); } finally { s.close(); }
    if (i === 0) { const before = selected(); await analyzeRepository(root); expect(selected()).toEqual(before); }
  }
});

test("actual Tauri reports are owned semantic facts and disappear from current output when their source support is removed", async () => {
  const root = await temporary(); await cp(path.resolve("tests/fixtures/mixed"), root, { recursive: true });
  const app = path.join(root, "src/App.tsx"), original = await readFile(app, "utf8"); await appendFile(app, '\nvoid invoke("missing_owned_command");\n');
  const first = await analyzeRepository(root); const expected = first.graph.diagnostics.find(d => d.code === "unmatched-tauri-invoke" && d.metadata.name === "missing_owned_command"); expect(expected).toBeDefined();
  const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); let snapshot: number;
  try { snapshot = s.activeSnapshot()!; expect(reports(s)).toContainEqual(expected); } finally { s.close(); }
  await writeFile(app, original); await analyzeRepository(root);
  const changed = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try { expect(reports(changed).some(d => d.metadata.name === "missing_owned_command")).toBe(false); expect(reports(changed, snapshot!)).toContainEqual(expected); } finally { changed.close(); }
}, 60000);
