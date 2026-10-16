import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeFileSync } from "node:fs";
import { Project } from "ts-morph";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { traceCompilerInputs } from "../src/core/semantic/typescript-inputs.js";
import { toolInputResource, toolReceipt } from "../src/core/semantic/tool-receipt.js";
import { recordedInputStatus, retainProviders, semanticInventory } from "../src/core/semantic/provider-runs.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { canonical, digest, SCIP_SEMANTIC_VERSION, MANAGED_SCIP_VERSION } from "../src/core/semantic/model.js";
import { scanRepository } from "../src/core/repository/repository.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-inputs-")); roots.push(root); return root; }
function visible(index: string) {
  const s = new SemanticStore(path.join(index, "semantic.sqlite"));
  try { return digest(canonical(s.sql("SELECT c.key,f.key AS fact,c.confidence FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE snapshot=? ORDER BY c.key").all(s.activeSnapshot()))); }
  finally { s.close(); }
}

test("observed compiler search, directory membership and realpath changes fail the prepublication barrier", async () => {
  const root = await temporary(); const host = new Project().getFileSystem(); const trace = traceCompilerInputs(host);
  const missing = path.join(root, "new.d.ts"); expect(host.fileExistsSync(missing)).toBe(false);
  host.readDirSync(root); await trace.verify();
  await writeFile(missing, "export const answer: number;"); await expect(trace.verify()).rejects.toThrow("changed before publication");
  const alias = path.join(root, "alias"); const first = path.join(root, "one"); const second = path.join(root, "two"); await mkdir(first); await mkdir(second); await symlink(first, alias);
  const other = new Project().getFileSystem();
  const observed = traceCompilerInputs(other); other.realpathSync(alias); await observed.verify(); await rm(alias); await symlink(second, alias);
  await expect(observed.verify()).rejects.toThrow("changed before publication");
});

test("an excluded new module invalidates an unedited importer and agrees with a clean compiler rebuild", async () => {
  const root = await temporary(); const clean = await temporary(); await mkdir(path.join(root, "build/feature"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), '{"files":["app.ts"],"compilerOptions":{"strict":true}}');
  await writeFile(path.join(root, "app.ts"), "import {value} from './build/feature'; export function run(){return value()}\n");
  await writeFile(path.join(root, "build/feature/index.d.ts"), "export function value(): number;\n");
  const first = await analyzeRepository(root); expect(first.manifest.semanticCore?.status, first.manifest.semanticCore?.reason).toBe("partial"); expect((await repositoryStatus(root)).state).toBe("fresh");
  const old = visible(path.join(root, ".prograph"));
  await writeFile(path.join(root, "build/feature.d.ts"), "export function value(): string;\n");
  expect(await repositoryStatus(root)).toMatchObject({ state: "stale", addedFiles: [], modifiedFiles: [], semanticInputsChanged: true });
  const synced = await syncRepository(root); expect(synced.statusAfter.state).toBe("fresh"); expect(synced.fallbackReason).toContain("semantic dependency");
  expect(visible(path.join(root, ".prograph"))).not.toBe(old);
  await analyzeRepository(root, { output: clean }); expect(visible(clean)).toBe(visible(path.join(root, ".prograph")));
  // External dependencies are reference targets, not fabricated indexed definitions.
  const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try {
    const targets = s.sql("SELECT symbol.file,f.value_json FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_symbols symbol ON symbol.entity=f.object WHERE a.snapshot=? AND f.predicate='common.CallTarget'").all(s.activeSnapshot()) as Array<{ file: string; value_json: string }>;
    expect(targets.some(row => row.file === "build/feature.d.ts" && JSON.parse(row.value_json).signature.includes("string"))).toBe(true);
  } finally { s.close(); }
});

