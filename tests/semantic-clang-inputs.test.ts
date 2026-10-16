import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { discoverProjects } from "../src/core/semantic/projects.js";
import { indexClang } from "../src/core/semantic/clang.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { recordedDigest } from "../src/core/semantic/input-check.js";
import * as inputTools from "../src/core/semantic/inputs.js";
import type { ProviderRegistration } from "../src/core/semantic/provider-plan.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-clang-input-")); roots.push(root); return root; }
const functions = "int one(void){return 1;} int two(void){return 2;}\n";
function inspect(root: string, index = path.join(root, ".prograph")) {
  const s = new SemanticStore(path.join(index, "semantic.sqlite"));
  try { const snapshot = s.activeSnapshot()!; return { snapshot, runs: s.sql("SELECT p.partition_key,p.run FROM sc_partitions p WHERE p.snapshot=? AND p.partition_key LIKE 'clang/%' ORDER BY p.partition_key").all(snapshot), claims: s.sql("SELECT c.key FROM sc_partitions p JOIN sc_owned o ON o.run=p.run JOIN sc_claims c ON c.id=o.claim WHERE p.snapshot=? AND p.partition_key LIKE 'clang/%' ORDER BY c.key").all(snapshot) }; }
  finally { s.close(); }
}
function calls(root: string, snapshot?: number) {
  const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite"));
  try { const caller = q.execute("find", "caller", snapshot ? { snapshot } : {}).items[0] as { key: string }; return q.execute("callees", caller.key, snapshot ? { snapshot } : {}).items.map(item => (item as { name: string }).name); }
  finally { q.close(); }
}
async function setup(root: string, source: string, flags: string[]) {
  await writeFile(path.join(root, "main.c"), source); await writeFile(path.join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", ...flags, "main.c"] }]));
  await analyzeRepository(root); const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(unit => unit.language === "c")!; return unit;
}
const qualified = test.skipIf(!existsSync("/usr/bin/clang"));

qualified("an excluded earlier header appearing invalidates the unedited importer and agrees exactly with a clean Clang rebuild", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build/late"), { recursive: true }); await writeFile(path.join(root, "build/late/api.h"), "#define SELECT 1\n");
  const source = '#include "api.h"\n' + functions + "int caller(void){\n#if SELECT\nreturn one();\n#else\nreturn two();\n#endif\n}\n";
  const unit = await setup(root, source, ["-Ibuild/early", "-Ibuild/late"]); const first = await indexClang(root, unit.key); expect(first.coverage).toMatchObject({ negativeSearches: "qualified-expanded-includes" }); expect(calls(root)).toEqual(["one"]);
  expect((await repositoryStatus(root)).state).toBe("fresh"); await mkdir(path.join(root, "build/early")); await writeFile(path.join(root, "build/early/api.h"), "#define SELECT 0\n");
  const status = await repositoryStatus(root); expect(status.modifiedFiles).toEqual([]); expect(status.semanticInputsChanged).toBe(true);
  const publisher = vi.spyOn(SemanticStore.prototype, "publish"); try { expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(publisher).toHaveBeenCalledTimes(1); } finally { publisher.mockRestore(); }
  expect(calls(root)).toEqual(["two"]); expect(calls(root, Number(first.snapshot))).toEqual(["one"]);
  const clean = await temporary(); await indexClang(root, unit.key, clean); expect(inspect(root).claims).toEqual(inspect(root, clean).claims);
  const before = inspect(root); await writeFile(path.join(root, "README.md"), "# Documentation\n"); await syncRepository(root); expect(inspect(root).runs).toEqual(before.runs);
  await rm(path.join(root, "build/early/api.h")); await syncRepository(root); expect(calls(root)).toEqual(["one"]); expect(await readFile(path.join(root, "main.c"), "utf8")).toBe(source);
}, 120000);

