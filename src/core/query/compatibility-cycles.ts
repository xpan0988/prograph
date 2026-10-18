/** Explicit offline cycle preparation; interactive readers never run a global traversal. */
import type Database from 'better-sqlite3';
import { CompatibilityGlobalRead } from './compatibility-global-read.js';
import { NavigationRead } from './navigation.js';
import { QUERY_SCOPES, scopeBit, offlineCycles } from './global-projections.js';
import type { GraphEdge } from '../graph/schema.js';
export function prepareCompatibilityCycles(db: Database.Database) {
  if (!db.inTransaction)
    throw Error('Offline cycle preparation requires a transaction');
  const generation = new CompatibilityGlobalRead(db, new NavigationRead(db)).generation;
  const rows: Array<{
    edge: string;
    source: string;
    target: string;
    mask: number;
    level: number;
    kind: string;
  }> = [];
  let bytes = 0;
  for (const raw of db.prepare("SELECT edge,source,target,mask,level,kind FROM cq_edges WHERE kind IN ('imports','calls','mentions','configures','tests','related_to')ORDER BY edge").iterate()) {
    const row = raw as typeof rows[number];
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (rows.length >= 1000000 || bytes > 128 * 1024 ** 2)
      throw Error('Offline cycle preparation exceeds 1000000 relationships or 128 MiB');
    rows.push(row);
  }
  db.exec('DELETE FROM cq_cycles;DELETE FROM cq_cycle_errors');
  let total = 0;
  for (const scope of QUERY_SCOPES)
    for (let level = 0;level < 3;level++) {
      const allowed = new Set(scope === 'code' ? ['imports', 'calls'] : ['imports', 'calls', 'mentions', 'configures', 'tests', 'related_to']);
      const edges = rows.filter(row => (row.mask & scopeBit(scope)) && row.level <= level && allowed.has(row.kind)).map(row => ({ id: row.edge, source: row.source, target: row.target, kind: row.kind as GraphEdge['kind'], confidence: 'exact' as const, evidence: [], metadata: {} }));
      const result = offlineCycles(edges);
      if (result.error)
        db.prepare('INSERT INTO cq_cycle_errors VALUES(?,?,?)').run(scope, level, result.error);
      else
        for (const [ordinal, cycle] of result.cycles.entries()) {
          db.prepare('INSERT INTO cq_cycles(scope,level,ordinal,data)VALUES(?,?,?,?)').run(scope, level, ordinal + 1, JSON.stringify(cycle));
          total++;
        }
    }
  db.prepare("INSERT INTO cq_meta VALUES('cycles','ready')ON CONFLICT(key)DO UPDATE SET value=excluded.value").run();
  return { projectionVersion: 'owned-query-1', generation, relationships: rows.length, bytes, cycles: total, ordering: 'stable relationship identity; DFS back-edge semantics' };
}
