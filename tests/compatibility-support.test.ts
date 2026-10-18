import {afterEach,expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {SemanticStore} from '../src/core/semantic/store.js';
import {scanRepository} from '../src/core/repository/repository.js';
import {createIndexState} from '../src/core/analysis/state.js';
import {OwnedWriter,writeSyntaxBase,OWNED_PASS_VERSION} from '../src/core/semantic/owned-projection.js';
import {canonical,digest,semanticKey,type Provenance} from '../src/core/semantic/model.js';
import {readCompatibilitySnapshot} from '../src/core/semantic/compatibility-snapshot.js';
import type {AnalysisManifest,GraphNode,GraphEdge} from '../src/core/graph/schema.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});

test('owned compatibility winners follow alternative support, negative selectors, restored visibility and same-payload owner replacement through GC',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prograph-compatibility-support-'));roots.push(root);const repository=path.join(root,'repo'),index=path.join(root,'index');await mkdir(repository);await mkdir(index);await writeFile(path.join(repository,'a.ts'),'export function caller(){}');await writeFile(path.join(repository,'b.ts'),'export function target(){}');
 const{snapshot}=await scanRepository(repository,index),store=new SemanticStore(path.join(index,'semantic.sqlite'));
 try{
  const context=semanticKey('analysis-context',[snapshot.repository.identity,OWNED_PASS_VERSION]);
  const nodes:GraphNode[]=[{id:'repo',kind:'repository',name:'repo',qualifiedName:repository,adapter:'fixture',metadata:{}},...['a.ts','b.ts'].map(file=>({id:'file:'+file,kind:'file'as const,name:file,qualifiedName:file,file,adapter:'fixture',metadata:{}})),...['caller','target'].map((name,i)=>({id:name,kind:'function'as const,name,qualifiedName:name,file:i?'b.ts':'a.ts',adapter:'fixture',metadata:{}}))];
  const source=writeSyntaxBase(store,snapshot,{nodes,edges:[],diagnostics:[],metadata:{}},context,digest('base'));
  const provenance=(inputFingerprint:string):Provenance=>({provider:'synthetic-owned-support',version:'1',basis:'inference',method:'explicit-fixture',context,inputFingerprint});
  const token=(name:string)=>{const run=store.begin('support/'+name,context,name),subject=semanticKey('fixture',[name]);store.addEntity(subject,'artifact',{subject});const claim=store.batch(run,()=>store.addFact(run,{predicate:'context.Project',context,subject,value:{token:name},confidence:'exact',provenance:provenance(name)}));store.seal(run,{status:'partial'});return{run,claim}};
  const a=token('a'),b=token('b'),guardOwner=store.begin('support/guard',context,'guard'),subject=semanticKey('fixture',['guard']);store.addEntity(subject,'artifact',{subject});
  const guard=store.batch(guardOwner,()=>store.addFact(guardOwner,{predicate:'support.Conjunction',context,subject,value:{guard:true},confidence:'exact',provenance:provenance('guard'),supports:[[{claim:source.nodeClaims.get('caller')!},{claim:a.claim}],[{claim:source.nodeClaims.get('caller')!},{claim:b.claim}]]}));store.seal(guardOwner,{status:'partial'});
  const selector=(value:string)=>{const run=store.begin('analysis/pass:cache-fixture@1',context,value);store.selector(run,'cache-fixture',value);store.seal(run,{status:'partial',pass:'cache-fixture',dependencies:[],version:'1'});return run};
  const edge:GraphEdge={id:'edge',source:'caller',target:'target',kind:'calls',confidence:'resolved',evidence:[{file:'a.ts',line:1,adapter:'fixture'}],metadata:{}};
  const shard=(version:string,selectorValue:string)=>{const run=store.begin('analysis/pass:cache-fixture@1/segment:one',context,version),inputs=new Map(source.nodeClaims);inputs.set('caller',guard);new OwnedWriter(store,run,snapshot,provenance(version),{key:'cache-fixture',digest:selectorValue},source.fileClaims,inputs).write({nodes:[],edges:[edge],diagnostics:[],metadata:{}});store.seal(run,{status:'partial',pass:'cache-fixture',dependencies:[],version:'1'});return run};
  const one=selector('one'),two=selector('two'),firstShard=shard('first','one');let parent:number|undefined;
  const publish=(owners:number[],edgeCount:number)=>{const generatedAt=new Date().toISOString(),manifest:AnalysisManifest={schemaVersion:'1.2.0',toolVersion:'0.3.0',repositoryRoot:repository,repositoryIdentity:snapshot.repository.identity,generatedAt,adapterRuns:[],enabledAdapters:[],scannedFileCount:2,excludedFileCount:0,nodeCount:nodes.length,edgeCount,diagnosticCount:0,analysisDuration:0,semanticCore:{format:2,status:'partial',durationMs:0,reason:'Synthetic graph fixture'}};const{files,...stateHeader}=createIndexState(snapshot,manifest);parent=store.publish([...source.runs,guardOwner,...owners],parent,[],{manifest,stateHeader});expect(store.sql('SELECT COUNT(*) n FROM edges').get()).toEqual({n:edgeCount});expect(store.sql('SELECT COUNT(*) n FROM cq_edges').get()).toEqual({n:edgeCount});expect(store.sql('SELECT COUNT(*) n FROM cg_current c WHERE NOT EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=c.claim)').get(parent)).toEqual({n:0});return parent};
  const first=publish([one,firstShard,a.run,b.run],1);store.pinSnapshot(first,'fixture-history');
  publish([one,firstShard,b.run],1);expect(JSON.parse((store.sql("SELECT value FROM cg_meta WHERE key='work'").get()as{value:string}).value)).toMatchObject({classifiedRows:0,resolvedKeys:1,changedPayloads:0});
  publish([one,firstShard],0);expect(store.sql('SELECT degree FROM cq_nodes WHERE node=?').get('caller')).toEqual({degree:0});
  publish([one,firstShard,a.run],1);
  publish([two,firstShard,a.run],0);expect(store.sql('SELECT 1 FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? AND c.key=?').get(parent,guard)).toBeDefined();
  const secondShard=shard('second','two');publish([two,secondShard,a.run],1);const physical=store.sql("SELECT rowid FROM edges WHERE id='edge'").get();
  const thirdShard=shard('third','two');publish([two,thirdShard,a.run],1);expect(store.sql("SELECT run FROM cg_current WHERE kind='edge' AND key='edge'").get()).toEqual({run:thirdShard});expect(store.sql("SELECT rowid FROM edges WHERE id='edge'").get()).toEqual(physical);
  store.collectGarbage({keep:1});expect(store.db.transaction(()=>readCompatibilitySnapshot(store.db,first))().graph.edges).toEqual([edge]);store.unpinSnapshot(first,'fixture-history');store.collectGarbage({keep:1});expect(store.db.pragma('integrity_check',{simple:true})).toBe('ok');expect(store.db.pragma('foreign_key_check')).toEqual([]);
 }finally{store.close()}
},30000);
