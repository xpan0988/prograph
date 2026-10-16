import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { indexClang } from "../src/core/semantic/clang.js";
import { indexRust } from "../src/core/semantic/rust.js";
import { indexManagedProject, type ManagedProject } from "../src/core/semantic/managed-scip.js";
import { discoverProjects } from "../src/core/semantic/projects.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { authorizeProvider, verifyProviderAuthorization } from "../src/core/semantic/provider-grants.js";
import { digest, RUST_PROVIDER_VERSION } from "../src/core/semantic/model.js";
import type { ProviderRegistration, PreparedProvider } from "../src/core/semantic/provider-plan.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-replay-")); roots.push(root); return root; }
function inspect(root: string) {
  const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  try { return { snapshot: s.activeSnapshot()!, snapshots: s.sql("SELECT COUNT(*) AS n FROM sc_snapshots").get() as { n: number }, runs: s.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? ORDER BY partition_key").all(s.activeSnapshot()) as Array<{ partition_key: string; run: number }>, recipes: s.sql("SELECT key,kind FROM sc_provider_recipes ORDER BY key").all() }; }
  finally { s.close(); }
}
function find(root: string, name: string, snapshot?: number) {
  const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite"));
  try { return q.execute("find", name, snapshot ? { snapshot } : {}).items; } finally { q.close(); }
}

test("provider grants bind recipe, repository and index; a copied or modified registration is not execution authority", async () => {
  const root = await temporary(), index = await temporary(), other = await temporary();
  const grant = await authorizeProvider({ key: "test", kind: "managed", recipe: { configuration: "/declared/context.json", id: "context", language: "python" }, trust: "0".repeat(64), version: "1" }, root, index);
  expect(await verifyProviderAuthorization(grant, root, index)).toBe(true);
  expect(await verifyProviderAuthorization(grant, other, index)).toBe(false); expect(await verifyProviderAuthorization(grant, root, other)).toBe(false);
  expect(await verifyProviderAuthorization({ ...grant, recipe: { ...grant.recipe, configuration: "/changed/context.json" } }, root, index)).toBe(false);
  expect(await verifyProviderAuthorization({ ...grant, version: "2" }, root, index)).toBe(false);
});

test("an index cannot forge permission to launch a different Rust binary; failure publishes owned coverage without stale native output", async () => {
  const root = await temporary(), toolchain = await temporary(); const marker = path.join(root, "EXECUTED");
  const binary = `#!/bin/sh\ntouch '${marker}'\nprintf 'unqualified tool\\n'\n`;
  for (const tool of ["analyzer", "cargo", "rustc"]) { await writeFile(path.join(toolchain, tool), binary); await chmod(path.join(toolchain, tool), 0o755); }
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "Cargo.toml"), '[package]\nname="closed"\nversion="0.1.0"\nedition="2021"\n'); await writeFile(path.join(root, "src/lib.rs"), "pub fn safe(){}\n");
  await mkdir(path.join(root, ".prograph")); const s = new SemanticStore(path.join(root, ".prograph/semantic.sqlite"));
  const options = { analyzer: path.join(toolchain, "analyzer"), analyzerSha256: digest(binary), toolchain };
  const registration: ProviderRegistration = { key: "rust-forged", kind: "rust", recipe: { manifest: "Cargo.toml", options, prefix: "scip/rust-forged" }, trust: "0".repeat(64), version: RUST_PROVIDER_VERSION, authorization: "0".repeat(64) };
  try { const run = s.begin("fixture/empty", "ctx", "empty"); s.seal(run, {}); s.publish([run], undefined, [registration]); } finally { s.close(); }
  await expect(indexRust(root, "Cargo.toml", { ...options, authorization: registration })).rejects.toThrow("explicit requalification");
  const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status).toBe("partial");
  expect(inspect(root).runs.some(row => row.partition_key === "provider/failure:rust-forged")).toBe(true);
  const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite"));
  try { expect(q.execute("context").items).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ provider: "rust-forged", status: "unavailable" }) })])); } finally { q.close(); }
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(!existsSync("/usr/bin/clang"))("registered Clang prepares without publication, then source/config changes publish once and failed replay removes precise output", async () => {
  const root = await temporary();
  await writeFile(path.join(root, "main.c"), "int target(void){return 1;} int run(void){return target();}\n");
  const command = (flags: string[] = []) => JSON.stringify([{ directory: root, file: "main.c", arguments: ["clang", ...flags, "-c", "main.c"] }]);
  await writeFile(path.join(root, "compile_commands.json"), command());
  const unit = discoverProjects((await scanRepository(root)).snapshot).units.find(unit => unit.language === "c")!;
  const initial = await indexClang(root, unit.key); expect(inspect(root).recipes).toHaveLength(1);
  let prepared: PreparedProvider | undefined; const parent = inspect(root).snapshot;
  await indexClang(root, unit.key, undefined, { prepare: plan => { prepared = plan; } });
  expect(prepared?.parent).toBe(parent); expect(inspect(root).snapshot).toBe(parent);
  await analyzeRepository(root); const before = inspect(root);
  await writeFile(path.join(root, "main.c"), "int target(void){return 2;} int run(void){return target();}\n");
  const publisher = vi.spyOn(SemanticStore.prototype, "publish");
  try { const result = await analyzeRepository(root); expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe("partial"); expect(publisher).toHaveBeenCalledTimes(1); } finally { publisher.mockRestore(); }
  const changed = inspect(root); expect(changed.snapshots.n).toBe(before.snapshots.n + 1); expect(find(root, "target")).toHaveLength(1); expect(find(root, "target", Number(initial.snapshot))).toHaveLength(1);
  await writeFile(path.join(root, "compile_commands.json"), command(["-DMODE=2"])); expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(find(root, "target")).toHaveLength(1);
  await writeFile(path.join(root, "compile_commands.json"), command(["-Xclang", "-load", "untrusted.so"]));
  await syncRepository(root); expect(find(root, "target")).toHaveLength(0); expect(inspect(root).runs.some(row => row.partition_key.startsWith("provider/failure:clang-"))).toBe(true);
  const gc = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); try { gc.collectGarbage({ keep: 1 }); } finally { gc.close(); }
  expect(inspect(root).recipes).toHaveLength(1);
  await writeFile(path.join(root, "compile_commands.json"), command()); expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(find(root, "target")).toHaveLength(1);
}, 120000);

