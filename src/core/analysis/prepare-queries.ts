import {resolveCompatibilityDatabase} from "../semantic/authority.js";
import path from "node:path";
import { IndexLease } from "../semantic/maintenance-lock.js";
import { prepareCompatibilityCycles } from "../query/compatibility-cycles.js";
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { GLOBAL_QUERY_SQL, GLOBAL_QUERY_VERSION, materializeGlobalQueries } from "../query/global-projections.js";
import { graphNodeFromRow, graphEdgeFromRow, diagnosticFromRow, type NodeRow, type EdgeRow, type DiagnosticRow } from "../storage/sqlite.js";

/** Explicit offline maintenance: no compiler, provider, build or source write is performed. */
export function prepareQueryIndex(filename: string): Record<string, unknown> {
  filename=resolveCompatibilityDatabase(filename);
  const started = performance.now(); const lease=new IndexLease(path.dirname(filename),"work");let db:Database.Database|undefined;
  try{db=new Database(filename,{fileMustExist:true})}catch(error){lease.close();throw error}
  try {
    db.pragma("synchronous=FULL");
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get()){const result=db.transaction(()=>prepareCompatibilityCycles(db!)).immediate();return{filename,...result,durationMs:Math.round(performance.now()-started)}}
    db.exec(GLOBAL_QUERY_SQL);
    const result = db.transaction(() => {
      const nodes = []; const edges = []; const diagnostics = []; let bytes = 0;
      const charge = (row: object) => { for (const value of Object.values(row)) if (typeof value === "string") bytes += Buffer.byteLength(value); if (bytes > 512 * 1024 ** 2) throw Error("Offline query preparation exceeds 512 MiB payload budget"); };
      for (const row of db.prepare("SELECT * FROM nodes ORDER BY rowid").iterate() as Iterable<NodeRow>) { charge(row); if (nodes.length >= 2000000) throw Error("Offline query preparation exceeds node bound"); nodes.push(graphNodeFromRow(row)); }
      for (const row of db.prepare("SELECT * FROM edges ORDER BY rowid").iterate() as Iterable<EdgeRow>) { charge(row); if (edges.length >= 5000000) throw Error("Offline query preparation exceeds edge bound"); edges.push(graphEdgeFromRow(row)); }
      for (const row of db.prepare("SELECT * FROM diagnostics ORDER BY id").iterate() as Iterable<DiagnosticRow>) { charge(row); if (diagnostics.length >= 1000000) throw Error("Offline query preparation exceeds diagnostic bound"); diagnostics.push(diagnosticFromRow(row)); }
      materializeGlobalQueries(db, { nodes, edges, diagnostics });
      return { nodes: nodes.length, edges: edges.length, diagnostics: diagnostics.length };
    }).immediate();
    return { filename, projectionVersion: GLOBAL_QUERY_VERSION, ...result, durationMs: Math.round(performance.now() - started) };
  } finally { db.close();lease.close(); }
}
