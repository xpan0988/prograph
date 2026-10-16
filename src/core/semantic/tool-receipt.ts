import path from "node:path";
import { lstat, stat, realpath, readlink, readdir } from "node:fs/promises";
import { canonical, digest } from "./model.js";
import { digestFile } from "./inputs.js";

/** Retain the configured path rather than resolving away a mutable SDK alias. */
export async function toolInputResource(filename: string): Promise<string> {
  if (!path.isAbsolute(filename)) throw Error("Tool receipt requires an absolute path");
  return `${(await stat(filename)).isDirectory() ? "tree" : "physical"}:${filename}`;
}

/** A tool directory is immutable input, including bundled stubs, DLLs and SDK files, not just its launcher. */
export async function toolReceipt(filename: string, signal?: AbortSignal): Promise<{ sha256: string; inputs: Record<string, string>; bytes: number; files: number }> {
  if (!path.isAbsolute(filename)) throw Error("Tool receipt requires an absolute path");
  const root = await realpath(filename); const inputs: Record<string, string> = {}; const entries: unknown[] = []; let bytes = 0; let files = 0;
  const visit = async (file: string): Promise<void> => {
    signal?.throwIfAborted(); const info = await lstat(file); const relative = path.relative(root, file).split(path.sep).join("/");
    if (info.isSymbolicLink()) { const link = await readlink(file); let target: string; try { target = await realpath(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; target = path.resolve(path.dirname(file), link); } if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw Error(`Tool symlink escapes receipt root: ${file} -> ${target}`); entries.push([relative, "link", link]); return; }
    if (info.isDirectory()) { for (const child of (await readdir(file)).sort()) await visit(path.join(file, child)); return; }
    if (!info.isFile() || ++files > 40000 || (bytes += info.size) > 3 * 1024 ** 3) throw Error("Tool receipt exceeds 40000 files / 3 GiB");
    const hash = await digestFile(file, 512 * 1024 ** 2, signal); inputs[`physical:${file}`] = hash; entries.push([relative, hash]);
  };
  const info = await lstat(root); await visit(root);
  return { sha256: info.isFile() ? inputs[`physical:${root}`]! : digest(canonical(entries)), inputs, bytes, files };
}
