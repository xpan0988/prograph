import path from "node:path";
import { access } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Diagnostic, EdgeKind, GraphEdge, GraphNode, NodeKind } from "../graph/schema.js";
import { diagnosticFromRow, graphEdgeFromRow, graphNodeFromRow, type DiagnosticRow, type EdgeRow, type NodeRow } from "../storage/sqlite.js";
import { resolveRepositoryRoot } from "../repository/repository.js";

export interface BoundedQuery {
  depth?: number;
  maxNodes?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
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

  architecture(maxNodes = 100): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const nodes = (this.database.prepare(`
      SELECT * FROM nodes
      WHERE kind IN ('repository', 'directory', 'file', 'module', 'framework_command', 'framework_event', 'external_package')
      ORDER BY CASE kind WHEN 'repository' THEN 0 WHEN 'directory' THEN 1 WHEN 'framework_command' THEN 2 WHEN 'framework_event' THEN 3 WHEN 'file' THEN 4 ELSE 5 END, qualified_name
      LIMIT ?
    `).all(maxNodes) as NodeRow[]).map(graphNodeFromRow);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = (this.database.prepare("SELECT * FROM edges WHERE kind IN ('imports', 'invokes', 'registers', 'emits', 'listens')").all() as EdgeRow[])
      .map(graphEdgeFromRow)
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

  fileDetails(file: string): Record<string, unknown> {
    const nodes = (this.database.prepare("SELECT * FROM nodes WHERE file = ? ORDER BY start_line, name").all(file) as NodeRow[]).map(graphNodeFromRow);
    const nodeIds = nodes.map((node) => node.id);
    const edges = this.edgesTouching(nodeIds);
    return { file, nodes, dependencies: edges.filter((edge) => nodeIds.includes(edge.source)), reverseDependencies: edges.filter((edge) => nodeIds.includes(edge.target)) };
  }

  searchSymbols(query: string, maxNodes = 50): GraphNode[] {
    const term = `%${query}%`;
    return (this.database.prepare("SELECT * FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, name LIMIT ?").all(term, term, query, maxNodes) as NodeRow[]).map(graphNodeFromRow);
  }

  symbol(id: string): GraphNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? graphNodeFromRow(row) : undefined;
  }

  callers(id: string, maxNodes = 50): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges = (this.database.prepare("SELECT * FROM edges WHERE target = ? AND kind IN ('calls', 'invokes', 'renders', 'listens') LIMIT ?").all(id, maxNodes) as EdgeRow[]).map(graphEdgeFromRow);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.source)), edges };
  }

  callees(id: string, maxNodes = 50): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges = (this.database.prepare("SELECT * FROM edges WHERE source = ? AND kind IN ('calls', 'invokes', 'renders', 'emits', 'uses_type') LIMIT ?").all(id, maxNodes) as EdgeRow[]).map(graphEdgeFromRow);
    const symbol = this.symbol(id);
    return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map((edge) => edge.target)), edges };
  }

  neighborhood(id: string, options: BoundedQuery = {}): Neighborhood {
    const center = this.symbol(id);
    if (!center) throw new Error(`Symbol not found: ${id}`);
    const depth = Math.max(0, Math.min(options.depth ?? 2, 8));
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 50, 500));
    const allEdges = (this.database.prepare("SELECT * FROM edges").all() as EdgeRow[]).map(graphEdgeFromRow).filter((edge) => !options.edgeKinds?.length || options.edgeKinds.includes(edge.kind));
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
    return { center, nodes, edges: [...selectedEdges.values()].filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target)), truncated };
  }

  cycles(): Array<{ nodeIds: string[]; nodes: GraphNode[] }> {
    const edges = (this.database.prepare("SELECT * FROM edges WHERE kind IN ('imports', 'calls')").all() as EdgeRow[]).map(graphEdgeFromRow);
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

  frameworkBindings(framework?: string): Record<string, unknown> {
    const nodes = (this.database.prepare("SELECT * FROM nodes WHERE kind IN ('framework_command', 'framework_event') ORDER BY kind, name").all() as NodeRow[]).map(graphNodeFromRow);
    const selected = framework ? nodes.filter((node) => node.metadata.framework === framework) : nodes;
    return { framework: framework ?? "all", nodes: selected, edges: this.edgesTouching(selected.map((node) => node.id)) };
  }

  diagnostics(): Diagnostic[] {
    return (this.database.prepare("SELECT * FROM diagnostics ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, code").all() as DiagnosticRow[]).map(diagnosticFromRow);
  }

  private nodesByIds(ids: string[]): GraphNode[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.database.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...ids) as NodeRow[]).map(graphNodeFromRow);
  }

  private edgesTouching(ids: string[]): GraphEdge[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.database.prepare(`SELECT * FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).all(...ids, ...ids) as EdgeRow[]).map(graphEdgeFromRow);
  }
}

export async function queryServiceForRepository(input = "."): Promise<QueryService> {
  const root = await resolveRepositoryRoot(input);
  const databasePath = path.join(root, ".prograph", "graph.sqlite");
  try {
    await access(databasePath);
  } catch {
    throw new Error(`No ProGraph index found at ${databasePath}. Run "prograph analyze ${input}" first.`);
  }
  return new QueryService(databasePath);
}
