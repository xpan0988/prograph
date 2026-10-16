import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { canonical, digest } from "../src/core/semantic/model.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-incremental-")); roots.push(root); return root; }
function inspect(index: string) {
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try {
    const snapshot = store.activeSnapshot()!;
    const runs = store.sql("SELECT p.partition_key,p.run,r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE snapshot=? ORDER BY p.partition_key").all(snapshot) as Array<{ partition_key: string; run: number; coverage_json: string }>;
    const claims = store.sql("SELECT c.key,c.confidence,f.key AS fact,f.predicate FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE snapshot=? ORDER BY c.key").all(snapshot);
    const navigation = store.sql("SELECT n.relation,s.key AS subject,o.key AS object,x.key AS occurrence,c.key AS claim,n.confidence FROM sc_navigation n JOIN sc_entities s ON s.id=n.subject LEFT JOIN sc_entities o ON o.id=n.object LEFT JOIN sc_entities x ON x.id=n.occurrence JOIN sc_claims c ON c.id=n.claim WHERE snapshot=? ORDER BY relation,subject,object,occurrence,claim").all(snapshot);
    const coverage = runs.map(({ partition_key, coverage_json }) => ({ partition_key, coverage: JSON.parse(coverage_json) }));
    return { runs, data: { claims, navigation, coverage }, hash: digest(canonical({ claims, navigation, coverage })) };
  } finally { store.close(); }
}

test("compiler document ownership reuses unrelated outputs and invalidates unchanged callers after exported signature changes", async () => {
  const root = await fixture(); const index = path.join(root, ".prograph");
  await writeFile(path.join(root, "tsconfig.json"), '{"include":["*.ts"],"compilerOptions":{"strict":true}}');
  await writeFile(path.join(root, "a.ts"), "export function value(n:number):number{return n}\n");
  await writeFile(path.join(root, "b.ts"), "import {value} from './a'; export function call(){return value(1)}\n");
  await writeFile(path.join(root, "c.ts"), "export function independent(){return true}\n");
  await analyzeRepository(root); const before = inspect(index);
  await writeFile(path.join(root, "a.ts"), "export function value(n:number):string{return String(n)}\n");
  await syncRepository(root); const after = inspect(index);
  const id = (rows: typeof after.runs, file: string) => rows.find(row => row.partition_key.endsWith(`/document:${file}`))!.run;
  expect(id(after.runs, "c.ts")).toBe(id(before.runs, "c.ts"));
  expect(after.runs.find(row => row.partition_key === "analysis/source/file:c.ts")!.run).toBe(before.runs.find(row => row.partition_key === "analysis/source/file:c.ts")!.run);
  expect(after.runs.find(row => row.partition_key === "analysis/source")!.run).toBe(before.runs.find(row => row.partition_key === "analysis/source")!.run);
  expect(id(after.runs, "b.ts")).not.toBe(id(before.runs, "b.ts"));
  expect(id(after.runs, "a.ts")).not.toBe(id(before.runs, "a.ts"));
  const clean = await fixture(); await analyzeRepository(root, { output: clean }); expect(inspect(clean).hash).toBe(after.hash);
});

test("seeded source/config/negative selector edits agree with a clean compiler and pass rebuild", async () => {
  const root = await fixture(); const index = path.join(root, ".prograph"); const clean = await fixture();
  await mkdir(path.join(root, "feature"));
  await writeFile(path.join(root, "tsconfig.json"), '{"include":["**/*.ts"],"compilerOptions":{"strict":true}}');
  await writeFile(path.join(root, "feature/index.ts"), "export function value(){return 1}\n");
  await writeFile(path.join(root, "app.ts"), "import {value} from './feature'; export const run=()=>value();\n");
  let seed = 0x51a7e; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  await analyzeRepository(root);
  const edits: Array<() => Promise<void>> = [
    () => writeFile(path.join(root, "feature.ts"), "export function value(){return 'new module'}\n"),
    () => writeFile(path.join(root, "feature.ts"), "export function value(n?:number){return n ?? 'overload input'}\n"),
    () => rename(path.join(root, "feature.ts"), path.join(root, "renamed.ts")),
    () => rm(path.join(root, "renamed.ts")),
    () => writeFile(path.join(root, "tsconfig.json"), '{"include":["**/*.ts"],"compilerOptions":{"strict":false,"target":"ES2022"}}'),
    () => writeFile(path.join(root, "README.md"), "# app.ts task documentation\n"),
    () => writeFile(path.join(root, "feature/index.ts"), `export function value(){return ${random() % 100}}\n`),
  ];
  for (let i = 0; i < 12; i++) {
    await edits[i < edits.length ? i : random() % edits.length]!().catch(error => { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; });
    await syncRepository(root); const incremental = inspect(index);
    await rm(clean, { recursive: true, force: true }); await analyzeRepository(root, { output: clean });
    const rebuilt = inspect(clean);
    if (rebuilt.hash !== incremental.hash) {
      const differences = Object.fromEntries(Object.keys(rebuilt.data).map(key => {
        const field = key as keyof typeof rebuilt.data; const a = new Set(rebuilt.data[field].map(canonical)); const b = new Set(incremental.data[field].map(canonical));
        return [key, { cleanOnly: [...a].filter(x => !b.has(x)).slice(0, 2), incrementalOnly: [...b].filter(x => !a.has(x)).slice(0, 2) }];
      }));
      throw Error(`edit ${i}, seed ${seed}: ${JSON.stringify(differences)}`);
    }
  }
}, 120000);
