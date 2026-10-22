import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, open, stat, lstat, readdir, chmod, symlink, readlink, link, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonAtomic, writeJsonExports } from "../src/core/storage/json-export.js";
import { acceptedPrettyJson } from "./oracles/legacy-json-stage6-2.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-json-export-")); roots.push(root);
  const file = path.join(root, "graph.json"); await writeFile(file, acceptedPrettyJson({ accepted: true }));
  const handle = await open(file, "r"), prototype = Object.getPrototypeOf(handle); await handle.close();
  return { root, file, prototype, old: await readFile(file) };
}
const large = { nodes: Array.from({ length: 2000 }, (_, id) => ({ id, metadata: { text: "🙂\n".repeat(20) } })), diagnostics: [] };

test("existing files retain bytes/modes, new files honor umask, and stale siblings are never reused", async () => {
  const f = await fixture(); await chmod(f.file, 0o640);
  const stale = path.join(f.root, ".graph.json.prograph-stale.tmp"); await writeFile(stale, "keep unrelated stale data");
  const before = await stat(f.file), result = await writeJsonAtomic(f.file, large);
  expect(await readFile(f.file, "utf8")).toBe(acceptedPrettyJson(large));
  expect((await stat(f.file)).mode & 0o777).toBe(0o640); expect((await stat(f.file)).ino).not.toBe(before.ino);
  expect(result.bytes).toBe(Buffer.byteLength(acceptedPrettyJson(large))); expect(result.maxBufferBytes).toBeLessThanOrEqual(49152);
  expect(await readFile(stale, "utf8")).toBe("keep unrelated stale data");
  const fresh = path.join(f.root, "fresh.json"); await writeJsonAtomic(fresh, []);
  expect((await stat(fresh)).mode & 0o777).toBe(0o666 & ~process.umask());
  expect((await readdir(f.root)).sort()).toEqual([".graph.json.prograph-stale.tmp", "fresh.json", "graph.json"]);
});

test("stable relative, chained and dangling symlinks retain link paths and update complete referents", async () => {
  const f = await fixture(), alias = path.join(f.root, "alias.json"), chain = path.join(f.root, "chain.json");
  await symlink("graph.json", alias); await symlink("alias.json", chain);
  await writeJsonAtomic(chain, large);
  expect(await readFile(f.file, "utf8")).toBe(acceptedPrettyJson(large));
  expect(await readlink(chain)).toBe("alias.json"); expect(await readlink(alias)).toBe("graph.json");
  const dangling = path.join(f.root, "dangling.json"); await symlink("missing.json", dangling);
  await writeJsonAtomic(dangling, { created: true }); expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(f.root, "missing.json"), "utf8")).toBe(acceptedPrettyJson({ created: true }));
});

test("hard links, directories and symlink loops are refused without changing accepted files", async () => {
  const f = await fixture(), peer = path.join(f.root, "peer.json"); await link(f.file, peer);
  await expect(writeJsonAtomic(f.file, large)).rejects.toThrow(/one link/);
  expect(await readFile(f.file)).toEqual(f.old); expect(await readFile(peer)).toEqual(f.old);
  await expect(writeJsonAtomic(f.root, {})).rejects.toThrow(/ordinary file/);
  const loop = path.join(f.root, "loop"); await symlink("loop", loop);
  await expect(writeJsonAtomic(loop, {})).rejects.toThrow(/Too many symlinks/);
  expect((await readdir(f.root)).some(name => name.endsWith(".tmp"))).toBe(false);
});

test("permission failures preserve old files, including writable files in non-writable directories", async () => {
  const f = await fixture(); await chmod(f.file, 0o444);
  try { await expect(writeJsonAtomic(f.file, large)).rejects.toMatchObject({ code: "EACCES" }); }
  finally { await chmod(f.file, 0o644); }
  expect(await readFile(f.file)).toEqual(f.old);
  await chmod(f.root, 0o555);
  try { await expect(writeJsonAtomic(f.file, large)).rejects.toMatchObject({ code: "EACCES" }); }
  finally { await chmod(f.root, 0o755); }
  expect(await readFile(f.file)).toEqual(f.old);
  expect(await readdir(f.root)).toEqual(["graph.json"]);
});

test.each(["EIO", "ENOSPC"])("midstream %s preserves accepted bytes, cleans its temporary file, and permits restart", async code => {
  const f = await fixture(), original = f.prototype.write;
  let calls = 0;
  const injected = vi.spyOn(f.prototype, "write").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (++calls === 3) throw Object.assign(Error("injected write failure"), { code });
    return original.apply(this, args);
  });
  await expect(writeJsonAtomic(f.file, large)).rejects.toMatchObject({ code }); injected.mockRestore();
  expect(calls).toBe(3); expect(await readFile(f.file)).toEqual(f.old); expect(await readdir(f.root)).toEqual(["graph.json"]);
  await writeJsonAtomic(f.file, large); expect(await readFile(f.file, "utf8")).toBe(acceptedPrettyJson(large));
});

test("abort during writes and invalid serialization preserve accepted bytes with no temporary files", async () => {
  const f = await fixture(), original = f.prototype.write, controller = new AbortController();
  const injected = vi.spyOn(f.prototype, "write").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args); controller.abort(); return result;
  });
  await expect(writeJsonAtomic(f.file, large, controller.signal)).rejects.toMatchObject({ name: "AbortError" }); injected.mockRestore();
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const value of [cycle, { bigint: 1n }]) await expect(writeJsonAtomic(f.file, value)).rejects.toThrow(TypeError);
  expect(await readFile(f.file)).toEqual(f.old); expect(await readdir(f.root)).toEqual(["graph.json"]);
});

