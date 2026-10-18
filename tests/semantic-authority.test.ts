import {releaseMigrationRetention} from "./oracles/migration-retention.js";
import {prepareAuthorityMigration} from "../src/core/semantic/authority-migration.js";
import {afterEach,expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import protobuf from 'protobufjs';
import {analyzeRepository} from '../src/core/analysis/analyze.js';
import {repositoryStatus} from '../src/core/analysis/state.js';
import {syncRepository} from '../src/core/analysis/sync.js';
import {SemanticStore} from '../src/core/semantic/store.js';
import {SemanticQuery} from '../src/core/semantic/query.js';
import {readSnapshotReport} from '../src/core/semantic/snapshot-report.js';
import {queryServiceForRepository,QueryService} from '../src/core/query/query-service.js';
import {isolatedQueryForRepository} from '../src/core/query/isolation.js';
import {scipType} from '../src/core/semantic/scip-wire.js';
import {importScip,type ScipManifest} from '../src/core/semantic/scip-import.js';
import {digest} from '../src/core/semantic/model.js';
import {pathToFileURL} from 'node:url';
import {canonical} from '../src/core/semantic/model.js';
import {exportCompatibilitySnapshot} from '../src/core/semantic/compatibility-export.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'prograph-authority-'));roots.push(root);
  const repository=path.join(root,'source'),index=path.join(root,'custom [index]');await mkdir(repository);
  await writeFile(path.join(repository,'tsconfig.json'),'{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  await writeFile(path.join(repository,'a.ts'),'export function target(){return 1};export function run(){return target()}');
  await writeFile(path.join(repository,'a.py'),'target()\n');await writeFile(path.join(repository,'README.md'),'# Example\n');
  const field=(id:number,type:string,value:object)=>Buffer.from(protobuf.Writer.create().uint32(id<<3|2).bytes(scipType(type).encode(scipType(type).fromObject(value)).finish()).finish());
  const symbol='scip-python python fixture 1 module/native_target().',bytes=Buffer.concat([field(1,'Metadata',{version:0,tool_info:{name:'fixture-scip',version:'1'},project_root:new URL(`file://${repository}/`).href,text_document_encoding:1}),field(2,'Document',{relative_path:'a.py',language:'Python',position_encoding:2,occurrences:[{symbol,range:[0,0,6],symbol_roles:1}],symbols:[{symbol,kind:17,display_name:'native_target'}]})]);
  const artifact=path.join(root,'index.scip');await writeFile(artifact,bytes);
  const manifest:ScipManifest={format:1,id:'fixture',sourceRoot:repository,projectContext:'fixture',indexDigest:digest(bytes),sources:{'a.py':digest(await readFile(path.join(repository,'a.py')))},provider:{name:'fixture-scip',version:'1',basis:'compiler'}};
  const analyzed=await analyzeRepository(repository,{output:index});
  expect(analyzed.manifest.semanticCore?.status,analyzed.manifest.semanticCore?.reason).toBe('partial');
  return{root,repository,index,artifact,manifest};
}
test('default navigation and freshness use one semantic snapshot without any legacy database or filesystem exports',async()=>{
  const f=await fixture();
  for(const file of ['graph.sqlite','graph.sqlite-wal','graph.sqlite-shm','manifest.json','state.json','diagnostics.json','exports'])await rm(path.join(f.index,file),{recursive:true,force:true});
  const query=await queryServiceForRepository(f.repository,f.index);
  try{expect(path.basename(query.database.name)).toBe('semantic.sqlite');expect(query.searchSymbols('target').length).toBeGreaterThan(0);}finally{query.close();}
  expect(await repositoryStatus(f.repository,f.index)).toMatchObject({state:'fresh',authority:'semantic',semanticPublication:{state:'matches-semantic-snapshot'}});
  expect((await (await isolatedQueryForRepository(f.repository,f.index)).searchSymbols('target')).length).toBeGreaterThan(0);
  await writeFile(path.join(f.repository,'README.md'),'# Changed docs\n');
  expect(await repositoryStatus(f.repository,f.index)).toMatchObject({state:'stale',modifiedFiles:['README.md']});
  expect((await syncRepository(f.repository,f.index)).statusAfter.state).toBe('fresh');
},30000);
const authorityBaseline=process.env.PROGRAPH_TEST_AUTHORITY_BASELINE_RUNTIME;
test.skipIf(!authorityBaseline)('actual accepted source-policy writer migrates to semantic default authority and its old reader consumes a retained-snapshot rollback export',async()=>{
  const baseline=JSON.parse(await readFile(path.join(authorityBaseline!,'baseline-receipt.json'),'utf8'));expect(baseline.commit).toBe('b96118fc7513191b33af5d82caef387ad2c8e01e');
  for(const[file,expected]of Object.entries(baseline.digests))expect(digest(await readFile(path.join(authorityBaseline!,'dist',file)))).toBe(expected);
  const oldAnalyze=await import(/* @vite-ignore */ pathToFileURL(path.join(authorityBaseline!,'dist/core/analysis/analyze.js')).href) as typeof import('../src/core/analysis/analyze.js');
  const OldStore=(await import(/* @vite-ignore */ pathToFileURL(path.join(authorityBaseline!,'dist/core/semantic/store.js')).href) as typeof import('../src/core/semantic/store.js')).SemanticStore;
  const OldQuery=(await import(/* @vite-ignore */ pathToFileURL(path.join(authorityBaseline!,'dist/core/query/query-service.js')).href) as typeof import('../src/core/query/query-service.js')).QueryService;
  const f=await fixture();await rm(f.index,{recursive:true,force:true});const old=await oldAnalyze.analyzeRepository(f.repository,{output:f.index});expect(old.manifest.semanticCore?.status).toBe('partial');
  const file=path.join(f.index,'semantic.sqlite'),initial=new OldStore(file),snapshot=initial.activeSnapshot()!;let historicalReport:string;
  try{expect(initial.sql("SELECT value FROM sc_meta WHERE key='schema'").get()).toEqual({value:'2.0.0-step2.12'});initial.pinSnapshot(snapshot,'accepted-policy-upgrade');historicalReport=canonical(readSnapshotReport(initial.db,snapshot));}finally{initial.close();}
  const migrated=await syncRepository(f.repository,f.index);expect(migrated.statusAfter).toMatchObject({authority:'semantic',state:'fresh',schemaChanged:false});
  expect(()=>new OldStore(file)).toThrow(/Unsupported Semantic Core storage\/schema/);
  const current=new SemanticStore(file);let pinnedGc:Record<string,number>,unpinnedGc:Record<string,number>;
  try{pinnedGc=current.collectGarbage({keep:1});expect(canonical(readSnapshotReport(current.db,snapshot))).toBe(historicalReport!);}finally{current.close();}
  const output=path.join(f.root,'rollback');await exportCompatibilitySnapshot(f.index,output,snapshot);
  const reader=new OldQuery(path.join(output,'graph.sqlite'));try{expect(reader.searchSymbols('target').some(node=>node.language==='typescript')).toBe(true);expect(reader.overview({scope:'full'})).toHaveProperty('counts.nodes',old.graph.nodes.length);}finally{reader.close();}
  const final=new SemanticStore(file);try{final.unpinSnapshot(snapshot,'accepted-policy-upgrade');expect(releaseMigrationRetention(final)).toBeGreaterThan(0);unpinnedGc=final.collectGarbage({keep:1});expect(readSnapshotReport(final.db,snapshot)).toBeUndefined();expect(final.db.pragma('integrity_check',{simple:true})).toBe('ok');expect(final.db.pragma('foreign_key_check')).toEqual([]);}finally{final.close();}
  const evidence={baseline,historicalReportHash:digest(historicalReport!),pinnedGc:pinnedGc!,unpinnedGc:unpinnedGc!,authority:migrated.statusAfter.authority,freshness:migrated.statusAfter.state,legacySchema:'1.2.0',rollbackOldReader:'passed'};
  if(process.env.PROGRAPH_TEST_AUTHORITY_UPGRADE_EVIDENCE)await writeFile(process.env.PROGRAPH_TEST_AUTHORITY_UPGRADE_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
},60000);
test('qualified native publication inherits current compatibility metadata while changed source fails closed until sync',async()=>{
  const f=await fixture(),filename=path.join(f.index,'semantic.sqlite'),initial=new SemanticStore(filename),old=initial.activeSnapshot()!;
  initial.pinSnapshot(old,'native-inheritance');initial.close();
  await importScip(f.repository,f.artifact,f.manifest,f.index);
  const current=new SemanticStore(filename);
  try{const report=readSnapshotReport(current.db,current.activeSnapshot()!)!;expect(report.format).toBe(2);expect(report.compatibilityReady).toBe(true);expect(report.inherited?.snapshot).toBe(old);expect(readSnapshotReport(current.db,old)?.snapshot).toBe(old);}finally{current.close();}
  expect((await repositoryStatus(f.repository,f.index)).state).toBe('fresh');
  let query=await queryServiceForRepository(f.repository,f.index);try{expect(query.searchSymbols('target').length).toBeGreaterThan(0);}finally{query.close();}
  await writeFile(path.join(f.repository,'a.ts'),'export function replacement(){return 2}');await importScip(f.repository,f.artifact,f.manifest,f.index);
  expect(await repositoryStatus(f.repository,f.index)).toMatchObject({state:'stale',authority:'semantic',semanticPublication:{state:'unreported'}});
  query=await queryServiceForRepository(f.repository,f.index);try{expect(()=>query.overview()).toThrow(/do not match|unavailable/);}finally{query.close();}
  expect((await syncRepository(f.repository,f.index)).statusAfter.state).toBe('fresh');
},30000);
test('an unreported publication cannot silently reactivate a stale legacy compatibility database',async()=>{
  const f=await fixture(),store=new SemanticStore(path.join(f.index,'semantic.sqlite'));
  try{store.publish([],store.activeSnapshot());}finally{store.close();}
  const legacy=new QueryService(path.join(f.index,'graph.sqlite'));try{expect(legacy.searchSymbols('target').length).toBeGreaterThan(0);}finally{legacy.close();}
  const query=await isolatedQueryForRepository(f.repository,f.index);await expect(query.overview()).rejects.toThrow(/do not match|unavailable/);
  expect(await repositoryStatus(f.repository,f.index)).toMatchObject({authority:'semantic',state:'stale',semanticPublication:{state:'unreported'}});
  expect((await syncRepository(f.repository,f.index)).statusAfter.state).toBe('fresh');
},30000);
test('failed analysis records a durable attempt without replacing the previous coherent published view',async()=>{
  const f=await fixture(),filename=path.join(f.index,'semantic.sqlite'),store=new SemanticStore(filename),old=store.activeSnapshot();
  store.db.exec("CREATE TRIGGER reject_test_snapshot BEFORE INSERT ON sc_snapshots BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END");store.close();
  await writeFile(path.join(f.repository,'a.ts'),'export function replacement(){return 2}');const result=await analyzeRepository(f.repository,{output:f.index});expect(result.manifest.semanticCore?.status).toBe('failed');
  const query=new SemanticQuery(filename);try{expect(query.execute('status').snapshot).toBe(old);expect(query.execute('status').latestAttempt).toMatchObject({status:'failed',matchesSnapshot:false});}finally{query.close();}
  const compatibility=await queryServiceForRepository(f.repository,f.index);try{expect(compatibility.searchSymbols('target').length).toBeGreaterThan(0);expect(compatibility.searchSymbols('replacement')).toHaveLength(0);}finally{compatibility.close();}
  expect((await repositoryStatus(f.repository,f.index)).state).toBe('stale');const repaired=new SemanticStore(filename);repaired.db.exec('DROP TRIGGER reject_test_snapshot');repaired.close();expect((await syncRepository(f.repository,f.index)).statusAfter.state).toBe('fresh');
},30000);
