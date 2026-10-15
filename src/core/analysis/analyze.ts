import { polyglotAdapters } from "../../adapters/language/polyglot/index.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { GraphBuilder } from "../graph/builder.js";
import { nodeId, validateIdentities, withEdgeId } from "../graph/identity.js";
import { GRAPH_SCHEMA_VERSION, type AdapterRun, type AnalysisManifest, type GraphData, type GraphNode } from "../graph/schema.js";
import { resolveRepositoryRoot, scanRepository } from "../repository/repository.js";
import { typescriptAdapter } from "../../adapters/language/typescript/index.js";
import { rustAdapter } from "../../adapters/language/rust/index.js";
import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import { persistGraph } from "../storage/sqlite.js";
import packageJson from "../../../package.json" with { type: "json" };
import { createIndexState, writeIndexState } from "./state.js";
import { runAdapter } from "./adapter-run.js";
import { deriveOwnedAnalysis } from "../semantic/analysis-passes.js";
import { indexSemanticFoundation } from "../semantic/typescript.js";

export interface AnalyzeOptions {
  output?: string;
}

export interface AnalysisResult {
  graph: GraphData;
  manifest: AnalysisManifest;
  adapterRuns: AdapterRun[];
  outputDirectory: string;
}

function baseGraph(snapshot: RepositorySnapshot): AdapterResult {
  const graph = new GraphBuilder();
  const root: GraphNode = {
    id: nodeId({ repositoryIdentity: snapshot.repository.identity, kind: "repository", qualifiedName: snapshot.repository.root }),
    kind: "repository",
    name: path.basename(snapshot.repository.root),
    qualifiedName: snapshot.repository.root,
    adapter: "repository",
    metadata: {},
  };
  graph.addNode(root);
  const directories = new Map<string, GraphNode>();
  for (const file of snapshot.files) {
    const parts = path.posix.dirname(file) === "." ? [] : path.posix.dirname(file).split("/");
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const current = parts.slice(0, index + 1).join("/");
      let directory = directories.get(current);
      if (!directory) {
        directory = {
          id: nodeId({ repositoryIdentity: snapshot.repository.identity, kind: "directory", qualifiedName: current }),
          kind: "directory",
          name: parts[index]!,
          qualifiedName: current,
          file: current,
          adapter: "repository",
          metadata: {},
        };
        directories.set(current, directory);
        graph.addNode(directory);
        graph.addEdge(withEdgeId({ source: parent.id, target: directory.id, kind: "contains", confidence: "exact", evidence: [{ adapter: "repository", file: current }], metadata: {} }));
      }
      parent = directory;
    }
  }
  return graph.result();
}


export async function analyzeRepository(input = ".", options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = performance.now();
  const root = await resolveRepositoryRoot(input);
  const scan = await scanRepository(root, options.output ? path.resolve(options.output) : undefined);
  const builder = new GraphBuilder();
  builder.merge(baseGraph(scan.snapshot));
  builder.diagnostics.push(...scan.diagnostics);
  const adapterRuns: AdapterRun[] = [];
  for (const adapter of [typescriptAdapter, rustAdapter, ...polyglotAdapters]) {
    const executed = await runAdapter(adapter, scan.snapshot, builder.result(), false);
    adapterRuns.push(executed.run);
    builder.diagnostics.push(...validateIdentities(executed.result.nodes, executed.result.edges));
    builder.merge(executed.result);
  }
  const outputDirectory = path.resolve(options.output ?? path.join(root, ".prograph"));
  await mkdir(outputDirectory, { recursive: true });
  const owned = await deriveOwnedAnalysis(scan.snapshot, builder.result(), path.join(outputDirectory, "semantic.sqlite"));
  builder.merge(owned.result); adapterRuns.push(...owned.adapterRuns);
  builder.diagnostics.push(...validateIdentities([...builder.nodes.values()], [...builder.edges.values()]));
  const repositoryNode = [...builder.nodes.values()].find(node => node.kind === "repository");
  if (repositoryNode) repositoryNode.metadata.analysis = adapterRuns.map(({ adapter, detected, metadata }) => ({ adapter, detected, ...metadata }));
  const graph: GraphData = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repository: scan.snapshot.repository,
    nodes: [...builder.nodes.values()],
    edges: [...builder.edges.values()],
    diagnostics: builder.diagnostics,
  };
  const manifest: AnalysisManifest = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    toolVersion: packageJson.version,
    repositoryRoot: root,
    repositoryIdentity: scan.snapshot.repository.identity,
    ...(scan.snapshot.repository.gitCommit ? { gitCommit: scan.snapshot.repository.gitCommit } : {}),
    generatedAt: new Date().toISOString(),
    adapterRuns,
    enabledAdapters: adapterRuns.filter((run) => run.detected).map((run) => run.adapter),
    scannedFileCount: scan.snapshot.files.length,
    excludedFileCount: scan.excludedFileCount,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    diagnosticCount: graph.diagnostics.length,
    analysisDuration: Math.round(performance.now() - started),
  };
  await mkdir(path.join(outputDirectory, "exports"), { recursive: true });
  const semanticStarted = performance.now();
  try {
    const semantic = await indexSemanticFoundation(scan.snapshot, graph, path.join(outputDirectory, "semantic.sqlite"), owned);
    manifest.semanticCore = { format: 2, status: semantic.coverage.status === "unavailable" ? "unavailable" : "partial", snapshot: semantic.snapshot, context: semantic.context, durationMs: semantic.durationMs };
  } catch (error) {
    manifest.semanticCore = { format: 2, status: "failed", durationMs: Math.round(performance.now() - semanticStarted), reason: String(error) };
    graph.diagnostics.push({ code: "semantic-foundation-failure", severity: "warning", message: String(error), adapter: "semantic-core", metadata: { previousSnapshotIsHistorical: true } });
    manifest.diagnosticCount = graph.diagnostics.length;
  }
  manifest.analysisDuration = Math.round(performance.now() - started);
  await persistGraph(outputDirectory, graph, manifest, adapterRuns);
  await Promise.all([
    writeFile(path.join(outputDirectory, "exports", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "diagnostics.json"), `${JSON.stringify(graph.diagnostics, null, 2)}\n`),
    writeIndexState(outputDirectory, createIndexState(scan.snapshot, manifest)),
  ]);
  return { graph, manifest, adapterRuns, outputDirectory };
}
