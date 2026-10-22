import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analysisPasses, deriveOwnedAnalysis } from "../src/core/semantic/analysis-passes.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { installAnalysisDiagnostics } from "../src/core/analysis/diagnostics.js";
import type { AdapterResult, FrameworkAdapter } from "../src/core/adapters/contracts.js";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-owned-residency-")); roots.push(root); return root; }

const sealedTables = ["sc_entities", "sc_facts", "sc_claims", "sc_provenance", "sc_occurrences", "sc_symbols", "sc_owned", "sc_groups", "sc_supports", "sc_inputs", "sc_observed_inputs", "sc_run_digests", "sc_run_selectors", "sc_selector_gates", "sc_projection_rows", "sc_diagnostics"];
function completeRows(filename: string) {
  const store = new SemanticStore(filename);
  try {
    const tables: Record<string, unknown> = {};
    for (const table of [...sealedTables, "sc_runs", "sc_snapshots", "sc_partitions", "sc_active"]) {
      const columns = store.sql(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
      const selected = columns.filter(c => c.name !== "created_at").map(c => c.name);
      const order = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
      tables[table] = store.sql(`SELECT ${selected.join(",")} FROM ${table} ORDER BY ${(order.length ? order : selected).join(",")}`).all();
    }
    return tables;
  } finally { store.close(); }
}

test("accepted extractor matches complete sealed outputs through branching, overrides, diagnostics, reuse and removed dependencies", async () => {
  const baseline = process.env.PROGRAPH_TEST_OWNED_BASELINE_RUNTIME;
  if (!baseline) throw Error("Set PROGRAPH_TEST_OWNED_BASELINE_RUNTIME using prepare-semantic-baseline.mjs owned");
  expect(JSON.parse(await readFile(path.join(baseline, "baseline-receipt.json"), "utf8")).commit).toBe("97bcab797c4c5f838f87bfcfd5e298bbaa6cef0b");
  const accepted = await import(/* @vite-ignore */ pathToFileURL(path.join(baseline, "dist/core/semantic/analysis-passes.js")).href);
  const root = await temporary(), repo = path.join(root, "source"); await mkdir(repo);
  await writeFile(path.join(repo, "a.rs"), "fn a(){}\n"); await writeFile(path.join(repo, "b.rs"), "fn b(){}\n");
  const { snapshot } = await scanRepository(repo);
  const node = (id: string, file = "a.rs") => ({ id, name: id, qualifiedName: id, kind: "function" as const, file, adapter: "fixture", metadata: { unicode: "🚀" } });
  const source: AdapterResult = { nodes: [node("base"), node("other", "b.rs")], edges: [{ id: "base-edge", source: "base", target: "other", kind: "calls", confidence: "probable", evidence: [], metadata: {} }], diagnostics: [{ code: "base-diagnostic", severity: "info", message: "source", metadata: {} }], metadata: {} };
  const originalSource = JSON.stringify(source);
  const contract = analysisPasses[0]!;
  const make = (id: string, dependencies: string[]) => ({ ...contract, id, dependencies, adapter: {
    name: `fixture-${id}`, detect: () => true,
    analyze: (_snapshot, input) => {
      expect(input.nodes.some(n => n.id === "base")).toBe(true);
      const output = { ...node(id), metadata: { unicode: "🚀", omitted: undefined } };
      return { nodes: [output, ...(id === "left" ? [{ ...node("root", "b.rs"), metadata: { unicode: "override" } }] : [])], edges: [{ id: `edge-${id}`, source: id, target: "base", kind: "contains", confidence: "probable", evidence: [], metadata: {} }],
        diagnostics: [{ code: id, severity: "info", message: id, metadata: { seen: input.nodes.map(n => n.id), edges: input.edges.map(e => e.id), diagnoses: input.diagnostics.map(d => d.code) } }], metadata: {} };
    },
  } as FrameworkAdapter });
  const definitions = [make("root", []), make("left", ["root"]), make("right", ["root"]), make("join", ["left", "right"]), make("leaf", [])];
  const saved = [...analysisPasses], oldSaved = [...accepted.analysisPasses];
  const currentFile = path.join(root, "current.sqlite"), oldFile = path.join(root, "old.sqlite");
  const run = async (filename: string, derive: typeof deriveOwnedAnalysis) => {
    const output = await derive(snapshot, source, filename);
    const store = new SemanticStore(filename);
    try { store.publish(output.runs, output.parent); } finally { store.close(); }
    return output.result;
  };
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const active = iteration ? definitions.map(p => p.id === "join" ? { ...p, dependencies: ["right"] } : p) : definitions;
      analysisPasses.splice(0, analysisPasses.length, ...active); accepted.analysisPasses.splice(0, accepted.analysisPasses.length, ...active);
      const expected = await run(oldFile, accepted.deriveOwnedAnalysis);
      const events: Array<{ phase: string; counts?: Readonly<Record<string, number>> }> = [];
      const uninstall = installAnalysisDiagnostics(event => { if (event.kind === "measure") events.push({ phase: event.phase, counts: event.counts }); });
      let actual: AdapterResult;
      try { actual = await run(currentFile, deriveOwnedAnalysis); } finally { uninstall(); }
      expect(actual).toEqual(expected); expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      expect(completeRows(currentFile)).toEqual(completeRows(oldFile));
      expect(events.find(e => e.phase === "owned-input:join")!.counts!.inputNodes).toBeGreaterThan(2);
      expect(events.find(e => e.phase === "owned-retained:leaf")!.counts).toMatchObject({ finalNodes: 5, finalEdges: 5 });
      expect(JSON.stringify(source)).toBe(originalSource);
    }
    // Failure after a shared ancestor has been consumed must not publish or
    // damage historical snapshots; a subsequent successful derive can restart.
    const before = completeRows(currentFile);
    const failure = make("failure", ["root"]); failure.adapter.analyze = async () => { throw Error("injected pass failure"); };
    analysisPasses.splice(0, analysisPasses.length, definitions[0]!, failure);
    await expect(deriveOwnedAnalysis(snapshot, source, currentFile)).rejects.toThrow("injected pass failure");
    const s = new SemanticStore(currentFile);
    try { expect(s.activeSnapshot()).toBe(2); expect(s.db.pragma("integrity_check", { simple: true })).toBe("ok"); } finally { s.close(); }
    expect(completeRows(currentFile).sc_active).toEqual(before.sc_active);
    analysisPasses.splice(0, analysisPasses.length, ...definitions); await run(currentFile, deriveOwnedAnalysis);
  } finally { analysisPasses.splice(0, analysisPasses.length, ...saved); accepted.analysisPasses.splice(0, accepted.analysisPasses.length, ...oldSaved); }
}, 60000);

