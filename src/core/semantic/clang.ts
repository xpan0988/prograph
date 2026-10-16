import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { scanRepository, resolveRepositoryRoot } from "../repository/repository.js";
import { discoverProjects, type ProjectUnit } from "./projects.js";
import { SemanticStore } from "./store.js";
import { SourceCoordinates } from "./coordinates.js";
import { canonical, digest, semanticKey, CLANG_SEMANTIC_VERSION, type Provenance } from "./model.js";
import { executePasses } from "./passes.js";
import { semanticInventory, retainProviders } from "./provider-runs.js";
import { boundedInput, digestFile } from "./inputs.js";
import type { ProviderPreparation } from "./provider-plan.js";
import { authorizeProvider, verifyProviderAuthorization } from "./provider-grants.js";
import { withIndexWork } from "./maintenance-lock.js";
import { captureClangInputs, clangDriverSelection } from "./clang-inputs.js";
import { inputMatches } from "./input-check.js";
import { runProviderProcess } from "./process.js";

const exec = (executable: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => runProviderProcess(executable, args, options.cwd ?? process.cwd(), options.env, { timeoutMs: options.timeout, maxOutputBytes: options.maxBuffer });
const COMPILER = "/usr/bin/clang";
const bounds = { maxOutputBytes: 33554432, maxSourceBytes: 8388608, timeoutMs: 30000, batch: 500, maxNodes: 200000 };
interface Ast {
  id?: string; kind: string; name?: string; mangledName?: string; isImplicit?: boolean; virtual?: boolean;
  type?: { qualType?: string }; loc?: Location; range?: { begin: Location; end: Location };
  referencedDecl?: { id: string }; referencedMemberDecl?: string;
  parentDeclContextId?: string;
  inner?: Ast[]; bases?: Array<{ type?: { qualType?: string } }>;
}
interface Location { file?: string; offset?: number; tokLen?: number; spellingLoc?: Location; expansionLoc?: Location }
function compilerArguments(unit: ProjectUnit, source: string): string[] {
  const original = unit.options.arguments;
  if (!Array.isArray(original) || original.some(value => typeof value !== "string")) throw Error("Clang requires an arguments-array compilation database entry");
  const output: string[] = [];
  const pairs = new Set(["-I", "-isystem", "-iquote", "-include", "-imacros", "-D", "-U", "-x", "-target", "--target", "-isysroot", "--sysroot"]);
  for (let i = 1; i < original.length; i++) {
    const arg = original[i] as string;
    if (["-c", "-fsyntax-only"].includes(arg)) continue;
    if (arg === "-o") { if (!original[++i]) throw Error("Missing output argument"); continue; }
    if (!arg.startsWith("-") && path.resolve(String(unit.options.directory), arg) === source) continue;
    if (pairs.has(arg)) { const value = original[++i]; if (typeof value !== "string" || value.startsWith("-")) throw Error(`Invalid compiler option ${arg}`); output.push(arg, value); continue; }
    if (/^-(?:I|D|U).+|^-std=|^--(?:target|sysroot)=|^-O[0-3sgz]$|^-W(?:all|extra|error|no-[A-Za-z0-9-]+)$/.test(arg) || ["-g", "-pthread", "-nostdinc", "-nostdinc++", "-fPIC", "-fPIE", "-fno-exceptions", "-fno-rtti", "-m32", "-m64", "-fms-extensions"].includes(arg)) output.push(arg);
    else throw Error(`Unsupported compiler argument (not executed): ${arg}`);
  }
  return output;
}
function dependencyPaths(output: string): string[] {
  const payload = output.replace(/\\\r?\n/g, ""); const colon = payload.indexOf(":"); if (colon < 0) throw Error("Invalid compiler dependency output");
  const values: string[] = []; let current = "";
  for (let i = colon + 1; i < payload.length; i++) {
    const char = payload[i]!;
    if (char === "\\" && i + 1 < payload.length) current += payload[++i];
    else if (/\s/.test(char)) { if (current) { values.push(current); current = ""; } }
    else current += char;
  }
  if (current) values.push(current); if (values.length > 100000) throw Error("Compiler dependency quota exceeded"); return [...new Set(values)];
}

/** Explicit opt-in, fixed trusted executable and allowlisted syntax-only arguments. No discovered shell execution. */
export async function indexClang(repository: string, unitKey: string, index?: string, options: ProviderPreparation = {}): Promise<Record<string, unknown>> {
  const root = await resolveRepositoryRoot(repository); const selected = path.resolve(index ?? path.join(root, ".prograph"));
  return withIndexWork(selected.endsWith(".sqlite") ? path.dirname(selected) : selected, () => indexClangWithLease(root, unitKey, index, options));
}

async function indexClangWithLease(repository: string, unitKey: string, index: string | undefined, options: ProviderPreparation): Promise<Record<string, unknown>> {
  const started = performance.now();
  const scan = await scanRepository(await resolveRepositoryRoot(repository), index); const root = scan.snapshot.repository.root;
  const unit = discoverProjects(scan.snapshot).units.find(value => value.key === unitKey && ["c", "cpp"].includes(value.language));
  if (!unit || !unit.sources.length) throw Error("C/C++ compilation unit not found; inspect semantic context first");
  const source = path.resolve(root, unit.sources[0]!); const actualRoot = await realpath(root);
  if (!(await realpath(source)).startsWith(`${actualRoot}${path.sep}`)) throw Error("Compilation source escapes repository");
  const argv = compilerArguments(unit, source); const cwd = String(unit.options.directory);
  const directory = path.resolve(index?.endsWith(".sqlite") ? path.dirname(index) : index ?? path.join(root, ".prograph")); await mkdir(directory, { recursive: true });
  const executableDigest = await digestFile(COMPILER); const executablePath = await realpath(COMPILER);
  const driver = await clangDriverSelection();
  const compilerTrust = async (installed: string) => digest(canonical([COMPILER, executablePath, executableDigest, driver, installed, await realpath(installed), await digestFile(installed)]));
  if (options.authorization) {
    const grant = options.authorization, installed = grant.recipe.installedCompiler;
    if (!await verifyProviderAuthorization(grant, root, directory) || grant.kind !== "clang" || grant.version !== CLANG_SEMANTIC_VERSION || typeof installed !== "string" || !path.isAbsolute(installed) || grant.trust !== await compilerTrust(installed)) throw Error("Clang tool/driver selection changed; explicit requalification required");
  }
  const env = { PATH: "/usr/bin:/bin", LANG: "C" };
  const tool = await exec(COMPILER, ["--version"], { env, timeout: bounds.timeoutMs, maxBuffer: 65536 });
  const version = tool.stdout.split("\n")[0]!;
  const implicitTarget = /^Target:\s*(.+)$/m.exec(tool.stdout)?.[1]?.trim() ?? "unreported";
  const installedDirectory = /^InstalledDir:\s*(.+)$/m.exec(tool.stdout)?.[1]?.trim();
  if (!installedDirectory || !path.isAbsolute(installedDirectory)) throw Error("Clang did not report a qualified absolute installed compiler directory");
  const installedCompiler = path.join(installedDirectory, "clang"), trust = await compilerTrust(installedCompiler);
  if (options.authorization && (options.authorization.recipe.installedCompiler !== installedCompiler || options.authorization.trust !== trust)) throw Error("Clang installed compiler changed; explicit requalification required");
  const flags = [...argv, "-x", unit.language === "cpp" ? "c++" : "c", "--no-default-config", "-fno-implicit-modules", "-fno-implicit-module-maps"];
  const deps = await exec(COMPILER, [...flags, "-M", "-MT", "prograph", source], { cwd, env, timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes });
  const inputs: Record<string, string> = { ...unit.inputs };
  inputs[COMPILER] = executableDigest;
  inputs[installedCompiler] = await digestFile(installedCompiler);
  const dependencies = dependencyPaths(deps.stdout).map(file => path.resolve(cwd, file));
  for (const file of dependencies) inputs[file] = await digestFile(file);
  const trace = await exec(COMPILER, [...flags, "-E", "-dI", "-v", source], { cwd, env, timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes });
  const lookup = await captureClangInputs(trace.stdout, trace.stderr, cwd, source, dependencies, flags, driver);
  lookup.inputs[`probe-realpath:${root}`] = digest(actualRoot);
  const result = await exec(COMPILER, [...flags, "-fsyntax-only", "-Xclang", "-ast-dump=json", source], { cwd, env, timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes });
  const ast = JSON.parse(result.stdout) as Ast;
  const context = semanticKey("clang-context", [unit.context, COMPILER, version, implicitTarget, trust, flags, lookup.environment, CLANG_SEMANTIC_VERSION]);
  const inputFingerprint = digest(canonical([inputs, lookup.inputs, context]));
  const store = new SemanticStore(path.join(directory, "semantic.sqlite")); const parent = store.activeSnapshot(); const partition = `clang/${unit.key}`;
  const run = store.begin(partition, context, inputFingerprint);
  const provenance: Provenance = { provider: "clang/compiler-ast", version, basis: "compiler", method: `clang-ast-binding-v${CLANG_SEMANTIC_VERSION}`, context, inputFingerprint };
  const sourceFiles = new Map<string, { text: string; raw: Buffer; coordinates: SourceCoordinates; bytes: number }>();
  const symbols = new Map<string, string>(); const scopes = new Map<Ast, string>(); const callable = new Set<string>();
  const nodes: Array<{ node: Ast; file?: string; ancestry: string[]; owner?: Ast }> = [];
  let lastFile: string | undefined; let unresolved = 0; let macroSkipped = 0;
  const collect = (node: Ast, inherited?: string, ancestry: string[] = [], owner?: Ast): void => {
    if (nodes.length >= bounds.maxNodes) throw Error("Clang AST node bound exceeded");
    if (node.loc?.file || node.range?.begin.file) lastFile = path.resolve(cwd, node.loc?.file ?? node.range!.begin.file!);
    const file = node.loc?.file ? path.resolve(cwd, node.loc.file) : inherited ?? lastFile;
    nodes.push({ node, ...(file ? { file } : {}), ancestry, ...(owner ? { owner } : {}) });
    const nextOwner = /^(?:Function|CXXMethod|CXXConstructor|CXXDestructor|CXXConversion)Decl$/.test(node.kind) ? node : owner;
    const nextAncestry = node.name && /Decl$/.test(node.kind) ? [...ancestry, node.name] : ancestry;
    for (const child of node.inner ?? []) collect(child, file, nextAncestry, nextOwner);
  };
  try {
    collect(ast);
    const byId = new Map(nodes.filter(entry => entry.node.id).map(entry => [entry.node.id!, entry]));
    const declarationPath = (entry: (typeof nodes)[number], seen = new Set<string>()): string[] => {
      const parentId = entry.node.parentDeclContextId;
      if (parentId && seen.has(parentId) || seen.size > 64) throw Error("Invalid/deep Clang declaration context");
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parentId) seen.add(parentId);
      const prefix = parent ? declarationPath(parent, seen) : entry.ancestry;
      return entry.node.name ? [...prefix, entry.node.name] : prefix;
    };
    const localFiles = [...new Set(nodes.map(value => value.file).filter((file): file is string => !!file && file.startsWith(`${root}${path.sep}`)))];
    for (const file of localFiles) {
      const bytes = await boundedInput(file, bounds.maxSourceBytes);
      if (!(await realpath(file)).startsWith(`${actualRoot}${path.sep}`)) throw Error("Clang source dependency escapes repository");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const relative = path.relative(root, file).split(path.sep).join("/"); sourceFiles.set(file, { text, raw: bytes, coordinates: new SourceCoordinates(relative, text, true), bytes: bytes.length });
    }
    const module = semanticKey("clang-module", [context, unit.sources[0]]);
    store.batch(run, () => {
      store.addSymbol({ key: module, name: `<unit:${unit.sources[0]}>`, qualifiedName: unit.sources[0]!, kind: "compilation-unit", file: unit.sources[0]!, context });
      const key = semanticKey("project", [scan.snapshot.repository.identity, unit.key]); store.addEntity(key, "artifact", { key, kind: "project" });
      store.addFact(run, { predicate: "context.Project", context, subject: key, value: { unit: unit.key, source: unit.sources[0], workingDirectory: cwd, language: unit.language, compiler: COMPILER, installedCompiler, implicitTarget, version, mappingVersion: CLANG_SEMANTIC_VERSION, flags, dependencyCount: Object.keys(inputs).length, searchInputs: Object.keys(lookup.inputs).length, negativeSearches: lookup.gaps.length ? "unqualified" : "qualified-expanded-includes", bounds }, confidence: "exact", provenance });
      for (const [file, hash] of Object.entries(inputs)) store.input(run, `physical:${file}`, hash);
      store.input(run, `probe-realpath:${COMPILER}`, digest(executablePath));
      for (const [resource, hash] of Object.entries(lookup.inputs)) store.input(run, resource, hash);
      store.input(run, "project-inventory", semanticInventory(scan.snapshot));
      store.selector(run, `clang:${context}:inventory`, inputFingerprint);
    });
    for (let offset = 0; offset < nodes.length; offset += bounds.batch) store.batch(run, () => {
      for (const entry of nodes.slice(offset, offset + bounds.batch)) {
        const { node, file } = entry;
        const input = file ? sourceFiles.get(file) : undefined;
        if (!input || !node.name || !node.id || !/Decl$/.test(node.kind) || node.isImplicit) continue;
        if (node.loc?.spellingLoc || node.loc?.expansionLoc) { macroSkipped++; continue; }
        if (node.loc?.offset === undefined) continue;
        // A macro return type/attribute does not invalidate the compiler's direct
        // identifier anchor. Macro-expanded names still require expansion mapping.
        if (/^[A-Za-z_]\w*$/.test(node.name) && input.raw.subarray(node.loc.offset, node.loc.offset + (node.loc.tokLen ?? Buffer.byteLength(node.name))).toString("utf8") !== node.name) { macroSkipped++; continue; }
        const local = /^(?:ParmVar|Var|Field)Decl$/.test(node.kind) && !node.mangledName;
        const arguments_ = (node.inner ?? []).filter(value => value.kind === "TemplateArgument").map(value => value.type?.qualType ?? value.name ?? value.kind);
        const qualified = declarationPath(entry).join("::");
        // Semantic declaration contexts unify out-of-line definitions; spelling distinguishes
        // explicit ABI aliases rather than treating a mangled linker name as a compiler USR.
        const key = semanticKey("clang-symbol", [context, node.mangledName ? [node.mangledName, qualified] : [qualified, node.kind, node.type?.qualType ?? null, arguments_, local ? [file, node.loc.offset] : null]]);
        store.addSymbol({ key, name: node.name, qualifiedName: qualified, kind: node.kind, file: "<clang-unit>", context }); symbols.set(node.id, key);
        if (/^(?:Function|CXXMethod|CXXConstructor|CXXDestructor|CXXConversion)Decl$/.test(node.kind)) { scopes.set(node, key); callable.add(node.id); }
        const start = input.coordinates.utf16AtByte(node.loc.offset); const end = input.coordinates.utf16AtByte(node.loc.offset + (node.loc.tokLen ?? Buffer.byteLength(node.name)));
        const occurrence = input.coordinates.range(start, end, context, "definition"); store.addOccurrence(occurrence, input.bytes);
        store.addFact(run, { predicate: "common.Declaration", context, subject: key, occurrence: occurrence.key, confidence: "exact", provenance });
        store.addFact(run, { predicate: "common.Definition", context, subject: key, object: key, occurrence: occurrence.key, value: { hasBody: (node.inner ?? []).some(value => value.kind === "CompoundStmt") }, confidence: "exact", provenance });
        store.addFact(run, { predicate: "cxx.Declaration", context, subject: key, occurrence: occurrence.key, value: { kind: node.kind, mangledName: node.mangledName ?? null, type: node.type?.qualType ?? null, templateArguments: arguments_, virtual: !!node.virtual, baseTypes: (node.bases ?? []).map(base => base.type?.qualType ?? "unknown"), attributes: (node.inner ?? []).filter(value => /Attr$/.test(value.kind)).map(value => value.kind) }, confidence: "exact", provenance });
      }
    });
    const referenced = (node: Ast): string | undefined => node.referencedDecl?.id ?? node.referencedMemberDecl;
    const calleeDeclaration = (node: Ast): string | undefined => {
      if (["DeclRefExpr", "MemberExpr"].includes(node.kind)) return referenced(node);
      // Only transparent callee wrappers may be unwrapped. Nested calls, selectors and
      // constructor arguments can contain function references without being that callee.
      if (["ImplicitCastExpr", "ParenExpr", "CStyleCastExpr", "CXXStaticCastExpr", "CXXReinterpretCastExpr", "UnaryOperator"].includes(node.kind) && node.inner?.length === 1) return calleeDeclaration(node.inner[0]!);
      return undefined;
    };
    for (let offset = 0; offset < nodes.length; offset += bounds.batch) store.batch(run, () => {
      for (const { node, file, owner } of nodes.slice(offset, offset + bounds.batch)) {
        const input = file ? sourceFiles.get(file) : undefined; const span = node.range;
        if (!input || !span || span.begin.offset === undefined || span.end.offset === undefined || span.begin.spellingLoc || span.end.spellingLoc) continue;
        if (!["DeclRefExpr", "MemberExpr", "CallExpr", "CXXMemberCallExpr", "CXXOperatorCallExpr", "CXXConstructExpr"].includes(node.kind)) continue;
        const caller = owner ? scopes.get(owner) ?? module : module;
        const call = node.kind.endsWith("CallExpr") || node.kind === "CallExpr" || node.kind === "CXXConstructExpr";
        const targetId = node.kind === "CXXConstructExpr" ? undefined : call ? node.inner?.[0] ? calleeDeclaration(node.inner[0]) : undefined : referenced(node);
        const target = targetId && (!call || callable.has(targetId)) ? symbols.get(targetId) : undefined;
        const occurrence = input.coordinates.range(input.coordinates.utf16AtByte(span.begin.offset), input.coordinates.utf16AtByte(span.end.offset + (span.end.tokLen ?? 1)), context, call ? "call" : "reference"); store.addOccurrence(occurrence, input.bytes);
        if (call) {
          store.addFact(run, { predicate: "common.CallSite", context, subject: caller, occurrence: occurrence.key, value: { syntax: node.kind }, confidence: "exact", provenance });
          if (target) store.addFact(run, { predicate: "common.CallTarget", context, subject: caller, object: target, occurrence: occurrence.key, value: { dispatch: "static-declaration", syntax: node.kind }, confidence: "resolved", provenance }); else unresolved++;
        } else if (target) store.addFact(run, { predicate: "common.Reference", context, subject: caller, object: target, occurrence: occurrence.key, confidence: "resolved", provenance });
      }
    });
    for (const [file, hash] of Object.entries(inputs)) if (await digestFile(file) !== hash) throw Error("Clang input changed during extraction");
    for (const [resource, hash] of Object.entries(lookup.inputs)) if (!resource.startsWith("unavailable-input:") && !await inputMatches({ resource, digest: hash }, root)) throw Error("Clang search input changed during extraction");
    const finalDependencies = await exec(COMPILER, [...flags, "-M", "-MT", "prograph", source], { cwd, env, timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes });
    if (canonical(dependencyPaths(finalDependencies.stdout).map(file => path.resolve(cwd, file)).sort()) !== canonical([...dependencies].sort())) throw Error("Clang dependency selection changed during extraction");
    if (await compilerTrust(installedCompiler) !== trust) throw Error("Clang tool inputs changed during extraction");
    const coverage = { status: "partial", provider: provenance.provider, mappingVersion: CLANG_SEMANTIC_VERSION, language: unit.language, definitions: "partial", references: "partial", calls: "partial", unresolved, macroSkipped,
      negativeSearches: lookup.gaps.length ? "unqualified" : "qualified-expanded-includes", searchInputs: Object.keys(lookup.inputs).length,
      gaps: ["Static declaration binding, not runtime dispatch or cross-translation-unit linking", "Macro expansion anchors, constructors without target IDs and external declarations are not qualified", "Recorded build may use another compiler; this is explicit Clang syntax-only extraction", ...lookup.gaps] };
    store.seal(run, coverage); const passes = executePasses(store, run, partition, provenance, `clang:${context}:inventory`);
    const registration = await authorizeProvider({ key: options.authorization?.key ?? `clang-${digest(unit.key).slice(0, 32)}`, kind: "clang", recipe: { unitKey, source: unit.sources[0]!, database: unit.project.split("#")[0]!, prefix: partition, installedCompiler }, trust, version: CLANG_SEMANTIC_VERSION }, root, directory);
    if (options.prepare) {
      options.prepare({ parent, prefix: partition, runs: [run, ...passes], registration });
      return { status: "prepared", context, coverage, durationMs: Math.round(performance.now() - started), compiler: { executable: COMPILER, version }, bounds };
    }
    const native = await retainProviders(store, scan.snapshot, parent, partition);
    const others = parent ? (store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=?").all(parent) as Array<{ partition_key: string; run: number }>).filter(row => !row.partition_key.startsWith("scip/") && !row.partition_key.startsWith("clang/")).map(row => row.run) : [];
    const published = store.publish([...others, ...native, run, ...passes], parent, [registration]);
    return { snapshot: published, context, coverage, durationMs: Math.round(performance.now() - started), compiler: { executable: COMPILER, version }, bounds };
  } finally { store.close(); }
}
