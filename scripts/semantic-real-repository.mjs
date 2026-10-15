// Read-only source analysis; require a custom output outside the source repository.
// node scripts/semantic-real-repository.mjs /path/to/repo /tmp/custom-index /tmp/report.json
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { analyzeRepository } from '../dist/core/analysis/analyze.js';
import { scanRepository } from '../dist/core/repository/repository.js';
import { discoverProjects } from '../dist/core/semantic/projects.js';
import { SemanticStore } from '../dist/core/semantic/store.js';
import { SemanticQuery } from '../dist/core/semantic/query.js';
import { digest } from '../dist/core/semantic/model.js';

const repository = path.resolve(process.argv[2] ?? '.'); const output = path.resolve(process.argv[3]); const reportPath = process.argv[4];
if (output === repository || output.startsWith(`${repository}${path.sep}`)) throw Error('Use an external custom index directory');
const timers = new Map(); const timings = [];
const begin = SemanticStore.prototype.begin; const seal = SemanticStore.prototype.seal;
SemanticStore.prototype.begin = function(...args) { const run = begin.apply(this,args); timers.set(run,{ partition:args[0],start:performance.now() }); process.stderr.write(`semantic staging: ${args[0]}\n`); return run; };
SemanticStore.prototype.seal = function(...args) { const result = seal.apply(this,args); const timer = timers.get(args[0]); if(timer) { const ms=+(performance.now()-timer.start).toFixed(3); timings.push({partition:timer.partition,stageAndSealMs:ms}); process.stderr.write(`sealed ${timer.partition}: ${ms}ms\n`); } return result; };
const startedAt = new Date().toISOString(); const start = performance.now();
const result = await analyzeRepository(repository,{output});
const elapsedMs = Math.round(performance.now()-start);
const scan = await scanRepository(repository, output); const plan = discoverProjects(scan.snapshot);
const sources = [...scan.snapshot.fileContents].filter(([file])=>/\.(?:[cm]?tsx?|jsx?|rs|py|java|c|h|cpp|cc|cxx|go|cs)$/.test(file));
const units = plan.units.map(unit=>({key:unit.key,language:unit.language,context:unit.context,sources:unit.sources.length,gaps:unit.gaps}));
const query = new SemanticQuery(path.join(output,'semantic.sqlite'),path.join(output,'manifest.json')); const queries = [];
try {
  for(const name of (process.argv[5]?.split(',') ?? ['SemanticStore','indexClang','invoke'])) {
    const qstart=performance.now(); const found=query.execute('find',name,{limit:5}); const key=found.items[0]?.key;
    const definitions=key?query.execute('definition',key,{limit:5}):null;
    const references=key?query.execute('references',key,{limit:5}):null;
    queries.push({name,ms:+(performance.now()-qstart).toFixed(3),symbols:found.items.length,definitions:definitions?.items.length??0,references:references?.items.length??0,work:references?.work??found.work});
  }
  const counts=Object.fromEntries(['occurrences','facts','claims','navigation','calls'].map(table=>[table,query.db.prepare(`SELECT COUNT(*) AS n FROM sc_${table}`).get().n]));
  const report={repository:scan.snapshot.repository,startedAt,elapsedMs,sourceFiles:sources.length,sourceLines:sources.reduce((n,[,text])=>n+text.split('\n').length,0),sourceInventoryDigest:digest(JSON.stringify(sources.map(([file,text])=>[file,digest(text)]).sort())),
    legacy:{schema:result.graph.schemaVersion,nodes:result.graph.nodes.length,edges:result.graph.edges.length,diagnostics:result.graph.diagnostics.length},semantic:result.manifest.semanticCore,unitTimings:timings,units,counts,queries,
    integrity:query.db.pragma('integrity_check',{simple:true}),databaseBytes:(await stat(path.join(output,'semantic.sqlite'))).size,maxRssKiB:process.resourceUsage().maxRSS,
    implementationDigests:Object.fromEntries(await Promise.all(['typescript','projects','passes','analysis-passes','boundary-pass','owned-projection','provider-runs','store','schema'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/semantic/${name}.js`,import.meta.url)))]))) };
  if(reportPath) await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`); process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { query.close(); }
