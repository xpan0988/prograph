/** Explicit offline legacy rollback artifact; the source fact database is read-only. */
import path from "node:path";
import { mkdtemp, realpath, lstat, mkdir, open, readdir, rm, symlink, readlink } from "node:fs/promises";
import Database from "better-sqlite3";
import { IndexLease } from "./maintenance-lock.js";
import { readCompatibilitySnapshot } from "./compatibility-snapshot.js";
import { persistGraph } from "../storage/sqlite.js";
import { writePrettyJson } from "../storage/json-stream.js";
async function syncPath(file: string) {
  const handle = await open(file, "r"); try {
    await handle.sync();
  }
    finally {
    await handle.close();
  }
}
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      await syncTree(file);
    else if (entry.isFile())
      await syncPath(file);
    else
      throw Error("Unexpected export filesystem entry");
  }
  await syncPath(directory);
}
export async function exportCompatibilitySnapshot(index: string, destination: string, snapshot?: number) {
  if (process.platform === "win32")
    throw Error("Atomic compatibility directory publication is not qualified on Windows");
  const supplied=path.resolve(index),source=await realpath(supplied.endsWith(".sqlite")?path.dirname(supplied):supplied),sourceDatabase=path.join(source,supplied.endsWith(".sqlite")?path.basename(supplied):"semantic.sqlite"),requested=path.resolve(destination),parent=await realpath(path.dirname(requested)),target=path.join(parent,path.basename(requested));
  if (target === source || source.startsWith(`${target}${path.sep}`))
    throw Error("Compatibility export cannot replace its source index or an ancestor");
  try {
    await lstat(target);
    throw Error("Compatibility export destination already exists");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  }
  if (!(await lstat(sourceDatabase)).isFile())
    throw Error("A regular source Semantic Core database is required");
  const lease = new IndexLease(source, "work");
  let generation: string | undefined, published = false;
  try {
    const db = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
    let selected: ReturnType<typeof readCompatibilitySnapshot>, id: number;
    try {
      selected = db.transaction(() => {
        const active = db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as {
          value: string;
        } | undefined;
        id = snapshot ?? Number(active?.value);
        if (!Number.isSafeInteger(id) || id < 1)
          throw Error("A published semantic snapshot is required");
        return readCompatibilitySnapshot(db, id);
      }).deferred();
    }
    finally {
      db.close();
    }
    generation = await mkdtemp(path.join(parent, `.${path.basename(target)}.generation-`));
    await mkdir(path.join(generation, "exports"));
    // This artifact deliberately contains no Semantic Core database. Historical
    // native facts remain in the source index; rollback readers get schema 1.2.
    const manifest = { ...selected.manifest, semanticCore: { format: 2 as const, status: "unavailable" as const, durationMs: 0, reason: "Compatibility-only export; native semantic history remains in the source index" } };
    await persistGraph(generation, selected.graph, manifest, manifest.adapterRuns!);
    const check = new Database(path.join(generation, "graph.sqlite"));
    try {
      check.pragma("synchronous=FULL");
      check.pragma("wal_checkpoint(TRUNCATE)");
      if (check.pragma("integrity_check", { simple: true }) !== "ok" || (check.pragma("foreign_key_check") as unknown[]).length)
        throw Error("Compatibility export failed SQLite verification");
    }
    finally {
      check.close();
    }
    const receipt = {
      format: 1, kind: "semantic-compatibility-export", source, sourceDatabase, sourceSnapshot: id!, sourceReport: selected.reportKey, graphHash: selected.hash, ordering: selected.ordering, sourceManifest: selected.manifest,
      coverage: "Legacy compatibility projection only; native facts are not flattened into graph edges", publication: "durable generation + exclusive atomic directory symlink", work: selected.work
    };
    for (const [file, value] of Object.entries({ "manifest.json": manifest, "state.json": selected.state, "diagnostics.json": selected.graph.diagnostics, "exports/graph.json": selected.graph, "exports/semantic-compatibility.json": receipt })) {
      const handle = await open(path.join(generation, file), "wx");
      try { await writePrettyJson(handle, value); }
      finally { await handle.close(); }
    }
    await syncTree(generation);
    // symlink is exclusive (EEXIST), unlike rename over an existing empty folder.
    // Both paths have the same real parent. The complete directory becomes
    // visible at once; no old index/export is overwritten during publication.
    await symlink(path.basename(generation), target, "dir");
    published = true;
    await syncPath(parent);
    if (await readlink(target) !== path.basename(generation))
      throw Error("Compatibility export destination changed during publication");
    return { outputDirectory: target, storageDirectory: generation, snapshot: id!, graphHash: selected.hash, sourceReport: selected.reportKey, counts: { nodes: selected.graph.nodes.length, edges: selected.graph.edges.length, diagnostics: selected.graph.diagnostics.length }, work: selected.work };
  }
  catch (error) {
    // Once published, retain the complete generation even if the parent fsync or
    // final check fails. The caller must inspect it; cancellation is not rollback.
    if (generation && !published)
      await rm(generation, { recursive: true, force: true });
    throw error;
  }
  finally {
    lease.close();
  }
}
