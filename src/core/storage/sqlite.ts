import path from "node:path";
import Database from "better-sqlite3";
import type { AdapterRun, AnalysisManifest, Diagnostic, GraphData, GraphEdge, GraphNode } from "../graph/schema.js";

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repository_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  manifest_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  language TEXT,
  file TEXT,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  adapter TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  column INTEGER,
  adapter TEXT,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adapter_runs (
  adapter TEXT PRIMARY KEY,
  detected INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  diagnostic_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON diagnostics(severity);
`;

export async function persistGraph(outputDirectory: string, graph: GraphData, manifest: AnalysisManifest, adapterRuns: AdapterRun[]): Promise<void> {
  const database = new Database(path.join(outputDirectory, "graph.sqlite"));
  try {
    database.exec(SCHEMA_SQL);
    const persist = database.transaction(() => {
      for (const table of ["schema_metadata", "repository_metadata", "files", "nodes", "edges", "diagnostics", "adapter_runs"]) {
        database.exec(`DELETE FROM ${table}`);
      }
      const meta = database.prepare("INSERT INTO schema_metadata (key, value) VALUES (?, ?)");
      meta.run("schemaVersion", graph.schemaVersion);
      meta.run("toolVersion", manifest.toolVersion);
      const repo = database.prepare("INSERT INTO repository_metadata (key, value) VALUES (?, ?)");
      repo.run("root", graph.repository.root);
      repo.run("identity", graph.repository.identity);
      if (graph.repository.gitCommit) repo.run("gitCommit", graph.repository.gitCommit);
      database.prepare("INSERT INTO analysis_runs (generated_at, tool_version, schema_version, manifest_json) VALUES (?, ?, ?, ?)").run(
        manifest.generatedAt,
        manifest.toolVersion,
        manifest.schemaVersion,
        JSON.stringify(manifest),
      );
      const insertFile = database.prepare("INSERT INTO files (path, language, metadata_json) VALUES (?, ?, ?)");
      const insertNode = database.prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, language, file, start_line, start_column, end_line, end_column, adapter, metadata_json)
        VALUES (@id, @kind, @name, @qualifiedName, @language, @file, @startLine, @startColumn, @endLine, @endColumn, @adapter, @metadata)
      `);
      for (const node of graph.nodes) {
        if (node.kind === "file" && node.file) insertFile.run(node.file, node.language ?? null, JSON.stringify(node.metadata));
        insertNode.run({
          id: node.id,
          kind: node.kind,
          name: node.name,
          qualifiedName: node.qualifiedName,
          language: node.language ?? null,
          file: node.file ?? null,
          startLine: node.startLine ?? null,
          startColumn: node.startColumn ?? null,
          endLine: node.endLine ?? null,
          endColumn: node.endColumn ?? null,
          adapter: node.adapter,
          metadata: JSON.stringify(node.metadata),
        });
      }
      const insertEdge = database.prepare("INSERT INTO edges (id, source, target, kind, confidence, evidence_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const edge of graph.edges) insertEdge.run(edge.id, edge.source, edge.target, edge.kind, edge.confidence, JSON.stringify(edge.evidence), JSON.stringify(edge.metadata));
      const insertDiagnostic = database.prepare("INSERT INTO diagnostics (code, severity, message, file, line, column, adapter, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const diagnostic of graph.diagnostics) {
        insertDiagnostic.run(
          diagnostic.code,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.file ?? null,
          diagnostic.line ?? null,
          diagnostic.column ?? null,
          diagnostic.adapter ?? null,
          JSON.stringify(diagnostic.metadata),
        );
      }
      const insertAdapter = database.prepare("INSERT INTO adapter_runs (adapter, detected, duration_ms, file_count, node_count, edge_count, diagnostic_count) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const run of adapterRuns) insertAdapter.run(run.adapter, run.detected ? 1 : 0, run.durationMs, run.fileCount, run.nodeCount, run.edgeCount, run.diagnosticCount);
    });
    persist();
  } finally {
    database.close();
  }
}

interface NodeRow {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  qualified_name: string;
  language: string | null;
  file: string | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  adapter: string;
  metadata_json: string;
}

interface EdgeRow {
  id: string;
  source: string;
  target: string;
  kind: GraphEdge["kind"];
  confidence: GraphEdge["confidence"];
  evidence_json: string;
  metadata_json: string;
}

interface DiagnosticRow {
  code: string;
  severity: Diagnostic["severity"];
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  adapter: string | null;
  metadata_json: string;
}

export function graphNodeFromRow(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    ...(row.language ? { language: row.language } : {}),
    ...(row.file ? { file: row.file } : {}),
    ...(row.start_line !== null ? { startLine: row.start_line } : {}),
    ...(row.start_column !== null ? { startColumn: row.start_column } : {}),
    ...(row.end_line !== null ? { endLine: row.end_line } : {}),
    ...(row.end_column !== null ? { endColumn: row.end_column } : {}),
    adapter: row.adapter,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

export function graphEdgeFromRow(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    kind: row.kind,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json) as GraphEdge["evidence"],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

export function diagnosticFromRow(row: DiagnosticRow): Diagnostic {
  return {
    code: row.code,
    severity: row.severity,
    message: row.message,
    ...(row.file ? { file: row.file } : {}),
    ...(row.line !== null ? { line: row.line } : {}),
    ...(row.column !== null ? { column: row.column } : {}),
    ...(row.adapter ? { adapter: row.adapter } : {}),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

export type { NodeRow, EdgeRow, DiagnosticRow };
