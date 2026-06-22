import type { GraphEdge, GraphNode, SourceEvidence } from "../graph/schema.js";

export type OutputMode = "compact" | "standard" | "full";

export interface OutputModeOptions {
  mode?: OutputMode;
  maxEvidence?: number;
}

function isGraphNode(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && typeof value.kind === "string" && typeof value.name === "string" && typeof value.adapter === "string";
}

function isGraphEdge(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && typeof value.source === "string" && typeof value.target === "string" && typeof value.confidence === "string";
}

function evidencePointer(evidence: SourceEvidence): Record<string, unknown> {
  return {
    ...(evidence.file ? { file: evidence.file } : {}),
    ...(evidence.line !== undefined ? { line: evidence.line } : {}),
    ...(evidence.column !== undefined ? { column: evidence.column } : {}),
  };
}

function uiMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const allowed = ["uiGranularity", "symbolCount", "incomingCount", "outgoingCount", "containedSymbols", "aggregated", "edgeKinds", "underlyingEdgeCount", "underlyingEdges"];
  const picked = Object.fromEntries(allowed.flatMap((key) => key in metadata ? [[key, metadata[key]]] : []));
  return Object.keys(picked).length ? picked : undefined;
}

function formatNode(node: GraphNode, mode: OutputMode): Record<string, unknown> {
  if (mode === "full") return { ...node };
  const metadata = mode === "standard" ? uiMetadata(node.metadata) : undefined;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    ...(node.file ? { file: node.file } : {}),
    ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
    ...(mode === "standard" ? {
      qualifiedName: node.qualifiedName,
      ...(node.language ? { language: node.language } : {}),
      adapter: node.adapter,
      ...(metadata ? { metadata } : {}),
    } : {}),
  };
}

function formatEdge(edge: GraphEdge, mode: OutputMode, maxEvidence: number): Record<string, unknown> {
  if (mode === "full") return { ...edge, evidence: edge.evidence.slice(0, maxEvidence) };
  const metadata = mode === "standard" ? uiMetadata(edge.metadata) : undefined;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    confidence: edge.confidence,
    ...(metadata ? { metadata } : {}),
    evidence: edge.evidence.slice(0, maxEvidence).map((item) => mode === "compact" ? evidencePointer(item) : item),
  };
}

export function formatQueryOutput(value: unknown, options: OutputModeOptions = {}): unknown {
  const mode = options.mode ?? "compact";
  const maxEvidence = Math.max(0, Math.min(options.maxEvidence ?? (mode === "compact" ? 1 : 3), 100));
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (isGraphEdge(record)) return formatEdge(record as unknown as GraphEdge, mode, maxEvidence);
    if (isGraphNode(record)) return formatNode(record as unknown as GraphNode, mode);
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, visit(nested)]));
  };
  return visit(value);
}
