/** Preserve the pre-activation stores before any in-place storage upgrade. */
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir,realpath,lstat,stat,statfs,mkdtemp,readFile,writeFile,copyFile,chmod,open,readdir,link,rename,rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import Database from 'better-sqlite3';
import { IndexLease } from './maintenance-lock.js';
import { SemanticStore } from './store.js';
import { canonical,digest,READABLE_SEMANTIC_SCHEMAS,SEMANTIC_SCHEMA_VERSION } from './model.js';
export const MIGRATION_PIN='authority-migration-rollback';
export const MIGRATION_MARKER='.semantic-authority-rollback.json';
const prefix='.semantic-authority-rollback-';
const caches=['manifest.json','state.json','diagnostics.json','exports/graph.json','exports/semantic-compatibility.json'];
interface Receipt {
  format: 1;
  kind: 'prograph-authority-rollback';
  index: string;
  directory: string;
  createdAt: string;
  nativeSnapshots: number[];
  semanticSchema: string|null;
  semanticFile: string;
  files: Record<string,{
    bytes: number;
    sha256: string;
  }>;
  coherence: string;
  retention: string;
}
async function exists(file: string) {
  try {
    const entry=await lstat(file);
    if(!entry.isFile()||entry.isSymbolicLink())
      throw Error('Migration requires regular index files: '+file);
    return true;
  }
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')
      return false;
    throw error;
  }
}
async function checksum(file: string) {
  const hash=createHash('sha256'); for await(const bytes of createReadStream(file))
    hash.update(bytes); return hash.digest('hex');
}
async function syncPath(file: string) {
  const handle=await open(file,'r'); try {
    await handle.sync();
  }
    finally {
    await handle.close();
  }
}
async function syncTree(directory: string): Promise<void> {
  for(const entry of await readdir(directory,{ withFileTypes: true })) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())
      await syncTree(file);
    else if(entry.isFile())
      await syncPath(file);
    else
      throw Error('Unexpected migration archive entry');
  } await syncPath(directory);
}
function metadata(file: string) {
  const db=new Database(file,{ readonly: true,fileMustExist: true }); try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get())
      throw Error('Unrecognized semantic database; preserve it and rebuild separately');
    const values=Object.fromEntries((db.prepare("SELECT key,value FROM sc_meta WHERE key IN ('format','schema','compatibility-authority','authority-migration-backup')").all() as Array<{
      key: string;
      value: string;
    }>).map(row => [row.key,row.value]));
    if(values.format!=='2'||!(READABLE_SEMANTIC_SCHEMAS as readonly string[]).includes(values.schema??''))
      throw Error('Unsupported Semantic Core storage/schema; preserve it and rebuild separately');
    if(values['compatibility-authority'] && values['compatibility-authority']!=='owned-v1')throw Error('Unsupported semantic compatibility authority; preserve this index');
    return values;
  }
    finally {
    db.close();
  }
}
async function existingReceipt(directory: string) {
  const marker=path.join(directory,MIGRATION_MARKER); if(!await exists(marker))
    return undefined; const info=await stat(marker); if(info.size>262144)
    throw Error('Oversized authority rollback receipt'); const text=await readFile(marker,'utf8'),receipt=JSON.parse(text) as Receipt; if(receipt.format!==1||receipt.kind!=='prograph-authority-rollback'||receipt.index!==directory||!receipt.directory.startsWith(prefix)||path.basename(receipt.directory)!==receipt.directory||!Array.isArray(receipt.nativeSnapshots)||receipt.nativeSnapshots.length>10000||receipt.nativeSnapshots.some(id => !Number.isSafeInteger(id)||id<1))
    throw Error('Unrecognized or foreign authority rollback receipt'); const generation=path.join(directory,receipt.directory); if((await lstat(generation)).isSymbolicLink()||!(await lstat(generation)).isDirectory()||await realpath(generation)!==generation)
    throw Error('Invalid authority rollback directory'); if(digest(await readFile(path.join(generation,'receipt.json')))!==digest(text))
    throw Error('Authority rollback receipt changed'); for(const [file,expected] of Object.entries(receipt.files)) {
      if(!['graph.sqlite',receipt.semanticFile,...caches].includes(file)||!/^[a-f0-9]{64}$/.test(expected.sha256)||!await exists(path.join(generation,file))||(await stat(path.join(generation,file))).size!==expected.bytes||await checksum(path.join(generation,file))!==expected.sha256)
        throw Error('Authority rollback contents failed verification');
    } return { receipt,text,key: digest(text) };
}
/** Exclusive maintenance ends only after schema upgrade + rollback pins commit.
 * Older cooperating writers cannot open in the gap between backup and upgrade.
 * Queries hold independent WAL reads and need not release their old snapshot.
 */
