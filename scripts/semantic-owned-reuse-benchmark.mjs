// Build first. Uses a disposable Java checkout; appended source revision is restored in finally.
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {indexManagedProject} from '../dist/core/semantic/managed-scip.js';
import {SemanticStore} from '../dist/core/semantic/store.js';
import {digest} from '../dist/core/semantic/model.js';
const [repository,configuration,relativeFile,output]=process.argv.slice(2);
if(!repository || !configuration || !relativeFile || !output)throw Error('Usage: node scripts/semantic-owned-reuse-benchmark.mjs <disposable-java-repository> <configuration> <relative-java-file> <receipt.json>');
if(path.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/).includes('..') || !relativeFile.endsWith('.java'))throw Error('A Java source inside the disposable checkout is required');
const index=await mkdtemp(path.join(os.tmpdir(),'prograph-stage5-jsoup-'));
const file=path.join(repository,relativeFile),before=await readFile(file);
const partitionMap=()=>{const s=new SemanticStore(path.join(index,'semantic.sqlite'));try{return new Map(s.sql('SELECT partition_key,run FROM sc_partitions WHERE snapshot=?').all(s.activeSnapshot()).map(r=>[r.partition_key,r.run]));}finally{s.close()}};
const results=[];let previous=new Map();
try{
 for(const label of ['first','unchanged','one-source-revision']){
  if(label==='one-source-revision')await writeFile(file,Buffer.concat([before,Buffer.from('\n// Semantic Core owned-publication validation.\n')]));
  const result=await indexManagedProject(repository,configuration,index); const current=partitionMap();
  results.push({label,...result,partitionCount:current.size,reusedPartitions:[...current].filter(([k,v])=>previous.get(k)===v).length,changedPartitions:[...current].filter(([k,v])=>previous.get(k)!==v).map(([k])=>k)});previous=current;
 }
}finally{await writeFile(file,before)}
const s=new SemanticStore(path.join(index,'semantic.sqlite'));const checks={integrity:s.db.pragma('integrity_check',{simple:true}),foreignKeys:s.db.pragma('foreign_key_check'),snapshots:s.sql('SELECT COUNT(*) AS n FROM sc_snapshots').get().n};s.close();
const evidence={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,repository,configuration,relativeFile,index,sourceRestored:digest(await readFile(file))===digest(before),scope:'real managed Java producer; see environment receipts for SDK, producer and release; one serial trial per shape (new database then warm repeats), includes producer/source/SDK verification and all publication projections; no child RSS measurement',results,checks,nodePeakRssKiB:process.resourceUsage().maxRSS};
await writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({...evidence,results:results.map(r=>({label:r.label,accepted:r.accepted,reusedDocuments:r.reusedDocuments,partitionCount:r.partitionCount,reusedPartitions:r.reusedPartitions,changedPartitions:r.changedPartitions.length,totalMs:r.totalMs,publicationMs:r.publicationMs,publicationStagesMs:r.publicationStagesMs}))}));
