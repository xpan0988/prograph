// Post-run correctness/resource witness, in a separate process outside analysis timing.
// node scripts/semantic-profile-verify.mjs SOURCE INDEX REPORT
import { readFile, stat, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { scanRepository } from '../dist/core/repository/repository.js';
import { canonical, digest } from '../dist/core/semantic/model.js';

const [source, index, report] = process.argv.slice(2);
const accepted = JSON.parse(await readFile(new URL('../docs/benchmarks/semantic-core-stage6-source-indexes.json', import.meta.url)));
const expected = accepted.results.find(r => r.name === 'indexed').data;
const files = [];
async function visit(directory = '') {
  for (const e of await readdir(path.join(source, directory), { withFileTypes: true })) {
    const file = path.posix.join(directory, e.name);
    if (e.isDirectory()) await visit(file);
    else if (e.isFile()) files.push([file, digest(await readFile(path.join(source, file)))]);
  }
}
await visit(); files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const copiedInventory = digest(JSON.stringify(files));
if (copiedInventory !== accepted.copiedInventory) throw Error('Frozen capture changed');
const { snapshot } = await scanRepository(source, index);
const inventory = digest(canonical([...snapshot.fileContents].map(([file, text]) => [file, digest(text)]).sort()));
if (inventory !== expected.inventory) throw Error('Selected input inventory changed');
const code = [...snapshot.fileContents].filter(([f]) => /\.(?:[cm]?tsx?|jsx?|rs|py|java|c|h|cpp|cc|cxx|go|cs)$/.test(f));
const sourceStats = { copiedFiles: files.length, copiedInventory, inventory, selectedFiles: snapshot.files.length,
  selectedBytes: [...snapshot.fileContents.values()].reduce((n, s) => n + Buffer.byteLength(s), 0), codeFiles: code.length,
  codeBytes: code.reduce((n, [, s]) => n + Buffer.byteLength(s), 0),
  physicalCodeLines: code.reduce((n, [, s]) => n + (s.length ? s.split('\n').length - Number(s.endsWith('\n')) : 0), 0),
  byExtension: Object.fromEntries([...new Set(code.map(([f]) => path.extname(f)))].sort().map(ext => [ext, code.filter(([f]) => path.extname(f) === ext).length])) };
const db = new Database(path.join(index, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
const checksums = {};
function rows(name, sql) { const h = createHash('sha256'); let count = 0; for (const row of db.prepare(sql).iterate()) { h.update(canonical(row) + '\n'); count++; } checksums[name] = { count, sha256: h.digest('hex') }; }
rows('visibleClaims', 'SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=1 ORDER BY c.key');
rows('occurrences', 'SELECT e.key,o.context,o.start_byte,o.end_byte,o.line,o.column_num,o.end_line,o.end_column,o.role FROM sc_occurrences o JOIN sc_entities e ON e.id=o.entity ORDER BY e.key');
rows('calls', 'SELECT x.key caller,y.key callee,c.site_count,c.confidence,e.key sample FROM sc_calls c JOIN sc_entities x ON x.id=c.caller JOIN sc_entities y ON y.id=c.callee JOIN sc_claims e ON e.id=c.sample_claim WHERE snapshot=1 ORDER BY x.key,y.key');
rows('scopeRows', 'SELECT * FROM cq_scope_nodes ORDER BY scope,node');
rows('boundaries', 'SELECT * FROM cq_boundaries ORDER BY framework,node');
rows('edges', 'SELECT * FROM edges ORDER BY id');
rows('diagnostics', 'SELECT code,severity,message,file,line,column,adapter,metadata_json FROM diagnostics ORDER BY code,severity,message,file,line,column,adapter,metadata_json');
rows('nodes', "SELECT * FROM nodes WHERE kind<>'repository' ORDER BY id");
if (JSON.stringify(checksums) !== JSON.stringify(expected.checksums)) throw Error('Accepted complete output witness changed');
const counts = Object.fromEntries(['facts', 'claims', 'entities', 'occurrences', 'symbols', 'runs', 'owned', 'groups', 'supports', 'projection_rows', 'inputs'].map(t => [t, db.prepare(`SELECT COUNT(*) n FROM sc_${t}`).get().n]));
const sqlite = { version: db.prepare('SELECT sqlite_version() v').get().v,
  integrity: db.pragma('integrity_check', { simple: true }), foreignKeys: db.pragma('foreign_key_check'),
  journal: db.pragma('journal_mode', { simple: true }), readConnectionSynchronous: db.pragma('synchronous', { simple: true }),
  pageSize: db.pragma('page_size', { simple: true }), pages: db.pragma('page_count', { simple: true }),
  connectionDefaultCacheSize: db.pragma('cache_size', { simple: true }), connectionDefaultMmapSize: db.pragma('mmap_size', { simple: true }),
  counts };
db.close();
const legacy = new Database(path.join(index, 'graph.sqlite'), { readonly: true, fileMustExist: true });
const compat = new Database(path.join(index, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
for (const table of ['nodes', 'edges', 'diagnostics']) {
  const order = table === 'diagnostics' ? 'code,severity,message,file,line,column,adapter,metadata_json' : 'id';
  const select = table === 'diagnostics' ? 'code,severity,message,file,line,column,adapter,metadata_json' : '*';
  const where = table === 'nodes' ? " WHERE kind<>'repository'" : '';
  const sql = `SELECT ${select} FROM ${table}${where} ORDER BY ${order}`;
  // Cache JSON is canonically ordered; legacy SQLite keeps insertion order.
  const normalize = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith('_json') ? JSON.parse(value) : value])));
  if (digest(canonical(normalize(legacy.prepare(sql).all()))) !== digest(canonical(normalize(compat.prepare(sql).all())))) throw Error('Legacy SQLite differs from authoritative cache: ' + table);
}
legacy.close(); compat.close();
const graph = JSON.parse(await readFile(path.join(index, 'exports/graph.json'), 'utf8'));
const jsonWitness = { nodes: digest(canonical(graph.nodes.filter(n => n.kind !== 'repository'))), edges: digest(canonical(graph.edges)), diagnostics: digest(canonical(graph.diagnostics)) };
const bytes = Object.fromEntries(await Promise.all(['semantic.sqlite', 'graph.sqlite', 'exports/graph.json'].map(async f => [f, (await stat(path.join(index, f))).size])));
// synchronous is connection-local: reopening a reader cannot witness the writer.
if (sqlite.integrity !== 'ok' || sqlite.foreignKeys.length || sqlite.journal !== 'wal') throw Error('Integrity/durability witness failed');
await writeFile(report, JSON.stringify({ format: 1, sourceStats, checksums, sqlite, jsonWitness, bytes, acceptedChecksumsEqual: true, legacySqliteEqual: true }, null, 2) + '\n');
console.log(JSON.stringify({ report, sourceStats, counts, bytes, acceptedChecksumsEqual: true }));
