import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, lstat, realpath, readlink, readFile, writeFile, chmod, cp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { scanRepository, resolveRepositoryRoot } from "../repository/repository.js";
import { boundedInput, digestFile } from "./inputs.js";
import { canonical, digest, MANAGED_SCIP_VERSION } from "./model.js";
import { importScip, type ScipManifest } from "./scip-import.js";
import { deriveScipNative, type NativeLanguage } from "./scip-native.js";
import { runProviderProcess } from "./process.js";
import { javac0131Range, python066Symbol } from "./scip-dialects.js";
import { inventoryFromDisk } from "./provider-runs.js";

export interface ToolReceipt { path: string; sha256: string; entry?: string }
export interface ManagedProject {
  format: 1; id: string; language: Exclude<NativeLanguage, "rust">; root: string;
  package: { name: string; version: string };
  sources?: string[];
  sourceRoots?: string[];
  runtime: ToolReceipt; producer: ToolReceipt;
  python?: { interpreter: ToolReceipt; version: string; extraPaths?: string[]; stubs?: ToolReceipt[] };
  go?: { os: string; arch: string; tags?: string[]; moduleCache?: ToolReceipt };
  java?: { release: number; plugins: ToolReceipt[]; classpath?: ToolReceipt[]; modulePath?: ToolReceipt[] };
  csharp?: { projects: Array<{ file: string; targetFramework: string; assembly: string; sources: string[]; references?: ToolReceipt[]; projectReferences?: string[]; defines?: string[] }> };
}
export const MANAGED_CAPABILITIES = {
  python: { symbols: "partial", definitions: "partial", references: "partial", imports: "partial", calls: "partial-declared-static-targets", types: "reported-documentation-and-source-roles", inheritance: "reported-relationships", generics: "reported-symbols", metaprogramming: "unsupported", dynamicDispatch: "unsupported", nativeFacts: "partial", buildCompleteness: "declared-environment-only" },
  go: { symbols: "partial", definitions: "partial", references: "partial", imports: "partial", calls: "partial-declared-static-targets", types: "reported-signatures", inheritance: "reported-implementations", generics: "reported-signatures", metaprogramming: "unsupported", dynamicDispatch: "unsupported", nativeFacts: "partial", buildCompleteness: "selected-offline-non-cgo-variant" },
  java: { symbols: "partial", definitions: "partial", references: "partial", imports: "partial", calls: "partial-declared-static-targets", types: "reported-signatures", inheritance: "reported-relationships", generics: "reported-signatures", metaprogramming: "unsupported-processors-disabled", dynamicDispatch: "unsupported", nativeFacts: "partial", buildCompleteness: "declared-classpath-modulepath-release" },
  csharp: { symbols: "partial", definitions: "partial", references: "partial", imports: "partial", calls: "partial-declared-static-targets", types: "reported-documentation-and-source-roles", inheritance: "reported-relationships", generics: "reported-symbols", metaprogramming: "unsupported-generators-disabled", dynamicDispatch: "unsupported", nativeFacts: "partial", buildCompleteness: "explicit-project-framework-reference-variant" },
} as const;

