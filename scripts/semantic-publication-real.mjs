// Historical native semantic corpus migration/republication; original source/index remains untouched.
import Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SemanticStore } from '../dist/core/semantic/store.js';
import { SemanticQuery } from '../dist/core/semantic/query.js';
import { canonical, digest } from '../dist/core/semantic/model.js';
const [source,output]=process.argv.slice(2);const checksum=async file=>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');};
const sourceHash=await checksum(source);const root=await mkdtemp(path.join(os.tmpdir(),'prograph-publication-real-'));const filename=path.join(root,'semantic.sqlite');
const original=new Database(source,{readonly:true});await original.backup(filename);original.close();
const report={source,sourceHash,startedAt:new Date().toISOString(),node:process.version,methodology:'Online backup of a historical real-repository semantic index. Original bytes unchanged; this qualifies migration and native-query equivalence, not freshness against current source/compiler inputs. Sample item/coverage digests and full visible-claim/call-aggregate sets checked across old schema, upgraded retained snapshot and first epoch publication. Publication timings include all eligibility/navigation/call construction and FULL commit; setup and integrity outside timings. No compiler process.'};
function samples(q){const results={};for(const name of ['SemanticStore','analyzeRepository','SemanticQuery']){const found=q.execute('find',name,{limit:5});results[`find:${name}`]=digest(canonical([found.items,found.coverage]));for(const symbol of found.items.slice(0,2))for(const operation of ['definition','references','callers','callees','native','relationships','context']){const result=q.execute(operation,symbol.key,{limit:5});results[`${operation}:${symbol.key}`]=digest(canonical([result.items,result.coverage]));}}return results;}
try{
  const before=new SemanticQuery(filename);report.beforeSchema=before.execute('status').schema;const baseline=before.execute('status').snapshot;report.before=samples(before);before.close();
  let stages={};const store=new SemanticStore(filename,{measure(stage,ms){stages[stage]=+ms.toFixed(3);}});
  try{
    const retained=new SemanticQuery(filename);try{report.retained=samples(retained);}finally{retained.close();}
    const runs=store.db.prepare('SELECT run FROM sc_partitions WHERE snapshot=? ORDER BY run').all(baseline).map(x=>x.run);
    const start=performance.now();const snapshot=store.publish(runs);report.publicationMs=+(performance.now()-start).toFixed(3);report.stages=stages;report.partitions=runs.length;
    const after=new SemanticQuery(filename);try{report.afterSchema=after.execute('status').schema;report.after=samples(after);}finally{after.close();}
    if(canonical(report.before)!==canonical(report.retained)||canonical(report.before)!==canonical(report.after))throw Error('Sample semantic navigation/coverage mismatch');
    for(const table of ['sc_active','sc_calls'])for(const [a,b]of [[baseline,snapshot],[snapshot,baseline]]){
      const columns=table==='sc_active'?'claim':'caller,callee,site_count,confidence,sample_claim';
      if(store.db.prepare(`SELECT 1 FROM (SELECT ${columns} FROM ${table} WHERE snapshot=? EXCEPT SELECT ${columns} FROM ${table} WHERE snapshot=?) LIMIT 1`).get(a,b))throw Error(`Full ${table} oracle mismatch`);
    }
    report.fullOracle={visibleClaims:true,callAggregates:true};report.counts=Object.fromEntries(['entities','occurrences','facts','claims','claim_navigation'].map(table=>[table,store.db.prepare(`SELECT COUNT(*) n FROM sc_${table}`).get().n]));
    report.integrity=store.db.pragma('integrity_check',{simple:true});report.foreignKeyViolations=store.db.pragma('foreign_key_check');if(report.integrity!=='ok'||report.foreignKeyViolations.length)throw Error('Database integrity failure');
    if(await checksum(source)!==sourceHash)throw Error('Original source index changed');report.maxRssKiB=process.resourceUsage().maxRSS;
    report.implementationDigests=Object.fromEntries(await Promise.all(['publication','store','schema','read','query','model'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/semantic/${name}.js`,import.meta.url)))])));
    await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({publicationMs:report.publicationMs,stages:report.stages,fullOracle:report.fullOracle,integrity:report.integrity,sampleCount:Object.keys(report.before).length}));
  }finally{store.close();}
}finally{await rm(root,{recursive:true,force:true});}
