import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { SemanticStore } from "../src/core/semantic/store.js";
import { readSnapshotReport, writeSnapshotReport, type SnapshotReportInput } from "../src/core/semantic/snapshot-report.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { createIndexState } from "../src/core/analysis/state.js";
import { writeSyntaxBase, OWNED_PASS_VERSION } from "../src/core/semantic/owned-projection.js";
import { semanticKey, digest, canonical } from "../src/core/semantic/model.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import type { AnalysisManifest } from "../src/core/graph/schema.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { inputMatches } from "../src/core/semantic/input-check.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-report-test-")); roots.push(root);
  const repository = path.join(root, "source"), index = path.join(root, "index"); await mkdir(repository); await mkdir(index);
  await writeFile(path.join(repository, "a.ts"), "export const value=1"); return { root, repository, index };
}
async function base(store: SemanticStore, repository: string, index: string, revision: string) {
  const { snapshot } = await scanRepository(repository, index);
  const context = semanticKey("analysis-context", [snapshot.repository.identity, OWNED_PASS_VERSION]);
  const runs = writeSyntaxBase(store, snapshot, { nodes: [{ id: "file", kind: "file", name: "a.ts", qualifiedName: "a.ts", file: "a.ts", adapter: "fixture", metadata: { revision } }], edges: [], diagnostics: [], metadata: {} }, context, digest(revision)).runs;
  const manifest: AnalysisManifest = { schemaVersion: "1.2.0", toolVersion: "0.3.0", repositoryRoot: repository, repositoryIdentity: snapshot.repository.identity, generatedAt: new Date().toISOString(), adapterRuns: [], enabledAdapters: [], scannedFileCount: 1, excludedFileCount: 0, nodeCount: 1, edgeCount: 0, diagnosticCount: 0, analysisDuration: 0, semanticCore: { format: 2, status: "unavailable", context: "none", durationMs: 0 } };
  const { files: _files, ...stateHeader } = createIndexState(snapshot, manifest); return { runs, report: { manifest, stateHeader } satisfies SnapshotReportInput };
}

test("publication atomically binds immutable report metadata and retained history without certifying compatibility readiness", async () => {
  const { repository, index } = await fixture(), store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try {
    const a = await base(store, repository, index, "one"), first = store.publish(a.runs, undefined, [], a.report);
    const original = readSnapshotReport(store.db, first)!; expect(original.snapshot).toBe(first); expect(original.manifest.semanticCore?.snapshot).toBe(first); expect(original.compatibilityReady).toBe(false); expect(original.stateHeader).not.toHaveProperty("files");
    expect(() => writeSnapshotReport(store, first, original.snapshotKey, a.report)).toThrow("publication transaction");
    const next = await base(store, repository, index, "two");
    expect(() => store.publish(next.runs, first, [], { ...next.report, stateHeader: { ...next.report.stateHeader, repositoryIdentity: "wrong-repository" } })).toThrow(/Invalid snapshot-bound|selected sealed source catalogue/);
    expect(store.activeSnapshot()).toBe(first); expect(readSnapshotReport(store.db, first)).toEqual(original);
    const second = store.publish(next.runs, first, [], next.report); expect(readSnapshotReport(store.db, second)?.sourceCatalogue).toBe(digest("two"));
    store.pinSnapshot(first, "report-history"); store.collectGarbage({ keep: 1 }); expect(readSnapshotReport(store.db, first)).toEqual(original);
    store.unpinSnapshot(first, "report-history"); store.collectGarbage({ keep: 1 }); expect(readSnapshotReport(store.db, first)).toBeUndefined(); expect(readSnapshotReport(store.db, second)?.snapshot).toBe(second);
    const before = store.sql("SELECT COUNT(*) n FROM sc_snapshots").get();
    expect(() => store.publish(next.runs, second, [], { ...next.report, manifest: { ...next.report.manifest, adapterRuns: [{ adapter: "oversized", detected: true, durationMs: 0, fileCount: 0, nodeCount: 0, edgeCount: 0, diagnosticCount: 0, metadata: { large: "x".repeat(1048576) } }] } })).toThrow("1 MiB");
    expect(store.sql("SELECT COUNT(*) n FROM sc_snapshots").get()).toEqual(before); expect(store.activeSnapshot()).toBe(second);
    expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]);
  } finally { store.close(); }
});

test("real analysis records its own report even while legacy filesystem metadata is missing or stale", async () => {
  const { repository, index } = await fixture(); const analyzed = await analyzeRepository(repository, { output: index });
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try {
    const report = readSnapshotReport(store.db, store.activeSnapshot()!)!; expect(report).toBeDefined(); expect(report.manifest.repositoryIdentity).toBe(analyzed.manifest.repositoryIdentity);
    await rm(path.join(index, "manifest.json")); expect(readSnapshotReport(store.db, store.activeSnapshot()!)).toEqual(report);
    await writeFile(path.join(index, "manifest.json"), JSON.stringify({ semanticCore: { status: "failed", snapshot: -1 } })); expect(readSnapshotReport(store.db, store.activeSnapshot()!)).toEqual(report);
    store.db.exec("UPDATE sc_snapshot_reports SET json='{}'"); expect(() => readSnapshotReport(store.db, store.activeSnapshot()!)).toThrow("receipt");
  } finally { store.close(); }
});

