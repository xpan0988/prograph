import { expect, test } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rustAdapter } from "../src/adapters/language/rust/index.js";
import { rustAdapter as accepted } from "./oracles/rust-stage6-1.js";
import { defaultConfig } from "../src/core/config/config.js";
import type { RepositorySnapshot } from "../src/core/adapters/contracts.js";
import { installAnalysisDiagnostics } from "../src/core/analysis/diagnostics.js";

function snapshot(sources: Record<string, string>): RepositorySnapshot {
  return { repository: { root: "/rust-oracle", identity: "rust-stage6-equivalence" }, sourceRoot: "/rust-oracle", configurationInput: "fixed",
    config: defaultConfig(), files: Object.keys(sources).reverse(), fileContents: new Map(Object.entries(sources)),
    absoluteFiles: new Map(Object.keys(sources).map(file => [file, `/rust-oracle/${file}`])) };
}
async function equal(sources: Record<string, string>) {
  const input = snapshot(sources), before = await accepted.analyze(input), after = await rustAdapter.analyze(input);
  // No sorting, projection, position/confidence/diagnostic omission or volatile fields.
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  return after;
}
const types = `struct A; struct B;
impl A { fn hit(&self) {} fn make() -> A { A } }
impl B { fn hit(&self) {} fn make() -> B { B } }
`;

test("the independent oracle body is the exact pre-optimization 8ed2d32 extractor", async () => {
  const source = await readFile(new URL("./oracles/rust-stage6-1.ts", import.meta.url), "utf8");
  expect(createHash("sha256").update(source.slice(source.indexOf("interface ParsedFile"))).digest("hex"))
    .toBe("3dff3c0c665e7909d3a9c0dd25654724c079b8d5fbd4356da9ba0cdc3f1c3030");
});

