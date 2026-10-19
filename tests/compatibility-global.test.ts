import { fileArchitecture } from '../src/core/query/file-architecture.js';
import { canonical } from '../src/core/semantic/model.js';
import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeRepository } from '../src/core/analysis/analyze.js';
import { SemanticStore } from '../src/core/semantic/store.js';
import { QueryService } from '../src/core/query/query-service.js';
import { CompatibilityGlobalRead } from '../src/core/query/compatibility-global-read.js';
import { NavigationRead } from '../src/core/query/navigation.js';
import { QUERY_SCOPES } from '../src/core/query/global-projections.js';
import { COMPATIBILITY_QUERY_SQL, updateCompatibilityNodes, updateCompatibilityEdges, updateCompatibilityDiagnostics, updateCompatibilityFileRows, updateCompatibilityArchitecture } from '../src/core/semantic/compatibility-global.js';
import type { CompatibilityChange } from '../src/core/semantic/compatibility-cache.js';
const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0))
    await rm(p, { recursive: true, force: true });
});
test('incremental scalar summaries and file rows agree with the frozen compatibility query surface across scopes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prograph-query-projection-'));
  roots.push(root);
  const result = await analyzeRepository(path.resolve('tests/fixtures/mixed'), { output: root });
  expect(result.manifest.semanticCore?.status, result.manifest.semanticCore?.reason).toBe('partial');
  const store = new SemanticStore(path.join(root, 'semantic.sqlite')), legacy = new QueryService(path.join(root, 'graph.sqlite'));
  try {
    const changes: CompatibilityChange[] = [...result.graph.nodes.map(after => ({ kind: 'node' as const, key: after.id, after })), ...result.graph.edges.map(after => ({ kind: 'edge' as const, key: after.id, after })), ...result.graph.diagnostics.map((after, i) => ({ kind: 'diagnostic' as const, key: String(i), after }))];
    const view = new CompatibilityGlobalRead(store.db, new NavigationRead(store.db));
    for (const scope of QUERY_SCOPES) {
      for (let level = 0;level < 3;level++) {
        const options = { scope, includeProbable: level > 0, includeUnresolved: level > 1 };
        const actual = new CompatibilityGlobalRead(store.db, new NavigationRead(store.db)).architecture(100, scope, level), expected = legacy.architecture(100, options);
        expect(new Set(actual.nodes.map(node => node.id))).toEqual(new Set(expected.nodes.map(node => node.id)));
        expect(new Set(actual.edges.map(edge => edge.id))).toEqual(new Set(expected.edges.map(edge => edge.id)));
        expect(actual.truncated).toBe(expected.truncated);
      }
      const expected = legacy.overview({ scope }) as {
        counts: {
          nodes: number;
          edges: number;
          files: number;
        };
        nodesByKind: unknown[];
        edgesByKind: unknown[];
      };
      expect(view.summary(scope)).toMatchObject({ counts: expected.counts });
      expect(new Set(view.files(scope).map(JSON.stringify))).toEqual(new Set(legacy.files({ scope }).map(JSON.stringify)));
      const rows = store.sql('SELECT dimension,kind,n FROM cq_counts WHERE scope=?').all(scope) as Array<{
        dimension: string;
        kind: string;
        n: number;
      }>;
      const count = (dimension: string) => rows.filter(row => row.dimension === dimension).reduce((n, row) => n + row.n, 0);
      expect(count('nodes')).toBe(expected.counts.nodes);
      expect(count('edges')).toBe(expected.counts.edges);
      expect(rows.find(row => row.dimension === 'total' && row.kind === 'files')?.n ?? 0).toBe(expected.counts.files);
      const files = (store.sql('SELECT data FROM cq_files WHERE scope=? ORDER BY path').all(scope) as Array<{
        data: string;
      }>).map(row => JSON.parse(row.data));
      const original = legacy.files({ scope });
      expect(new Set(files.map(JSON.stringify))).toEqual(new Set(original.map(JSON.stringify)));
    }
    const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize).sort((a, b) => canonical(a).localeCompare(canonical(b))) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).map(([key, value]) => [key, normalize(value)])) : value;
    for (let level = 0;level < 3;level++) {
      const options = { includeProbable: level > 0, includeUnresolved: level > 1 }, actual = new CompatibilityGlobalRead(store.db, new NavigationRead(store.db)).architecture(100, 'code', level), reference = fileArchitecture([...result.graph.nodes].sort((a, b) => binary(a.id, b.id)), [...result.graph.edges].sort((a, b) => binary(a.id, b.id)), 100, options, binary);
      expect(normalize(actual)).toEqual(normalize(reference));
    }
    for (const framework of [undefined, 'tauri', 'http', 'graphql', 'grpc'])
      for (let level = 0;level < 3;level++) {
        const actual = new CompatibilityGlobalRead(store.db, new NavigationRead(store.db)).framework(framework, level);
        const expected = new (await import('../src/core/query/global-read.js')).GlobalRead(legacy.database, new NavigationRead(legacy.database)).framework(framework, level);
        expect(new Set(actual.selected.map(node => node.id))).toEqual(new Set(expected.selected.map(node => node.id)));
        expect(new Set(actual.edges.map(edge => edge.id))).toEqual(new Set(expected.edges.map(edge => edge.id)));
        expect(actual.truncated).toBe(expected.truncated);
      }
    for (const [sql, args] of [
      ["SELECT n.* FROM cq_nodes q INDEXED BY cq_node_file_navigation CROSS JOIN nodes n ON n.id=q.node WHERE q.file=? ORDER BY q.start_line,q.name,q.node", ['src/main.ts']],
      ["SELECT edge,mask,level FROM cq_edges INDEXED BY cq_edge_pair WHERE source=? AND target=? AND edge>? ORDER BY edge LIMIT 1", ['a', 'b', '']],
      ["SELECT node FROM cq_nodes WHERE context_eligible=1 ORDER BY degree DESC,qualified,node LIMIT 2000", []],
      ["SELECT node FROM cq_scope_nodes WHERE scope=? ORDER BY rank,qualified,node LIMIT 101", ['full']],
      // A node can belong to every scope/framework. Publication must not scan
      // all other symbols to clear these rows once for every changed node.
      ["DELETE FROM cq_scope_nodes WHERE node=?", ['a']],
      ["DELETE FROM cq_boundaries WHERE node=?", ['a']],
      ["SELECT framework FROM cq_boundaries WHERE node=?", ['a']],
      ["SELECT edge FROM cq_flow WHERE source=? AND target=? AND level=? ORDER BY edge LIMIT 24", ['a', 'b', 0]],
    ] as const) {
      const plan = store.sql('EXPLAIN QUERY PLAN ' + sql).all(...args) as Array<{
        detail: string;
      }>;
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
      expect(plan.some(row => /SEARCH|USING INDEX|USING COVERING INDEX/.test(row.detail))).toBe(true);
    }
    const before = store.sql('SELECT * FROM cq_nodes ORDER BY node').all();
    const beforeScopes = store.sql('SELECT * FROM cq_scope_nodes ORDER BY scope,node').all();
    const beforeBoundaries = store.sql('SELECT * FROM cq_boundaries ORDER BY framework,node').all();
    store.db.transaction(() => { const changesAgain = changes.filter(change => change.kind === 'node').map(change => ({ ...change, before: change.after })); const nodes = updateCompatibilityNodes(store, changesAgain); updateCompatibilityEdges(store, changesAgain, nodes.edgeNodes); })();
    expect(store.sql('SELECT * FROM cq_nodes ORDER BY node').all()).toEqual(before);
    expect(store.sql('SELECT * FROM cq_scope_nodes ORDER BY scope,node').all()).toEqual(beforeScopes);
    expect(store.sql('SELECT * FROM cq_boundaries ORDER BY framework,node').all()).toEqual(beforeBoundaries);
  }
  finally {
    legacy.close();
    store.close();
  }
}, 30000);