qualified("literal has_include absence is recorded even when the tested file is never included", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build"));
  const unit = await setup(root, functions + '#define EXISTS __ha\\\ns_include("optional.h")\n#if EXISTS\nint caller(void){return two();}\n#else\nint caller(void){return one();}\n#endif\n', ["-Ibuild"]);
  expect((await indexClang(root, unit.key)).coverage).toMatchObject({ negativeSearches: "qualified-expanded-includes" }); expect(calls(root)).toEqual(["one"]);
  await writeFile(path.join(root, "build/optional.h"), "// existence only\n"); expect((await repositoryStatus(root)).semanticInputsChanged).toBe(true);
  expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(calls(root)).toEqual(["two"]);
  const clean = await temporary(); await indexClang(root, unit.key, clean); expect(inspect(root).claims).toEqual(inspect(root, clean).claims);
}, 120000);

qualified("include directory alias retargeting invalidates context even when every positive input has identical bytes", async () => {
  const root = await temporary(); for (const dir of ["a", "b"]) { await mkdir(path.join(root, `build/${dir}`), { recursive: true }); await writeFile(path.join(root, `build/${dir}/api.h`), "int one(void);\n"); }
  const alias = path.join(root, "build/include"); await symlink("a", alias, "dir");
  const unit = await setup(root, '#include "api.h"\nint caller(void){return one();}\n', ["-Ibuild/include"]); await indexClang(root, unit.key);
  const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); let positives: Array<{ resource: string; digest: string }>;
  try { positives = s.sql("SELECT i.resource,i.digest FROM sc_partitions p JOIN sc_inputs i ON i.run=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'clang/%' AND i.resource LIKE 'physical:%'").all(s.activeSnapshot()) as typeof positives; } finally { s.close(); }
  const before = inspect(root); await rm(alias); await symlink("b", alias, "dir"); for (const input of positives!) expect(await recordedDigest(input.resource, root)).toBe(input.digest);
  expect((await repositoryStatus(root)).semanticInputsChanged).toBe(true); expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(inspect(root).runs).not.toEqual(before.runs); expect(calls(root)).toEqual(["one"]);
}, 120000);

qualified("nonliteral preprocessor queries expose unchecked coverage and cannot reuse stale precise output", async () => {
  for (const [preamble, condition] of [['#define HEADER "optional.h"\n', '__has_include(HEADER)'], ['#define HAS(x) __has_ %:%: include(x)\n', 'HAS("optional.h")']]) {
  const root = await temporary(); await mkdir(path.join(root, "build"));
  const unit = await setup(root, functions + preamble + `#if ${condition}\nint caller(void){return two();}\n#else\nint caller(void){return one();}\n#endif\n`, ["-Ibuild"]);
  expect((await indexClang(root, unit.key)).coverage).toMatchObject({ negativeSearches: "unqualified" }); expect(calls(root)).toEqual(["one"]); expect((await repositoryStatus(root)).semanticInputs?.state).toBe("unchecked");
  const before = inspect(root); await writeFile(path.join(root, "build/optional.h"), "// not part of -M dependencies\n"); await syncRepository(root); expect(calls(root)).toEqual(["two"]); expect(inspect(root).runs).not.toEqual(before.runs); expect((await repositoryStatus(root)).state).toBe("stale");
  }
}, 120000);

qualified("a header added between preprocessor observation and AST publication cannot publish a mixed dependency snapshot", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build/early"), { recursive: true }); await mkdir(path.join(root, "build/late")); await writeFile(path.join(root, "build/late/api.h"), "#define SELECT 1\n");
  const unit = await setup(root, '#include "api.h"\n' + functions + "int caller(void){return one();}\n", ["-Ibuild/early", "-Ibuild/late"]); await indexClang(root, unit.key); const before = inspect(root);
  const add = SemanticStore.prototype.addFact; let changed = false;
  const injected = vi.spyOn(SemanticStore.prototype, "addFact").mockImplementation(function(this: SemanticStore, run, fact) {
    const result = add.call(this, run, fact);
    if (!changed && fact.provenance.provider === "clang/compiler-ast") { changed = true; writeFileSync(path.join(root, "build/early/api.h"), "#define SELECT 0\n"); }
    return result;
  });
  try { await expect(indexClang(root, unit.key)).rejects.toThrow("Clang search input changed"); } finally { injected.mockRestore(); }
  expect(changed).toBe(true); expect(inspect(root).snapshot).toBe(before.snapshot); expect(calls(root)).toEqual(["one"]);
}, 120000);

