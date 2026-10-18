import { openAuthorityObservation, type AuthorityObservation } from "../semantic/authority.js";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AnalysisManifest } from "../graph/schema.js";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import { GRAPH_SCHEMA_VERSION } from "../graph/schema.js";
import { resolveRepositoryRoot, scanRepository } from "../repository/repository.js";
import packageJson from "../../../package.json" with { type: "json" };
import { SEMANTIC_SCHEMA_VERSION, TYPESCRIPT_SEMANTIC_VERSION, CLANG_SEMANTIC_VERSION, SCIP_SEMANTIC_VERSION, RUST_PROVIDER_VERSION, MANAGED_SCIP_VERSION } from "../semantic/model.js";
import { recordedInputStatus, type RecordedInputStatus } from "../semantic/provider-runs.js";
import { PROJECT_DISCOVERY_VERSION } from "../semantic/projects.js";
import { ANALYSIS_PASS_VERSIONS } from "../semantic/analysis-versions.js";
import { canonical, digest } from "../semantic/model.js";
import { snapshotReportStatus, type SnapshotReportStatus } from "../semantic/snapshot-report.js";

import { OWNED_PASS_VERSION } from "../semantic/owned-projection.js";

const require = createRequire(import.meta.url);

export const ADAPTER_VERSIONS = {
  globalQueries: "1",
  projectDiscovery: PROJECT_DISCOVERY_VERSION,
  ownedPasses: `${OWNED_PASS_VERSION}/${digest(canonical(ANALYSIS_PASS_VERSIONS))}`,
  semanticCore: `${SEMANTIC_SCHEMA_VERSION}/ts:${TYPESCRIPT_SEMANTIC_VERSION}/clang:${CLANG_SEMANTIC_VERSION}/scip:${SCIP_SEMANTIC_VERSION}/rust:${RUST_PROVIDER_VERSION}/managed:${MANAGED_SCIP_VERSION}`,
  typescript: "4",
  polyglot: "1",
  architecture: "1",
  providers: JSON.stringify(["tree-sitter", "tree-sitter-python", "tree-sitter-java", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-go", "tree-sitter-c-sharp", "tree-sitter-rust", "ts-morph", "typescript", "yaml", "graphql", "protobufjs"].map(name => [name, require(`${name}/package.json`).version])),
  rust: "4",
  react: "1",
  tauri: "3",
  markdown: "1",
  packageJson: "1",
  cargoToml: "1",
  tauriConfig: "1",
  tauriCapability: "1",
  tests: "1",
  semanticLinker: "1",
} as const;

export interface IndexState {
  schemaVersion: string;
  toolVersion: string;
  generatedAt: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  gitCommit?: string;
  configHash: string;
  adapterVersions: Record<string, string>;
  files: Record<string, string>;
}

export interface RepositoryStatus {
  repositoryRoot: string;
  indexDirectory: string;
  indexedCommit?: string;
  currentCommit?: string;
  indexGeneratedAt?: string;
  schemaVersion?: string;
  toolVersion?: string;
  enabledAdapters: string[];
  indexedFileCount: number;
  currentSupportedFileCount: number;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  configChanged: boolean;
  adapterVersionsChanged: boolean;
  schemaChanged: boolean;
  repositoryChanged?: boolean;
  semanticPublication?: SnapshotReportStatus;
  authority?: "semantic" | "legacy";
  semanticInputsChanged?: boolean;
  semanticInputs?: RecordedInputStatus;
  stale: boolean;
  state: "fresh" | "stale" | "missing";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileHashes(snapshot: RepositorySnapshot): Record<string, string> {
  return Object.fromEntries([...snapshot.fileContents.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, content]) => [file, hash(content)]));
}

function configHash(snapshot: RepositorySnapshot): string {
  return hash(canonical({ config: snapshot.config, configurationInput: snapshot.configurationInput ?? "not-captured" }));
}

export function createIndexState(snapshot: RepositorySnapshot, manifest: AnalysisManifest): IndexState {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    toolVersion: packageJson.version,
    generatedAt: manifest.generatedAt,
    repositoryRoot: snapshot.repository.root,
    repositoryIdentity: snapshot.repository.identity,
    ...(snapshot.repository.gitCommit ? { gitCommit: snapshot.repository.gitCommit } : {}),
    configHash: configHash(snapshot),
    adapterVersions: ADAPTER_VERSIONS,
    files: fileHashes(snapshot),
  };
}

