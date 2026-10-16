import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import Database from "better-sqlite3";
import { SemanticStore } from "../src/core/semantic/store.js";
import { IndexLease, withIndexWork } from "../src/core/semantic/maintenance-lock.js";
import { createProviderWorkspace, collectIndexGarbage } from "../src/core/semantic/provider-artifacts.js";
import { repositoryInputPaths, scanRepository } from "../src/core/repository/repository.js";
import type { FactInput } from "../src/core/semantic/model.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prograph-artifact-gc-"))); roots.push(root);
  const index = path.join(root, ".prograph"); await mkdir(index);
  const filename = path.join(index, "semantic.sqlite"); const store = new SemanticStore(filename); store.close();
  return { root, index, filename };
}
function run(s: SemanticStore, partition: string, inputs: string[], supports?: FactInput["supports"]) {
  s.addSymbol({ key: "symbol", name: "symbol", qualifiedName: "symbol", kind: "function", file: "a.ts", context: "ctx" });
  const occurrence = new SourceCoordinates("a.ts", "symbol").range(0, 6, "ctx", "definition"); s.addOccurrence(occurrence, 6);
  const id = s.begin(partition, "ctx", partition);
  const claim = s.batch(id, () => s.addFact(id, { predicate: "common.Definition", subject: "symbol", object: "symbol", occurrence: occurrence.key, value: { partition }, context: "ctx", confidence: "resolved", provenance: { provider: "fixture", version: "1", basis: "compiler", method: "gc", inputFingerprint: partition, context: "ctx" }, ...(supports ? { supports } : {}) }));
  for (const resource of inputs) s.input(id, resource, "digest"); s.seal(id, { status: "partial" }); return { id, claim };
}
async function workspace(index: string, root: string, kind = "python") { const work = await createProviderWorkspace(index, root, kind); await writeFile(path.join(work, "index.scip"), "evidence"); return work; }

test("maintenance excludes active staging and whole indexing jobs while independent writers can share work leases", async () => {
  const { index, filename } = await fixture(); const a = new SemanticStore(filename), b = new SemanticStore(filename);
  try {
    const staged = run(a, "staging", []);
    expect(() => a.collectGarbage({ keep: 1 })).toThrow("maintenance/index work");
    expect(a.sql("SELECT state FROM sc_runs WHERE id=?").get(staged.id)).toEqual({ state: "sealed" });
    await expect(collectIndexGarbage(filename)).rejects.toMatchObject({ code: "INDEX_MAINTENANCE_BUSY" });
    b.close(); a.publish([staged.id]);
    expect(() => a.db.transaction(() => a.collectGarbage())()).toThrow("staging transaction");
    expect(a.collectGarbage({ keep: 1 }).runs).toBe(0);
  } finally { a.close(); if (b.db.open) b.close(); }
  await withIndexWork(index, async () => {
    const transient = new SemanticStore(filename); transient.close();
    await Promise.resolve(); // The lease spans async preparation gaps between stores.
    await expect(collectIndexGarbage(filename)).rejects.toMatchObject({ code: "INDEX_MAINTENANCE_BUSY" });
  });
  await expect(collectIndexGarbage(filename)).resolves.toHaveProperty("artifacts.state", "complete");
});

test("cross-process indexing locks release after a killed worker without PID or heartbeat expiry", async () => {
  const { root, index, filename } = await fixture();
  const module = pathToFileURL(path.resolve("dist/core/semantic/provider-artifacts.js")).href, storeModule = pathToFileURL(path.resolve("dist/core/semantic/store.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {createProviderWorkspace} from ${JSON.stringify(module)}; import {SemanticStore} from ${JSON.stringify(storeModule)}; const store=new SemanticStore(process.argv[1]+'/semantic.sqlite'); const work=await createProviderWorkspace(process.argv[1],process.argv[2],'python'); const run=store.begin('abandoned','ctx','input'); store.input(run,'artifact:'+work+'/index.scip','digest'); console.log(work); setTimeout(()=>store.close(),10000);`, index, root], { stdio: ["ignore", "pipe", "pipe"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw Error("Lock child exited before readiness"); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Lock child readiness deadline")), 5000); })]);
    expect(() => new IndexLease(index, "maintenance")).toThrow("maintenance/index work");
    child.kill("SIGKILL"); await once(child, "exit");
    const result = await collectIndexGarbage(filename); expect(result).toHaveProperty("artifacts.state", "complete"); expect(result).toHaveProperty("artifacts.deleted", 1); expect(result).toHaveProperty("collected.runs", 1);
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } }
}, 15000);

