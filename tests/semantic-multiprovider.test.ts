import {releaseMigrationRetention} from "./oracles/migration-retention.js";
import {prepareAuthorityMigration} from "../src/core/semantic/authority-migration.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { indexManagedProject, type ManagedProject } from "../src/core/semantic/managed-scip.js";
import { indexRust } from "../src/core/semantic/rust.js";
import { indexClang } from "../src/core/semantic/clang.js";
import { discoverProjects } from "../src/core/semantic/projects.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { authorizeProvider } from "../src/core/semantic/provider-grants.js";
import { canonical, digest } from "../src/core/semantic/model.js";
import type { ProviderRegistration } from "../src/core/semantic/provider-plan.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { collectIndexGarbage } from "../src/core/semantic/provider-artifacts.js";
import { repositoryStatus } from "../src/core/analysis/state.js";

const profilesFile = process.env.PROGRAPH_TEST_MANAGED_PROFILES;
const analyzer = process.env.PROGRAPH_TEST_RUST_ANALYZER, toolchain = process.env.PROGRAPH_TEST_RUST_TOOLCHAIN;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (process.env.PROGRAPH_TEST_ORACLE_KEEP) console.log(`oracle investigation retained: ${root}`); else await rm(root, { recursive: true, force: true }); } });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-multiprovider-")); roots.push(root); return root; }

/** Copy local execution CONTROL only. A new index must reauthorize and run every
 * real producer. No semantic fact, claim, output SCIP artifact or projection from
 * the incremental index is an input to the expected result. */
async function independentRebuild(root: string, index: string, clean: string) {
  const before = new SemanticStore(path.join(index, "semantic.sqlite"));
  let registrations: ProviderRegistration[];
  try {
    const rows = before.sql("SELECT key,kind,recipe_json,trust,version FROM sc_provider_recipes ORDER BY key").all() as Array<Omit<ProviderRegistration, "recipe" | "authorization"> & { recipe_json: string }>;
    await mkdir(clean, { recursive: true });
    registrations = await Promise.all(rows.map(row => authorizeProvider({ key: row.key, kind: row.kind, recipe: JSON.parse(row.recipe_json), trust: row.trust, version: row.version }, root, clean)));
  } finally { before.close(); }
  const seed = new SemanticStore(path.join(clean, "semantic.sqlite"));
  try { seed.publish([], undefined, registrations); } finally { seed.close(); }
  const result = await analyzeRepository(root, { output: clean }); expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe("partial");
}

