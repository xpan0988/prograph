export const GRAPH_SCHEMA_VERSION = "1.0.0";

export const NODE_KINDS = [
  "repository",
  "directory",
  "file",
  "module",
  "function",
  "method",
  "class",
  "interface",
  "type_alias",
  "react_component",
  "struct",
  "enum",
  "trait",
  "framework_command",
  "framework_event",
  "external_package",
  "unresolved_symbol",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "contains",
  "imports",
  "calls",
  "renders",
  "uses_type",
  "passes_callback",
  "extends",
  "implements",
  "registers",
  "invokes",
  "emits",
  "listens",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];
export type Confidence = "exact" | "resolved" | "probable" | "unresolved";
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface SourceEvidence {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  adapter: string;
  matchedSyntax?: string;
  bindingName?: string;
  resolutionMethod?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  language?: string;
  file?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  adapter: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: Confidence;
  evidence: SourceEvidence[];
  metadata: Record<string, unknown>;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  adapter?: string;
  metadata: Record<string, unknown>;
}

export interface GraphData {
  schemaVersion: string;
  repository: RepositoryMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export interface RepositoryMetadata {
  root: string;
  identity: string;
  gitCommit?: string;
}

export interface AdapterRun {
  adapter: string;
  detected: boolean;
  durationMs: number;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  diagnosticCount: number;
}

export interface AnalysisManifest {
  schemaVersion: string;
  toolVersion: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  gitCommit?: string;
  generatedAt: string;
  enabledAdapters: string[];
  scannedFileCount: number;
  excludedFileCount: number;
  nodeCount: number;
  edgeCount: number;
  diagnosticCount: number;
  analysisDuration: number;
}
