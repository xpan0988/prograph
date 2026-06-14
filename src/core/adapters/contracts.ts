import type { Diagnostic, GraphEdge, GraphNode, RepositoryMetadata } from "../graph/schema.js";
import type { LoadedConfig } from "../config/config.js";

export interface RepositorySnapshot {
  repository: RepositoryMetadata;
  config: LoadedConfig;
  files: string[];
  absoluteFiles: Map<string, string>;
  fileContents: Map<string, string>;
}

export interface AdapterResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  metadata: Record<string, unknown>;
}

export interface LanguageAdapter {
  name: string;
  detect(snapshot: RepositorySnapshot): Promise<boolean>;
  analyze(snapshot: RepositorySnapshot): Promise<AdapterResult>;
}

export interface FrameworkAdapter {
  name: string;
  detect(snapshot: RepositorySnapshot, graph: AdapterResult): Promise<boolean>;
  analyze(snapshot: RepositorySnapshot, graph: AdapterResult): Promise<AdapterResult>;
}

export function emptyAdapterResult(): AdapterResult {
  return { nodes: [], edges: [], diagnostics: [], metadata: {} };
}
