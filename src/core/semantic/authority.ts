/** Routing and pinned metadata for the atomically published compatibility authority. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { IndexState } from '../analysis/state.js';
import { CompatibilityGlobalRead } from '../query/compatibility-global-read.js';
import { NavigationRead } from '../query/navigation.js';
import { readSnapshotReport } from './snapshot-report.js';
import { SEMANTIC_SCHEMA_VERSION } from './model.js';
export function semanticDatabasePath(index: string): string {
  const selected=path.resolve(index);
  return selected.endsWith(".sqlite")&&path.basename(selected)!=="graph.sqlite"? selected:path.join(selected.endsWith(".sqlite")? path.dirname(selected):selected,"semantic.sqlite");
}
export function resolveCompatibilityDatabase(index: string): string {
  const selected=path.resolve(index);
  if(selected.endsWith('.sqlite'))
    return selected; // Explicit legacy files remain readable.
  const semantic=path.join(selected,'semantic.sqlite');
  if(existsSync(semantic)) {
    const db=new Database(semantic,{ readonly: true,fileMustExist: true });
    try {
      const authority=db.prepare("SELECT value FROM sc_meta WHERE key='compatibility-authority'").get() as {
        value: string;
      }|undefined;
      if(authority) {
        if(authority.value!=='owned-v1')
          throw Error('Unsupported semantic compatibility authority');
        return semantic;
      }
    }
    finally {
      db.close();
    }
  }
  return path.join(selected,'graph.sqlite');
}
export interface AuthorityObservation {
  filename: string;
  db: Database.Database;
  snapshot?: number;
  report?: NonNullable<ReturnType<typeof readSnapshotReport>>;
  state?: IndexState;
  attempt?: {
    status: string;
    snapshot?: number;
    reason?: string;
  };
  reason?: string;
  close(): void;
}
/** Caller holds this WAL read transaction through asynchronous source/input checks. */
export function openAuthorityObservation(index: string): AuthorityObservation|undefined {
  const filename=resolveCompatibilityDatabase(index);
  if(!existsSync(filename))
    return undefined;
  const db=new Database(filename,{ readonly: true,fileMustExist: true });
  try {
    db.exec('BEGIN');
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get()) {
      db.close();
      return undefined;
    }
    const authority=db.prepare("SELECT value FROM sc_meta WHERE key='compatibility-authority'").get() as {
      value: string;
    }|undefined;
    if(!authority) {
      db.close();
      return undefined;
    }
    if(authority.value!=='owned-v1')
      throw Error('Unsupported semantic compatibility authority');
    const result: AuthorityObservation={
      filename,db,close() {
        if(db.open) {
          if(db.inTransaction)
            db.exec('ROLLBACK');
          db.close();
        }
      }
    };
    try {
      const active=db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as {
        value: string;
      }|undefined;
      const id=Number(active?.value);
      if(!Number.isSafeInteger(id)||id<1)
        throw Error('No current semantic snapshot');
      result.snapshot=id;
      const attempt=db.prepare("SELECT value FROM sc_meta WHERE key='analysis-attempt'").get() as {
        value: string;
      }|undefined;
      if(attempt) {
        if(Buffer.byteLength(attempt.value)>4096)
          throw Error('Oversized analysis attempt metadata');
        result.attempt=JSON.parse(attempt.value);
      }
      new CompatibilityGlobalRead(db,new NavigationRead(db));
      const report=readSnapshotReport(db,id);
      if(!report?.compatibilityReady||report.format!==2)
        throw Error('Current semantic compatibility report unavailable; run analyze/sync');
      const files: Record<string,string>={};
      let rows=0,bytes=0;
      for(const row of db.prepare('SELECT path,digest FROM cg_source_inputs ORDER BY path').iterate() as Iterable<{
        path: string;
        digest: string;
      }>) {
        bytes+=Buffer.byteLength(row.path)+row.digest.length;
        if(++rows>1000000||bytes>128*1024**2)
          throw Error('Source status catalogue exceeds offline row/byte budget');
        files[row.path]=row.digest;
      }
      if(rows!==report.manifest.scannedFileCount)
        throw Error('Source status catalogue does not match its report');
      result.report=report;
      result.state={ ...report.stateHeader,files };
    }
    catch(error) {
      result.reason=String(error).slice(0,320);
    }
    return result;
  }
  catch(error) {
    if(db.open)
      db.close();
    throw error;
  }
}
/** Failed attempts are separate metadata; the previously committed snapshot stays immutable. */
export function recordAnalysisFailure(filename: string,reason: string): void {
  let db: Database.Database|undefined;
  try {
    db=new Database(filename,{ fileMustExist: true });
    db.pragma('synchronous=FULL');
    const metadata=Object.fromEntries((db.prepare("SELECT key,value FROM sc_meta WHERE key IN ('schema','format','compatibility-authority')").all() as Array<{
      key: string;
      value: string;
    }>).map(row => [row.key,row.value]));
    if(metadata.format!=='2'||metadata.schema!==SEMANTIC_SCHEMA_VERSION||metadata['compatibility-authority']!=='owned-v1')
      return;
    db.prepare("INSERT INTO sc_meta VALUES('analysis-attempt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ status: 'failed',reason: reason.slice(0,320),snapshot: null,observedAt: new Date().toISOString() }));
  }
  catch { /* Storage failure may also prevent attempt metadata. Never rewrite the snapshot or fall back. */ }
  finally {
    db?.close();
  }
}
