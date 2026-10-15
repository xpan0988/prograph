import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GraphData, GraphEdge, GraphNode, GraphScope } from "../graph/schema.js";
import { nodeInScope, isKnowledgeEdge } from "./scope.js";
import { fileArchitecture } from "./file-architecture.js";

export const GLOBAL_QUERY_VERSION = "global-query-1";
export const QUERY_SCOPES: GraphScope[] = ["code", "code+docs", "code+config", "code+tests", "full"];
export const GLOBAL_QUERY_SQL = `
CREATE TABLE IF NOT EXISTS q_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS q_search_docs(ordinal INTEGER PRIMARY KEY,node TEXT NOT NULL,name TEXT NOT NULL,qualified TEXT NOT NULL,name_fold TEXT NOT NULL,scope_mask INTEGER NOT NULL,unresolved INTEGER NOT NULL,name_order INTEGER NOT NULL,empty_priority INTEGER NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(name||qualified AS BLOB))) STORED);
CREATE INDEX IF NOT EXISTS q_search_name ON q_search_docs(name_fold,ordinal);
CREATE INDEX IF NOT EXISTS q_search_browse ON q_search_docs(empty_priority,name_order);
CREATE INDEX IF NOT EXISTS q_search_concrete ON q_search_docs(unresolved,empty_priority,name_order);
CREATE VIRTUAL TABLE IF NOT EXISTS q_search USING fts5(name,qualified,tokenize='trigram');
CREATE TABLE IF NOT EXISTS q_diagnostics(ordinal INTEGER PRIMARY KEY,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED);
CREATE TABLE IF NOT EXISTS q_summaries(scope TEXT PRIMARY KEY,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED);
CREATE TABLE IF NOT EXISTS q_scope_nodes(scope TEXT NOT NULL,ordinal INTEGER NOT NULL,node TEXT NOT NULL,PRIMARY KEY(scope,ordinal));
CREATE TABLE IF NOT EXISTS q_edges(ordinal INTEGER PRIMARY KEY,id TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,scope_mask INTEGER NOT NULL,level INTEGER NOT NULL,kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS q_edges_pair ON q_edges(source,target,ordinal);
CREATE TABLE IF NOT EXISTS q_files(scope TEXT NOT NULL,ordinal INTEGER NOT NULL,path TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(scope,ordinal));
CREATE TABLE IF NOT EXISTS q_context(ordinal INTEGER PRIMARY KEY,node TEXT NOT NULL,scope_mask INTEGER NOT NULL,degree INTEGER NOT NULL,name TEXT NOT NULL,qualified TEXT NOT NULL,file TEXT NOT NULL,qualified_original TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(name||qualified||file||qualified_original AS BLOB))) STORED);
CREATE TABLE IF NOT EXISTS q_arch_nodes(level INTEGER NOT NULL,ordinal INTEGER NOT NULL,id TEXT NOT NULL,is_file INTEGER NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(level,ordinal));
CREATE TABLE IF NOT EXISTS q_arch_edges(level INTEGER NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(level,source,target));
CREATE TABLE IF NOT EXISTS q_cycles(scope TEXT NOT NULL,level INTEGER NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,bytes INTEGER GENERATED ALWAYS AS(length(CAST(data AS BLOB))) STORED,PRIMARY KEY(scope,level,ordinal));
CREATE TABLE IF NOT EXISTS q_cycle_errors(scope TEXT NOT NULL,level INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(scope,level));
CREATE TABLE IF NOT EXISTS q_framework_edges(framework TEXT NOT NULL,level INTEGER NOT NULL,ordinal INTEGER NOT NULL,edge TEXT NOT NULL,PRIMARY KEY(framework,level,ordinal));
CREATE TABLE IF NOT EXISTS q_boundaries(framework TEXT NOT NULL,ordinal INTEGER NOT NULL,node TEXT NOT NULL,PRIMARY KEY(framework,ordinal));
${["nodes", "edges", "files", "diagnostics"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => `CREATE TRIGGER IF NOT EXISTS q_invalidate_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} WHEN EXISTS(SELECT 1 FROM q_meta WHERE key='version') BEGIN DELETE FROM q_meta WHERE key='version'; END;`)).join("\n")}
`;
export function asciiFold(value: string): string { return value.replace(/[A-Z]/g, character => character.toLowerCase()); }
export function confidenceLevel(confidence: GraphEdge["confidence"]): number { return confidence === "unresolved" ? 2 : confidence === "probable" ? 1 : 0; }
export function scopeBit(scope: GraphScope): number { const index = QUERY_SCOPES.indexOf(scope); if (index < 0) throw Error("Unknown graph scope"); return 1 << index; }
const options = (level: number) => ({ includeProbable: level >= 1, includeUnresolved: level >= 2 });
const countBy = (values: string[]) => [...values.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>())]
  .map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

