// Post-timing full ownership/support and source-freshness comparison. No graph-byte normalization.
// node scripts/semantic-export-witness.mjs ACCEPTED_INDEX NEW_INDEX SOURCE REPORT
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonical } from '../dist/core/semantic/model.js';
import { repositoryStatus } from '../dist/core/analysis/state.js';
const [accepted, current, source, report] = process.argv.slice(2);
if (!accepted || !current || !source || !report) throw Error('ACCEPTED_INDEX NEW_INDEX SOURCE REPORT required');
async function bytesEqual(a, b) {
  const left = createReadStream(a, { highWaterMark: 65536 }), right = createReadStream(b, { highWaterMark: 65536 });
  const iterator = right[Symbol.asyncIterator](), hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of left) { const other = await iterator.next(); if (other.done || !chunk.equals(other.value)) throw Error('Complete export bytes differ: ' + a); hash.update(chunk); bytes += chunk.length; }
    if (!(await iterator.next()).done) throw Error('Complete export length differs: ' + a);
    return { equal: true, bytes, sha256: hash.digest('hex') };
  } finally { left.destroy(); right.destroy(); }
}
const files = {};
for (const name of ['exports/graph.json', 'diagnostics.json']) files[name] = await bytesEqual(path.join(accepted, name), path.join(current, name));
const left = new Database(path.join(accepted, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
const right = new Database(path.join(current, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
const tables = {};
try {
  for (const table of ['sc_facts', 'sc_claims', 'sc_entities', 'sc_occurrences', 'sc_symbols', 'sc_contexts', 'sc_owned', 'sc_groups', 'sc_supports', 'sc_inputs', 'sc_observed_inputs', 'sc_run_digests', 'sc_run_selectors', 'sc_selector_gates', 'sc_runs']) {
    const columns = left.prepare(`PRAGMA table_info(${table})`).all();
    // Fresh runs have different wall-clock creation timestamps. No semantic or
    // support column is excluded; snapshot reports/manifests have separate clocks.
    const select = columns.filter(c => !(table === 'sc_runs' && c.name === 'created_at')).map(c => c.name).join(',');
    const order = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name).join(',');
    if (!select || !order) throw Error('Expected keyed table: ' + table);
    function digest(db) { const h = createHash('sha256'); let count = 0; for (const row of db.prepare(`SELECT ${select} FROM ${table} ORDER BY ${order}`).iterate()) { h.update(canonical(row) + '\n'); count++; } return { count, sha256: h.digest('hex') }; }
    const a = digest(left), b = digest(right); if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Ownership/semantic rows differ: ' + table);
    tables[table] = { ...b, equal: true, excludedColumns: table === 'sc_runs' ? ['created_at'] : [] };
  }
} finally { left.close(); right.close(); }
const freshness = await repositoryStatus(source, current);
if (freshness.state !== 'fresh') throw Error('Source is not fresh');
await writeFile(report, JSON.stringify({ format: 1, files, tables, freshness, limits: 'Raw graph/diagnostics compared completely without normalization. Complete selected SQL rows compared in primary-key order; only sc_runs.created_at excluded. Complete semantic report/manifest run clocks are not byte-compared across analyses.' }, null, 2) + '\n');
console.log(JSON.stringify({ report, files, tables, freshness: freshness.state }));