test.skipIf(!profilesFile || !analyzer || !toolchain)("seeded multi-provider edits match independent actual compiler rebuilds for facts, claims, coverage, projections and confidence", async () => {
  const root = await temporary(), clean = await temporary(), index = path.join(root, ".prograph");
  const put = async (file: string, body: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), body); };
  const rustManifest = (special: boolean) => `[package]\nname="oracle_native"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[${special ? '"special"' : ""}]\nspecial=[]\n`;
  await put("tsconfig.json", '{"include":["*.ts"],"compilerOptions":{"strict":true,"target":"ES2022"}}');
  await put("api.ts", "export function target(n:number):number{return n}\n");
  await put("use.ts", "import {target} from './api'; export function run(){return target(1)}\n");
  await put("python/pkg/__init__.py", ""); await put("python/pkg/api.py", "def target()->int: return 1\n");
  await put("python/pkg/use.py", "from .api import target\ndef run()->int:return target()\n");
  await put("python/pyproject.toml", '[project]\nname="oracle-python"\nversion="0.1.0"\n');
  await put("go/go.mod", "module example.org/prographprobe\ngo 1.26.0\n");
  await put("go/api.go", "package probe\nfunc Target()int{return 1}\nfunc Run()int{return Target()}\n");
  await put("java/Foo.java", "package sample; public class Foo { public static int target(){return 1;} public static int run(){return target();}}\n");
  await put("java/pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>oracle</artifactId><version>1</version></project>");
  await put("csharp/Probe.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  await put("csharp/Foo.cs", "namespace Sample; public class Foo { public static int Target()=>1; public static int Run()=>Target(); }\n");
  await put("native/Cargo.toml", rustManifest(false));
  await put("native/src/lib.rs", '#[cfg(not(feature="special"))]pub fn base()->u32{1}\n#[cfg(feature="special")]pub fn enhanced()->u32{2}\npub fn run()->u32{\n#[cfg(feature="special")]{enhanced()}\n#[cfg(not(feature="special"))]{base()}\n}\n');
  await put("target.h", "int target(void);\n"); await put("main.c", '#include "target.h"\nint target(void){return 1;} int run(void){return target();}\n');
  const compile = (mode: number) => JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", `-DMODE=${mode}`, "-c", "main.c"] }]);
  await put("compile_commands.json", compile(1));
  const schema = (operation: string) => JSON.stringify({ openapi: "3.0.0", info: { title: "Oracle", version: "1" }, servers: [{ url: "https://oracle.example" }], paths: { "/items": { get: { operationId: operation, responses: { "200": { description: "ok" } } } } } });
  await put("api.openapi.json", schema("items")); await put("README.md", "# target and run\nSee api.ts and python/pkg/api.py\n");
  const profiles = JSON.parse(await readFile(profilesFile!, "utf8")) as Record<string, ManagedProject>;
  const configurations = new Map<string, ManagedProject>();
  for (const language of ["python", "go", "java", "csharp"] as const) {
    const config = { ...profiles[language]!, id: `oracle-${language}`, root: language };
    configurations.set(language, config); await put(`${language}-context.json`, JSON.stringify(config));
    await indexManagedProject(root, `${language}-context.json`);
  }
  await indexRust(root, "native/Cargo.toml", { analyzer: analyzer!, analyzerSha256: digest(await readFile(analyzer!)), toolchain: toolchain! });
  const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(unit => unit.language === "c")!;
  await indexClang(root, unit.key); await analyzeRepository(root);
  const initialSeed = Number(process.env.PROGRAPH_TEST_ORACLE_SEED ?? "0x29f61b");
  expect(Number.isSafeInteger(initialSeed) && initialSeed >= 0 && initialSeed <= 0xffffffff).toBe(true);
  let seed = initialSeed; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const editConfig = async (language: string, mutate: (config: ManagedProject) => void) => {
    const config = structuredClone(configurations.get(language)!); mutate(config); await put(`${language}-context.json`, JSON.stringify(config));
  };
  const edits: Array<{ name: string; apply(): Promise<void> }> = [
    { name: "add Python module without editing importer", apply: () => put("python/pkg/api/__init__.py", `def target()->int: return ${random() % 100}\n`) },
    { name: "modify exported TS overload", apply: () => put("api.ts", "export function target(n:number):number; export function target(n:string):string; export function target(n:any){return n}\n") },
    { name: "rename Java source", apply: async () => { await rename(path.join(root, "java/Foo.java"), path.join(root, "java/Renamed.java")); await put("java/Renamed.java", "package sample; class Foo { public static int target(){return 2;} public static int run(){return target();}}\n"); } },
    { name: "delete shadow Python module", apply: () => rm(path.join(root, "python/pkg/api"), { recursive: true, force: true }) },
    { name: "C header dependency", apply: () => put("target.h", `#define ORACLE_${random() % 100} 1\nint target(void);\n`) },
    { name: "project compiler configuration", apply: () => put("tsconfig.json", '{"include":["*.ts"],"compilerOptions":{"strict":false,"target":"ES2020"}}') },
    { name: "Rust feature variant", apply: () => put("native/Cargo.toml", rustManifest(true)) },
    { name: "Go target tags", apply: () => editConfig("go", config => { config.go!.tags = ["oracle"]; }) },
    { name: "Java language level", apply: () => editConfig("java", config => { config.java!.release = 21; }) },
    { name: "Csharp variant defines", apply: () => editConfig("csharp", config => { config.csharp!.projects[0]!.defines = ["ORACLE"]; }) },
    { name: "schema contract replacement", apply: () => put("api.openapi.json", schema(`items${random() % 100}`)) },
    { name: "documentation only", apply: () => put("README.md", `# run and target\nSee use.ts and java/Renamed.java\n${random()}\n`) },
    { name: "producer receipt mismatch", apply: () => editConfig("python", config => { config.producer.sha256 = "0".repeat(64); }) },
    { name: "restore qualified producer", apply: () => editConfig("python", () => {}) },
  ];
  // Dependency-sensitive tickets stay ordered; the independent source/config/
  // variant tickets are reproducibly shuffled, followed by randomized repeats.
  const shuffled = edits.slice(4, 12); for (let i = shuffled.length - 1; i > 0; i--) { const j = random() % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  const schedule = [...edits.slice(0, 4), ...shuffled, ...edits.slice(12), ...Array.from({ length: 3 }, () => shuffled[random() % shuffled.length]!)];
  const evidence: unknown[] = [];
  let pythonUnavailable = false;
  for (let i = -1; i < schedule.length; i++) {
    console.log(`multi-provider oracle ${i + 2}/${schedule.length + 1}: executing ${schedule[i]?.name ?? "initial"}`);
    const edit = schedule[i]; if (edit) { await edit.apply(); await syncRepository(root); }
    await rm(clean, { recursive: true, force: true }); await independentRebuild(root, index, clean);
    const actual = await semanticSnapshot(index), expected = await semanticSnapshot(clean);
    if (edit?.name === "producer receipt mismatch") pythonUnavailable = true;
    if (edit?.name === "restore qualified producer") pythonUnavailable = false;
    // Equality of two empty/gap-only results is not producer qualification.
    for (const state of [actual, expected]) {
      const coverage = state.coverage.map(row => JSON.parse(row) as [string, Record<string, unknown>]);
      expect(coverage.filter(([partition]) => partition.startsWith("provider/failure:"))).toHaveLength(pythonUnavailable ? 1 : 0);
      expect(state.calls).toHaveLength(pythonUnavailable ? 6 : 7);
      for (const provider of ["scip-python", "scip-go", "scip-java", "scip-dotnet", "rust-analyzer", "clang/compiler-ast", "typescript/compiler-api"]) {
        if (provider === "scip-python" && pythonUnavailable) continue;
        expect(coverage.some(([, result]) => result.provider === provider && result.status === "partial"), provider).toBe(true);
        const contexts = state.facts.map(row => JSON.parse(row) as unknown[]).filter(row => row[0] === "context.Project" && (row[5] as Record<string, unknown>).producer && ((row[5] as Record<string, unknown>).producer as Record<string, unknown>).name === provider).map(row => row[1]);
        if (contexts.length) expect(state.facts.some(row => { const fact = JSON.parse(row) as unknown[]; return fact[0] === "common.CallSummary" && contexts.includes(fact[1]); }), `Observed declared call required for ${provider}`).toBe(true);
      }
    }
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
      if (canonical(actual[field]) !== canonical(expected[field])) {
        const a = new Set(actual[field]), e = new Set(expected[field]);
        throw Error(`seed=${seed} edit=${i} ${edit?.name ?? "initial"}, ${field}: ${JSON.stringify({ incrementalOnly: [...a].filter(row => !e.has(row)).slice(0, 2), cleanOnly: [...e].filter(row => !a.has(row)).slice(0, 2) })}`);
      }
    }
    evidence.push({ edit: edit?.name ?? "initial", seed, hashes: Object.fromEntries(Object.entries(actual).map(([field, rows]) => [field, digest(canonical(rows))])), counts: Object.fromEntries(Object.entries(actual).map(([field, rows]) => [field, rows.length])) });
    if (process.env.PROGRAPH_TEST_ORACLE_EVIDENCE) await writeFile(process.env.PROGRAPH_TEST_ORACLE_EVIDENCE, `${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, initialSeed, sourceRoot: root, complete: i === schedule.length - 1, expectedChecks: schedule.length + 1, scope: "Actual TS/Clang/Rust/Python/Go/Java/Csharp tools, fresh independent index and reauthorized execution control per edit; no copied facts or producer outputs", evidence }, null, 2)}\n`);
    console.log(`multi-provider oracle ${i + 2}/${schedule.length + 1}: ${edit?.name ?? "initial"} agrees`);
  }
  expect(evidence).toHaveLength(18);
// This is 18 independent seven-language extractions, not a production request.
// Linux Node 22/24 measured 2-6 minutes per checkpoint; the aggregate
// correctness container must hold all 18. Production deadlines remain unchanged.
}, 5400000);

