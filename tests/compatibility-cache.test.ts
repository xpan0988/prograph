import { test, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeRepository } from '../src/core/analysis/analyze.js';
import { SemanticStore } from '../src/core/semantic/store.js';
import { QueryService } from '../src/core/query/query-service.js';
import { graphNodeFromRow, graphEdgeFromRow, diagnosticFromRow, type NodeRow, type EdgeRow, type DiagnosticRow } from '../src/core/storage/sqlite.js';
import { canonical, digest } from '../src/core/semantic/model.js';
const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0))
    await rm(p, { recursive: true, force: true });
});
const normalize = (items: unknown[]) => items.map(item => canonical(JSON.parse(JSON.stringify(item)))).sort();
function cached(s: SemanticStore) { return { nodes: normalize((s.sql('SELECT * FROM nodes').all() as NodeRow[]).map(graphNodeFromRow)), edges: normalize((s.sql('SELECT * FROM edges').all() as EdgeRow[]).map(graphEdgeFromRow)), diagnostics: normalize((s.sql('SELECT * FROM diagnostics').all() as DiagnosticRow[]).map(diagnosticFromRow)) }; }
test('cache payloads have selected eligible owners and agree with complete legacy results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-cache-'));
  roots.push(root);
  const result = await analyzeRepository(path.resolve('tests/fixtures/mixed'), { output: root });
  expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe('partial');
  const store = new SemanticStore(path.join(root, 'semantic.sqlite'));
  try {
    expect(cached(store)).toEqual({ nodes: normalize(result.graph.nodes), edges: normalize(result.graph.edges), diagnostics: normalize(result.graph.diagnostics) });
    expect(store.sql('SELECT COUNT(*) n FROM cg_current current WHERE NOT EXISTS(SELECT 1 FROM sc_partitions p WHERE p.snapshot=? AND p.run=current.run) OR NOT EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=current.claim)').get(store.activeSnapshot(), store.activeSnapshot())).toEqual({ n: 0 });
    expect(store.db.pragma('foreign_key_check')).toEqual([]);
  }
  finally {
    store.close();
  }
  const q = new QueryService(path.join(root, 'semantic.sqlite'));
  try {
    const symbol = q.searchSymbols;
    expect(q.symbol(result.graph.nodes.find(n => n.kind === 'function')!.id)).toBeDefined();
  }
  finally {
    q.close();
  }
}, 30000);
test('one documentation replacement preserves unrelated current rows and resolves only the affected owner/support keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-cache-delta-'));
  roots.push(root);
  const repo = path.join(root, 'repo'), index = path.join(root, 'index');
  await mkdir(repo);
  await writeFile(path.join(repo, 'a.ts'), 'export function target(){return 1} export function run(){return target()}');
  await writeFile(path.join(repo, 'README.md'), '# First\n');
  const first = await analyzeRepository(repo, { output: index });
  const old = new SemanticStore(path.join(index, 'semantic.sqlite'));
  const previous = cached(old), allocation = old.sql('SELECT id,rowid AS row,metadata_json FROM nodes').all();
  old.close();
  await writeFile(path.join(repo, 'README.md'), '# Second\n');
  const second = await analyzeRepository(repo, { output: index });
  expect(second.manifest.semanticCore?.status, second.manifest.semanticCore?.reason).toBe('partial');
  const db = new SemanticStore(path.join(index, 'semantic.sqlite'));
  try {
    expect(cached(db)).toEqual({ nodes: normalize(second.graph.nodes), edges: normalize(second.graph.edges), diagnostics: normalize(second.graph.diagnostics) });
    const work = JSON.parse((db.sql("SELECT value FROM cg_meta WHERE key='work'").get() as {
      value: string;
    }).value);
    expect(work.changedPayloads).toBeLessThan(10);
    expect(work.classifiedRows).toBeLessThan(first.graph.nodes.length + first.graph.edges.length);
    for (const row of allocation as Array<{
      id: string;
      row: number;
      metadata_json: string;
    }>)
      if (first.graph.nodes.find(n => n.id === row.id)?.adapter === 'typescript')
        expect(db.sql('SELECT rowid AS row,metadata_json FROM nodes WHERE id=?').get(row.id)).toEqual({ row: row.row, metadata_json: row.metadata_json });
    expect(db.db.pragma('integrity_check', { simple: true })).toBe('ok');
  }
  finally {
    db.close();
  }
}, 30000);
