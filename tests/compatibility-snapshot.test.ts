import {test,expect,afterEach} from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import {mkdtemp,mkdir,writeFile,rm,readFile} from "node:fs/promises";
import {analyzeRepository} from "../src/core/analysis/analyze.js";
import {readCompatibilitySnapshot} from "../src/core/semantic/compatibility-snapshot.js";
import {SemanticStore} from "../src/core/semantic/store.js";
import {canonical,digest} from "../src/core/semantic/model.js";
const cleanup:string[]=[];afterEach(async()=>{for(const root of cleanup.splice(0))await rm(root,{recursive:true,force:true})});
const normalize=(g:{nodes:unknown[];edges:unknown[];diagnostics:unknown[]})=>Object.fromEntries(Object.entries(g).filter(([key])=>['nodes','edges','diagnostics'].includes(key)).map(([key,value])=>[key,(value as unknown[]).map(value=>canonical(JSON.parse(JSON.stringify(value)))).sort()]));
test('reconstructs complete legacy payload sets from selected supported facts and durable metadata',async()=>{
 const out=await mkdtemp(path.join(os.tmpdir(),'prograph-compat-'));cleanup.push(out);
 const actual=await analyzeRepository(path.resolve('tests/fixtures/mixed'),{output:out});expect(actual.manifest.semanticCore?.status,actual.manifest.semanticCore?.reason).toBe('partial');
 const db=new Database(path.join(out,'semantic.sqlite'),{readonly:true,fileMustExist:true});try{
  const read=db.transaction(()=>readCompatibilitySnapshot(db,actual.manifest.semanticCore!.snapshot!)).deferred();
  expect(normalize(read.graph)).toEqual(normalize(actual.graph));expect(read.state.files).toEqual(JSON.parse(await readFile(path.join(out,'state.json'),'utf8')).files);
 }finally{db.close()}
},30000);
test('historical reconstruction survives source deletion and uses no compatibility export or source graph as authority',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prograph-compat-history-'));cleanup.push(root);const repo=path.join(root,'repo'),index=path.join(root,'index');await mkdir(repo);
 await writeFile(path.join(repo,'a.ts'),'export function run(){return 1}');const first=await analyzeRepository(repo,{output:index});
 const store=new SemanticStore(path.join(index,'semantic.sqlite'));store.pinSnapshot(first.manifest.semanticCore!.snapshot!,'test');store.close();
 await writeFile(path.join(repo,'a.ts'),'export function replacement(){return 2}');await analyzeRepository(repo,{output:index});await rm(repo,{recursive:true});await rm(path.join(index,'graph.sqlite'));await rm(path.join(index,'exports'),{recursive:true});await rm(path.join(index,'manifest.json'));
 const db=new Database(path.join(index,'semantic.sqlite'),{readonly:true,fileMustExist:true});try{expect(normalize(db.transaction(()=>readCompatibilitySnapshot(db,first.manifest.semanticCore!.snapshot!)).deferred().graph)).toEqual(normalize(first.graph));}finally{db.close()}
},30000);
test('unchanged-byte report and fact database remain untouched by offline reconstruction',async()=>{
 const out=await mkdtemp(path.join(os.tmpdir(),'prograph-compat-readonly-'));cleanup.push(out);const result=await analyzeRepository(path.resolve('tests/fixtures/mixed'),{output:out});
 const file=path.join(out,'semantic.sqlite'),before=digest(await readFile(file));const db=new Database(file,{readonly:true,fileMustExist:true});try{db.transaction(()=>readCompatibilitySnapshot(db,result.manifest.semanticCore!.snapshot!)).deferred()}finally{db.close()}
 expect(digest(await readFile(file))).toBe(before);
},30000);
