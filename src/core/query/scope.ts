import { graphDomainOf, isKnowledgeNode as metadataIsKnowledgeNode, sourceCategoryOf } from "../graph/metadata.js";
import type { Confidence, GraphEdge, GraphNode, GraphScope, NodeKind, EdgeKind } from "../graph/schema.js";
import type { ConfidenceQuery, ScopeQuery } from "./query-service.js";

export function includedConfidences(options: ConfidenceQuery = {}): Set<Confidence> {
  const values = new Set<Confidence>(["exact", "resolved"]);
  if (options.includeProbable || options.includeUnresolved) values.add("probable");
  if (options.includeUnresolved) values.add("unresolved");
  return values;
}

export function filterEdges(edges: GraphEdge[], options: ConfidenceQuery = {}): GraphEdge[] {
  const confidences = includedConfidences(options);
  return edges.filter((edge) => confidences.has(edge.confidence));
}

const KNOWLEDGE_NODE_KINDS = new Set<NodeKind>([
  "doc_section",
  "configuration",
  "api_surface",
  "cli_command",
  "test_artifact",
  "external_service",
  "security_boundary",
  "concept",
  "feature",
  "workflow",
]);

const KNOWLEDGE_EDGE_KINDS = new Set<EdgeKind>([
  "documents",
  "explains",
  "mentions",
  "configured_by",
  "configures",
  "exposes_api",
  "describes_workflow",
  "tests",
  "related_to",
]);

export function scope(options: ScopeQuery = {}): GraphScope {
  return options.scope ?? "code";
}

export function isKnowledgeNode(node: GraphNode): boolean {
  return metadataIsKnowledgeNode(node) || KNOWLEDGE_NODE_KINDS.has(node.kind);
}

function nodeCategory(node: GraphNode): string | undefined {
  return sourceCategoryOf(node);
}

export function nodeInScope(node: GraphNode, selected: GraphScope): boolean {
  if (!isKnowledgeNode(node)) return true;
  if (selected === "full") return true;
  const category = nodeCategory(node);
  if (selected === "code+docs") return category === "docs";
  if (selected === "code+config") return category === "config" || category === "semantic";
  if (selected === "code+tests") return category === "tests";
  return false;
}

export function isKnowledgeEdge(edge: GraphEdge): boolean {
  return graphDomainOf(edge) === "knowledge" || KNOWLEDGE_EDGE_KINDS.has(edge.kind);
}

export function scopedNodes(nodes: GraphNode[], options: ScopeQuery = {}): GraphNode[] {
  const selected = scope(options);
  return nodes.filter((node) => nodeInScope(node, selected));
}

export function scopedEdges(edges: GraphEdge[], nodes: GraphNode[], options: ConfidenceQuery = {}): GraphEdge[] {
  const selected = scope(options);
  const ids = new Set(scopedNodes(nodes, options).map((node) => node.id));
  return filterEdges(edges, options).filter((edge) => ids.has(edge.source) && ids.has(edge.target) && (selected !== "code" || !isKnowledgeEdge(edge)));
}