test.each(["rust-quality", "rust-verified-misses"])("complete existing %s fixture output matches the original extractor", async fixture => {
  const root = new URL(`./fixtures/${fixture}/`, import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter(f => f.endsWith(".rs"));
  await equal(Object.fromEntries(await Promise.all(files.map(async file => [file.replaceAll("\\", "/"), await readFile(new URL(file, root), "utf8")]))));
});

test("ordered cross-file/module definitions, aliases, scoped imports and ambiguity remain identical", async () => {
  const result = await equal({
    "native/src/lib.rs": `mod left; mod right; use crate::left::unique as renamed;
      fn root() { left::same(); right::same(); renamed(); same(); }
      fn scoped() { use crate::right::unique as private_name; private_name(); }
      fn other() { private_name(); }
      mod nested { use super::left::unique as local; fn run() { local(); super::right::same(); } }`,
    "native/src/left.rs": "pub fn same() {} pub fn unique() {}",
    "native/src/right.rs": "pub fn same() {} pub fn unique() {}",
    "ignored.txt": "fn should_not_be_indexed() {}",
  });
  expect(result.edges.some(e => e.confidence === "unresolved" && e.evidence[0]?.bindingName === "same")).toBe(true);
  expect(result.edges.filter(e => e.evidence[0]?.bindingName === "private_name").map(e => e.confidence)).toEqual(["resolved", "unresolved"]);
});

test("receiver parameters, shadowing, earlier/later lets, reassignment and nested-function observations preserve the accepted heuristic", async () => {
  const result = await equal({ "src/lib.rs": types + `
    fn run(p: A) {
      p.hit(); let p: B = B::make(); p.hit();
      x.hit(); let x: A = A::make(); x.hit();
      { let x: B = B::make(); x.hit(); }
      x.hit(); x = A::make(); x.hit(); let x = unknown(); x.hit();
      fn inner() { let y: B = B::make(); y.hit(); }
      y.hit(); let y: A = A::make(); y.hit();
    }` });
  const names = new Map(result.nodes.map(n => [n.id, n.metadata.ownerType]));
  const calls = (name: string) => result.edges.filter(e => e.evidence[0]?.bindingName === name).map(e => names.get(e.target) ?? e.confidence);
  // Compatibility assertions are deliberately the existing syntax heuristic,
  // not a new lexical/type/dataflow resolver: parameters win; reassignment and
  // uninferrable lets are ignored; the old function-subtree observation is retained.
  expect(calls("p.hit")).toEqual(["A", "A"]);
  expect(calls("x.hit")).toEqual(["unresolved", "A", "B", "B", "B", "B"]);
  expect(calls("y.hit")).toEqual(["B", "B", "A"]);
});

test("self, Self, explicit types, impl/trait ownership and static/instance ambiguity do not change confidence", async () => {
  const result = await equal({ "src/lib.rs": types + `
    trait Trait { fn hit(&self); fn default_body(&self) { self.hit(); Self::make(); } }
    impl Trait for A { fn hit(&self) { self.hit(); } }
    impl A { fn work(&self, value: &A) { self.hit(); Self::make(); value.hit();
      fn nested(value: B) { value.hit(); } }
      fn duplicate(&self) {} fn duplicate() {} }
    fn run() { let a: A = A::make(); a.duplicate(); A::duplicate(); }
  ` });
  expect(result.edges.filter(e => e.evidence[0]?.bindingName === "a.duplicate").map(e => e.confidence)).toEqual(["unresolved"]);
  expect(result.diagnostics.some(d => d.metadata.candidateCount === 2)).toBe(true);
  expect(result.nodes.some(n => n.metadata.traitOwner === "Trait" && n.kind === "method")).toBe(true);
});

test("Unicode, attributes, macros, nested blocks and recovery preserve complete anchors and serialization", async () => {
  const result = await equal({
    "src/日本語.rs": `// 🙂 π é\n${types}
      macro_rules! calls { ($x:expr) => { $x.hit(); } }
      #[first] #[second(value = "é")] fn café() { let 値: A = A::make(); 値.hit(); calls!(値); }
      mod 内部 { trait X { fn missing(&self); } fn broken( { let x: A = A::make(); x.hit(); }
      fn unfinished() { unknown!( { #[x] fn token() {} );` });
  expect(result.diagnostics.some(d => d.code === "rust-parser-error-node")).toBe(true);
  expect(result.nodes.filter(n => n.kind === "file").some(n => Array.isArray(n.metadata.macros) && n.metadata.macros.length > 0)).toBe(true);
});

test("receiver caches never cross source revisions or function owners and build observations at most once per function", async () => {
  for (const owner of ["A", "B"]) {
    const events: Array<Record<string, number>> = [];
    const detach = installAnalysisDiagnostics(e => { if (e.kind === "end" && e.phase === "rust-calls" && e.counts) events.push({ ...e.counts }); });
    try {
      await equal({ "src/lib.rs": types + `fn run() { let x: ${owner} = ${owner}::make(); ${"x.hit();".repeat(24)} }
        fn other() { let x: A = A::make(); x.hit(); }` });
    } finally { detach(); }
    expect(events.at(-1)).toMatchObject({ receiverFunctions: 2, receiverLookups: 25, receiverBindings: 2 });
  }
});

test("200 deterministic syntax/recovery cases match every ordered field of the frozen extractor", async () => {
  let seed = 0x6a12b;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 200; i++) {
    let source = types + `
      mod one { pub fn same() {} } mod two { pub fn same() {} }
      use one::same as outer;
      fn run(param: ${random(2) ? "A" : "B"}) {
        param.hit(); use two::same as scoped; scoped(); outer();
        let x: ${random(2) ? "A" : "B"} = A::make(); x.hit();
        { let x = ${random(2) ? "A" : "B"}::make(); x.hit(); }
        x.hit(); x = B::make(); x.hit(); let x = unknown(); x.hit();
        fn nested() { let x: B = B::make(); x.hit(); }
        one::same(); two::same(); same(); unknown!("🙂", x);
      }
      impl A { fn nested(&self) { self.hit(); Self::make(); } }
      trait T { fn required(&self); fn default_body(&self) { self.hit(); } }
    `;
    if (i % 3 === 0) { const start = random(source.length); source = source.slice(0, start) + source.slice(start + 1 + random(19)); }
    if (i % 5 === 0) source = source.slice(0, random(source.length));
    await equal({ "native/src/lib.rs": source, "native/src/extra.rs": `pub fn same() {} fn other(){ let x: A = A::make(); x.hit(); }` });
  }
}, 30000);
