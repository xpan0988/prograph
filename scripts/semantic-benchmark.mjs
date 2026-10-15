// Step 1 qualification: synthetic storage/query workload, not LOC/provider qualification.
// Run after npm run build: node scripts/semantic-benchmark.mjs 100000 /tmp/result.json
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SemanticStore } from '../dist/core/semantic/store.js';
import { SemanticQuery } from '../dist/core/semantic/query.js';
import { digest, semanticKey } from '../dist/core/semantic/model.js';

const count = Number(process.argv[2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1000 || count > 10000000) throw Error('count must be 1,000..10,000,000');
const output = process.argv[3];
const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-step1-bench-'));
const started = performance.now();
const report = { workload: 'synthetic occurrence navigation, 1% static calls, 1000 caller identities, batch 1000; not a source-code corpus', count,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryBytes: os.totalmem(), sqlite: new Database(':memory:').prepare('select sqlite_version() as version').get().version },
  startedAt: new Date().toISOString() };
report.implementationDigests = Object.fromEntries(await Promise.all(['model','store','schema','query','publication','read','coordinates'].map(async name => [name, digest(await readFile(new URL(`../dist/core/semantic/${name}.js`, import.meta.url)))])));
function measured(operation) { const start = performance.now(); const result = operation(); return { ms: +(performance.now() - start).toFixed(3), result }; }
try {
  const filename = path.join(root, 'semantic.sqlite'); const publicationStages = {};
  const store = new SemanticStore(filename, { measure(stage, ms) { publicationStages[stage] = +ms.toFixed(3); } });
  report.sqlitePragmas = Object.fromEntries(['journal_mode','synchronous','wal_autocheckpoint','cache_size'].map(p => [p,store.db.pragma(p,{simple:true})]));
  const context = 'benchmark'; const inputFingerprint = digest(`synthetic-${count}`);
  const provenance = { provider: 'benchmark/compiler', version: '1', basis: 'compiler', method: 'synthetic', context, inputFingerprint };
  const passProvenance = { ...provenance, provider: 'benchmark/pass' };
  const run = store.begin('base', context, inputFingerprint); const pass = store.begin('calls', context, inputFingerprint);
  const sourceDigest = digest('x'.repeat(count + 1001));
  const sourceSize = count + 1001;
  const occurrence = (i, role) => {
    const data = { file: 'hub.ts', sourceDigest, context, startByte: i, endByte: i + 1, line: 1, column: i + 1, endLine: 1, endColumn: i + 2, role };
    return { key: semanticKey('occurrence', data), ...data };
  };
  store.batch(run, () => {
    for (let i = 0; i <= 1000; i++) {
      const key = i === 1000 ? 'hub' : `caller-${i}`;
      store.addSymbol({ key, name: key, qualifiedName: key, kind: 'function', file: 'hub.ts', context });
      const o = occurrence(count + i, 'definition'); store.addOccurrence(o, sourceSize);
      store.addFact(run, { predicate: 'common.Declaration', context, subject: key, occurrence: o.key, confidence: 'exact', provenance });
      store.addFact(run, { predicate: 'common.Definition', context, subject: key, object: key, occurrence: o.key, confidence: 'exact', provenance });
    }
    store.selector(run, 'inventory', inputFingerprint);
  });
  const writes = performance.now(); let callSites = 0;
  for (let offset = 0; offset < count; offset += 1000) {
    const derived = [];
    store.batch(run, () => {
      for (let i = offset; i < Math.min(offset + 1000, count); i++) {
        const isCall = i % 100 === 0;
        const caller = `caller-${Math.floor(i / 100) % 1000}`;
        const o = occurrence(i, isCall ? 'call' : 'reference'); store.addOccurrence(o, sourceSize);
        if (!isCall) store.addFact(run, { predicate: 'common.Reference', context, subject: caller, object: 'hub', occurrence: o.key, confidence: 'resolved', provenance });
        else {
          const site = store.addFact(run, { predicate: 'common.CallSite', context, subject: caller, occurrence: o.key, confidence: 'exact', provenance });
          const binding = store.addFact(run, { predicate: 'common.CallTarget', context, subject: caller, object: 'hub', occurrence: o.key, confidence: 'resolved', provenance });
          derived.push({ caller, o, site, binding }); callSites++;
        }
      }
    });
    store.batch(pass, () => { for (const c of derived) store.addFact(pass, { predicate: 'common.CallSummary', context, subject: c.caller, object: 'hub', occurrence: c.o.key, confidence: 'resolved', provenance: passProvenance,
      supports: [[{ claim: c.site }, { claim: c.binding }, { selector: 'inventory', digest: inputFingerprint }]] }); });
    if (offset % 100000 === 0) process.stderr.write(`staged ${offset}/${count}\n`);
  }
  report.writeMs = Math.round(performance.now() - writes); report.callSites = callSites;
  const sealStarted = performance.now();
  store.seal(run, { status: 'partial', gaps: ['Synthetic facts, not a compiler index'] }); store.seal(pass, { status: 'partial' });
  report.sealMs = +(performance.now() - sealStarted).toFixed(3);
  const published = measured(() => store.publish([run, pass])); report.publicationMs = published.ms;
  report.publicationStagesMs = publicationStages;
  report.counts = Object.fromEntries(['entities','occurrences','facts','claims','provenance','groups','supports','navigation','calls'].map(t => [t, store.db.prepare(`SELECT COUNT(*) AS n FROM sc_${t}`).get().n]));
  report.queryPlans = {
    references: store.db.prepare('EXPLAIN QUERY PLAN SELECT occurrence,claim FROM sc_navigation WHERE snapshot=? AND relation=? AND object=? AND occurrence>? ORDER BY occurrence LIMIT ?').all(published.result, 'reference', store.entity('hub'), 0, 51),
    callers: store.db.prepare('EXPLAIN QUERY PLAN SELECT caller FROM sc_calls WHERE snapshot=? AND callee=? AND caller>? ORDER BY caller LIMIT ?').all(published.result, store.entity('hub'), 0, 51),
    occurrence: store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM sc_navigation WHERE snapshot=? AND occurrence=? LIMIT 1').all(published.result, store.entity(occurrence(1, 'reference').key)),
  };
  report.callSiteOracle = store.db.prepare('SELECT SUM(site_count) AS sites,COUNT(*) AS pairs FROM sc_calls WHERE snapshot=?').get(published.result);
  if (report.callSiteOracle.sites !== callSites || report.callSiteOracle.pairs !== Math.min(callSites, 1000)) throw Error('Full synthetic static-call aggregate oracle mismatch');
  report.integrity = store.db.pragma('integrity_check', { simple: true }); report.foreignKeyViolations = store.db.pragma('foreign_key_check');
  if (report.integrity !== 'ok' || report.foreignKeyViolations.length || store.db.pragma('synchronous', { simple: true }) !== 2) throw Error('Storage integrity/durability failure');
  store.db.pragma('wal_checkpoint(TRUNCATE)'); store.close(); report.databaseBytes = (await stat(filename)).size;
  const query = new SemanticQuery(filename); report.queries = {};
  for (const [operation, input] of [['definition','hub'],['references','hub'],['callers','hub'],['callees','caller-0']]) {
    // First connection read is reported separately; OS page cache is not evicted.
    const first = measured(() => query.execute(operation, input, { limit: 50 }));
    const samples = Array.from({ length: 30 }, () => measured(() => query.execute(operation, input, { limit: 50 })).ms).sort((a,b) => a-b);
    report.queries[operation] = { firstReadMs: first.ms, warmMedianMs: samples[15], warmP95Ms: samples[28], returned: first.result.items.length, bytes: Buffer.byteLength(JSON.stringify(first.result)), work: first.result.work };
  }
  query.close();
  // Isolated equal-information layout experiments: exclude identity/membership/projection overhead.
  // They answer whether duplicating provenance and repeated support lists is cheap.
  const layoutFile = path.join(root, 'layouts.sqlite'); const layouts = new Database(layoutFile);
  layouts.exec('CREATE TABLE json_occ(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE normalized_occ(id INTEGER PRIMARY KEY,start INTEGER,end INTEGER,role TEXT,provenance INTEGER); CREATE TABLE provenance(id INTEGER PRIMARY KEY,json TEXT); CREATE TABLE flat_support(id INTEGER PRIMARY KEY,json TEXT); CREATE TABLE support_group(id INTEGER PRIMARY KEY,json TEXT UNIQUE); CREATE TABLE support_ref(id INTEGER PRIMARY KEY,group_id INTEGER);');
  const json = layouts.prepare('INSERT INTO json_occ VALUES(?,?)'); const typed = layouts.prepare('INSERT INTO normalized_occ VALUES(?,?,?,?,1)');
  const flat = layouts.prepare('INSERT INTO flat_support VALUES(?,?)'); const ref = layouts.prepare('INSERT INTO support_ref VALUES(?,1)');
  const support = JSON.stringify([[{ claim: 'a'.repeat(80) }, { claim: 'b'.repeat(80) }, { selector: 'inventory', digest: inputFingerprint }]]);
  layouts.prepare('INSERT INTO provenance VALUES(1,?)').run(JSON.stringify(provenance)); layouts.prepare('INSERT INTO support_group VALUES(1,?)').run(support);
  const experiments = performance.now();
  for (let offset = 0; offset < count; offset += 1000) layouts.transaction(() => {
    for (let i=offset;i<Math.min(count,offset+1000);i++) { json.run(i,JSON.stringify({ start:i,end:i+1,role:'reference',provenance })); typed.run(i,i,i+1,'reference'); flat.run(i,support); ref.run(i); }
  })();
  report.layoutExperimentMs = Math.round(performance.now()-experiments);
  report.layoutBytes = Object.fromEntries(layouts.prepare("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all().map(r => [r.name,r.bytes]));
  report.supportExperiment = { shape: 'all rows share one 2-claim AND + selector; upper bound on reuse benefit, not realistic per-callsite reuse', uniqueProductionGroups: report.counts.groups, productionSupportAtoms: report.counts.supports };
  layouts.close(); report.totalMs = Math.round(performance.now()-started); report.maxRssKiB = process.resourceUsage().maxRSS;
  const text = `${JSON.stringify(report,null,2)}\n`; if (output) await writeFile(output,text); process.stdout.write(text);
} finally {
  if (process.env.PROGRAPH_BENCH_KEEP === '1') process.stderr.write(`retained disposable benchmark corpus: ${root}\n`);
  else await rm(root,{ recursive:true,force:true });
}
