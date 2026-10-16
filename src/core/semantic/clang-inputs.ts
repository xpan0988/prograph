import path from "node:path";
import { canonical, digest } from "./model.js";
import { boundedInput, digestFile } from "./inputs.js";
import { recordedDigest } from "./input-check.js";

export interface ClangInputs { inputs: Record<string, string>; environment: unknown; gaps: string[] }
const maxInputs = 100000, maxReceiptBytes = 32 * 1024 ** 2;

/** The fixed Apple launcher chooses another compiler through this system link.
 * Observe it before invoking a previously authorized driver, not just afterwards.
 */
export async function clangDriverSelection(): Promise<Record<string, string>> {
  const inputs: Record<string, string> = { "environment:host": (await recordedDigest("environment:host", ""))! };
  if (process.platform === "darwin") {
    const file = "/var/db/xcode_select_link", resource = `probe-present:${file}`;
    inputs[resource] = (await recordedDigest(resource, ""))!;
    if (inputs[resource] === digest("true")) inputs[`probe-realpath:${file}`] = (await recordedDigest(`probe-realpath:${file}`, ""))!;
  }
  return inputs;
}

/** Observe expanded successful include spellings from Clang itself, then record
 * all earlier/later candidate locations. This is conservative over-invalidation,
 * not a reimplementation of overload or preprocessor semantics. Missing builtin
 * header queries need native PPCallbacks and explicitly disable qualified reuse.
 */
