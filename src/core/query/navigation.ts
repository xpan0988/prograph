import type Database from "better-sqlite3";
import type { GraphEdge, GraphNode } from "../graph/schema.js";
import { graphEdgeFromRow, graphNodeFromRow, type EdgeRow, type NodeRow } from "../storage/sqlite.js";

export interface NavigationLimits {
  maxCandidates?: number;
  maxPayloadBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}
export class QueryBudgetError extends Error {
  readonly code = "QUERY_BUDGET_EXCEEDED";
  constructor(readonly reason: "candidates" | "payload" | "deadline" | "cancelled", detail: string) {
    super(`Query ${reason} budget exceeded: ${detail}`);
  }
}
type EdgeCursor = EdgeRow & { cursor: number };
type Direction = "source" | "target" | "both";

/** Indexed raw adjacency pages. Rejected confidence/scope rows still consume work. */
export class NavigationRead {
  private readonly cache = new Map<string, GraphNode | undefined>();
  private readonly started = performance.now();
  private candidates = 0;
  private bytes = 0;
  private readonly maxCandidates: number;
  private readonly maxBytes: number;
  private readonly deadline: number;
  constructor(private readonly db: Database.Database, private readonly limits: NavigationLimits = {}) {
    this.maxCandidates = limits.maxCandidates ?? 20000;
    this.maxBytes = limits.maxPayloadBytes ?? 8 * 1024 ** 2;
    this.deadline = limits.deadlineMs ?? 1000;
    if (![this.maxCandidates, this.maxBytes, this.deadline].every(n => Number.isSafeInteger(n) && n > 0)) throw Error("Invalid navigation work limits");
  }
  check(): void {
    if (this.limits.signal?.aborted) throw new QueryBudgetError("cancelled", "execution aborted");
    if (performance.now() - this.started > this.deadline) throw new QueryBudgetError("deadline", `${this.deadline}ms`);
  }
  private charge(row: NodeRow | EdgeRow): void {
    this.check();
    if (++this.candidates > this.maxCandidates) throw new QueryBudgetError("candidates", `${this.maxCandidates} raw rows`);
    for (const value of Object.values(row)) if (typeof value === "string") this.bytes += Buffer.byteLength(value);
    if (this.bytes > this.maxBytes) throw new QueryBudgetError("payload", `${this.maxBytes} bytes`);
  }
  node(id: string): GraphNode | undefined {
    this.check();
    if (!this.cache.has(id)) {
      const row = this.db.prepare("SELECT * FROM nodes WHERE id=?").get(id) as NodeRow | undefined;
      // Missing endpoints must also consume lookup work.
      if (row) this.charge(row); else if (++this.candidates > this.maxCandidates) throw new QueryBudgetError("candidates", "endpoint lookups");
      this.cache.set(id, row ? graphNodeFromRow(row) : undefined);
    }
    return this.cache.get(id);
  }
  *fileRoots(file: string): Generator<GraphNode> {
    yield* this.fileNodes(file, true);
  }
  *fileNodes(file: string, rootsOnly = false): Generator<GraphNode> {
    const query = this.db.prepare(`SELECT * FROM nodes INDEXED BY idx_nodes_file WHERE file=? ${rootsOnly ? "AND kind NOT IN ('file','directory','repository','unresolved_symbol') ORDER BY start_line" : "ORDER BY start_line,name"}`);
    for (const row of query.iterate(file) as Iterable<NodeRow>) { this.charge(row); const node = graphNodeFromRow(row); this.cache.set(node.id, node); yield node; }
  }
  /** Preserve the old multi-index OR order for file dependency arrays. */
  *fileEdges(ids: string[]): Generator<GraphEdge> {
    const ordered = [...new Set(ids)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const seen = new Set<string>();
    for (const column of ["source", "target"] as const) for (const id of ordered) for (const edge of this.edges([id], column)) {
      if (!seen.has(edge.id)) { seen.add(edge.id); yield edge; }
    }
  }
  /** Merge indexed streams in insertion order, matching the former full-table scan. */
  *edges(ids: Iterable<string>, direction: Direction): Generator<GraphEdge> {
    const columns = direction === "both" ? ["source", "target"] as const : [direction];
    const statements = new Map(columns.map(column => [column, this.db.prepare(`SELECT rowid AS cursor,* FROM edges INDEXED BY idx_edges_${column} WHERE ${column}=? AND rowid>? ORDER BY rowid LIMIT ?`)]));
    const streams: Array<{ id: string; column: "source" | "target"; after: number; rows: EdgeCursor[]; offset: number }> = [];
    const fill = (stream: typeof streams[number], count: number) => {
      this.check();
      const remaining = this.maxCandidates - this.candidates;
      if (remaining <= 0) throw new QueryBudgetError("candidates", `${this.maxCandidates} raw rows`);
      stream.rows = statements.get(stream.column)!.all(stream.id, stream.after, Math.min(count, remaining)) as EdgeCursor[];
      stream.offset = 0;
      for (const row of stream.rows) this.charge(row);
    };
    for (const id of new Set(ids)) for (const column of columns) {
      const stream = { id, column, after: 0, rows: [] as EdgeCursor[], offset: 0 };
      fill(stream, 1); if (stream.rows.length) streams.push(stream);
    }
    let last = 0;
    while (streams.length) {
      this.check();
      // At most 2 * bounded frontier width heads; no global edge array.
      let best = 0;
      for (let i = 1; i < streams.length; i++) if (streams[i]!.rows[streams[i]!.offset]!.cursor < streams[best]!.rows[streams[best]!.offset]!.cursor) best = i;
      const stream = streams[best]!; const row = stream.rows[stream.offset++]!;
      stream.after = row.cursor;
      if (row.cursor !== last) { last = row.cursor; yield graphEdgeFromRow(row); }
      if (stream.offset === stream.rows.length) { fill(stream, 32); if (!stream.rows.length) streams.splice(best, 1); }
    }
  }
}
