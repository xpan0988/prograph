// Bounded real-source diagnostic runner. Raw profiles belong outside the repository.
// node --max-old-space-size=2048 scripts/semantic-profile.mjs MODE SOURCE OUTPUT REPORT
// MODE: baseline | phases | cpu | memory. Use a fresh OUTPUT for every run.
import { Session } from 'node:inspector';
import { PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [mode, source, output, report] = process.argv.slice(2);
if (!['baseline', 'phases', 'cpu', 'memory'].includes(mode) || !source || !output || !report) throw Error('MODE SOURCE OUTPUT REPORT required');
if (path.resolve(output).startsWith(path.resolve(source) + path.sep)) throw Error('Use an external output');
try { await stat(output); throw Error('Output already exists; use a fresh index'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const session = new Session();
const post = (method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
if (mode === 'cpu' || mode === 'memory') session.connect();
if (mode === 'memory') {
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false });
}
const { analyzeRepository } = await import('../dist/core/analysis/analyze.js');
const events = [], gc = [], allocations = [], diagnosticErrors = [], sqliteConnections = [], methodCalls = {};
const resources = () => ({ atMs: performance.now(), memory: process.memoryUsage(), v8: getHeapStatistics(), cpu: process.cpuUsage(), usage: process.resourceUsage() });
function allocationSummary(label, profile) {
  const frames = new Map(), categories = {};
  function walk(node, ancestors) {
    const f = node.callFrame;
    const key = `${f.url}:${f.lineNumber + 1}:${f.functionName}`;
    const stack = [...ancestors, key];
    const category = stack.some(s => /node_modules\/(?:@ts-morph|ts-morph)\//.test(s)) ? 'typescript-and-ts-morph' :
      stack.some(s => /node_modules\/tree-sitter\//.test(s)) ? 'tree-sitter-js-wrappers' :
      stack.some(s => s.includes('/semantic/model.js')) ? 'canonical-and-identity' :
      stack.some(s => s.includes('/semantic/owned-projection.js') || s.includes('/semantic/projection-shards.js')) ? 'owned-projection' :
      stack.some(s => s.includes('/storage/sqlite.js') || s.includes('/query/global-projections.js')) ? 'legacy-sqlite-export' :
      stack.some(s => s.includes('/analysis/analyze.js')) ? 'other-analysis-and-json-export' : 'other-or-startup';
    categories[category] = (categories[category] ?? 0) + node.selfSize;
    for (const frame of new Set(stack)) {
      const row = frames.get(frame) ?? { frame, selfBytes: 0, inclusiveBytes: 0 };
      row.inclusiveBytes += node.selfSize;
      if (frame === key) row.selfBytes += node.selfSize;
      frames.set(frame, row);
    }
    for (const child of node.children) walk(child, stack);
  }
  walk(profile.head, []);
  return { label, atMs: performance.now(), samples: profile.samples.length, estimatedLiveBytes: profile.samples.reduce((n, s) => n + s.size, 0), categories,
    topSelf: [...frames.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 35),
    topInclusive: [...frames.values()].sort((a, b) => b.inclusiveBytes - a.inclusiveBytes).slice(0, 45) };
}
let observer, uninstall;
if (mode !== 'baseline') {
  const { SemanticStore } = await import('../dist/core/semantic/store.js');
  const observed = new WeakSet(), batch = SemanticStore.prototype.batch;
  SemanticStore.prototype.batch = function (...args) {
    if (!observed.has(this)) {
      observed.add(this);
      sqliteConnections.push({ atMs: performance.now(), filename: this.filename, journal: this.db.pragma('journal_mode', { simple: true }),
        synchronous: this.db.pragma('synchronous', { simple: true }), cacheSize: this.db.pragma('cache_size', { simple: true }),
        mmapSize: this.db.pragma('mmap_size', { simple: true }), pageSize: this.db.pragma('page_size', { simple: true }) });
    }
    return batch.apply(this, args);
  };
  if (mode === 'memory') {
    for (const name of ['batch', 'begin', 'seal', 'addFact', 'addEntity', 'addOccurrence', 'sql']) {
      const original = SemanticStore.prototype[name];
      SemanticStore.prototype[name] = function (...args) { methodCalls[name] = (methodCalls[name] ?? 0) + 1; return original.apply(this, args); };
    }
    const { GraphBuilder } = await import('../dist/core/graph/builder.js');
    const original = GraphBuilder.prototype.result;
    GraphBuilder.prototype.result = function (...args) {
      const result = original.apply(this, args);
      methodCalls.graphResults = (methodCalls.graphResults ?? 0) + 1;
      methodCalls.graphArraySlots = (methodCalls.graphArraySlots ?? 0) + result.nodes.length + result.edges.length + result.diagnostics.length;
      return result;
    };
  }
  observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({ startMs: e.startTime, durationMs: e.duration, kind: e.detail.kind, flags: e.detail.flags }); });
  observer.observe({ entryTypes: ['gc'] });
  const { installAnalysisDiagnostics } = await import('../dist/core/analysis/diagnostics.js');
  uninstall = installAnalysisDiagnostics(event => {
    events.push({ ...event, ...resources() });
    // Synchronous inspector snapshots sample live allocations without requesting GC.
    if (mode === 'memory' && event.kind === 'end' && ['adapter:rust', 'owned-analysis', 'semantic-typescript', 'semantic-publication', 'json-export'].includes(event.phase)) {
      const start = performance.now();
      session.post('HeapProfiler.getSamplingProfile', {}, (error, result) => {
        if (error) { diagnosticErrors.push(String(error)); return; }
        try { allocations.push({ ...allocationSummary(event.phase, result.profile), diagnosticOverheadMs: performance.now() - start }); }
        catch (error) { diagnosticErrors.push(String(error)); }
      });
    }
  });
}
if (mode === 'cpu') { await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start'); }
const before = resources(), startedAt = new Date().toISOString();
const result = await analyzeRepository(source, { output });
const after = resources(), elapsedMs = after.atMs - before.atMs;
if (result.manifest.semanticCore?.status === 'failed') throw Error(result.manifest.semanticCore.reason);
if (mode === 'cpu') { const { profile } = await post('Profiler.stop'); await writeFile(`${report}.cpuprofile`, JSON.stringify(profile)); }
if (mode === 'memory') { const { profile } = await post('HeapProfiler.stopSampling'); allocations.push(allocationSummary('returned-result', profile)); }
uninstall?.();
await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
observer?.disconnect();
if (mode === 'cpu' || mode === 'memory') session.disconnect();
const summary = { format: 1, mode, source, output, startedAt, node: process.version, versions: process.versions, argv: process.execArgv,
  before, after, elapsedMs, events, gc, allocations, diagnosticErrors, sqliteConnections, methodCalls, counts: { nodes: result.graph.nodes.length, edges: result.graph.edges.length, diagnostics: result.graph.diagnostics.length },
  manifest: result.manifest, databaseBytes: (await stat(path.join(output, 'semantic.sqlite'))).size };
await writeFile(report, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ mode, report, elapsedMs, maxRssKiB: after.usage.maxRSS, counts: summary.counts }));
