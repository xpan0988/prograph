import path from "node:path";
import os from "node:os";
import { mkdir, open, lstat, realpath, link, rm } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { boundedInput } from "./inputs.js";
import { canonical, digest } from "./model.js";
import type { ProviderRegistration } from "./provider-plan.js";

type UnsignedRegistration = Omit<ProviderRegistration, "authorization">;
const filename = () => path.join(os.homedir(), ".cache", "prograph", "provider-grants-v1.key");
async function localKey(create: boolean): Promise<Buffer> {
  const file = filename();
  if (create) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${file}.${randomBytes(16).toString("hex")}`; let handle;
      try {
        handle = await open(temporary, "wx", 0o600); await handle.writeFile(randomBytes(32)); await handle.sync(); await handle.close(); handle = undefined;
        try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const parent = await open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); }
      } finally { await handle?.close(); await rm(temporary, { force: true }); }
    }
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error("Provider grant key is not a private local file");
  return boundedInput(file, 32);
}
async function seal(registration: UnsignedRegistration, root: string, directory: string, create: boolean): Promise<string> {
  const key = await localKey(create);
  return createHmac("sha256", key).update(canonical(["provider-grant-1", await realpath(root), await realpath(directory), registration])).digest("hex");
}
/** Called only after explicit, pinned tool execution. Repo/index contents cannot grant execution authority. */
export async function authorizeProvider(registration: UnsignedRegistration, root: string, directory: string): Promise<ProviderRegistration> {
  return { ...registration, authorization: await seal(registration, root, directory, true) };
}
export async function verifyProviderAuthorization(registration: ProviderRegistration, root: string, directory: string): Promise<boolean> {
  try {
    const { authorization, ...unsigned } = registration;
    if (!/^[a-f0-9]{64}$/.test(authorization)) return false;
    const expected = await seal(unsigned, root, directory, false);
    return timingSafeEqual(Buffer.from(authorization, "hex"), Buffer.from(expected, "hex"));
  } catch { return false; }
}
/** Tool roles, configured aliases, digests and entrypoints are the authorized execution boundary. */
export function managedToolTrust(configuration: unknown): string {
  const tools: unknown[] = [];
  const walk = (value: unknown, key: string) => {
    if (!value || typeof value !== "object") return;
    if ("path" in value && "sha256" in value) { const tool = value as { path: unknown; sha256: unknown; entry?: unknown }; tools.push([key, tool.path, tool.sha256, tool.entry ?? null]); return; }
    for (const [name, child] of Object.entries(value)) walk(child, `${key}/${name}`);
  };
  walk(configuration, ""); return digest(canonical(tools));
}
