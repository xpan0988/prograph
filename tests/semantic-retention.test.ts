import {releaseMigrationRetention} from "./oracles/migration-retention.js";
import {prepareAuthorityMigration} from "../src/core/semantic/authority-migration.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { readSnapshotReport } from "../src/core/semantic/snapshot-report.js";
import { collectSemanticGarbage } from "../src/core/semantic/gc.js";
import { canonical } from "../src/core/semantic/model.js";
import protobuf from "protobufjs";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { importScip, type ScipManifest } from "../src/core/semantic/scip-import.js";
import { scipType } from "../src/core/semantic/scip-wire.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";
import * as qualification from "../src/core/semantic/retention-qualification.js";
import { digest } from "../src/core/semantic/model.js";
const roots:string[]=[]; afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
async function fixture(analyze=true){const root=await mkdtemp(path.join(os.tmpdir(),'prograph-native-retention-'));roots.push(root);const repository=path.join(root,'source'),index=path.join(root,'index');await mkdir(repository);await writeFile(path.join(repository,'tsconfig.json'),'{"compilerOptions":{"strict":true},"include":["*.ts"]}');await writeFile(path.join(repository,'a.ts'),'export function target(){return 1};export function run(){return target()}');await writeFile(path.join(repository,'a.py'),'target()\n');await writeFile(path.join(repository,'README.md'),'# Example\n');
 const field=(id:number,type:string,value:unknown)=>Buffer.from(protobuf.Writer.create().uint32(id<<3|2).bytes(scipType(type).encode(scipType(type).fromObject(value as Record<string,unknown>)).finish()).finish());
 const symbol='scip-python python fixture 1 module/native_target().',bytes=Buffer.concat([field(1,'Metadata',{version:0,tool_info:{name:'fixture-scip',version:'1'},project_root:new URL(`file://${repository}/`).href,text_document_encoding:1}),field(2,'Document',{relative_path:'a.py',language:'Python',position_encoding:2,occurrences:[{symbol,range:[0,0,6],symbol_roles:1}],symbols:[{symbol,kind:17,display_name:'native_target'}]})]);const artifact=path.join(root,'index.scip');await writeFile(artifact,bytes);
 const manifest:ScipManifest={format:1,id:'fixture',sourceRoot:repository,projectContext:'fixture',indexDigest:digest(bytes),sources:{'a.py':digest(await readFile(path.join(repository,'a.py')))},provider:{name:'fixture-scip',version:'1',basis:'compiler'}};
 if(analyze)await analyzeRepository(repository,{output:index});return{root,repository,index,artifact,manifest};}