/** A tool directory is immutable input, including bundled stubs, DLLs and SDK files, not just its launcher. */
export async function toolReceipt(filename: string, signal?: AbortSignal): Promise<{ sha256: string; inputs: Record<string, string>; bytes: number; files: number }> {
  if (!path.isAbsolute(filename)) throw Error("Tool receipt requires an absolute path");
  const root = await realpath(filename); const inputs: Record<string, string> = {}; const entries: unknown[] = []; let bytes = 0; let files = 0;
  const visit = async (file: string): Promise<void> => {
    signal?.throwIfAborted(); const info = await lstat(file); const relative = path.relative(root, file).split(path.sep).join("/");
    if (info.isSymbolicLink()) { const link = await readlink(file); let target: string; try { target = await realpath(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; target = path.resolve(path.dirname(file), link); } if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw Error("Tool symlink escapes receipt root"); entries.push([relative, "link", link]); return; }
    if (info.isDirectory()) { for (const child of (await readdir(file)).sort()) await visit(path.join(file, child)); return; }
    if (!info.isFile() || ++files > 40000 || (bytes += info.size) > 3 * 1024 ** 3) throw Error("Tool receipt exceeds 40000 files / 3 GiB");
    const hash = await digestFile(file, 512 * 1024 ** 2, signal); inputs[`physical:${file}`] = hash; entries.push([relative, hash]);
  };
  const info = await lstat(root); await visit(root);
  return { sha256: info.isFile() ? inputs[`physical:${root}`]! : digest(canonical(entries)), inputs, bytes, files };
}
const safeRelative = (value: string) => typeof value === "string" && value.length <= 4096 && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !value.split("/").some(part => part === ".." || !part);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const msbuildPath = (text: string) => xml(text.replace(/[%$@;?*()']/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`));

/** Explicit compiler contexts; never invokes repository build scripts, package installation or network discovery. */
export async function indexManagedProject(repository: string, configuration: string, index?: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const started = performance.now(); const timeout = options.timeoutMs ?? 300000;
  if (process.platform === "win32" || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600000) throw Error("Managed SCIP requires POSIX and a 100..600000ms total deadline");
  const root = await resolveRepositoryRoot(repository); const configFile = path.resolve(root, configuration);
  const configBytes = await boundedInput(configFile, 1024 ** 2); const config = JSON.parse(configBytes.toString("utf8")) as ManagedProject;
  if (config.format !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(config.id) || !Object.hasOwn(MANAGED_CAPABILITIES, config.language) || !safeRelative(config.root) || !config.package?.name || !config.package.version || [config.package.name, config.package.version].some(v => typeof v !== "string" || v.length > 256 || /[\s\0]/.test(v))) throw Error("Unsupported managed project configuration");
  if (config.sources?.some(f => !safeRelative(f)) || config.sourceRoots?.some(f => !safeRelative(f)) || Buffer.byteLength(canonical(config)) > 32768) throw Error("Managed source selection is invalid or configuration exceeds 32 KiB");
  const directory = path.resolve(index?.endsWith(".sqlite") ? path.dirname(index) : index ?? path.join(root, ".prograph")); await mkdir(directory, { recursive: true });
  const initialInventory = await inventoryFromDisk(root, directory, 200000, options.signal);
  const scan = await scanRepository(root, directory); const projectRoot = path.resolve(root, config.root);
  if ((await realpath(projectRoot)) !== (await realpath(root)) && !(await realpath(projectRoot)).startsWith(`${await realpath(root)}${path.sep}`)) throw Error("Managed project root escapes repository");
  const executionDirectory = path.join(await realpath(directory), "providers", config.language, randomUUID()); const source = path.join(executionDirectory, "source"); await mkdir(source, { recursive: true });
  const inputs: Record<string, string> = { [`physical:${configFile}`]: digest(configBytes) }; const sources: Record<string, string> = {}; const buildInputs: Record<string, string> = {};
  const extension = { python: /\.pyi?$/, go: /\.go$/, java: /\.java$/, csharp: /\.cs$/ }[config.language];
  const metadata = /(?:^|\/)(?:pyproject\.toml|pyrightconfig\.json|go\.(?:mod|sum|work)|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:csproj|sln))$/;
  let bytes = 0; let count = 0;
  const selected = config.sources ? new Set(config.sources) : undefined;
  for (const file of scan.snapshot.files) {
    const relative = path.relative(projectRoot, path.join(root, file)).split(path.sep).join("/"); if (!safeRelative(relative) || !(extension.test(file) || metadata.test(file))) continue;
    if (extension.test(file) && (selected && !selected.has(relative) || config.sourceRoots && !config.sourceRoots.some(prefix => prefix === "." || relative.startsWith(`${prefix}/`)))) continue;
    if (++count > 10000) throw Error("Managed source catalogue exceeds 10000 files");
    const original = path.join(root, file); const stat = await lstat(original);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(original)).startsWith(`${await realpath(root)}${path.sep}`)) throw Error("Managed source escapes repository");
    const body = await boundedInput(original, 8 * 1024 ** 2); if ((bytes += body.length) > 128 * 1024 ** 2) throw Error("Managed source copy exceeds 128 MiB");
    const hash = digest(body); inputs[`source:${file}`] = hash; if (extension.test(file)) sources[file] = hash; else buildInputs[file] = hash;
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true }); await writeFile(path.join(source, relative), body);
  }
  if (!Object.keys(sources).length) throw Error("Managed project has no selected sources");
  const receipts: Array<{ receipt: ToolReceipt; hash: string; files: number; bytes: number }> = [];
  const tool = async (receipt: ToolReceipt): Promise<string> => {
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.entry !== undefined && !safeRelative(receipt.entry)) throw Error("Explicit tool path, SHA-256 and safe entry required");
    const captured = await toolReceipt(receipt.path, options.signal); if (captured.sha256 !== receipt.sha256) throw Error(`Managed tool receipt mismatch: ${receipt.path}`);
    Object.assign(inputs, captured.inputs); receipts.push({ receipt, hash: captured.sha256, files: captured.files, bytes: captured.bytes });
    const executable = receipt.entry ? path.join(receipt.path, receipt.entry) : receipt.path;
    const resolved = await realpath(executable); if (receipt.entry && !resolved.startsWith(`${await realpath(receipt.path)}${path.sep}`)) throw Error("Tool entry escapes receipt"); return executable;
  };
  const runtime = await tool(config.runtime); const producer = await tool(config.producer);
  const env: Record<string, string> = { PATH: `${path.dirname(runtime)}:/usr/bin:/bin`, HOME: path.join(executionDirectory, "home"), LANG: "C.UTF-8", TMPDIR: executionDirectory };
  await mkdir(env.HOME!, { recursive: true }); const stages: Record<string, number> = {};
  const run = async (name: string, executable: string, args: string[], cwd = source) => {
    const remaining = Math.floor(timeout - (performance.now() - started)); if (remaining <= 0) throw Error("Managed SCIP total deadline exceeded");
    const result = await runProviderProcess(executable, args, cwd, env, { timeoutMs: remaining, maxOutputBytes: 8 * 1024 ** 2, ...(options.signal ? { signal: options.signal } : {}) }); stages[name] = +result.durationMs.toFixed(3); return result.stdout.trim();
  };
  const artifact = path.join(executionDirectory, "index.scip"); let provider = ""; let producerVersion = ""; let runtimeVersion = ""; let encoding: 1 | 2 = 2;
  if (config.language === "python") {
    const py = config.python; if (!py || !/^3\.(?:10|11|12|13)$/.test(py.version)) throw Error("Python requires a supported explicit 3.10..3.13 language version and isolated interpreter receipt");
    const interpreter = await tool(py.interpreter); const packageInfo = JSON.parse(await readFile(path.join(config.producer.path, "package.json"), "utf8")) as { version: string };
    if (packageInfo.version !== "0.6.6" || await digestFile(producer) !== "ce60dd39157c8f52d8f9de8f060743e1135b697c52253de65521a19b84e19d2a") throw Error("Qualified Python producer is scip-python 0.6.6");
    const wrapper = path.join(executionDirectory, "python-bin"); await mkdir(wrapper);
    if (/[\n\r']/g.test(interpreter)) throw Error("Python interpreter path cannot contain shell quoting characters");
    for (const name of ["python", "python3"]) { const file = path.join(wrapper, name); await writeFile(file, `#!/bin/sh\nexec '${interpreter}' -I -S -B "$@"\n`); await chmod(file, 0o755); }
    env.PATH = `${wrapper}:${env.PATH}`;
    runtimeVersion = await run("runtime-version", runtime, ["--version"]); const pythonVersion = await run("interpreter-version", interpreter, ["-I", "-S", "--version"]);
    if (!/^v(?:20|22|24)\./.test(runtimeVersion) || !/^Python 3\./.test(pythonVersion)) throw Error("Qualified Python runtime requires Node 20/22/24 and Python 3");
    runtimeVersion += `; ${pythonVersion}`;
    const extraPaths = py.extraPaths ?? ["."]; if (extraPaths.some(p => !safeRelative(p))) throw Error("Python package root escapes context");
    const stubPaths: string[] = []; for (const stub of py.stubs ?? []) stubPaths.push(await tool(stub));
    await writeFile(path.join(source, "pyrightconfig.json"), JSON.stringify({ include: ["."], extraPaths: [...extraPaths, ...stubPaths], pythonVersion: py.version, typeCheckingMode: "strict" }));
    const environment = path.join(executionDirectory, "python-environment.json"); await writeFile(environment, "[]");
    await run("index", runtime, [producer, "index", "--cwd", source, "--project-name", config.package.name, "--project-version", config.package.version, "--environment", environment, "--output", artifact]);
    provider = "scip-python"; producerVersion = "0.6.6";
  } else if (config.language === "go") {
    const go = config.go; if (!go || !/^[a-z0-9]+$/.test(go.os) || !/^[a-z0-9]+$/.test(go.arch) || go.tags?.some(t => !/^[A-Za-z0-9_.]+$/.test(t))) throw Error("Go requires explicit GOOS/GOARCH/build tags");
    const moduleCache = path.join(executionDirectory, "go-modules"); if (go.moduleCache) { const original = await tool(go.moduleCache); await cp(original, moduleCache, { recursive: true, dereference: true }); }
    Object.assign(env, { GOENV: "off", GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOVCS: "*:off", CGO_ENABLED: "0", GOOS: go.os, GOARCH: go.arch, GOROOT: config.runtime.path, GOPATH: path.join(executionDirectory, "go-path"), GOCACHE: path.join(executionDirectory, "go-cache"), GOMODCACHE: moduleCache, GOWORK: "off", GOFLAGS: `-mod=readonly${go.tags?.length ? ` -tags=${go.tags.join(",")}` : ""}` });
    runtimeVersion = await run("runtime-version", runtime, ["version"]); producerVersion = await run("producer-version", producer, ["--version"]);
    if (!/^go version go1\.26\./.test(runtimeVersion) || producerVersion !== "0.2.7") throw Error("Qualified Go producer requires scip-go 0.2.7 / Go 1.26");
    if (!["dedb659aa95faa2bd45c4dd1f0dddba0e6277545a6cdbe9078a76ce38ea37cb3", "fed9c4825132c13e8f4337da097536e3f6dfd90cb12c9f92691a97e59b73d1c3"].includes(await digestFile(producer))) throw Error("Unqualified Go executable; pinned Linux x64 / macOS arm64 artifacts required");
    const checkLocal = (relative: string, base = source) => { const target = path.resolve(base, relative); if (target !== source && !target.startsWith(`${source}${path.sep}`)) throw Error("Go path dependency escapes captured workspace"); };
    for (const file of Object.keys(buildInputs).filter(f => path.posix.basename(f) === "go.mod")) {
      const captured = path.join(source, path.relative(projectRoot, path.join(root, file)));
      const mod = JSON.parse(await run(`module-context:${file}`, runtime, ["mod", "edit", "-json", captured])) as { Replace?: Array<{ New: { Path: string; Version?: string } }> };
      for (const replacement of mod.Replace ?? []) if (!replacement.New.Version) checkLocal(replacement.New.Path, path.dirname(captured));
    }
    try { await lstat(path.join(source, "go.work")); env.GOWORK = path.join(source, "go.work"); const work = JSON.parse(await run("workspace-context", runtime, ["work", "edit", "-json"])) as { Use?: Array<{ DiskPath: string }>; Replace?: Array<{ New: { Path: string; Version?: string } }> }; for (const use of work.Use ?? []) checkLocal(use.DiskPath); for (const replacement of work.Replace ?? []) if (!replacement.New.Version) checkLocal(replacement.New.Path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await run("compiler-check", runtime, ["build", "./..."]);
    await run("index", producer, ["index", "--module-root=.", `--repository-remote=${config.package.name}`, `--module-version=${config.package.version}`, `--go-version=${runtimeVersion.split(" ")[2]}`, "--skip-tests", `--output=${artifact}`, "./..."]);
    provider = "scip-go"; encoding = 1;
  } else if (config.language === "java") {
    const java = config.java; if (!java || !Number.isInteger(java.release) || java.release < 8 || java.release > 21 || java.plugins.length !== 4) throw Error("Java requires an explicit release and four pinned plugin libraries");
    const plugins: string[] = []; for (const receipt of java.plugins) plugins.push(await tool(receipt));
    const required = ["1c7ad1c8361f6ea9f9758e4b55decd4869b0ac7bb8610127aca045173ff590ef", "8c58e069af784b178347849f9b0e127781d9070210201ac6617947ace4f895be", "ab1c627cb9ff6a8b0f05d91ee329c0ef281819ed011a2b2806fa7ea5f16c1006", "780e269712d59ae34b87b702ce26aede7982804299dd56a65aa84bda6c145268"];
    if (java.plugins.some((r, i) => r.sha256 !== required[i]) || await digestFile(producer) !== "a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe") throw Error("Qualified Java producer requires scip-java / javac 0.13.1 and pinned dependencies");
    runtimeVersion = await run("runtime-version", runtime, ["--version"]); if (!/^(?:openjdk|java) 21\./.test(runtimeVersion)) throw Error("Qualified Java runtime requires JDK 21");
    env.JAVA_HOME = config.runtime.path; env.COURSIER_CACHE = path.join(executionDirectory, "coursier-cache");
    const classes = path.join(executionDirectory, "classes"); const shards = path.join(executionDirectory, "shards"); await mkdir(classes); await mkdir(shards);
    if (/\s/.test(source) || /\s/.test(shards)) throw Error("Qualified javac plugin requires a custom index path without whitespace");
    const classpath: string[] = []; const modulePath: string[] = []; for (const r of java.classpath ?? []) classpath.push(await tool(r)); for (const r of java.modulePath ?? []) modulePath.push(await tool(r));
    const args = ["model", "api", "tree", "util", "code"].map(part => `-J--add-exports=jdk.compiler/com.sun.tools.javac.${part}=ALL-UNNAMED`);
    const files = Object.keys(sources).map(file => path.join(source, path.relative(projectRoot, path.join(root, file))));
    await run("compiler-index", path.join(config.runtime.path, "bin", "javac"), [...args, "-proc:none", "-encoding", "UTF-8", "-processorpath", plugins.join(path.delimiter), `-Xplugin:scip -sourceroot:${source} -targetroot:${shards}`, "--release", String(java.release), "-d", classes,
      ...(classpath.length ? ["--class-path", classpath.join(path.delimiter)] : []), ...(modulePath.length ? ["--module-path", modulePath.join(path.delimiter)] : []), ...files]);
    await run("aggregate", runtime, [`-Duser.home=${env.HOME}`, "-jar", producer, "aggregate", `--targetroot=${shards}`, `--output=${artifact}`, "--allow-exporting-global-symbols-from-directory-entries"]);
    provider = "scip-java"; producerVersion = "0.0.0-SNAPSHOT";
  } else {
    const cs = config.csharp; if (!cs?.projects.length || cs.projects.length > 64) throw Error("C# requires 1..64 explicit project variants");
    if (await digestFile(producer) !== "d873fa73099c22143551558d65079c759ba10e3890a01d2dd57c0aa7998424e0") throw Error("Qualified C# producer requires scip-dotnet 0.2.14 net10");
    Object.assign(env, { DOTNET_ROOT: config.runtime.path, DOTNET_CLI_HOME: env.HOME, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_MULTILEVEL_LOOKUP: "0", ImportDirectoryBuildProps: "false", ImportDirectoryBuildTargets: "false", MSBuildEnableWorkloadResolver: "false", NUGET_PACKAGES: path.join(executionDirectory, "nuget-packages") });
    runtimeVersion = await run("runtime-version", runtime, ["--version"]); if (!/^10\.0\./.test(runtimeVersion)) throw Error("Qualified C# runtime requires .NET SDK 10");
    await writeFile(path.join(source, "global.json"), JSON.stringify({ sdk: { version: runtimeVersion, rollForward: "disable" } }));
    const nuget = path.join(source, "NuGet.Config"); await writeFile(nuget, "<configuration><packageSources><clear /></packageSources></configuration>");
    for (const project of cs.projects) {
      if (!safeRelative(project.file) || !project.file.endsWith(".csproj") || !/^[A-Za-z0-9._-]+$/.test(project.assembly) || !/^net(?:8|9|10)\.0$/.test(project.targetFramework) || project.defines?.some(d => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d)) || !buildInputs[path.posix.join(config.root === "." ? "" : config.root, project.file)]) throw Error("Invalid or uncaptured C# project variant");
      const references: string[] = []; for (const r of project.references ?? []) references.push(await tool(r));
      if (project.sources.some(file => !safeRelative(file) || !sources[path.posix.join(config.root === "." ? "" : config.root, file)])) throw Error("C# compile source is not captured");
      if (project.projectReferences?.some(file => !cs.projects.some(p => p.file === file))) throw Error("C# project reference missing selected variant");
      const projectDirectory = path.dirname(path.join(source, project.file)); await mkdir(projectDirectory, { recursive: true });
      const relative = (f: string) => msbuildPath(path.relative(projectDirectory, path.join(source, f)));
      const body = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${project.targetFramework}</TargetFramework><AssemblyName>${xml(project.assembly)}</AssemblyName><EnableDefaultCompileItems>false</EnableDefaultCompileItems><EnableNETAnalyzers>false</EnableNETAnalyzers><RunAnalyzers>false</RunAnalyzers><GenerateAssemblyInfo>false</GenerateAssemblyInfo><GenerateTargetFrameworkAttribute>false</GenerateTargetFrameworkAttribute><DefineConstants>${(project.defines ?? []).join(";")}</DefineConstants></PropertyGroup><ItemGroup>${project.sources.map(f => `<Compile Include="${relative(f)}" />`).join("")}${(project.projectReferences ?? []).map(f => `<ProjectReference Include="${relative(f)}" />`).join("")}${references.map((f, i) => `<Reference Include="declared${i}"><HintPath>${msbuildPath(f)}</HintPath></Reference>`).join("")}</ItemGroup></Project>`;
      await writeFile(path.join(source, project.file), body);
    }
    for (const project of cs.projects) {
      await run(`restore:${project.file}`, runtime, ["restore", path.join(source, project.file), "--configfile", nuget, "-noAutoResponse"]);
      await run(`compiler-check:${project.file}`, runtime, ["build", path.join(source, project.file), "--no-restore", "--disable-build-servers", "-noAutoResponse"]);
    }
    await run("index", runtime, [producer, "index", ...cs.projects.map(p => path.join(source, p.file)), "--working-directory", source, "--output", artifact, "--skip-dotnet-restore", "--allow-global-symbol-definitions", "--exclude", "**/obj/**"]);
    provider = "scip-dotnet"; producerVersion = "0.1.0-SNAPSHOT";
  }
  const prefix = config.root === "." ? undefined : config.root;
  // Artifact metadata is retained verbatim; authenticated distribution version is separate.
  const environment = { language: config.language, configuration: config, runtimeVersion, producerDistribution: { python: "0.6.6", go: "0.2.7", java: "0.13.1", csharp: "0.2.14" }[config.language], artifactReportedVersion: producerVersion, coordinateConvention: config.language === "java" ? "javac-tab-stops-8-utf16" : encoding === 1 ? "utf8" : "utf16", symbolDialect: config.language === "python" ? "scip-python-0.6.6-opaque-lambda-locals" : "scip", tools: receipts.map(r => ({ ...r.receipt, files: r.files, bytes: r.bytes })), capabilities: MANAGED_CAPABILITIES[config.language], selectedFiles: count, sourceBytes: bytes, network: "disabled-by-tool-configuration", effects: "controlled-copy-no-repository-build-scripts", gaps: ["Explicit context, not a claim of equivalence to arbitrary repository builds", "Runtime dispatch, reflection, generated code and metaprogramming remain unqualified", "No kernel sandbox or network firewall is claimed; only trusted pinned tools execute"] };
  const context = digest(canonical([MANAGED_SCIP_VERSION, config, runtimeVersion]));
  const sidecar: ScipManifest = { format: 1, id: `managed-${config.id}`, projectContext: `${config.language}/${context}`, sourceRoot: root, originalProjectRoot: pathToFileURL(source + (config.language === "java" ? path.sep : "")).href,
    indexDigest: await digestFile(artifact), provider: { name: provider, version: producerVersion, basis: "compiler" }, sources, inputs: buildInputs, legacyPositionEncoding: encoding, ...(config.language === "python" ? { externalLocalPolicy: "diagnose" as const } : {}), ...(config.language === "java" ? { enclosingPolicy: "diagnose" as const } : {}), ...(prefix ? { documentPathPrefix: prefix } : {}) };
  const verify = async (signal?: AbortSignal) => {
    for (const [resource, expected] of Object.entries(inputs)) { signal?.throwIfAborted(); if (performance.now() - started > timeout) throw Error("Managed SCIP deadline exceeded before publication"); const file = resource.startsWith("source:") ? path.join(root, resource.slice(7)) : resource.slice(9); if (await digestFile(file, 10 * 1024 ** 3, signal) !== expected) throw Error(`Managed input changed: ${resource}`); }
    // Reenumeration detects added/removed libraries and stub files as well as modified positive inputs.
    for (const r of receipts) if ((await toolReceipt(r.receipt.path, signal)).sha256 !== r.hash) throw Error("Managed tool directory membership changed");
    if ((await inventoryFromDisk(root, directory, 200000, signal)).inventory !== initialInventory.inventory) throw Error("Managed source/config inventory changed during production");
  };
  await writeFile(path.join(executionDirectory, "execution.json"), JSON.stringify({ sidecar, environment, stages }, null, 2));
  const result = await importScip(root, artifact, sidecar, directory, { maxDocuments: 10000, maxIndexBytes: 256 * 1024 ** 2 }, options.signal, { version: MANAGED_SCIP_VERSION, environment, inputs, diagnostics: [], capabilities: MANAGED_CAPABILITIES[config.language], requireAllDocuments: true, verify,
    ...(config.language === "python" ? { parseSymbol: python066Symbol } : {}), ...(config.language === "java" ? { sourceRange: javac0131Range } : {}),
    derive: (store, documents, ctx, fingerprint) => deriveScipNative(store, documents, root, config.language, ctx, fingerprint, options.signal) });
  return { ...result, calls: "partial-declared-static-targets", provider, capabilities: MANAGED_CAPABILITIES[config.language], environment, executionDirectory, stagesMs: stages, totalMs: Math.round(performance.now() - started) };
}