export async function prepareAuthorityMigration(requested: string,hooks: {
  storageOnly?: boolean;
  semanticFile?: string;
  fault?: (point: 'backup-durable'|'schema-ready') => void;
}={}): Promise<void> {
  await mkdir(requested,{ recursive: true });
  const directory=await realpath(requested),semanticFile=hooks.semanticFile??'semantic.sqlite';
  if(path.basename(semanticFile)!==semanticFile||!semanticFile.endsWith('.sqlite')||semanticFile==='graph.sqlite')
    throw Error('Invalid semantic storage filename');
  const semantic=path.join(directory,semanticFile),graph=path.join(directory,'graph.sqlite');
  const hasSemantic=await exists(semantic),hasGraph=await exists(graph);
  if(!hasSemantic&&!hasGraph||hooks.storageOnly&&!hasSemantic)
    return;
  if(hasSemantic) {
    const meta=metadata(semantic);
    if(hooks.storageOnly&&meta.schema===SEMANTIC_SCHEMA_VERSION)
      return;
    if(meta['compatibility-authority']==='owned-v1')
      return;
    if(meta.schema===SEMANTIC_SCHEMA_VERSION&&meta['authority-migration-backup']) {
      const previous=await existingReceipt(directory);
      if(!previous||previous.key!==meta['authority-migration-backup'])
        throw Error('Prepared authority rollback receipt does not match its store');
      return;
    }
  }
  if(process.platform==='win32')
    throw Error('Pre-existing-index authority migration is not qualified on Windows; preserve this index and analyze into a separate new index');
  const lease=new IndexLease(directory,'maintenance');
  let generation: string|undefined,published=false;
  try {
    if(await exists(semantic)&&metadata(semantic)['compatibility-authority']==='owned-v1')
      return;
    const previous=await existingReceipt(directory);
    if(previous&&previous.receipt.semanticFile!==semanticFile)
      throw Error('Multiple semantic stores require separate migration index directories'); // Never replace unrelated files.
    const sources=['graph.sqlite',semanticFile,...caches],present: string[]=[];
    let required=64*1024**2;
    for(const relative of sources)
      if(await exists(path.join(directory,relative))) {
        present.push(relative);
        required+=(await stat(path.join(directory,relative))).size*2;
      }
    for(const name of ['graph.sqlite-wal',semanticFile+'-wal'])
      if(await exists(path.join(directory,name)))
        required+=(await stat(path.join(directory,name))).size*2;
    const free=await statfs(directory);
    if(free.bavail*free.bsize<required)
      throw Error('Insufficient free space for a durable pre-activation rollback copy; no index upgrade performed');
    if(present.includes('graph.sqlite')) {
      const db=new Database(graph,{ readonly: true,fileMustExist: true });
      try {
        if((db.prepare("SELECT value FROM schema_metadata WHERE key='schemaVersion'").get() as {
          value: string;
        }|undefined)?.value!=='1.2.0')
          throw Error('Unrecognized legacy graph; preserve it and rebuild separately');
      }
      finally {
        db.close();
      }
    }
    generation=await mkdtemp(path.join(directory,prefix));
    const files: Receipt['files']={};
    let snapshots: number[]=[],schema: string|null=null;
    for(const relative of present) {
      const source=path.join(directory,relative),target=path.join(generation,relative);
      await mkdir(path.dirname(target),{ recursive: true });
      if(relative.endsWith('.sqlite')) {
        const db=new Database(source,{ readonly: true,fileMustExist: true });
        try {
          if(relative===semanticFile) {
            schema=metadata(source).schema!;
            const rows=db.prepare('SELECT id FROM sc_snapshots ORDER BY id LIMIT 10001').all() as Array<{
              id: number;
            }>;
            if(rows.length>10000)
              throw Error('Rollback snapshot catalogue exceeds 10000 snapshots; apply explicit retention first');
            snapshots=rows.map(row => row.id);
          }
          await db.backup(target);
        }
        finally {
          db.close();
        }
        const copy=new Database(target,{ fileMustExist: true });
        try {
          copy.pragma('synchronous=FULL');
          copy.pragma('wal_checkpoint(TRUNCATE)');
          copy.pragma('journal_mode=DELETE');
          if(copy.pragma('integrity_check',{ simple: true })!=='ok'||(copy.pragma('foreign_key_check') as unknown[]).length)
            throw Error('Rollback SQLite verification failed');
        }
        finally {
          copy.close();
        }
      }
      else
        await copyFile(source,target,constants.COPYFILE_EXCL);
      files[relative]={ bytes: (await stat(target)).size,sha256: await checksum(target) };
      await chmod(target,0o444);
    }
    const receipt: Receipt={ format: 1,kind: 'prograph-authority-rollback',index: directory,directory: path.basename(generation),createdAt: new Date().toISOString(),nativeSnapshots: snapshots,semanticSchema: schema,semanticFile,files,coherence: 'Original stores/cache files preserved under exclusive maintenance; an old cross-database mismatch is not certified coherent. Native facts are independently readable.',retention: 'All archived native snapshots are pinned in the upgraded store under '+MIGRATION_PIN+'. Removing these pins/backups requires explicit maintenance. External SDK execution/replay still requires environment and authorization qualification.' };
    const text=canonical(receipt)+'\n',receiptPath=path.join(generation,'receipt.json');
    if(Buffer.byteLength(text)>262144)
      throw Error('Rollback receipt exceeds 256 KiB');
    await writeFile(receiptPath,text,{ flag: 'wx',mode: 0o444 });
    await syncTree(generation);
    const marker=path.join(directory,MIGRATION_MARKER);
    if(previous) {
      if(digest(await readFile(marker))!==previous.key)
        throw Error('Authority rollback marker changed during maintenance');
      const pending=path.join(directory,path.basename(generation)+'.pointer');
      await link(receiptPath,pending);
      try {
        await rename(pending,marker);
      }
      finally {
        await rm(pending,{ force: true });
      }
    }
    else
      await link(receiptPath,marker);
    published=true;
    await syncPath(directory);
    hooks.fault?.('backup-durable');
    const store=new SemanticStore(semantic,{},lease,s => {
      for(const snapshot of snapshots)
        s.pinSnapshot(snapshot,MIGRATION_PIN); s.sql("INSERT INTO sc_meta VALUES('authority-migration-backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest(text));
    });
    store.close();
    hooks.fault?.('schema-ready');
  }
  catch(error) {
    if(generation&&!published)
      await rm(generation,{ recursive: true,force: true });
    throw error;
  }
  finally {
    lease.close();
  }
}
