import {releaseMigrationRetention} from "./oracles/migration-retention.js";
import {prepareAuthorityMigration} from "../src/core/semantic/authority-migration.js";
import{test,expect,vi,afterEach}from'vitest';
import{mkdtemp,mkdir,writeFile,rm,readFile}from'node:fs/promises';
import path from'node:path';import os from'node:os';
import{analyzeRepository}from'../src/core/analysis/analyze.js';import{compilerApiAdapter}from'../src/adapters/language/typescript/index.js';
import{semanticSnapshot}from'./oracles/semantic-snapshot.js';import{SemanticStore}from'../src/core/semantic/store.js';
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
async function fixture(analyze=true){const root=await mkdtemp(path.join(os.tmpdir(),'prograph-source-reuse-'));roots.push(root);const repo=path.join(root,'repo'),index=path.join(root,'index');await mkdir(repo);await writeFile(path.join(repo,'tsconfig.json'),'{"include":["*.ts"],"compilerOptions":{"strict":true}}');await writeFile(path.join(repo,'a.ts'),'export function target(){return 1} export function run(){return target()}');await writeFile(path.join(repo,'README.md'),'# Initial\n');if(analyze)await analyzeRepository(repo,{output:index});return{root,repo,index}}
test('documentation-only analysis reuses actual compiler observations and equals an independent rebuild',async()=>{
 const f=await fixture(),spy=vi.spyOn(compilerApiAdapter,'analyze');await writeFile(path.join(f.repo,'README.md'),'# Changed documentation\n');await analyzeRepository(f.repo,{output:f.index});expect(spy).not.toHaveBeenCalled();const clean=path.join(f.root,'clean');await analyzeRepository(f.repo,{output:clean});expect(spy).toHaveBeenCalledTimes(1);expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
},30000);
test('new module, source and excluded configuration edits rerun the compiler rather than reusing stale observations',async()=>{
 for(const mode of ['source','module','config']){const f=await fixture();await mkdir(path.join(f.repo,'build'));await writeFile(path.join(f.repo,'build/base.json'),'{"compilerOptions":{"strict":true}}');await writeFile(path.join(f.repo,'tsconfig.json'),'{"extends":"./build/base.json","include":["*.ts"]}');await analyzeRepository(f.repo,{output:f.index});const spy=vi.spyOn(compilerApiAdapter,'analyze');await writeFile(path.join(f.repo,mode==='source'?'a.ts':mode==='module'?'new.ts':'build/base.json'),mode==='config'?'{"compilerOptions":{"strict":false}}':'export function added(){return 2}');await analyzeRepository(f.repo,{output:f.index});expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();const clean=path.join(f.root,'clean');await analyzeRepository(f.repo,{output:clean});expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));}
},30000);
test('missing and unsupported observation receipts force a fresh compiler observation',async()=>{
 const f=await fixture(),db=new SemanticStore(path.join(f.index,'semantic.sqlite'));try{const run=(db.sql("SELECT run FROM sc_partitions WHERE snapshot=? AND partition_key='analysis/catalogue'").get(db.activeSnapshot())as{run:number}).run;db.sql("DELETE FROM sc_inputs WHERE run=? AND resource='environment:host'").run(run)}finally{db.close()}
 const spy=vi.spyOn(compilerApiAdapter,'analyze');await writeFile(path.join(f.repo,'README.md'),'# Changed\n');await analyzeRepository(f.repo,{output:f.index});expect(spy).toHaveBeenCalledTimes(1);
},30000);

test('an earlier excluded import target appearing invalidates reused observations without an importer edit',async()=>{
 const f=await fixture();await writeFile(path.join(f.repo,'a.ts'),'import {dep} from "./build/dep"; export function run(){return dep()}');await analyzeRepository(f.repo,{output:f.index});const spy=vi.spyOn(compilerApiAdapter,'analyze');await mkdir(path.join(f.repo,'build'));await writeFile(path.join(f.repo,'build/dep.ts'),'export function dep(){return 1}');await writeFile(path.join(f.repo,'README.md'),'# Changed\n');await analyzeRepository(f.repo,{output:f.index});expect(spy).toHaveBeenCalledTimes(1);const clean=path.join(f.root,'clean');await analyzeRepository(f.repo,{output:clean});expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
},30000);