export async function writeIndexState(outputDirectory: string, state: IndexState): Promise<void> {
  await writeFile(path.join(outputDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function repositoryStatus(input = ".", index?: string): Promise<RepositoryStatus> {
  const repositoryRoot = await resolveRepositoryRoot(input);
  const requestedIndex = path.resolve(index ?? path.join(repositoryRoot, ".prograph"));
  const indexDirectory = requestedIndex.endsWith(".sqlite") ? path.dirname(requestedIndex) : requestedIndex;
  let authority: AuthorityObservation | undefined, authorityFailure: string | undefined;
  try { authority = openAuthorityObservation(requestedIndex); } catch (error) { authorityFailure=String(error).slice(0,320); }
  const semanticAuthority=!!authority || !!authorityFailure;
  try {
  const [legacyStored, legacyManifest, scan] = await Promise.all([
    semanticAuthority ? Promise.resolve(undefined) : readJson<IndexState>(path.join(indexDirectory, "state.json")),
    semanticAuthority ? Promise.resolve(undefined) : readJson<AnalysisManifest>(path.join(indexDirectory, "manifest.json")),
    scanRepository(repositoryRoot, indexDirectory),
  ]);
  const stored=semanticAuthority?authority?.state:legacyStored, manifest=semanticAuthority?authority?.report?.manifest:legacyManifest;
  const currentFiles = fileHashes(scan.snapshot);
  const indexedFiles = stored?.files ?? {};
  const addedFiles = Object.keys(currentFiles).filter((file) => !(file in indexedFiles)).sort();
  const modifiedFiles = Object.keys(currentFiles).filter((file) => indexedFiles[file] !== undefined && indexedFiles[file] !== currentFiles[file]).sort();
  const deletedFiles = Object.keys(indexedFiles).filter((file) => !(file in currentFiles)).sort();
  const configChanged = stored ? stored.configHash !== configHash(scan.snapshot) : false;
  const adapterVersionsChanged = stored ? canonical(stored.adapterVersions) !== canonical(ADAPTER_VERSIONS) : false;
  const schemaChanged = stored ? stored.schemaVersion !== GRAPH_SCHEMA_VERSION : false;
  const repositoryChanged = !!stored && (stored.repositoryRoot !== scan.snapshot.repository.root || stored.repositoryIdentity !== scan.snapshot.repository.identity);
  const { files: _files, ...stateHeader } = stored ?? { files: {} };
  const semanticPublication: SnapshotReportStatus = semanticAuthority ? authority?.report && authority.state ? {state:"matches-semantic-snapshot",snapshot:authority.snapshot!} : {state:authorityFailure?"unavailable":"unreported",...(authority?.snapshot===undefined?{}:{snapshot:authority.snapshot}),...((authorityFailure??authority?.reason)?{reason:authorityFailure??authority?.reason!}:{})} : snapshotReportStatus(path.join(indexDirectory, "semantic.sqlite"), manifest, stored ? stateHeader as Omit<IndexState, "files"> : undefined);
  const semanticInputs: RecordedInputStatus = authorityFailure ? {state:"unavailable",checked:0,additionalChanges:0,reason:authorityFailure} : await recordedInputStatus(authority?.filename ?? path.join(indexDirectory, "semantic.sqlite"), scan.snapshot, new Set([...addedFiles, ...modifiedFiles, ...deletedFiles]), authority?.db);
  const semanticInputsChanged = semanticInputs.additionalChanges > 0 || (semanticAuthority || !!manifest?.semanticCore) && ["unavailable", "unchecked"].includes(semanticInputs.state);
  const publicationChanged = semanticAuthority && (!authority?.report || !!authority.reason || authority.attempt?.status === "failed") || semanticPublication.state === "out-of-sync" || !!manifest?.semanticCore && (manifest.semanticCore.status === "failed" || semanticPublication.state === "unavailable");
  const stale = !stored || addedFiles.length > 0 || modifiedFiles.length > 0 || deletedFiles.length > 0 || configChanged || adapterVersionsChanged || schemaChanged || semanticInputsChanged || repositoryChanged || publicationChanged;
  return {
    repositoryRoot,
    indexDirectory,
    ...(stored?.gitCommit ? { indexedCommit: stored.gitCommit } : {}),
    ...(scan.snapshot.repository.gitCommit ? { currentCommit: scan.snapshot.repository.gitCommit } : {}),
    ...(stored?.generatedAt ? { indexGeneratedAt: stored.generatedAt } : {}),
    ...(stored?.schemaVersion ? { schemaVersion: stored.schemaVersion } : {}),
    ...(stored?.toolVersion ? { toolVersion: stored.toolVersion } : {}),
    enabledAdapters: manifest?.enabledAdapters ?? [],
    indexedFileCount: Object.keys(indexedFiles).length,
    currentSupportedFileCount: Object.keys(currentFiles).length,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    configChanged,
    adapterVersionsChanged,
    schemaChanged,
    repositoryChanged,
    authority:semanticAuthority?"semantic":"legacy",
    semanticPublication,
    semanticInputsChanged,
    semanticInputs,
    stale,
    state: stored ? stale ? "stale" : "fresh" : semanticAuthority ? "stale" : "missing",
  };
  } finally {authority?.close();}
}
