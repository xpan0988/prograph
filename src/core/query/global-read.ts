import type Database from "better-sqlite3";
import type { GraphNode, GraphEdge, GraphScope } from "../graph/schema.js";
import { NavigationRead, QueryBudgetError } from "./navigation.js";
import { GLOBAL_QUERY_VERSION, scopeBit, asciiFold } from "./global-projections.js";

export interface FilePageOptions { scope?: GraphScope; limit?: number; cursor?: string }
interface PairRow { ordinal: number; id: string; source: string; target: string; scope_mask: number; level: number }
const maximum = (value: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(value) ? Math.floor(value) : max));

/** Every operation runs under QueryService's read transaction and the isolated worker deadline. */
export class GlobalRead {
  readonly generation: string;
  constructor(private readonly db: Database.Database, readonly budget: NavigationRead) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='q_meta'").get();
    const version = table ? db.prepare("SELECT value FROM q_meta WHERE key='version'").get() as { value: string } | undefined : undefined;
    const generation = table ? db.prepare("SELECT value FROM q_meta WHERE key='generation'").get() as { value: string } | undefined : undefined;
    const source = table ? db.prepare("SELECT value FROM q_meta WHERE key='source_generation'").get() as { value: string } | undefined : undefined;
    if (version?.value !== GLOBAL_QUERY_VERSION || !generation || !source) throw Error('Global query projections unavailable or stale. Run "prograph prepare-queries" offline, or analyze/sync the index.');
    const current = db.prepare("SELECT MAX(id) AS id FROM analysis_runs").get() as { id: number };
    if (source.value !== String(current.id)) throw Error('Global query projections unavailable or stale. Run "prograph prepare-queries" offline, or analyze/sync the index.');
    const identity = db.prepare("SELECT value FROM repository_metadata WHERE key='identity'").get() as { value: string } | undefined;
    this.generation = `${identity?.value ?? "legacy"}:${generation.value}:${GLOBAL_QUERY_VERSION}`;
    budget.charge({ version: version.value, generation: this.generation });
  }
  private rows<T extends object>(sql: string, ...parameters: unknown[]): T[] {
    const rows: T[] = [];
    for (const raw of this.db.prepare(sql).iterate(...parameters)) { this.budget.charge(raw as object); rows.push(raw as T); }
    return rows;
  }
  private json<T>(row: { data: string | null } | undefined): T {
    if (!row) throw Error("Missing global projection row");
    if (row.data === null) throw new QueryBudgetError("payload", "projection row exceeds 1 MiB; use a smaller or offline query");
    this.budget.charge(row); return JSON.parse(row.data) as T;
  }
  summary(scope: GraphScope): Record<string, unknown> {
    return this.json(this.db.prepare("SELECT CASE WHEN bytes<=1048576 THEN data END AS data FROM q_summaries WHERE scope=?").get(scope) as { data: string | null });
  }
  filePage(options: FilePageOptions = {}): Record<string, unknown> {
    const scope = options.scope ?? "code"; scopeBit(scope); const limit = maximum(options.limit ?? 200, 1000); let after = 0;
    if (options.cursor) {
      if (options.cursor.length > 1024) throw Error("Invalid files cursor");
      let cursor: { generation: string; scope: string; after: number };
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as typeof cursor; } catch { throw Error("Invalid files cursor"); }
      if (cursor.generation !== this.generation || cursor.scope !== scope || !Number.isSafeInteger(cursor.after) || cursor.after < 0) throw Error("Files cursor does not match scope/index generation");
      after = cursor.after;
    }
    const rows = this.rows<{ ordinal: number; data: string | null }>("SELECT ordinal,CASE WHEN bytes<=1048576 THEN data END AS data FROM q_files WHERE scope=? AND ordinal>? ORDER BY ordinal LIMIT ?", scope, after, limit + 1);
    const items = rows.slice(0, limit).map(row => this.json<Record<string, unknown>>(row));
    const truncated = rows.length > limit;
    return { items, generation: this.generation, scope, truncated, nextCursor: truncated ? Buffer.from(JSON.stringify({ generation: this.generation, scope, after: rows[limit - 1]!.ordinal })).toString("base64url") : null, bounded: { maxItems: limit } };
  }
  files(scope: GraphScope): Array<Record<string, unknown>> {
    const first = this.filePage({ scope, limit: 1000 });
    if (first.truncated) throw new QueryBudgetError("candidates", "file list exceeds 1000 items; use files-page / the filePage API cursor");
    return first.items as Array<Record<string, unknown>>;
  }
  private pairRows(ids: string[], scope: GraphScope, level: number, limit: number): { rows: PairRow[]; truncated: boolean } {
    const query = this.db.prepare("SELECT ordinal,id,source,target,scope_mask,level FROM q_edges INDEXED BY q_edges_pair WHERE source=? AND target=? AND ordinal>? ORDER BY ordinal LIMIT 1");
    interface Stream { source: string; target: string; after: number; row: PairRow }
    const heap: Stream[] = [];
    const push = (stream: Stream) => { let at = heap.length; heap.push(stream); while (at) { const parent = (at - 1) >> 1; if (heap[parent]!.row.ordinal <= stream.row.ordinal) break; heap[at] = heap[parent]!; at = parent; } heap[at] = stream; };
    const pop = () => { const best = heap[0]!; const last = heap.pop()!; if (heap.length) { let at = 0; while (2 * at + 1 < heap.length) { let child = 2 * at + 1; if (child + 1 < heap.length && heap[child + 1]!.row.ordinal < heap[child]!.row.ordinal) child++; if (last.row.ordinal <= heap[child]!.row.ordinal) break; heap[at] = heap[child]!; at = child; } heap[at] = last; } return best; };
    const next = (source: string, target: string, after: number): Stream | undefined => {
      while (true) {
        const row = query.get(source, target, after) as PairRow | undefined; this.budget.charge(row ?? {});
        if (!row) return undefined; after = row.ordinal;
        if (row.scope_mask & scopeBit(scope) && row.level <= level) return { source, target, after, row };
      }
    };
    for (const source of ids) for (const target of ids) { const stream = next(source, target, 0); if (stream) push(stream); }
    const rows: PairRow[] = [];
    while (heap.length && rows.length < limit) { const stream = pop(); rows.push(stream.row); const following = next(stream.source, stream.target, stream.after); if (following) push(following); }
    return { rows, truncated: heap.length > 0 };
  }
  architecture(maxNodes: number, scope: GraphScope, level: number): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const max = maxNodes === 0 ? 0 : maximum(maxNodes, 100);
    if (scope !== "code") {
      const rows = this.rows<{ node: string }>("SELECT node FROM q_scope_nodes WHERE scope=? AND ordinal>0 ORDER BY ordinal LIMIT ?", scope, max + 1);
      const nodes = rows.slice(0, max).map(row => { this.budget.charge(row); const node = this.budget.node(row.node); if (!node) throw Error("Projection endpoint missing"); return node; });
      const selected = this.pairRows(nodes.map(node => node.id), scope, level, 1000);
      const edges = selected.rows.map(row => this.budget.edge(row.id)!);
      return { nodes, edges, truncated: rows.length > max || selected.truncated };
    }
    const rows = this.rows<{ id: string; is_file: number; data: string | null }>("SELECT ordinal,id,is_file,CASE WHEN bytes<=1048576 THEN data END AS data FROM q_arch_nodes WHERE level=? AND ordinal>0 ORDER BY ordinal LIMIT ?", level, max + 1);
    const nodes = rows.slice(0, max).map(row => this.json<GraphNode>(row)); const incoming = new Map<string, number>(); const outgoing = new Map<string, number>();
    const pairs: { source: string; target: string }[] = [];
    const pair = this.db.prepare("SELECT source,target FROM q_arch_edges WHERE level=? AND source=? AND target=?");
    for (const source of nodes) for (const target of nodes) {
      const row = pair.get(level, source.id, target.id) as { source: string; target: string } | undefined; this.budget.charge(row ?? {});
      if (row) { pairs.push(row); incoming.set(row.target, (incoming.get(row.target) ?? 0) + 1); outgoing.set(row.source, (outgoing.get(row.source) ?? 0) + 1); }
    }
    pairs.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    const edgeQuery = this.db.prepare("SELECT CASE WHEN bytes<=1048576 THEN data END AS data FROM q_arch_edges WHERE level=? AND source=? AND target=?");
    const edges = pairs.slice(0, 1000).map(row => this.json<GraphEdge>(edgeQuery.get(level, row.source, row.target) as { data: string | null }));
    for (const node of nodes) node.metadata = { ...node.metadata, incomingCount: incoming.get(node.id) ?? 0, outgoingCount: outgoing.get(node.id) ?? 0 };
    const total = this.db.prepare("SELECT value FROM q_meta WHERE key=?").get(`arch-files:${level}`) as { value: string };
    return { nodes, edges, truncated: Number(total.value) > rows.slice(0, max).filter(row => row.is_file).length || pairs.length > 1000 || nodes.some(node => node.metadata.containedSymbolsTruncated === true) };
  }
  cycles(scope: GraphScope, level: number): Array<{ nodeIds: string[]; nodes: GraphNode[] }> {
    const error = this.db.prepare("SELECT reason FROM q_cycle_errors WHERE scope=? AND level=?").get(scope, level) as { reason: string } | undefined;
    if (error) throw new QueryBudgetError("candidates", error.reason);
    const rows = this.rows<{ data: string | null }>("SELECT CASE WHEN bytes<=1048576 THEN data END AS data FROM q_cycles WHERE scope=? AND level=? AND ordinal>0 ORDER BY ordinal LIMIT 201", scope, level);
    if (rows.length > 200) throw new QueryBudgetError("candidates", "more than 200 precomputed cycles; use a filtered offline analysis");
    return rows.map(row => {
      const nodeIds = this.json<string[]>(row);
      // Legacy IN lookup returns SQLite's BINARY key order, independently of cycle order.
      const nodes = [...nodeIds].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(id => { this.budget.charge({ id }); return this.budget.node(id)!; });
      return { nodeIds, nodes };
    });
  }
  contextCandidates(scope: GraphScope): Array<{ node: string; degree: number; name: string; qualified: string; file: string; qualified_original: string; kind: string }> {
    const rows = this.rows<{ node: string; degree: number; name: string; qualified: string; file: string; qualified_original: string; kind: string }>(`SELECT node,degree,
      CASE WHEN bytes<=65536 THEN name END AS name,CASE WHEN bytes<=65536 THEN qualified END AS qualified,CASE WHEN bytes<=65536 THEN file END AS file,
      CASE WHEN bytes<=65536 THEN qualified_original END AS qualified_original,kind,scope_mask FROM q_context WHERE ordinal>0 ORDER BY ordinal LIMIT 2000`);
    if (rows.some(row => row.name === null)) throw new QueryBudgetError("payload", "context candidate metadata exceeds 64 KiB");
    return rows.filter(row => (row as typeof row & { scope_mask: number }).scope_mask & scopeBit(scope));
  }
  search(query: string, maxNodes: number, scope: GraphScope, includeUnresolved: boolean): GraphNode[] {
    if (maxNodes === 0) return [];
    if (query.length > 256) throw Error("Symbol query exceeds 256 characters");
    const max = maximum(maxNodes, 200); const folded = asciiFold(query);
    type Candidate = { node: string; name: string; qualified: string; scope_mask: number; unresolved: number };
    let rows: Candidate[];
    if (!query) rows = this.rows<Candidate>(`SELECT node,CASE WHEN bytes<=65536 THEN name END AS name,CASE WHEN bytes<=65536 THEN qualified END AS qualified,scope_mask,unresolved FROM q_search_docs ${includeUnresolved ? "" : "WHERE unresolved=0"} ORDER BY empty_priority,name_order LIMIT ?`, max * 4);
    else if ([...query].length < 3) rows = this.rows<Candidate>("SELECT node,CASE WHEN bytes<=65536 THEN name END AS name,CASE WHEN bytes<=65536 THEN qualified END AS qualified,scope_mask,unresolved FROM q_search_docs WHERE name_fold=? ORDER BY ordinal LIMIT 10001", folded);
    else rows = this.rows<Candidate>(`SELECT d.node,CASE WHEN d.bytes<=65536 THEN d.name END AS name,CASE WHEN d.bytes<=65536 THEN d.qualified END AS qualified,d.scope_mask,d.unresolved FROM (SELECT rowid FROM q_search WHERE q_search MATCH ? ORDER BY rowid LIMIT 10001) hits CROSS JOIN q_search_docs d ON d.ordinal=hits.rowid`, '"' + query.replaceAll('"', '""') + '"');
    if (rows.some(row => row.name === null)) throw new QueryBudgetError("payload", "symbol candidate metadata exceeds 64 KiB");
    if (rows.length > 10000) throw new QueryBudgetError("candidates", "more than 10000 symbol candidates; refine the query");
    const priority = (row: Candidate) => row.name === query ? 0 : row.unresolved ? 2 : 1;
    const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    rows = rows.filter(row => (includeUnresolved || !row.unresolved) && (!query || asciiFold(row.name).includes(folded) || asciiFold(row.qualified).includes(folded)))
      .sort((a, b) => priority(a) - priority(b) || binary(a.name, b.name) || binary(a.qualified, b.qualified)).slice(0, max * 4)
      .filter(row => row.scope_mask & scopeBit(scope)).slice(0, max);
    return rows.map(row => this.budget.node(row.node)!);
  }
  diagnosticPage(options: { limit?: number; cursor?: string } = {}): Record<string, unknown> {
    const limit = maximum(options.limit ?? 200, 1000); let after = 0;
    if (options.cursor) {
      if (options.cursor.length > 1024) throw Error("Invalid diagnostics cursor");
      let cursor: { generation: string; operation: string; after: number };
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as typeof cursor; } catch { throw Error("Invalid diagnostics cursor"); }
      if (cursor.generation !== this.generation || cursor.operation !== "diagnostics" || !Number.isSafeInteger(cursor.after) || cursor.after < 0) throw Error("Diagnostics cursor does not match index generation"); after = cursor.after;
    }
    const rows = this.rows<{ ordinal: number; data: string | null }>("SELECT ordinal,CASE WHEN bytes<=1048576 THEN data END AS data FROM q_diagnostics WHERE ordinal>? ORDER BY ordinal LIMIT ?", after, limit + 1);
    const items = rows.slice(0, limit).map(row => this.json<Record<string, unknown>>(row)); const truncated = rows.length > limit;
    const counts = this.json<Record<string, number>>(this.db.prepare("SELECT value AS data FROM q_meta WHERE key='diagnostic_counts'").get() as { data: string });
    return { items, counts, generation: this.generation, truncated, nextCursor: truncated ? Buffer.from(JSON.stringify({ generation: this.generation, operation: "diagnostics", after: rows[limit - 1]!.ordinal })).toString("base64url") : null, bounded: { maxItems: limit } };
  }
  framework(framework: string | undefined, level: number): { selected: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const rows = this.db.prepare("SELECT node FROM q_boundaries WHERE framework=? AND ordinal>0 ORDER BY ordinal LIMIT 201").all(framework ?? "") as { node: string }[];
    const selected = rows.slice(0, 200).map(row => { this.budget.charge(row); return this.budget.node(row.node)!; });
    const edgeRows = this.db.prepare("SELECT edge FROM q_framework_edges WHERE framework=? AND level=? AND ordinal>0 ORDER BY ordinal LIMIT 1001").all(framework ?? "", level) as { edge: string }[];
    const edges = edgeRows.slice(0, 1000).map(row => { this.budget.charge(row); return this.budget.edge(row.edge)!; });
    return { selected, edges, truncated: rows.length > 200 || edgeRows.length > 1000 };
  }
}