function owners(index:string){const store=new SemanticStore(path.join(index,'semantic.sqlite'));try{return store.sql('SELECT partition_key,run FROM sc_partitions WHERE snapshot=? ORDER BY partition_key').all(store.activeSnapshot()) as Array<{partition_key:string;run:number}>}finally{store.close()}}
function find(index:string,name:string,snapshot?:number){const q=new SemanticQuery(path.join(index,'semantic.sqlite'));try{return q.execute('find',name,{snapshot}).items as unknown[]}finally{q.close()}}
test('unchanged native-only publication retains qualified source, passes and TypeScript groups',async()=>{const f=await fixture(),before=owners(f.index);await importScip(f.repository,f.artifact,f.manifest,f.index);const after=owners(f.index);for(const row of before)expect(after).toContainEqual(row);expect(find(f.index,'target')).toHaveLength(1);expect(find(f.index,'native_target')).toHaveLength(1);expect(after.some(row=>row.partition_key==='retention/gaps')).toBe(false);},30000);
test('changed source removes stale TypeScript and owned pass facts while old snapshots remain readable',async()=>{const f=await fixture(),store=new SemanticStore(path.join(f.index,'semantic.sqlite'));const previous=store.activeSnapshot()!;store.pinSnapshot(previous,'history');store.close();await writeFile(path.join(f.repository,'a.ts'),'export function replacement(){return 2}');await importScip(f.repository,f.artifact,f.manifest,f.index);expect(find(f.index,'target')).toHaveLength(0);expect(find(f.index,'native_target')).toHaveLength(1);expect(find(f.index,'target',previous)).toHaveLength(1);expect(owners(f.index).some(row=>row.partition_key.startsWith('analysis/'))).toBe(false);expect(owners(f.index).some(row=>row.partition_key==='retention/gaps')).toBe(true);const synced=await syncRepository(f.repository,f.index);expect(synced.statusAfter.state).toBe('fresh');expect(find(f.index,'replacement')).toHaveLength(1);expect(owners(f.index).some(row=>row.partition_key==='retention/gaps')).toBe(false);},30000);
test('documentation-only explicit imports hide stale knowledge but keep compiler groups and subsequent compiler reuse',async()=>{const f=await fixture(),before=owners(f.index).filter(row=>row.partition_key.startsWith('typescript/'));await writeFile(path.join(f.repository,'README.md'),'# Changed docs\n');await importScip(f.repository,f.artifact,f.manifest,f.index);expect(owners(f.index).filter(row=>row.partition_key.startsWith('typescript/'))).toEqual(before);expect(owners(f.index).some(row=>row.partition_key.startsWith('analysis/'))).toBe(false);expect(find(f.index,'target')).toHaveLength(1);await analyzeRepository(f.repository,{output:f.index});expect(owners(f.index).filter(row=>row.partition_key.startsWith('typescript/'))).toEqual(before);},30000);
test('a newly added semantic module invalidates prior negative candidate catalogues without importer edits',async()=>{const f=await fixture();await writeFile(path.join(f.repository,'new.py'),'value=1\n');await importScip(f.repository,f.artifact,f.manifest,f.index);expect(find(f.index,'target')).toHaveLength(0);expect(find(f.index,'native_target')).toHaveLength(1);expect(owners(f.index).some(row=>row.partition_key.startsWith('typescript/'))).toBe(false);},30000);
test('configuration-only changes invalidate unexecuted groups even when source selection is identical',async()=>{const f=await fixture();await writeFile(path.join(f.repository,'prograph.config.json'),JSON.stringify({include:['*.ts','*.py','README.md'],exclude:['prograph.config.json'],adapters:{react:false}}));await importScip(f.repository,f.artifact,f.manifest,f.index);expect(owners(f.index).some(row=>row.partition_key.startsWith('typescript/'))).toBe(false);expect(find(f.index,'native_target')).toHaveLength(1);},30000);

test('mixed source/schema edits and recovery agree with independent clean source and interchange rebuilds',async()=>{
 const f=await fixture(),clean=path.join(f.root,'clean');
 for(const edit of [()=>writeFile(path.join(f.repository,'a.ts'),'export function replacement(){return 2}'),()=>writeFile(path.join(f.repository,'README.md'),'# Documentation change\n'),()=>writeFile(path.join(f.repository,'added.py'),'value=1\n')]) {
   await edit(); await importScip(f.repository,f.artifact,f.manifest,f.index); await syncRepository(f.repository,f.index);
   await rm(clean,{recursive:true,force:true}); await analyzeRepository(f.repository,{output:clean});await importScip(f.repository,f.artifact,f.manifest,clean);await analyzeRepository(f.repository,{output:clean});
   expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
 }
},60000);

test('source, native document and negative inventory changes after qualification abort the whole native publication',async()=>{
 for(const change of ['source','document','new-module','configuration']) {
  const f=await fixture(),before=owners(f.index),db=new SemanticStore(path.join(f.index,'semantic.sqlite'));const active=db.activeSnapshot();db.close();
  const original=qualification.qualifyRetainedAnalysis;
  const spy=vi.spyOn(qualification,'qualifyRetainedAnalysis').mockImplementation(async(...args)=>{
   const runs=await original(...args);
   await writeFile(path.join(f.repository,change==='source'?'a.ts':change==='document'?'a.py':change==='new-module'?'new.py':'prograph.config.json'),change==='configuration'?'{}':'changed input');return runs;
  });
  try{await expect(importScip(f.repository,f.artifact,f.manifest,f.index)).rejects.toThrow(/input changed|inventory changed/);}finally{spy.mockRestore();}
  expect(owners(f.index)).toEqual(before);const recovered=new SemanticStore(path.join(f.index,'semantic.sqlite'));try{expect(recovered.activeSnapshot()).toBe(active);expect(recovered.db.pragma('integrity_check',{simple:true})).toBe('ok');expect(recovered.db.pragma('foreign_key_check')).toEqual([]);}finally{recovered.close();}
 }
},30000);