/** Must run offline, inside the same transaction that replaces the compatibility graph. */
export function materializeGlobalQueries(db: Database.Database, graph: Pick<GraphData, "nodes" | "edges" | "diagnostics">): void {
  if (!db.inTransaction) throw Error("Global query projections require an atomic graph transaction");
  for (const table of ["q_meta", "q_search", "q_search_docs", "q_diagnostics", "q_summaries", "q_scope_nodes", "q_edges", "q_files", "q_context", "q_arch_nodes", "q_arch_edges", "q_cycles", "q_cycle_errors", "q_framework_edges", "q_boundaries"]) db.exec(`DELETE FROM ${table}`);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const masks = new Map(graph.nodes.map(node => [node.id, QUERY_SCOPES.reduce((mask, scope) => mask | (nodeInScope(node, scope) ? scopeBit(scope) : 0), 0)]));
  const degree = new Map<string, number>();
  const projected: { edge: GraphEdge; mask: number; level: number }[] = [];
  const insertEdge = db.prepare("INSERT INTO q_edges VALUES(?,?,?,?,?,?,?)");
  for (const [ordinal, edge] of graph.edges.entries()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (edge.target !== edge.source) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    const mask = (masks.get(edge.source) ?? 0) & (masks.get(edge.target) ?? 0) & (isKnowledgeEdge(edge) ? ~1 : 31); const level = confidenceLevel(edge.confidence);
    projected.push({ edge, mask, level }); insertEdge.run(ordinal + 1, edge.id, edge.source, edge.target, mask, level, edge.kind);
  }
  const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const nameOrder = new Map([...graph.nodes].sort((a, b) => binary(a.name, b.name) || binary(a.qualifiedName, b.qualifiedName)).map((node, index) => [node.id, index]));
  const insertSearch = db.prepare("INSERT INTO q_search_docs VALUES(?,?,?,?,?,?,?,?,?)"); const insertFts = db.prepare("INSERT INTO q_search(rowid,name,qualified) VALUES(?,?,?)");
  for (const [index, node] of graph.nodes.entries()) {
    const unresolved = node.kind === "unresolved_symbol" ? 1 : 0;
    insertSearch.run(index + 1, node.id, node.name, node.qualifiedName, asciiFold(node.name), masks.get(node.id), unresolved, nameOrder.get(node.id), node.name === "" ? 0 : unresolved ? 2 : 1);
    insertFts.run(index + 1, node.name, node.qualifiedName);
  }
  const severity = (value: string) => value === "error" ? 0 : value === "warning" ? 1 : 2;
  const insertDiagnostic = db.prepare("INSERT INTO q_diagnostics(ordinal,data) VALUES(?,?)");
  [...graph.diagnostics].sort((a, b) => severity(a.severity) - severity(b.severity) || binary(a.code, b.code)).forEach((diagnostic, ordinal) => insertDiagnostic.run(ordinal + 1, JSON.stringify(diagnostic)));
  const totalCounts = { files: graph.nodes.filter(node => node.kind === "file" && node.file).length, nodes: graph.nodes.length, edges: graph.edges.length, diagnostics: graph.diagnostics.length };
  const insertSummary = db.prepare("INSERT INTO q_summaries VALUES(?,?)"); const insertNode = db.prepare("INSERT INTO q_scope_nodes VALUES(?,?,?)");
  const insertFile = db.prepare("INSERT INTO q_files VALUES(?,?,?,?)");
  const rank = (node: GraphNode) => node.kind === "repository" ? 0 : node.kind === "directory" ? 1 : node.kind === "framework_command" ? 2 : node.kind === "framework_event" ? 3 : node.kind === "file" ? 4 : nodeInScope(node, "code") ? 5 : 6;
  for (const scope of QUERY_SCOPES) {
    const bit = scopeBit(scope); const selected = graph.nodes.filter(node => masks.get(node.id)! & bit); const edges = projected.filter(item => item.mask & bit && item.level === 0).map(item => item.edge);
    insertSummary.run(scope, JSON.stringify({ counts: { files: selected.filter(node => node.kind === "file").length, nodes: selected.length, edges: edges.length, diagnostics: graph.diagnostics.length }, totalCounts, nodesByKind: countBy(selected.map(node => node.kind)), edgesByKind: countBy(edges.map(edge => edge.kind)) }));
    [...selected].sort((a, b) => rank(a) - rank(b) || a.qualifiedName.localeCompare(b.qualifiedName)).forEach((node, ordinal) => insertNode.run(scope, ordinal + 1, node.id));
    const files = selected.filter(node => node.kind === "file" && node.file).sort((a, b) => a.file!.localeCompare(b.file!));
    const counts = new Map<string, { nodeCount: number; outgoingCount: number; incomingCount: number }>();
    const forFile = (file: string) => { let current = counts.get(file); if (!current) { current = { nodeCount: 0, outgoingCount: 0, incomingCount: 0 }; counts.set(file, current); } return current; };
    for (const node of selected) if (node.file) forFile(node.file).nodeCount++;
    for (const edge of edges) { const source = nodes.get(edge.source)?.file; const target = nodes.get(edge.target)?.file; if (source) forFile(source).outgoingCount++; if (target) forFile(target).incomingCount++; }
    files.forEach((node, ordinal) => insertFile.run(scope, ordinal + 1, node.file, JSON.stringify({ path: node.file, language: node.language, ...forFile(node.file!) })));
  }
  const context = graph.nodes.filter(node => !["repository", "directory", "file", "unresolved_symbol"].includes(node.kind))
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || Buffer.compare(Buffer.from(a.qualifiedName), Buffer.from(b.qualifiedName))).slice(0, 2000);
  const insertContext = db.prepare("INSERT INTO q_context VALUES(?,?,?,?,?,?,?,?,?)");
  context.forEach((node, ordinal) => insertContext.run(ordinal + 1, node.id, masks.get(node.id), degree.get(node.id) ?? 0, node.name.toLowerCase(), node.qualifiedName.toLowerCase(), node.file?.toLowerCase() ?? "", node.qualifiedName, node.kind));
  const insertArchNode = db.prepare("INSERT INTO q_arch_nodes VALUES(?,?,?,?,?)"); const insertArchEdge = db.prepare("INSERT INTO q_arch_edges VALUES(?,?,?,?)");
  for (let level = 0; level < 3; level++) {
    const architecture = fileArchitecture(graph.nodes, graph.edges, Number.MAX_SAFE_INTEGER, options(level));
    db.prepare("INSERT INTO q_meta VALUES(?,?)").run(`arch-files:${level}`, String(architecture.nodes.filter(node => node.kind === "file").length));
    architecture.nodes.forEach((node, ordinal) => insertArchNode.run(level, ordinal + 1, node.id, node.kind === "file" ? 1 : 0, JSON.stringify(node)));
    architecture.edges.forEach(edge => insertArchEdge.run(level, edge.source, edge.target, JSON.stringify(edge)));
    for (const scope of QUERY_SCOPES) {
      const allowed = scope === "code" ? ["imports", "calls"] : ["imports", "calls", "mentions", "configures", "tests", "related_to"];
      const edges = projected.filter(item => item.mask & scopeBit(scope) && item.level <= level && allowed.includes(item.edge.kind)).map(item => item.edge);
      const result = offlineCycles(edges);
      if (result.error) db.prepare("INSERT INTO q_cycle_errors VALUES(?,?,?)").run(scope, level, result.error);
      else { const insert = db.prepare("INSERT INTO q_cycles VALUES(?,?,?,?)"); result.cycles.forEach((cycle, ordinal) => insert.run(scope, level, ordinal + 1, JSON.stringify(cycle))); }
    }
  }
  const boundaries = graph.nodes.filter(node => ["boundary", "framework_command", "framework_event"].includes(node.kind));
  // Match SQLite's BINARY order used by the existing framework API.
  boundaries.sort((a, b) => Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind)) || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const groups = new Map<string, GraphNode[]>(); groups.set("", boundaries);
  for (const node of boundaries) for (const key of new Set([node.metadata.framework, (node.metadata.boundary as { protocol?: string } | undefined)?.protocol])) {
    if (typeof key !== "string" || !key) continue; const group = groups.get(key) ?? []; group.push(node); groups.set(key, group);
  }
  const insertBoundary = db.prepare("INSERT INTO q_boundaries VALUES(?,?,?)"); const insertFrameworkEdge = db.prepare("INSERT INTO q_framework_edges VALUES(?,?,?,?)");
  for (const [key, values] of groups) {
    values.forEach((node, ordinal) => insertBoundary.run(key, ordinal + 1, node.id));
    const ids = new Set(values.slice(0, 200).map(node => node.id));
    const edges = graph.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target)).sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    for (let level = 0; level < 3; level++) edges.filter(edge => confidenceLevel(edge.confidence) <= level).forEach((edge, ordinal) => insertFrameworkEdge.run(key, level, ordinal + 1, edge.id));
  }
  db.prepare("INSERT INTO q_meta VALUES('diagnostic_counts',?)").run(JSON.stringify(Object.fromEntries(["error", "warning", "info"].map(severity => [severity, graph.diagnostics.filter(item => item.severity === severity).length]))));
  db.prepare("INSERT INTO q_meta VALUES('version',?)").run(GLOBAL_QUERY_VERSION);
  const generation = db.prepare("SELECT MAX(id) AS id FROM analysis_runs").get() as { id: number };
  db.prepare("INSERT INTO q_meta VALUES('source_generation',?)").run(String(generation.id));
  db.prepare("INSERT INTO q_meta VALUES('generation',?)").run(randomUUID());
}

