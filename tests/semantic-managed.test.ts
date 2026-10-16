import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexManagedProject, toolReceipt, type ManagedProject } from "../src/core/semantic/managed-scip.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { digest } from "../src/core/semantic/model.js";
import { python066Symbol, javac0131Offset, javac0131Range } from "../src/core/semantic/scip-dialects.js";
import { parseScipSymbol } from "../src/core/semantic/scip-symbol.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";
import { scanRepository } from "../src/core/repository/repository.js";
import { recordedInputStatus, semanticInventory, retainProviders } from "../src/core/semantic/provider-runs.js";
import { MANAGED_SCIP_VERSION, SCIP_SEMANTIC_VERSION } from "../src/core/semantic/model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-managed-")); roots.push(root); return root; }
test("qualified producer dialects preserve opaque local IDs and map javac tabs without clamping", () => {
  expect(() => parseScipSymbol("local 28(s)")).toThrow(); expect(python066Symbol("local 28(s)")).toEqual({ raw: "local 28(s)", local: true, name: "local 28(s)" });
  expect(() => python066Symbol("local broken(x y)")).toThrow();
  const source = new SourceCoordinates("A.java", "\t🚀a\tcall()\r\n\tend", true);
  expect(javac0131Offset(source, 0, 8, 2)).toBe(1); expect(javac0131Offset(source, 0, 10, 2)).toBe(3);
  expect(javac0131Offset(source, 0, 16, 2)).toBe(5); expect(javac0131Offset(source, 1, 8, 2)).toBe(14);
  for (const column of [1, 7, 9, 12, 100]) expect(() => javac0131Offset(source, 0, column, 2)).toThrow();
  expect(javac0131Range(source, [0, 9, 0, 13], 2)).toEqual([5, 9]);
});
test("tool receipts capture directory membership, content and internal links; escapes are rejected", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a"), "one"); const first = await toolReceipt(root);
  await writeFile(path.join(root, "b"), "two"); expect((await toolReceipt(root)).sha256).not.toBe(first.sha256);
  await symlink("a", path.join(root, "link")); const linked = await toolReceipt(root); expect(linked.files).toBe(2);
  await writeFile(path.join(root, "a"), "new"); expect((await toolReceipt(root)).sha256).not.toBe(linked.sha256);
  await symlink(os.tmpdir(), path.join(root, "escape")); await expect(toolReceipt(root)).rejects.toThrow("escapes");
});
test("recorded SDK membership invalidates retained provider groups on added stubs without a source edit", async () => {
  const root = await temporary(); const sdk = await temporary();
  await writeFile(path.join(root, "a.py"), "pass\n"); await writeFile(path.join(sdk, "stub.pyi"), "class A: ...\n");
  const snapshot = (await scanRepository(root)).snapshot;
  const store = new SemanticStore(path.join(root, "semantic.sqlite"));
  try {
    const run = store.begin("scip/managed-test/index", "ctx", "input");
    store.input(run, `tree:${sdk}`, (await toolReceipt(sdk)).sha256); store.input(run, "project-inventory", semanticInventory(snapshot));
    store.seal(run, { mappingVersion: SCIP_SEMANTIC_VERSION, executionVersion: MANAGED_SCIP_VERSION }); const parent = store.publish([run]);
    expect(await retainProviders(store, snapshot, parent)).toEqual([run]);
    expect(await recordedInputStatus(store.filename, snapshot, new Set())).toMatchObject({ state: "checked-recorded", additionalChanges: 0 });
    await writeFile(path.join(sdk, "new.pyi"), "class B: ...\n");
    expect(await recordedInputStatus(store.filename, snapshot, new Set())).toMatchObject({ state: "changed", additionalChanges: 1 });
    expect(await retainProviders(store, snapshot, parent)).toEqual([]);
  } finally { store.close(); }
});
test("managed contexts reject unpinned tools before executing repository code", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a.py"), "raise RuntimeError('must not execute')\n");
  await writeFile(path.join(root, "context.json"), JSON.stringify({ format: 1, id: "test", language: "python", root: ".", package: { name: "test", version: "1" }, runtime: { path: process.execPath, sha256: "0".repeat(64) } }));
  await expect(indexManagedProject(root, "context.json")).rejects.toThrow("receipt mismatch");
  const store = new SemanticStore(path.join(root, ".prograph/semantic.sqlite")); expect(store.activeSnapshot()).toBeUndefined(); store.close();
});
const profilesFile = process.env.PROGRAPH_TEST_MANAGED_PROFILES;
const fixtures = {
  python: {
    "pkg/__init__.py": "",
    "pkg/api.py": "from typing import Protocol, TypeVar\nT = TypeVar('T')\nclass Reader(Protocol):\n def read(self) -> int: ...\ndef add(a: int,b: int)->int: return a+b\ndef identity(v:T)->T: return v\n",
    "pkg/use.py": "from .api import add, identity\ndef run()->int:\n emoji='🚀'; return identity(add(1,2))\nlocal = lambda s: s\n",
    "trap.py": "raise RuntimeError('source execution forbidden')\n",
    "pyproject.toml": "[project]\nname='prograph-probe'\nversion='0.1.0'\n",
  },
  go: {
    "go.mod": "module example.org/prographprobe\ngo 1.26.0\n",
    "lib/add.go": "package lib\nfunc Add(a,b int)int{return a+b}\nfunc Identity[T any](v T)T{return v}\ntype Reader interface{ Read() int }\ntype Value struct{}\nfunc(Value)Read()int{return 1}\n",
    "main.go": "package probe\nimport \"example.org/prographprobe/lib\"\nfunc Run()int{s:=\"🚀\";_=s;return lib.Identity[int](lib.Add(1,2))}\nfunc init(){panic(\"source execution forbidden\")}\n",
  },
  java: {
    "@Argument.java": "package sample; class PassiveArgument {}\n",
    "Foo.java": "package sample;\nimport java.util.List;\n@Deprecated public class Foo<T> implements Comparable<Foo<T>> {\n List<T> values;\n public static int add(int a,int b){return a+b;}\n public static String add(String a,String b){return a+b;}\n\t public static int run(){String emoji=\"🚀\";return add(1,2);}\n public int compareTo(Foo<T> other){return 0;}\n}\n",
    "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>probe</artifactId><version>1</version></project>",
  },
  csharp: {
    "literal$([System.IO.Directory]::CreateDirectory('unwanted')).cs": "namespace Sample; internal class LiteralName {}\n",
    "Probe.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><Target Name="Forbidden" BeforeTargets="Build"><Error Text="original build must not execute" /></Target></Project>',
    "Foo.cs": "using System.Collections.Generic;\nnamespace Sample;\n[System.Obsolete] public class Foo<T>: System.IComparable<Foo<T>> {\n List<T> values;\n public static int Add(int a,int b)=>a+b;\n public static string Add(string a,string b)=>a+b;\n public static int Run(){string emoji=\"🚀\";return Add(1,2);}\n public int CompareTo(Foo<T> other)=>0;\n}\n",
  },
};
for (const language of ["python", "go", "java", "csharp"] as const) test.skipIf(!profilesFile)(`real ${language} producer qualifies definitions, references, imports/types and owned declared calls`, async () => {
  const profiles = JSON.parse(await readFile(profilesFile!, "utf8")) as Record<string, ManagedProject>;
  const root = await temporary(); const index = await temporary();
  for (const [file, text] of Object.entries(fixtures[language])) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  const config = { ...profiles[language]!, id: `qualified-${language}` };
  if (language === "csharp") config.csharp!.projects[0]!.sources.push("literal$([System.IO.Directory]::CreateDirectory('unwanted')).cs");
  await writeFile(path.join(root, "context.json"), JSON.stringify(config));
  const result = await indexManagedProject(root, "context.json", index);
  expect(result).toMatchObject({ rejected: 0, calls: "partial-declared-static-targets", capabilities: { dynamicDispatch: "unsupported" } });
  expect(Number(result.accepted)).toBeGreaterThan(0);
  if (language === "csharp") await expect(stat(path.join(String(result.executionDirectory), "source", "unwanted"))).rejects.toMatchObject({ code: "ENOENT" });
  const q = new SemanticQuery(path.join(index, "semantic.sqlite"));
  try {
    const name = ["go", "csharp"].includes(language) ? "Add" : "add";
    const found = q.execute("find", name).items as Array<{ key: string }>;
    expect(found.length).toBe(["java", "csharp"].includes(language) ? 2 : 1);
    expect(found.every(item => !String((item as { file?: string }).file).startsWith("<"))).toBe(true);
    const called = found.find(item => (q.execute("callers", item.key).items as unknown[]).length);
    expect(called, JSON.stringify(result)).toBeDefined();
    if (["java", "csharp"].includes(language)) expect((called as { qualifiedName?: string }).qualifiedName ?? JSON.stringify(called)).not.toContain("(+1)");
    expect(q.execute("definition", called!.key).items.length).toBeGreaterThan(0);
    expect(q.execute("references", called!.key).items.length).toBeGreaterThan(0);
    expect(q.execute("native", called!.key).items.length).toBeGreaterThan(0);
    const run = (q.execute("find", ["go", "csharp"].includes(language) ? "Run" : "run").items as Array<{ key: string }>)[0]!;
    const callees = q.execute("callees", run.key).items as Array<{ key: string }>;
    expect(callees.length).toBe(["python", "go"].includes(language) ? 2 : 1);
    expect(q.execute("context", called!.key).items).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ execution: expect.objectContaining({ version: MANAGED_SCIP_VERSION }) }) })]));
  } finally { q.close(); }
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try {
    expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]);
    const rows = store.db.prepare("SELECT r.partition_key,r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND r.partition_key LIKE '%/pass:%'").all(store.activeSnapshot()) as Array<{ partition_key: string; coverage_json: string }>;
    expect(rows.some(row => row.partition_key.endsWith("/pass:scip-native@1"))).toBe(true);
    expect(rows.every(row => JSON.parse(row.coverage_json).ownershipShard)).toBe(true);
    const calls = store.db.prepare("SELECT COUNT(*) AS n FROM sc_navigation WHERE snapshot=? AND relation='calls'").get(store.activeSnapshot()) as { n: number }; expect(calls.n).toBeGreaterThan(0);
    const imports = store.db.prepare("SELECT COUNT(*) AS n FROM sc_navigation WHERE snapshot=? AND relation='import'").get(store.activeSnapshot()) as { n: number }; expect(imports.n).toBeGreaterThan(0);
    const roles = store.db.prepare("SELECT COUNT(*) AS n FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE a.snapshot=? AND f.predicate='scip.SourceRole'").get(store.activeSnapshot()) as { n: number }; expect(roles.n).toBeGreaterThan(0);
  } finally { store.close(); }
  for (const [file, text] of Object.entries(fixtures[language])) expect(digest(await readFile(path.join(root, file)))).toBe(digest(text));
  const beforeReuse = new SemanticStore(path.join(index, "semantic.sqlite"));
  const retained = beforeReuse.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key NOT LIKE '%/index' ORDER BY partition_key").all(beforeReuse.activeSnapshot()); beforeReuse.close();
  const repeated = await indexManagedProject(root, "context.json", index);
  expect(repeated).toMatchObject({ accepted: result.accepted, reusedDocuments: result.accepted });
  const afterReuse = new SemanticStore(path.join(index, "semantic.sqlite"));
  try { expect(afterReuse.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key NOT LIKE '%/index' ORDER BY partition_key").all(afterReuse.activeSnapshot())).toEqual(retained); } finally { afterReuse.close(); }
}, 600000);
