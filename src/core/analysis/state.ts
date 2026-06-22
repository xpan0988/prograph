import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AnalysisManifest } from "../graph/schema.js";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import { GRAPH_SCHEMA_VERSION } from "../graph/schema.js";
import { resolveRepositoryRoot, scanRepository } from "../repository/repository.js";
import packageJson from "../../../package.json" with { type: "json" };

export const ADAPTER_VERSIONS = {
  typescript: "1",
  rust: "3",
  react: "1",
  tauri: "2",
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
  return hash(JSON.stringify({
    include: snapshot.config.include,
    exclude: snapshot.config.exclude,
    adapters: snapshot.config.adapters,
  }));
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
  const [stored, manifest, scan] = await Promise.all([
    readJson<IndexState>(path.join(indexDirectory, "state.json")),
    readJson<AnalysisManifest>(path.join(indexDirectory, "manifest.json")),
    scanRepository(repositoryRoot),
  ]);
  const currentFiles = fileHashes(scan.snapshot);
  const indexedFiles = stored?.files ?? {};
  const addedFiles = Object.keys(currentFiles).filter((file) => !(file in indexedFiles)).sort();
  const modifiedFiles = Object.keys(currentFiles).filter((file) => indexedFiles[file] !== undefined && indexedFiles[file] !== currentFiles[file]).sort();
  const deletedFiles = Object.keys(indexedFiles).filter((file) => !(file in currentFiles)).sort();
  const configChanged = stored ? stored.configHash !== configHash(scan.snapshot) : false;
  const adapterVersionsChanged = stored ? JSON.stringify(stored.adapterVersions) !== JSON.stringify(ADAPTER_VERSIONS) : false;
  const schemaChanged = stored ? stored.schemaVersion !== GRAPH_SCHEMA_VERSION : false;
  const stale = !stored || addedFiles.length > 0 || modifiedFiles.length > 0 || deletedFiles.length > 0 || configChanged || adapterVersionsChanged || schemaChanged;
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
    stale,
    state: stored ? stale ? "stale" : "fresh" : "missing",
  };
}