const analyzer = process.env.PROGRAPH_TEST_RUST_ANALYZER, toolchain = process.env.PROGRAPH_TEST_RUST_TOOLCHAIN;
test.skipIf(!analyzer || !toolchain)("registered Rust replays manifest features atomically and ambient Cargo additions become owned fail-closed gaps", async () => {
  const root = await temporary(); await mkdir(path.join(root, "src"));
  const manifest = (features: string) => `[package]\nname="closed_replay"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[${features}]\nspecial=[]\n`;
  await writeFile(path.join(root, "Cargo.toml"), manifest(""));
  await writeFile(path.join(root, "src/lib.rs"), '#[cfg(not(feature="special"))] pub fn base()->u32{1}\n#[cfg(feature="special")] pub fn enhanced()->u32{2}\npub fn run()->u32{\n#[cfg(feature="special")] {enhanced()}\n#[cfg(not(feature="special"))] {base()}\n}\n');
  await indexRust(root, "Cargo.toml", { analyzer: analyzer!, analyzerSha256: digest(await readFile(analyzer!)), toolchain: toolchain! }); await analyzeRepository(root);
  const calls = () => { const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite")); try { const target = q.execute("find", "run").items[0] as { key: string }; return q.execute("callees", target.key).items.map(item => (item as { name: string }).name).sort(); } finally { q.close(); } };
  expect(calls()).toEqual(["base"]);
  await writeFile(path.join(root, "README.md"), "# Rust docs\n"); const before = inspect(root); await syncRepository(root); expect(inspect(root).runs.filter(row => row.partition_key.startsWith("scip/"))).toEqual(before.runs.filter(row => row.partition_key.startsWith("scip/")));
  await writeFile(path.join(root, "Cargo.toml"), manifest('"special"'));
  const publisher = vi.spyOn(SemanticStore.prototype, "publish");
  try { expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(publisher).toHaveBeenCalledTimes(1); } finally { publisher.mockRestore(); }
  expect(calls()).toEqual(["enhanced"]);
  await mkdir(path.join(root, ".cargo")); await writeFile(path.join(root, ".cargo/config.toml"), '[build]\nrustc-wrapper="must-not-run"\n'); await syncRepository(root);
  expect(find(root, "run")).toHaveLength(0); expect(inspect(root).runs.some(row => row.partition_key.startsWith("provider/failure:rust-"))).toBe(true);
  await rm(path.join(root, ".cargo/config.toml")); expect((await syncRepository(root)).statusAfter.state).toBe("fresh"); expect(calls()).toEqual(["enhanced"]);
}, 180000);

const profilesFile = process.env.PROGRAPH_TEST_MANAGED_PROFILES;
const managedSources = {
  python: { "pkg/__init__.py": "", "pkg/api.py": "def target()->int: return 1\n", "pkg/use.py": "from .api import target\ndef run()->int: return target()\n", "pyproject.toml": '[project]\nname="prograph-probe"\nversion="0.1.0"\n' },
  go: { "go.mod": "module example.org/prographprobe\ngo 1.26.0\n", "api.go": "package probe\nfunc Target()int{return 1}\nfunc Run()int{return Target()}\n" },
  java: { "Foo.java": "package sample; public class Foo { public static int target(){return 1;} public static int run(){return target();}}\n", "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>probe</artifactId><version>1</version></project>" },
  csharp: { "Probe.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>', "Foo.cs": "namespace Sample; public class Foo { public static int Target()=>1; public static int Run()=>Target(); }\n" },
};
for (const language of ["python", "go", "java", "csharp"] as const) test.skipIf(!profilesFile)(`registered ${language} uses the actual qualified producer on changes, reuses documentation-only output, and publishes a single snapshot`, async () => {
  const root = await temporary(); const profiles = JSON.parse(await readFile(profilesFile!, "utf8")) as Record<string, ManagedProject>;
  for (const [file, body] of Object.entries(managedSources[language])) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), body); }
  const config = { ...profiles[language]!, id: `replay-${language}` }; const file = path.join(root, "context.json"); await writeFile(file, JSON.stringify(config));
  const first = await indexManagedProject(root, file); await analyzeRepository(root); const before = inspect(root);
  const prefix = `scip/managed-replay-${language}/`;
  await writeFile(path.join(root, "README.md"), "# Documentation change\n"); await syncRepository(root); const documented = inspect(root);
  expect(documented.runs.filter(row => row.partition_key.startsWith(prefix))).toEqual(before.runs.filter(row => row.partition_key.startsWith(prefix)));
  const source = language === "python" ? "pkg/api.py" : language === "go" ? "api.go" : language === "java" ? "Foo.java" : "Foo.cs";
  const body = await readFile(path.join(root, source), "utf8"); await writeFile(path.join(root, source), body.replace("1", "2"));
  const publisher = vi.spyOn(SemanticStore.prototype, "publish");
  try { const result = await syncRepository(root); expect(result.manifest?.semanticCore?.status, result.manifest?.semanticCore?.reason).toBe("partial"); expect(result.statusAfter.state).toBe("fresh"); expect(publisher).toHaveBeenCalledTimes(1); } finally { publisher.mockRestore(); }
  const after = inspect(root); expect(after.snapshots.n).toBe(documented.snapshots.n + 1);
  expect(after.runs.filter(row => row.partition_key.startsWith(prefix))).not.toEqual(documented.runs.filter(row => row.partition_key.startsWith(prefix)));
  const name = ["go", "csharp"].includes(language) ? "Target" : "target";
  expect(find(root, name)).toHaveLength(1); expect(find(root, name, Number(first.snapshot))).toHaveLength(1);
  const q = new SemanticQuery(path.join(root, ".prograph/semantic.sqlite")); try { const target = q.execute("find", name).items[0] as { key: string }; expect(q.execute("callers", target.key).items.length).toBeGreaterThan(0); } finally { q.close(); }
}, 600000);
