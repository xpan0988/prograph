import path from "node:path";
import { access } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Confidence, Diagnostic, EdgeKind, GraphEdge, GraphNode, NodeKind } from "../graph/schema.js";
import { diagnosticFromRow, graphEdgeFromRow, graphNodeFromRow, type DiagnosticRow, type EdgeRow, type NodeRow } from "../storage/sqlite.js";
import { resolveRepositoryRoot } from "../repository/repository.js";

export interface ConfidenceQuery {
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

export interface SymbolSearchOptions {
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

  overview(): Record<string, unknown> {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS files,
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM edges) AS edges,
        (SELECT COUNT(*) FROM diagnostics) AS diagnostics
    `).get() as Record<string, number>;
    const nodesByKind = this.database.prepare("SELECT kind, COUNT(*) AS count FROM nodes GROUP BY kind ORDER BY count DESC").all();
    const edgesByKind = this.database.prepare("SELECT kind, COUNT(*) AS count FROM edges GROUP BY kind ORDER BY count DESC").all();
    const adapters = this.adapters();
    const repository = Object.fromEntries((this.database.prepare("SELECT key, value FROM repository_metadata").all() as Array<{ key: string; value: string }>).map((item) => [item.key, item.value]));
    return { repository, counts, nodesByKind, edgesByKind, adapters };
  }

  adapters(): unknown[] {
    return this.database.prepare("SELECT adapter, detected, duration_ms AS durationMs, file_count AS fileCount, node_count AS nodeCount, edge_count AS edgeCount, diagnostic_count AS diagnosticCount FROM adapter_runs ORDER BY adapter").all();
  }

  architecture(maxNodes = 100, options: ConfidenceQuery = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const nodes = (this.database.prepare(`
      SELECT * FROM nodes
      WHERE kind IN ('repository', 'directory', 'file', 'module', 'framework_command', 'framework_event', 'external_package')
      ORDER BY CASE kind WHEN 'repository' THEN 0 WHEN 'directory' THEN 1 WHEN 'framework_command' THEN 2 WHEN 'framework_event' THEN 3 WHEN 'file' THEN 4 ELSE 5 END, qualified_name
      LIMIT ?
    `).all(maxNodes) as NodeRow[]).map(graphNodeFromRow);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = filterEdges((this.database.prepare("SELECT * FROM edges WHERE kind IN ('imports', 'invokes', 'registers', 'emits', 'listens')").all() as EdgeRow[])
      .map(graphEdgeFromRow), options)
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const total = (this.database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE kind IN ('repository', 'directory', 'file', 'module', 'framework_command', 'framework_event', 'external_package')").get() as { count: number }).count;
    return { nodes, edges, truncated: total > nodes.length };
  }

  files(): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT f.path, f.language,
        (SELECT COUNT(*) FROM nodes n WHERE n.file = f.path) AS nodeCount,
        (SELECT COUNT(*) FROM edges e JOIN nodes n ON n.id = e.source WHERE n.file = f.path) AS outgoingCount,
        (SELECT COUNT(*) FROM edges e JOIN nodes n ON n.id = e.target WHERE n.file = f.path) AS incomingCount
      FROM files f ORDER BY f.path
    `).all() as Array<Record<string, unknown>>;
  }

  fileDetails(file: string, options: ConfidenceQuery = {}): Record<string, unknown> {
    const nodes = (this.database.prepare("SELECT * FROM nodes WHERE file = ? ORDER BY start_line, name").all(file) as NodeRow[]).map(graphNodeFromRow);
    const nodeIds = nodes.map((node) => node.id);
    const edges = this.edgesTouching(nodeIds, options);
    return { file, nodes, dependencies: edges.filter((edge) => nodeIds.includes(edge.source)), reverseDependencies: edges.filter((edge) => nodeIds.includes(edge.target)) };
  }

  searchSymbols(query: string, maxNodes = 50, options: SymbolSearchOptions = {}): GraphNode[] {
    const term = `%${query}%`;
    return (this.database.prepare(`
      SELECT * FROM nodes
      WHERE (name LIKE ? OR qualified_name LIKE ?)
        AND (? = 1 OR kind != 'unresolved_symbol')
      ORDER BY CASE WHEN name = ? THEN 0 WHEN kind = 'unresolved_symbol' THEN 2 ELSE 1 END, name, qualified_name
      LIMIT ?
    `).all(term, term, options.includeUnresolved ? 1 : 0, query, maxNodes) as NodeRow[]).map(graphNodeFromRow);
  }

  symbol(id: string): GraphNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? graphNodeFromRow(row) : undefined;
  }

  callers(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges = filterEdges((this.database.prepare("SELECT * FROM edges WHERE target = ? AND kind IN ('calls', 'invokes', 'renders', 'listens')").all(id) as EdgeRow[]).map(graphEdgeFromRow), options).slice(0, maxNodes);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.source)), edges };
  }

  callees(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges = filterEdges((this.database.prepare("SELECT * FROM edges WHERE source = ? AND kind IN ('calls', 'invokes', 'renders', 'emits', 'uses_type')").all(id) as EdgeRow[]).map(graphEdgeFromRow), options).slice(0, maxNodes);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.target)), edges };
  }

  neighborhood(id: string, options: BoundedQuery = {}): Neighborhood {
    const center = this.symbol(id);
    if (!center) throw new Error(`Symbol not found: ${id}`);
    const depth = Math.max(0, Math.min(options.depth ?? 2, 8));
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 50, 500));
    const maxEdges = Math.max(1, Math.min(options.maxEdges ?? maxNodes * 4, 2000));
    const allEdges = filterEdges((this.database.prepare("SELECT * FROM edges").all() as EdgeRow[]).map(graphEdgeFromRow), options)
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
    let nodes = this.nodesByIds([...nodeIds]);
    if (options.nodeKinds?.length) nodes = nodes.filter((node) => node.id === id || options.nodeKinds!.includes(node.kind));
    const finalIds = new Set(nodes.map((node) => node.id));
    const finalEdges = [...selectedEdges.values()].filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target));
    if (finalEdges.length > maxEdges) truncated = true;
    return { center, nodes, edges: finalEdges.slice(0, maxEdges), truncated };
  }

  cycles(options: ConfidenceQuery = {}): Array<{ nodeIds: string[]; nodes: GraphNode[] }> {
    const edges = filterEdges((this.database.prepare("SELECT * FROM edges WHERE kind IN ('imports', 'calls')").all() as EdgeRow[]).map(graphEdgeFromRow), options);
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
    const rows = (this.database.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM edges e WHERE e.source = n.id OR e.target = n.id) AS degree
      FROM nodes n WHERE n.kind NOT IN ('repository', 'directory', 'file', 'unresolved_symbol')
      ORDER BY degree DESC, n.qualified_name LIMIT 2000
    `).all() as Array<NodeRow & { degree: number }>).map((row) => ({ node: graphNodeFromRow(row), degree: row.degree }));
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
    const trustedEdges = filterEdges((this.database.prepare("SELECT * FROM edges").all() as EdgeRow[]).map(graphEdgeFromRow), options);
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
    const directSymbols = input.includes(":") ? [this.symbol(input)].filter((node): node is GraphNode => Boolean(node)) : [];
    const fileNodes = (this.database.prepare("SELECT * FROM nodes WHERE file = ? AND kind NOT IN ('file', 'directory', 'repository', 'unresolved_symbol') ORDER BY start_line").all(input) as NodeRow[]).map(graphNodeFromRow);
    const allRoots = directSymbols.length ? directSymbols : fileNodes.length ? fileNodes : this.searchSymbols(input, 20);
    if (!allRoots.length) throw new Error(`No indexed file or symbol matches: ${input}`);
    const allEdges = filterEdges((this.database.prepare("SELECT * FROM edges WHERE kind IN ('calls', 'imports', 'invokes', 'renders', 'listens', 'uses_type')").all() as EdgeRow[]).map(graphEdgeFromRow), options);
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
    return filterEdges((this.database.prepare(`SELECT * FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).all(...ids, ...ids) as EdgeRow[]).map(graphEdgeFromRow), options);
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
