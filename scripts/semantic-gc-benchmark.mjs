// Build first. Measures 100k retained alternative-support proofs and final reachability sweep.
import {mkdtemp,writeFile,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {SemanticStore} from '../dist/core/semantic/store.js';
const root=await mkdtemp(path.join(os.tmpdir(),'prograph-stage5-gc-')); const store=new SemanticStore(path.join(root,'semantic.sqlite'));
const p=name=>({provider:name,version:'1',basis:'compiler',method:'benchmark',context:'ctx',inputFingerprint:name});
for(const key of ['caller','target']) store.addSymbol({key,name:key,qualifiedName:key,kind:'function',file:'a.ts',context:'ctx'});
store.addOccurrence({key:'occ',file:'a.ts',sourceDigest:'source',context:'ctx',startByte:0,endByte:1,line:1,column:1,endLine:1,endColumn:2,role:'call'},1);
const base=name=>{const id=store.begin(name,'ctx',name);const c=store.batch(id,()=>store.addFact(id,{predicate:'common.Reference',context:'ctx',subject:'caller',object:'target',occurrence:'occ',confidence:'resolved',provenance:p(name)}));store.input(id,'source:a.ts','source');store.seal(id,{status:'partial'});return{id,c}};
const a=base('a'),b=base('b');const derived=store.begin('derived','ctx','derived');
for(let at=0;at<100000;at+=1000)store.batch(derived,()=>{for(let i=at;i<at+1000;i++)store.addFact(derived,{predicate:'common.CallSummary',context:'ctx',subject:'caller',object:'target',occurrence:'occ',value:{i},confidence:'resolved',provenance:p('derived'),supports:[[{claim:a.c}],[{claim:b.c}]]})});
store.seal(derived,{status:'partial'});const first=store.publish([a.id,b.id,derived]);const firstVisible=store.sql('SELECT COUNT(*) AS n FROM sc_active WHERE snapshot=?').get(first).n;store.publish([derived]);
const started=performance.now();const collected=store.collectGarbage({keep:1});const gcMs=performance.now()-started;
const retainedProofClaims=store.sql('SELECT COUNT(*) AS n FROM sc_claims').get().n;const origins=store.sql('SELECT COUNT(*) AS n FROM sc_origin_runs').get().n;
const empty=store.publish([]);const sweepStarted=performance.now();const swept=store.collectGarbage({keep:1});const sweepMs=performance.now()-sweepStarted;
const integrity=store.db.pragma('integrity_check',{simple:true}),foreignKeys=store.db.pragma('foreign_key_check');const pragmas=Object.fromEntries(['journal_mode','synchronous'].map(key=>[key,store.db.pragma(key,{simple:true})]));store.close();
const receipt={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,shape:{baseClaims:2,derivedClaims:100000,alternativeSupports:2},root,firstVisible,retainedProofClaims,origins,gcMs,sweepMs,collected,swept,empty,integrity,foreignKeys,pragmas,nodePeakRssKiB:process.resourceUsage().maxRSS,sqliteBytes:(await stat(path.join(root,'semantic.sqlite'))).size,scope:'offline GC, not publication or compiler scale; one warm trial'};
await writeFile(process.argv[2] ?? 'semantic-gc-benchmark.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
