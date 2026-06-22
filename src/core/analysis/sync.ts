import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AdapterRun, AnalysisManifest, GraphData } from "../graph/schema.js";
import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import { analyzeRepository } from "./analyze.js";
import { createIndexState, repositoryStatus, writeIndexState, type RepositoryStatus } from "./state.js";
import { scanRepository } from "../repository/repository.js";
import { typescriptAdapter } from "../../adapters/language/typescript/index.js";
import { rustAdapter } from "../../adapters/language/rust/index.js";
import { persistGraph } from "../storage/sqlite.js";
import packageJson from "../../../package.json" with { type: "json" };

export interface SyncResult {
  statusBefore: RepositoryStatus;
  statusAfter: RepositoryStatus;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesReanalyzed: number;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  duration: number;
  incremental: boolean;
  fallbackReason?: string;
  manifest?: AnalysisManifest;
}

function frameworkRelevant(file: string, source: string): boolean {
  return /\.(?:tsx|jsx)$/.test(file) || /(?:@tauri-apps\/api|tauri::|#\s*\[\s*tauri::command|generate_handler!|invoke\s*\(|listen\s*\(|emit\s*\()/m.test(source);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function adapterRunsFor(graph: GraphData, enabledAdapters: string[], fileCount: number): AdapterRun[] {
  return enabledAdapters.map((adapter) => ({
    adapter,
    detected: true,
    durationMs: 0,
    fileCount,
    nodeCount: graph.nodes.filter((node) => node.adapter === adapter).length,
    edgeCount: graph.edges.filter((edge) => edge.evidence.some((item) => item.adapter === adapter)).length,
    diagnosticCount: graph.diagnostics.filter((item) => item.adapter === adapter).length,
  }));
}

function identityChanges(previous: Array<{ id: string }>, current: Array<{ id: string }>): { added: number; removed: number } {
  const previousIds = new Set(previous.map((item) => item.id));
  const currentIds = new Set(current.map((item) => item.id));
  return {
    added: [...currentIds].filter((id) => !previousIds.has(id)).length,
    removed: [...previousIds].filter((id) => !currentIds.has(id)).length,
  };
}

async function tryIsolatedIncremental(status: RepositoryStatus, previous: GraphData, previousManifest: AnalysisManifest, started: number): Promise<SyncResult | undefined> {
  const changedFiles = [...status.addedFiles, ...status.modifiedFiles];
  const affectedFiles = new Set([...changedFiles, ...status.deletedFiles]);
  if (changedFiles.length + status.deletedFiles.length === 0 || changedFiles.length > 10) return undefined;
  const scan = await scanRepository(status.repositoryRoot);
  if (changedFiles.some((file) => frameworkRelevant(file, scan.snapshot.fileContents.get(file) ?? ""))) return undefined;
  const removedIds = new Set(previous.nodes.filter((node) => node.file && affectedFiles.has(node.file)).map((node) => node.id));
  if (previous.edges.some((edge) => removedIds.has(edge.source) !== removedIds.has(edge.target))) return undefined;
  for (const file of status.addedFiles) {
    const directory = path.posix.dirname(file);
    if (directory !== "." && !previous.nodes.some((node) => node.kind === "directory" && node.qualifiedName === directory)) return undefined;
  }
  const sourceFiles = changedFiles.filter((file) => /\.(?:ts|tsx|js|jsx|mts|cts|rs)$/.test(file));
  if (sourceFiles.length !== changedFiles.length) return undefined;
  const partialSnapshot: RepositorySnapshot = {
    ...scan.snapshot,
    files: sourceFiles,
    absoluteFiles: new Map([...scan.snapshot.absoluteFiles].filter(([file]) => sourceFiles.includes(file) || !/\.(?:ts|tsx|js|jsx|mts|cts|rs)$/.test(file))),
    fileContents: new Map([...scan.snapshot.fileContents].filter(([file]) => sourceFiles.includes(file) || !/\.(?:ts|tsx|js|jsx|mts|cts|rs)$/.test(file))),
  };
  const results: AdapterResult[] = [];
  if (sourceFiles.some((file) => /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file))) results.push(await typescriptAdapter.analyze(partialSnapshot));
  if (sourceFiles.some((file) => file.endsWith(".rs"))) results.push(await rustAdapter.analyze(partialSnapshot));
  const partialNodes = results.flatMap((result) => result.nodes);
  const partialEdges = results.flatMap((result) => result.edges);
  if (partialNodes.some((node) => node.kind === "unresolved_symbol" || node.kind.startsWith("framework_"))) return undefined;
  if (partialEdges.some((edge) => edge.confidence === "probable" || edge.confidence === "unresolved" || ["imports", "invokes", "registers", "emits", "listens", "renders", "passes_callback"].includes(edge.kind))) return undefined;
  const retainedNodes = previous.nodes.filter((node) => !removedIds.has(node.id));
  const retainedIds = new Set(retainedNodes.map((node) => node.id));
  const partialIds = new Set(partialNodes.map((node) => node.id));
  const knownEndpoint = (id: string): boolean => retainedIds.has(id) || partialIds.has(id);
  if (partialEdges.some((edge) => !knownEndpoint(edge.source) || !knownEndpoint(edge.target))) return undefined;
  const graph: GraphData = {
    ...previous,
    repository: scan.snapshot.repository,
    nodes: [...retainedNodes, ...partialNodes],
    edges: [...previous.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)), ...partialEdges],
    diagnostics: [...previous.diagnostics.filter((item) => !item.file || !affectedFiles.has(item.file)), ...results.flatMap((result) => result.diagnostics)],
  };
  const manifestBase: AnalysisManifest = { ...previousManifest };
  delete manifestBase.gitCommit;
  const manifest: AnalysisManifest = {
    ...manifestBase,
    toolVersion: packageJson.version,
    repositoryRoot: status.repositoryRoot,
    repositoryIdentity: scan.snapshot.repository.identity,
    ...(scan.snapshot.repository.gitCommit ? { gitCommit: scan.snapshot.repository.gitCommit } : {}),
    generatedAt: new Date().toISOString(),
    scannedFileCount: scan.snapshot.files.length,
    excludedFileCount: scan.excludedFileCount,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    diagnosticCount: graph.diagnostics.length,
    analysisDuration: Math.round(performance.now() - started),
  };
  const nodeChanges = identityChanges(previous.nodes, graph.nodes);
  const edgeChanges = identityChanges(previous.edges, graph.edges);
  await mkdir(path.join(status.indexDirectory, "exports"), { recursive: true });
  await persistGraph(status.indexDirectory, graph, manifest, adapterRunsFor(graph, manifest.enabledAdapters, scan.snapshot.files.length));
  await Promise.all([
    writeFile(path.join(status.indexDirectory, "exports", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`),
    writeFile(path.join(status.indexDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(status.indexDirectory, "diagnostics.json"), `${JSON.stringify(graph.diagnostics, null, 2)}\n`),
    writeIndexState(status.indexDirectory, createIndexState(scan.snapshot, manifest)),
  ]);
  const statusAfter = await repositoryStatus(status.repositoryRoot, status.indexDirectory);
  return {
    statusBefore: status,
    statusAfter,
    filesAdded: status.addedFiles.length,
    filesModified: status.modifiedFiles.length,
    filesDeleted: status.deletedFiles.length,
    filesReanalyzed: sourceFiles.length,
    nodesAdded: nodeChanges.added,
    nodesRemoved: nodeChanges.removed,
    edgesAdded: edgeChanges.added,
    edgesRemoved: edgeChanges.removed,
    duration: Math.round(performance.now() - started),
    incremental: true,
    manifest,
  };
}

export async function syncRepository(input = ".", index?: string): Promise<SyncResult> {
  const started = performance.now();
  const statusBefore = await repositoryStatus(input, index);
  if (!statusBefore.stale) {
    return {
      statusBefore,
      statusAfter: statusBefore,
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesReanalyzed: 0,
      nodesAdded: 0,
      nodesRemoved: 0,
      edgesAdded: 0,
      edgesRemoved: 0,
      duration: Math.round(performance.now() - started),
      incremental: true,
    };
  }
  const [previous, previousManifest] = await Promise.all([
    readJson<GraphData>(path.join(statusBefore.indexDirectory, "exports", "graph.json")),
    readJson<AnalysisManifest>(path.join(statusBefore.indexDirectory, "manifest.json")),
  ]);
  if (previous && previousManifest && !statusBefore.schemaChanged && !statusBefore.adapterVersionsChanged && !statusBefore.configChanged) {
    const incremental = await tryIsolatedIncremental(statusBefore, previous, previousManifest, started);
    if (incremental) return incremental;
  }
  const fallbackReason = statusBefore.schemaChanged
    ? "graph schema changed"
    : statusBefore.adapterVersionsChanged
      ? "adapter version changed"
      : statusBefore.configChanged
        ? "configuration changed"
        : "changed files have dependency, framework, or unresolved relationships requiring a full adapter rebuild";
  const analysis = await analyzeRepository(statusBefore.repositoryRoot, { output: statusBefore.indexDirectory });
  const statusAfter = await repositoryStatus(statusBefore.repositoryRoot, statusBefore.indexDirectory);
  const nodeChanges = identityChanges(previous?.nodes ?? [], analysis.graph.nodes);
  const edgeChanges = identityChanges(previous?.edges ?? [], analysis.graph.edges);
  return {
    statusBefore,
    statusAfter,
    filesAdded: statusBefore.addedFiles.length,
    filesModified: statusBefore.modifiedFiles.length,
    filesDeleted: statusBefore.deletedFiles.length,
    filesReanalyzed: analysis.manifest.scannedFileCount,
    nodesAdded: nodeChanges.added,
    nodesRemoved: nodeChanges.removed,
    edgesAdded: edgeChanges.added,
    edgesRemoved: edgeChanges.removed,
    duration: Math.round(performance.now() - started),
    incremental: false,
    fallbackReason,
    manifest: analysis.manifest,
  };
}