test('compiler filesystem case policy participates in the semantic context identity',async()=>{
 const {ts}=await import('ts-morph');const {scanRepository}=await import('../src/core/repository/repository.js');const {discoverProjects}=await import('../src/core/semantic/projects.js');
 const f=await fixture(),scan=await scanRepository(f.repo,f.index),original=ts.sys.useCaseSensitiveFileNames;const before=discoverProjects(scan.snapshot).units.filter(unit=>unit.language==='typescript');
 try{ts.sys.useCaseSensitiveFileNames=!original;const after=discoverProjects(scan.snapshot).units.filter(unit=>unit.language==='typescript');expect(after.map(unit=>unit.context)).not.toEqual(before.map(unit=>unit.context));expect(after[0]!.options).toHaveProperty('compilerHost.caseSensitiveFileNames',!original)}finally{ts.sys.useCaseSensitiveFileNames=original}
},30000);

const retentionRuntime=process.env.PROGRAPH_TEST_RETENTION_BASELINE_RUNTIME;
test.skipIf(!retentionRuntime)('actual 2.12 writer policy upgrade invalidates unchanged schema inputs and preserves pinned history',async()=>{
 const {pathToFileURL}=await import('node:url'),{repositoryStatus}=await import('../src/core/analysis/state.js'),{syncRepository}=await import('../src/core/analysis/sync.js'),{canonical,digest}=await import('../src/core/semantic/model.js');
 const receipt=JSON.parse(await readFile(path.join(retentionRuntime!,'baseline-receipt.json'),'utf8'));expect(receipt.commit).toBe('d38b47b1f3fc0f917f9c1052c868fe29b92b173b');for(const[file,hash]of Object.entries(receipt.digests))expect(digest(await readFile(path.join(retentionRuntime!,'dist',file)))).toBe(hash);
 const old=await import(/* @vite-ignore */pathToFileURL(path.join(retentionRuntime!,'dist/core/analysis/analyze.js')).href)as typeof import('../src/core/analysis/analyze.js');
 const f=await fixture(false),first=await old.analyzeRepository(f.repo,{output:f.index});expect(first.manifest.semanticCore?.status,first.manifest.semanticCore?.reason).toBe('partial');
 const {SemanticStore:AcceptedStore}=await import(/* @vite-ignore */pathToFileURL(path.join(retentionRuntime!,'dist/core/semantic/store.js')).href)as typeof import('../src/core/semantic/store.js');
 const db=new AcceptedStore(path.join(f.index,'semantic.sqlite'));let snapshot:number,claims:string;
 try{snapshot=db.activeSnapshot()!;db.pinSnapshot(snapshot,'policy-upgrade');claims=digest(canonical(db.sql('SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key').all(snapshot)));expect(db.sql("SELECT value FROM sc_meta WHERE key='schema'").get()).toEqual({value:'2.0.0-step2.12'})}finally{db.close()}
 expect(await repositoryStatus(f.repo,f.index)).toMatchObject({state:'stale',schemaChanged:false,adapterVersionsChanged:true,modifiedFiles:[]});expect((await syncRepository(f.repo,f.index)).statusAfter.state).toBe('fresh');
 const clean=path.join(f.root,'clean');await analyzeRepository(f.repo,{output:clean});expect(await semanticSnapshot(f.index)).toEqual(await semanticSnapshot(clean));
 const after=new SemanticStore(path.join(f.index,'semantic.sqlite'));try{after.collectGarbage({keep:1});expect(digest(canonical(after.sql('SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key').all(snapshot)))).toBe(claims);after.unpinSnapshot(snapshot,'policy-upgrade');expect(releaseMigrationRetention(after)).toBeGreaterThan(0);after.collectGarbage({keep:1});expect(after.db.pragma('foreign_key_check')).toEqual([])}finally{after.close()}
},60000);
