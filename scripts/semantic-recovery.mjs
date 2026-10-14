// Actual-process crash probes for the built Step 1 publisher; disposable databases only.
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { SemanticStore } from '../dist/core/semantic/store.js';
import { SourceCoordinates } from '../dist/core/semantic/coordinates.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-step1-recovery-'));
const filename = path.join(root, 'semantic.sqlite');
const provider = { provider:'probe',version:'1',basis:'compiler',method:'probe',context:'ctx',inputFingerprint:'inputs' };
const report = { node:process.version, probes:[] };
try {
  const store = new SemanticStore(filename);
  for (const name of ['callee','other']) store.addSymbol({ key:name,name,qualifiedName:name,kind:'function',file:'src.ts',context:'ctx' });
  store.addOccurrence({ ...new SourceCoordinates('src.ts','callee()').range(0,6,'ctx','definition'),key:'occ' },8);
  const run = store.begin('base','ctx','inputs');
  store.batch(run,()=>store.addFact(run,{ predicate:'common.Definition',context:'ctx',subject:'callee',object:'callee',occurrence:'occ',confidence:'resolved',provenance:provider }));
  store.seal(run,{status:'partial'}); const baseline = store.publish([run]); store.close();
  const module = new URL('../dist/core/semantic/store.js',import.meta.url).href;
  for (const point of ['before-seal','before-publish','during-publish','after-publish']) {
    const code = `import { SemanticStore } from ${JSON.stringify(module)};
      const store=new SemanticStore(process.argv[1],{fault(point){if(point===process.argv[2])process.exit(57)}});
      const run=store.begin('base','ctx','inputs');
      store.batch(run,()=>store.addFact(run,{predicate:'common.Definition',context:'ctx',subject:'other',object:'other',occurrence:'occ',confidence:'resolved',provenance:${JSON.stringify(provider)}}));
      store.seal(run,{status:'partial'});store.publish([run]);store.close();`;
    const child = spawnSync(process.execPath,['--input-type=module','-e',code,filename,point],{encoding:'utf8',timeout:30000});
    if (child.status!==57) throw Error(`Crash point missed: ${point}: ${child.stderr}`);
    const reader = new SemanticStore(filename); const active=reader.activeSnapshot();
    const integrity=reader.db.prepare('PRAGMA integrity_check').get().integrity_check;
    const visible=reader.db.prepare('SELECT e.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject WHERE a.snapshot=?').all(active).map(r=>r.key);
    const expected=point==='after-publish'?'other':'callee';
    if(integrity!=='ok'||visible.length!==1||visible[0]!==expected||(point!=='after-publish'&&active!==baseline)) throw Error(`Incoherent crash recovery: ${point}`);
    report.probes.push({ point,exitCode:child.status,activeSnapshot:active,visible,integrity,baselineRetained:!!reader.db.prepare('SELECT 1 FROM sc_snapshots WHERE id=?').get(baseline) });reader.close();
  }
  const corrupt=path.join(root,'corrupt.sqlite');await writeFile(corrupt,'not SQLite');const before=await readFile(corrupt);let refused=false;
  try { new SemanticStore(corrupt).close(); } catch { refused=true; }
  report.corruption={refused,unchanged:before.equals(await readFile(corrupt))};
  if(!report.corruption.refused||!report.corruption.unchanged)throw Error('Corruption probe failed');
  const json=`${JSON.stringify(report,null,2)}\n`;if(process.argv[2])await writeFile(process.argv[2],json);process.stdout.write(json);
} finally { await rm(root,{recursive:true,force:true}); }
