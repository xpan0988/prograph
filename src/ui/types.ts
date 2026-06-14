import type { Diagnostic, GraphEdge, GraphNode } from "../core/graph/schema";
import type { TranslationKey } from "./i18n/en";

export type View = "architecture" | "dependencies" | "symbols" | "framework" | "context" | "affected" | "diagnostics";
export type ConfidenceLevel = "trusted" | "probable" | "unresolved";
export type EvidenceMode = "compact" | "standard" | "full";
export type RepositoryState = "fresh" | "stale" | "missing" | "checking" | "syncing" | "error";

export interface Overview {
  repository: { root?: string; identity?: string };
  counts: { files: number; nodes: number; edges: number; diagnostics: number };
  nodesByKind: Array<{ kind: string; count: number }>;
  edgesByKind: Array<{ kind: string; count: number }>;
  adapters: Array<{ adapter: string; detected: number; durationMs: number; nodeCount: number; edgeCount: number; diagnosticCount: number }>;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
  center?: GraphNode;
}

export interface RepositoryStatus {
  state: "fresh" | "stale" | "missing";
  stale: boolean;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
}

export interface FileSummary {
  path: string;
  language: string;
  nodeCount: number;
  outgoingCount?: number;
  incomingCount?: number;
}

export interface ContextResult {
  task: string;
  files: Array<{ file: string; score: number; reasons: string[] }>;
  symbols: Array<{ node: GraphNode; score: number; reasons: string[] }>;
  relationships: GraphEdge[];
  relatedTests: string[];
}

export interface AffectedResult {
  roots: GraphNode[];
  directlyAffectedSymbols: GraphNode[];
  transitivelyAffectedSymbols: GraphNode[];
  affectedFiles: string[];
  relatedTests: string[];
  frameworkBoundariesCrossed: string[];
  relationships: GraphEdge[];
  confidenceSummary: Record<string, number>;
}

export interface ErrorNotice {
  operation: TranslationKey;
  message: string;
  messageKey?: TranslationKey;
  fingerprint: string;
}

export interface AppData {
  overview?: Overview;
  files: FileSummary[];
  diagnostics: Diagnostic[];
}
