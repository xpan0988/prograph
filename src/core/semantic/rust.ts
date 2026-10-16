import path from "node:path";
import os from "node:os";
import { mkdir, lstat, realpath, writeFile, symlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { scanRepository, resolveRepositoryRoot } from "../repository/repository.js";
import { boundedInput, digestFile } from "./inputs.js";
import { canonical, digest, RUST_PROVIDER_VERSION } from "./model.js";
import { importScip, type ScipManifest } from "./scip-import.js";
import { runProviderProcess } from "./process.js";
import { qualifyRustAnalyzer } from "./rust-qualification.js";
import { deriveScipNative } from "./scip-native.js";
import { inventoryFromDisk } from "./provider-runs.js";
import { inputMatches } from "./input-check.js";
import type { ProviderPreparation } from "./provider-plan.js";
import { authorizeProvider, verifyProviderAuthorization } from "./provider-grants.js";

export { RUST_PROVIDER_VERSION } from "./model.js";
export const RUST_PROVIDER_CAPABILITIES = { symbols: "partial", definitions: "partial", references: "partial", imports: "partial", calls: "partial-declared-static-targets", types: "reported-signatures", traits: "reported-symbols", associatedItems: "reported-symbols", macros: "unqualified", dynamicDispatch: "unsupported" } as const;
export interface RustOptions extends ProviderPreparation {
  analyzer: string;
  analyzerSha256: string;
  toolchain: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  target?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface Package {
  id: string; name: string; version: string; manifest_path: string;
  targets: Array<{ kind: string[]; crate_types: string[]; src_path: string }>;
}
interface CargoMetadata {
  workspace_root: string; workspace_members: string[]; packages: Package[];
  resolve: { nodes: Array<{ id: string; features: string[]; deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }> }> } | null;
}

/** Explicit, offline execution in a persistent isolated copy. No indexer runs during discovery/sync. */
export async function indexRust(repository: string, manifestFile: string, options: RustOptions, index?: string): Promise<Record<string, unknown>> {
  const started = performance.now(); const timeout = options.timeoutMs ?? 120000;
  if (process.platform === "win32") throw Error("Rust managed process-tree cancellation is not qualified on Windows");
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600000) throw Error("Rust deadline must be 100..600000ms");
  if (!path.isAbsolute(options.analyzer) || !path.isAbsolute(options.toolchain) || !/^[a-f0-9]{64}$/.test(options.analyzerSha256)) throw Error("Rust requires explicit absolute analyzer/toolchain paths and a pinned analyzer digest");
  const features = [...new Set(options.features ?? [])].sort();
  if (features.length > 128 || features.some(feature => !/^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,255}$/.test(feature)) || options.target && !/^[A-Za-z0-9_-]{1,128}$/.test(options.target)) throw Error("Unsupported Rust feature/target selection");
  if (await digestFile(options.analyzer) !== options.analyzerSha256) throw Error("Rust analyzer digest mismatch");
  const root = await resolveRepositoryRoot(repository); const directory = path.resolve(index?.endsWith(".sqlite") ? path.dirname(index) : index ?? path.join(root, ".prograph"));
  const cargo = path.join(options.toolchain, "cargo"), rustc = path.join(options.toolchain, "rustc");
  const toolInputs = { [`physical:${options.analyzer}`]: options.analyzerSha256, [`physical:${cargo}`]: await digestFile(cargo), [`physical:${rustc}`]: await digestFile(rustc) };
  const trust = digest(canonical([options.analyzer, options.toolchain, toolInputs]));
  if (options.authorization && (!await verifyProviderAuthorization(options.authorization, root, directory) || options.authorization.kind !== "rust" || options.authorization.trust !== trust)) throw Error("Rust tool inputs changed; explicit requalification required");
  const searches: Record<string, string> = {};
  const noCargoConfig = async (file: string, ambient = false) => {
    try { await stat(file); throw Error(`Managed Rust ${ambient ? "ambient " : ""}Cargo configuration is not qualified`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; searches[`probe-present:${file}`] = digest("false"); }
  };
  const initialInventory = await inventoryFromDisk(root, directory, 200000, options.signal);
  const scan = await scanRepository(root, directory);
  const manifest = path.relative(root, path.resolve(root, manifestFile)).split(path.sep).join("/");
  if (manifest.startsWith("../") || !scan.snapshot.fileContents.has(manifest) || !manifest.endsWith("Cargo.toml")) throw Error("Selected Rust manifest is not in the repository inventory");
  const files = scan.snapshot.files.filter(file => /\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$/.test(file));
  if (files.length > 1000) throw Error("Rust source/input catalogue exceeds 1000 files");
  // Cargo config may invoke wrappers/tools or change resolution. Do not silently ignore it.
  for (const file of files.filter(file => file.endsWith("Cargo.toml"))) {
    let parent = path.dirname(path.join(root, file));
    while (parent === root || parent.startsWith(`${root}${path.sep}`)) {
      for (const name of ["config", "config.toml"]) await noCargoConfig(path.join(parent, ".cargo", name));
      if (parent === root) break; parent = path.dirname(parent);
    }
  }
  await mkdir(directory, { recursive: true });
  const runDirectory = path.join(await realpath(directory), "providers", "rust", randomUUID()); const sourceRoot = path.join(runDirectory, "source"); const cargoHome = path.join(runDirectory, "cargo-home");
  await mkdir(sourceRoot, { recursive: true }); await mkdir(cargoHome);
  // Cargo also searches cwd ancestors outside CARGO_HOME (including custom index parents).
  for (let parent = sourceRoot;; parent = path.dirname(parent)) {
    for (const name of ["config", "config.toml"]) {
      await noCargoConfig(path.join(parent, ".cargo", name), true);
    }
    if (path.dirname(parent) === parent) break;
  }
  // Reuse only cache directories, never credential/config files; networking stays offline.
  for (const name of ["registry", "git"]) { const cache = path.join(os.homedir(), ".cargo", name); try { await stat(cache); await symlink(cache, path.join(cargoHome, name), "dir"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  const inputs: Record<string, string> = { ...toolInputs, ...searches }; const sources: Record<string, string> = {}; const buildInputs: Record<string, string> = {}; let sourceBytes = 0;
  for (const file of files) {
    options.signal?.throwIfAborted(); const original = path.join(root, file); const info = await lstat(original);
    if (!info.isFile() || info.isSymbolicLink() || !(await realpath(original)).startsWith(`${await realpath(root)}${path.sep}`)) throw Error("Rust source escapes repository");
    const bytes = await boundedInput(original, 8 * 1024 ** 2); sourceBytes += bytes.length;
    if (sourceBytes > 32 * 1024 ** 2) throw Error("Rust source copy exceeds 32 MiB");
    const expected = digest(bytes); inputs[`source:${file}`] = expected;
    if (file.endsWith(".rs")) sources[file] = expected; else buildInputs[file] = expected;
    const destination = path.join(sourceRoot, file); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  }
  const env = { PATH: `${options.toolchain}${path.delimiter}/usr/bin${path.delimiter}/bin`, CARGO_HOME: cargoHome, CARGO_NET_OFFLINE: "true", CARGO_TARGET_DIR: path.join(runDirectory, "target"), RUSTC: rustc, LANG: "C", TMPDIR: runDirectory };
  const stages: Record<string, number> = {};
  const run = async (name: string, executable: string, args: string[], cwd = sourceRoot) => {
    const remaining = Math.floor(timeout - (performance.now() - started)); if (remaining <= 0) throw Error("Rust provider total deadline exceeded");
    const result = await runProviderProcess(executable, args, cwd, env, { timeoutMs: remaining, maxOutputBytes: 4 * 1024 ** 2, ...(options.signal ? { signal: options.signal } : {}) }); stages[name] = +result.durationMs.toFixed(3); return result;
  };
  const analyzerVersion = (await run("analyzer-probe", options.analyzer, ["--version"])).stdout.trim();
  const analyzerQualification = qualifyRustAnalyzer(analyzerVersion, options.analyzerSha256);
  const rustcVersion = (await run("rustc-probe", rustc, ["-vV"])).stdout.trim(); const cargoVersion = (await run("cargo-probe", cargo, ["--version"])).stdout.trim();
  const target = options.target ?? rustcVersion.match(/^host: (.+)$/m)?.[1]; if (!target) throw Error("Rust compiler host target unavailable");
  const selectedManifest = path.join(sourceRoot, manifest);
  const featureArgs = [...(features.length ? ["--features", features.join(",")] : []), ...(options.noDefaultFeatures ? ["--no-default-features"] : [])];
  // Resolve a missing lock only inside our copy, then use locked metadata/check thereafter.
  if (!files.some(file => file.endsWith("Cargo.lock"))) await run("lock", cargo, ["generate-lockfile", "--offline", "--manifest-path", selectedManifest]);
  const metadata = JSON.parse((await run("metadata", cargo, ["metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", target, "--manifest-path", selectedManifest, ...featureArgs])).stdout) as CargoMetadata;
  if (!metadata.resolve || !metadata.workspace_root.startsWith(`${sourceRoot}${path.sep}`) && metadata.workspace_root !== sourceRoot) throw Error("Rust workspace escaped captured source");
  const byId = new Map(metadata.packages.map(pkg => [pkg.id, pkg])); const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const closure = new Set<string>(); const queue = [...metadata.workspace_members];
  while (queue.length) {
    const id = queue.pop()!; if (closure.has(id)) continue; closure.add(id); const pkg = byId.get(id);
    if (!pkg || !pkg.manifest_path.startsWith(`${sourceRoot}${path.sep}`)) throw Error("Managed Rust external dependency environments are not yet qualified; use declared SCIP input instead");
    if (pkg.targets.some(t => t.kind.includes("custom-build") || t.kind.includes("proc-macro"))) throw Error("Managed Rust build scripts/proc macros are unsupported; no build executed");
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind === null || kind.kind === "build")) queue.push(dep.pkg);
  }
  const prefix = path.relative(sourceRoot, metadata.workspace_root).split(path.sep).join("/");
  const compiler = await run("compiler-check", cargo, ["check", "--workspace", "--offline", "--locked", "--target", target, "--manifest-path", selectedManifest, ...featureArgs]);
  const cfg = (await run("target-cfg", rustc, ["--print", "cfg", "--target", target])).stdout.trim().split("\n").sort();
  const lock = path.join(metadata.workspace_root, "Cargo.lock"); const lockDigest = await digestFile(lock); inputs[`physical:${lock}`] = lockDigest;
  const config = { cargo: { sysroot: null, setTest: false, allTargets: false, target, features, noDefaultFeatures: !!options.noDefaultFeatures, extraArgs: ["--offline", "--locked"], extraEnv: env, buildScripts: { overrideCommand: ["/usr/bin/true"] } }, procMacro: { enable: false } };
  const configFile = path.join(runDirectory, "analyzer-config.json"); await writeFile(configFile, JSON.stringify(config)); inputs[`physical:${configFile}`] = await digestFile(configFile);
  const artifact = path.join(runDirectory, "index.scip");
  const extracted = await run("semantic-producer", options.analyzer, ["scip", metadata.workspace_root, "--output", artifact, "--config-path", configFile, "--exclude-vendored-libraries", "--num-threads", "1"]);
  if ((await stat(artifact)).size > 64 * 1024 ** 2) throw Error("Rust SCIP artifact exceeds 64 MiB");
  const environment = { provider: "rust-analyzer", analyzerVersion, analyzerQualification, analyzerSha256: options.analyzerSha256, cargoVersion, rustcVersion, target, cfg, features, noDefaultFeatures: !!options.noDefaultFeatures, lockDigest,
    packages: [...closure].sort().map(id => { const pkg = byId.get(id)!; return { name: pkg.name, version: pkg.version, manifest: path.relative(sourceRoot, pkg.manifest_path).split(path.sep).join("/"), features: [...(nodes.get(id)?.features ?? [])].sort(), targets: pkg.targets.map(t => ({ kinds: t.kind, source: path.relative(sourceRoot, t.src_path).split(path.sep).join("/") })) }; }), capabilities: RUST_PROVIDER_CAPABILITIES,
    gaps: ["Rust sysroot semantic sources, external normal dependencies, build scripts and proc macros are not qualified", "SCIP supplies navigation/signatures, not call targets, borrow checking or trait obligations", "Enclosing ranges are advisory and invalid values are diagnosed; primary ranges remain strict", "Explicit pinned toolchain; no rustup installations or source repository writes"], sourceFiles: files.length, sourceBytes, compilerChecked: true };
  const identity = digest(canonical([RUST_PROVIDER_VERSION, prefix, features, !!options.noDefaultFeatures, target]));
  const { sourceFiles: _sourceFiles, sourceBytes: _sourceBytes, ...semanticEnvironment } = environment;
  const context = digest(canonical([RUST_PROVIDER_VERSION, semanticEnvironment, buildInputs, inputs[`physical:${cargo}`], inputs[`physical:${rustc}`]]));
  await writeFile(path.join(runDirectory, "execution.json"), JSON.stringify({ environment, stages }, null, 2));
  const sidecar: ScipManifest = { format: 1, id: `rust-${identity.slice(0, 32)}`, projectContext: `rust/${context}`, sourceRoot: root, indexDigest: await digestFile(artifact),
    originalProjectRoot: `file://${metadata.workspace_root}`, provider: { name: "rust-analyzer", version: analyzerVersion.replace(/^rust-analyzer /, ""), basis: "lsp" }, sources, inputs: buildInputs,
    ...(prefix ? { documentPathPrefix: prefix } : {}), enclosingPolicy: "diagnose" };
  const verify = async (signal?: AbortSignal) => {
    signal?.throwIfAborted(); if (performance.now() - started > timeout) throw Error("Rust provider total deadline exceeded before publication");
    for (const [resource, expected] of Object.entries(inputs)) if (!await inputMatches({ resource, digest: expected }, root, signal)) throw Error(`Rust recorded input changed: ${resource}`);
    if ((await inventoryFromDisk(root, directory, 200000, signal)).inventory !== initialInventory.inventory) throw Error("Rust source/config inventory changed during production");
    signal?.throwIfAborted(); if (performance.now() - started > timeout) throw Error("Rust provider total deadline exceeded before publication");
  };
  await verify(options.signal);
  const recipeOptions = { analyzer: options.analyzer, analyzerSha256: options.analyzerSha256, toolchain: options.toolchain, features, noDefaultFeatures: !!options.noDefaultFeatures, target, timeoutMs: timeout };
  const registration = await authorizeProvider({ key: `rust-${digest(canonical([manifest, features, !!options.noDefaultFeatures, target])).slice(0, 32)}`, kind: "rust", recipe: { manifest, options: recipeOptions, prefix: `scip/${sidecar.id}` }, trust, version: RUST_PROVIDER_VERSION }, root, directory);
  const imported = await importScip(root, artifact, sidecar, directory, { maxIndexBytes: 64 * 1024 ** 2, maxDocuments: 1000 }, options.signal,
    { version: RUST_PROVIDER_VERSION, environment, inputs, diagnostics: [compiler.stderr, extracted.stderr].filter(Boolean).map(message => message.slice(0, 2048)), requireAllDocuments: true, verify,
      registration, ...(options.prepare ? { prepare: options.prepare } : {}),
      derive: (store, documents, ctx, fingerprint) => deriveScipNative(store, documents, root, "rust", ctx, fingerprint, options.signal) });
  return { ...imported, calls: "partial-declared-static-targets", provider: "rust-analyzer", capabilities: RUST_PROVIDER_CAPABILITIES, environment, executionDirectory: runDirectory, stagesMs: stages, totalMs: Math.round(performance.now() - started) };
}