test('identical-byte relocation cannot retain another logical repository project or semantic identities',async()=>{
 const f=await fixture(),other=path.join(f.root,'other');await cp(f.repository,other,{recursive:true});
 await importScip(other,f.artifact,{...f.manifest,sourceRoot:other,originalProjectRoot:new URL(`file://${f.repository}/`).href},f.index);
 const current=owners(f.index);expect(current.some(row=>/^(?:analysis|typescript|context)\//.test(row.partition_key))).toBe(false);expect(find(f.index,'target')).toHaveLength(0);expect(find(f.index,'native_target')).toHaveLength(1);
},30000);

test('excluded compiler configuration invalidates syntax/pass observations as well as common TS facts and remains visibly stale',async()=>{
 const f=await fixture();await mkdir(path.join(f.repository,'build'));await writeFile(path.join(f.repository,'build/base.json'),'{"compilerOptions":{"strict":true}}');await writeFile(path.join(f.repository,'tsconfig.json'),'{"extends":"./build/base.json","include":["*.ts"]}');await analyzeRepository(f.repository,{output:f.index});
 const unchanged=owners(f.index);await importScip(f.repository,f.artifact,f.manifest,f.index);for(const row of unchanged)expect(owners(f.index)).toContainEqual(row);
 await writeFile(path.join(f.repository,'build/base.json'),'{"compilerOptions":{"strict":false}}');await importScip(f.repository,f.artifact,f.manifest,f.index);
 expect(owners(f.index).some(row=>row.partition_key.startsWith('analysis/'))).toBe(false);expect(find(f.index,'target')).toHaveLength(0);expect(owners(f.index).some(row=>row.partition_key.startsWith('context/'))).toBe(false);expect(await repositoryStatus(f.repository,f.index)).toMatchObject({state:'stale',modifiedFiles:[],semanticInputsChanged:true});expect((await syncRepository(f.repository,f.index)).statusAfter.state).toBe('fresh');
},30000);

test('literal scanner paths with brackets retain source observations and qualified semantic navigation',async()=>{
 const f=await fixture();await writeFile(path.join(f.repository,'[route].ts'),'export function route(){return 1}');const analyzed=await analyzeRepository(f.repository,{output:f.index});expect(analyzed.manifest.semanticCore?.status,analyzed.manifest.semanticCore?.reason).toBe('partial');expect(analyzed.graph.nodes.some(node=>node.name==='route'&&node.file==='[route].ts')).toBe(true);const before=owners(f.index);await importScip(f.repository,f.artifact,f.manifest,f.index);for(const row of before)expect(owners(f.index)).toContainEqual(row);expect(find(f.index,'route')).toHaveLength(1);
},30000);

test('qualified isolated module sync preserves observed inputs and agrees with clean facts before native retention',async()=>{
 const f=await fixture(),config={include:['*.ts','a.py','README.md'],adapters:{python:false}};await writeFile(path.join(f.repository,'prograph.config.json'),JSON.stringify(config));await analyzeRepository(f.repository,{output:f.index});
 await writeFile(path.join(f.repository,'a.ts'),'export function target(){return 2};export function run(){return target()}');
 const synced=await syncRepository(f.repository,f.index);expect(synced.incremental).toBe(true);expect(synced.statusAfter.state).toBe('fresh');
 const clean=path.join(f.root,'clean');await analyzeRepository(f.repository,{output:clean});expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
 const before=owners(f.index);await importScip(f.repository,f.artifact,f.manifest,f.index);for(const row of before)expect(owners(f.index)).toContainEqual(row);
},30000);
test('global script and new ambient augmentation edits take a full source rebuild and match clean observations',async()=>{
 for(const mode of ['script','augmentation']) {
  const f=await fixture();await writeFile(path.join(f.repository,'prograph.config.json'),JSON.stringify({include:['*.ts','a.py','README.md'],adapters:{python:false}}));
  await writeFile(path.join(f.repository,'a.ts'),mode==='script'?'function existing(){}':'export {};');await writeFile(path.join(f.repository,'b.ts'),mode==='script'?'function run(){return newlyAdded()}':'export function run(){return injected()}');await analyzeRepository(f.repository,{output:f.index});
  await writeFile(path.join(f.repository,'a.ts'),mode==='script'?'function existing(){} function newlyAdded(){return 1}':'export {}; declare global { function injected():number; }');const synced=await syncRepository(f.repository,f.index);expect(synced.incremental).toBe(false);expect(synced.statusAfter.state).toBe('fresh');const clean=path.join(f.root,'clean');await analyzeRepository(f.repository,{output:clean});expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
 }
},30000);

test('excluded configuration receipts bind original bytes even when UTF-8 decoding has identical replacements',async()=>{
 const f=await fixture(),file=path.join(f.repository,'prograph.config.json');const prefix=Buffer.from('{"include":["*.ts","a.py","README.md"],"note":"'),suffix=Buffer.from('"}');
 await writeFile(file,Buffer.concat([prefix,Buffer.from([0xff]),suffix]));await analyzeRepository(f.repository,{output:f.index});expect((await repositoryStatus(f.repository,f.index)).state).toBe('fresh');await writeFile(file,Buffer.concat([prefix,Buffer.from([0xfe]),suffix]));expect(await repositoryStatus(f.repository,f.index)).toMatchObject({state:'stale',configChanged:true,modifiedFiles:[]});
},30000);

const reportRuntime = process.env.PROGRAPH_TEST_REPORT_BASELINE_RUNTIME;
test.skipIf(!reportRuntime)("actual report writer upgrade hides unqualified owners and preserves reports, history and observations through GC", async () => {
  const receipt = JSON.parse(await readFile(path.join(reportRuntime!, "baseline-receipt.json"), "utf8"));
  expect(receipt.commit).toBe("892d91833cfd22639da3f34948969a24a1ea96bb");
  for (const [file, hash] of Object.entries(receipt.digests)) expect(digest(await readFile(path.join(reportRuntime!, "dist", file)))).toBe(hash);
  const old = await import(/* @vite-ignore */ pathToFileURL(path.join(reportRuntime!, "dist/core/analysis/analyze.js")).href) as typeof import("../src/core/analysis/analyze.js");
  const f = await fixture(false), first = await old.analyzeRepository(f.repository, { output: f.index });
  expect(first.manifest.semanticCore?.status, first.manifest.semanticCore?.reason).toBe("partial");
  await prepareAuthorityMigration(f.index,{storageOnly:true});
  const filename = path.join(f.index, "semantic.sqlite"), store = new SemanticStore(filename);
  let previous: number, report: string, claims: string;
  try {
    previous = store.activeSnapshot()!; store.pinSnapshot(previous, "report-upgrade");
    report = canonical(readSnapshotReport(store.db, previous));
    claims = digest(canonical(store.sql("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE snapshot=? ORDER BY c.key").all(previous)));
  } finally { store.close(); }
  await importScip(f.repository, f.artifact, f.manifest, f.index);
  expect(find(f.index, "target")).toHaveLength(0); expect(find(f.index, "target", previous)).toHaveLength(1);
  expect(owners(f.index).some(row => row.partition_key === "retention/gaps")).toBe(true);
  expect((await repositoryStatus(f.repository, f.index)).state).toBe("stale");
  expect((await syncRepository(f.repository, f.index)).statusAfter.state).toBe("fresh");
  const clean = path.join(f.root, "clean"); await analyzeRepository(f.repository, { output: clean });
  await importScip(f.repository, f.artifact, f.manifest, clean); await analyzeRepository(f.repository, { output: clean });
  const actual = await semanticSnapshot(f.index); expect(actual).toEqual(await semanticSnapshot(clean));
  const upgraded = new SemanticStore(filename);
  let pinnedGc: Record<string, number>, unpinnedGc: Record<string, number>;
  try {
    pinnedGc = collectSemanticGarbage(upgraded, { keep: 1 });
    expect(canonical(readSnapshotReport(upgraded.db, previous))).toBe(report);
    expect(digest(canonical(upgraded.sql("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE snapshot=? ORDER BY c.key").all(previous)))).toBe(claims);
    expect(upgraded.sql("SELECT COUNT(*) n FROM sc_observed_inputs").get()).toMatchObject({ n: expect.any(Number) });
    expect((upgraded.sql("SELECT COUNT(*) n FROM sc_observed_inputs").get() as {n:number}).n).toBeGreaterThan(0);
    upgraded.unpinSnapshot(previous, "report-upgrade");expect(releaseMigrationRetention(upgraded)).toBeGreaterThan(0); unpinnedGc = collectSemanticGarbage(upgraded, { keep: 1 });
    expect(readSnapshotReport(upgraded.db, previous)).toBeUndefined();
    expect(upgraded.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
  } finally { upgraded.close(); }
  expect(await semanticSnapshot(f.index)).toEqual(actual);
  if (process.env.PROGRAPH_TEST_RETENTION_UPGRADE_EVIDENCE) await writeFile(process.env.PROGRAPH_TEST_RETENTION_UPGRADE_EVIDENCE, `${JSON.stringify({ baseline: receipt, historicalClaimHash: claims, historicalReportHash: digest(report), cleanRebuildHash: digest(canonical(actual)), pinnedGc, unpinnedGc, freshness: "fresh" }, null, 2)}\n`);
}, 60000);
