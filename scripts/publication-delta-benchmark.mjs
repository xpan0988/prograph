// Storage-only replacement benchmark over actual validated SCIP facts. No provider/LOC qualification.
// node scripts/publication-delta-benchmark.mjs /retained/scip/semantic.sqlite /tmp/delta.json
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { prepareAuthorityMigration } from '../dist/core/semantic/authority-migration.js';
import { SemanticStore } from '../dist/core/semantic/store.js';
import { digest } from '../dist/core/semantic/model.js';
import { SEMANTIC_SQL } from '../dist/core/semantic/schema.js';
async function checksum(file) { const h=createHash('sha256'); for await(const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
const [input, output]=process.argv.slice(2); const originalHash=await checksum(input);
const root=await mkdtemp(path.join(os.tmpdir(),'prograph-publication-delta-')); const filename=path.join(root,'semantic.sqlite');
const original=new Database(input,{readonly:true}); await original.backup(filename); original.close();
const report={startedAt:new Date().toISOString(),source:{filename:input,sha256:originalHash},environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
  methodology:'Online backup of validated SCIP facts. Setup deterministically reshards existing immutable claims into <=2000-claim owners with identical context/fingerprint and copied physical inputs/selectors; no fact/support/provenance is altered. This is a storage workload, not a claim that the original provider can reindex those shards. Original ownership and reshaped ownership both receive a complete first publication from empty projections with the current physical schema. Complete first publication and 3 serial replacements each of 1/10/100 full shards use the production publisher, WAL/FULL, all indexes, support checks and commit. Replacements validate every fact through addFact under a changed synthetic input fingerprint; staging/seal time is reported separately. No pointer-only timing, cache eviction or compiler/LOC claim. Full ownership EXCEPT oracles and pinned history are checked outside timing. High-fanout supports use synthetic derived dependency facts and alternate proofs. Source bytes remain unchanged. Required storage migration/rollback preparation is separately recorded before timing, as schema initialization previously was; no required publication work is excluded.'};
const migrationStarted=performance.now();await prepareAuthorityMigration(root,{storageOnly:true});report.storageMigrationMs=+(performance.now()-migrationStarted).toFixed(3);
let stages={};const store=new SemanticStore(filename,{measure(stage,ms){stages[stage]=+ms.toFixed(3);}});
const publish=runs=>{stages={};const start=performance.now();const snapshot=store.publish(runs);return {snapshot,totalMs:+(performance.now()-start).toFixed(3),stages:{...stages},pending:store.db.prepare('SELECT COUNT(*) n FROM sc_pending').get().n,eligible:store.db.prepare('SELECT COUNT(*) n FROM sc_eligible').get().n};};
const liveCount=snapshot=>store.db.prepare('SELECT COUNT(*) n FROM sc_active WHERE snapshot=?').get(snapshot).n;
const copyInputs=(from,to)=>{store.db.prepare('INSERT INTO sc_inputs SELECT ?,resource,digest FROM sc_inputs WHERE run=?').run(to,from);store.db.prepare('INSERT INTO sc_run_selectors SELECT ?,key,digest FROM sc_run_selectors WHERE run=?').run(to,from);};
const reset=()=>store.db.transaction(()=>{store.db.exec("DELETE FROM sc_meta WHERE key='active'; UPDATE sc_snapshots SET parent=NULL; DELETE FROM sc_snapshots; DELETE FROM sc_visibility; DROP TABLE sc_call_epochs; DROP TABLE sc_claim_navigation;");store.db.exec(SEMANTIC_SQL);})();
try {
  report.pragmas=Object.fromEntries(['journal_mode','synchronous','foreign_keys','wal_autocheckpoint','cache_size'].map(key=>[key,store.db.pragma(key,{simple:true})]));
  if(store.db.prepare('SELECT 1 FROM sc_selector_gates LIMIT 1').get())throw Error('Raw base-fact fixture required: reshaping must not omit selector admission qualifiers');
  const parent=store.activeSnapshot();const sources=store.db.prepare('SELECT r.* FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? ORDER BY r.id').all(parent);
  if(store.db.prepare('SELECT 1 FROM sc_partitions p JOIN sc_owned o ON o.run=p.run JOIN sc_claims c ON c.id=o.claim WHERE p.snapshot=? AND c.support_group IS NOT NULL LIMIT 1').get(parent))throw Error('Baseline must contain only base SCIP observations; supported output has its separate fanout workload');
  reset();report.originalOwnershipFirst=publish(sources.map(source=>source.id));report.originalOwnershipPartitions=sources.length;
  const selected=[];const templates=[];let count=0; const setup=performance.now();
  for(const source of sources){let after=0;while(true){const claims=store.db.prepare('SELECT claim FROM sc_owned WHERE run=? AND claim>? ORDER BY claim LIMIT 2000').all(source.id,after);if(!claims.length)break;
    const partition=`benchmark/shard:${count++}`;const run=store.begin(partition,source.context,source.input_fingerprint);const end=claims.at(-1).claim;
    store.batch(run,()=>{copyInputs(source.id,run);store.db.prepare('INSERT INTO sc_owned SELECT ?,claim FROM sc_owned WHERE run=? AND claim>? AND claim<=?').run(run,source.id,after,end);});
    store.seal(run,{status:'partial',provider:'benchmark/repartitioned-existing',gaps:['Storage shape; original provider unit reindexability is unqualified']});
    selected.push(run);templates.push({run,partition,context:source.context,fingerprint:source.input_fingerprint,claims:claims.length});after=end;
  }}
  // Disposable copy only: benchmark the first publication without accidentally timing a warm reuse.
  reset();
  report.setupMs=+(performance.now()-setup).toFixed(3);report.partitions=selected.length;report.occurrences=store.db.prepare('SELECT COUNT(*) n FROM sc_occurrences').get().n;
  report.first=publish(selected);report.baselineClaims=liveCount(report.first.snapshot);report.noOp=publish(selected);
  const fixedCount=report.baselineClaims; const originalSnapshot=report.first.snapshot;
  const eligibleIndices=templates.flatMap((t,i)=>t.claims===2000?[i]:[]);
  report.replacements=[];
  for(const partitions of [1,10,100])for(let trial=0;trial<3;trial++){
    if(eligibleIndices.length<partitions)throw Error('Insufficient full shards for required replacement shape');
    const start=performance.now();let replacedClaims=0;
    for(const index of eligibleIndices.slice(0,partitions)){
      const template=templates[index];const fingerprint=digest(`replacement:${partitions}:${trial}:${index}`);const run=store.begin(template.partition,template.context,fingerprint);
      const rows=store.db.prepare(`SELECT f.*,e.key subject_key,o.key object_key,occ.key occurrence_key,c.confidence,p.json provenance FROM sc_owned owned JOIN sc_claims c ON c.id=owned.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject LEFT JOIN sc_entities o ON o.id=f.object LEFT JOIN sc_entities occ ON occ.id=f.occurrence JOIN sc_provenance p ON p.id=c.provenance WHERE owned.run=? ORDER BY owned.claim`).all(template.run);
      for(let offset=0;offset<rows.length;offset+=500)store.batch(run,()=>{for(const row of rows.slice(offset,offset+500))store.addFact(run,{predicate:row.predicate,context:template.context,subject:row.subject_key,...(row.object_key?{object:row.object_key}:{}),...(row.occurrence_key?{occurrence:row.occurrence_key}:{}),value:JSON.parse(row.value_json),confidence:row.confidence,provenance:{...JSON.parse(row.provenance),provider:'benchmark/reindexed',method:'synthetic-full-unit-replacement',inputFingerprint:fingerprint}});});
      store.batch(run,()=>{copyInputs(template.run,run);store.input(run,'benchmark/context-change',fingerprint);});store.seal(run,{status:'partial',provider:'benchmark/reindexed'});selected[index]=run;replacedClaims+=rows.length;
    }
    const stagingAndSealMs=+(performance.now()-start).toFixed(3);const measured=publish(selected);
    const missing=store.db.prepare('SELECT 1 FROM (SELECT o.claim FROM sc_partitions p JOIN sc_owned o ON o.run=p.run WHERE p.snapshot=? EXCEPT SELECT claim FROM sc_active WHERE snapshot=?) LIMIT 1').get(measured.snapshot,measured.snapshot);
    const extra=store.db.prepare('SELECT 1 FROM (SELECT claim FROM sc_active WHERE snapshot=? EXCEPT SELECT o.claim FROM sc_partitions p JOIN sc_owned o ON o.run=p.run WHERE p.snapshot=?) LIMIT 1').get(measured.snapshot,measured.snapshot);
    const expectedCount=store.db.prepare('SELECT COUNT(DISTINCT o.claim) n FROM sc_partitions p JOIN sc_owned o ON o.run=p.run WHERE p.snapshot=?').get(measured.snapshot).n;
    if(missing||extra||liveCount(measured.snapshot)!==expectedCount||liveCount(originalSnapshot)!==fixedCount)throw Error('Full ownership or historical oracle mismatch');
    report.replacements.push({partitions,trial,replacedClaims,expectedVisibleClaims:expectedCount,stagingAndSealMs,...measured,fullOwnershipOracle:true,historicalSnapshotRetained:true});process.stderr.write(`replaced ${partitions}, trial ${trial}: ${measured.totalMs}ms\n`);
  }
  const roots=eligibleIndices.slice(0,2).map(index=>store.db.prepare('SELECT c.key FROM sc_owned o JOIN sc_claims c ON c.id=o.claim WHERE o.run=? ORDER BY c.id LIMIT 1').get(selected[index]).key);
  const template=templates[eligibleIndices[0]];const provenance={provider:'benchmark/fanout',version:'1',basis:'inference',method:'synthetic-support',context:template.context,inputFingerprint:'fanout'};
  const pass=store.begin('benchmark/fanout-pass',template.context,'fanout');const subject=store.db.prepare('SELECT key FROM sc_entities WHERE kind=\'symbol\' LIMIT 1').get().key;
  for(let offset=0;offset<100000;offset+=500)store.batch(pass,()=>{for(let i=offset;i<offset+500;i++)store.addFact(pass,{predicate:'projection.Dependency',context:template.context,subject,confidence:'probable',value:{sample:i},provenance,supports:i%2?[[{claim:roots[0]}],[{claim:roots[1]}]]:[[{claim:roots[0]}]]});});
  store.seal(pass,{status:'partial',pass:'benchmark-fanout'});selected.push(pass);const fanoutFirst=publish(selected);
  const removed=selected.filter(id=>id!==selected[eligibleIndices[0]]);const fanoutDelete=publish(removed);const survivors=store.db.prepare('SELECT COUNT(*) n FROM sc_owned o JOIN sc_active a ON a.claim=o.claim AND a.snapshot=? WHERE o.run=?').get(fanoutDelete.snapshot,pass).n;
  if(survivors!==50000)throw Error('Alternate fanout support failed');
  const fanoutNone=publish(removed.filter(id=>id!==selected[eligibleIndices[1]]));const remaining=store.db.prepare('SELECT COUNT(*) n FROM sc_owned o JOIN sc_active a ON a.claim=o.claim AND a.snapshot=? WHERE o.run=?').get(fanoutNone.snapshot,pass).n;
  if(remaining!==0||liveCount(originalSnapshot)!==fixedCount)throw Error('Last fanout support/history failed');
  report.fanout={derived:100000,initial:fanoutFirst,oneSupportRemoved:fanoutDelete,alternativeSurvivors:survivors,lastSupportRemoved:fanoutNone,lastSupportSurvivors:remaining};
  report.integrity=store.db.pragma('integrity_check',{simple:true});if(report.integrity!=='ok')throw Error('Integrity failure');report.foreignKeyViolations=store.db.pragma('foreign_key_check');if(report.foreignKeyViolations.length)throw Error('Foreign key integrity failure');
  report.storageDefinition=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('sc_claim_navigation','sc_visibility','sc_call_epochs') ORDER BY name").all();store.db.pragma('wal_checkpoint(TRUNCATE)');store.close();report.databaseBytes=(await stat(filename)).size;report.maxRssKiB=process.resourceUsage().maxRSS;
  report.implementationDigests=Object.fromEntries(await Promise.all(['publication','store','schema','read','query','model'].map(async name=>[name,digest(await readFile(new URL(`../dist/core/semantic/${name}.js`,import.meta.url)))])));
  if(await checksum(input)!==originalHash)throw Error('Original source index changed');await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({first:report.first,noOp:report.noOp,replacements:report.replacements.map(r=>({partitions:r.partitions,ms:r.totalMs})),fanout:report.fanout,integrity:report.integrity}));
}finally{if(store.db.open)store.close();if(process.env.PROGRAPH_BENCH_KEEP==='1')process.stderr.write(`retained disposable delta corpus: ${root}\n`);else await rm(root,{recursive:true,force:true});}
