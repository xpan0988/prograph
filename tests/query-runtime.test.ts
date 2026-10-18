import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { queryServiceForRepository, QueryService, scopedEdges, scopedNodes, type ConfidenceQuery } from "../src/core/query/query-service.js";
import { graphNodeFromRow, graphEdgeFromRow, type NodeRow, type EdgeRow } from "../src/core/storage/sqlite.js";
import type { GraphNode, GraphEdge, GraphScope } from "../src/core/graph/schema.js";
import { executeRead } from "../src/core/query/isolation.js";
import { NavigationRead } from "../src/core/query/navigation.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { startServer } from "../src/server/index.js";
import { formatQueryOutput } from "../src/core/query/output-mode.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-query-work-")); roots.push(root);
  const file = path.join(root, "graph.sqlite"); const db = new Database(file);
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,language TEXT,file TEXT,start_line INTEGER,start_column INTEGER,end_line INTEGER,end_column INTEGER,adapter TEXT,metadata_json TEXT);CREATE INDEX idx_nodes_file ON nodes(file);CREATE TABLE edges(id TEXT PRIMARY KEY,source TEXT,target TEXT,kind TEXT,confidence TEXT,evidence_json TEXT,metadata_json TEXT);CREATE INDEX idx_edges_source ON edges(source);CREATE INDEX idx_edges_target ON edges(target)");
  const nodes: GraphNode[] = Array.from({length:80},(_,i)=>({id:`symbol:${i}`,kind:i%9===0?"concept":"function",name:`n${i}`,qualifiedName:`n${i}`,file:`src/${i%8}.ts`,startLine:i%13,adapter:"test",metadata:i%9===0?{graphDomain:"knowledge",sourceCategory:["docs","config","tests"][i%3]}:{}}));
  // Deterministic seeded corpus; reverse edge IDs deliberately disagree with insertion order.
  let seed=29117; const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  const edges: GraphEdge[] = Array.from({length:400},(_,i)=>({id:`edge:${400-i}`,source:nodes[random()%nodes.length]!.id,target:nodes[random()%nodes.length]!.id,kind:(["calls","imports","uses_type","mentions","tests"] as const)[i%5]!,confidence:(["exact","resolved","probable","unresolved"] as const)[i%4]!,evidence:[],metadata:i%11===0?{graphDomain:"knowledge"}:{}}));
  db.transaction(()=>{
    const n=db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"); for(const node of nodes)n.run(node.id,node.kind,node.name,node.qualifiedName,null,node.file,node.startLine,null,null,null,node.adapter,JSON.stringify(node.metadata));
    const e=db.prepare("INSERT INTO edges VALUES (?,?,?,?,?,?,?)"); for(const edge of edges)e.run(edge.id,edge.source,edge.target,edge.kind,edge.confidence,"[]",JSON.stringify(edge.metadata));
  })(); db.close(); return {file,nodes,edges};
}
test("indexed navigation matches former scan semantics across scopes, confidence and traversal limits",async()=>{
  const {file,nodes,edges}=await fixture(); const q=new QueryService(file);
  const selectedNodes=(ids:Set<string>)=>(q.database.prepare(`SELECT * FROM nodes WHERE id IN (${[...ids].map(()=>"?")})`).all(...ids) as NodeRow[]).map(graphNodeFromRow);
  try {
    // Fails if these navigation paths accidentally return to whole-graph hydration.
    Object.assign(q, { allNodes() { throw Error("global nodes"); } });
    Object.assign(q, { allEdges() { throw Error("global edges"); } });
    for(const scope of ["code","code+docs","code+config","code+tests","full"] as GraphScope[]) for(const includeUnresolved of [false,true]) {
      const options:ConfidenceQuery={scope,includeUnresolved}; const visible=scopedEdges(edges,nodes,options);
      for(const id of ["symbol:1","symbol:9","symbol:43"]) {
        const callerEdges=visible.filter(e=>e.target===id&&(scope!=="code"||["calls","invokes","renders","listens"].includes(e.kind))).slice(0,7);
        const calleeEdges=visible.filter(e=>e.source===id&&(scope!=="code"||["calls","invokes","renders","emits","uses_type"].includes(e.kind))).slice(0,7);
        expect(q.callers(id,7,options).edges).toEqual(callerEdges); expect(q.callees(id,7,options).edges).toEqual(calleeEdges);
        for(const maxNodes of [3,17,50]) {
          const ids=new Set([id]);let frontier=new Set([id]);let truncated=false;const chosen=new Map<string,GraphEdge>();
          for(let depth=0;depth<3;depth++) { const next=new Set<string>(); for(const edge of visible) {
            if(!frontier.has(edge.source)&&!frontier.has(edge.target))continue; const candidate=frontier.has(edge.source)?edge.target:edge.source;
            if(ids.size>=maxNodes&&!ids.has(candidate)){truncated=true;continue;}ids.add(candidate);next.add(candidate);chosen.set(edge.id,edge);
          }frontier=next; }
          const resultNodes=scopedNodes(selectedNodes(ids),options);const finalIds=new Set(resultNodes.map(n=>n.id));const finalEdges=[...chosen.values()].filter(e=>finalIds.has(e.source)&&finalIds.has(e.target));
          expect(q.neighborhood(id,{...options,depth:3,maxNodes,maxEdges:9})).toEqual({center:q.symbol(id),nodes:resultNodes,edges:finalEdges.slice(0,9),truncated:truncated||finalEdges.length>9});
        }
      }
    }
    for(const column of ["source","target"]) {
      const plan=q.database.prepare(`EXPLAIN QUERY PLAN SELECT rowid,* FROM edges INDEXED BY idx_edges_${column} WHERE ${column}=? AND rowid>? ORDER BY rowid LIMIT ?`).all("symbol:1",0,32) as Array<{detail:string}>;
      expect(plan.some(p=>p.detail.includes(`idx_edges_${column}`))).toBe(true);expect(plan.some(p=>p.detail.includes("TEMP B-TREE"))).toBe(false);
    }
    const fileNodes = (q.database.prepare("SELECT * FROM nodes WHERE file=? ORDER BY start_line,name").all("src/1.ts") as NodeRow[]).map(graphNodeFromRow);
    const ids=fileNodes.map(n=>n.id);const placeholders=ids.map(()=>"?").join(",");
    const oldEdges=scopedEdges((q.database.prepare(`SELECT * FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).all(...ids,...ids) as EdgeRow[]).map(graphEdgeFromRow),nodes,{scope:"full",includeUnresolved:true});
    expect(q.fileDetails("src/1.ts",{scope:"full",includeUnresolved:true})).toEqual({file:"src/1.ts",nodes:fileNodes,dependencies:oldEdges.filter(e=>ids.includes(e.source)),reverseDependencies:oldEdges.filter(e=>ids.includes(e.target))});
  }finally{q.close();}
});
test("rejected raw candidates, payload, cancellation and time consume actual navigation budgets",async()=>{
  const {file}=await fixture();
  for(const limits of [{maxCandidates:1},{maxPayloadBytes:1},{deadlineMs:1,signal:AbortSignal.abort()}]) {
    const q=new QueryService(file,limits); try{expect(()=>q.neighborhood("symbol:1",{depth:3,scope:"full"})).toThrow(/budget exceeded/);}finally{q.close();}
  }
  const q=new QueryService(file); const read=new NavigationRead(q.database,{deadlineMs:1});
  await new Promise(resolve=>setTimeout(resolve,10));
  try { expect(()=>read.node("symbol:1")).toThrow(/deadline/); } finally {q.close();}
});
test("confidence-rejected adjacency rows still consume candidate work",async()=>{
  const {file}=await fixture();const db=new Database(file);
  db.exec("INSERT INTO nodes SELECT 'symbol:hot',kind,name,qualified_name,language,file,start_line,start_column,end_line,end_column,adapter,metadata_json FROM nodes LIMIT 1");
  const insert=db.prepare("INSERT INTO edges VALUES (?,?,'symbol:hot','calls','unresolved','[]','{}')");
  db.transaction(()=>{for(let i=0;i<100;i++)insert.run(`filtered:${i}`,"symbol:1");})();db.close();
  const q=new QueryService(file,{maxCandidates:25});try{expect(()=>q.callers("symbol:hot")).toThrow(/candidates budget/);}finally{q.close();}
});
test("read workers enforce deadlines during native SQL and recover for subsequent reads",async()=>{
  const {file}=await fixture();const db=new Database(file);
  db.exec("DROP TABLE nodes; CREATE VIEW nodes AS WITH RECURSIVE spin(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM spin WHERE n<1000000000) SELECT CAST(n AS TEXT) AS id,n AS kind,n AS name,n AS qualified_name,NULL AS language,NULL AS file,NULL AS start_line,NULL AS start_column,NULL AS end_line,NULL AS end_column,'test' AS adapter,'{}' AS metadata_json FROM spin");db.close();
  let heartbeat=false;const timer=setTimeout(()=>{heartbeat=true;},50);
  try{await expect(executeRead(file,"legacy","symbol",["missing"],undefined,{timeoutMs:700})).rejects.toMatchObject({code:"QUERY_DEADLINE"});expect(heartbeat).toBe(true);}finally{clearTimeout(timer);}
  const controller=new AbortController();const running=executeRead(file,"legacy","symbol",["missing"],undefined,{signal:controller.signal});setTimeout(()=>controller.abort(),250);
  await expect(running).rejects.toMatchObject({code:"QUERY_CANCELLED"});
  const good=await fixture();expect(await executeRead(good.file,"legacy","symbol",["symbol:1"])).toMatchObject({id:"symbol:1"});
});
test("read admission is bounded and cancellation drains queued requests",async()=>{
  const {file}=await fixture();const controller=new AbortController();
  const all=Promise.allSettled(Array.from({length:19},()=>executeRead(file,"legacy","symbol",["symbol:1"],undefined,{signal:controller.signal})));
  controller.abort();const results=await all;
  expect(results.some(r=>r.status==="rejected"&&r.reason.code==="QUERY_BUSY")).toBe(true);
  expect(results.every(r=>r.status==="rejected"&&["QUERY_CANCELLED","QUERY_BUSY"].includes(r.reason.code))).toBe(true);
  await expect(executeRead(file,"legacy","symbol",["symbol:1"],undefined,{signal:AbortSignal.abort()})).rejects.toMatchObject({code:"QUERY_CANCELLED"});
  expect(await executeRead(file,"legacy","symbol",["symbol:1"])).toMatchObject({id:"symbol:1"});
});
test("isolated HTTP and CLI navigation preserve shared full-output contracts",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"prograph-query-transports-"));roots.push(root);
  const repository=path.resolve("tests/fixtures/mixed");await analyzeRepository(repository,{output:root});
  const q=await queryServiceForRepository(repository,root);const id=q.searchSymbols("formatGreeting",1)[0]!.id;
  const {server}=await startServer(repository,{index:root,port:0});const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
  try {
    for(const [suffix,value] of [["callers",q.callers(id)],["callees",q.callees(id)],["neighborhood",q.neighborhood(id)]] as const) {
      const response=await fetch(`${base}/api/symbols/${id}/${suffix}?mode=full`);expect(response.status).toBe(200);expect(await response.json()).toEqual(JSON.parse(JSON.stringify(formatQueryOutput(value,{mode:"full"}))));
    }
    const response=await fetch(`${base}/api/affected?input=${encodeURIComponent(id)}&mode=full`);expect(response.status).toBe(200);expect(await response.json()).toEqual(JSON.parse(JSON.stringify(formatQueryOutput(q.affected(id),{mode:"full"}))));
    const result=await promisify(execFile)(process.execPath,["dist/cli/index.js","callers",id,"--repo",repository,"--index",root,"--format","json","--mode","full"]);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(formatQueryOutput(q.callers(id),{mode:"full"}))));
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));q.close();}
},30000);
