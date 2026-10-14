// Synthetic wire ingestion, separate generator and importer processes so importer RSS is honest.
// Run after build: node scripts/scip-benchmark.mjs 100000 /tmp/report.json
import { mkdtemp, mkdir, writeFile, readFile, rm, open, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import Database from 'better-sqlite3';
import { scipType } from '../dist/core/semantic/scip-wire.js';
import { importScip } from '../dist/core/semantic/scip-import.js';
import { SemanticQuery } from '../dist/core/semantic/query.js';
import { digest } from '../dist/core/semantic/model.js';

if (process.argv[2] === '--import') {
  const root = process.argv[3]; const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const result = await importScip(root, path.join(root, 'index.scip'), manifest);
  const filename = path.join(root, '.prograph/semantic.sqlite'); const q = new SemanticQuery(filename);
  const target = q.execute('find', 'target').items[0].key;
  const samples = Array.from({ length: 30 }, () => { const start = performance.now(); const result = q.execute('references', target, { limit: 50 }); return { ms: performance.now() - start, result }; });
  const times = samples.map(x => x.ms).sort((a,b) => a-b);
  const integrity = q.db.pragma('integrity_check', { simple: true }); q.close();
  const db = new Database(filename); const counts = Object.fromEntries(['occurrences','facts','claims','navigation','provenance','calls'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM sc_${table}`).get().n]));
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  const report = { ...result, counts, integrity, databaseBytes: (await stat(filename)).size, maxRssKiB: process.resourceUsage().maxRSS,
    query: { firstReadMs: +samples[0].ms.toFixed(3), warmP95Ms: +times[28].toFixed(3), bytes: Buffer.byteLength(JSON.stringify(samples[0].result)), work: samples[0].result.work }, callsCreated: counts.calls };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report));
} else {
  const count = Number(process.argv[2] ?? 100000); const output = process.argv[3];
  if (!Number.isSafeInteger(count) || count < 1000 || count > 10000000) throw Error('count must be 1,000..10,000,000');
  const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-scip-bench-'));
  const startedAt = new Date().toISOString(); const sources = {}; const symbol = 'scip-python python synthetic 1 fixture/target().';
  const hash = createHash('sha256'); const wire = (id,type,value) => { const message = scipType(type).encode(scipType(type).fromObject(value)).finish(); return Buffer.from(protobuf.Writer.create().uint32(id << 3 | 2).bytes(message).finish()); };
  try {
    await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname="synthetic"\nversion="1"\n');
    const handle = await open(path.join(root, 'index.scip'), 'w'); let documents = 0;
    try {
      const metadata = wire(1,'Metadata',{ version:0, tool_info:{name:'synthetic-scip',version:'1'},project_root:new URL(`file://${root}/`).href,text_document_encoding:1 }); hash.update(metadata); await handle.write(metadata);
      for (let offset = 0; offset < count; offset += 100000) {
        const size = Math.min(100000,count-offset); const file = `src/doc-${documents++}.py`; const text = 'target()\n'.repeat(size); await writeFile(path.join(root,file),text); sources[file] = digest(text);
        const occurrences = Array.from({length:size},(_,line)=>({symbol,range:[line,0,6],symbol_roles:line===0 ? 1:8,syntax_kind:15}));
        const bytes = wire(2,'Document',{relative_path:file,language:'Python',position_encoding:2,symbols:[{symbol,display_name:'target',kind:17}],occurrences}); hash.update(bytes); await handle.write(bytes);
      }
    } finally { await handle.close(); }
    const artifactBytes = (await stat(path.join(root,'index.scip'))).size;
    await writeFile(path.join(root,'manifest.json'),JSON.stringify({format:1,id:'synthetic',sourceRoot:root,projectContext:'benchmark',indexDigest:hash.digest('hex'),sources,provider:{name:'synthetic-scip',version:'1',basis:'compiler'}}));
    await new Promise((resolve,reject)=> { const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--import',root],{stdio:'inherit'}); child.on('error',reject); child.on('close',code=>code===0?resolve():reject(Error(`Importer exited ${code}`))); });
    const report = { workload:'synthetic streamed SCIP, 100k occurrences/document, one symbol, unique line anchors, definition + references/highlighting; no compiler or LOC qualification', count, documents, artifactBytes, startedAt,
      environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
      implementationDigests:Object.fromEntries(await Promise.all(['scip-import','scip-wire','store','schema','query','coordinates','inputs'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/semantic/${name}.js`,import.meta.url)))]))),
      ...JSON.parse(await readFile(path.join(root,'result.json'),'utf8')) };
    if (output) await writeFile(output,`${JSON.stringify(report,null,2)}\n`); process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
  } finally { if(process.env.PROGRAPH_BENCH_KEEP==='1') process.stderr.write(`retained disposable corpus: ${root}\n`); else await rm(root,{recursive:true,force:true}); }
}
