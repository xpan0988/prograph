// Historical graph equivalence and process-separated timings; no source/compiler execution.
// node scripts/global-query-benchmark.mjs /tmp/report.json /path/to/historical/graph.sqlite
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { canonical, digest } from '../dist/core/semantic/model.js';
const CASES=[['overview',[]],['overview',[{scope:'full'}]],['files',[]],['architecture',[30]],['architecture',[30,{scope:'code+docs'}]],['cycles',[]],['context',['semantic command configuration']],['frameworkBindings',['tauri']],['searchSymbols',['invoke',20]]];
const revision='500135351e296255caa7914d4be925ca55f6c3ee';
async function fileDigest(filename){const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');}
const normalize=value=>JSON.parse(JSON.stringify(value));
function boundedArchitecture(value){value=normalize(value);for(const node of value.nodes){const symbols=node.metadata?.containedSymbols;if(symbols?.length>64){node.metadata.containedSymbols=symbols.slice(0,64);node.metadata.containedSymbolsTruncated=true;value.truncated=true;}}if(value.edges.length>1000){value.edges=value.edges.slice(0,1000);value.truncated=true;}return value;}
if(process.argv[2]==='--prepare'){
  const {prepareQueryIndex}=await import('../dist/core/analysis/prepare-queries.js');const prepared=prepareQueryIndex(process.argv[3]);
  console.log(JSON.stringify({...prepared,maxRssKiB:process.resourceUsage().maxRSS}));
 }else if(process.argv[2]==='--files-oracle'){
  const [filename,module]=process.argv.slice(3);const baseline=await import(module);const q=new baseline.QueryService(filename);
  try{const all=q.allNodes();const nodes=baseline.scopedNodes(all);const edges=baseline.scopedEdges(q.allEdges(),all);const byId=new Map(nodes.map(n=>[n.id,n]));
    const counts=new Map();const entry=file=>{let x=counts.get(file);if(!x){x={nodeCount:0,outgoingCount:0,incomingCount:0};counts.set(file,x);}return x;};
    for(const node of nodes)if(node.file)entry(node.file).nodeCount++;
    for(const edge of edges){const a=byId.get(edge.source)?.file,b=byId.get(edge.target)?.file;if(a)entry(a).outgoingCount++;if(b)entry(b).incomingCount++;}
    const files=nodes.filter(n=>n.kind==='file'&&n.file).sort((a,b)=>a.file.localeCompare(b.file)).map(n=>({path:n.file,language:n.language,...entry(n.file)}));
    console.log(JSON.stringify({comparisonDigest:digest(canonical(normalize(files))),methodology:'Frozen legacy scope/confidence predicates and immutable source rows, with repeated ID lookups replaced by a unique-ID map solely for the independent equivalence oracle. Not a timed execution of the former files method.'}));
  }finally{q.close();}
}else if(process.argv[2]==='--query'){
  const [filename,module,role,selected]=process.argv.slice(3);const {QueryService}=await import(module);const q=new QueryService(filename);const results={};
  const cases=selected===undefined?CASES:[CASES[Number(selected)]];
  try{for(const [method,args] of cases){const name=method+JSON.stringify(args);const timings=[];let value,error;
    for(let i=0;i<5;i++){const start=performance.now();try{value=q[method](...args);}catch(caught){error=String(caught);break;}timings.push(+(performance.now()-start).toFixed(3));}
    const normalized=value===undefined?undefined:normalize(value);const compared=method==='architecture'&&role==='before'?boundedArchitecture(normalized):normalized;
    results[name]={timingsMs:timings,...(error?{error}:{rawDigest:digest(canonical(normalized)),comparisonDigest:digest(canonical(compared)),bytes:Buffer.byteLength(JSON.stringify(value))})};
  }
  const {executeRead}=await import('../dist/core/query/isolation.js');const isolated=[];
  if(role==='after'&&(selected===undefined||selected==='0'))for(let i=0;i<10;i++){const start=performance.now();await executeRead(filename,'legacy','overview',[]);isolated.push(+(performance.now()-start).toFixed(3));}
  console.log(JSON.stringify({results,isolatedOverviewMs:isolated,maxRssKiB:process.resourceUsage().maxRSS,node:process.version}));
  }finally{q.close();}
}else{
  const startedAt=new Date().toISOString();const output=process.argv[2],source=path.resolve(process.argv[3]);const root=await mkdtemp(path.join(os.tmpdir(),'prograph-global-bench-'));const replica=path.join(root,'graph.sqlite');
  const baseline=new URL('../dist/core/query/global-benchmark-baseline.js',import.meta.url);
  const sourceDigest=await fileDigest(source);const original=new Database(source,{readonly:true,fileMustExist:true});
  const corpus={source,sourceDigest,counts:original.prepare('SELECT (SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM edges) edges').get(),repository:original.prepare('SELECT * FROM repository_metadata').all()};
  await original.backup(replica);original.close();
  const code=execFileSync('git',['show',`${revision}:src/core/query/query-service.ts`],{encoding:'utf8'});
  await writeFile(baseline,ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  const child=(timeout,...args)=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),...args],{encoding:'utf8',timeout,maxBuffer:1048576}));
  const queryCases=(module,role)=>{const output={results:{},isolatedOverviewMs:[],maxRssKiB:0,node:process.version};for(let i=0;i<CASES.length;i++){
    const name=CASES[i][0]+JSON.stringify(CASES[i][1]);process.stderr.write(`${role}: ${name}\n`);
    try{const result=child(60000,'--query',replica,module,role,String(i));output.results[name]={...result.results[name],maxRssKiB:result.maxRssKiB};output.isolatedOverviewMs.push(...result.isolatedOverviewMs);output.maxRssKiB=Math.max(output.maxRssKiB,result.maxRssKiB);}
    catch(error){output.results[name]={error:error.code==='ETIMEDOUT'?'Process exceeded 60000ms including startup':String(error),timingsMs:[],comparisonDigest:null};}
  }return output;};
  try{
    const preparation=child(300000,'--prepare',replica);const before=queryCases(baseline.href,'before');const after=queryCases(new URL('../dist/core/query/query-service.js',import.meta.url).href,'after');const filesOracle=child(60000,'--files-oracle',replica,baseline.href);
    const equivalence=Object.fromEntries(Object.keys(before.results).map(name=>[name,{same:(name==='files[]'&&before.results[name].error?filesOracle.comparisonDigest:before.results[name].comparisonDigest)===after.results[name].comparisonDigest&&!!after.results[name].comparisonDigest,oracle:name==='files[]'&&before.results[name].error?'independent-frozen-predicate-files-oracle':'executed-frozen-method',beforeError:before.results[name].error??null,afterError:after.results[name].error??null}]));
    const db=new Database(replica,{readonly:true});const integrity=db.pragma('integrity_check',{simple:true});db.close();
    if(await fileDigest(source)!==sourceDigest)throw Error('Historical source index changed');
    const report={baselineRevision:revision,startedAt,corpus,preparation,before,after,filesOracle,equivalence,integrity,
      methodology:'SQLite online backup of an existing historical graph; original bytes checked unchanged. Explicit offline projection preparation precedes process-separated baseline/current reads. Each method runs in its own process, attempting five serial core samples under a 60s process deadline; timeouts are retained without a latency or output hash. Maximum RSS covers completed method processes only; timed-out process RSS is unavailable. Ten current isolated overview samples include process startup. A separate frozen-predicate/unique-ID-map file oracle checks real file-statistic equivalence when the original method times out; its output is never used as the former method latency. OS page cache is not evicted. Architecture comparison applies only the declared 64-symbol/1000-edge output caps to the baseline; raw and compared hashes are both retained. No LOC/provider/physical-power-loss qualification.',
      implementationDigests:Object.fromEntries(await Promise.all(['query-service','global-read','global-projections','file-architecture','navigation','isolation'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/query/${name}.js`,import.meta.url)))])))};
    await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({equivalence,preparation,integrity}));
  }finally{await rm(baseline,{force:true});await rm(root,{recursive:true,force:true});}
}
