// Compare exact baseline implementation in separate processes, excluding corpus generation RSS.
// node scripts/legacy-navigation-benchmark.mjs /tmp/report.json [unrelated-edge-count=1000000] [existing graph.sqlite] [symbol name]
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { digest } from '../dist/core/semantic/model.js';
const baselineRevision='98a523b';
if(process.argv[2]==='--child') {
  const [,, ,filename,moduleFile,id='symbol:center']=process.argv;
  const {QueryService}=await import(moduleFile);const q=new QueryService(filename);const timings={};const results={};
  try {
    for(const [name,args] of [['callers',[id,50]],['callees',[id,50]],['neighborhood',[id,{depth:2,maxNodes:50}]],['affected',[id,{depth:3,maxNodes:50}]]]) {
      const samples=[];let result;
      for(let i=0;i<5;i++){const start=performance.now();result=q[name](...args);samples.push(+(performance.now()-start).toFixed(3));}
      timings[name]=samples;results[name]=digest(JSON.stringify(result));
    }
    const {isolatedQueryForRepository}=await import('../dist/core/query/isolation.js');
    const client=await isolatedQueryForRepository(path.dirname(filename),filename);const workerSamples=[];
    for(let i=0;i<5;i++){const t=performance.now();await client.callers(id,50);workerSamples.push(+(performance.now()-t).toFixed(3));}
    console.log(JSON.stringify({timings,resultDigests:results,isolatedCallersMs:workerSamples,maxRssKiB:process.resourceUsage().maxRSS,node:process.version}));
  }finally{q.close();}
} else {
  const startedAt=new Date().toISOString();
  const directory=await mkdtemp(path.join(os.tmpdir(),'prograph-nav-benchmark-'));const existing=process.argv[4];const filename=existing?path.resolve(existing):path.join(directory,'graph.sqlite');const n=Number(process.argv[3]??1000000);
  if(!Number.isSafeInteger(n)||n<0||n>2000000)throw Error('Invalid synthetic edge count');
  const baselineSource=execFileSync('git',['show',`${baselineRevision}:src/core/query/query-service.ts`],{encoding:'utf8'});
  const baselineFile=new URL('../dist/core/query/query-baseline-benchmark.js',import.meta.url);
  await writeFile(baselineFile,ts.transpileModule(baselineSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  try {
    const db=new Database(filename,{readonly:!!existing,fileMustExist:!!existing});
    if(!existing) { db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,language TEXT,file TEXT,start_line INTEGER,start_column INTEGER,end_line INTEGER,end_column INTEGER,adapter TEXT,metadata_json TEXT);CREATE INDEX idx_nodes_file ON nodes(file);CREATE TABLE edges(id TEXT PRIMARY KEY,source TEXT,target TEXT,kind TEXT,confidence TEXT,evidence_json TEXT,metadata_json TEXT);CREATE INDEX idx_edges_source ON edges(source);CREATE INDEX idx_edges_target ON edges(target)");
    db.transaction(()=>{
      const node=db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');const edge=db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?)');
      node.run('symbol:center','function','center','center',null,'src/center.ts',1,null,null,null,'synthetic','{}');
      for(let i=0;i<50000;i++)node.run(`symbol:${i}`,'function',`fn${i}`,`fn${i}`,null,`src/${i}.ts`,1,null,null,null,'synthetic','{}');
      for(let i=0;i<40;i++){edge.run(`in${i}`,`symbol:${i}`,'symbol:center','calls','resolved','[]','{}');edge.run(`out${i}`,'symbol:center',`symbol:${i}`,'calls','resolved','[]','{}');}
      for(let i=0;i<n;i++)edge.run(`noise${i}`,`symbol:${100+i%49900}`,`symbol:${100+(i*13)%49900}`,'calls','resolved','[]','{}');
    })(); }
    const selected=existing?db.prepare("SELECT id,name,file FROM nodes WHERE name=? AND kind IN ('function','method') ORDER BY id LIMIT 1").get(process.argv[5]):{id:'symbol:center',name:'center'};
    if(!selected)throw Error('Choose an indexed real symbol name');
    const corpus=existing?{database:filename,selected,counts:db.prepare('SELECT (SELECT count(*) FROM nodes) nodes,(SELECT count(*) FROM edges) edges').get(),repository:db.prepare('SELECT * FROM repository_metadata').all()}:null;
    const integrity=db.pragma('integrity_check',{simple:true});db.close();
    const measure=moduleFile=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--child',filename,moduleFile,selected.id],{encoding:'utf8',timeout:180000,maxBuffer:1024*1024}));
    const before=measure(baselineFile.href);const after=measure(new URL('../dist/core/query/query-service.js',import.meta.url).href);
    if(JSON.stringify(before.resultDigests)!==JSON.stringify(after.resultDigests))throw Error('Baseline/result mismatch');
    const report={startedAt,baselineRevision,synthetic:existing?null:{nodes:50001,edges:n+80,unrelatedEdges:n,notLinesOfCode:true},corpus,methodology:'Five serial same-process reads per method in separate baseline/current Node processes; first sample is first-process read, later samples warm; OS page cache not evicted; generator memory excluded. Isolated samples use current runtime in both processes and include process startup. Results hashed in full before comparison. Existing real indices are historical snapshots; no source freshness qualification is implied.',before,after,integrity,environment:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model},implementationDigests:Object.fromEntries(await Promise.all(['query-service','navigation','isolation','query-worker'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/query/${name}.js`,import.meta.url)))])))};
    await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{await rm(baselineFile,{force:true});await rm(directory,{recursive:true,force:true});}
}
