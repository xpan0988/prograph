import path from "node:path";
import os from "node:os";
import { stat, readdir, realpath, readFile } from "node:fs/promises";
import { canonical, digest } from "./model.js";
import { digestFile } from "./inputs.js";
import { toolReceipt } from "./tool-receipt.js";
import { readProGraphConfiguration } from "../config/config.js";

export interface RecordedInput { resource: string; digest: string }
export function recordedPath(resource: string): string | undefined {
  if (resource.startsWith("probe-read:")) return (JSON.parse(resource.slice(11)) as [string, string])[0];
  for (const prefix of ["probe-file:", "probe-dir:", "probe-present:", "probe-realpath:", "probe-list:"]) if (resource.startsWith(prefix)) return resource.slice(prefix.length);
  return undefined;
}
export const missingInput = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
export function directoryFingerprint(entries: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }>): string {
  if (entries.length > 100000) throw Error("Compiler directory input exceeds entry budget");
  return digest(canonical(entries.map(entry => [path.basename(entry.name), entry.isFile, entry.isDirectory, entry.isSymlink]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));
}

/** Recheck observed compiler searches, including absence and alias paths. Undefined is a non-filesystem input. */
export async function recordedDigest(resource: string, root: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (resource === "configuration:prograph") return (await readProGraphConfiguration(root)).fingerprint;
  if (resource === "environment:cwd") return digest(path.resolve(process.cwd()));
  if (resource === "environment:host") return digest(canonical([process.platform, process.arch, os.machine(), os.release(), [...new Set(os.cpus().map(cpu => cpu.model))].sort()]));
  if (resource.startsWith("source:")) return digestFile(path.join(root, resource.slice(7)), undefined, signal);
  if (resource.startsWith("physical:") || resource.startsWith("artifact:")) return digestFile(resource.slice(9), undefined, signal);
  if (resource.startsWith("tree:")) return (await toolReceipt(resource.slice(5), signal)).sha256;
  if (resource.startsWith("probe-file:") || resource.startsWith("probe-dir:") || resource.startsWith("probe-present:")) {
    try { const info = await stat(resource.slice(resource.indexOf(":") + 1)); return digest(String(resource.startsWith("probe-present:") || (resource.startsWith("probe-file:") ? info.isFile() : info.isDirectory()))); }
    catch (error) { if (missingInput(error)) return digest("false"); throw error; }
  }
  if (resource.startsWith("probe-realpath:")) return digest(await realpath(resource.slice(15)));
  if (resource.startsWith("probe-read:")) {
    const [file, encoding] = JSON.parse(resource.slice(11)) as [string, BufferEncoding];
    const info = await stat(file); if (!info.isFile() || info.size > 32 * 1024 ** 2) throw Error("Compiler file input exceeds byte budget");
    return digest(await readFile(file, encoding));
  }
  if (resource.startsWith("probe-list:")) {
    const directory = resource.slice(11); const children = await readdir(directory, { withFileTypes: true });
    if (children.length > 100000) throw Error("Compiler directory input exceeds entry budget");
    const entries = [];
    for (const child of children) {
      let isFile = child.isFile(), isDirectory = child.isDirectory();
      if (child.isSymbolicLink()) { try { const info = await stat(path.join(directory, child.name)); isFile = info.isFile(); isDirectory = info.isDirectory(); } catch (error) { if (!missingInput(error)) throw error; } }
      entries.push({ name: child.name, isFile, isDirectory, isSymlink: child.isSymbolicLink() });
    }
    return directoryFingerprint(entries);
  }
  if (resource.startsWith("probe-")) throw Error("Unknown compiler input probe");
  return undefined;
}

export async function inputMatches(input: RecordedInput, root: string, signal?: AbortSignal): Promise<boolean> {
  try { const actual = await recordedDigest(input.resource, root, signal); return actual === undefined || actual === input.digest; }
  catch (error) { signal?.throwIfAborted(); return false; }
}
