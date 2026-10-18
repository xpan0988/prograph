import { test, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeRepository } from '../src/core/analysis/analyze.js';
import { QueryService } from '../src/core/query/query-service.js';
import { SemanticStore } from '../src/core/semantic/store.js';
import { prepareQueryIndex } from '../src/core/analysis/prepare-queries.js';
import { QUERY_SCOPES } from '../src/core/query/global-projections.js';
import { canonical, digest } from '../src/core/semantic/model.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** Compare full payloads, retaining duplicate array members; only order and execution timing differ. */
function normalized(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(normalized).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([key, value]) => key !== 'durationMs' && value !== undefined).map(([key, value]) => [key, normalized(value)]));
  return value;
}
function executionOnly(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(executionOnly); if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([key, value]) => key !== 'durationMs' && value !== undefined).map(([key, value]) => [key, executionOnly(value)])); return value;
}
function querySet(query: QueryService) {
  return QUERY_SCOPES.map(scope => ({ scope, overview: query.overview({ scope }), files: query.files({ scope }), architecture: [0, 1, 2].map(level => query.architecture(100, { scope, includeProbable: level > 0, includeUnresolved: level > 1 })), context: query.context('target run module documentation', { scope, maxSymbols: 200, maxFiles: 100 }), framework: query.frameworkBindings(undefined, { scope, includeUnresolved: true }), symbols: query.searchSymbols('', 200, { scope, includeUnresolved: true }) }));
}
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-owned-query-oracle-')); roots.push(root); const repo = path.join(root, 'repo'), index = path.join(root, 'index'); await mkdir(repo); await writeFile(path.join(repo, 'tsconfig.json'), '{"include":["*.ts"]}'); await writeFile(path.join(repo, 'a.ts'), 'export function target(){return 1}'); await writeFile(path.join(repo, 'b.ts'), 'import{target}from"./a"; export function run(){return target()}'); await writeFile(path.join(repo, 'README.md'), '# Documentation\nUse `target` from the module.'); await analyzeRepository(repo, { output: index }); return { root, repo, index }; }
test('owned global projections agree with frozen legacy and independent clean builds across source, documentation, rename, delete, module and config edits', async () => {
  const f = await fixture();
  const edits = [async () => { }, async () => writeFile(path.join(f.repo, 'README.md'), '# Documentation\nThe module uses `run`.'), async () => writeFile(path.join(f.repo, 'a.ts'), 'export function target(){return 2} export function more(){return target()}'), async () => { await rename(path.join(f.repo, 'b.ts'), path.join(f.repo, 'caller.ts')); }, async () => writeFile(path.join(f.repo, 'new.ts'), 'export function moduleTarget(){return 3}'), async () => rm(path.join(f.repo, 'new.ts')), async () => writeFile(path.join(f.repo, 'prograph.config.json'), '{"include":["**/*"],"exclude":["prograph.config.json"]}'), async () => rm(path.join(f.repo, 'README.md'))];
  const hashes: string[] = [];
  for (const edit of edits) {
    await edit();
    await analyzeRepository(f.repo, { output: f.index });
    const clean = path.join(f.root, 'clean');
    await rm(clean, { recursive: true, force: true });
    await analyzeRepository(f.repo, { output: clean });
    const owned = new QueryService(path.join(f.index, 'semantic.sqlite')), legacy = new QueryService(path.join(f.index, 'graph.sqlite')), independent = new QueryService(path.join(clean, 'semantic.sqlite'));
    try {
      const actual = normalized(querySet(owned));
      expect(actual).toEqual(normalized(querySet(legacy)));
      expect(actual).toEqual(normalized(querySet(independent)));
      expect(executionOnly(querySet(owned))).toEqual(executionOnly(querySet(independent)));
      hashes.push(digest(canonical(actual)));
      expect(owned.database.pragma('foreign_key_check')).toEqual([]);
      expect(owned.database.pragma('integrity_check', { simple: true })).toBe('ok');
    }
    finally {
      owned.close();
      legacy.close();
      independent.close();
    }
  }
  expect(hashes).toHaveLength(8);
}, 90000);
test('pinned SQL readers retain the previous coherent cache while publication and historical GC advance', async () => {
  const f = await fixture(), filename = path.join(f.index, 'semantic.sqlite'), old = new QueryService(filename);
  old.database.exec('BEGIN');
  const before = normalized(querySet(old));
  const generation = old.filePage({ limit: 1 }).generation;
  try {
    await writeFile(path.join(f.repo, 'a.ts'), 'export function replacement(){return 5}');
    await analyzeRepository(f.repo, { output: f.index });
    const store = new SemanticStore(filename);
    try {
      store.collectGarbage({ keep: 1 });
    }
    finally {
      store.close();
    }
    expect(normalized(querySet(old))).toEqual(before);
    expect(old.filePage({ limit: 1 }).generation).toBe(generation);
    const next = new QueryService(filename);
    try {
      expect(next.filePage({ limit: 1 }).generation).not.toBe(generation);
      expect(normalized(querySet(next))).not.toEqual(before);
    }
    finally {
      next.close();
    }
  }
  finally {
    old.database.exec('ROLLBACK');
    old.close();
  }
}, 30000);
test('cycle queries require explicit offline preparation and relevant relationship changes invalidate it', async () => {
  const f = await fixture(), filename = path.join(f.index, 'semantic.sqlite');
  let query = new QueryService(filename);
  try {
    expect(() => query.cycles()).toThrow(/prepare-queries offline/);
  }
  finally {
    query.close();
  }
  const prepared = prepareQueryIndex(filename);
  expect(prepared).toHaveProperty('projectionVersion', 'owned-query-1');
  query = new QueryService(filename);
  try {
    expect(query.cycles()).toEqual([]);
  }
  finally {
    query.close();
  }
  await writeFile(path.join(f.repo, 'README.md'), '# New documentation');
  await analyzeRepository(f.repo, { output: f.index });
  query = new QueryService(filename);
  try {
    expect(query.cycles()).toEqual([]);
    expect(() => query.cycles({ scope: 'full' })).toThrow(/prepare-queries offline/);
  }
  finally {
    query.close();
  }
  await writeFile(path.join(f.repo, 'b.ts'), 'export function run(){return 0}');
  await analyzeRepository(f.repo, { output: f.index });
  query = new QueryService(filename);
  try {
    expect(() => query.cycles()).toThrow(/prepare-queries offline/);
  }
  finally {
    query.close();
  }
}, 30000);

test('owned query consumers refuse a corrupted bound report instead of trusting a matching cache marker',async()=>{
 const f=await fixture(),filename=path.join(f.index,'semantic.sqlite'),store=new SemanticStore(filename);try{store.sql("UPDATE sc_snapshot_reports SET json='{}' WHERE snapshot=?").run(store.activeSnapshot())}finally{store.close()}
 const query=new QueryService(filename);try{expect(()=>query.overview()).toThrow(/receipt/);expect(()=>query.symbol('missing')).toThrow(/receipt/)}finally{query.close()}
},30000);
