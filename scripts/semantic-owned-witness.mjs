// Post-timing complete SQL witness, including sealed projection order and all
// legacy/query tables. Raw graph/diagnostic bytes use semantic-export-witness.
// node scripts/semantic-owned-witness.mjs ACCEPTED_INDEX NEW_INDEX REPORT
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSnapshotReport } from '../dist/core/semantic/snapshot-report.js';
const [accepted, current, report] = process.argv.slice(2);
if (!accepted || !current || !report) throw Error('ACCEPTED_INDEX NEW_INDEX REPORT required');
const clockFields = ['sc_runs.created_at', 'sc_snapshots.created_at', 'sc_origin_runs.created_at', 'sc_provider_recipes.updated_at',
  'analysis_runs.generated_at', 'adapter_runs.duration_ms', 'manifest.generatedAt', 'manifest.analysisDuration',
  'manifest.adapterRuns[].durationMs', 'manifest.semanticCore.durationMs', 'stateHeader.generatedAt'];
function manifest(value) {
  const copy = structuredClone(value);
  delete copy.generatedAt; delete copy.analysisDuration;
  for (const run of copy.adapterRuns ?? []) delete run.durationMs;
  if (copy.semanticCore) delete copy.semanticCore.durationMs;
  return copy;
}
function normalizedReport(db, snapshot) {
  // Authenticate original report hash and its snapshot binding before excluding
  // clocks and the hash derived from those clocks from cross-run comparison.
  const value = readSnapshotReport(db, snapshot);
  assert.ok(value); delete value.reportKey;
  value.manifest = manifest(value.manifest); delete value.stateHeader.generatedAt;
  return value;
}
const databases = {};
for (const filename of ['semantic.sqlite', 'graph.sqlite']) {
  const left = new Database(path.join(accepted, filename), { readonly: true });
  const right = new Database(path.join(current, filename), { readonly: true });
  try {
    const schema = db => db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
    assert.deepEqual(schema(right), schema(left), 'Complete SQL schemas differ');
    const tables = {};
    for (const { name } of left.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      const quote = name => '"' + name.replaceAll('"', '""') + '"';
      const columns = left.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const order = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
      if (!order.length) order.push(...columns.map(c => c.name));
      const rows = db => {
        const h = createHash('sha256'); let count = 0;
        for (const original of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order.map(quote).join(',')}`).iterate()) {
          const row = { ...original };
          for (const field of clockFields) { const [table, column] = field.split('.'); if (name === table) delete row[column]; }
          if (name === 'analysis_runs') row.manifest_json = manifest(JSON.parse(row.manifest_json));
          if (name === 'sc_snapshot_reports') { row.json = normalizedReport(db, row.snapshot); delete row.key; }
          if (name === 'cg_meta' && row.key === 'reportKey' || name === 'cq_meta' && row.key === 'generation') {
            const bound = db.prepare('SELECT snapshot FROM sc_snapshot_reports WHERE key=?').get(row.value);
            assert.ok(bound, 'Compatibility report key must bind an authenticated report');
            row.value = normalizedReport(db, bound.snapshot);
          }
          h.update(JSON.stringify(row) + '\n'); count++;
        }
        return { count, sha256: h.digest('hex') };
      };
      const a = rows(left), b = rows(right);
      if (name === 'q_meta' && a.sha256 !== b.sha256) {
        // This legacy cache uses randomUUID(), not a clock. Keep its raw
        // difference visible rather than claiming complete SQL byte equality.
        const l = left.prepare('SELECT * FROM q_meta ORDER BY key').all(), r = right.prepare('SELECT * FROM q_meta ORDER BY key').all();
        assert.deepEqual(r.filter(row => row.key !== 'generation'), l.filter(row => row.key !== 'generation'));
        const tokens = [l, r].map(values => values.find(row => row.key === 'generation')?.value);
        for (const token of tokens) assert.match(token, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        tables[name] = { equal: false, accepted: a, current: b, randomGenerationTokens: tokens,
          limitation: 'All remaining rows equal. Raw non-clock cache UUID difference retained; complete SQL byte equality is not claimed.' };
        continue;
      }
      assert.deepEqual(b, a, filename + ':' + name + ' complete rows differ');
      tables[name] = { ...b, equal: true };
    }
    for (const db of [left, right]) { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []); }
    databases[filename] = { schemaEqual: true, tables, integrity: 'ok', foreignKeys: 'ok' };
  } finally { left.close(); right.close(); }
}
await writeFile(report, JSON.stringify({ format: 1, databases, excludedClockFields: clockFields,
  reportKeys: 'Original keys authenticated independently; compare complete reports excluding clocks and their derived report keys. No graph/export bytes normalized.' }, null, 2) + '\n');
console.log(JSON.stringify({ report, tables: Object.fromEntries(Object.entries(databases).map(([file, data]) => [file, Object.keys(data.tables).length])),
  allOtherTablesEqual: true, rawDifferences: ['graph.sqlite:q_meta generation UUID'] }));
