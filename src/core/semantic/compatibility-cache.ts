/** Current compatibility projection of selected sealed facts; updated in publication. */
import { publishCompatibilityQueries } from "./compatibility-global.js";
import { COMPATIBILITY_SCHEMA_SQL, graphNodeFromRow, graphEdgeFromRow, diagnosticFromRow, type NodeRow, type EdgeRow, type DiagnosticRow } from "../storage/sqlite.js";
import type { GraphNode, GraphEdge, Diagnostic } from "../graph/schema.js";
import { canonical, digest, semanticKey } from "./model.js";
import { readSnapshotReport } from "./snapshot-report.js";
import { orderPasses } from "./passes.js";
import type { SemanticStore } from "./store.js";
const SQL = `
CREATE TABLE IF NOT EXISTS cg_owners(run INTEGER PRIMARY KEY REFERENCES sc_runs(id) ON DELETE CASCADE,priority INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cg_candidates(run INTEGER NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,claim INTEGER NOT NULL REFERENCES sc_claims(id) ON DELETE CASCADE,key TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(run,kind,ordinal),FOREIGN KEY(run,kind,ordinal) REFERENCES sc_projection_rows(run,kind,ordinal) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS cg_candidate_key ON cg_candidates(kind,key,priority DESC,run DESC,ordinal DESC);
CREATE INDEX IF NOT EXISTS cg_candidate_claim ON cg_candidates(claim);
CREATE TABLE IF NOT EXISTS cg_current(kind TEXT NOT NULL,key TEXT NOT NULL,run INTEGER NOT NULL REFERENCES sc_runs(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,claim INTEGER NOT NULL REFERENCES sc_claims(id) ON DELETE CASCADE,hash TEXT NOT NULL,PRIMARY KEY(kind,key));
CREATE TABLE IF NOT EXISTS cg_diagnostic_rows(key TEXT PRIMARY KEY,row INTEGER NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS cg_source_inputs(path TEXT PRIMARY KEY,run INTEGER NOT NULL REFERENCES sc_runs(id) ON DELETE CASCADE,claim INTEGER NOT NULL REFERENCES sc_claims(id) ON DELETE CASCADE,digest TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS cg_source_input_claim ON cg_source_inputs(claim);
CREATE TABLE IF NOT EXISTS cg_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS cg_delete_node AFTER DELETE ON cg_current WHEN OLD.kind='node' BEGIN DELETE FROM nodes WHERE id=OLD.key; END;
CREATE TRIGGER IF NOT EXISTS cg_delete_edge AFTER DELETE ON cg_current WHEN OLD.kind='edge' BEGIN DELETE FROM edges WHERE id=OLD.key; END;
CREATE TRIGGER IF NOT EXISTS cg_delete_diagnostic AFTER DELETE ON cg_current WHEN OLD.kind='diagnostic' BEGIN DELETE FROM diagnostics WHERE id=(SELECT row FROM cg_diagnostic_rows WHERE key=OLD.key); DELETE FROM cg_diagnostic_rows WHERE key=OLD.key; END;
`;
type Kind = "node" | "edge" | "diagnostic";
type Item = GraphNode | GraphEdge | Diagnostic;
export interface CompatibilityChange {
  kind: Kind;
  key: string;
  before?: Item;
  after?: Item;
}
export function publishCompatibilityCache(store: SemanticStore, snapshot: number, parent: number | undefined) {
  if (!store.db.inTransaction)
    throw Error("Compatibility cache requires atomic publication");
  const report = readSnapshotReport(store.db, snapshot);
  if (!report)
    throw Error("Compatibility cache requires its snapshot report");
  if (store.sql("SELECT 1 FROM sqlite_master WHERE name='nodes'").get() && !store.sql("SELECT 1 FROM sqlite_master WHERE name='cg_meta'").get())
    throw Error("Refusing to overwrite unmanaged compatibility tables");
  store.db.exec(COMPATIBILITY_SCHEMA_SQL);
  store.db.exec(SQL);
  store.db.exec("CREATE TEMP TABLE IF NOT EXISTS cg_touched(kind TEXT,key TEXT,PRIMARY KEY(kind,key)); DELETE FROM cg_touched;");
  const marker = store.sql("SELECT value FROM cg_meta WHERE key='snapshot'").get() as {
    value: string;
  } | undefined;
  const rebuilding = Number(marker?.value) !== parent || (store.sql("SELECT value FROM cg_meta WHERE key='schema'").get() as {
    value: string;
  } | undefined)?.value !== 'owned-compatibility-1';
  if (rebuilding) {
    store.db.exec("DELETE FROM cg_current; DELETE FROM cg_candidates; DELETE FROM cg_source_inputs; DELETE FROM cg_owners; DELETE FROM cg_meta; DELETE FROM nodes; DELETE FROM edges; DELETE FROM files; DELETE FROM diagnostics;");
  }
  const owners = store.sql("SELECT p.partition_key,p.run,r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'analysis/%' LIMIT 200001").all(snapshot) as Array<{
    partition_key: string;
    run: number;
    coverage_json: string;
  }>;
  if (owners.length > 200000)
    throw Error("Compatibility ownership exceeds publication budget");
  const contracts = owners.filter(row => /^analysis\/pass:[^/]+$/.test(row.partition_key)).map(row => { const c = JSON.parse(row.coverage_json); return { id: c.pass as string, dependencies: c.dependencies as string[] }; });
  const ranks = new Map(orderPasses(contracts).map((c, i) => [c.id, i + 1]));
  const expected = new Map(owners.map(row => {
    const priority = row.partition_key.startsWith('analysis/pass:') ? ranks.get(JSON.parse(row.coverage_json).pass) : 0; if (priority === undefined)
      throw Error("Missing selected compatibility pass contract"); return [row.run, { ...row, priority }];
  }));
  const current = new Map((store.sql("SELECT run,priority FROM cg_owners").all() as Array<{
    run: number;
    priority: number;
  }>).map(row => [row.run, row.priority]));
  const work = { classifiedRows: 0, classifiedBytes: 0, resolvedKeys: 0, resolvedBytes: 0, changedPayloads: 0 };
  const charge = (stage: 'classified' | 'resolved', bytes: number) => {
    const row = stage === 'classified' ? 'classifiedRows' : 'resolvedKeys', size = stage === 'classified' ? 'classifiedBytes' : 'resolvedBytes'; if (++work[row] > 1000000 || (work[size] += bytes) > 128 * 1024 ** 2)
      throw Error("Compatibility publication exceeds offline row/byte budgets");
  };
  const decode = (json: string) => {
    let payload = JSON.parse(json) as {
      node?: GraphNode;
      edge?: GraphEdge;
      diagnostic?: Diagnostic;
      payloadEntity?: string;
    }; let bytes = Buffer.byteLength(json); if (payload.payloadEntity) {
      const stored = store.sql("SELECT CASE WHEN length(CAST(canonical AS BLOB))<=134217728 THEN canonical END AS data FROM sc_entities WHERE key=?").get(payload.payloadEntity) as {
        data: string | null;
      } | undefined;
      if (!stored?.data)
        throw Error("Missing or oversized compatibility payload");
      bytes += Buffer.byteLength(stored.data);
      payload = JSON.parse(stored.data);
    } return { payload, bytes };
  };
  const markOwner = store.sql("INSERT OR IGNORE INTO cg_touched SELECT kind,key FROM cg_candidates WHERE run=?");
  for (const [run, priority] of current)
    if (expected.get(run)?.priority !== priority) {
      markOwner.run(run);
      store.sql("DELETE FROM cg_candidates WHERE run=?").run(run);
      store.sql("DELETE FROM cg_source_inputs WHERE run=?").run(run);
      store.sql("DELETE FROM cg_owners WHERE run=?").run(run);
      current.delete(run);
    }
  for (const [run, owner] of expected)
    if (!current.has(run)) {
      store.sql("INSERT INTO cg_owners VALUES(?,?)").run(run, owner.priority);
      const rows = function*() {
        let kind = '', ordinal = -1; while (true) {
          const batch = store.sql("SELECT p.kind,p.ordinal,p.claim,f.value_json FROM sc_projection_rows p CROSS JOIN sc_claims c ON c.id=p.claim CROSS JOIN sc_facts f ON f.id=c.fact WHERE p.run=? AND (p.kind>? OR p.kind=? AND p.ordinal>?) ORDER BY p.kind,p.ordinal LIMIT 500").all(run, kind, kind, ordinal) as Array<{
            kind: Kind;
            ordinal: number;
          }>;
          if (!batch.length)
            return;
          yield* batch;
          const last = batch.at(-1)!;
          kind = last.kind;
          ordinal = last.ordinal;
        }
      };
      for (const value of rows()) {
        const row = value as {
          kind: Kind;
          ordinal: number;
          claim: number;
          value_json: string;
        };
        const { payload, bytes } = decode(row.value_json);
        charge('classified', bytes);
        const item = payload[row.kind];
        if (!item)
          throw Error("Invalid compatibility candidate payload");
        const key = row.kind === 'diagnostic' ? semanticKey('compatibility-diagnostic', [owner.partition_key, row.ordinal]) : (item as GraphNode | GraphEdge).id;
        store.sql("INSERT INTO cg_candidates VALUES(?,?,?,?,?,?)").run(run, row.kind, row.ordinal, row.claim, key, owner.priority);
        store.sql("INSERT OR IGNORE INTO cg_touched VALUES(?,?)").run(row.kind, key);
      }
    }
  // The publisher validated the complete support closure. Retained candidates need
  // winner resolution only when eligibility changed; alternate support alone does not
  // change their payload. Added/removed owners are independently marked above.
  store.sql(`INSERT OR IGNORE INTO cg_touched SELECT c.kind,c.key FROM sc_pending p
    CROSS JOIN cg_candidates c INDEXED BY cg_candidate_claim ON c.claim=p.claim
    WHERE EXISTS(SELECT 1 FROM(SELECT first,last FROM sc_visibility v WHERE v.claim=p.claim ORDER BY first DESC LIMIT 1)latest WHERE latest.first=? OR latest.last=?)`).run(snapshot,snapshot);
  store.db.exec("INSERT OR IGNORE INTO cg_touched SELECT 'node',id FROM nodes WHERE kind='repository';");
  store.db.exec("DELETE FROM cg_source_inputs WHERE claim IN(SELECT claim FROM sc_pending) AND NOT EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=" + snapshot + " AND a.claim=cg_source_inputs.claim);");
  const sourceRows = store.sql(`SELECT o.run,c.id,f.value_json FROM ${rebuilding ? "cg_owners owner CROSS JOIN sc_owned o ON o.run=owner.run CROSS JOIN sc_claims c ON c.id=o.claim CROSS JOIN sc_facts f ON f.id=c.fact" : "sc_pending pending CROSS JOIN sc_claims c ON c.id=pending.claim CROSS JOIN sc_facts f ON f.id=c.fact CROSS JOIN sc_owned o ON o.claim=c.id CROSS JOIN cg_owners owner ON owner.run=o.run"} WHERE f.predicate='source.File' AND EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=c.id) LIMIT 200001`).all(snapshot);
  if (sourceRows.length > 200000)
    throw Error("Compatibility source inputs exceed publication budget");
  for (const raw of sourceRows) {
    const row = raw as {
      run: number;
      id: number;
      value_json: string;
    };
    const input = JSON.parse(row.value_json) as {
      file: string;
      digest: string;
    };
    if (!input.file || input.file.startsWith('/') || input.file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(input.digest))
      throw Error("Invalid selected source-file receipt");
    store.sql("INSERT INTO cg_source_inputs VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET run=excluded.run,claim=excluded.claim,digest=excluded.digest").run(input.file, row.run, row.id, input.digest);
  }
  if ((store.sql("SELECT COUNT(*) n FROM cg_source_inputs").get() as {
    n: number;
  }).n !== report.manifest.scannedFileCount)
    throw Error("Compatibility source inputs disagree with the bound report");
  const changes: CompatibilityChange[] = [];
  const counts = JSON.parse((store.sql("SELECT value FROM cg_meta WHERE key='counts'").get() as {
    value: string;
  } | undefined)?.value ?? '{"node":0,"edge":0,"diagnostic":0}') as Record<Kind, number>;
  const winner = store.sql(`SELECT x.run,x.ordinal,x.claim,f.value_json FROM cg_candidates x INDEXED BY cg_candidate_key CROSS JOIN sc_claims c ON c.id=x.claim CROSS JOIN sc_facts f ON f.id=c.fact
    WHERE x.kind=? AND x.key=? AND EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=x.claim) ORDER BY x.priority DESC,x.run DESC,x.ordinal DESC LIMIT 1`);
  const read = (kind: Kind, key: string): Item => kind === 'node' ? graphNodeFromRow(store.sql("SELECT * FROM nodes WHERE id=?").get(key) as NodeRow) : kind === 'edge' ? graphEdgeFromRow(store.sql("SELECT * FROM edges WHERE id=?").get(key) as EdgeRow) : diagnosticFromRow(store.sql("SELECT d.* FROM cg_diagnostic_rows r JOIN diagnostics d ON d.id=r.row WHERE r.key=?").get(key) as DiagnosticRow);
  const upsertNode = store.sql(`INSERT INTO nodes VALUES(@id,@kind,@name,@qualifiedName,@language,@file,@startLine,@startColumn,@endLine,@endColumn,@adapter,@metadata)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,qualified_name=excluded.qualified_name,language=excluded.language,file=excluded.file,start_line=excluded.start_line,start_column=excluded.start_column,end_line=excluded.end_line,end_column=excluded.end_column,adapter=excluded.adapter,metadata_json=excluded.metadata_json`);
  const upsertEdge = store.sql("INSERT INTO edges VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,target=excluded.target,kind=excluded.kind,confidence=excluded.confidence,evidence_json=excluded.evidence_json,metadata_json=excluded.metadata_json");
  const upsertCurrent = store.sql("INSERT INTO cg_current VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET run=excluded.run,ordinal=excluded.ordinal,claim=excluded.claim,hash=excluded.hash");
  for (const kind of ['node', 'edge', 'diagnostic'] as const) {
    const keys = function*() {
      let after = ''; while (true) {
        const rows = store.sql("SELECT key FROM cg_touched WHERE kind=? AND key>? ORDER BY key LIMIT 500").all(kind, after) as Array<{
          key: string;
        }>;
        if (!rows.length)
          return;
        yield* rows;
        after = rows.at(-1)!.key;
      }
    };
    for (const raw of keys()) {
      if (++work.resolvedKeys > 1000000)
        throw Error("Compatibility publication exceeds key budget");
      const key = (raw as {
        key: string;
      }).key, previous = store.sql("SELECT hash FROM cg_current WHERE kind=? AND key=?").get(kind, key) as {
        hash: string;
      } | undefined;
      const row = winner.get(kind, key, snapshot) as {
        run: number;
        ordinal: number;
        claim: number;
        value_json: string;
      } | undefined;
      let item: Item | undefined;
      if (row) {
        const decoded = decode(row.value_json);
        if ((work.resolvedBytes += decoded.bytes) > 128 * 1024 ** 2)
          throw Error("Compatibility publication exceeds byte budget");
        item = decoded.payload[kind];
        if (!item)
          throw Error("Invalid compatibility winner");
        if (kind === 'node' && (item as GraphNode).kind === 'repository')
          item = { ...item, metadata: { ...(item as GraphNode).metadata, analysis: (report.manifest.adapterRuns ?? []).map(({ adapter, detected, metadata }) => ({ adapter, detected, ...metadata })) } };
      }
      const hash = item ? digest(canonical(item)) : undefined;
      if (row && hash === previous?.hash) {
        if (kind === 'edge') {
          const e = item as GraphEdge;
          if (!store.sql("SELECT 1 FROM nodes WHERE id=?").get(e.source) || !store.sql("SELECT 1 FROM nodes WHERE id=?").get(e.target))
            throw Error("Unsupported compatibility edge endpoint");
        }
        upsertCurrent.run(kind, key, row.run, row.ordinal, row.claim, hash);
        continue;
      }
      if (!row && !previous)
        continue;
      const before = previous ? read(kind, key) : undefined;
      changes.push({ kind, key, ...(before ? { before } : {}), ...(item ? { after: item } : {}) });
      work.changedPayloads++;
      if (!previous && item)
        counts[kind]++;
      else if (previous && !item)
        counts[kind]--;
      if (kind === 'node' && before && !item)
        for (const endpoint of ['source', 'target'])
          store.sql(`INSERT OR IGNORE INTO cg_touched SELECT 'edge',id FROM edges INDEXED BY idx_edges_${endpoint} WHERE ${endpoint}=?`).run(key);
      if (!row) {
        store.sql("DELETE FROM cg_current WHERE kind=? AND key=?").run(kind, key);
        continue;
      }
      if (kind === 'node') {
        const n = item as GraphNode;
        upsertNode.run({ ...n, language: n.language ?? null, file: n.file ?? null, startLine: n.startLine ?? null, startColumn: n.startColumn ?? null, endLine: n.endLine ?? null, endColumn: n.endColumn ?? null, metadata: JSON.stringify(n.metadata) });
      }
      else if (kind === 'edge') {
        const e = item as GraphEdge;
        if (!store.sql("SELECT 1 FROM nodes WHERE id=?").get(e.source) || !store.sql("SELECT 1 FROM nodes WHERE id=?").get(e.target))
          throw Error("Unsupported compatibility edge endpoint");
        upsertEdge.run(e.id, e.source, e.target, e.kind, e.confidence, JSON.stringify(e.evidence), JSON.stringify(e.metadata));
      }
      else {
        const d = item as Diagnostic;
        store.sql("DELETE FROM diagnostics WHERE id=(SELECT row FROM cg_diagnostic_rows WHERE key=?)").run(key);
        const inserted = store.sql("INSERT INTO diagnostics(code,severity,message,file,line,column,adapter,metadata_json) VALUES(?,?,?,?,?,?,?,?)").run(d.code, d.severity, d.message, d.file ?? null, d.line ?? null, d.column ?? null, d.adapter ?? null, JSON.stringify(d.metadata));
        store.sql("INSERT INTO cg_diagnostic_rows VALUES(?,?) ON CONFLICT(key) DO UPDATE SET row=excluded.row").run(key, inserted.lastInsertRowid);
      }
      upsertCurrent.run(kind, key, row.run, row.ordinal, row.claim, hash!);
    }
  }
  if (counts.node !== report.manifest.nodeCount || counts.edge !== report.manifest.edgeCount || counts.diagnostic !== report.manifest.diagnosticCount)
    throw Error("Owned compatibility counts disagree with the bound report");
  for (const change of changes)
    if (change.kind === 'node')
      for (const item of [change.before, change.after]) {
        const n = item as GraphNode | undefined;
        if (n?.kind === 'file' && n.file) {
          store.sql("DELETE FROM files WHERE path=?").run(n.file);
          const matches = store.sql("SELECT * FROM nodes WHERE kind='file' AND file=? LIMIT 2").all(n.file) as NodeRow[];
          if (matches.length > 1)
            throw Error("Duplicate compatibility file path");
          if (matches.length) {
            const current = matches[0]!;
            store.sql("INSERT INTO files VALUES(?,?,?)").run(n.file, current.language, current.metadata_json);
          }
        }
      }
  for (const table of ['schema_metadata', 'repository_metadata', 'analysis_runs', 'adapter_runs'])
    store.db.exec(`DELETE FROM ${table}`);
  const m = report.manifest;
  for (const [key, value] of Object.entries({ schemaVersion: m.schemaVersion, toolVersion: m.toolVersion, adapterMetadata: JSON.stringify(Object.fromEntries((m.adapterRuns ?? []).map(run => [run.adapter, run.metadata ?? {}]))) }))
    store.sql("INSERT INTO schema_metadata VALUES(?,?)").run(key, value);
  for (const [key, value] of Object.entries({ root: m.repositoryRoot, identity: m.repositoryIdentity, ...(m.gitCommit ? { gitCommit: m.gitCommit } : {}) }))
    store.sql("INSERT INTO repository_metadata VALUES(?,?)").run(key, value);
  store.sql("INSERT INTO analysis_runs VALUES(?,?,?,?,?)").run(snapshot, m.generatedAt, m.toolVersion, m.schemaVersion, JSON.stringify(m));
  for (const r of m.adapterRuns ?? [])
    store.sql("INSERT INTO adapter_runs VALUES(?,?,?,?,?,?,?)").run(r.adapter, r.detected ? 1 : 0, r.durationMs, r.fileCount, r.nodeCount, r.edgeCount, r.diagnosticCount);
  for (const [key, value] of Object.entries({ snapshot: String(snapshot), counts: JSON.stringify(counts), schema: 'owned-compatibility-1', work: JSON.stringify(work), snapshotKey: report.snapshotKey, reportKey: report.reportKey }))
    store.sql("INSERT INTO cg_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  const queries = publishCompatibilityQueries(store, snapshot, report.reportKey, changes, rebuilding);
  return { changes, work, queries };
}