test("real mixed fixture keeps complete export bytes, sealed ownership, historical reads and independent rebuild results", async () => {
  const baseline = process.env.PROGRAPH_TEST_OWNED_BASELINE_RUNTIME;
  if (!baseline) throw Error("Accepted owned runtime required");
  const accepted = await import(/* @vite-ignore */ pathToFileURL(path.join(baseline, "dist/core/analysis/analyze.js")).href);
  const root = await temporary(), repo = path.join(root, "source"), old = path.join(root, "old"), current = path.join(root, "current"), rebuilt = path.join(root, "rebuilt");
  await cp(path.resolve("tests/fixtures/mixed"), repo, { recursive: true });
  const first = await accepted.analyzeRepository(repo, { output: old }); const second = await analyzeRepository(repo, { output: current });
  expect(second.manifest.semanticCore?.status).not.toBe("failed"); expect(second.graph).toEqual(first.graph);
  for (const file of ["exports/graph.json", "diagnostics.json"]) expect(await readFile(path.join(current, file))).toEqual(await readFile(path.join(old, file)));
  expect(completeRows(path.join(current, "semantic.sqlite"))).toEqual(completeRows(path.join(old, "semantic.sqlite")));
  const witness = path.join(root, "complete-witness.json");
  await promisify(execFile)(process.execPath, ["scripts/semantic-owned-witness.mjs", old, current, witness]);
  const evidence = JSON.parse(await readFile(witness, "utf8"));
  expect(evidence.databases["semantic.sqlite"].tables.sc_projection_rows.equal).toBe(true);
  expect(evidence.databases["graph.sqlite"].tables.edges.equal).toBe(true);
  expect(evidence.databases["graph.sqlite"].tables.q_meta).toMatchObject({ equal: false });
  expect(evidence.databases["graph.sqlite"].tables.q_meta.randomGenerationTokens).toHaveLength(2);
  const history = new SemanticStore(path.join(current, "semantic.sqlite"));
  const snapshot = history.activeSnapshot()!; history.pinSnapshot(snapshot, "residency-history"); history.close();
  await writeFile(path.join(repo, "README.md"), "# Replacement 🚀\nThe `greet` symbol is discussed here.\n");
  await syncRepository(repo, current); await analyzeRepository(repo, { output: rebuilt });
  expect(await semanticSnapshot(current)).toEqual(await semanticSnapshot(rebuilt));
  const retained = new SemanticStore(path.join(current, "semantic.sqlite"));
  try {
    const oldStore = new SemanticStore(path.join(old, "semantic.sqlite"));
    try {
      const query = "SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key";
      expect(retained.sql(query).all(snapshot)).toEqual(oldStore.sql(query).all(oldStore.activeSnapshot()));
    } finally { oldStore.close(); }
  } finally { retained.close(); }
}, 60000);

test("process cancellation after final input assembly leaves published history valid and can restart", async () => {
  const root = await temporary(), repo = path.join(root, "source"), index = path.join(root, "index");
  await mkdir(repo); await writeFile(path.join(repo, "lib.rs"), "fn target(){} fn run(){target()}\n");
  await analyzeRepository(repo, { output: index });
  const before = completeRows(path.join(index, "semantic.sqlite"));
  const code = `
    import {installAnalysisDiagnostics} from ${JSON.stringify(pathToFileURL(path.resolve("dist/core/analysis/diagnostics.js")).href)};
    import {analyzeRepository} from ${JSON.stringify(pathToFileURL(path.resolve("dist/core/analysis/analyze.js")).href)};
    installAnalysisDiagnostics(event => { if(event.phase === 'owned-input:dependency-projection') {
      process.send('assembled'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    }});
    await analyzeRepository(${JSON.stringify(repo)}, {output:${JSON.stringify(index)}});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += String(data); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Cancellation checkpoint not reached: " + stderr)); }, 20000);
    child.once("message", message => { expect(message).toBe("assembled"); child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("exit", (_code, signal) => { clearTimeout(timeout); if (signal !== "SIGKILL") reject(Error(stderr)); else resolve(); });
  });
  const after = completeRows(path.join(index, "semantic.sqlite"));
  for (const table of ["sc_snapshots", "sc_partitions", "sc_active"]) expect(after[table]).toEqual(before[table]);
  const restarted = await analyzeRepository(repo, { output: index });
  expect(restarted.manifest.semanticCore?.status).not.toBe("failed");
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try { expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]); } finally { store.close(); }
}, 40000);
