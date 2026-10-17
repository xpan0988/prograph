import type { Diagnostic, GraphEdge, GraphNode, RepositoryMetadata } from "../graph/schema.js";
import type { LoadedConfig } from "../config/config.js";

export interface RepositorySnapshot {
  /** Physical source root observed before discovery; retained separately from logical repository identity. */
  sourceRoot?: string;
  /** Captured raw ProGraph configuration, even when excluded from source globs. */
  configurationInput?: string;
  repository: RepositoryMetadata;
  config: LoadedConfig;
  files: string[];
  absoluteFiles: Map<string, string>;
  fileContents: Map<string, string>;
}

export interface AdapterResult {
  /** Extraction input tracking; independent of semantic/build completeness. */
  inputReceipt?: { qualified: boolean; inputs: Array<{ resource: string; digest: string }> };
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  metadata: Record<string, unknown>;
}

export interface LanguageAdapter {
  name: string;
  version?: string;
  appliesTo?(file: string): boolean;
  capabilities?: import("./providers.js").Capabilities;
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
