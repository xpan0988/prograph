import { afterEach,expect,test,vi } from 'vitest';
const controls=vi.hoisted(() => ({ noSpace: false }));
vi.mock('node:fs/promises',async (original) => { const fs=await original<typeof import('node:fs/promises')>(); return { ...fs,statfs: async (...args: Parameters<typeof fs.statfs>) => { const value=await fs.statfs(...args); return controls.noSpace? { ...value,bavail: 0 }:value; } }; });
import { mkdtemp,mkdir,writeFile,readFile,rm,lstat,stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { prepareAuthorityMigration,MIGRATION_MARKER,MIGRATION_PIN } from '../src/core/semantic/authority-migration.js';
import { IndexLease } from '../src/core/semantic/maintenance-lock.js';
import { SemanticStore } from '../src/core/semantic/store.js';
import { SemanticQuery } from '../src/core/semantic/query.js';
import { recordAnalysisFailure,openAuthorityObservation } from '../src/core/semantic/authority.js';
import { SEMANTIC_SCHEMA_VERSION,digest } from '../src/core/semantic/model.js';
import { analyzeRepository } from '../src/core/analysis/analyze.js';
import { queryServiceForRepository } from '../src/core/query/query-service.js';
import { releaseMigrationRetention } from './oracles/migration-retention.js';
const baseline=process.env.PROGRAPH_TEST_AUTHORITY_BASELINE_RUNTIME,roots: string[]=[];
afterEach(async () => {
  controls.noSpace=false; vi.unstubAllGlobals(); for(const root of roots.splice(0))
    await rm(root,{ recursive: true,force: true });
});
async function fixture(old=true) {
  const root=await mkdtemp(path.join(os.tmpdir(),'prograph-authority-upgrade-'));
  roots.push(root);
  const repo=path.join(root,'repo'),index=path.join(root,'custom index');
  await mkdir(repo);
  await writeFile(path.join(repo,'tsconfig.json'),'{"include":["*.ts"]}');
  await writeFile(path.join(repo,'a.ts'),'export function target(){return 1} export function run(){return target()}');
  if(old) {
    const accepted=await import(/* @vite-ignore */ pathToFileURL(path.join(baseline!,'dist/core/analysis/analyze.js')).href) as typeof import('../src/core/analysis/analyze.js');
    const result=await accepted.analyzeRepository(repo,{ output: index });
    expect(result.manifest.semanticCore?.status).toBe('partial');
  }
  else
    await analyzeRepository(repo,{ output: index });
  return { root,repo,index,file: path.join(index,'semantic.sqlite') };
}
async function receipt(index: string) {
  return JSON.parse(await readFile(path.join(index,MIGRATION_MARKER),'utf8')) as {
    directory: string;
    nativeSnapshots: number[];
    files: Record<string,{
      bytes: number;
      sha256: string;
    }>;
    semanticSchema: string;
  };
}
async function oldReadable(index: string) {
  const OldQuery=(await import(/* @vite-ignore */ pathToFileURL(path.join(baseline!,'dist/core/query/query-service.js')).href) as typeof import('../src/core/query/query-service.js')).QueryService;
  const q=new OldQuery(path.join(index,'graph.sqlite'));
  try {
    expect(q.searchSymbols('target').length).toBeGreaterThan(0);
  }
  finally {
    q.close();
  }
  const OldSemantic=(await import(/* @vite-ignore */ pathToFileURL(path.join(baseline!,'dist/core/semantic/query.js')).href) as typeof import('../src/core/semantic/query.js')).SemanticQuery;
  const native=new OldSemantic(path.join(index,'semantic.sqlite'));
  try {
    expect(native.execute('find','target').items.length).toBeGreaterThan(0);
  }
  finally {
    native.close();
  }
}
test.skipIf(!baseline)('automatic activation preserves actual older native/legacy stores and pinned readers until explicit rollback retention release',async () => {
  const f=await fixture(),old=new Database(path.join(f.index,'graph.sqlite'),{ readonly: true });
  old.exec('BEGIN');
  const before=old.prepare("SELECT id FROM nodes WHERE name='target' ORDER BY id").all();
  try {
    await writeFile(path.join(f.repo,'a.ts'),'export function replacement(){return 2}');
    await analyzeRepository(f.repo,{ output: f.index });
    expect(old.prepare("SELECT id FROM nodes WHERE name='target' ORDER BY id").all()).toEqual(before);
    const saved=await receipt(f.index),generation=path.join(f.index,saved.directory);
    expect(saved.semanticSchema).toBe('2.0.0-step2.12');
    expect(saved.nativeSnapshots.length).toBeGreaterThan(0);
    for(const [file,expected] of Object.entries(saved.files)) {
      expect((await stat(path.join(generation,file))).size).toBe(expected.bytes);
      expect(digest(await readFile(path.join(generation,file)))).toBe(expected.sha256);
    }
    await oldReadable(generation);
    const store=new SemanticStore(f.file);
    try {
      const pins=store.sql('SELECT snapshot FROM sc_snapshot_pins WHERE label=? ORDER BY snapshot').all(MIGRATION_PIN) as Array<{
        snapshot: number;
      }>;
      expect(pins.map(row => row.snapshot)).toEqual(saved.nativeSnapshots);
      store.collectGarbage({ keep: 1 });
      for(const snapshot of saved.nativeSnapshots)
        expect(store.sql('SELECT 1 FROM sc_snapshots WHERE id=?').get(snapshot)).toBeDefined();
      expect(releaseMigrationRetention(store)).toBe(saved.nativeSnapshots.length);
      store.collectGarbage({ keep: 1 });
      for(const snapshot of saved.nativeSnapshots)
        expect(store.sql('SELECT 1 FROM sc_snapshots WHERE id=?').get(snapshot)).toBeUndefined();
    }
    finally {
      store.close();
    }
    await oldReadable(generation);
    const q=await queryServiceForRepository(f.repo,f.index);
    try {
      expect(q.searchSymbols('replacement').length).toBeGreaterThan(0);
      expect(q.searchSymbols('target')).toHaveLength(0);
    }
    finally {
      q.close();
    }
  }
  finally {
    old.exec('ROLLBACK');
    old.close();
  }
},60000);
test.skipIf(!baseline)('an older live writer prevents upgrade before storage, backup markers or legacy bytes change',async () => {
  const f=await fixture(),before=digest(await readFile(f.file)),lease=new IndexLease(f.index,'work');
  try {
    await expect(prepareAuthorityMigration(f.index)).rejects.toMatchObject({ code: 'INDEX_MAINTENANCE_BUSY' });
    expect(digest(await readFile(f.file))).toBe(before);
    await expect(lstat(path.join(f.index,MIGRATION_MARKER))).rejects.toHaveProperty('code','ENOENT');
  }
  finally {
    lease.close();
  }
  await prepareAuthorityMigration(f.index);
  const saved=await receipt(f.index);
  await oldReadable(path.join(f.index,saved.directory));
},30000);
test.skipIf(!baseline)('insufficient rollback space and unrelated marker content leave the actual old index unchanged',async () => {
  const f=await fixture(),before=await readFile(f.file);
  controls.noSpace=true;
  await expect(prepareAuthorityMigration(f.index)).rejects.toThrow(/Insufficient free space/);
  expect(await readFile(f.file)).toEqual(before);
  await expect(lstat(path.join(f.index,MIGRATION_MARKER))).rejects.toHaveProperty('code','ENOENT');
  controls.noSpace=false;
  await writeFile(path.join(f.index,MIGRATION_MARKER),'user-owned content');
  await expect(prepareAuthorityMigration(f.index)).rejects.toThrow();
  expect(await readFile(f.file)).toEqual(before);
  expect(await readFile(path.join(f.index,MIGRATION_MARKER),'utf8')).toBe('user-owned content');
},30000);
test.skipIf(!baseline)('hard termination after durable backup or schema initialization preserves rollback readability and resumes without half activation',async () => {
  for(const point of ['backup-durable','schema-ready']) {
    const f=await fixture(),probe=path.join(f.root,'ready'),script=path.join(f.root,'worker.mjs');
    await writeFile(script,`import{writeFileSync}from'node:fs';import{prepareAuthorityMigration}from${JSON.stringify(new URL('../dist/core/semantic/authority-migration.js',import.meta.url).href)};await prepareAuthorityMigration(${JSON.stringify(f.index)},{fault(p){if(p===${JSON.stringify(point)}){writeFileSync(${JSON.stringify(probe)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}});`);
    const child=spawn(process.execPath,[script],{ stdio: 'ignore' });
    try {
      const end=performance.now()+10000;
      while(performance.now()<end) {
        try {
          await stat(probe);
          break;
        }
        catch {
          await new Promise(resolve => setTimeout(resolve,20));
        }
      }
      expect((await stat(probe)).isFile()).toBe(true);
      const closed=new Promise(resolve => child.once('close',resolve));
      child.kill('SIGKILL');
      await closed;
      const saved=await receipt(f.index);
      await oldReadable(path.join(f.index,saved.directory));
      const db=new Database(f.file,{ readonly: true });
      try {
        expect(db.prepare("SELECT value FROM sc_meta WHERE key='compatibility-authority'").get()).toBeUndefined();
        expect(db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get()).toEqual({ value: point==='backup-durable'? '2.0.0-step2.12':SEMANTIC_SCHEMA_VERSION });
        expect(db.pragma('integrity_check',{ simple: true })).toBe('ok');
      }
      finally {
        db.close();
      }
      expect((await analyzeRepository(f.repo,{ output: f.index })).manifest.semanticCore?.status).toBe('partial');
    }
    finally {
      child.kill('SIGKILL');
    }
  }
},60000);
test.skipIf(!baseline)('unqualified Windows migration refuses a pre-existing index before replacing any store',async () => {
  const f=await fixture(),before=await readFile(f.file);
  vi.stubGlobal('process',new Proxy(process,{ get(target,key) { return key==='platform'? 'win32':Reflect.get(target,key,target); } }));
  await expect(prepareAuthorityMigration(f.index)).rejects.toThrow(/not qualified on Windows/);
  expect(await readFile(f.file)).toEqual(before);
},30000);
test('failure attempt metadata is byte-bounded and cannot modify a newer storage format',async () => {
  const f=await fixture(false),large='\\"\u0000🚀'.repeat(2000);
  recordAnalysisFailure(f.file,large);
  const observation=openAuthorityObservation(f.index);
  try {
    expect(observation?.reason).toBeUndefined();
    expect(observation?.attempt?.status).toBe('failed');
    expect(Buffer.byteLength((observation!.db.prepare("SELECT value FROM sc_meta WHERE key='analysis-attempt'").get() as {
      value: string;
    }).value)).toBeLessThanOrEqual(4096);
  }
  finally {
    observation?.close();
  }
  const db=new Database(f.file);
  db.prepare("UPDATE sc_meta SET value='2.0.0-future' WHERE key='schema'").run();
  db.close();
  const before=await readFile(f.file);
  recordAnalysisFailure(f.file,'older writer failure');
  expect(await readFile(f.file)).toEqual(before);
  expect(() => new SemanticStore(f.file)).toThrow(/Unsupported/);
  const unknown=new Database(f.file);unknown.prepare("UPDATE sc_meta SET value=? WHERE key='schema'").run(SEMANTIC_SCHEMA_VERSION);unknown.prepare("UPDATE sc_meta SET value='owned-future' WHERE key='compatibility-authority'").run();unknown.close();const unknownBytes=await readFile(f.file);expect(()=>new SemanticStore(f.file)).toThrow(/Unsupported semantic compatibility authority/);expect(await readFile(f.file)).toEqual(unknownBytes);
},30000);
test('a writer opened before a storage-version change cannot publish or advance the pointer',async () => {
  const f=await fixture(false),store=new SemanticStore(f.file),before=store.activeSnapshot();
  try {
    store.sql("UPDATE sc_meta SET value='2.0.0-future' WHERE key='schema'").run();
    expect(() => store.publish([],before)).toThrow(/Storage version changed/);
    expect(store.activeSnapshot()).toBe(before);
    store.sql("UPDATE sc_meta SET value=? WHERE key='schema'").run(SEMANTIC_SCHEMA_VERSION);store.sql("UPDATE sc_meta SET value='owned-future' WHERE key='compatibility-authority'").run();expect(()=>store.publish([],before)).toThrow(/Compatibility authority version changed/);expect(store.activeSnapshot()).toBe(before);
  }
  finally {
    store.close();
  }
},30000);