test("exclusive maintenance rejects writers while an already pinned WAL reader retains its old snapshot", async () => {
  const { index, filename } = await fixture(); const s = new SemanticStore(filename); const old = run(s, "old", []); s.publish([old.id]); s.publish([]); s.close();
  const reader = new Database(filename, { readonly: true }); reader.exec("BEGIN"); expect(reader.prepare("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 2 });
  const lease = new IndexLease(index, "maintenance");
  try {
    expect(() => new SemanticStore(filename)).toThrow("maintenance/index work");
    const maintenance = new SemanticStore(filename, {}, lease); try { maintenance.collectGarbage({ keep: 1 }); } finally { maintenance.close(); }
    expect(reader.prepare("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 2 });
  } finally { lease.close(); reader.close(); }
  const after = new SemanticStore(filename); try { expect(after.sql("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 1 }); } finally { after.close(); }
});

test("artifact GC retains current and pinned evidence, sweeps only marked unreachable workspaces, and is idempotent", async () => {
  const { root, index, filename } = await fixture(); const old = await workspace(index, root), live = await workspace(index, root, "go"), abandoned = await workspace(index, root);
  const unknown = path.join(index, "providers/python/user-data"); await mkdir(unknown); await writeFile(path.join(unknown, "keep"), "user");
  const unmarked = await workspace(index, root); await rm(path.join(unmarked, ".prograph-provider.json"));
  const s = new SemanticStore(filename);
  let first: number;
  try { const a = run(s, "old", [`artifact:${old}/index.scip`]); first = s.publish([a.id]); s.pinSnapshot(first); const b = run(s, "live", [`artifact:${live}/index.scip`]); s.publish([b.id]); } finally { s.close(); }
  const collected = await collectIndexGarbage(filename, { keep: 1 }); expect(collected).toHaveProperty("artifacts.deleted", 1); expect(existsSync(abandoned)).toBe(false);
  for (const file of [old, live, unmarked, unknown]) expect(existsSync(file), file).toBe(true);
  const unpin = new SemanticStore(filename); unpin.unpinSnapshot(first!); unpin.close();
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.deleted", 1); expect(existsSync(old)).toBe(false); expect(existsSync(live)).toBe(true);
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.deleted", 0);
});

test("orphan positive and selector support receipts retain original provider artifacts until the final derived claim expires", async () => {
  const { root, index, filename } = await fixture(); const proof = await workspace(index, root), selector = await workspace(index, root, "rust"); const s = new SemanticStore(filename);
  try {
    const base = run(s, "base", [`artifact:${proof}/index.scip`]);
    const environment = s.begin("selector", "ctx", "selector"); s.input(environment, `artifact:${selector}/index.scip`, "digest"); s.selector(environment, "unique", "one"); s.seal(environment, {});
    const derived = run(s, "derived", [], [[{ claim: base.claim }], [{ selector: "unique", digest: "one" }]]);
    s.publish([base.id, environment, derived.id]); s.publish([derived.id]);
  } finally { s.close(); }
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.retained", 2);
  expect(existsSync(proof)).toBe(true); expect(existsSync(selector)).toBe(true);
  const after = new SemanticStore(filename);
  try { expect(after.sql("SELECT COUNT(*) AS n FROM sc_origin_runs").get()).toEqual({ n: 2 }); after.publish([]); } finally { after.close(); }
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.deleted", 2);
});

test("SDK aliases into retained workspaces survive; symlinks, malformed markers and legacy directories never authorize deletion", async () => {
  const { root, index, filename } = await fixture(); const sdk = await workspace(index, root, "java"), malformed = await workspace(index, root), outside = path.join(root, "sdk-outside"); await mkdir(outside); await writeFile(path.join(outside, "keep"), "sdk");
  const alias = path.join(root, "sdk-alias"); await symlink(sdk, alias, "dir");
  await writeFile(path.join(malformed, ".prograph-provider.json"), JSON.stringify({ format: 1, artifactOwnership: 1, index: "/different-root", id: path.basename(malformed), kind: "python" }));
  const link = path.join(index, "providers/python/00000000-0000-4000-8000-000000000000"); await symlink(outside, link, "dir");
  const legacy = path.join(index, "providers/python/legacy-build"); await mkdir(legacy);
  const s = new SemanticStore(filename); try { const live = run(s, "live", [`tree:${alias}`]); s.publish([live.id]); } finally { s.close(); }
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.retained", 1);
  for (const file of [sdk, malformed, link, legacy, outside]) expect(existsSync(file), file).toBe(true);
  expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("sdk");
});

test("interruption between database retention and artifact sweep is retryable and cannot remove retained evidence", async () => {
  for (const fault of ["after-database", "before-artifact-delete", "after-artifact-delete"] as const) {
    const { root, index, filename } = await fixture(); const live = await workspace(index, root), obsolete = await workspace(index, root);
    const s = new SemanticStore(filename); let snapshot: number;
    try { const r = run(s, "retained", [`artifact:${live}/index.scip`]); snapshot = s.publish([r.id]); } finally { s.close(); }
    await expect(collectIndexGarbage(filename, { keep: 1, fault: point => { if (point === fault) throw Error("simulated interruption"); } })).rejects.toThrow("simulated interruption");
    expect(existsSync(live)).toBe(true); await collectIndexGarbage(filename, { keep: 1 }); expect(existsSync(obsolete)).toBe(false);
    const checked = new SemanticStore(filename); try { expect(checked.activeSnapshot()).toBe(snapshot!); expect(checked.db.pragma("foreign_key_check")).toEqual([]); expect(checked.db.pragma("integrity_check", { simple: true })).toBe("ok"); } finally { checked.close(); }
  }
});

test("partial workspace removal preserves ownership for retry and artifact aliases retain their evidence", async () => {
  const { root, index, filename } = await fixture(); const obsolete = await workspace(index, root), live = await workspace(index, root);
  const alias = path.join(root, "artifact-alias.scip"); await symlink(path.join(live, "index.scip"), alias);
  const s = new SemanticStore(filename); try { const r = run(s, "alias", [`artifact:${alias}`]); s.publish([r.id]); } finally { s.close(); }
  const result = await collectIndexGarbage(filename, { keep: 1, fault: point => { if (point === "during-artifact-delete") throw Error("partial I/O failure"); } });
  expect(result).toHaveProperty("artifacts.state", "partial"); expect(existsSync(path.join(obsolete, ".prograph-provider.json"))).toBe(true); expect(existsSync(live)).toBe(true);
  await expect(collectIndexGarbage(filename, { keep: 1 })).resolves.toHaveProperty("artifacts.deleted", 1); expect(existsSync(obsolete)).toBe(false); expect(existsSync(live)).toBe(true);
});

test("custom index ancestors preserve source discovery; workspace roots and aliases fail safely and missing maintenance never creates an index", async () => {
  const { root, index } = await fixture(); await writeFile(path.join(root, "a.ts"), "export function a(){}\n");
  for (const output of [root, path.dirname(root), index]) {
    expect((await scanRepository(root, output)).snapshot.files).toContain("a.ts"); expect(await repositoryInputPaths(root, output, 100)).toContain("a.ts");
  }
  await expect(createProviderWorkspace(root, root, "python")).rejects.toThrow("dedicated index");
  const outside = path.join(root, "outside"); await mkdir(outside); await mkdir(path.join(index, "providers")); await symlink(outside, path.join(index, "providers/csharp"), "dir");
  await expect(createProviderWorkspace(index, root, "csharp")).rejects.toThrow("without aliases");
  const missing = path.join(root, "missing.sqlite"); await expect(collectIndexGarbage(missing)).rejects.toMatchObject({ code: "ENOENT" }); expect(existsSync(missing)).toBe(false);
});

test("CLI maintenance preserves pin/unpin and custom sqlite index contracts with additive artifact results", async () => {
  const { root, index, filename } = await fixture(); const s = new SemanticStore(filename); const original = run(s, "original", []); const first = s.publish([original.id]); s.close();
  const execute = promisify(execFile);
  const command = async (operation: string, flags: string[] = []) => JSON.parse((await execute(process.execPath, ["dist/cli/index.js", "semantic", operation, root, "--index", path.join(index, "graph.sqlite"), "--format", "json", ...flags], { timeout: 10000 })).stdout);
  expect(await command("pin", ["--snapshot", String(first)])).toMatchObject({ operation: "pin", snapshot: first });
  const next = new SemanticStore(filename); const active = next.publish([]); next.close();
  expect(await command("gc", ["--keep", "1"])).toMatchObject({ active, collected: { snapshots: 0 }, artifacts: { state: "complete" } });
  expect(await command("unpin", ["--snapshot", String(first)])).toMatchObject({ operation: "unpin", snapshot: first });
  expect(await command("gc", ["--keep", "1"])).toMatchObject({ active, collected: { snapshots: 1 }, artifacts: { state: "complete" } });
}, 30000);
