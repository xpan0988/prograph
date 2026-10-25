// Opt-in, bounded Stage 6.5 diagnostic. Run prepare, reference, candidate serially.
// prepare SOURCE ACCEPTED_INDEX INPUT_JSON
// reference INPUT_JSON REFERENCE_BYTES REPORT_JSON
// candidate INPUT_JSON REFERENCE_BYTES REPORT_JSON
// All artifacts belong outside Git. No forced GC. No production analysis is run.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { getHeapStatistics } from 'node:v8';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonical, digest } from '../dist/core/semantic/model.js';
import { canonicalDigest, writeCanonical } from '../dist/core/semantic/canonical-hash.js';
const [mode, first, second, report] = process.argv.slice(2);
if (mode === 'prepare') {
  const { scanRepository } = await import('../dist/core/repository/repository.js');
  const { readSyntaxProjection } = await import('../dist/core/semantic/owned-projection.js');
  const { analysisPasses } = await import('../dist/core/semantic/analysis-passes.js');
  const { orderPasses, passContract } = await import('../dist/core/semantic/passes.js');
  const { readSnapshotReport } = await import('../dist/core/semantic/snapshot-report.js');
  const { snapshot } = await scanRepository(first, second);
  const db = new Database(path.join(second, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const active = Number(db.prepare("SELECT value FROM sc_meta WHERE key='active'").get().value);
    const source = readSyntaxProjection({ sql: sql => db.prepare(sql) }, active).result;
    if (source.inputReceipt) source.inputReceipt.inputs.sort((a, b) => a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0);
    const value = { sourceBinding: readSnapshotReport(db, active).sourceBinding,
      files: [...snapshot.fileContents].map(([file, text]) => [file, digest(text)]).sort(),
      inputs: source.inputReceipt ?? null, config: snapshot.config, configurationInput: snapshot.configurationInput ?? 'not-captured',
      passes: orderPasses(analysisPasses).map(passContract), nodes: source.nodes.sort((a, b) => a.id.localeCompare(b.id)), edges: source.edges.sort((a, b) => a.id.localeCompare(b.id)) };
    const expected = db.prepare("SELECT r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key='analysis/catalogue'").get(active).input_fingerprint;
    assert.equal(digest(canonical(value)), expected, 'Reconstructed value must match the actual accepted fingerprint before profiling');
    // Diagnostic preparation only: this JSON transfer buffer is outside both
    // production results and timed/profiled encoding regions in fresh children.
    await writeFile(report, JSON.stringify({ expected, value }));
    console.log(JSON.stringify({ input: report, expected, nodes: value.nodes.length, edges: value.edges.length }));
  } finally { db.close(); }
} else {
  if (!['reference', 'candidate'].includes(mode) || !first || !second || !report) throw Error('MODE INPUT REFERENCE_BYTES REPORT required');
  const input = JSON.parse(await readFile(first, 'utf8'));
  const resources = () => ({ atMs: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), v8: getHeapStatistics(), usage: process.resourceUsage() });
  const session = new Session(); session.connect();
  const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (error, result) => error ? reject(error) : resolve(result)));
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false });
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
  const before = resources(); let encoded, hash;
  const stats = { bytes: 0, chunks: 0, maxChunkBytes: 0, referenceFallback: 0 };
  if (mode === 'reference') {
    encoded = canonical(input.value); hash = digest(encoded);
    stats.bytes = Buffer.byteLength(encoded); stats.chunks = 1; stats.maxChunkBytes = stats.bytes;
  } else hash = canonicalDigest(input.value, stats);
  const after = resources();
  const { profile: cpu } = await post('Profiler.stop');
  const { profile: allocations } = await post('HeapProfiler.stopSampling'); session.disconnect();
  assert.equal(hash, input.expected, 'Reconstructed input must hash to the actual accepted production fingerprint');
  const frames = new Map(cpu.nodes.map(node => [node.id, { ...node.callFrame, selfUs: 0, inclusiveUs: 0, parents: [] }]));
  for (const node of cpu.nodes) for (const child of node.children ?? []) frames.get(child).parents.push(node.id);
  for (let i = 0; i < (cpu.samples ?? []).length; i++) {
    const id = cpu.samples[i], time = cpu.timeDeltas[i] ?? 0; frames.get(id).selfUs += time;
    const seen = new Set(), visit = id => { if (seen.has(id)) return; seen.add(id); const frame = frames.get(id); frame.inclusiveUs += time; for (const parent of frame.parents) visit(parent); }; visit(id);
  }
  const allocationFrames = [];
  const walk = (node, stack) => { const next = [...stack, node.callFrame]; if (node.selfSize) allocationFrames.push({ stack: next, selfBytes: node.selfSize }); for (const child of node.children) walk(child, next); }; walk(allocations.head, []);
  // Filesystem/byte-oracle work happens AFTER the recorded encoding resources
  // and both profiles stop. It is never subtracted from a production RSS peak.
  let byteOracle;
  if (mode === 'reference') await writeFile(second, encoded);
  else {
    const fd = openSync(second, 'r'); let at = 0; const h = createHash('sha256');
    try {
      const observed = writeCanonical(input.value, chunk => {
        const bytes = Buffer.from(chunk), expected = Buffer.allocUnsafe(bytes.length); let read = 0;
        while (read < bytes.length) { const n = readSync(fd, expected, read, bytes.length - read, at + read); assert.ok(n > 0); read += n; }
        assert.ok(bytes.equals(expected), 'Complete canonical bytes differ'); h.update(bytes); at += bytes.length;
      });
      assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, at), 0); assert.equal(h.digest('hex'), input.expected);
      byteOracle = { equal: true, bytes: at, stats: observed };
    } finally { closeSync(fd); }
  }
  const summary = { mode, expected: input.expected, hash, stats, before, after, elapsedMs: after.atMs - before.atMs,
    processCpuUs: after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system,
    allocatedBytes: after.v8.total_allocated_bytes - before.v8.total_allocated_bytes,
    sampledLiveAllocationBytes: allocations.samples.reduce((n, s) => n + s.size, 0),
    cpuSamples: cpu.samples.length, cpuTop: [...frames.values()].map(({ parents, ...frame }) => frame).sort((a, b) => b.selfUs - a.selfUs).slice(0, 30),
    allocationTop: allocationFrames.sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 25), byteOracle,
    limits: 'Encoding-only timing includes counter bookkeeping and profiler overhead. Whole child high-water includes startup/input loading; post-timing artifacts and candidate byte-oracle pass excluded from recorded after resources. No Core-only RSS attribution.' };
  await writeFile(report, JSON.stringify(summary, null, 2) + '\n'); await writeFile(report + '.cpuprofile', JSON.stringify(cpu));
  console.log(JSON.stringify({ mode, elapsedMs: summary.elapsedMs, cpuUs: summary.processCpuUs, allocatedBytes: summary.allocatedBytes, maxRssThroughEncodingKiB: after.usage.maxRSS, stats, byteOracle }));
}
