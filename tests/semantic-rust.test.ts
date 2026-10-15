import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexRust } from "../src/core/semantic/rust.js";
import { runProviderProcess } from "../src/core/semantic/process.js";
import { semanticQueryForRepository } from "../src/core/semantic/query.js";
import { digest } from "../src/core/semantic/model.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { qualifyRustAnalyzer, RUST_ANALYZER_RELEASE } from "../src/core/semantic/rust-qualification.js";
const roots: string[] = [];
test("release qualification accepts platform displays and binds missing revision to exact artifact", () => {
  const mac = RUST_ANALYZER_RELEASE.artifacts["darwin:arm64"].executableSha256;
  const linux = RUST_ANALYZER_RELEASE.artifacts["linux:x64"].executableSha256;
  expect(qualifyRustAnalyzer("rust-analyzer 0.3.3081-standalone (2ad81e72b7 2026-10-11)", mac, "darwin", "arm64")).toMatchObject({ revisionEvidence: "embedded-and-pinned-artifact" });
  for (const text of ["rust-analyzer 0.3.3081-standalone", "rust-analyzer 0.3.3081", "rust-analyzer 0.3.3081 (2ad81e72b7)", "rust-analyzer 0.3.3081-standalone (unknown commit)", "rust-analyzer  0.3.3081-standalone (2ad81e72b7e978cb800dffe1bcce5c9f98032acf 2026-10-11)\n"]) {
    expect(qualifyRustAnalyzer(text, linux, "linux", "x64")).toMatchObject({ semanticVersion: "0.3.3081", artifact: "rust-analyzer-x86_64-unknown-linux-gnu.gz" });
  }
  expect(qualifyRustAnalyzer("rust-analyzer 0.3.3081-standalone", linux, "linux", "x64")).toMatchObject({ observedRevision: null, revisionEvidence: "pinned-release-artifact" });
});
test("release qualification rejects wrong version, revision, date, artifact and platform", () => {
  const linux = RUST_ANALYZER_RELEASE.artifacts["linux:x64"].executableSha256;
  for (const text of ["rust-analyzer 0.3.3082-standalone", "rust-analyzer 0.3.3081-next", "rust-analyzer 0.3.3081 (deadbeef00 2026-10-11)", "rust-analyzer 0.3.3081 (2ad81e72b7 2026-10-10)", "other 0.3.3081", "rust-analyzer 0.3.3081 (2ad81e72b7 deadbeef00)"]) expect(() => qualifyRustAnalyzer(text, linux, "linux", "x64")).toThrow();
  expect(() => qualifyRustAnalyzer("rust-analyzer 0.3.3081", "0".repeat(64), "linux", "x64")).toThrow("artifact");
  expect(() => qualifyRustAnalyzer("rust-analyzer 0.3.3081", linux, "darwin", "arm64")).toThrow("artifact");
  expect(() => qualifyRustAnalyzer("rust-analyzer 0.3.3081", linux, "linux", "arm64")).toThrow("artifact");
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-rust-provider-")); roots.push(root);
  await writeFile(path.join(root, "package.json"), '{"name":"rust-root"}');
  await mkdir(path.join(root, "native/src"), { recursive: true }); await mkdir(path.join(root, "native/helper/src"), { recursive: true });
  await writeFile(path.join(root, "native/Cargo.toml"), '[workspace]\nmembers=["helper"]\nresolver="2"\n[package]\nname="qualified_app"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nhelper={path="helper"}\n[features]\nextra=[]\n');
  await writeFile(path.join(root, "native/helper/Cargo.toml"), '[package]\nname="helper"\nversion="0.1.0"\nedition="2021"\n');
  await writeFile(path.join(root, "native/helper/src/lib.rs"), 'pub struct Value { pub number: i32 }\npub fn target() -> i32 { 1 }\n');
  await writeFile(path.join(root, "native/src/lib.rs"), 'use helper::Value;\npub trait Measure { type Item; fn measure(&self) -> Self::Item; }\nimpl Measure for Value { type Item = i32; fn measure(&self) -> i32 { self.number } }\npub fn target(value: &Value) -> i32 { value.measure() }\n#[cfg(feature="extra")] pub fn selected() -> i32 { 2 }\n');
  return root;
}
test("provider process bounds output, deadlines and cancellation", async () => {
  const cwd = await fixture(); const limits = { timeoutMs: 2000, maxOutputBytes: 1024 };
  await expect(runProviderProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], cwd, process.env, limits)).rejects.toThrow("Provider output");
  await expect(runProviderProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], cwd, process.env, { ...limits, timeoutMs: 100 })).rejects.toThrow("Provider deadline");
  const controller = new AbortController(); const promise = runProviderProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], cwd, process.env, { ...limits, signal: controller.signal }); controller.abort(); await expect(promise).rejects.toThrow("cancelled");
});
test.skipIf(process.platform === "win32")("deadline terminates POSIX descendants, not just the direct process", async () => {
  const root = await fixture(); const marker = path.join(root, "descendant-write");
  const descendant = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leaked'),500)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  await expect(runProviderProcess(process.execPath, ["-e", parent], root, process.env, { timeoutMs: 200, maxOutputBytes: 1024 })).rejects.toThrow("deadline");
  await new Promise(resolve => setTimeout(resolve, 600)); await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
test.skipIf(process.platform === "win32")("successful producer exit also cleans up descendants", async () => {
  const root = await fixture(); const marker = path.join(root, "descendant-success");
  const descendant = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leaked'),500)`;
  await runProviderProcess(process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`], root, process.env, { timeoutMs: 2000, maxOutputBytes: 1024 });
  await new Promise(resolve => setTimeout(resolve, 600)); await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
test("Rust binary pin failure preserves legacy behavior and does not invoke a producer", async () => {
  const root = await fixture(); await analyzeRepository(root);
  await expect(indexRust(root, "native/Cargo.toml", { analyzer: process.execPath, analyzerSha256: "0".repeat(64), toolchain: path.dirname(process.execPath) })).rejects.toThrow("digest mismatch");
  expect((await repositoryStatus(root)).state).toBe("fresh");
});
const analyzer = process.env.PROGRAPH_TEST_RUST_ANALYZER; const toolchain = process.env.PROGRAPH_TEST_RUST_TOOLCHAIN;
test.skipIf(!analyzer || !toolchain)("real Rust producer qualifies traits, path dependencies, feature variants and stable navigation", async () => {
  const root = await fixture(); const options = { analyzer: analyzer!, analyzerSha256: digest(await readFile(analyzer!)), toolchain: toolchain! };
  const original = await readFile(path.join(root, "native/src/lib.rs"));
  await analyzeRepository(root);
  const first = await indexRust(root, "native/Cargo.toml", options);
  expect(first).toMatchObject({ accepted: 2, rejected: 0, calls: "unsupported", environment: { compilerChecked: true } });
  let q = await semanticQueryForRepository(root); let defaultTargets: string[];
  try {
    defaultTargets = (q.execute("find", "target").items as Array<{ key: string }>).map(item => item.key); expect(defaultTargets).toHaveLength(2);
    expect(q.execute("find", "Measure").items).toHaveLength(1);
    expect(q.execute("find", "Item").items).toHaveLength(2);
    const value = (q.execute("find", "Value").items as Array<{ key: string }>)[0]!.key;
    expect(q.execute("references", value).items.length).toBeGreaterThan(0);
    expect(q.execute("native", value).items).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ signature: expect.stringContaining("Value") }) })]));
    expect(q.execute("find", "selected").items).toHaveLength(0);
    expect(q.execute("context", value).items).toMatchObject([{ value: { documentPathPrefix: "native", execution: { environment: { capabilities: { calls: "unsupported" } } } } }]);
  } finally { q.close(); }
  await indexRust(root, "native/Cargo.toml", { ...options, features: ["extra"] });
  q = await semanticQueryForRepository(root);
  try { expect(q.execute("find", "target").items).toHaveLength(4); expect(q.execute("find", "selected").items).toHaveLength(1); } finally { q.close(); }
  await writeFile(path.join(root, "native/src/lib.rs"), original.toString().replace("{ 2 }", "{ 3 }"));
  await indexRust(root, "native/Cargo.toml", options);
  q = await semanticQueryForRepository(root);
  try { expect((q.execute("find", "target").items as Array<{ key: string }>).map(item => item.key)).toEqual(defaultTargets); expect(q.execute("find", "selected").items).toHaveLength(0); } finally { q.close(); }
  const clean = await mkdtemp(path.join(os.tmpdir(), "prograph-rust-oracle-")); roots.push(clean);
  await indexRust(root, "native/Cargo.toml", options, clean);
  const common = async (index?: string) => {
    const query = await semanticQueryForRepository(root, index);
    try { return query.db.prepare("SELECT DISTINCT f.key,c.confidence FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE a.snapshot=(SELECT value FROM sc_meta WHERE key='active') AND f.predicate IN ('common.Definition','common.Reference') ORDER BY f.key,c.confidence").all(); }
    finally { query.close(); }
  };
  expect(await common()).toEqual(await common(clean));
  await expect(stat(path.join(root, "native/Cargo.lock"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60000);
test.skipIf(!analyzer || !toolchain)("Rust build scripts are refused without effects or snapshot replacement", async () => {
  const root = await fixture(); await analyzeRepository(root);
  const before = await semanticQueryForRepository(root); let snapshot: unknown;
  try { snapshot = before.execute("status").snapshot; } finally { before.close(); }
  await writeFile(path.join(root, "native/build.rs"), 'fn main() { std::fs::write("UNEXPECTED_BUILD", "ran").unwrap(); }');
  const options = { analyzer: analyzer!, analyzerSha256: digest(await readFile(analyzer!)), toolchain: toolchain! };
  await expect(indexRust(root, "native/Cargo.toml", options)).rejects.toThrow("build scripts/proc macros");
  await expect(stat(path.join(root, "native/UNEXPECTED_BUILD"))).rejects.toMatchObject({ code: "ENOENT" });
  const after = await semanticQueryForRepository(root); try { expect(after.execute("status").snapshot).toBe(snapshot); } finally { after.close(); }
}, 30000);
test.skipIf(!analyzer || !toolchain)("custom output ancestors cannot supply undeclared Cargo configuration", async () => {
  const root = await fixture(); const output = await mkdtemp(path.join(os.tmpdir(), "prograph-rust-ambient-")); roots.push(output);
  await mkdir(path.join(output, ".cargo")); await writeFile(path.join(output, ".cargo/config.toml"), '[build]\nrustc-wrapper="/unqualified-wrapper"\n');
  await expect(indexRust(root, "native/Cargo.toml", { analyzer: analyzer!, analyzerSha256: digest(await readFile(analyzer!)), toolchain: toolchain! }, output)).rejects.toThrow("ambient Cargo configuration");
  await expect(stat(path.join(output, "semantic.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});