const baselineRuntime = process.env.PROGRAPH_TEST_BASELINE_RUNTIME;
test.skipIf(!profilesFile || !baselineRuntime)("actual accepted writer upgrade invalidates prior mappings, replays registered producers and preserves pinned history through GC", async () => {
  const receipt = JSON.parse(await readFile(path.join(baselineRuntime!, "baseline-receipt.json"), "utf8"));
  expect(receipt.commit).toBe("6eefca04b5032f3416fcc95bda23dec4bb8f65db");
  const oldAnalyze = await import(/* @vite-ignore */ pathToFileURL(path.join(baselineRuntime!, "dist/core/analysis/analyze.js")).href) as typeof import("../src/core/analysis/analyze.js");
  const oldManaged = await import(/* @vite-ignore */ pathToFileURL(path.join(baselineRuntime!, "dist/core/semantic/managed-scip.js")).href) as typeof import("../src/core/semantic/managed-scip.js");
  const root = await temporary(), clean = await temporary(), index = path.join(root, ".prograph");
  const put = async (file: string, body: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), body); };
  await put("tsconfig.json", '{"include":["*.ts"],"compilerOptions":{"strict":true}}');
  await put("a.ts", "export function target(){return 1} export function run(){return target()}\n");
  await put("python/api.py", "def target()->int:return 1\ndef run()->int:return target()\n");
  await put("python/pyproject.toml", '[project]\nname="upgrade-probe"\nversion="0.1.0"\n');
  await put("go/go.mod", "module example.org/prographprobe\ngo 1.26.0\n");
  await put("go/api.go", "package probe\nfunc Target()int{return 1}\nfunc Run()int{return Target()}\n");
  const profiles = JSON.parse(await readFile(profilesFile!, "utf8")) as Record<string, ManagedProject>;
  for (const language of ["python", "go"] as const) {
    await put(`${language}-context.json`, JSON.stringify({ ...profiles[language]!, id: `upgrade-${language}`, root: language }));
    await oldManaged.indexManagedProject(root, `${language}-context.json`);
  }
  await oldAnalyze.analyzeRepository(root);
  await prepareAuthorityMigration(index,{storageOnly:true});
  const filename = path.join(index, "semantic.sqlite"), before = new SemanticStore(filename);
  let pinned: number, originalClaims: string, oldRuns: number[];
  try {
    pinned = before.activeSnapshot()!; before.pinSnapshot(pinned, "upgrade-oracle");
    oldRuns = (before.sql("SELECT run FROM sc_partitions WHERE snapshot=?").all(pinned) as Array<{ run: number }>).map(row => row.run);
    const coverage = before.sql("SELECT r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'scip/%/index'").all(pinned) as Array<{ coverage_json: string }>;
    expect(coverage).toHaveLength(2); expect(coverage.every(row => JSON.parse(row.coverage_json).mappingVersion === "4")).toBe(true);
    originalClaims = digest(canonical(before.sql("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE snapshot=? ORDER BY c.key").all(pinned)));
  } finally { before.close(); }
  const changed = await syncRepository(root); expect(changed.manifest?.semanticCore?.status).toBe("partial");
  await independentRebuild(root, index, clean);
  const actual = await semanticSnapshot(index), expected = await semanticSnapshot(clean); expect(actual).toEqual(expected);
  expect(actual.calls).toHaveLength(3);
  const current = new SemanticStore(filename);
  try {
    const coverage = current.sql("SELECT r.coverage_json,p.run FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'scip/%/index'").all(current.activeSnapshot()) as Array<{ coverage_json: string; run: number }>;
    expect(coverage).toHaveLength(2); expect(coverage.every(row => JSON.parse(row.coverage_json).mappingVersion === "5" && !oldRuns.includes(row.run))).toBe(true);
  } finally { current.close(); }
  const collected = await collectIndexGarbage(filename, { keep: 1 });
  // Old sources have no root witness. Refuse to guess their filesystem identity.
  expect(collected).toHaveProperty("artifacts.state", "deferred");
  const historical = new SemanticQuery(filename);
  try { expect(historical.execute("find", "target", { snapshot: pinned }).items.length).toBeGreaterThan(0); } finally { historical.close(); }
  const retained = new SemanticStore(filename);
  try {
    expect(digest(canonical(retained.sql("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE snapshot=? ORDER BY c.key").all(pinned)))).toBe(originalClaims);
    retained.unpinSnapshot(pinned, "upgrade-oracle");expect(releaseMigrationRetention(retained)).toBeGreaterThan(0);
  } finally { retained.close(); }
  expect(await collectIndexGarbage(filename, { keep: 1 })).toHaveProperty("artifacts.state", "complete");
  expect((await repositoryStatus(root)).state).toBe("fresh");
  if (process.env.PROGRAPH_TEST_UPGRADE_EVIDENCE) await writeFile(process.env.PROGRAPH_TEST_UPGRADE_EVIDENCE, `${JSON.stringify({ baseline: receipt, sourceRoot: root, pinned, historicalClaimHash: originalClaims, cleanRebuildHash: digest(canonical(actual)), counts: Object.fromEntries(Object.entries(actual).map(([field, rows]) => [field, rows.length])), pinnedGc: collected, unpinnedGc: "complete", freshness: "fresh" }, null, 2)}\n`);
}, 300000);
