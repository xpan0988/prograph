import path from "node:path";
import { evidenceOf, metadataOf } from "../graph/metadata.js";
import type { GraphNode, GraphEdge, Confidence, EdgeKind } from "../graph/schema.js";
import type { ConfidenceQuery } from "./query-service.js";
import { scopedNodes, scopedEdges } from "./scope.js";

/** Offline file projection. Interactive readers select from durable aggregated rows. */
export function fileArchitecture(allNodes: GraphNode[], allEdges: GraphEdge[], maxNodes: number, options: ConfidenceQuery = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const nodes = scopedNodes(allNodes, options);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const fileNodes = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (node.kind === "file" && node.file) fileNodes.set(node.file, node);
    }

    const symbolsByFile = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (!node.file || node.kind === "directory" || node.kind === "repository" || node.kind === "file") continue;
      const current = symbolsByFile.get(node.file) ?? [];
      current.push(node);
      symbolsByFile.set(node.file, current);
      if (!fileNodes.has(node.file)) {
        fileNodes.set(node.file, {
          id: `file:${node.file}`,
          kind: "file",
          name: path.basename(node.file),
          qualifiedName: node.file,
          file: node.file,
          adapter: node.adapter,
          metadata: {},
          ...(node.language ? { language: node.language } : {}),
        });
      }
    }

    const flowKinds = new Set<EdgeKind>(["imports", "calls", "renders", "invokes", "registers", "emits", "listens", "tests"]);
    const noisyKinds = new Set<EdgeKind>(["contains", "uses_type"]);
    const confidenceRank: Record<Confidence, number> = { exact: 0, resolved: 1, probable: 2, unresolved: 3 };
    const kindPriority: EdgeKind[] = ["invokes", "emits", "listens", "registers", "renders", "calls", "imports", "tests"];
    const fileForNode = (node: GraphNode | undefined): GraphNode | undefined => {
      if (!node) return undefined;
      if (node.kind === "external_package") return node;
      if (node.kind === "file" && node.file) return fileNodes.get(node.file);
      return node.file ? fileNodes.get(node.file) : undefined;
    };
    const chooseKind = (kinds: Set<EdgeKind>): EdgeKind => kindPriority.find((kind) => kinds.has(kind)) ?? [...kinds][0] ?? "imports";
    const chooseConfidence = (left: Confidence, right: Confidence): Confidence => confidenceRank[left] <= confidenceRank[right] ? left : right;

    const aggregated = new Map<string, {
      source: GraphNode;
      target: GraphNode;
      confidence: Confidence;
      kinds: Set<EdgeKind>;
      evidence: GraphEdge["evidence"];
      underlyingEdges: Array<Record<string, unknown>>;
      underlyingEdgeCount: number;
    }>();

    for (const edge of scopedEdges(allEdges, allNodes, options)) {
      if (!flowKinds.has(edge.kind) || noisyKinds.has(edge.kind)) continue;
      const source = fileForNode(nodeById.get(edge.source));
      const target = fileForNode(nodeById.get(edge.target));
      if (!source || !target || source.id === target.id) continue;
      const key = `${source.id}->${target.id}`;
      const current = aggregated.get(key);
      const edgeEvidence = evidenceOf(edge);
      const sourceSymbol = nodeById.get(edge.source);
      const targetSymbol = nodeById.get(edge.target);
      const underlying = {
        id: edge.id,
        kind: edge.kind,
        confidence: edge.confidence,
        source: edge.source,
        target: edge.target,
        sourceSymbol: sourceSymbol?.qualifiedName ?? sourceSymbol?.name,
        targetSymbol: targetSymbol?.qualifiedName ?? targetSymbol?.name,
        evidence: edgeEvidence,
      };
      if (current) {
        current.confidence = chooseConfidence(current.confidence, edge.confidence);
        current.kinds.add(edge.kind);
        current.evidence.push(...edgeEvidence.slice(0, Math.max(0, 12 - current.evidence.length)));
        if (current.underlyingEdges.length < 24) current.underlyingEdges.push(underlying);
        current.underlyingEdgeCount++;
      } else {
        aggregated.set(key, {
          source,
          target,
          confidence: edge.confidence,
          kinds: new Set([edge.kind]),
          evidence: edgeEvidence.slice(0, 12),
          underlyingEdges: [underlying], underlyingEdgeCount: 1,
        });
      }
    }

    const sortedFiles = [...fileNodes.values()]
      .sort((left, right) => (left.file ?? left.qualifiedName).localeCompare(right.file ?? right.qualifiedName))
      .slice(0, maxNodes);
    const visibleIds = new Set(sortedFiles.map((node) => node.id));
    const externalIds = new Set([...aggregated.values()].flatMap(edge => [edge.source.id, edge.target.id]));
    const externalNodes = [...nodes]
      .filter((node) => node.kind === "external_package")
      .filter((node) => externalIds.has(node.id))
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName))
      .slice(0, Math.max(0, maxNodes - sortedFiles.length));
    for (const node of externalNodes) visibleIds.add(node.id);

    const incoming = new Map<string, number>(); const outgoing = new Map<string, number>();
    for (const edge of aggregated.values()) if (visibleIds.has(edge.source.id) && visibleIds.has(edge.target.id)) {
      incoming.set(edge.target.id, (incoming.get(edge.target.id) ?? 0) + 1); outgoing.set(edge.source.id, (outgoing.get(edge.source.id) ?? 0) + 1);
    }
    const decoratedNodes = [...sortedFiles, ...externalNodes].map((node) => {
      const containedSymbols = (node.file ? symbolsByFile.get(node.file) : undefined) ?? [];
      const incomingCount = incoming.get(node.id) ?? 0;
      const outgoingCount = outgoing.get(node.id) ?? 0;
      return {
        ...node,
        metadata: {
          ...metadataOf(node),
          uiGranularity: "file",
          symbolCount: containedSymbols.length,
          incomingCount,
          outgoingCount,
          ...(containedSymbols.length > 64 ? { containedSymbolsTruncated: true } : {}),
          containedSymbols: containedSymbols
            .sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0) || left.name.localeCompare(right.name))
            .slice(0, 64).map((symbol) => ({
              id: symbol.id,
              name: symbol.name,
              kind: symbol.kind,
              qualifiedName: symbol.qualifiedName,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
            })),
        },
      };
    });

    const edges = [...aggregated.entries()]
      .filter(([, edge]) => visibleIds.has(edge.source.id) && visibleIds.has(edge.target.id))
      .map(([key, edge]) => {
        const kind = chooseKind(edge.kinds);
        return {
          id: `fileedge:${key}:${[...edge.kinds].sort().join("+")}`,
          source: edge.source.id,
          target: edge.target.id,
          kind,
          confidence: edge.confidence,
          evidence: edge.evidence.slice(0, 12),
          metadata: {
            graphDomain: "code",
            aggregated: true,
            edgeKinds: [...edge.kinds].sort(),
            underlyingEdgeCount: edge.underlyingEdgeCount,
            underlyingEdges: edge.underlyingEdges.slice(0, 24),
          },
        } satisfies GraphEdge;
      })
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.kind.localeCompare(right.kind));

    return { nodes: decoratedNodes, edges, truncated: fileNodes.size + externalNodes.length > decoratedNodes.length };
  }

