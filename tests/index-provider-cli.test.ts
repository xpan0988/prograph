import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { discoverProjects } from "../src/core/semantic/projects.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { digest } from "../src/core/semantic/model.js";
import type { ManagedProject } from "../src/core/semantic/managed-scip.js";
const profilesFile = process.env.PROGRAPH_TEST_MANAGED_PROFILES, analyzer = process.env.PROGRAPH_TEST_RUST_ANALYZER, toolchain = process.env.PROGRAPH_TEST_RUST_TOOLCHAIN;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-index-cli-")); roots.push(root);
  const repository = path.join(root, "source"), index = path.join(root, "custom"); await mkdir(repository);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(repository, file)), { recursive: true }); await writeFile(path.join(repository, file), text); }
  return { repository, index };
}
async function cli(args: string[]) { return JSON.parse((await promisify(execFile)(process.execPath, ["dist/cli/index.js", "semantic", ...args, "--format", "json"], { timeout: 300000, maxBuffer: 4 * 1024 ** 2 })).stdout) as Record<string, unknown>; }
function verify(index: string, name: string, called = true) {
  const query = new SemanticQuery(path.join(index, "semantic.sqlite"));
  try {
    const symbol = (query.execute("find", name).items as Array<{ key: string }>)[0]; expect(symbol).toBeDefined();
    expect(query.execute("definition", symbol!.key).items.length).toBeGreaterThan(0); expect(query.execute("references", symbol!.key).items.length).toBeGreaterThan(0);
    if (called) expect(query.execute("callers", symbol!.key).items.length).toBeGreaterThan(0);
  } finally { query.close(); }
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try { expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]); expect(store.sql("SELECT COUNT(*) n FROM sc_provider_recipes").get()).toEqual({ n: called ? 1 : 0 }); } finally { store.close(); }
}
const sources = {
  python: { "api.py": "def target()->int:return 1\ndef run()->int:return target()\n", "pyproject.toml": '[project]\nname="cli-probe"\nversion="0.1.0"\n' },
  go: { "go.mod": "module example.org/prographprobe\ngo 1.26.0\n", "api.go": "package probe\nfunc Target()int{return 1}\nfunc Run()int{return Target()}\n" },
  java: { "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>cli</artifactId><version>1</version></project>", "Foo.java": "package sample; public class Foo {public static int target(){return 1;} public static int run(){return target();}}\n" },
  csharp: { "Probe.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>', "Foo.cs": "namespace Sample; public class Foo {public static int Target()=>1;public static int Run()=>Target();}\n" },
};
for (const language of ["python", "go", "java", "csharp"] as const) test.skipIf(!profilesFile)(`isolated CLI executes qualified ${language} and preserves owned navigation/registration`, async () => {
  const { repository, index } = await fixture(sources[language]);
  const profiles = JSON.parse(await readFile(profilesFile!, "utf8")) as Record<string, ManagedProject>;
  await writeFile(path.join(repository, "context.json"), JSON.stringify({ ...profiles[language], id: `cli-${language}` }));
  const result = await cli(["index-project", "context.json", "--repo", repository, "--index", index]);
  expect(result).toMatchObject({ rejected: 0, calls: "partial-declared-static-targets" }); verify(index, ["go", "csharp"].includes(language) ? "Target" : "target");
  if (language === "go") {
    const execution = String(result.executionDirectory), sidecar = JSON.parse(await readFile(path.join(execution, "execution.json"), "utf8")).sidecar;
    const manifest = path.join(repository, "sidecar.json"); await writeFile(manifest, JSON.stringify(sidecar));
    const imported = path.join(index, "reimport"), replay = await cli(["import-scip", path.join(execution, "index.scip"), "--manifest", manifest, "--repo", repository, "--index", imported]);
    expect(replay.rejected).toBe(0); verify(imported, "Target", false);
  }
}, 300000);

test.skipIf(!analyzer || !toolchain)("isolated Rust CLI preserves explicit feature flags and pinned compiler environment", async () => {
  const { repository, index } = await fixture({ "Cargo.toml": '[package]\nname="cli_rust"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[]\nextra=[]\n', "src/lib.rs": '#[cfg(feature="extra")]pub fn target()->u32{1}\npub fn run()->u32{target()}\n' });
  const result = await cli(["index-rust", "Cargo.toml", "--repo", repository, "--index", index, "--analyzer", analyzer!, "--analyzer-sha256", digest(await readFile(analyzer!)), "--toolchain", toolchain!, "--features", "extra", "--no-default-features"]);
  expect(result).toMatchObject({ rejected: 0, environment: { features: ["extra"], noDefaultFeatures: true } }); verify(index, "target");
}, 120000);

test("isolated Clang CLI preserves compilation-unit input and owned calls", async () => {
  const { repository, index } = await fixture({ "api.c": "int target(void){return 1;} int run(void){return target();}\n" });
  await writeFile(path.join(repository, "compile_commands.json"), JSON.stringify([{ directory: repository, file: "api.c", arguments: ["clang", "-c", "api.c"] }]));
  const unit = discoverProjects((await scanRepository(repository)).snapshot).units.find(unit => unit.language === "c")!;
  const result = await cli(["index-clang", unit.key, "--repo", repository, "--index", index]); expect(result).toHaveProperty("coverage.status", "partial"); verify(index, "target");
});
