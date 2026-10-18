/** Incremental query projections of the owned compatibility cache. Not a fact authority. */
import { graphNodeFromRow, graphEdgeFromRow, diagnosticFromRow, type NodeRow, type EdgeRow, type DiagnosticRow } from '../storage/sqlite.js';
import path from 'node:path';
import { evidenceOf } from '../graph/metadata.js';
import type { GraphNode, GraphEdge, Diagnostic } from '../graph/schema.js';
import type { SemanticStore } from './store.js';
import type { CompatibilityChange } from './compatibility-cache.js';
import { QUERY_SCOPES, scopeBit, asciiFold, confidenceLevel } from '../query/global-projections.js';
import { nodeInScope, isKnowledgeEdge } from '../query/scope.js';
export const COMPATIBILITY_QUERY_VERSION = 'owned-query-1';
export const COMPATIBILITY_QUERY_SQL = `
CREATE TABLE IF NOT EXISTS cq_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cq_nodes(node TEXT PRIMARY KEY,mask INTEGER NOT NULL,rank INTEGER NOT NULL,kind TEXT NOT NULL,file TEXT NOT NULL,name TEXT NOT NULL,qualified TEXT NOT NULL,name_lower TEXT NOT NULL,qualified_lower TEXT NOT NULL,file_lower TEXT NOT NULL,degree INTEGER NOT NULL,context_eligible INTEGER NOT NULL,arch_symbol INTEGER NOT NULL,start_line INTEGER NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(name||qualified||file AS BLOB))) STORED);
CREATE INDEX IF NOT EXISTS cq_node_context ON cq_nodes(context_eligible,degree DESC,qualified,node);
CREATE INDEX IF NOT EXISTS cq_node_file_navigation ON cq_nodes(file,start_line,name,node);
CREATE INDEX IF NOT EXISTS cq_node_file_symbols ON cq_nodes(file,arch_symbol,start_line,name,node);
CREATE INDEX IF NOT EXISTS cq_node_file_id ON cq_nodes(file,arch_symbol,node);
CREATE INDEX IF NOT EXISTS cq_node_file_kind ON cq_nodes(file,kind,node);
CREATE TABLE IF NOT EXISTS cq_scope_nodes(scope TEXT NOT NULL,node TEXT NOT NULL,rank INTEGER NOT NULL,qualified TEXT NOT NULL,PRIMARY KEY(scope,node));
CREATE INDEX IF NOT EXISTS cq_scope_order ON cq_scope_nodes(scope,rank,qualified,node);
CREATE TABLE IF NOT EXISTS cq_counts(scope TEXT NOT NULL,dimension TEXT NOT NULL,kind TEXT NOT NULL,n INTEGER NOT NULL CHECK(n>=0),PRIMARY KEY(scope,dimension,kind));
CREATE TABLE IF NOT EXISTS cq_file_counts(scope TEXT NOT NULL,path TEXT NOT NULL,nodes INTEGER NOT NULL,outgoing INTEGER NOT NULL,incoming INTEGER NOT NULL,PRIMARY KEY(scope,path));
CREATE TABLE IF NOT EXISTS cq_files(scope TEXT NOT NULL,path TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(scope,path));
CREATE TABLE IF NOT EXISTS cq_edges(edge TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,mask INTEGER NOT NULL,level INTEGER NOT NULL,kind TEXT NOT NULL,source_file TEXT NOT NULL,target_file TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS cq_edge_pair ON cq_edges(source,target,edge,level);
CREATE INDEX IF NOT EXISTS cq_edge_source ON cq_edges(source,edge);
CREATE INDEX IF NOT EXISTS cq_edge_target ON cq_edges(target,edge);
CREATE TABLE IF NOT EXISTS cq_search_docs(ordinal INTEGER PRIMARY KEY,node TEXT NOT NULL UNIQUE,name TEXT NOT NULL,qualified TEXT NOT NULL,name_fold TEXT NOT NULL,scope_mask INTEGER NOT NULL,unresolved INTEGER NOT NULL,empty_priority INTEGER NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(name||qualified AS BLOB))) STORED);
CREATE INDEX IF NOT EXISTS cq_search_exact ON cq_search_docs(name_fold,node);
CREATE INDEX IF NOT EXISTS cq_search_browse ON cq_search_docs(empty_priority,name,qualified,node);
CREATE INDEX IF NOT EXISTS cq_search_concrete ON cq_search_docs(unresolved,empty_priority,name,qualified,node);
CREATE VIRTUAL TABLE IF NOT EXISTS cq_search USING fts5(name,qualified,tokenize='trigram');
CREATE TABLE IF NOT EXISTS cq_diagnostics(key TEXT PRIMARY KEY,severity INTEGER NOT NULL,code TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED);
CREATE INDEX IF NOT EXISTS cq_diagnostic_order ON cq_diagnostics(severity,code,key);
CREATE TABLE IF NOT EXISTS cq_arch_counts(path TEXT PRIMARY KEY,n INTEGER NOT NULL CHECK(n>=0));
CREATE TABLE IF NOT EXISTS cq_arch_files(path TEXT PRIMARY KEY,node TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cq_arch_nodes(level INTEGER NOT NULL,id TEXT NOT NULL,is_file INTEGER NOT NULL,sort_key TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(level,id));
CREATE INDEX IF NOT EXISTS cq_arch_order ON cq_arch_nodes(level,is_file DESC,sort_key,id);
CREATE TABLE IF NOT EXISTS cq_flow(edge TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,level INTEGER NOT NULL,kind TEXT NOT NULL,confidence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cq_flow_counts(source TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,level INTEGER NOT NULL,confidence INTEGER NOT NULL,n INTEGER NOT NULL CHECK(n>0),PRIMARY KEY(source,target,kind,level,confidence));
CREATE INDEX IF NOT EXISTS cq_flow_pair ON cq_flow(source,target,level,edge);
CREATE INDEX IF NOT EXISTS cq_flow_source ON cq_flow(source,level,edge);
CREATE INDEX IF NOT EXISTS cq_flow_target ON cq_flow(target,level,edge);
CREATE TABLE IF NOT EXISTS cq_flow_evidence(edge TEXT NOT NULL,ordinal INTEGER NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,level INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(edge,ordinal));
CREATE INDEX IF NOT EXISTS cq_flow_samples ON cq_flow_evidence(source,target,level,edge,ordinal);
CREATE TABLE IF NOT EXISTS cq_arch_edges(level INTEGER NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(level,source,target));
CREATE INDEX IF NOT EXISTS cq_arch_target ON cq_arch_edges(level,target,source);
CREATE TABLE IF NOT EXISTS cq_boundaries(framework TEXT NOT NULL,node TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(framework,node));
CREATE INDEX IF NOT EXISTS cq_boundary_order ON cq_boundaries(framework,kind,name,node);
CREATE TABLE IF NOT EXISTS cq_boundary_edges(framework TEXT NOT NULL,node TEXT NOT NULL,level INTEGER NOT NULL,edge TEXT NOT NULL,PRIMARY KEY(framework,node,level,edge));
CREATE INDEX IF NOT EXISTS cq_boundary_edge ON cq_boundary_edges(edge);
CREATE TABLE IF NOT EXISTS cq_cycles(scope TEXT NOT NULL,level INTEGER NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(scope,level,ordinal));
CREATE TABLE IF NOT EXISTS cq_cycle_errors(scope TEXT NOT NULL,level INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(scope,level));
`;
const rootKinds = new Set(['repository', 'directory', 'file', 'unresolved_symbol']);
export function compatibilityNodeFlags(node: GraphNode) {
  const mask = QUERY_SCOPES.reduce((mask, scope) => mask | (nodeInScope(node, scope) ? scopeBit(scope) : 0), 0);
  const rank = node.kind === 'repository' ? 0 : node.kind === 'directory' ? 1 : node.kind === 'framework_command' ? 2 : node.kind === 'framework_event' ? 3 : node.kind === 'file' ? 4 : mask & 1 ? 5 : 6;
  return { node: node.id, mask, rank, kind: node.kind, file: node.file ?? '', name: node.name, qualified: node.qualifiedName, name_lower: node.name.toLowerCase(), qualified_lower: node.qualifiedName.toLowerCase(), file_lower: node.file?.toLowerCase() ?? '', context_eligible: rootKinds.has(node.kind) ? 0 : 1, arch_symbol: !!(mask & 1) && !!node.file && !['repository', 'directory', 'file'].includes(node.kind) ? 1 : 0, start_line: node.startLine ?? 0 };
}
function counter(store: SemanticStore, scope: string, dimension: string, kind: string, delta: number) {
  if (!delta)
    return;
  const row = store.sql('UPDATE cq_counts SET n=n+? WHERE scope=? AND dimension=? AND kind=? RETURNING n').get(delta, scope, dimension, kind) as {
    n: number;
  } | undefined;
  if (!row) {
    if (delta < 0)
      throw Error('Compatibility projection counter underflow');
    store.sql('INSERT INTO cq_counts VALUES(?,?,?,?)').run(scope, dimension, kind, delta);
  }
  else if (row.n === 0)
    store.sql('DELETE FROM cq_counts WHERE scope=? AND dimension=? AND kind=?').run(scope, dimension, kind);
}
function fileCounter(store: SemanticStore, scope: string, file: string, nodes: number, outgoing: number, incoming: number) {
  if (!file)
    return;
  store.sql('INSERT INTO cq_file_counts VALUES(?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET nodes=nodes+excluded.nodes,outgoing=outgoing+excluded.outgoing,incoming=incoming+excluded.incoming').run(scope, file, nodes, outgoing, incoming);
  const row = store.sql('SELECT nodes,outgoing,incoming FROM cq_file_counts WHERE scope=? AND path=?').get(scope, file) as {
    nodes: number;
    outgoing: number;
    incoming: number;
  };
  if (Math.min(row.nodes, row.outgoing, row.incoming) < 0)
    throw Error('Compatibility file projection counter underflow');
  if (row.nodes === 0 && row.outgoing === 0 && row.incoming === 0)
    store.sql('DELETE FROM cq_file_counts WHERE scope=? AND path=?').run(scope, file);
}
export function updateCompatibilityNodes(store: SemanticStore, changes: CompatibilityChange[]) {
  if (!store.db.inTransaction)
    throw Error('Compatibility query projections require publication transaction');
  const files = new Set<string>(), nodes = new Set<string>(), edgeNodes = new Set<string>();
  for (const change of changes)
    if (change.kind === 'node') {
      nodes.add(change.key);
      const previous = change.before as GraphNode | undefined, next = change.after as GraphNode | undefined;
      const edgeIdentity = (node: GraphNode) => {
        const flags = compatibilityNodeFlags(node); return JSON.stringify([flags.mask, flags.kind, flags.file, flags.qualified, node.metadata.framework, (node.metadata.boundary as {
          protocol?: string;
        } | undefined)?.protocol]);
      };
      if (!previous || !next || edgeIdentity(previous) !== edgeIdentity(next))
        edgeNodes.add(change.key);
      for (const [original, sign] of [[change.before, -1], [change.after, 1]] as const)
        if (original) {
          const node = original as GraphNode, flags = compatibilityNodeFlags(node);
          counter(store, '*', 'total', 'nodes', sign);
          if (node.kind === 'file' && node.file)
            counter(store, '*', 'total', 'files', sign);
          for (const scope of QUERY_SCOPES)
            if (flags.mask & scopeBit(scope)) {
              counter(store, scope, 'nodes', node.kind, sign);
              if (node.kind === 'file')
                counter(store, scope, 'total', 'files', sign);
              fileCounter(store, scope, flags.file, sign, 0, 0);
            }
          if (flags.file)
            files.add(flags.file);
          if (flags.arch_symbol) {
            const count = store.sql('UPDATE cq_arch_counts SET n=n+? WHERE path=? RETURNING n').get(sign, flags.file) as {
              n: number;
            } | undefined;
            if (!count) {
              if (sign < 0)
                throw Error('Compatibility symbol count underflow');
              store.sql('INSERT INTO cq_arch_counts VALUES(?,?)').run(flags.file, sign);
            }
            else if (count.n === 0)
              store.sql('DELETE FROM cq_arch_counts WHERE path=?').run(flags.file);
          }
        }
      const old = store.sql('SELECT ordinal FROM cq_search_docs WHERE node=?').get(change.key) as {
        ordinal: number;
      } | undefined;
      if (old) {
        store.sql('DELETE FROM cq_search WHERE rowid=?').run(old.ordinal);
        store.sql('DELETE FROM cq_search_docs WHERE ordinal=?').run(old.ordinal);
      }
      store.sql('DELETE FROM cq_scope_nodes WHERE node=?').run(change.key);
      store.sql('DELETE FROM cq_boundaries WHERE node=?').run(change.key);
      if (!change.after) {
        store.sql('DELETE FROM cq_nodes WHERE node=?').run(change.key);
        continue;
      }
      const node = change.after as GraphNode, flags = compatibilityNodeFlags(node), prior = store.sql('SELECT degree FROM cq_nodes WHERE node=?').get(node.id) as {
        degree: number;
      } | undefined;
      store.sql(`INSERT INTO cq_nodes(node,mask,rank,kind,file,name,qualified,name_lower,qualified_lower,file_lower,degree,context_eligible,arch_symbol,start_line)VALUES(@node,@mask,@rank,@kind,@file,@name,@qualified,@name_lower,@qualified_lower,@file_lower,@degree,@context_eligible,@arch_symbol,@start_line)
    ON CONFLICT(node)DO UPDATE SET mask=excluded.mask,rank=excluded.rank,kind=excluded.kind,file=excluded.file,name=excluded.name,qualified=excluded.qualified,name_lower=excluded.name_lower,qualified_lower=excluded.qualified_lower,file_lower=excluded.file_lower,context_eligible=excluded.context_eligible,arch_symbol=excluded.arch_symbol,start_line=excluded.start_line`).run({ ...flags, degree: prior?.degree ?? 0 });
      for (const scope of QUERY_SCOPES)
        if (flags.mask & scopeBit(scope))
          store.sql('INSERT INTO cq_scope_nodes VALUES(?,?,?,?)').run(scope, node.id, flags.rank, node.qualifiedName);
      const unresolved = node.kind === 'unresolved_symbol' ? 1 : 0;
      const id = store.sql('INSERT INTO cq_search_docs(ordinal,node,name,qualified,name_fold,scope_mask,unresolved,empty_priority)VALUES(?,?,?,?,?,?,?,?)').run(old?.ordinal ?? null, node.id, node.name, node.qualifiedName, asciiFold(node.name), flags.mask, unresolved, node.name === '' ? 0 : unresolved ? 2 : 1).lastInsertRowid;
      store.sql('INSERT INTO cq_search(rowid,name,qualified)VALUES(?,?,?)').run(id, node.name, node.qualifiedName);
      if (['boundary', 'framework_command', 'framework_event'].includes(node.kind))
        for (const framework of new Set(['', node.metadata.framework, (node.metadata.boundary as {
          protocol?: string;
        } | undefined)?.protocol]))
          if (typeof framework === 'string')
            store.sql('INSERT INTO cq_boundaries VALUES(?,?,?,?)').run(framework, node.id, node.kind, node.name);
    }
  return { files, nodes, edgeNodes };
}
export function updateCompatibilityDiagnostics(store: SemanticStore, changes: CompatibilityChange[]) {
  for (const change of changes)
    if (change.kind === 'diagnostic') {
      for (const [item, sign] of [[change.before, -1], [change.after, 1]] as const)
        if (item) {
          const d = item as Diagnostic;
          counter(store, '*', 'total', 'diagnostics', sign);
          counter(store, '*', 'diagnostics', d.severity, sign);
        }
      store.sql('DELETE FROM cq_diagnostics WHERE key=?').run(change.key);
      if (change.after) {
        const d = change.after as Diagnostic;
        store.sql('INSERT INTO cq_diagnostics(key,severity,code,data)VALUES(?,?,?,?)').run(change.key, d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2, d.code, JSON.stringify(d));
      }
    }
}
interface EdgeFlags {
  edge: string;
  source: string;
  target: string;
  mask: number;
  level: number;
  kind: string;
  source_file: string;
  target_file: string;
}
export function updateCompatibilityEdges(store: SemanticStore, changes: CompatibilityChange[], changedNodes: Set<string>) {
  const changed = new Map(changes.filter(change => change.kind === 'edge').map(change => [change.key, change]));
  const keys = new Set(changed.keys());
  for (const node of changedNodes)
    for (const direction of ['source', 'target'])
      for (const raw of store.sql(`SELECT edge FROM cq_edges INDEXED BY cq_edge_${direction} WHERE ${direction}=?`).iterate(node))
        keys.add((raw as {
          edge: string;
        }).edge);
  const files = new Set<string>(), architectureKeys = new Set<string>(), cyclePartitions = new Map<string, {
    scope: string;
    level: number;
  }>();
  let visited = 0, structuralChanges = 0;
  const totals = new Map<string, {
    scope: string;
    dimension: string;
    kind: string;
    delta: number;
  }>(), fileTotals = new Map<string, {
    scope: string;
    file: string;
    outgoing: number;
    incoming: number;
  }>(), degrees = new Map<string, number>();
  const count = (scope: string, dimension: string, kind: string, delta: number) => { const key = JSON.stringify([scope, dimension, kind]); const row = totals.get(key) ?? { scope, dimension, kind, delta: 0 }; row.delta += delta; totals.set(key, row); };
  const fileCount = (scope: string, file: string, outgoing: number, incoming: number) => {
    if (!file)
      return; const key = JSON.stringify([scope, file]); const row = fileTotals.get(key) ?? { scope, file, outgoing: 0, incoming: 0 }; row.outgoing += outgoing; row.incoming += incoming; fileTotals.set(key, row);
  };
  const nodes = new Map<string, {
    mask: number;
    file: string;
  }>();
  const node = (id: string) => {
    let flags = nodes.get(id); if (!flags) {
      flags = store.sql('SELECT mask,file FROM cq_nodes WHERE node=?').get(id) as {
        mask: number;
        file: string;
      } | undefined;
      if (!flags)
        throw Error('Compatibility query endpoint is unsupported');
      nodes.set(id, flags);
    } return flags;
  };
  const boundary = new Map<string, Array<{
    framework: string;
  }>>();
  const groups = (id: string) => {
    let rows = boundary.get(id); if (!rows) {
      rows = store.sql('SELECT framework FROM cq_boundaries WHERE node=?').all(id) as Array<{
        framework: string;
      }>;
      boundary.set(id, rows);
    } return rows;
  };
  const cycleKey = (flags: EdgeFlags | undefined) => flags ? JSON.stringify([flags.source, flags.target, flags.kind, flags.mask, flags.level]) : '';
  const flagKey = (flags: EdgeFlags | undefined) => flags ? JSON.stringify([flags.source, flags.target, flags.kind, flags.mask, flags.level, flags.source_file, flags.target_file]) : '';
  for (const key of keys) {
    if (++visited > 1000000)
      throw Error('Compatibility edge projection exceeds affected-closure budget');
    const old = store.sql('SELECT * FROM cq_edges WHERE edge=?').get(key) as EdgeFlags | undefined, change = changed.get(key);
    let edge: GraphEdge | undefined;
    if (change)
      edge = change.after as GraphEdge | undefined;
    else {
      const row = store.sql('SELECT * FROM edges WHERE id=?').get(key) as EdgeRow | undefined;
      if (row) {
        if (Buffer.byteLength(row.metadata_json) > 128 * 1024 ** 2)
          throw Error('Compatibility relationship metadata exceeds offline budget');
        edge = graphEdgeFromRow(row);
      }
    }
    let current: EdgeFlags | undefined;
    if (edge) {
      const source = node(edge.source), target = node(edge.target);
      current = { edge: key, source: edge.source, target: edge.target, kind: edge.kind, mask: source.mask & target.mask & (isKnowledgeEdge(edge) ? 30 : 31), level: confidenceLevel(edge.confidence), source_file: source.file, target_file: target.file };
    }
    const structural = flagKey(old) !== flagKey(current), endpointChanged = !!current && (changedNodes.has(current.source) || changedNodes.has(current.target));
    const before = change?.before as GraphEdge | undefined;
    if (structural || endpointChanged || before?.confidence !== edge?.confidence || JSON.stringify(before?.evidence) !== JSON.stringify(edge?.evidence))
      architectureKeys.add(key);
    if (cycleKey(old) !== cycleKey(current))
      for (const flags of [old, current])
        if (flags)
          for (const scope of QUERY_SCOPES)
            if ((flags.mask & scopeBit(scope)) && (scope === 'code' ? ['imports', 'calls'] : ['imports', 'calls', 'mentions', 'configures', 'tests', 'related_to']).includes(flags.kind))
              for (let level = flags.level;level < 3;level++)
                cyclePartitions.set(JSON.stringify([scope, level]), { scope, level });
    if (structural) {
      structuralChanges++;
      for (const [flags, sign] of [[old, -1], [current, 1]] as const)
        if (flags) {
          count('*', 'total', 'edges', sign);
          for (const id of new Set([flags.source, flags.target]))
            degrees.set(id, (degrees.get(id) ?? 0) + sign);
          if (flags.level === 0)
            for (const scope of QUERY_SCOPES)
              if (flags.mask & scopeBit(scope)) {
                count(scope, 'edges', flags.kind, sign);
                fileCount(scope, flags.source_file, sign, 0);
                fileCount(scope, flags.target_file, 0, sign);
              }
          if (flags.source_file)
            files.add(flags.source_file);
          if (flags.target_file)
            files.add(flags.target_file);
        }
      store.sql('DELETE FROM cq_edges WHERE edge=?').run(key);
      if (current)
        store.sql('INSERT INTO cq_edges VALUES(@edge,@source,@target,@mask,@level,@kind,@source_file,@target_file)').run(current);
    }
    if (structural || endpointChanged) {
      store.sql('DELETE FROM cq_boundary_edges WHERE edge=?').run(key);
      if (current)
        for (const id of new Set([current.source, current.target]))
          for (const { framework } of groups(id))
            store.sql('INSERT INTO cq_boundary_edges VALUES(?,?,?,?)').run(framework, id, current.level, key);
    }
  }
  for (const row of totals.values())
    counter(store, row.scope, row.dimension, row.kind, row.delta);
  for (const row of fileTotals.values())
    if (row.outgoing || row.incoming)
      fileCounter(store, row.scope, row.file, 0, row.outgoing, row.incoming);
  for (const [id, delta] of degrees)
    if (delta) {
      const value = store.sql('UPDATE cq_nodes SET degree=degree+? WHERE node=? RETURNING degree').get(delta, id) as {
        degree: number;
      } | undefined;
      if (value && value.degree < 0)
        throw Error('Compatibility degree counter underflow');
    }
  return { keys, files, cyclePartitions, architectureKeys, structuralChanges };
}
export function updateCompatibilityFileRows(store: SemanticStore, files: Set<string>) {
  for (const file of files) {
    const rows = store.sql("SELECT node,mask FROM cq_nodes WHERE kind='file' AND file=? LIMIT 2").all(file) as Array<{
      node: string;
      mask: number;
    }>;
    if (rows.length > 1)
      throw Error('Duplicate compatibility file projection');
    const language = rows.length ? (store.sql('SELECT language FROM nodes WHERE id=?').get(rows[0]!.node) as {
      language: string | null;
    }).language : null;
    for (const scope of QUERY_SCOPES) {
      store.sql('DELETE FROM cq_files WHERE scope=? AND path=?').run(scope, file);
      if (!rows.length || !(rows[0]!.mask & scopeBit(scope)))
        continue;
      const counts = store.sql('SELECT nodes,outgoing,incoming FROM cq_file_counts WHERE scope=? AND path=?').get(scope, file) as {
        nodes: number;
        outgoing: number;
        incoming: number;
      } | undefined;
      const data = { path: file, ...(language !== null ? { language } : {}), nodeCount: counts?.nodes ?? 0, outgoingCount: counts?.outgoing ?? 0, incomingCount: counts?.incoming ?? 0 };
      store.sql('INSERT INTO cq_files(scope,path,data)VALUES(?,?,?)').run(scope, file, JSON.stringify(data));
    }
  }
}
const flowKinds = new Set(['imports', 'calls', 'renders', 'invokes', 'registers', 'emits', 'listens', 'tests']);
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** File decorations use only a maintained count plus an indexed 64-symbol sample. */
export function updateCompatibilityArchitecture(store: SemanticStore, files: Set<string>, edgeKeys: Set<string>, changedNodes: Set<string>) {
  const pairs = new Map<string, [
    string,
    string
  ]>(), external = new Set<string>();
  const pair = (source: string, target: string) => pairs.set(JSON.stringify([source, target]), [source, target]);
  for (const file of files) {
    const before = store.sql('SELECT node FROM cq_arch_files WHERE path=?').get(file) as {
      node: string;
    } | undefined;
    const explicit = store.sql("SELECT n.* FROM cq_nodes q JOIN nodes n ON n.id=q.node WHERE q.file=? AND q.kind='file' AND(q.mask&1)!=0 LIMIT 2").all(file) as NodeRow[];
    if (explicit.length > 1)
      throw Error('Duplicate file architecture identity');
    const count = (store.sql('SELECT n FROM cq_arch_counts WHERE path=?').get(file) as {
      n: number;
    } | undefined)?.n ?? 0;
    let base: GraphNode | undefined = explicit.length ? graphNodeFromRow(explicit[0]!) : undefined;
    if (!base && count) {
      const first = store.sql('SELECT n.adapter,n.language FROM cq_nodes q JOIN nodes n ON n.id=q.node WHERE q.file=? AND q.arch_symbol=1 ORDER BY q.node LIMIT 1').get(file) as {
        adapter: string;
        language: string | null;
      } | undefined;
      if (!first)
        throw Error('Missing architecture symbol sample');
      base = { id: `file:${file}`, kind: 'file', name: path.basename(file), qualifiedName: file, file, adapter: first.adapter, metadata: {}, ...(first.language ? { language: first.language } : {}) };
    }
    if (before) {
      store.sql('DELETE FROM cq_arch_files WHERE path=?').run(file);
      store.sql('DELETE FROM cq_arch_nodes WHERE id=? AND is_file=1').run(before.node);
    }
    if (!!before !== !!base)
      counter(store, '*', 'architecture', 'files', base ? 1 : -1);
    if (base) {
      const symbols = store.sql('SELECT n.id,n.name,n.kind,n.qualified_name,n.start_line,n.end_line FROM cq_nodes q JOIN nodes n ON n.id=q.node WHERE q.file=? AND q.arch_symbol=1 ORDER BY q.start_line,q.name,q.node LIMIT 64').all(file) as Array<{
        id: string;
        name: string;
        kind: string;
        qualified_name: string;
        start_line: number | null;
        end_line: number | null;
      }>;
      const data = JSON.stringify({ ...base, metadata: { ...base.metadata, uiGranularity: 'file', symbolCount: count, incomingCount: 0, outgoingCount: 0, ...(count > 64 ? { containedSymbolsTruncated: true } : {}), containedSymbols: symbols.map(s => ({ id: s.id, name: s.name, kind: s.kind, qualifiedName: s.qualified_name, ...(s.start_line === null ? {} : { startLine: s.start_line }), ...(s.end_line === null ? {} : { endLine: s.end_line }) })) } });
      store.sql('INSERT INTO cq_arch_files VALUES(?,?,?)').run(file, base.id, data);
      for (let level = 0;level < 3;level++)
        store.sql('INSERT INTO cq_arch_nodes(level,id,is_file,sort_key,data)VALUES(?,?,1,?,?)').run(level, base.id, file, data);
    }
    if (before?.node !== base?.id)
      for (const direction of ['source', 'target'])
        for (const raw of store.sql(`SELECT e.edge FROM cq_nodes n INDEXED BY cq_node_file_kind CROSS JOIN cq_edges e INDEXED BY cq_edge_${direction} ON e.${direction}=n.node WHERE n.file=?`).iterate(file))
          edgeKeys.add((raw as {
            edge: string;
          }).edge);
  }
  const anchor = (id: string) => {
    const node = store.sql('SELECT node,kind,file,mask FROM cq_nodes WHERE node=?').get(id) as {
      node: string;
      kind: string;
      file: string;
      mask: number;
    } | undefined; if (!node || !(node.mask & 1))
      return undefined; if (node.kind === 'external_package')
      return node.node; return node.file ? (store.sql('SELECT node FROM cq_arch_files WHERE path=?').get(node.file) as {
        node: string;
      } | undefined)?.node : undefined;
  };
  for (const key of edgeKeys) {
    const old = store.sql('SELECT * FROM cq_flow WHERE edge=?').get(key) as {
      source: string;
      target: string;
      kind: string;
      level: number;
      confidence: number;
    } | undefined;
    if (old) {
      pair(old.source, old.target);
      adjustFlowCount(store, old, -1);
    }
    store.sql('DELETE FROM cq_flow_evidence WHERE edge=?').run(key);
    store.sql('DELETE FROM cq_flow WHERE edge=?').run(key);
    const flags = store.sql('SELECT * FROM cq_edges WHERE edge=?').get(key) as EdgeFlags | undefined;
    if (!flags || !(flags.mask & 1) || !flowKinds.has(flags.kind))
      continue;
    const source = anchor(flags.source), target = anchor(flags.target);
    if (!source || !target || source === target)
      continue;
    const edge = store.sql('SELECT confidence,evidence_json,metadata_json FROM edges WHERE id=?').get(key) as {
      confidence: GraphEdge['confidence'];
      evidence_json: string;
      metadata_json: string;
    };
    if (Buffer.byteLength(edge.evidence_json) + Buffer.byteLength(edge.metadata_json) > 128 * 1024 ** 2)
      throw Error('Architecture relationship exceeds offline byte budget');
    const confidence = ['exact', 'resolved', 'probable', 'unresolved'].indexOf(edge.confidence);
    store.sql('INSERT INTO cq_flow VALUES(?,?,?,?,?,?)').run(key, source, target, flags.level, flags.kind, confidence);
    adjustFlowCount(store, { source, target, level: flags.level, kind: flags.kind, confidence }, 1);
    const evidence = evidenceOf({ evidence: JSON.parse(edge.evidence_json) });
    evidence.slice(0, 12).forEach((value, ordinal) => store.sql('INSERT INTO cq_flow_evidence VALUES(?,?,?,?,?,?)').run(key, ordinal, source, target, flags.level, JSON.stringify(value)));
    pair(source, target);
  }
  for (const [source, target] of pairs.values()) {
    external.add(source);
    external.add(target);
    for (let level = 0;level < 3;level++) {
      const grouped = store.sql('SELECT kind,MIN(confidence) confidence,SUM(n) n FROM cq_flow_counts WHERE source=? AND target=? AND level<=? GROUP BY kind').all(source, target, level) as Array<{
        kind: string;
        confidence: number;
        n: number;
      }>;
      store.sql('DELETE FROM cq_arch_edges WHERE level=? AND source=? AND target=?').run(level, source, target);
      if (!grouped.length)
        continue;
      const kinds = grouped.map(row => row.kind).sort(), kind = ['invokes', 'emits', 'listens', 'registers', 'renders', 'calls', 'imports', 'tests'].find(kind => kinds.includes(kind)) ?? kinds[0]!, confidence = ['exact', 'resolved', 'probable', 'unresolved'][Math.min(...grouped.map(row => row.confidence))]!, underlyingEdgeCount = grouped.reduce((n, row) => n + row.n, 0);
      const samples: Array<{
        edge: string;
      }> = [], evidence: Array<{
        edge: string;
        ordinal: number;
        data: string;
      }> = [];
      for (let tier = 0;tier <= level;tier++) {
        samples.push(...store.sql('SELECT edge FROM cq_flow WHERE source=? AND target=? AND level=? ORDER BY edge LIMIT 24').all(source, target, tier) as Array<{
          edge: string;
        }>);
        evidence.push(...store.sql('SELECT edge,ordinal,data FROM cq_flow_evidence WHERE source=? AND target=? AND level=? ORDER BY edge,ordinal LIMIT 12').all(source, target, tier) as Array<{
          edge: string;
          ordinal: number;
          data: string;
        }>);
      }
      samples.sort((a, b) => binary(a.edge, b.edge));
      evidence.sort((a, b) => binary(a.edge, b.edge) || a.ordinal - b.ordinal);
      const underlyingEdges = samples.slice(0, 24).map(sample => {
        const row = store.sql('SELECT e.*,s.qualified_name source_symbol,t.qualified_name target_symbol FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.id=?').get(sample.edge) as {
          id: string;
          kind: GraphEdge['kind'];
          confidence: GraphEdge['confidence'];
          source: string;
          target: string;
          source_symbol: string;
          target_symbol: string;
          evidence_json: string;
          metadata_json: string;
        };
        return { id: row.id, kind: row.kind, confidence: row.confidence, source: row.source, target: row.target, sourceSymbol: row.source_symbol, targetSymbol: row.target_symbol, evidence: evidenceOf({ evidence: JSON.parse(row.evidence_json) }) };
      });
      const data = JSON.stringify({ id: `fileedge:${source}->${target}:${kinds.join('+')}`, source, target, kind, confidence, evidence: evidence.slice(0, 12).map(row => JSON.parse(row.data)), metadata: { graphDomain: 'code', aggregated: true, edgeKinds: kinds, underlyingEdgeCount, underlyingEdges } });
      if (Buffer.byteLength(data) > 128 * 1024 ** 2)
        throw Error('Architecture pair exceeds offline byte budget');
      store.sql('INSERT INTO cq_arch_edges(level,source,target,data)VALUES(?,?,?,?)').run(level, source, target, data);
    }
  }
  for (const id of new Set([...external, ...changedNodes])) {
    const node = store.sql("SELECT n.* FROM cq_nodes q JOIN nodes n ON n.id=q.node WHERE q.node=? AND q.kind='external_package' AND(q.mask&1)!=0").get(id) as NodeRow | undefined;
    for (let level = 0;level < 3;level++) {
      store.sql('DELETE FROM cq_arch_nodes WHERE level=? AND id=? AND is_file=0').run(level, id);
      if (node && (store.sql('SELECT 1 FROM cq_arch_edges WHERE level=? AND source=? LIMIT 1').get(level, id) || store.sql('SELECT 1 FROM cq_arch_edges INDEXED BY cq_arch_target WHERE level=? AND target=? LIMIT 1').get(level, id))) {
        const original = graphNodeFromRow(node), data = JSON.stringify({ ...original, metadata: { ...original.metadata, uiGranularity: 'file', symbolCount: 0, incomingCount: 0, outgoingCount: 0, containedSymbols: [] } });
        store.sql('INSERT INTO cq_arch_nodes(level,id,is_file,sort_key,data)VALUES(?,?,0,?,?)').run(level, id, original.qualifiedName, data);
      }
    }
  }
  return { pairs: pairs.size, files: files.size };
}
/** Bootstrap once; subsequent publication applies only changed payload/support contributions. */
export function publishCompatibilityQueries(store: SemanticStore, snapshot: number, generation: string, changes: CompatibilityChange[], reset = false) {
  if (!store.db.inTransaction)
    throw Error('Owned query projections require the publication transaction');
  const exists = store.sql("SELECT 1 FROM sqlite_master WHERE name='cq_meta'").get();
  const ready = exists && (store.sql("SELECT value FROM cq_meta WHERE key='version'").get() as {
    value: string;
  } | undefined)?.value === COMPATIBILITY_QUERY_VERSION;
  const tables = ['cq_search', 'cq_search_docs', 'cq_meta', 'cq_nodes', 'cq_scope_nodes', 'cq_counts', 'cq_file_counts', 'cq_files', 'cq_edges', 'cq_diagnostics', 'cq_arch_counts', 'cq_arch_files', 'cq_arch_nodes', 'cq_flow', 'cq_flow_counts', 'cq_flow_evidence', 'cq_arch_edges', 'cq_boundaries', 'cq_boundary_edges', 'cq_cycles', 'cq_cycle_errors'];
  const rebuilding = reset || !ready;
  if (rebuilding) {
    for (const table of tables)
      store.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  store.db.exec(COMPATIBILITY_QUERY_SQL);
  let plan = changes, bytes = 0;
  if (rebuilding) {
    plan = [];
    let kind = '', key = '';
    while (true) {
      const rows = store.sql('SELECT kind,key FROM cg_current WHERE(kind,key)>(?,?)ORDER BY kind,key LIMIT 500').all(kind, key) as Array<{
        kind: CompatibilityChange['kind'];
        key: string;
      }>;
      if (!rows.length)
        break;
      for (const row of rows) {
        let after: CompatibilityChange['after'];
        if (row.kind === 'node')
          after = graphNodeFromRow(store.sql('SELECT * FROM nodes WHERE id=?').get(row.key) as NodeRow);
        else if (row.kind === 'edge')
          after = graphEdgeFromRow(store.sql('SELECT * FROM edges WHERE id=?').get(row.key) as EdgeRow);
        else
          after = diagnosticFromRow(store.sql('SELECT d.* FROM cg_diagnostic_rows r JOIN diagnostics d ON d.id=r.row WHERE r.key=?').get(row.key) as DiagnosticRow);
        bytes += Buffer.byteLength(JSON.stringify(after));
        if (plan.length >= 1000000 || bytes > 128 * 1024 ** 2)
          throw Error('Owned query bootstrap exceeds offline budget');
        plan.push({ ...row, after });
      }
      const last = rows.at(-1)!;
      kind = last.kind;
      key = last.key;
    }
  }
  const node = updateCompatibilityNodes(store, plan);
  store.hooks.fault?.("during-compatibility");
  const edge = updateCompatibilityEdges(store, plan, node.edgeNodes);
  updateCompatibilityDiagnostics(store, plan);
  const files = new Set([...node.files, ...edge.files]);
  updateCompatibilityFileRows(store, files);
  const architecture = updateCompatibilityArchitecture(store, files, edge.architectureKeys, node.nodes);
  if (rebuilding)
    store.sql("INSERT INTO cq_meta VALUES('cycles','stale')ON CONFLICT(key)DO UPDATE SET value=excluded.value").run();
  for (const { scope, level } of edge.cyclePartitions.values()) {
    store.sql('DELETE FROM cq_cycles WHERE scope=? AND level=?').run(scope, level);
    store.sql('INSERT INTO cq_cycle_errors VALUES(?,?,?)ON CONFLICT(scope,level)DO UPDATE SET reason=excluded.reason').run(scope, level, 'Owned cycle projection invalidated; run prepare-queries offline');
  }
  const work = { bootstrap: rebuilding, payloadChanges: plan.length, nodeContributions: node.nodes.size, edgeContributions: edge.keys.size, edgeReclassifications: edge.structuralChanges, architectureRelationships: edge.architectureKeys.size, fileContributions: files.size, architecturePairs: architecture.pairs };
  for (const [key, value] of Object.entries({ version: COMPATIBILITY_QUERY_VERSION, snapshot: String(snapshot), generation, work: JSON.stringify(work) }))
    store.sql('INSERT INTO cq_meta VALUES(?,?)ON CONFLICT(key)DO UPDATE SET value=excluded.value').run(key, value);
  return work;
}
function adjustFlowCount(store: SemanticStore, flow: {
  source: string;
  target: string;
  kind: string;
  level: number;
  confidence: number;
}, sign: 1 | -1) {
  const args = [flow.source, flow.target, flow.kind, flow.level, flow.confidence] as const;
  if (sign < 0) {
    const old = store.sql('SELECT n FROM cq_flow_counts WHERE source=? AND target=? AND kind=? AND level=? AND confidence=?').get(...args) as {
      n: number;
    } | undefined;
    if (!old)
      throw Error('Architecture contribution underflow');
    if (old.n === 1)
      store.sql('DELETE FROM cq_flow_counts WHERE source=? AND target=? AND kind=? AND level=? AND confidence=?').run(...args);
    else
      store.sql('UPDATE cq_flow_counts SET n=n-1 WHERE source=? AND target=? AND kind=? AND level=? AND confidence=?').run(...args);
  }
  else
    store.sql('INSERT INTO cq_flow_counts VALUES(?,?,?,?,?,1)ON CONFLICT(source,target,kind,level,confidence)DO UPDATE SET n=n+1').run(...args);
}
