import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { GraphBuilder } from "../graph/builder.js";
import { nodeId, validateIdentities, withEdgeId } from "../graph/identity.js";
import { GRAPH_SCHEMA_VERSION, type AdapterRun, type AnalysisManifest, type GraphData, type GraphNode } from "../graph/schema.js";
import { resolveRepositoryRoot, scanRepository } from "../repository/repository.js";
import { typescriptAdapter } from "../../adapters/language/typescript/index.js";
import { rustAdapter } from "../../adapters/language/rust/index.js";
import { reactAdapter } from "../../adapters/framework/react/index.js";
import { tauriAdapter } from "../../adapters/framework/tauri/index.js";
import { markdownAdapter } from "../../adapters/artifact/markdown/index.js";
import { packageJsonAdapter } from "../../adapters/artifact/package-json/index.js";
import { cargoTomlAdapter } from "../../adapters/artifact/cargo-toml/index.js";
import { tauriConfigAdapter } from "../../adapters/artifact/tauri-config/index.js";
import { tauriCapabilityAdapter } from "../../adapters/artifact/tauri-capability/index.js";
import { testsAdapter } from "../../adapters/artifact/tests/index.js";
import { semanticLinkerAdapter } from "../../adapters/overlay/semantic-linker/index.js";
import type { AdapterResult, FrameworkAdapter, LanguageAdapter, RepositorySnapshot } from "../adapters/contracts.js";
import { persistGraph } from "../storage/sqlite.js";
import packageJson from "../../../package.json" with { type: "json" };
import { createIndexState, writeIndexState } from "./state.js";

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

async function runAdapter(adapter: LanguageAdapter | FrameworkAdapter, snapshot: RepositorySnapshot, graph: AdapterResult, framework: boolean): Promise<{ result: AdapterResult; run: AdapterRun }> {
  const started = performance.now();
  let detected = false;
  let result: AdapterResult = { nodes: [], edges: [], diagnostics: [], metadata: {} };
  try {
    detected = framework
      ? await (adapter as FrameworkAdapter).detect(snapshot, graph)
      : await (adapter as LanguageAdapter).detect(snapshot);
    if (detected) {
      result = framework ? await (adapter as FrameworkAdapter).analyze(snapshot, graph) : await (adapter as LanguageAdapter).analyze(snapshot);
    }
  } catch (error) {
    result.diagnostics.push({
      code: "adapter-failure",
      severity: "error",
      message: `Adapter ${adapter.name} failed: ${String(error)}`,
      adapter: adapter.name,
      metadata: {},
    });
  }
  return {
    result,
    run: {
      adapter: adapter.name,
      detected,
      durationMs: Math.round(performance.now() - started),
      fileCount: detected ? snapshot.files.length : 0,
      nodeCount: result.nodes.length,
      edgeCount: result.edges.length,
      diagnosticCount: result.diagnostics.length,
    },
  };
}

export async function analyzeRepository(input = ".", options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = performance.now();
  const root = await resolveRepositoryRoot(input);
  const scan = await scanRepository(root);
  const builder = new GraphBuilder();
  builder.merge(baseGraph(scan.snapshot));
  builder.diagnostics.push(...scan.diagnostics);
  const adapterRuns: AdapterRun[] = [];
  for (const adapter of [typescriptAdapter, rustAdapter]) {
    const executed = await runAdapter(adapter, scan.snapshot, builder.result(), false);
    adapterRuns.push(executed.run);
    builder.diagnostics.push(...validateIdentities(executed.result.nodes, executed.result.edges));
    builder.merge(executed.result);
  }
  for (const adapter of [reactAdapter, tauriAdapter]) {
    const executed = await runAdapter(adapter, scan.snapshot, builder.result(), true);
    adapterRuns.push(executed.run);
    builder.diagnostics.push(...validateIdentities(executed.result.nodes, executed.result.edges));
    builder.merge(executed.result);
  }
  for (const adapter of [markdownAdapter, packageJsonAdapter, cargoTomlAdapter, tauriConfigAdapter, tauriCapabilityAdapter, testsAdapter, semanticLinkerAdapter]) {
    const executed = await runAdapter(adapter, scan.snapshot, builder.result(), true);
    adapterRuns.push(executed.run);
    builder.diagnostics.push(...validateIdentities(executed.result.nodes, executed.result.edges));
    builder.merge(executed.result);
  }
  builder.diagnostics.push(...validateIdentities([...builder.nodes.values()], [...builder.edges.values()]));
  const graph: GraphData = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repository: scan.snapshot.repository,
    nodes: [...builder.nodes.values()],
    edges: [...builder.edges.values()],
    diagnostics: builder.diagnostics,
  };
  const outputDirectory = path.resolve(options.output ?? path.join(root, ".prograph"));
  const manifest: AnalysisManifest = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    toolVersion: packageJson.version,
    repositoryRoot: root,
    repositoryIdentity: scan.snapshot.repository.identity,
    ...(scan.snapshot.repository.gitCommit ? { gitCommit: scan.snapshot.repository.gitCommit } : {}),
    generatedAt: new Date().toISOString(),
    enabledAdapters: adapterRuns.filter((run) => run.detected).map((run) => run.adapter),
    scannedFileCount: scan.snapshot.files.length,
    excludedFileCount: scan.excludedFileCount,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    diagnosticCount: graph.diagnostics.length,
    analysisDuration: Math.round(performance.now() - started),
  };
  await mkdir(path.join(outputDirectory, "exports"), { recursive: true });
  await persistGraph(outputDirectory, graph, manifest, adapterRuns);
  await Promise.all([
    writeFile(path.join(outputDirectory, "exports", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "diagnostics.json"), `${JSON.stringify(graph.diagnostics, null, 2)}\n`),
    writeIndexState(outputDirectory, createIndexState(scan.snapshot, manifest)),
  ]);
  return { graph, manifest, adapterRuns, outputDirectory };
}
