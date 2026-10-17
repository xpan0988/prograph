import type { AdapterResult } from "../adapters/contracts.js";
import type { Diagnostic, GraphEdge, GraphNode } from "./schema.js";

export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly diagnostics: Diagnostic[] = [];
  private readonly inputs = new Map<string, string>();
  private inputsQualified = true;
  private hasInputReceipt = false;

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
    if (result.inputReceipt) {
      this.hasInputReceipt = true; this.inputsQualified &&= result.inputReceipt.qualified;
      for (const input of result.inputReceipt.inputs) {
        const previous = this.inputs.get(input.resource);
        if (previous !== undefined && previous !== input.digest) throw Error(`Provider input changed across observations: ${input.resource}`);
        this.inputs.set(input.resource, input.digest);
      }
    }
    result.nodes.forEach((node) => this.addNode(node));
    result.edges.forEach((edge) => this.addEdge(edge));
    this.diagnostics.push(...result.diagnostics);
  }

  result(metadata: Record<string, unknown> = {}): AdapterResult {
    return {
      ...(this.hasInputReceipt ? { inputReceipt: { qualified: this.inputsQualified, inputs: [...this.inputs].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([resource,digest])=>({resource,digest})) } } : {}),
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      diagnostics: [...this.diagnostics],
      metadata,
    };
  }
}
