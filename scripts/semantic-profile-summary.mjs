// Reduce local raw diagnostics to a compact, auditable receipt. Never copies raw profiles.
// node scripts/semantic-profile-summary.mjs RUN_DIRECTORY OUTPUT.json
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
const [directory, output] = process.argv.slice(2);
const load = async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
const sha = async file => createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
const modes = ['baseline', 'phases', 'cpu', 'memory'];
const witnesses = await Promise.all(modes.map(mode => load(`${mode}-witness.json`)));
const runs = [];
for (const [i, mode] of modes.entries()) {
  const data = await load(`${mode}.json`), starts = new Map(), phases = [], publication = [];
  for (const event of data.events) {
    if (event.kind === 'begin') starts.set(event.id, event);
    else if (event.kind === 'end') {
      const before = starts.get(event.id);
      if (!before) throw Error(`Missing begin ${event.phase}`);
      phases.push({ phase: event.phase, startMs: before.atMs - data.before.atMs, endMs: event.atMs - data.before.atMs,
        wallMs: event.atMs - before.atMs, cpuUserMs: (event.cpu.user - before.cpu.user) / 1000,
        cpuSystemMs: (event.cpu.system - before.cpu.system) / 1000, before: before.memory, after: event.memory,
        heapCommittedBytes: event.v8.total_physical_size, cumulativeMaxRssKiB: event.usage.maxRSS, counts: event.counts });
      starts.delete(event.id);
    } else publication.push({ phase: event.phase, durationMs: event.counts.durationMs, endMs: event.atMs - data.before.atMs,
      memory: event.memory, cumulativeMaxRssKiB: event.usage.maxRSS });
  }
  if (starts.size) throw Error('Unclosed diagnostic phases');
  let processes;
  if (mode !== 'baseline') {
    const raw = await load(`${mode}-processes.json`);
    const root = raw.samples.flatMap(s => s.processes.filter(p => p.pid === raw.rootPid).map(p => ({
      elapsedMs: s.elapsedMs, analysisRelativeMsApprox: s.elapsedMs - data.before.atMs, rssKiB: p.rssKiB, cpu: p.cpu })));
    const peak = root.reduce((a, b) => b.rssKiB > a.rssKiB ? b : a);
    const children = new Map();
    for (const sample of raw.samples) for (const p of sample.processes) if (p.pid !== raw.rootPid) {
      const previous = children.get(p.pid);
      children.set(p.pid, { pid: p.pid, executable: p.executable, firstMs: previous?.firstMs ?? sample.elapsedMs,
        lastMs: sample.elapsedMs, peakRssKiB: Math.max(previous?.peakRssKiB ?? 0, p.rssKiB) });
    }
    processes = { intervalMs: raw.intervalMs, processLifetimeMs: raw.elapsedMs, samples: root.length, peak, children: [...children.values()],
      totalSamplerElapsedMs: raw.samples.reduce((n, s) => n + s.samplerMs, 0),
      timeline: root.filter((_, n) => n % 10 === 0 || root[n] === peak || n === root.length - 1),
      phasePeaks: phases.map(phase => ({ phase: phase.phase, startMs: phase.startMs,
        peakSampledRssKiB: Math.max(0, ...root.filter(s => s.analysisRelativeMsApprox >= phase.startMs && s.analysisRelativeMsApprox <= phase.endMs).map(s => s.rssKiB)) || null })) };
  }
  const gc = data.gc.filter(e => e.startMs >= data.before.atMs && e.startMs <= data.after.atMs);
  runs.push({ mode, elapsedMs: data.elapsedMs, startedAt: data.startedAt, cpuUserMs: (data.after.cpu.user - data.before.cpu.user) / 1000,
    cpuSystemMs: (data.after.cpu.system - data.before.cpu.system) / 1000, before: data.before.memory, after: data.after.memory,
    maxRssKiB: data.after.usage.maxRSS, usage: data.after.usage, v8After: data.after.v8,
    v8AllocatedDuringAnalysisBytes: data.after.v8.total_allocated_bytes - data.before.v8.total_allocated_bytes,
    phases, publication, gc: mode === 'baseline' ? null : { entries: gc.length, observedDurationMs: gc.reduce((n, e) => n + e.durationMs, 0),
      maxPauseMs: Math.max(0, ...gc.map(e => e.durationMs)), byKind: Object.fromEntries([...new Set(gc.map(e => e.kind))].map(k => [k, gc.filter(e => e.kind === k).length])) },
    allocations: data.allocations.map(a => ({ ...a, topSelf: a.topSelf.slice(0, 12), topInclusive: a.topInclusive.slice(0, 18) })), diagnosticErrors: data.diagnosticErrors ?? [], sqliteConnections: data.sqliteConnections ?? [], methodCalls: data.methodCalls ?? {},
    counts: data.counts, databaseBytes: data.databaseBytes, processes,
    witness: { acceptedChecksumsEqual: witnesses[i].acceptedChecksumsEqual, legacySqliteEqual: witnesses[i].legacySqliteEqual,
      jsonWitness: witnesses[i].jsonWitness, sqlite: witnesses[i].sqlite, bytes: witnesses[i].bytes },
    rawSummarySha256: await sha(`${mode}.json`) });
}
const p = await load('cpu.json.cpuprofile'), nodes = new Map(p.nodes.map(n => [n.id, n])), parents = new Map();
p.nodes.forEach(n => n.children?.forEach(c => parents.set(c, n.id)));
const frames = new Map(), stackGroups = {}, nativeTreeAncestry = {};
let compilerSdkStackMs = 0, digestStackMs = 0, canonicalStackMs = 0;
const frameKey = n => JSON.stringify(n.callFrame);
const maps = new Map(), repository = fileURLToPath(new URL('../', import.meta.url));
function originalLocation(f) {
  if (!f.url.startsWith(`file://${repository}dist/`)) return {};
  try {
    const file = fileURLToPath(f.url); let map = maps.get(file);
    if (!map) { map = new SourceMap(JSON.parse(readFileSync(file + '.map', 'utf8'))); maps.set(file, map); }
    const entry = map.findEntry(f.lineNumber, f.columnNumber);
    return entry.originalSource ? { source: path.relative(repository, path.resolve(path.dirname(file), entry.originalSource)), sourceLine: entry.originalLine + 1 } : {};
  } catch { return {}; }
}
const get = n => {
  const key = frameKey(n); let frame = frames.get(key);
  if (!frame) { frame = { function: n.callFrame.functionName, url: n.callFrame.url.replace('file:///Users/xiyuanpan/prograph/', ''),
    line: n.callFrame.lineNumber + 1, column: n.callFrame.columnNumber + 1, ...originalLocation(n.callFrame), selfMs: 0, inclusiveMs: 0, sampleHits: 0 }; frames.set(key, frame); }
  return frame;
};
for (let i = 0; i < p.samples.length; i++) {
  let id = p.samples[i]; const ms = p.timeDeltas[i] / 1000, seen = new Set(), stack = [];
  get(nodes.get(id)).selfMs += ms; get(nodes.get(id)).sampleHits++;
  while (id) {
    const node = nodes.get(id), key = frameKey(node); stack.push(node.callFrame);
    if (!seen.has(key)) { get(node).inclusiveMs += ms; seen.add(key); }
    id = parents.get(id);
  }
  const has = pattern => stack.some(f => pattern.test(f.url));
  const leaf = stack[0];
  if (has(/@ts-morph\/common\/dist\/typescript\.js/)) compilerSdkStackMs += ms;
  if (stack.some(f => f.functionName === 'digest' && /(?:semantic\/model|graph\/identity)\.js/.test(f.url))) digestStackMs += ms;
  if (stack.some(f => f.functionName === 'canonical' && /semantic\/model\.js/.test(f.url))) canonicalStackMs += ms;
  if (leaf.functionName === 'TreeCursor') {
    const ancestry = stack.slice(1, 4).map(f => `${f.functionName} ${f.url.replace('file:///Users/xiyuanpan/prograph/', '')}:${f.lineNumber + 1}`).join(' < ');
    nativeTreeAncestry[ancestry] = (nativeTreeAncestry[ancestry] ?? 0) + ms;
  }
  // Mutually exclusive stack membership, not an estimate of subsystem CPU or RSS.
  const category = leaf.functionName === '(idle)' ? 'idle' : leaf.functionName === '(garbage collector)' ? 'gc' :
    has(/adapters\/language\/rust\//) ? 'rust-syntax' : has(/semantic\/owned-projection|semantic\/analysis-passes|semantic\/projection-shards|semantic\/boundary-shards/) ? 'owned-analysis' :
    has(/semantic\/compatibility-cache|semantic\/compatibility-global/) ? 'compatibility-publication' :
    has(/storage\/sqlite|query\/global-projections/) ? 'legacy-sqlite-export' :
    has(/semantic\/typescript/) ? 'typescript-semantic-including-staging' : has(/adapters\/language\/typescript\//) ? 'typescript-legacy' : 'other';
  stackGroups[category] = (stackGroups[category] ?? 0) + ms;
}
const cpu = { requestedIntervalUs: 1000, samples: p.samples.length, profileDurationMs: (p.endTime - p.startTime) / 1000,
  weightedSampleMs: p.timeDeltas.reduce((n, x) => n + x, 0) / 1000, stackGroups, compilerSdkStackMs, digestStackMs, canonicalStackMs,
  nativeTreeAncestry: Object.entries(nativeTreeAncestry).sort((a, b) => b[1] - a[1]).slice(0, 12),
  topSelf: [...frames.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 45),
  topInclusive: [...frames.values()].sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 65), rawSha256: await sha('cpu.json.cpuprofile') };
if (new Set(witnesses.map(w => JSON.stringify(w.jsonWitness))).size !== 1) throw Error('Complete normalized JSON outputs changed');
const receipt = { format: 1, scope: 'Four serial fresh complete analyses; no optimization or qualification claim',
  baselineRevision: 'd6bfa109229748ecc4da875713ea7e9c31aa5a9a', acceptedRuntime: 'f0af75338e8b3b1cb9462c354d71c901bc5aa4d2',
  implementation: await load('implementation.json'), validation: await load('validation.json'),
  corpus: await load('corpus.json'), toolchain: await load('toolchain.json'), storageShape: await load('storage-shape.json'), sourceStats: witnesses[0].sourceStats, acceptedChecksums: witnesses[0].checksums,
  runtime: { node: (await load('baseline.json')).node, versions: (await load('baseline.json')).versions }, runs, cpu,
  limits: ['RSS is process-wide; in-process Core/compiler/native allocations cannot be separated by RSS subtraction',
    'ps timeline alignment to process performance.now is approximate; 100ms samples can miss transients/short-lived children',
    'CPU weights represent sampled stack residence; native SQLite calls include CPU and waits',
    'Allocation weights are estimates of not-yet-collected sampled JS allocations, not dominator retained sizes or native allocations',
    'Single serial samples, uncontrolled OS cache/other apps; elapsed deltas do not isolate profiling overhead'] };
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, runs: runs.map(r => ({ mode: r.mode, elapsedMs: r.elapsedMs, maxRssKiB: r.maxRssKiB })) }));
