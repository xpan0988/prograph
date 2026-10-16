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
  const directory = await realpath(path.dirname(filename)); const lease = new IndexLease(directory, "maintenance");
  let store: SemanticStore | undefined;
  try {
    store = new SemanticStore(filename, {}, lease);
    const collected = store.collectGarbage(options); options.fault?.("after-database");
    const providers = path.join(directory, "providers"), retained = new Set<string>(); let visited = 0;
    const owner = (file: string) => {
      const relative = path.relative(providers, file).split(path.sep); return relative.length >= 2 && kinds.has(relative[0]!) && uuid.test(relative[1]!) ? path.join(providers, relative[0]!, relative[1]!) : undefined;
    };
    // GC retained selected inputs and archived positive/selector support receipts.
    // Stream resources, not graph payloads or whole source files.
    const resources = store.sql(`SELECT resource FROM sc_inputs WHERE resource LIKE 'artifact:%' OR resource LIKE 'physical:%' OR resource LIKE 'tree:%'
      UNION ALL SELECT json_extract(input.value,'$.resource') AS resource FROM sc_origin_runs origin,json_each(origin.inputs_json) input
      WHERE resource LIKE 'artifact:%' OR resource LIKE 'physical:%' OR resource LIKE 'tree:%'`);
    for (const input of resources.iterate() as Iterable<{ resource: string }>) {
      if (++visited > 1000000) return { collected, active: store.activeSnapshot(), artifacts: { state: "deferred", reason: "Retained evidence resource budget exceeded; no workspace deleted" } };
      const file = input.resource.slice(input.resource.indexOf(":") + 1); const literal = owner(file); if (literal) retained.add(literal);
      // Configured SDK/artifact aliases outside the index may point into a workspace.
      if (!literal) { try { const target = owner(await realpath(file)); if (target) retained.add(target); } catch { /* Missing external evidence is not GC permission. */ } }
    }
    const artifacts = { state: "complete", visitedResources: visited, retained: 0, deleted: 0, unowned: 0, failures: [] as Array<{ directory: string; reason: string }> };
    let parent;
    try { parent = await lstat(providers); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { collected, active: store.activeSnapshot(), artifacts }; throw error; }
    if (!parent.isDirectory() || parent.isSymbolicLink()) return { collected, active: store.activeSnapshot(), artifacts: { ...artifacts, state: "deferred", reason: "Provider workspace root is not an owned directory" } };
    let visitedEntries = 0;
    for (const kind of kinds) {
      const base = path.join(providers, kind); let entries;
      try { const info = await lstat(base); if (!info.isDirectory() || info.isSymbolicLink()) { artifacts.unowned++; continue; } entries = await opendir(base); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for await (const entry of entries) {
        if (++visitedEntries > 100000) return { collected, active: store.activeSnapshot(), artifacts: { ...artifacts, state: "partial", reason: "Provider workspace catalogue exceeds GC budget; retry maintenance" } };
        const work = path.join(base, entry.name);
        if (!entry.isDirectory() || !uuid.test(entry.name)) { artifacts.unowned++; continue; }
        if (retained.has(work)) { artifacts.retained++; continue; }
        let owned = false;
        try {
          const info = await lstat(path.join(work, marker));
          if (info.isFile() && !info.isSymbolicLink()) {
            const receipt = JSON.parse((await boundedInput(path.join(work, marker), 8192)).toString("utf8"));
            owned = receipt.format === 1 && receipt.artifactOwnership === 1 && receipt.index === directory && receipt.id === entry.name && receipt.kind === kind && await realpath(work) === work;
          }
        } catch { /* An absent/malformed marker never authorizes deletion. */ }
        if (!owned) { artifacts.unowned++; continue; }
        options.fault?.("before-artifact-delete");
        try { await removeWorkspace(work, options.fault); artifacts.deleted++; }
        catch { artifacts.failures.push({ directory: work, reason: "Owned workspace removal failed; retry maintenance" }); artifacts.state = "partial"; }
        options.fault?.("after-artifact-delete");
      }
    }
    return { collected, active: store.activeSnapshot(), artifacts };
  } finally { try { store?.close(); } finally { lease.close(); } }
}