test("missing extended configuration is a negative dependency even outside scanner input", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "app.ts"), "export function run(){return 1}\n");
  await writeFile(path.join(root, "tsconfig.json"), '{"extends":"./build/options.json","files":["app.ts"]}');
  const first = await analyzeRepository(root); expect(first.manifest.semanticCore?.status, first.manifest.semanticCore?.reason).toBe("partial"); expect((await repositoryStatus(root)).state).toBe("fresh");
  await writeFile(path.join(root, "build/options.json"), '{"compilerOptions":{"strict":true,"target":"ES2022"}}');
  expect(await repositoryStatus(root)).toMatchObject({ state: "stale", addedFiles: [], semanticInputsChanged: true });
  expect((await syncRepository(root)).statusAfter.state).toBe("fresh");
});

test("configured SDK aliases retain membership and retarget dependencies through status and native retention", async () => {
  const root = await temporary(); const tools = await temporary(); await writeFile(path.join(root, "app.py"), "pass\n");
  for (const name of ["one", "two"]) { await mkdir(path.join(tools, name)); await writeFile(path.join(tools, name, "runtime"), "identical launcher"); }
  await writeFile(path.join(tools, "two/extra.pyi"), "class Added: ...\n");
  const alias = path.join(tools, "sdk"); await symlink(path.join(tools, "one"), alias);
  const snapshot = (await scanRepository(root)).snapshot; const s = new SemanticStore(path.join(root, "semantic.sqlite"));
  try {
    const run = s.begin("scip/managed-alias/index", "ctx", "input"); const resource = await toolInputResource(alias); expect(resource).toBe(`tree:${alias}`);
    s.input(run, resource, (await toolReceipt(alias)).sha256); s.input(run, "project-inventory", semanticInventory(snapshot)); s.seal(run, { mappingVersion: SCIP_SEMANTIC_VERSION, executionVersion: MANAGED_SCIP_VERSION }); const parent = s.publish([run]);
    expect(await retainProviders(s, snapshot, parent)).toEqual([run]); await rm(alias); await symlink(path.join(tools, "two"), alias);
    expect(await recordedInputStatus(s.filename, snapshot, new Set())).toMatchObject({ state: "changed", additionalChanges: 1 }); expect(await retainProviders(s, snapshot, parent)).toEqual([]);
    await rm(alias); await symlink(path.join(tools, "one"), alias); await writeFile(path.join(tools, "one/new.pyi"), "class New: ...\n");
    expect(await retainProviders(s, snapshot, parent)).toEqual([]);
  } finally { s.close(); }
});

test("a dependency changing after an earlier compiler unit seals cannot publish a mixed snapshot", async () => {
  const root = await temporary();
  for (const folder of ["one", "two"]) {
    await mkdir(path.join(root, folder)); await writeFile(path.join(root, folder, "tsconfig.json"), '{"files":["app.ts"]}');
    await writeFile(path.join(root, folder, "app.ts"), `export function ${folder}(){return 1}\n`);
  }
  await analyzeRepository(root); const filename = path.join(root, ".prograph/semantic.sqlite"); const before = new SemanticStore(filename); const parent = before.activeSnapshot(); before.close();
  await writeFile(path.join(root, "two/app.ts"), "export function two(){return 'changed'}\n");
  const seal = SemanticStore.prototype.seal; let injected = false;
  const hook = vi.spyOn(SemanticStore.prototype, "seal").mockImplementation(function(this: SemanticStore, run, coverage) {
    const result = seal.call(this, run, coverage);
    if (this.sql("SELECT partition_key FROM sc_runs WHERE id=?").get(run)?.partition_key === "typescript/project:two/tsconfig.json") {
      writeFileSync(path.join(root, "one/app.ts"), "export function one(){return false}\n"); injected = true;
    }
    return result;
  });
  try { const result = await analyzeRepository(root); expect(injected).toBe(true); expect(result.manifest.semanticCore).toMatchObject({ status: "failed", reason: expect.stringContaining("changed before publication") }); }
  finally { hook.mockRestore(); }
  const after = new SemanticStore(filename); try { expect(after.activeSnapshot()).toBe(parent); expect(after.db.pragma("integrity_check", { simple: true })).toBe("ok"); } finally { after.close(); }
});
