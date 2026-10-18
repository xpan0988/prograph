import {afterEach,expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {SemanticStore} from '../src/core/semantic/store.js';
import {scanRepository} from '../src/core/repository/repository.js';
import {createIndexState} from '../src/core/analysis/state.js';
import {OwnedWriter,writeSyntaxBase,OWNED_PASS_VERSION} from '../src/core/semantic/owned-projection.js';
import {digest,semanticKey,type Provenance} from '../src/core/semantic/model.js';
import {readSnapshotReport,retainedAnalysisReport} from '../src/core/semantic/snapshot-report.js';
import {QueryService} from '../src/core/query/query-service.js';
import type {AnalysisManifest,GraphNode,GraphEdge} from '../src/core/graph/schema.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
test('inherited authority validates effective projection visibility after alternative-support closure and native negative-selector changes',async()=>{
  for(const mode of ['last-support','negative-selector']){
    const root=await mkdtemp(path.join(os.tmpdir(),'prograph-authority-support-'));roots.push(root);const repository=path.join(root,'repo'),index=path.join(root,'index');await mkdir(repository);await mkdir(index);await writeFile(path.join(repository,'a.ts'),'export function caller(){}');await writeFile(path.join(repository,'b.ts'),'export function target(){}');
    const{snapshot}=await scanRepository(repository,index),store=new SemanticStore(path.join(index,'semantic.sqlite'));
    try{
      const context=semanticKey('analysis-context',[snapshot.repository.identity,OWNED_PASS_VERSION]);
      const nodes:GraphNode[]=[{id:'repo',kind:'repository',name:'repo',qualifiedName:repository,adapter:'fixture',metadata:{}},...['a.ts','b.ts'].map(file=>({id:'file:'+file,kind:'file'as const,name:file,qualifiedName:file,file,adapter:'fixture',metadata:{}})),...['caller','target'].map((name,i)=>({id:name,kind:'function'as const,name,qualifiedName:name,file:i?'b.ts':'a.ts',adapter:'fixture',metadata:{}}))];
      const source=writeSyntaxBase(store,snapshot,{nodes,edges:[],diagnostics:[],metadata:{}},context,digest('base'));
      const provenance=(inputFingerprint:string):Provenance=>({provider:'synthetic-authority-support',version:'1',basis:'inference',method:'explicit-fixture',context,inputFingerprint});
      const token=(name:string)=>{const run=store.begin('support/'+name,context,name),subject=semanticKey('fixture',[name]);store.addEntity(subject,'artifact',{subject});const claim=store.batch(run,()=>store.addFact(run,{predicate:'context.Project',context,subject,value:{token:name},confidence:'exact',provenance:provenance(name)}));store.seal(run,{status:'partial'});return{run,claim}};
      const a=token('a'),b=token('b'),guardOwner=store.begin('support/guard',context,'guard'),subject=semanticKey('fixture',['guard']);store.addEntity(subject,'artifact',{subject});
      const guard=store.batch(guardOwner,()=>store.addFact(guardOwner,{predicate:'support.Conjunction',context,subject,value:{guard:true},confidence:'exact',provenance:provenance('guard'),supports:[[{claim:source.nodeClaims.get('caller')!},{claim:a.claim}],[{claim:source.nodeClaims.get('caller')!},{claim:b.claim}]]}));store.seal(guardOwner,{status:'partial'});
      const selector=(value:string)=>{const run=store.begin('support/selector',context,value);store.selector(run,'binding-selector',value);store.seal(run,{status:'partial'});return run};
      const one=selector('one'),two=selector('two'),contract=store.begin('analysis/pass:cache-fixture@1',context,'contract');store.seal(contract,{status:'partial',pass:'cache-fixture',dependencies:[],version:'1'});
      const edge:GraphEdge={id:'edge',source:'caller',target:'target',kind:'calls',confidence:'resolved',evidence:[{file:'a.ts',line:1,adapter:'fixture'}],metadata:{}};
      const shard=store.begin('analysis/pass:cache-fixture@1/segment:one',context,'shard'),inputs=new Map(source.nodeClaims);inputs.set('caller',guard);new OwnedWriter(store,shard,snapshot,provenance('shard'),{key:'binding-selector',digest:'one'},source.fileClaims,inputs).write({nodes:[],edges:[edge],diagnostics:[],metadata:{}});store.seal(shard,{status:'partial',pass:'cache-fixture',dependencies:[],version:'1'});
      const fixed=[...source.runs,guardOwner,contract,shard];
      const manifest:AnalysisManifest={schemaVersion:'1.2.0',toolVersion:'0.3.0',repositoryRoot:repository,repositoryIdentity:snapshot.repository.identity,generatedAt:new Date().toISOString(),adapterRuns:[],enabledAdapters:[],scannedFileCount:2,excludedFileCount:0,nodeCount:nodes.length,edgeCount:1,diagnosticCount:0,analysisDuration:0,semanticCore:{format:2,status:'partial',durationMs:0,reason:'Synthetic support fixture'}};const{files,...stateHeader}=createIndexState(snapshot,manifest);
      const first=store.publish([...fixed,one,a.run,b.run],undefined,[],{manifest,stateHeader});store.pinSnapshot(first,'support-history');
      const unchanged=[...fixed,one,b.run],inherited=retainedAnalysisReport(store,unchanged,first);expect(inherited).toBeDefined();const second=store.publish(unchanged,first,[],inherited);expect(readSnapshotReport(store.db,second)?.inherited?.snapshot).toBe(first);expect(store.sql('SELECT COUNT(*) n FROM edges').get()).toEqual({n:1});
      const invalidated=[...fixed,...(mode==='last-support'?[one]:[two,b.run])],candidate=retainedAnalysisReport(store,invalidated,second);expect(candidate).toBeDefined();
      const third=store.publish(invalidated,second,[],candidate);expect(readSnapshotReport(store.db,third)).toBeUndefined();expect(readSnapshotReport(store.db,second)?.snapshot).toBe(second);
      const query=new QueryService(store.filename);try{expect(()=>query.overview()).toThrow(/do not match|unavailable/);}finally{query.close();}
      if(mode==='negative-selector')expect(store.sql('SELECT 1 FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? AND c.key=?').get(third,guard)).toBeDefined();
      expect(store.db.pragma('integrity_check',{simple:true})).toBe('ok');expect(store.db.pragma('foreign_key_check')).toEqual([]);
    }finally{store.close();}
  }
},30000);
