import type { AdapterResult } from "../adapters/contracts.js";
import type { Diagnostic, GraphEdge, GraphNode } from "./schema.js";

export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly diagnostics: Diagnostic[] = [];

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.set(edge.id, edge);
  }

  addDiagnostic(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  merge(result: AdapterResult): void {
    result.nodes.forEach((node) => this.addNode(node));
    result.edges.forEach((edge) => this.addEdge(edge));
    this.diagnostics.push(...result.diagnostics);
  }

  result(metadata: Record<string, unknown> = {}): AdapterResult {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      diagnostics: [...this.diagnostics],
      metadata,
    };
  }
}