qualified("dependency selection changing between the makefile dependency scan and AST is rejected", async () => {
  const root = await temporary(); await mkdir(path.join(root, "build/early"), { recursive: true }); await mkdir(path.join(root, "build/late")); await writeFile(path.join(root, "build/late/api.h"), "#define SELECT 1\n");
  const unit = await setup(root, '#include "api.h"\n' + functions + "int caller(void){return one();}\n", ["-Ibuild/early", "-Ibuild/late"]); await indexClang(root, unit.key); const before = inspect(root);
  const original = inputTools.digestFile; let changed = false;
  const injected = vi.spyOn(inputTools, "digestFile").mockImplementation(async (...args) => {
    const hash = await original(...args);
    if (!changed && args[0] === path.join(root, "main.c")) { changed = true; await writeFile(path.join(root, "build/early/api.h"), "#define SELECT 0\n"); }
    return hash;
  });
  try { await expect(indexClang(root, unit.key)).rejects.toThrow("Clang dependency selection changed"); } finally { injected.mockRestore(); }
  expect(changed).toBe(true); expect(inspect(root).snapshot).toBe(before.snapshot);
}, 120000);

qualified("macro return types preserve direct definition anchors while expanded identifier names remain unsupported", async () => {
  const root = await temporary(); const source = "#define API(type) type\nAPI(int) target(void){return 1;}\n#define DEFINE(name) int name(void){return 2;}\nDEFINE(hidden)\nint caller(void){return target()+hidden();}\n";
  const unit = await setup(root, source, []); const result = await indexClang(root, unit.key); expect((result.coverage as { macroSkipped: number }).macroSkipped).toBeGreaterThan(0);
  const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite"));
  try { const target = q.execute("find", "target").items[0] as { key: string }; expect(target).toBeDefined(); expect(q.execute("definition", target.key).items).toMatchObject([{ range: { line: 2, column: 10 } }]); expect(q.execute("callers", target.key).items).toMatchObject([{ name: "caller" }]); expect(q.execute("find", "hidden").items).toEqual([]); } finally { q.close(); }
}, 120000);

qualified("host context changes invalidate a registered native context and require tool requalification", async () => {
  const root = await temporary(), unit = await setup(root, "int caller(void){return 1;}\n", []); await indexClang(root, unit.key);
  const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); let grant: ProviderRegistration;
  try { const row = s.sql("SELECT * FROM sc_provider_recipes WHERE kind='clang'").get() as { key: string; recipe_json: string; trust: string; version: string; authorization: string }; grant = { key: row.key, kind: "clang", recipe: JSON.parse(row.recipe_json), trust: row.trust, version: row.version, authorization: row.authorization }; } finally { s.close(); }
  const before = os.release(), changed = vi.spyOn(os, "release").mockReturnValue(`${before}-qualified-input-test`);
  try { expect((await repositoryStatus(root)).semanticInputsChanged).toBe(true); await expect(indexClang(root, unit.key, undefined, { authorization: grant! })).rejects.toThrow("requalification"); await syncRepository(root); expect(inspect(root).runs).toEqual([]); } finally { changed.mockRestore(); }
  expect((await repositoryStatus(root)).semanticInputsChanged).toBe(true); expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(inspect(root).runs.length).toBeGreaterThan(0);
}, 120000);
