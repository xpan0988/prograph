import path from "node:path";
import { access } from "node:fs/promises";
import Database from "better-sqlite3";
import { evidenceOf, graphDomainOf, isKnowledgeNode as metadataIsKnowledgeNode, metadataOf, sourceCategoryOf } from "../graph/metadata.js";
import type { Confidence, Diagnostic, EdgeKind, GraphEdge, GraphNode, GraphScope, NodeKind } from "../graph/schema.js";
import { diagnosticFromRow, graphEdgeFromRow, graphNodeFromRow, type DiagnosticRow, type EdgeRow, type NodeRow } from "../storage/sqlite.js";
import { resolveRepositoryRoot } from "../repository/repository.js";

export interface ScopeQuery {
  scope?: GraphScope;
}

export interface ConfidenceQuery extends ScopeQuery {
  includeProbable?: boolean;
  includeUnresolved?: boolean;
}

export interface BoundedQuery extends ConfidenceQuery {
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface SymbolSearchOptions extends ScopeQuery {
  includeUnresolved?: boolean;
}

export interface ContextQuery extends ConfidenceQuery {
  maxFiles?: number;
  maxSymbols?: number;
}

export interface AffectedQuery extends ConfidenceQuery {
  depth?: number;
  includeTests?: boolean;
  maxNodes?: number;
}

function includedConfidences(options: ConfidenceQuery = {}): Set<Confidence> {
  const values = new Set<Confidence>(["exact", "resolved"]);
  if (options.includeProbable || options.includeUnresolved) values.add("probable");
  if (options.includeUnresolved) values.add("unresolved");
  return values;
}

function filterEdges(edges: GraphEdge[], options: ConfidenceQuery = {}): GraphEdge[] {
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

function scope(options: ScopeQuery = {}): GraphScope {
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

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.[^.]+$/.test(file) || /(?:^|\/)__tests__(?:\/|$)/.test(file) || /(?:^|\/)tests?\/[^/]+$/.test(file);
}

export class QueryService {
  readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.database.close();
  }

  overview(options: ScopeQuery = {}): Record<string, unknown> {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS files,
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM edges) AS edges,
        (SELECT COUNT(*) FROM diagnostics) AS diagnostics
    `).get() as Record<string, number>;
    const allNodes = this.allNodes();
    const nodes = scopedNodes(allNodes, options);
    const edges = scopedEdges(this.allEdges(), allNodes, options);
    const countBy = <T extends string>(values: T[]): Array<{ kind: T; count: number }> =>
      [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<T, number>())]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
    const scopedCounts = { files: nodes.filter((node) => node.kind === "file").length, nodes: nodes.length, edges: edges.length, diagnostics: counts.diagnostics };
    const nodesByKind = countBy(nodes.map((node) => node.kind));
    const edgesByKind = countBy(edges.map((edge) => edge.kind));
    const adapters = this.adapters();
    const repository = Object.fromEntries((this.database.prepare("SELECT key, value FROM repository_metadata").all() as Array<{ key: string; value: string }>).map((item) => [item.key, item.value]));
    return { repository, counts: scopedCounts, totalCounts: counts, nodesByKind, edgesByKind, adapters, scope: scope(options) };
  }

  adapters(): unknown[] {
    return this.database.prepare("SELECT adapter, detected, duration_ms AS durationMs, file_count AS fileCount, node_count AS nodeCount, edge_count AS edgeCount, diagnostic_count AS diagnosticCount FROM adapter_runs ORDER BY adapter").all();
  }

  private codeArchitecture(maxNodes: number, options: ConfidenceQuery = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const allNodes = this.allNodes();
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
    }>();

    for (const edge of scopedEdges(this.allEdges(), allNodes, options)) {
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
        current.evidence.push(...edgeEvidence);
        current.underlyingEdges.push(underlying);
      } else {
        aggregated.set(key, {
          source,
          target,
          confidence: edge.confidence,
          kinds: new Set([edge.kind]),
          evidence: [...edgeEvidence],
          underlyingEdges: [underlying],
        });
      }
    }

    const sortedFiles = [...fileNodes.values()]
      .sort((left, right) => (left.file ?? left.qualifiedName).localeCompare(right.file ?? right.qualifiedName))
      .slice(0, maxNodes);
    const visibleIds = new Set(sortedFiles.map((node) => node.id));
    const externalNodes = [...nodes]
      .filter((node) => node.kind === "external_package")
      .filter((node) => [...aggregated.values()].some((edge) => edge.source.id === node.id || edge.target.id === node.id))
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName))
      .slice(0, Math.max(0, maxNodes - sortedFiles.length));
    for (const node of externalNodes) visibleIds.add(node.id);

    const decoratedNodes = [...sortedFiles, ...externalNodes].map((node) => {
      const containedSymbols = (node.file ? symbolsByFile.get(node.file) : undefined) ?? [];
      const incomingCount = [...aggregated.values()].filter((edge) => edge.target.id === node.id && visibleIds.has(edge.source.id)).length;
      const outgoingCount = [...aggregated.values()].filter((edge) => edge.source.id === node.id && visibleIds.has(edge.target.id)).length;
      return {
        ...node,
        metadata: {
          ...metadataOf(node),
          uiGranularity: "file",
          symbolCount: containedSymbols.length,
          incomingCount,
          outgoingCount,
          containedSymbols: containedSymbols
            .sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0) || left.name.localeCompare(right.name))
            .map((symbol) => ({
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
            underlyingEdgeCount: edge.underlyingEdges.length,
            underlyingEdges: edge.underlyingEdges.slice(0, 24),
          },
        } satisfies GraphEdge;
      })
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.kind.localeCompare(right.kind));

    return { nodes: decoratedNodes, edges, truncated: fileNodes.size + externalNodes.length > decoratedNodes.length };
  }

  architecture(maxNodes = 100, options: ConfidenceQuery = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const selectedScope = scope(options);
    if (selectedScope === "code") return this.codeArchitecture(maxNodes, options);
    const allNodes = this.allNodes();
    const nodes = scopedNodes(allNodes, options)
      .sort((left, right) => {
        const rank = (node: GraphNode): number => node.kind === "repository" ? 0 : node.kind === "directory" ? 1 : node.kind === "framework_command" ? 2 : node.kind === "framework_event" ? 3 : node.kind === "file" ? 4 : isKnowledgeNode(node) ? 6 : 5;
        return rank(left) - rank(right) || left.qualifiedName.localeCompare(right.qualifiedName);
      })
      .slice(0, maxNodes);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = scopedEdges(this.allEdges(), allNodes, options)
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const total = scopedNodes(allNodes, options).length;
    return { nodes, edges, truncated: total > nodes.length };
  }

  files(options: ScopeQuery = {}): Array<Record<string, unknown>> {
    const allNodes = this.allNodes();
    const nodes = scopedNodes(allNodes, options);
    const edges = scopedEdges(this.allEdges(), allNodes, options);
    const fileNodes = nodes.filter((node) => node.kind === "file" && node.file).sort((left, right) => left.file!.localeCompare(right.file!));
    return fileNodes.map((node) => ({
      path: node.file,
      language: node.language,
      nodeCount: nodes.filter((item) => item.file === node.file).length,
      outgoingCount: edges.filter((edge) => nodes.find((item) => item.id === edge.source)?.file === node.file).length,
      incomingCount: edges.filter((edge) => nodes.find((item) => item.id === edge.target)?.file === node.file).length,
    }));
  }

  fileDetails(file: string, options: ConfidenceQuery = {}): Record<string, unknown> {
    const nodes = scopedNodes((this.database.prepare("SELECT * FROM nodes WHERE file = ? ORDER BY start_line, name").all(file) as NodeRow[]).map(graphNodeFromRow), options);
    const nodeIds = nodes.map((node) => node.id);
    const edges = this.edgesTouching(nodeIds, options);
    return { file, nodes, dependencies: edges.filter((edge) => nodeIds.includes(edge.source)), reverseDependencies: edges.filter((edge) => nodeIds.includes(edge.target)) };
  }

  searchSymbols(query: string, maxNodes = 50, options: SymbolSearchOptions = {}): GraphNode[] {
    const term = `%${query}%`;
    return scopedNodes((this.database.prepare(`
      SELECT * FROM nodes
      WHERE (name LIKE ? OR qualified_name LIKE ?)
        AND (? = 1 OR kind != 'unresolved_symbol')
      ORDER BY CASE WHEN name = ? THEN 0 WHEN kind = 'unresolved_symbol' THEN 2 ELSE 1 END, name, qualified_name
      LIMIT ?
    `).all(term, term, options.includeUnresolved ? 1 : 0, query, maxNodes * 4) as NodeRow[]).map(graphNodeFromRow), options).slice(0, maxNodes);
  }

  symbol(id: string): GraphNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? graphNodeFromRow(row) : undefined;
  }

  callers(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const allNodes = this.allNodes();
    const selectedKinds = scope(options) === "code" ? new Set<EdgeKind>(["calls", "invokes", "renders", "listens"]) : undefined;
    const edges = scopedEdges((this.database.prepare("SELECT * FROM edges WHERE target = ?").all(id) as EdgeRow[]).map(graphEdgeFromRow), allNodes, options)
      .filter((edge) => !selectedKinds || selectedKinds.has(edge.kind))
      .slice(0, maxNodes);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.source)), edges };
  }

  callees(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const allNodes = this.allNodes();
    const selectedKinds = scope(options) === "code" ? new Set<EdgeKind>(["calls", "invokes", "renders", "emits", "uses_type"]) : undefined;
    const edges = scopedEdges((this.database.prepare("SELECT * FROM edges WHERE source = ?").all(id) as EdgeRow[]).map(graphEdgeFromRow), allNodes, options)
      .filter((edge) => !selectedKinds || selectedKinds.has(edge.kind))
      .slice(0, maxNodes);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.target)), edges };
  }

  neighborhood(id: string, options: BoundedQuery = {}): Neighborhood {
    const center = this.symbol(id);
    if (!center) throw new Error(`Symbol not found: ${id}`);
    const depth = Math.max(0, Math.min(options.depth ?? 2, 8));
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 50, 500));
    const maxEdges = Math.max(1, Math.min(options.maxEdges ?? maxNodes * 4, 2000));
    const allNodes = this.allNodes();
    const allEdges = scopedEdges(this.allEdges(), allNodes, options)
      .filter((edge) => !options.edgeKinds?.length || options.edgeKinds.includes(edge.kind));
    const nodeIds = new Set([id]);
    const selectedEdges = new Map<string, GraphEdge>();
    let frontier = new Set([id]);
    let truncated = false;
    for (let level = 0; level < depth; level += 1) {
      const next = new Set<string>();
      for (const edge of allEdges) {
        if (!frontier.has(edge.source) && !frontier.has(edge.target)) continue;
        const candidate = frontier.has(edge.source) ? edge.target : edge.source;
        if (nodeIds.size >= maxNodes && !nodeIds.has(candidate)) {
          truncated = true;
          continue;
        }
        nodeIds.add(candidate);
        next.add(candidate);
        selectedEdges.set(edge.id, edge);
      }
      frontier = next;
    }
    let nodes = scopedNodes(this.nodesByIds([...nodeIds]), options);
    if (options.nodeKinds?.length) nodes = nodes.filter((node) => node.id === id || options.nodeKinds!.includes(node.kind));
    const finalIds = new Set(nodes.map((node) => node.id));
    const finalEdges = [...selectedEdges.values()].filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target));
    if (finalEdges.length > maxEdges) truncated = true;
    return { center, nodes, edges: finalEdges.slice(0, maxEdges), truncated };
  }

  cycles(options: ConfidenceQuery = {}): Array<{ nodeIds: string[]; nodes: GraphNode[] }> {
    const allNodes = this.allNodes();
    const selectedKinds = scope(options) === "code" ? new Set<EdgeKind>(["imports", "calls"]) : undefined;
    const edges = scopedEdges(this.allEdges(), allNodes, options).filter((edge) => selectedKinds ? selectedKinds.has(edge.kind) : ["imports", "calls", "mentions", "configures", "tests", "related_to"].includes(edge.kind));
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    const seen = new Set<string>();
    const active = new Set<string>();
    const stack: string[] = [];
    const cycles = new Map<string, string[]>();
    const visit = (id: string): void => {
      seen.add(id);
      active.add(id);
      stack.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) visit(next);
        else if (active.has(next)) {
          const cycle = stack.slice(stack.indexOf(next));
          const key = [...cycle].sort().join("|");
          cycles.set(key, cycle);
        }
      }
      stack.pop();
      active.delete(id);
    };
    for (const id of adjacency.keys()) if (!seen.has(id)) visit(id);
    return [...cycles.values()].map((nodeIds) => ({ nodeIds, nodes: this.nodesByIds(nodeIds) }));
  }

  frameworkBindings(framework?: string, options: ConfidenceQuery = {}): Record<string, unknown> {
    const nodes = (this.database.prepare("SELECT * FROM nodes WHERE kind IN ('framework_command', 'framework_event') ORDER BY kind, name").all() as NodeRow[]).map(graphNodeFromRow);
    const selected = framework ? nodes.filter((node) => node.metadata.framework === framework) : nodes;
    const edges = this.edgesTouching(selected.map((node) => node.id), options);
    const selectedIds = new Set(selected.map((node) => node.id));
    const relatedIds = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]).filter((id) => !selectedIds.has(id)))];
    return { framework: framework ?? "all", nodes: [...selected, ...this.nodesByIds(relatedIds)], edges };
  }

  context(task: string, options: ContextQuery = {}): Record<string, unknown> {
    const tokens = [...new Set(task.toLowerCase().split(/[^a-z0-9_]+/).filter((item) => item.length >= 2))];
    const maxSymbols = Math.max(1, Math.min(options.maxSymbols ?? 50, 200));
    const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 20, 100));
    const rows = scopedNodes((this.database.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM edges e WHERE e.source = n.id OR e.target = n.id) AS degree
      FROM nodes n WHERE n.kind NOT IN ('repository', 'directory', 'file', 'unresolved_symbol')
      ORDER BY degree DESC, n.qualified_name LIMIT 2000
    `).all() as Array<NodeRow & { degree: number }>).map(graphNodeFromRow), options).map((node) => ({ node, degree: (this.database.prepare("SELECT COUNT(*) AS degree FROM edges WHERE source = ? OR target = ?").get(node.id, node.id) as { degree: number }).degree }));
    const ranked = rows.map(({ node, degree }) => {
      const name = node.name.toLowerCase();
      const qualified = node.qualifiedName.toLowerCase();
      const file = node.file?.toLowerCase() ?? "";
      const matched = tokens.filter((token) => name.includes(token) || qualified.includes(token) || file.includes(token));
      const score = matched.reduce((total, token) => total + (name === token ? 20 : name.includes(token) ? 10 : file.includes(token) ? 6 : 4), 0) + Math.min(degree, 20) / 10;
      const reasons = [
        ...(matched.length ? [`matched task terms: ${matched.join(", ")}`] : []),
        ...(degree ? [`graph degree ${degree}`] : []),
        ...(node.kind.startsWith("framework_") ? ["framework binding"] : []),
      ];
      return { node, score, reasons };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName)).slice(0, maxSymbols);
    const selectedIds = new Set(ranked.map((item) => item.node.id));
    const allNodes = this.allNodes();
    const trustedEdges = scopedEdges(this.allEdges(), allNodes, options);
    const relationships = trustedEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .slice(0, maxSymbols * 3);
    const fileScores = new Map<string, { score: number; reasons: Set<string> }>();
    for (const item of ranked) {
      if (!item.node.file) continue;
      const current = fileScores.get(item.node.file) ?? { score: 0, reasons: new Set<string>() };
      current.score += item.score;
      item.reasons.forEach((reason) => current.reasons.add(reason));
      fileScores.set(item.node.file, current);
    }
    const files = [...fileScores].map(([file, value]) => ({ file, score: value.score, reasons: [...value.reasons] }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, maxFiles);
    const relatedNodeIds = [...new Set(trustedEdges.flatMap((edge) => selectedIds.has(edge.source) ? [edge.target] : selectedIds.has(edge.target) ? [edge.source] : []))];
    const relatedTests = [...new Set(this.nodesByIds(relatedNodeIds)
      .map((node) => node.file)
      .filter((file): file is string => typeof file === "string" && isTestFile(file)))].sort();
    return { task, files, symbols: ranked, relationships, relatedTests, bounded: { maxFiles, maxSymbols } };
  }

  affected(input: string, options: AffectedQuery = {}): Record<string, unknown> {
    const depth = Math.max(1, Math.min(options.depth ?? 3, 8));
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 100, 500));
    const directSymbols = input.includes(":") ? scopedNodes([this.symbol(input)].filter((node): node is GraphNode => Boolean(node)), options) : [];
    const fileNodes = scopedNodes((this.database.prepare("SELECT * FROM nodes WHERE file = ? AND kind NOT IN ('file', 'directory', 'repository', 'unresolved_symbol') ORDER BY start_line").all(input) as NodeRow[]).map(graphNodeFromRow), options);
    const allRoots = directSymbols.length ? directSymbols : fileNodes.length ? fileNodes : this.searchSymbols(input, 20, options);
    if (!allRoots.length) throw new Error(`No indexed file or symbol matches: ${input}`);
    const allNodes = this.allNodes();
    const selectedKinds = scope(options) === "code" ? new Set<EdgeKind>(["calls", "imports", "invokes", "renders", "listens", "uses_type"]) : undefined;
    const allEdges = scopedEdges(this.allEdges(), allNodes, options)
      .filter((edge) => !selectedKinds || selectedKinds.has(edge.kind));
    const rootIds = new Set(allRoots.map((node) => node.id));
    const visited = new Set(rootIds);
    const selectedEdges: GraphEdge[] = [];
    const direct = new Set<string>();
    const transitive = new Set<string>();
    let frontier = new Set(rootIds);
    for (let level = 1; level <= depth; level += 1) {
      const next = new Set<string>();
      for (const edge of allEdges) {
        if (!frontier.has(edge.target) || visited.has(edge.source)) continue;
        if (direct.size + transitive.size >= maxNodes) break;
        visited.add(edge.source);
        next.add(edge.source);
        selectedEdges.push(edge);
        (level === 1 ? direct : transitive).add(edge.source);
      }
      frontier = next;
    }
    const affectedNodes = this.nodesByIds([...direct, ...transitive]);
    const affectedFiles = [...new Set(affectedNodes.map((node) => node.file).filter((file): file is string => Boolean(file)))].sort();
    const relatedTests = options.includeTests ? affectedFiles.filter(isTestFile) : [];
    const frameworks = [...new Set(selectedEdges.filter((edge) => ["invokes", "listens", "emits", "registers"].includes(edge.kind)).map((edge) => edge.kind))];
    return {
      input,
      roots: allRoots.slice(0, maxNodes),
      rootCount: allRoots.length,
      directlyAffectedSymbols: this.nodesByIds([...direct]),
      transitivelyAffectedSymbols: this.nodesByIds([...transitive]),
      affectedFiles,
      relatedTests,
      frameworkBoundariesCrossed: frameworks,
      relationships: selectedEdges,
      confidenceSummary: Object.fromEntries(["exact", "resolved", "probable", "unresolved"].map((confidence) => [confidence, selectedEdges.filter((edge) => edge.confidence === confidence).length])),
      bounded: { depth, maxNodes, truncated: direct.size + transitive.size >= maxNodes || allRoots.length > maxNodes },
    };
  }

  diagnostics(): Diagnostic[] {
    return (this.database.prepare("SELECT * FROM diagnostics ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, code").all() as DiagnosticRow[]).map(diagnosticFromRow);
  }

  private nodesByIds(ids: string[]): GraphNode[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.database.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...ids) as NodeRow[]).map(graphNodeFromRow);
  }

  private edgesTouching(ids: string[], options: ConfidenceQuery = {}): GraphEdge[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return scopedEdges((this.database.prepare(`SELECT * FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).all(...ids, ...ids) as EdgeRow[]).map(graphEdgeFromRow), this.allNodes(), options);
  }

  private allNodes(): GraphNode[] {
    return (this.database.prepare("SELECT * FROM nodes").all() as NodeRow[]).map(graphNodeFromRow);
  }

  private allEdges(): GraphEdge[] {
    return (this.database.prepare("SELECT * FROM edges").all() as EdgeRow[]).map(graphEdgeFromRow);
  }
}

export async function queryServiceForRepository(input = ".", index?: string): Promise<QueryService> {
  const root = await resolveRepositoryRoot(input);
  const requestedIndex = index ? path.resolve(index) : path.join(root, ".prograph");
  const databasePath = requestedIndex.endsWith(".sqlite") ? requestedIndex : path.join(requestedIndex, "graph.sqlite");
  try {
    await access(databasePath);
  } catch {
    throw new Error(`No ProGraph index found at ${databasePath}. Run "prograph analyze ${input}${index ? ` --output ${index}` : ""}" first.`);
  }
  return new QueryService(databasePath);
}
