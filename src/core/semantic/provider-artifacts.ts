import {prepareAuthorityMigration} from "./authority-migration.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { access, mkdir, realpath, lstat, writeFile, opendir, rm, open, unlink, rmdir } from "node:fs/promises";
import { boundedInput, digestFile } from "./inputs.js";
import { IndexLease } from "./maintenance-lock.js";
import { SemanticStore } from "./store.js";
import type { GarbageCollectionOptions } from "./gc.js";
import { recordedPath } from "./input-check.js";

const kinds = new Set(["rust", "python", "go", "java", "csharp", "scip"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const marker = ".prograph-provider.json";
type ArtifactFault = (point: "after-database" | "before-artifact-delete" | "during-artifact-delete" | "after-artifact-delete") => void;

async function syncFile(file: string): Promise<void> { const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); } }
export async function syncProviderArtifact(file: string): Promise<void> { await syncFile(file); await syncFile(path.dirname(file)); }

export async function createProviderWorkspace(index: string, repository: string, kind: string): Promise<string> {
  if (!kinds.has(kind)) throw Error("Unknown owned provider workspace kind");
  const directory = await realpath(index), root = await realpath(repository);
  if (kind !== "scip" && directory === root) throw Error("Managed compiler artifacts require a dedicated index directory, separate from the repository root");
  for (const parent of [path.join(directory, "providers"), path.join(directory, "providers", kind)]) {
    await mkdir(parent, { recursive: true }); const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw Error("Provider workspace parent must be an owned directory without aliases");
  }
  const id = randomUUID(), work = path.join(directory, "providers", kind, id);
  await mkdir(work, { mode: 0o700 });
  await writeFile(path.join(work, marker), JSON.stringify({ format: 1, artifactOwnership: 1, kind, id, index: directory, repository: root }), { flag: "wx", mode: 0o600 });
  await syncFile(path.join(work, marker));
  for (const parent of [work, path.dirname(work), path.dirname(path.dirname(work)), directory]) await syncFile(parent);
  return work;
}

/** Generic producer paths are commonly overwritten on the next export. Retain
 * verified bytes under an owned immutable execution directory before ingesting.
 * Caller holds index work throughout copy, ingestion and snapshot publication.
 */
export async function retainScipArtifact(index: string, repository: string, original: string, expected: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const work = await createProviderWorkspace(index, repository, "scip"), file = path.join(work, "index.scip"); let bytes = 0;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? Error("SCIP retained artifact exceeds byte quota") : null, chunk); } });
  await pipeline(createReadStream(original), bound, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
  if (await digestFile(file, maxBytes, signal) !== expected) throw Error("SCIP artifact changed while retaining evidence");
  await syncProviderArtifact(file);
  return file;
}

async function removeWorkspace(work: string, fault?: ArtifactFault): Promise<void> {
  // Preserve the ownership receipt through partial payload removal, so retrying
  // a permission/I/O failure cannot turn the remaining SDK copy into unowned data.
  const receipt = await boundedInput(path.join(work, marker), 8192);
  for await (const entry of await opendir(work)) if (entry.name !== marker) {
    await rm(path.join(work, entry.name), { recursive: true, force: false }); fault?.("during-artifact-delete");
  }
  await unlink(path.join(work, marker));
  try { await rmdir(work); }
  catch (error) { await writeFile(path.join(work, marker), receipt, { flag: "wx", mode: 0o600 }); throw error; }
}

/** Filesystem GC is separate from the semantic retention transaction and never
 * traverses SDK/source roots. Unmarked legacy/user directories are preserved.
 */
