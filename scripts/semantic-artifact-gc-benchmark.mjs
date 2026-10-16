// Build first. Offline artifact retention/recovery qualification, not publication or LOC scale.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,cp,stat,realpath,opendir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {SemanticStore} from '../dist/core/semantic/store.js';
import {createProviderWorkspace,collectIndexGarbage} from '../dist/core/semantic/provider-artifacts.js';
import {indexManagedProject} from '../dist/core/semantic/managed-scip.js';
import {SemanticQuery} from '../dist/core/semantic/query.js';
import {digest} from '../dist/core/semantic/model.js';

const output=process.argv[2]; if(!output) throw Error('Output receipt filename required');
const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'prograph-owned-artifact-bench-')));
const index=path.join(root,'.prograph');await mkdir(index);const filename=path.join(index,'semantic.sqlite');
const s=new SemanticStore(filename),runs=[],workspaces=[]; const body=Buffer.alloc(4096,0x78);
const setupStart=performance.now();
for(let i=0;i<1000;i++){
  const work=await createProviderWorkspace(index,root,'scip');workspaces.push(work);
  for(let j=0;j<10;j++)await writeFile(path.join(work,`evidence-${j}.bin`),body);
  if(i<10){const run=s.begin(`owner:${i}`,'ctx',`input:${i}`);s.input(run,`artifact:${work}/evidence-0.bin`,digest(body));s.seal(run,{});runs.push(run);}
}
const snapshot=s.publish(runs);s.close();const setupMs=performance.now()-setupStart;
const begin=performance.now();const collected=await collectIndexGarbage(filename,{keep:1});const elapsedMs=performance.now()-begin;
assert.equal(collected.artifacts.state,'complete');assert.equal(collected.artifacts.retained,10);assert.equal(collected.artifacts.deleted,990);
for(let i=0;i<1000;i++)assert.equal(existsSync(workspaces[i]),i<10);
const checked=new SemanticStore(filename);assert.equal(checked.activeSnapshot(),snapshot);assert.equal(checked.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(checked.db.pragma('foreign_key_check'),[]);checked.close();
const receipt={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,scope:'one serial offline maintenance sample; separate from publication/LOC/provider throughput; setup not timed as GC',root,synthetic:{shape:{workspaces:1000,filesPerWorkspace:10,payloadBytesPerFile:4096,retained:10},setupMs,gcMs:elapsedMs,result:collected,allWorkspaceExistenceChecks:true,integrity:'ok',foreignKeys:[]}};

if(process.argv[3]){
  const original=await realpath(process.argv[3]);const configuration=path.resolve(original,process.argv[4]??'semantic-project.json');const config=JSON.parse(await readFile(configuration,'utf8'));
  assert.equal(path.basename(original),'jsoup-4cf664cdb2e9d2cc2d40fdf3bb9c0be0be22f865','Use the recorded pinned jsoup corpus');
  assert.equal(config.language,'java','This retained real-repository experiment qualifies Java only');assert.notEqual(config.root,'.');
  const repository=path.join(root,'real-jsoup');await mkdir(repository);await cp(path.join(original,config.root),path.join(repository,config.root),{recursive:true});
  await writeFile(path.join(repository,'semantic-project.json'),JSON.stringify(config));await writeFile(path.join(repository,'pom.xml'),await readFile(path.join(original,'pom.xml')));
  const realIndex=path.join(root,'real-index'),results=[];
  results.push(await indexManagedProject(repository,'semantic-project.json',realIndex));
  results.push(await indexManagedProject(repository,'semantic-project.json',realIndex));
  const db=path.join(realIndex,'semantic.sqlite');const owners=new SemanticStore(db);const first=Number(results[0].snapshot);owners.pinSnapshot(first,'artifact-benchmark');
  const files=owners.sql("SELECT DISTINCT s.path FROM sc_sources s JOIN sc_occurrences o ON o.source=s.id WHERE s.path LIKE '%.java' ORDER BY s.path").all().map(row=>row.path);
  const allSources=[];const visit=async directory=>{for await(const entry of await opendir(directory)){const file=path.join(directory,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&file.endsWith('.java'))allSources.push(path.relative(repository,file));}};await visit(path.join(repository,config.root));allSources.sort();
  const beforeSources=new Map();let sourceLines=0;for(const file of allSources){const bytes=await readFile(path.join(repository,file));beforeSources.set(file,digest(bytes));sourceLines+=bytes.toString('utf8').split('\n').length-1;}owners.close();
  const edited=files[0],source=await readFile(path.join(repository,edited));
  try{await writeFile(path.join(repository,edited),Buffer.concat([source,Buffer.from('\n// owned artifact retention probe\n')]));results.push(await indexManagedProject(repository,'semantic-project.json',realIndex));}
  finally{await writeFile(path.join(repository,edited),source);}
  const measure=new SemanticStore(db);const active=measure.activeSnapshot();
  const facts=epoch=>{const hash=createHash('sha256');let claims=0;for(const row of measure.sql('SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key').iterate(epoch)){hash.update(row.key+'\n');claims++;}return{claims,hash:hash.digest('hex')};};
  const samples=epoch=>{const q=new SemanticQuery(db);try{const found=q.execute('find','Jsoup',{snapshot:epoch}).items;assert.ok(found.length);return{found,queries:found.slice(0,3).map(symbol=>Object.fromEntries(['definition','references','callers','callees'].map(operation=>[operation,q.execute(operation,symbol.key,{snapshot:epoch}).items])))};}finally{q.close();}};
  const before={active:facts(active),pinned:facts(first),samples:{active:samples(active),pinned:samples(first)}};measure.close();
  const abandoned=await createProviderWorkspace(realIndex,repository,'java');await writeFile(path.join(abandoned,'orphan.bin'),body);
  const start=performance.now();const result=await collectIndexGarbage(db,{keep:1});const gcMs=performance.now()-start;
  assert.equal(result.artifacts.state,'complete');assert.equal(existsSync(abandoned),false);
  const afterStore=new SemanticStore(db);const afterFacts=epoch=>{const hash=createHash('sha256');let claims=0;for(const row of afterStore.sql('SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key').iterate(epoch)){hash.update(row.key+'\n');claims++;}return{claims,hash:hash.digest('hex')};};
  const after={active:afterFacts(active),pinned:afterFacts(first),samples:{active:samples(active),pinned:samples(first)}};assert.deepEqual(after,before);
  const artifacts=afterStore.sql("SELECT resource,digest FROM sc_inputs WHERE resource LIKE 'artifact:%' UNION SELECT json_extract(i.value,'$.resource') AS resource,json_extract(i.value,'$.digest') AS digest FROM sc_origin_runs r,json_each(r.inputs_json) i WHERE resource LIKE 'artifact:%'").all();
  for(const artifact of artifacts)assert.equal(digest(await readFile(artifact.resource.slice(9))),artifact.digest);
  assert.equal(afterStore.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(afterStore.db.pragma('foreign_key_check'),[]);
  const pragmas=Object.fromEntries(['journal_mode','synchronous'].map(key=>[key,afterStore.db.pragma(key,{simple:true})]));afterStore.close();
  for(const [file,hash]of beforeSources)assert.equal(digest(await readFile(path.join(repository,file))),hash);
  receipt.real={upstreamDirectory:original,upstreamRevision:'4cf664cdb2e9d2cc2d40fdf3bb9c0be0be22f865',repository,selectedJavaFiles:allSources.length,occurrenceBearingJavaFiles:files.length,sourceLines,scope:'copied jsoup Java8 source slice, explicit pinned JDK21/scip-java/classpath; original source untouched; one serial warm sample, compiler child RSS not measured',results,gcMs,result,before,after,retainedArtifactFiles:artifacts.length,retainedArtifactDigestsVerified:true,sourceCopyRestored:true,pragmas,integrity:'ok',foreignKeys:[],databaseBytes:(await stat(db)).size};
  receipt.real.sourceLineMethod='newline count; trailing empty split element excluded (older split-based 29,969 count includes 96 terminal empty entries)';
}
receipt.nodePeakRssKiB=process.resourceUsage().maxRSS;await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({output,synthetic:receipt.synthetic.gcMs,real:receipt.real?.gcMs}));