/** Iterative equivalent of the former DFS back-edge API, computed offline without recursion. */
export function offlineCycles(edges: GraphEdge[]): { cycles: string[][]; error?: string } {
  const adjacency = new Map<string, string[]>(); for (const edge of edges) { const list = adjacency.get(edge.source) ?? []; list.push(edge.target); adjacency.set(edge.source, list); }
  const seen = new Set<string>(); const active = new Map<string, number>(); const cycles = new Map<string, string[]>(); let memberships = 0;
  for (const id of adjacency.keys()) {
    if (seen.has(id)) continue;
    const stack: { id: string; next: number }[] = [{ id, next: 0 }]; seen.add(id); active.set(id, 0);
    while (stack.length) {
      const frame = stack.at(-1)!; const next = adjacency.get(frame.id)?.[frame.next++];
      if (next === undefined) { active.delete(frame.id); stack.pop(); continue; }
      if (!seen.has(next)) { seen.add(next); active.set(next, stack.length); stack.push({ id: next, next: 0 }); }
      else if (active.has(next)) {
        const cycle = stack.slice(active.get(next)).map(frame => frame.id); const key = [...cycle].sort().join("|");
        if (!cycles.has(key)) memberships += cycle.length;
        if (cycles.size >= 10000 || memberships > 1000000) return { cycles: [], error: "Offline cycle projection exceeds 10000 cycles or 1000000 memberships; use a filtered offline analysis" };
        cycles.set(key, cycle);
      }
    }
  }
  return { cycles: [...cycles.values()] };
}
