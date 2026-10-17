/** Reuse observations only when their actual compiler input receipt still agrees. */
import Database from "better-sqlite3";
import { ADAPTER_VERSIONS } from "../analysis/state.js";
import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import { canonical,digest,SEMANTIC_FORMAT_VERSION,READABLE_SEMANTIC_SCHEMAS } from "./model.js";
import { semanticInventory } from "./provider-runs.js";
import { inputMatches,type RecordedInput } from "./input-check.js";
import { readSyntaxProjection } from "./owned-projection.js";
import { readSnapshotReport } from "./snapshot-report.js";
export async function reuseTypeScriptObservations(filename:string,snapshot:RepositorySnapshot) {
  if(!snapshot.config.adapters.typescript)return undefined;
  let db:Database.Database|undefined;
  try {
    db=new Database(filename,{readonly:true,fileMustExist:true});db.exec("BEGIN");
    const format=db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as {value:string}|undefined;
    const schema=db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as {value:string}|undefined;
    if(format?.value!==String(SEMANTIC_FORMAT_VERSION)||!(READABLE_SEMANTIC_SCHEMAS as readonly string[]).includes(schema?.value??""))return undefined;
    const active=db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as {value:string}|undefined;
    const id=Number(active?.value);if(!Number.isSafeInteger(id)||id<1)return undefined;
    const report=readSnapshotReport(db,id),run=report?.manifest.adapterRuns?.find(run=>run.adapter==='typescript');
    if(!run?.detected||report?.manifest.repositoryIdentity!==snapshot.repository.identity||report.manifest.repositoryRoot!==snapshot.repository.root)return undefined;
    const catalogue=db.prepare("SELECT r.id,r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key='analysis/catalogue'").get(id) as {id:number;input_fingerprint:string}|undefined;
    if(!catalogue||catalogue.input_fingerprint!==report.sourceCatalogue)return undefined;
    const inputs=db.prepare("SELECT resource,digest FROM sc_inputs WHERE run=? LIMIT 100001").all(catalogue.id) as RecordedInput[];
    if(inputs.length>100000)return undefined;
    const values=new Map(inputs.map(input=>[input.resource,input.digest]));
    if(values.get('source-inputs-qualified')!=='true'||values.get('project-inventory')!==semanticInventory(snapshot)||values.get('analysis-versions')!==digest(canonical(ADAPTER_VERSIONS))||values.get('configuration:prograph')!==snapshot.configurationInput||values.get(`probe-realpath:${snapshot.repository.root}`)!==digest(snapshot.sourceRoot!))return undefined;
    if(!values.has('environment:host')||!values.has('environment:cwd')||!values.has('environment:node'))return undefined;
    for(const input of inputs) {
      if(['source-inventory','project-inventory','source-inputs-qualified','analysis-versions'].includes(input.resource)||input.resource.startsWith('source-root:'))continue;
      if(!/^(?:source:|physical:|artifact:|tree:|probe-)/.test(input.resource)&&!['configuration:prograph','environment:host','environment:cwd','environment:node'].includes(input.resource))return undefined;
      if(!await inputMatches(input,snapshot.repository.root))return undefined;
    }
    const statements=new Map<string,Database.Statement>();
    const source=readSyntaxProjection({sql:sql=>{let statement=statements.get(sql);if(!statement){statement=db!.prepare(sql);statements.set(sql,statement)}return statement}},id)?.result;
    if(!source?.inputReceipt?.qualified)return undefined;
    const nodes=source.nodes.filter(node=>node.adapter==='typescript'),ids=new Set(nodes.map(node=>node.id));
    if(source.edges.some(edge=>ids.has(edge.source)!==ids.has(edge.target)))return undefined;
    const result:AdapterResult={nodes,edges:source.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),diagnostics:source.diagnostics.filter(diagnostic=>diagnostic.adapter==='typescript'),metadata:run.metadata??{},inputReceipt:source.inputReceipt};
    return {result,run:{...run,durationMs:0}};
  }catch{return undefined}finally{if(db?.open){if(db.inTransaction)db.exec('ROLLBACK');db.close()}}
}
