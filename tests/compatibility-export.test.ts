import Database from 'better-sqlite3';
import {test,expect,afterEach}from"vitest";
import path from"node:path";
import os from"node:os";
import{mkdtemp,mkdir,writeFile,rm,readFile,lstat,readdir,readlink}from"node:fs/promises";
import{analyzeRepository}from"../src/core/analysis/analyze.js";
import{exportCompatibilitySnapshot}from"../src/core/semantic/compatibility-export.js";
import{QueryService}from"../src/core/query/query-service.js";
import{execFile}from"node:child_process";
import{promisify}from"node:util";
import{digest}from"../src/core/semantic/model.js";
const cleanup:string[]=[];afterEach(async()=>{for(const p of cleanup.splice(0))await rm(p,{recursive:true,force:true})});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'prograph-compat-export-'));cleanup.push(root);const index=path.join(root,'index'),output=path.join(root,'output');const analyzed=await analyzeRepository(path.resolve('tests/fixtures/mixed'),{output:index});return{root,index,output,analyzed}}
test('durable compatibility export is installed atomically and needs no source graph or repository reads',async()=>{
 const f=await fixture(),file=path.join(f.index,'semantic.sqlite'),before=digest(await readFile(file));
 await rm(path.join(f.index,'graph.sqlite'));await rm(path.join(f.index,'exports'),{recursive:true});await rm(path.join(f.index,'manifest.json'));
 const result=await exportCompatibilitySnapshot(f.index,f.output);expect((await lstat(f.output)).isSymbolicLink()).toBe(true);expect(result.counts).toMatchObject({nodes:f.analyzed.graph.nodes.length,edges:f.analyzed.graph.edges.length});
 expect(digest(await readFile(file))).toBe(before);const q=new QueryService(path.join(f.output,'graph.sqlite'));try{expect(q.overview({scope:'full'})).toHaveProperty('counts.nodes',f.analyzed.graph.nodes.length);expect(q.searchSymbols('App').length).toBeGreaterThan(0);expect(q.architecture(100).nodes.length).toBeGreaterThan(0)}finally{q.close()}
 expect(JSON.parse(await readFile(path.join(f.output,'manifest.json'),'utf8'))).toHaveProperty('semanticCore.status','unavailable');
},30000);
test('existing targets and source ancestors are refused without replacing user content',async()=>{
 const f=await fixture();await mkdir(f.output);await writeFile(path.join(f.output,'user.txt'),'keep');await expect(exportCompatibilitySnapshot(f.index,f.output)).rejects.toThrow(/already exists/);expect(await readFile(path.join(f.output,'user.txt'),'utf8')).toBe('keep');await expect(exportCompatibilitySnapshot(f.index,f.index)).rejects.toThrow(/source index/);await expect(exportCompatibilitySnapshot(f.index,f.root)).rejects.toThrow(/source index/);
},30000);
test('competing exports never overwrite a published complete generation',async()=>{
 const f=await fixture();const outcomes=await Promise.allSettled([exportCompatibilitySnapshot(f.index,f.output),exportCompatibilitySnapshot(f.index,f.output)]);expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
 const target=await readlink(f.output);expect((await readdir(f.root)).filter(x=>x.startsWith('.output.generation-'))).toEqual([target]);expect(JSON.parse(await readFile(path.join(f.output,'exports/graph.json'),'utf8')).nodes.length).toBe(f.analyzed.graph.nodes.length);
},30000);

test('isolated CLI exports a pinned historical snapshot through a custom sqlite path without an available source repository',async()=>{
 const f=await fixture();const run=promisify(execFile);
 const sourceDb=new Database(path.join(f.index,'semantic.sqlite'),{readonly:true});try{await sourceDb.backup(path.join(f.index,'custom-core.sqlite'))}finally{sourceDb.close()}await rm(path.join(f.index,'semantic.sqlite'));
 const {stdout}=await run(process.execPath,[path.resolve('dist/cli/index.js'),'semantic','export-compat',path.join(f.root,'missing-repository'),'--index',path.join(f.index,'custom-core.sqlite'),'--output',f.output,'--snapshot',String(f.analyzed.manifest.semanticCore!.snapshot),'--format','json'],{timeout:60000,maxBuffer:1024**2});
 expect(JSON.parse(stdout)).toHaveProperty('counts.nodes',f.analyzed.graph.nodes.length);
 const q=new QueryService(path.join(f.output,'graph.sqlite'));try{expect(q.files({scope:'full'}).length).toBeGreaterThan(0)}finally{q.close()}
},30000);