export async function captureClangInputs(stdout: string, stderr: string, cwd: string, source: string, dependencies: string[], flags: string[], driver: Record<string, string>): Promise<ClangInputs> {
  const inputs = { ...driver }, gaps = new Set<string>(); let receiptBytes = 0, inputCount = Object.keys(inputs).length;
  const add = (resource: string, hash: string) => {
    const previous = inputs[resource]; if (previous !== undefined && previous !== hash) throw Error("Clang search inputs changed during observation");
    if (previous !== undefined) return;
    receiptBytes += Buffer.byteLength(resource) + hash.length;
    if (++inputCount > maxInputs || receiptBytes > maxReceiptBytes) throw Error("Clang search receipt exceeds input/byte quota");
    inputs[resource] = hash;
  };
  const probe = async (resource: string) => { if (inputs[resource] !== undefined) return inputs[resource]!; const hash = (await recordedDigest(resource, ""))!; add(resource, hash); return hash; };
  const roots: Array<{ directory: string; framework: boolean }> = []; let section = false, ended = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/^#include (?:"\.\.\."|<\.\.\.>) search starts here:$/.test(line)) { section = true; continue; }
    if (line === "End of search list.") { ended = true; section = false; continue; }
    const absent = /^ignoring nonexistent directory ("(?:\\.|[^"\\])*")$/.exec(line);
    if (absent) { try { roots.push({ directory: path.resolve(cwd, JSON.parse(absent[1]!)), framework: false }); } catch { gaps.add("Unrecognized absent include-directory trace"); } }
    if (section && line.trim()) {
      const framework = line.endsWith(" (framework directory)"), spelling = line.trim().replace(/ \(framework directory\)$/, "");
      if (/\((?:headermap|.*directory)\)$/.test(spelling)) gaps.add("Unqualified include search-root format");
      else roots.push({ directory: path.resolve(cwd, spelling), framework });
    }
  }
  if (!ended) gaps.add("Compiler did not report a complete include search-root trace");
  if (roots.length > 4096) throw Error("Clang include-root quota exceeded");
  const environment: unknown[] = [];
  for (const root of roots) {
    const exists = await probe(`probe-dir:${root.directory}`); await probe(`probe-present:${root.directory}`);
    const resolved = exists === digest("true") ? await probe(`probe-realpath:${root.directory}`) : null;
    environment.push([root.directory, root.framework, resolved]);
    // Apple SDK settings can affect implicit target/predefined compiler context.
    const match = /^(.*?\.sdk)(?:\/|$)/.exec(root.directory);
    if (match) for (const name of ["SDKSettings.json", "SDKSettings.plist"]) {
      const file = path.join(match[1]!, name), present = await probe(`probe-file:${file}`);
      if (present === digest("true")) { const hash = await digestFile(file, 8 * 1024 ** 2); add(`physical:${file}`, hash); environment.push([file, hash]); }
    }
  }
  const queries: Array<{ name: string; quoted: boolean; including: string }> = []; let current = source;
  for (const line of stdout.split(/\r?\n/)) {
    const anchor = /^#\s+\d+\s+("(?:\\.|[^"\\])*")(?:\s+\d+)*\s*$/.exec(line);
    if (anchor) {
      try { const file = JSON.parse(anchor[1]!) as string; if (!file.startsWith("<")) current = path.resolve(cwd, file); }
      catch { gaps.add("Unqualified escaped include-source path"); } continue;
    }
    if (!/^#\s*(?:include|import)/.test(line)) continue;
    const include = /^#\s*include\s+(["<])([^">\0\r\n]+)[">]\s*\/\* clang -E -dI \*\/\s*$/.exec(line);
    if (!include) { gaps.add("Unqualified include/import/include_next trace"); continue; }
    queries.push({ name: include[2]!, quoted: include[1] === '"', including: current });
    if (queries.length > maxInputs) throw Error("Clang include query quota exceeded");
  }
  for (let i = 0; i < flags.length; i++) if (["-include", "-imacros"].includes(flags[i]!)) queries.push({ name: flags[++i]!, quoted: true, including: path.join(cwd, "<command-line>") });
  let sourceBytes = 0;
  if (flags.some(flag => /__has_(?:include(?:_next)?|embed)\b|##|%:%:|\?\?|[\\\r\n]/.test(flag))) gaps.add("Command-line conditional filename macros require native preprocessor callbacks");
  for (const file of dependencies) {
    const bytes = await boundedInput(file, 8 * 1024 ** 2); sourceBytes += bytes.length; if (sourceBytes > 128 * 1024 ** 2) throw Error("Clang preprocessor input observation exceeds 128 MiB");
    // Raw-token screening is deliberately conservative. Token-pasting can hide a
    // builtin filename query; dead branches/comments may produce a coverage gap.
    const text = bytes.toString("utf8").replace(/\\(?:\r\n?|\n)/g, ""), tokens = [...text.matchAll(/\b__has_include(?:_next)?\b/g)];
    const literalQueries = [...text.matchAll(/\b__has_include(?:_next)?\s*\(\s*(["<])([^"<>\\\0\r\n]+)[">]\s*\)/g)];
    for (const query of literalQueries) queries.push({ name: query[2]!, quoted: query[1] === '"', including: file });
    if (tokens.length !== literalQueries.length || /\0|##|%:%:|\?\?|\b__has_embed\b|^\s*#\s*embed\b/m.test(text)) gaps.add("Nonliteral/pasted/embedded header queries require native preprocessor callbacks; negative searches are unqualified");
    if (/\b__(?:DATE|TIME|TIMESTAMP)__\b/.test(text)) gaps.add("Volatile preprocessor clock/mtime inputs are unqualified");
    if (/\b(?:include_alias|_Pragma|__pragma)\b|^\s*#\s*pragma\s+clang\s+module\b/m.test(text)) gaps.add("Header aliases/module pragmas require native preprocessor callbacks");
    if (queries.length > maxInputs) throw Error("Clang include query quota exceeded");
  }
  const directories = [...new Set(dependencies.map(file => path.dirname(file)))];
  if (queries.length && dependencies.some(file => file.includes(".framework/"))) gaps.add("Nested framework lookup requires native preprocessor callbacks");
  const distinctQueries = new Map(queries.map(query => [canonical([query.name, query.quoted, path.dirname(query.including)]), query]));
  for (const query of distinctQueries.values()) {
    if (query.name.includes("\\")) gaps.add("Escaped include-name formatting is unqualified");
    const candidates = new Set<string>();
    if (path.isAbsolute(query.name)) candidates.add(query.name);
    else {
      if (query.quoted) candidates.add(path.resolve(path.dirname(query.including), query.name));
      // Microsoft-compatible includer stacks and macro expansion sites can use
      // a different read file's directory. Record an over-approximation of every
      // actual includer directory instead of guessing which macro expanded where.
      if (query.quoted) for (const directory of directories) candidates.add(path.resolve(directory, query.name));
      for (const root of roots) {
        if (!root.framework) candidates.add(path.resolve(root.directory, query.name));
        else {
          const slash = query.name.indexOf("/"); if (slash < 1) continue;
          for (const headers of ["Headers", "PrivateHeaders"]) candidates.add(path.join(root.directory, `${query.name.slice(0, slash)}.framework`, headers, query.name.slice(slash + 1)));
        }
      }
      if (query.including.includes(".framework/")) gaps.add("Nested framework lookup requires native preprocessor callbacks");
    }
    for (const file of candidates) if (await probe(`probe-file:${file}`) === digest("true")) await probe(`probe-realpath:${file}`);
  }
  if (process.platform === "darwin" && driver["probe-present:/var/db/xcode_select_link"] !== digest("true")) gaps.add("Implicit Apple driver selection without a stable developer-directory link is unqualified");
  for (const reason of gaps) add(`unavailable-input:clang:${digest(reason)}`, digest(reason));
  return { inputs, environment: canonical(environment), gaps: [...gaps] };
}
