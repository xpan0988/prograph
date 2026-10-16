import path from "node:path";
import { ts, type FileSystemHost } from "ts-morph";
import { canonical, digest } from "./model.js";
import { directoryFingerprint, recordedDigest, type RecordedInput } from "./input-check.js";

/** Observe the real compiler filesystem before it constructs/resolves a Program.
 * The SDK's embedded default libraries bypass this host and retain their bundle receipts.
 */
function inputTrace() {
  const observed = new Map<string, string>(); let bytes = 0;
  const record = (resource: string, hash: string) => {
    const previous = observed.get(resource);
    if (previous !== undefined && previous !== hash) throw Error(`Compiler input changed during extraction: ${resource}`);
    if (previous === undefined) {
      bytes += Buffer.byteLength(resource) + 64;
      if (observed.size >= 100000 || bytes > 32 * 1024 ** 2) throw Error("Compiler input catalogue exceeds budget");
      observed.set(resource, hash);
    }
  };
  return {
    record,
    entries: () => [...observed].map(([resource, hash]) => ({ resource, digest: hash })),
    async verify() { for (const [resource, hash] of observed) if (await recordedDigest(resource, "") !== hash) throw Error(`Compiler input changed before publication: ${resource}`); },
  };
}

export function traceCompilerInputs(host: FileSystemHost): { entries(): RecordedInput[]; verify(): Promise<void> } {
  const trace = inputTrace(); const { record } = trace;
  for (const [method, prefix] of [["fileExistsSync", "probe-file:"], ["directoryExistsSync", "probe-dir:"]] as const) {
    const original = host[method].bind(host);
    host[method] = (file: string) => { const value = original(file); record(prefix + path.resolve(file), digest(String(value))); return value; };
  }
  const read = host.readFileSync.bind(host);
  host.readFileSync = (file, encoding = "utf-8") => {
    const value = read(file, encoding);
    if (Buffer.byteLength(value) > 32 * 1024 ** 2) throw Error("Compiler file input exceeds byte budget");
    record(`probe-read:${canonical([path.resolve(file), encoding])}`, digest(value)); return value;
  };
  const list = host.readDirSync.bind(host);
  host.readDirSync = directory => { const entries = list(directory); record(`probe-list:${path.resolve(directory)}`, directoryFingerprint(entries)); return entries; };
  const resolve = host.realpathSync.bind(host);
  host.realpathSync = file => { const resolved = resolve(file); record(`probe-realpath:${path.resolve(file)}`, digest(resolved)); return resolved; };
  return trace;
}

/** Config inheritance/package searches precede Program construction and need their own receipt. */
export function traceConfigInputs(read: (file: string) => string | undefined): { host: ts.ParseConfigHost; entries(): RecordedInput[] } {
  const trace = inputTrace();
  return {
    entries: trace.entries,
    host: {
      ...ts.sys,
      fileExists(file) { const found = ts.sys.fileExists(file); trace.record(`probe-file:${path.resolve(file)}`, digest(String(found))); return found; },
      directoryExists(file) { const found = ts.sys.directoryExists(file); trace.record(`probe-dir:${path.resolve(file)}`, digest(String(found))); return found; },
      readFile(file) {
        const text = read(file);
        if (text !== undefined) trace.record(`probe-read:${canonical([path.resolve(file), "utf-8"])}`, digest(text));
        else trace.record(`probe-file:${path.resolve(file)}`, digest("false"));
        return text;
      },
    },
  };
}
