import { createHash } from "node:crypto";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, SourceEvidence } from "./schema.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function nodeId(input: {
  repositoryIdentity: string;
  language?: string;
  file?: string;
  kind: NodeKind;
  qualifiedName: string;
  discriminator?: string;
}): string {
  const stable = [
    input.repositoryIdentity,
    input.language ?? "none",
    input.file ?? "none",
    input.kind,
    input.qualifiedName,
    input.discriminator ?? "",
  ].join("\0");
  return `${input.language ?? "graph"}:${input.kind}:${digest(stable)}`;
}

export function edgeId(input: {
  source: string;
  target: string;
  kind: EdgeKind;
  evidence?: SourceEvidence[];
  discriminator?: string;
}): string {
  const evidenceKey = (input.evidence ?? [])
    .map((item) => `${item.file ?? ""}:${item.line ?? ""}:${item.column ?? ""}:${item.bindingName ?? ""}`)
    .sort()
    .join("|");
  return `edge:${input.kind}:${digest([input.source, input.target, input.kind, evidenceKey, input.discriminator ?? ""].join("\0"))}`;
}

export function withEdgeId(edge: Omit<GraphEdge, "id">): GraphEdge {
  return { ...edge, id: edgeId(edge) };
}

export function validateIdentities(nodes: GraphNode[], edges: GraphEdge[]): import("./schema.js").Diagnostic[] {
  const diagnostics: import("./schema.js").Diagnostic[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      diagnostics.push({
        code: "duplicate-node-id",
        severity: "error",
        message: `Duplicate generated node ID: ${node.id}`,
        adapter: node.adapter,
        metadata: { node },
      });
    }
    nodeIds.add(node.id);
  }
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      diagnostics.push({
        code: "duplicate-edge-id",
        severity: "error",
        message: `Duplicate generated edge ID: ${edge.id}`,
        metadata: { edge },
      });
    }
    edgeIds.add(edge.id);
  }
  return diagnostics;
}
