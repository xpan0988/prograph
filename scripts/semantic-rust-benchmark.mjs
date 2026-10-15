// Explicit compiler/provider qualification; fresh external output keeps corpus untouched.
// node scripts/semantic-rust-benchmark.mjs REPO MANIFEST OUT ANALYZER SHA TOOLCHAIN REPORT [NAME]
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { indexRust } from '../dist/core/semantic/rust.js';
import { SemanticQuery } from '../dist/core/semantic/query.js';
import { scanRepository } from '../dist/core/repository/repository.js';
import { digest, canonical } from '../dist/core/semantic/model.js';

const [repo, manifest, out, analyzer, analyzerSha256, toolchain, reportPath, name = 'target'] = process.argv.slice(2);
const root = path.resolve(repo); const output = path.resolve(out);
if (output === root || output.startsWith(`${root}${path.sep}`)) throw Error('Use a fresh external output directory');
try { await access(path.join(output,'semantic.sqlite')); throw Error('Existing output changes benchmark history; use a fresh directory'); } catch(error) { if(error.code !== 'ENOENT') throw error; }
const scan = await scanRepository(root, output);
const inputs = [...scan.snapshot.fileContents].filter(([file]) => /\.rs$|(?:^|\/)Cargo\.(?:toml|lock)$|(?:^|\/)rust-toolchain(?:\.toml)?$/.test(file)).sort(([a],[b])=>a.localeCompare(b));
const inventory = () => digest(canonical(inputs.map(([file,text])=>[file,digest(text)])));
const sourceInventoryDigest = inventory(); const startedAt = new Date().toISOString(); const started = performance.now();
let result; let failure; try { result = await indexRust(root, manifest, { analyzer, analyzerSha256, toolchain }, output); } catch(error) { failure = String(error); }
const elapsedMs = +(performance.now()-started).toFixed(3);
const unchanged = (await Promise.all(inputs.map(async ([file,text])=>digest(await readFile(path.join(root,file)))===digest(text)))).every(Boolean);
let database = null;
if(result) {
  const q = new SemanticQuery(path.join(output,'semantic.sqlite'));
  try {
    const counts = Object.fromEntries(['occurrences','facts','claims','navigation','calls'].map(table=>[table,q.db.prepare(`SELECT COUNT(*) AS n FROM sc_${table}`).get().n]));
    const find=q.execute('find',name,{limit:5}); const key=find.items[0]?.key; const latencies=[];
    for(let i=0;i<25;i++) { const t=performance.now(); if(key) q.execute('references',key,{limit:20}); latencies.push(performance.now()-t); }
    latencies.sort((a,b)=>a-b);
    database={counts,bytes:(await stat(path.join(output,'semantic.sqlite'))).size,integrity:q.db.pragma('integrity_check',{simple:true}),query:{name,matched:find.items.length,definitions:key?q.execute('definition',key,{limit:5}).items.length:0,references:key?q.execute('references',key,{limit:20}).items.length:0,warmReferencesP95Ms:+latencies[Math.floor(latencies.length*.95)].toFixed(3)}};
  } finally { q.close(); }
}
const report={startedAt,repository:scan.snapshot.repository,manifest,sourceFiles:inputs.filter(([f])=>f.endsWith('.rs')).length,sourceLines:inputs.filter(([f])=>f.endsWith('.rs')).reduce((n,[,s])=>n+s.split('\n').length,0),sourceInventoryDigest,sourceUnchanged:unchanged,elapsedMs,result:result??null,failure:failure??null,database,
  runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,parentMaxRssKiB:process.resourceUsage().maxRSS,memoryScope:'Node process only; excludes Cargo/rust-analyzer child peak RSS'},
  implementationDigests:Object.fromEntries(await Promise.all(['rust','process','scip-import','provider-runs','store'].map(async file=>[file,digest(await readFile(new URL(`../dist/core/semantic/${file}.js`,import.meta.url)))])))};
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify({report:reportPath,elapsedMs,occurrences:database?.counts.occurrences??null,failure,sourceUnchanged:unchanged}));
if(!unchanged) throw Error('Source corpus changed during qualification');