async function ready(file: string) { const until = performance.now() + 10000; while (performance.now() < until) { try { await stat(file); return; } catch { await new Promise(r => setTimeout(r, 20)); } } throw Error("Writer did not reach publication probe"); }
test("killed writers retain either both old facts/report or both new facts/report at all recovery points", async () => {
  for (const point of ["before-seal", "before-publish", "during-publish", "after-publish"]) {
    const { root, repository, index } = await fixture(), filename = path.join(index, "semantic.sqlite"), probe = path.join(root, "ready");
    const store = new SemanticStore(filename), initial = await base(store, repository, index, "one"), first = store.publish(initial.runs, undefined, [], initial.report);
    const original = readSnapshotReport(store.db, first)!; store.close();
    const file = path.join(root, "worker.mjs"), module = (name: string) => JSON.stringify(new URL(`../dist/core/${name}.js`, import.meta.url).href);
    await writeFile(file, `import{writeFileSync}from'node:fs';import{SemanticStore}from ${module("semantic/store")};import{writeSyntaxBase,OWNED_PASS_VERSION}from ${module("semantic/owned-projection")};import{scanRepository}from ${module("repository/repository")};import{semanticKey,digest}from ${module("semantic/model")};
      const s=new SemanticStore(${JSON.stringify(filename)},{fault(p){if(p===${JSON.stringify(point)}){writeFileSync(${JSON.stringify(probe)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}});
      const{snapshot}=await scanRepository(${JSON.stringify(repository)},${JSON.stringify(index)});const ctx=semanticKey('analysis-context',[snapshot.repository.identity,OWNED_PASS_VERSION]);const runs=writeSyntaxBase(s,snapshot,{nodes:[{id:'file',kind:'file',name:'a.ts',qualifiedName:'a.ts',file:'a.ts',adapter:'fixture',metadata:{revision:'two'}}],edges:[],diagnostics:[],metadata:{}},ctx,digest('two')).runs;
      s.publish(runs,${first},[],${JSON.stringify(initial.report)});`);
    const child = spawn(process.execPath, [file], { stdio: "ignore" });
    try {
      await ready(probe); const closed = new Promise(resolve => child.once("close", resolve)); child.kill("SIGKILL"); await closed;
      const recovered = new SemanticStore(filename);
      try {
        const active = recovered.activeSnapshot()!, report = readSnapshotReport(recovered.db, active)!;
        expect(active).toBe(point === "after-publish" ? first + 1 : first); expect(report.snapshot).toBe(active); expect(report.sourceCatalogue).toBe(digest(point === "after-publish" ? "two" : "one"));
        expect(readSnapshotReport(recovered.db, first)).toEqual(original); expect(recovered.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(recovered.db.pragma("foreign_key_check")).toEqual([]);
      } finally { recovered.close(); }
    } finally { child.kill("SIGKILL"); }
  }
}, 60000);

test("a custom index never reports a different identical-byte repository as fresh", async () => {
  const { root, repository, index } = await fixture(), other = path.join(root, "other"); await mkdir(other);
  await writeFile(path.join(other, "a.ts"), "export const value=1");
  await analyzeRepository(repository, { output: index });
  expect(await repositoryStatus(repository, index)).toMatchObject({ state: "fresh", repositoryChanged: false, semanticPublication: { state: "matches-legacy-report" } });
  expect(await repositoryStatus(other, index)).toMatchObject({ state: "stale", repositoryChanged: true, addedFiles: [], modifiedFiles: [], deletedFiles: [] });
  const synced = await syncRepository(other, index);
  expect(synced).toMatchObject({ incremental: false, fallbackReason: "repository identity or root changed", statusAfter: { state: "fresh", repositoryChanged: false } });
}, 30000);

test("excluded configuration, boundary settings and invalid raw edits participate in freshness and publication input checks", async () => {
  const { repository, index } = await fixture(), file = path.join(repository, "prograph.config.json");
  const config = { include: ["*.ts"], exclude: ["prograph.config.json"], boundaries: [{ protocol: "http", namespace: "service-one", contracts: ["api.yaml"], bindings: [] }] };
  await writeFile(file, JSON.stringify(config)); await analyzeRepository(repository, { output: index });
  const before = await scanRepository(repository, index); expect(before.snapshot.fileContents.has("prograph.config.json")).toBe(false);
  expect(await repositoryStatus(repository, index)).toMatchObject({ state: "fresh", configChanged: false });
  await writeFile(file, JSON.stringify({ ...config, boundaries: [{ ...config.boundaries[0], namespace: "service-two" }] }));
  expect(await inputMatches({ resource: "configuration:prograph", digest: before.snapshot.configurationInput! }, repository)).toBe(false);
  expect(await repositoryStatus(repository, index)).toMatchObject({ state: "stale", configChanged: true, modifiedFiles: [], semanticInputsChanged: true });
  expect((await syncRepository(repository, index)).statusAfter.state).toBe("fresh");
  // Raw configuration is evidence even when its effective settings are unchanged.
  await writeFile(file, JSON.stringify({ ...config, boundaries: [{ ...config.boundaries[0], namespace: "service-two" }], note: "raw edit" }));
  expect((await repositoryStatus(repository, index)).configChanged).toBe(true);
  await writeFile(file, "{invalid-one"); await analyzeRepository(repository, { output: index });
  await writeFile(file, "{invalid-two"); expect((await repositoryStatus(repository, index)).configChanged).toBe(true);
}, 30000);
