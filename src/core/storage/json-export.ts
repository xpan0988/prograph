/** Legacy export files only. Semantic Core publication has its own protocol. */
import path from "node:path";
import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, realpath, readlink, open, rename, link, unlink } from "node:fs/promises";
import { writePrettyJson, type JsonWriteStats } from "./json-stream.js";

type Witness = { file: string; stat: Stats | undefined; link?: string };
function same(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
    && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function optionalStat(file: string) {
  try { return await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
async function destination(supplied: string) {
  let file = path.resolve(supplied);
  const witnesses: Witness[] = [], parents: { supplied: string; real: string }[] = [];
  for (let depth = 0; depth < 40; depth++) {
    const suppliedParent = path.dirname(file), parent = await realpath(suppliedParent);
    parents.push({ supplied: suppliedParent, real: parent });
    witnesses.push({ file: parent, stat: await lstat(parent) });
    file = path.join(parent, path.basename(file));
    const stat = await optionalStat(file);
    if (stat?.isSymbolicLink()) {
      const target = await readlink(file);
      witnesses.push({ file, stat, link: target }); file = path.resolve(parent, target); continue;
    }
    if (stat && (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7000)))
      throw Error("Atomic JSON export requires an ordinary file with one link and no special mode bits");
    witnesses.push({ file, stat });
    if (stat) {
      // Check actual write permission without truncating the accepted output.
      const handle = await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try { if (!same(stat, await handle.stat())) throw Error("JSON export destination changed"); }
      finally { await handle.close(); }
    }
    return { file, parent, stat, async verify() {
      for (const p of parents) if (await realpath(p.supplied) !== p.real) throw Error("JSON export parent changed");
      for (const witness of witnesses) {
        const current = await optionalStat(witness.file);
        // Directory contents necessarily change when creating our temporary file.
        const matches = witness.stat?.isDirectory()
          ? current?.isDirectory() && current.dev === witness.stat.dev && current.ino === witness.stat.ino
          : witness.stat ? current && same(witness.stat, current) : !current;
        if (!matches || (witness.link !== undefined && await readlink(witness.file) !== witness.link))
          throw Error("JSON export destination changed");
      }
    } };
  }
  throw Error("Too many symlinks in JSON export destination");
}

/** Publish one complete file. Independent exports are deliberately not a transaction.
 * Random exclusive siblings are never reused. SIGKILL can leave a private stale
 * sibling, which a subsequent run ignores. IndexLease serializes our own writers;
 * the final checks do not promise CAS against hostile concurrent filesystem edits.
 */
export async function writeJsonAtomic(file: string, value: unknown, signal?: AbortSignal): Promise<JsonWriteStats> {
  signal?.throwIfAborted();
  const target = await destination(file);
  const temporary = path.join(target.parent, `.${path.basename(target.file)}.prograph-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false, temporaryExists = true;
  try {
    const stats = await writePrettyJson(handle, value, signal);
    if (target.stat) {
      const created = await handle.stat();
      if (created.uid !== target.stat.uid || created.gid !== target.stat.gid) await handle.chown(target.stat.uid, target.stat.gid);
    }
    await handle.chmod(target.stat ? target.stat.mode & 0o777 : 0o666 & ~process.umask());
    await handle.sync(); await handle.close(); closed = true;
    await target.verify(); signal?.throwIfAborted();
    if (target.stat) await rename(temporary, target.file);
    else {
      // Refuse a new destination installed by another writer after validation.
      await link(temporary, target.file); await unlink(temporary);
    }
    temporaryExists = false;
    if (process.platform !== "win32") {
      const parent = await open(target.parent, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return stats;
  } finally {
    try { if (!closed) await handle.close(); }
    finally { if (temporaryExists) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}

/** Bound serialization residency across files as well as within each file. */
export async function writeJsonExports(directory: string, values: { graph: unknown; manifest: unknown; diagnostics: unknown; state: unknown }) {
  const stats: Record<string, JsonWriteStats> = {};
  for (const [name, value] of [["exports/graph.json", values.graph], ["manifest.json", values.manifest], ["diagnostics.json", values.diagnostics], ["state.json", values.state]] as const)
    stats[name] = await writeJsonAtomic(path.join(directory, name), value);
  return stats;
}
