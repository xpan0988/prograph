import { expect, test } from "vitest";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { installAnalysisDiagnostics, type AnalysisDiagnostic } from "../src/core/analysis/diagnostics.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";

test("fingerprint optimization matches accepted runtime bytes, complete semantic/legacy SQL, incremental history and independent rebuild", async () => {
  const runtime = process.env.PROGRAPH_TEST_FINGERPRINT_BASELINE_RUNTIME;
  if (!runtime) throw Error("Set PROGRAPH_TEST_FINGERPRINT_BASELINE_RUNTIME using prepare-semantic-baseline.mjs fingerprint");
  expect(JSON.parse(await readFile(path.join(runtime, "baseline-receipt.json"), "utf8")).commit).toBe("a8d02241518c804fe40565bc518e905db499d9e9");
  const accepted = await import(/* @vite-ignore */ pathToFileURL(path.join(runtime, "dist/core/analysis/analyze.js")).href);
  const previousSync = await import(/* @vite-ignore */ pathToFileURL(path.join(runtime, "dist/core/analysis/sync.js")).href);
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-fingerprint-oracle-"));
  const source = path.join(root, "source"), old = path.join(root, "accepted"), current = path.join(root, "candidate"), rebuilt = path.join(root, "rebuilt");
  const events: AnalysisDiagnostic[] = [];
  const observe = installAnalysisDiagnostics(event => { if (event.phase === "owned-fingerprint") events.push(event); });
  const witness = async (label: string) => {
    for (const file of ["exports/graph.json", "diagnostics.json"]) expect(await readFile(path.join(current, file))).toEqual(await readFile(path.join(old, file)));
    const receipt = path.join(root, `${label}.json`);
    await promisify(execFile)(process.execPath, ["scripts/semantic-owned-witness.mjs", old, current, receipt]);
    const data = JSON.parse(await readFile(receipt, "utf8"));
    expect(data.databases["semantic.sqlite"].tables.sc_runs.equal).toBe(true);
    expect(data.databases["semantic.sqlite"].tables.sc_projection_rows.equal).toBe(true);
    expect(data.databases["semantic.sqlite"].tables.sc_supports.equal).toBe(true);
    expect(data.databases["graph.sqlite"].tables.q_meta.equal).toBe(false); // raw independent UUIDs remain visible
  };
  const historical = (directory: string, snapshot: number) => {
    const store = new SemanticStore(path.join(directory, "semantic.sqlite"));
    try { return store.sql("SELECT c.key,c.confidence,f.predicate,f.value_json FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE snapshot=? ORDER BY c.key").all(snapshot); }
    finally { store.close(); }
  };
  try {
    await cp(path.resolve("tests/fixtures/mixed"), source, { recursive: true });
    const expected = await accepted.analyzeRepository(source, { output: old });
    const actual = await analyzeRepository(source, { output: current });
    expect(actual.manifest.semanticCore?.status).toBe("partial"); expect(actual.graph).toEqual(expected.graph);
    await witness("fresh");
    const original = historical(old, 1); expect(historical(current, 1)).toEqual(original);
    for (const directory of [old, current]) {
      const store = new SemanticStore(path.join(directory, "semantic.sqlite"));
      try { store.pinSnapshot(1, "fingerprint-history"); } finally { store.close(); }
    }
    await writeFile(path.join(source, "README.md"), "# Changed 🚀\nThe `greet` implementation changed.\n");
    await previousSync.syncRepository(source, old); await syncRepository(source, current);
    await witness("incremental");
    expect(historical(old, 1)).toEqual(original); expect(historical(current, 1)).toEqual(original);
    await analyzeRepository(source, { output: rebuilt });
    expect(await semanticSnapshot(current)).toEqual(await semanticSnapshot(rebuilt));
    const ends = events.filter(event => event.kind === "end"); expect(ends.length).toBeGreaterThanOrEqual(3);
    for (const event of ends) {
      expect(event.counts!.bytes).toBeGreaterThan(0); expect(event.counts!.maxChunkBytes).toBeLessThanOrEqual(49152); expect(event.counts!.referenceFallback).toBe(0);
    }
  } finally { observe(); await rm(root, { recursive: true, force: true }); }
}, 60000);