test("changed symlinks and replaced destinations are detected before publication", async () => {
  const f = await fixture(), alias = path.join(f.root, "alias.json"), other = path.join(f.root, "other.json");
  await writeFile(other, "other accepted bytes"); await symlink("graph.json", alias);
  const original = f.prototype.write; let changed = false;
  const injected = vi.spyOn(f.prototype, "write").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!changed) { changed = true; await rm(alias); await symlink("other.json", alias); }
    return result;
  });
  await expect(writeJsonAtomic(alias, large)).rejects.toThrow(/destination changed/); injected.mockRestore();
  expect(await readFile(f.file)).toEqual(f.old); expect(await readFile(other, "utf8")).toBe("other accepted bytes");
  changed = false;
  const replacement = path.join(f.root, "replacement"); await writeFile(replacement, "external replacement");
  const replaced = vi.spyOn(f.prototype, "write").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args); if (!changed) { changed = true; await rename(replacement, f.file); } return result;
  });
  await expect(writeJsonAtomic(f.file, large)).rejects.toThrow(/destination changed/); replaced.mockRestore();
  expect(await readFile(f.file, "utf8")).toBe("external replacement");
  expect((await readdir(f.root)).some(name => name.endsWith(".tmp"))).toBe(false);
});

test("sequential export preserves every byte and a later failure leaves individually complete generations", async () => {
  const f = await fixture(); await mkdir(path.join(f.root, "exports"));
  const values = { graph: large, manifest: { nested: [null, "é"] }, diagnostics: [{ message: "\u0000🙂" }], state: {} };
  const names = { graph: "exports/graph.json", manifest: "manifest.json", diagnostics: "diagnostics.json", state: "state.json" };
  const result = await writeJsonExports(f.root, values);
  for (const [key, name] of Object.entries(names)) {
    expect(await readFile(path.join(f.root, name), "utf8")).toBe(acceptedPrettyJson(values[key as keyof typeof values]));
    expect(result[name]!.bytes).toBe(Buffer.byteLength(acceptedPrettyJson(values[key as keyof typeof values])));
  }
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  await expect(writeJsonExports(f.root, { ...values, graph: { new: true }, manifest: cycle })).rejects.toThrow(TypeError);
  expect(await readFile(path.join(f.root, "exports/graph.json"), "utf8")).toBe(acceptedPrettyJson({ new: true }));
  expect(await readFile(path.join(f.root, "manifest.json"), "utf8")).toBe(acceptedPrettyJson(values.manifest));
  expect(await readFile(path.join(f.root, "diagnostics.json"), "utf8")).toBe(acceptedPrettyJson(values.diagnostics));
});

test("SIGKILL midstream leaves the old JSON valid and a private stale sibling; restart succeeds", async () => {
  const f = await fixture(), module = pathToFileURL(path.resolve("dist/core/storage/json-export.js")).href;
  const code = `import {open} from 'node:fs/promises';import {writeJsonAtomic} from ${JSON.stringify(module)};
    const file=process.argv[1],h=await open(file,'r'),p=Object.getPrototypeOf(h);await h.close();const original=p.write;
    p.write=async function(...args){const result=await original.apply(this,args);process.send('written');await new Promise(()=>setInterval(()=>{},1000));return result};
    await writeJsonAtomic(file,{text:'🙂'.repeat(100000)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr!.on("data", data => errors += data);
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error(errors || "Child exited before its write"); })]);
    const exited = once(child, "exit"); child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  expect(await readFile(f.file)).toEqual(f.old);
  const stale = (await readdir(f.root)).filter(name => name.endsWith(".tmp")); expect(stale).toHaveLength(1);
  expect((await stat(path.join(f.root, stale[0]!))).mode & 0o777).toBe(0o600);
  await writeJsonAtomic(f.file, large); expect(await readFile(f.file, "utf8")).toBe(acceptedPrettyJson(large));
  expect((await readdir(f.root)).filter(name => name.endsWith(".tmp"))).toEqual(stale);
}, 15000);

test("an interrupted new-file link/unlink publication remains complete and admits explicit stale-link recovery", async () => {
  const f = await fixture(), fresh = path.join(f.root, "new.json"), stale = path.join(f.root, ".new.json.prograph-interrupted.tmp");
  // The possible SIGKILL boundary after exclusive link, before temporary unlink.
  await writeFile(stale, acceptedPrettyJson(large)); await link(stale, fresh);
  expect(await readFile(fresh, "utf8")).toBe(acceptedPrettyJson(large));
  await expect(writeJsonAtomic(fresh, {})).rejects.toThrow(/one link/);
  // Never remove unknown aliases automatically. An operator may remove the
  // identified stale sibling, leaving the complete published inode in place.
  await rm(stale); await writeJsonAtomic(fresh, { recovered: true });
  expect(await readFile(fresh, "utf8")).toBe(acceptedPrettyJson({ recovered: true }));
});

test("file-sync failure before publication retains accepted output and cleans the incomplete attempt", async () => {
  const f = await fixture();
  const injected = vi.spyOn(f.prototype, "sync").mockRejectedValue(Object.assign(Error("injected sync failure"), { code: "EIO" }));
  await expect(writeJsonAtomic(f.file, large)).rejects.toMatchObject({ code: "EIO" }); injected.mockRestore();
  expect(await readFile(f.file)).toEqual(f.old); expect(await readdir(f.root)).toEqual(["graph.json"]);
});
