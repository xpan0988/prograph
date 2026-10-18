import {readSnapshotReport} from "../semantic/snapshot-report.js";
/** Bounded indexed reads of the owned, stable-key compatibility projections. */
import type Database from 'better-sqlite3';
import { READABLE_SEMANTIC_SCHEMAS } from '../semantic/model.js';
import type { GraphScope, GraphNode, GraphEdge } from '../graph/schema.js';
import { NavigationRead, QueryBudgetError } from './navigation.js';
import { scopeBit, asciiFold, QUERY_SCOPES } from './global-projections.js';
import { COMPATIBILITY_QUERY_VERSION } from '../semantic/compatibility-global.js';
import type { FilePageOptions } from './global-read.js';
const maximum = (value: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(value) ? Math.floor(value) : max));
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export class CompatibilityGlobalRead {
  readonly generation: string;
  constructor(private readonly db: Database.Database, readonly budget: NavigationRead) {
    const values = Object.fromEntries(db.prepare("SELECT key,value FROM cq_meta WHERE key IN ('version','snapshot','generation')").all().map(row => {
      const r = row as {
        key: string;
        value: string;
      }; return [r.key, r.value];
    }));
    const active = db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as {
      value: string;
    } | undefined;
    if (values.version !== COMPATIBILITY_QUERY_VERSION || values.snapshot !== active?.value || !values.generation)
      throw Error('Owned global projections are unavailable or do not match the active semantic snapshot; run analyze/sync');
    const metadata = this.rows<{
      key: string;
      value: string;
    }>("SELECT key,value FROM sc_meta WHERE key IN ('format','schema','compatibility-authority')");
    const semantic = Object.fromEntries(metadata.map(row => [row.key, row.value]));
    if (semantic['compatibility-authority'] && semantic['compatibility-authority'] !== 'owned-v1') throw Error('Unsupported semantic compatibility authority');
    if (semantic.format !== '2' || !READABLE_SEMANTIC_SCHEMAS.includes(semantic.schema as typeof READABLE_SEMANTIC_SCHEMAS[number]))
      throw Error('Unsupported Semantic Core compatibility format');
    const cache = Object.fromEntries(this.rows<{
      key: string;
      value: string;
    }>("SELECT key,value FROM cg_meta WHERE key IN ('snapshot','schema','reportKey')").map(row => [row.key, row.value]));
    const report = readSnapshotReport(db,Number(values.snapshot));
    budget.charge(report?{report:JSON.stringify(report)}:{});
    if (semantic['compatibility-authority'] && (report?.format!==2 || !report.compatibilityReady)) throw Error('Current semantic compatibility report is unqualified; run analyze/sync');
    if (cache.schema !== 'owned-compatibility-1' || cache.snapshot !== values.snapshot || cache.reportKey !== values.generation || report?.reportKey !== values.generation)
      throw Error('Compatibility/report projection does not match the semantic snapshot');
    this.generation = `${values.generation}:${COMPATIBILITY_QUERY_VERSION}`;
    budget.charge({ generation: this.generation });
  }
  private rows<T extends object>(sql: string, ...args: unknown[]): T[] {
    const result: T[] = []; for (const raw of this.db.prepare(sql).iterate(...args)) {
      this.budget.charge(raw as object);
      result.push(raw as T);
    } return result;
  }
  private json<T>(row: {
    data: string | null;
  } | undefined): T {
    if (!row)
      throw Error('Missing owned query projection'); if (row.data === null)
      throw new QueryBudgetError('payload', 'projection exceeds 1 MiB; use a smaller or offline query'); this.budget.charge(row); return JSON.parse(row.data);
  }
  private cursor(value: string | undefined, operation: string): Record<string, unknown> | undefined {
    if (!value)
      return undefined;
    if (value.length > 2048)
      throw Error('Invalid query cursor');
    let cursor: Record<string, unknown>;
    try {
      cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    }
    catch {
      throw Error('Invalid query cursor');
    }
    if (cursor.generation !== this.generation || cursor.operation !== operation)
      throw Error('Cursor does not match operation/index generation');
    return cursor;
  }
  private encode(operation: string, after: unknown) { return Buffer.from(JSON.stringify({ generation: this.generation, operation, after })).toString('base64url'); }
  summary(scope: GraphScope): Record<string, unknown> {
    scopeBit(scope);
    const rows = this.rows<{
      scope: string;
      dimension: string;
      kind: string;
      n: number;
    }>('SELECT scope,dimension,kind,n FROM cq_counts WHERE scope IN (?,?) LIMIT 1001', scope, '*');
    if (rows.length > 1000)
      throw new QueryBudgetError('candidates', 'too many summary categories');
    const total = (key: string) => rows.find(row => row.scope === '*' && row.dimension === 'total' && row.kind === key)?.n ?? 0;
    const by = (dimension: string) => rows.filter(row => row.scope === scope && row.dimension === dimension).map(row => ({ kind: row.kind, count: row.n })).sort((a, b) => b.count - a.count || binary(a.kind, b.kind));
    const nodesByKind = by('nodes'), edgesByKind = by('edges');
    return { counts: { files: rows.find(row => row.scope === scope && row.dimension === 'total' && row.kind === 'files')?.n ?? 0, nodes: nodesByKind.reduce((n, row) => n + row.count, 0), edges: edgesByKind.reduce((n, row) => n + row.count, 0), diagnostics: total('diagnostics') }, totalCounts: { files: total('files'), nodes: total('nodes'), edges: total('edges'), diagnostics: total('diagnostics') }, nodesByKind, edgesByKind };
  }
  filePage(options: FilePageOptions = {}): Record<string, unknown> {
    const scope = options.scope ?? 'code';
    scopeBit(scope);
    const limit = maximum(options.limit ?? 200, 1000), cursor = this.cursor(options.cursor, `files:${scope}`);
    const after = cursor?.after ?? '';
    if (typeof after !== 'string')
      throw Error('Invalid files cursor');
    const rows = this.rows<{
      path: string;
      data: string | null;
    }>('SELECT path,CASE WHEN bytes<=1048576 THEN data END AS data FROM cq_files WHERE scope=? AND path>? ORDER BY path LIMIT ?', scope, after, limit + 1);
    const truncated = rows.length > limit;
    return { items: rows.slice(0, limit).map(row => this.json<Record<string, unknown>>(row)), generation: this.generation, scope, truncated, nextCursor: truncated ? this.encode(`files:${scope}`, rows[limit - 1]!.path) : null, bounded: { maxItems: limit } };
  }
  files(scope: GraphScope): Array<Record<string, unknown>> {
    const page = this.filePage({ scope, limit: 1000 }); if (page.truncated)
      throw new QueryBudgetError('candidates', 'file list exceeds 1000 items; use files-page'); return page.items as Array<Record<string, unknown>>;
  }
  contextCandidates(scope: GraphScope): Array<{
    node: string;
    degree: number;
    name: string;
    qualified: string;
    file: string;
    qualified_original: string;
    kind: string;
  }> {
    const rows = this.rows<{
      node: string;
      degree: number;
      name: string | null;
      qualified: string;
      file: string;
      qualified_original: string;
      kind: string;
      mask: number;
    }>(`SELECT node,degree,CASE WHEN bytes<=65536 THEN name_lower END AS name,CASE WHEN bytes<=65536 THEN qualified_lower END AS qualified,CASE WHEN bytes<=65536 THEN file_lower END AS file,CASE WHEN bytes<=65536 THEN qualified END AS qualified_original,kind,mask FROM cq_nodes WHERE context_eligible=1 ORDER BY degree DESC,qualified,node LIMIT 2000`);
    if (rows.some(row => row.name === null))
      throw new QueryBudgetError('payload', 'context candidate metadata exceeds 64 KiB');
    return rows.filter(row => row.mask & scopeBit(scope)) as Array<{
      node: string;
      degree: number;
      name: string;
      qualified: string;
      file: string;
      qualified_original: string;
      kind: string;
    }>;
  }
  search(query: string, maxNodes: number, scope: GraphScope, includeUnresolved: boolean): GraphNode[] {
    if (maxNodes === 0)
      return [];
    if (query.length > 256)
      throw Error('Symbol query exceeds 256 characters');
    const max = maximum(maxNodes, 200), folded = asciiFold(query);
    type Candidate = {
      node: string;
      name: string | null;
      qualified: string;
      scope_mask: number;
      unresolved: number;
    };
    let rows: Candidate[];
    const fields = 'node,CASE WHEN bytes<=65536 THEN name END AS name,CASE WHEN bytes<=65536 THEN qualified END AS qualified,scope_mask,unresolved';
    if (!query)
      rows = this.rows<Candidate>(`SELECT ${fields} FROM cq_search_docs ${includeUnresolved ? '' : 'WHERE unresolved=0'} ORDER BY empty_priority,name,qualified,node LIMIT ?`, max * 4);
    else if ([...query].length < 3)
      rows = this.rows<Candidate>(`SELECT ${fields} FROM cq_search_docs WHERE name_fold=? ORDER BY node LIMIT 10001`, folded);
    else
      rows = this.rows<Candidate>(`SELECT d.node,CASE WHEN d.bytes<=65536 THEN d.name END AS name,CASE WHEN d.bytes<=65536 THEN d.qualified END AS qualified,d.scope_mask,d.unresolved FROM(SELECT rowid FROM cq_search WHERE cq_search MATCH ? LIMIT 10001)hits CROSS JOIN cq_search_docs d ON d.ordinal=hits.rowid`, '"' + query.replaceAll('"', '""') + '"');
    if (rows.some(row => row.name === null))
      throw new QueryBudgetError('payload', 'symbol candidate metadata exceeds 64 KiB');
    if (rows.length > 10000)
      throw new QueryBudgetError('candidates', 'more than 10000 symbol candidates; refine query');
    const priority = (row: Candidate) => row.name === query ? 0 : row.unresolved ? 2 : 1;
    return rows.filter(row => (includeUnresolved || !row.unresolved) && (!query || asciiFold(row.name!).includes(folded) || asciiFold(row.qualified).includes(folded))).sort((a, b) => priority(a) - priority(b) || binary(a.name!, b.name!) || binary(a.qualified, b.qualified) || binary(a.node, b.node)).slice(0, max * 4).filter(row => row.scope_mask & scopeBit(scope)).slice(0, max).map(row => this.budget.node(row.node)!);
  }
  diagnosticPage(options: {
    limit?: number;
    cursor?: string;
  } = {}): Record<string, unknown> {
    const limit = maximum(options.limit ?? 200, 1000), cursor = this.cursor(options.cursor, 'diagnostics');
    const after = cursor?.after ?? [-1, '', ''];
    if (!Array.isArray(after) || after.length !== 3 || !Number.isInteger(after[0]) || typeof after[1] !== 'string' || typeof after[2] !== 'string')
      throw Error('Invalid diagnostics cursor');
    const rows = this.rows<{
      key: string;
      severity: number;
      code: string;
      data: string | null;
    }>(`SELECT key,severity,code,CASE WHEN bytes<=1048576 THEN data END AS data FROM cq_diagnostics WHERE(severity,code,key)>(?,?,?)ORDER BY severity,code,key LIMIT ?`, ...after, limit + 1);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const row of this.rows<{
      kind: keyof typeof counts;
      n: number;
    }>("SELECT kind,n FROM cq_counts WHERE scope='*' AND dimension='diagnostics' LIMIT 4"))
      if (Object.hasOwn(counts, row.kind))
        counts[row.kind] = row.n;
      else
        throw Error('Invalid diagnostic severity counter');
    const last = rows[limit - 1], truncated = rows.length > limit;
    return { items: rows.slice(0, limit).map(row => this.json<Record<string, unknown>>(row)), counts, generation: this.generation, truncated, nextCursor: truncated ? this.encode('diagnostics', [last!.severity, last!.code, last!.key]) : null, bounded: { maxItems: limit } };
  }
  /** Merge bounded stable-key index streams; every candidate and empty probe is charged. */
  private merge<T extends {
    edge: string;
  }>(next: Array<() => T | undefined>, limit: number): {
    rows: T[];
    truncated: boolean;
  } {
    const heap: Array<{
      stream: number;
      row: T;
    }> = [];
    const push = (item: {
      stream: number;
      row: T;
    }) => {
      let at = heap.length; heap.push(item); while (at) {
        const parent = (at - 1) >> 1;
        if (binary(heap[parent]!.row.edge, item.row.edge) <= 0)
          break;
        heap[at] = heap[parent]!;
        at = parent;
      } heap[at] = item;
    };
    const pop = () => {
      const best = heap[0]!, last = heap.pop()!; if (heap.length) {
        let at = 0;
        while (2 * at + 1 < heap.length) {
          let child = 2 * at + 1;
          if (child + 1 < heap.length && binary(heap[child + 1]!.row.edge, heap[child]!.row.edge) < 0)
            child++;
          if (binary(last.row.edge, heap[child]!.row.edge) <= 0)
            break;
          heap[at] = heap[child]!;
          at = child;
        }
        heap[at] = last;
      } return best;
    };
    next.forEach((get, stream) => {
      const row = get(); if (row)
        push({ stream, row });
    });
    const rows: T[] = [];
    let previous: string | undefined;
    while (heap.length && rows.length <= limit) {
      const item = pop();
      if (item.row.edge !== previous) {
        previous = item.row.edge;
        rows.push(item.row);
      }
      const row = next[item.stream]!();
      if (row)
        push({ stream: item.stream, row });
    }
    return { rows: rows.slice(0, limit), truncated: rows.length > limit || heap.length > 0 };
  }
  private pairRows(ids: string[], scope: GraphScope, level: number, limit: number) {
    const query = this.db.prepare('SELECT edge,mask,level FROM cq_edges INDEXED BY cq_edge_pair WHERE source=? AND target=? AND edge>? ORDER BY edge LIMIT 1');
    const streams: Array<() => {
      edge: string;
      mask: number;
    } | undefined> = [];
    for (const source of ids)
      for (const target of ids) {
        let after = '';
        streams.push(() => {
          while (true) {
            const row = query.get(source, target, after) as {
              edge: string;
              mask: number;
              level: number;
            } | undefined;
            this.budget.charge(row ?? {});
            if (!row)
              return;
            after = row.edge;
            if (row.level <= level && (row.mask & scopeBit(scope)))
              return row;
          }
        });
      }
    return this.merge(streams, limit);
  }
  architecture(maxNodes: number, scope: GraphScope, level: number): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
  } {
    scopeBit(scope);
    const max = maxNodes === 0 ? 0 : maximum(maxNodes, 100);
    if (scope !== 'code') {
      const rows = this.rows<{
        node: string;
      }>('SELECT node FROM cq_scope_nodes WHERE scope=? ORDER BY rank,qualified,node LIMIT ?', scope, max + 1);
      const nodes = rows.slice(0, max).map(row => this.budget.node(row.node)!);
      const selected = this.pairRows(nodes.map(node => node.id), scope, level, 1000);
      return { nodes, edges: selected.rows.map(row => this.budget.edge(row.edge)!), truncated: rows.length > max || selected.truncated };
    }
    const rows = this.rows<{
      id: string;
      is_file: number;
      data: string | null;
    }>('SELECT id,is_file,CASE WHEN bytes<=1048576 THEN data END AS data FROM cq_arch_nodes WHERE level=? ORDER BY is_file DESC,sort_key,id LIMIT ?', level, max + 1);
    const nodes = rows.slice(0, max).map(row => this.json<GraphNode>(row)), incoming = new Map<string, number>(), outgoing = new Map<string, number>(), pairs: Array<{
      source: string;
      target: string;
    }> = [];
    const query = this.db.prepare('SELECT source,target FROM cq_arch_edges WHERE level=? AND source=? AND target=?');
    for (const source of nodes)
      for (const target of nodes) {
        const row = query.get(level, source.id, target.id) as {
          source: string;
          target: string;
        } | undefined;
        this.budget.charge(row ?? {});
        if (row) {
          pairs.push(row);
          incoming.set(row.target, (incoming.get(row.target) ?? 0) + 1);
          outgoing.set(row.source, (outgoing.get(row.source) ?? 0) + 1);
        }
      }
    pairs.sort((a, b) => binary(a.source, b.source) || binary(a.target, b.target));
    const payload = this.db.prepare('SELECT CASE WHEN bytes<=1048576 THEN data END AS data FROM cq_arch_edges WHERE level=? AND source=? AND target=?');
    const edges = pairs.slice(0, 1000).map(row => this.json<GraphEdge>(payload.get(level, row.source, row.target) as {
      data: string | null;
    }));
    for (const node of nodes)
      node.metadata = { ...node.metadata, incomingCount: incoming.get(node.id) ?? 0, outgoingCount: outgoing.get(node.id) ?? 0 };
    const count = this.db.prepare("SELECT n FROM cq_counts WHERE scope='*' AND dimension='architecture' AND kind='files'").get() as {
      n: number;
    } | undefined;
    this.budget.charge(count ?? {});
    return { nodes, edges, truncated: (count?.n ?? 0) > rows.slice(0, max).filter(row => row.is_file).length || pairs.length > 1000 || nodes.some(node => node.metadata.containedSymbolsTruncated === true) };
  }
  framework(framework: string | undefined, level: number): {
    selected: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
  } {
    const rows = this.rows<{
      node: string;
    }>('SELECT node FROM cq_boundaries WHERE framework=? ORDER BY kind,name,node LIMIT 201', framework ?? '');
    const selected = rows.slice(0, 200).map(row => this.budget.node(row.node)!);
    const query = this.db.prepare('SELECT edge FROM cq_boundary_edges WHERE framework=? AND node=? AND level=? AND edge>? ORDER BY edge LIMIT 1'), streams: Array<() => {
      edge: string;
    } | undefined> = [];
    for (const node of selected)
      for (let tier = 0;tier <= level;tier++) {
        let after = '';
        streams.push(() => {
          const row = query.get(framework ?? '', node.id, tier, after) as {
            edge: string;
          } | undefined; this.budget.charge(row ?? {}); if (row)
            after = row.edge; return row;
        });
      }
    const edges = this.merge(streams, 1000);
    return { selected, edges: edges.rows.map(row => this.budget.edge(row.edge)!), truncated: rows.length > 200 || edges.truncated };
  }
  cycles(scope: GraphScope, level: number): Array<{
    nodeIds: string[];
    nodes: GraphNode[];
  }> {
    scopeBit(scope);
    const state = this.db.prepare("SELECT value FROM cq_meta WHERE key='cycles'").get() as {
      value: string;
    } | undefined;
    this.budget.charge(state ?? {});
    if (state?.value !== 'ready')
      throw new QueryBudgetError('candidates', 'Owned cycle projection is unavailable or invalidated; run prepare-queries offline');
    const error = this.db.prepare('SELECT reason FROM cq_cycle_errors WHERE scope=? AND level=?').get(scope, level) as {
      reason: string;
    } | undefined;
    this.budget.charge(error ?? {});
    if (error)
      throw new QueryBudgetError('candidates', error.reason);
    const rows = this.rows<{
      data: string | null;
    }>('SELECT CASE WHEN bytes<=1048576 THEN data END AS data FROM cq_cycles WHERE scope=? AND level=? ORDER BY ordinal LIMIT 201', scope, level);
    if (rows.length > 200)
      throw new QueryBudgetError('candidates', 'more than 200 precomputed cycles; use filtered offline analysis');
    return rows.map(row => { const nodeIds = this.json<string[]>(row); return { nodeIds, nodes: [...nodeIds].sort(binary).map(id => this.budget.node(id)!) }; });
  }
}