export async function collectIndexGarbage(filename: string, options: GarbageCollectionOptions & { fault?: ArtifactFault } = {}): Promise<Record<string, unknown>> {
  await access(filename); // Maintenance must never create a replacement semantic database.
  await prepareAuthorityMigration(path.dirname(filename),{storageOnly:true,semanticFile:path.basename(filename)});
  const directory = await realpath(path.dirname(filename)); const lease = new IndexLease(directory, "maintenance");
  let store: SemanticStore | undefined;
  try {
    store = new SemanticStore(filename, {}, lease);
    const collected = store.collectGarbage(options); options.fault?.("after-database");
    const providers = path.join(directory, "providers"), retained = new Set<string>(), roots = new Map<string, boolean>(), trees = new Set<string>(), catalogues = new Set<string>(); let visited = 0, resourceBytes = 0;
    let parent;
    try { parent = await lstat(providers); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { collected, active: store.activeSnapshot(), artifacts: { state: "complete", visitedResources: 0, retained: 0, deleted: 0, unowned: 0, failures: [] } }; throw error; }
    if (!parent.isDirectory() || parent.isSymbolicLink()) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Provider workspace root is not an owned directory" } };
    const owner = (file: string) => {
      const relative = path.relative(providers, file).split(path.sep); return relative.length >= 2 && kinds.has(relative[0]!) && uuid.test(relative[1]!) ? path.join(providers, relative[0]!, relative[1]!) : undefined;
    };
    // GC retained selected inputs and archived positive/selector support receipts.
    // Stream resources, not graph payloads or whole source files.
    const resources = store.sql(`WITH run_roots AS (
        SELECT run,MAX(substr(resource,13)) AS root,COUNT(*) AS n FROM sc_inputs WHERE resource LIKE 'source-root:%' GROUP BY run
      ), origin_roots AS (
        SELECT origin.id,MAX(substr(json_extract(input.value,'$.resource'),13)) AS root,COUNT(*) AS n
        FROM sc_origin_runs origin,json_each(origin.inputs_json) input WHERE json_extract(input.value,'$.resource') LIKE 'source-root:%' GROUP BY origin.id
      ), resources AS (
        SELECT i.resource,r.root,r.n FROM sc_inputs i LEFT JOIN run_roots r ON r.run=i.run
        UNION ALL SELECT json_extract(input.value,'$.resource') AS resource,r.root,r.n FROM sc_origin_runs origin
          LEFT JOIN origin_roots r ON r.id=origin.id,json_each(origin.inputs_json) input
      ) SELECT resource,root,n FROM resources WHERE resource LIKE 'artifact:%' OR resource LIKE 'physical:%' OR resource LIKE 'tree:%' OR resource LIKE 'probe-%' OR resource LIKE 'source:%'`);
    const mark = async (file: string, recursive = false, listing = false) => {
      if (!path.isAbsolute(file)) throw Error("Retained physical evidence requires an absolute resource path");
      const literal = owner(file); if (literal) retained.add(literal);
      if (recursive) trees.add(path.resolve(file)); if (listing) catalogues.add(path.resolve(file));
      // A source/SDK/probe alias may point into a different owned workspace.
      try { const resolved = await realpath(file), target = owner(resolved); if (target) retained.add(target); if (recursive) trees.add(resolved); if (listing) catalogues.add(resolved); }
      catch { /* Missing evidence never authorizes deletion of its literal owner. */ }
    };
    for (const input of resources.iterate() as Iterable<{ resource: string; root: string | null; n: number | null }>) {
      resourceBytes += Buffer.byteLength(input.resource);
      if (++visited > 1000000 || resourceBytes > 32 * 1024 ** 2) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Retained evidence resource budget exceeded; no workspace deleted" } };
      if (input.resource.startsWith("source:")) {
        if (input.n !== 1 || !input.root || !path.isAbsolute(input.root)) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Retained source has no unique root witness; no workspace deleted" } };
        if (!roots.has(input.root)) { try { roots.set(input.root, await realpath(input.root) === input.root); } catch { roots.set(input.root, false); } }
        if (!roots.get(input.root)) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Retained source root unavailable; no workspace deleted" } };
        await mark(path.resolve(input.root, input.resource.slice(7))); continue;
      }
      const file = input.resource.startsWith("probe-") ? recordedPath(input.resource) : input.resource.slice(input.resource.indexOf(":") + 1);
      if (!file) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Unknown retained filesystem probe; no workspace deleted" } };
      await mark(file, input.resource.startsWith("tree:"), input.resource.startsWith("probe-list:"));
    }
    const artifacts = { state: "complete", visitedResources: visited, retained: 0, deleted: 0, unowned: 0, failures: [] as Array<{ directory: string; reason: string }> };
    const candidates: string[] = []; let visitedEntries = 0, candidateBytes = 0;
    for (const kind of kinds) {
      const base = path.join(providers, kind); let entries;
      try { const info = await lstat(base); if (!info.isDirectory() || info.isSymbolicLink()) { artifacts.unowned++; continue; } entries = await opendir(base); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for await (const entry of entries) {
        if (++visitedEntries > 100000) return { collected, active: store.activeSnapshot(), artifacts: { ...artifacts, state: "deferred", reason: "Provider workspace catalogue exceeds GC budget; no workspace deleted" } };
        const work = path.join(base, entry.name);
        if (!entry.isDirectory() || !uuid.test(entry.name)) { artifacts.unowned++; continue; }
        if (retained.has(work)) { artifacts.retained++; continue; }
        let owned = false;
        try {
          const info = await lstat(path.join(work, marker));
          if (info.isFile() && !info.isSymbolicLink()) {
            const receipt = JSON.parse((await boundedInput(path.join(work, marker), 8192)).toString("utf8"));
            owned = receipt.format === 1 && receipt.artifactOwnership === 1 && receipt.index === directory && receipt.id === entry.name && receipt.kind === kind && typeof receipt.repository === "string" && path.isAbsolute(receipt.repository) && await realpath(work) === work;
          }
        } catch { /* An absent/malformed marker never authorizes deletion. */ }
        if (!owned) { artifacts.unowned++; continue; }
        candidateBytes += Buffer.byteLength(work); candidates.push(work);
        if (candidateBytes > 32 * 1024 ** 2) return { collected, active: store.activeSnapshot(), artifacts: { ...artifacts, state: "deferred", reason: "Owned workspace catalogue exceeds GC budget; no workspace deleted" } };
      }
    }
    const insideTree = (file: string) => { let current = file; while (true) { if (trees.has(current)) return true; const parent = path.dirname(current); if (parent === current) return false; current = parent; } };
    for (const work of candidates) {
      if (retained.has(work) || insideTree(work) || catalogues.has(path.dirname(work))) { artifacts.retained++; continue; }
      options.fault?.("before-artifact-delete");
      try { await removeWorkspace(work, options.fault); artifacts.deleted++; }
      catch { artifacts.failures.push({ directory: work, reason: "Owned workspace removal failed; retry maintenance" }); artifacts.state = "partial"; }
      options.fault?.("after-artifact-delete");
    }
    return { collected, active: store.activeSnapshot(), artifacts };
  } finally { try { store?.close(); } finally { lease.close(); } }
}
