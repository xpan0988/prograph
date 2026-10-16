// Build first. Pinned cJSON C99 slice; no repository build system is executed.
import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import{readFile,writeFile,mkdtemp}from'node:fs/promises';import path from'node:path';import os from'node:os';
import{analyzeRepository}from'../dist/core/analysis/analyze.js';import{syncRepository}from'../dist/core/analysis/sync.js';
import{scanRepository}from'../dist/core/repository/repository.js';import{discoverProjects}from'../dist/core/semantic/projects.js';
import{indexClang}from'../dist/core/semantic/clang.js';import{SemanticStore}from'../dist/core/semantic/store.js';import{SemanticQuery}from'../dist/core/semantic/query.js';
import{digest}from'../dist/core/semantic/model.js';
const [root,output]=process.argv.slice(2);if(!root||!output)throw Error('Repository and output receipt required');
const input=JSON.parse(await readFile(path.join(root,'qualification-inputs.json'),'utf8'));assert.equal(input.commit,'c859b25da02955fef659d658b8f324b5cde87be3');
for(const[file,receipt]of Object.entries(input.files))assert.equal(digest(await readFile(path.join(root,file))),receipt.sha256);
const start=performance.now(),record={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,input,repository:root,scope:'cJSON.c/cJSON.h from v1.7.19; fixed Clang C99 syntax-only context; warm local sample, not full project/build/platform qualification; child/compiler RSS not measured'};
function native(index=path.join(root,'.prograph')){const s=new SemanticStore(path.join(index,'semantic.sqlite'));try{const snapshot=s.activeSnapshot();const hash=createHash('sha256');let claims=0;for(const row of s.sql("SELECT DISTINCT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_owned o ON o.claim=c.id JOIN sc_partitions p ON p.run=o.run AND p.snapshot=a.snapshot WHERE a.snapshot=? AND p.partition_key LIKE 'clang/%' ORDER BY c.key").iterate(snapshot)){hash.update(row.key+'\n');claims++;}return{snapshot,claims,hash:hash.digest('hex'),runs:s.sql("SELECT p.partition_key,p.run FROM sc_partitions p WHERE p.snapshot=? AND p.partition_key LIKE 'clang/%' ORDER BY p.partition_key").all(snapshot),coverage:s.sql("SELECT r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'clang/%' ORDER BY p.partition_key").all(snapshot).map(row=>JSON.parse(row.coverage_json))};}finally{s.close();}}
const header=await readFile(path.join(root,'cJSON.h')),readme=await readFile(path.join(root,'README.md'));
try{
  await analyzeRepository(root);const unit=discoverProjects((await scanRepository(root)).snapshot).units.find(unit=>unit.language==='c'&&unit.sources[0]==='cJSON.c');assert.ok(unit);
  record.first=await indexClang(root,unit.key);await analyzeRepository(root);const before=native();
  await writeFile(path.join(root,'README.md'),Buffer.concat([readme,Buffer.from('\nArtifact-independent documentation probe\n')]));
  const docsStart=performance.now();const documentation=await syncRepository(root);record.documentation={elapsedMs:performance.now()-docsStart,state:documentation.statusAfter.state,reusedNativeOwners:JSON.stringify(native().runs)===JSON.stringify(before.runs)};
  await writeFile(path.join(root,'cJSON.h'),Buffer.concat([header,Buffer.from('\n/* header dependency qualification probe */\n')]));
  const editStart=performance.now();const edit=await syncRepository(root);record.headerEdit={elapsedMs:performance.now()-editStart,state:edit.statusAfter.state,native:native()};
  const clean=await mkdtemp(path.join(os.tmpdir(),'prograph-cjson-clean-'));await indexClang(root,unit.key,clean);const oracle=native(clean);assert.equal(oracle.hash,record.headerEdit.native.hash);assert.equal(oracle.claims,record.headerEdit.native.claims);record.cleanOracle={index:clean,hash:oracle.hash,claims:oracle.claims,exactVisibleClaimKeys:true};
  const q=new SemanticQuery(path.join(root,'.prograph/semantic.sqlite'));try{const found=q.execute('find','cJSON_Parse').items;assert.ok(found.length);record.navigation=found.map(symbol=>({key:symbol.key,definition:q.execute('definition',symbol.key).items.length,callers:q.execute('callers',symbol.key).items.length,callees:q.execute('callees',symbol.key).items.length}));}finally{q.close();}
  record.integrity={};const s=new SemanticStore(path.join(root,'.prograph/semantic.sqlite'));try{record.integrity.check=s.db.pragma('integrity_check',{simple:true});record.integrity.foreignKeys=s.db.pragma('foreign_key_check');assert.equal(record.integrity.check,'ok');assert.deepEqual(record.integrity.foreignKeys,[]);}finally{s.close();}
  record.qualification='partial-compiler-observations';record.negativeSearches=record.first.coverage.negativeSearches;
}catch(error){record.qualification='unavailable';record.reason=String(error).slice(0,1024);}
finally{await writeFile(path.join(root,'cJSON.h'),header);await writeFile(path.join(root,'README.md'),readme);}
for(const[file,receipt]of Object.entries(input.files))assert.equal(digest(await readFile(path.join(root,file))),receipt.sha256);
record.originalSourcesRestored=true;record.finalIndexState='historical after restoring benchmark header/docs edits; no final freshness claim';record.elapsedMs=performance.now()-start;record.nodePeakRssKiB=process.resourceUsage().maxRSS;
await writeFile(output,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({output,qualification:record.qualification,negativeSearches:record.negativeSearches,reason:record.reason,firstMs:record.first?.durationMs,documentation:record.documentation,headerEditMs:record.headerEdit?.elapsedMs,oracle:record.cleanOracle?.exactVisibleClaimKeys}));
