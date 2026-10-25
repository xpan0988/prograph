import { expect, test } from "vitest";
import { readFile, cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { SemanticStore } from "../src/core/semantic/store.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";

async function accepted() {
  const root = process.env.PROGRAPH_TEST_ENCODING_REUSE_BASELINE_RUNTIME;
  if (!root) throw Error("Set PROGRAPH_TEST_ENCODING_REUSE_BASELINE_RUNTIME using prepare-semantic-baseline.mjs encoding-reuse");
  expect(JSON.parse(await readFile(path.join(root, "baseline-receipt.json"), "utf8")).commit).toBe("0e668fb08f9d8046d5c730848b2c2fc7d7cdaf05");
  return { root, Store: (await import(/* @vite-ignore */ pathToFileURL(path.join(root, "dist/core/semantic/store.js")).href)).SemanticStore };
}
const provenance = () => ({ provider: "oracle", version: "1", basis: "syntax" as const, method: "fixture", context: "c", inputFingerprint: "f" });

test("accepted Stage 6.5 store agrees on complete stable rows and callback/error ordering through mutations, rollback and retry", async () => {
  const { Store } = await accepted();
  const run = (Constructor: typeof SemanticStore, variant: string) => {
    const store = new Constructor(":memory:"), id = store.begin("fixture", "c", "f"), log: string[] = [];
    const p = provenance(); let reads = 0, fail = true;
    const fact = { predicate: "source.File" as const, context: "c", subject: "subject", value: { text: "界🚀" }, confidence: "exact" as const, provenance: p };
    if (variant === "fact-getter") Object.defineProperty(fact, "provenance", { get() { log.push(`provenance:${++reads}`); return { ...p, method: String(reads) }; } });
    if (variant === "nested-getter") Object.defineProperty(p, "extra", { enumerable: true, get() { log.push(`extra:${++reads}`); return { value: reads }; } });
    if (variant === "proxy") fact.provenance = new Proxy(p, { get(target, key) { log.push(`get:${String(key)}`); return Reflect.get(target, key); }, ownKeys(target) { log.push("keys"); return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { log.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); } });
    if (variant === "unsupported") Object.assign(p, { extra: [1, undefined] });
    if (variant === "sql-before") { store.db.function("observe", () => { log.push("before-provenance"); p.method = "mutated by SQL"; return 1; }); store.db.exec("CREATE TRIGGER observe_fact AFTER INSERT ON sc_facts BEGIN SELECT observe(); END"); }
    if (variant === "sql-after") { store.db.function("observe", () => { log.push("after-provenance"); if (fail) throw Error("injected SQL failure"); return 1; }); store.db.exec("CREATE TRIGGER observe_provenance BEFORE INSERT ON sc_provenance BEGIN SELECT observe(); END"); }
    const dump = () => Object.fromEntries((store.sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => {
      const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
      const columns = (store.sql(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(c => c.name).filter(column => !(name === "sc_runs" && column === "created_at")); // existing genuine clock exception only
      return [name, store.sql(`SELECT ${columns.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${columns.map(quote).join(",")}`).all()];
    }));
    try {
      store.addEntity("subject", "artifact", { key: "subject" }); const results = [];
      for (let step = 0; step < 3; step++) {
        if (step === 1) { fail = false; p.method = "retry/mutation"; }
        if (step === 2) fact.value.text = "independent fact";
        try { results.push({ claim: store.batch(id, () => store.addFact(id, fact)), log: [...log], rows: dump() }); }
        catch (error) { results.push({ error: [(error as Error).name, (error as Error).message], log: [...log], rows: dump() }); }
      }
      return results;
    } finally { store.close(); }
  };
  for (const variant of ["plain", "fact-getter", "nested-getter", "proxy", "unsupported", "sql-before", "sql-after"]) expect(run(SemanticStore, variant)).toEqual(run(Store, variant));
});

test("bounded provenance reuse preserves accepted Stage 6.5 complete exports, SQL, history and independent incremental rebuilds", async () => {
  const { root: runtime } = await accepted();
  const oldAnalyze = (await import(/* @vite-ignore */ pathToFileURL(path.join(runtime, "dist/core/analysis/analyze.js")).href)).analyzeRepository;
  const oldSync = (await import(/* @vite-ignore */ pathToFileURL(path.join(runtime, "dist/core/analysis/sync.js")).href)).syncRepository;
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-encoding-runtime-")), source = path.join(root, "source"), old = path.join(root, "old"), current = path.join(root, "current"), rebuilt = path.join(root, "rebuilt");
  const history = (directory: string) => { const store = new SemanticStore(path.join(directory, "semantic.sqlite")); try { return store.sql("SELECT c.key,c.confidence,f.predicate,f.value_json FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE snapshot=1 ORDER BY c.key").all(); } finally { store.close(); } };
  const compare = async (name: string) => {
    for (const file of ["exports/graph.json", "diagnostics.json"]) expect(await readFile(path.join(current, file))).toEqual(await readFile(path.join(old, file)));
    const receipt = path.join(root, name + ".json");
    await promisify(execFile)(process.execPath, ["scripts/semantic-owned-witness.mjs", old, current, receipt]);
    const data = JSON.parse(await readFile(receipt, "utf8"));
    expect(data.databases["semantic.sqlite"].tables.sc_runs.equal).toBe(true);
    expect(data.databases["semantic.sqlite"].tables.sc_supports.equal).toBe(true);
    expect(data.databases["graph.sqlite"].tables.q_meta.equal).toBe(false);
  };
  try {
    await cp(path.resolve("tests/fixtures/mixed"), source, { recursive: true });
    const expected = await oldAnalyze(source, { output: old }); const actual = await analyzeRepository(source, { output: current });
    expect(actual.graph).toEqual(expected.graph); await compare("fresh");
    const previous = history(old); expect(history(current)).toEqual(previous);
    for (const directory of [old, current]) { const store = new SemanticStore(path.join(directory, "semantic.sqlite")); try { store.pinSnapshot(1, "encoding-reuse-history"); } finally { store.close(); } }
    await writeFile(path.join(source, "README.md"), "# Changed 函数 🚀\nThe `greet` implementation changed.\n");
    await oldSync(source, old); await syncRepository(source, current); await compare("incremental");
    expect(history(old)).toEqual(previous); expect(history(current)).toEqual(previous);
    await analyzeRepository(source, { output: rebuilt }); expect(await semanticSnapshot(current)).toEqual(await semanticSnapshot(rebuilt));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
