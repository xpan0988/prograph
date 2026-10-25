// One targeted encoding-region profile pair, serial fresh children. No analysis.
// prepare INDEX INPUT; reference|candidate INPUT REPORT
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { getHeapStatistics } from 'node:v8';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as model from '../dist/core/semantic/model.js';
import { provenanceReuseCandidate } from './diagnostics/provenance-reuse-candidate.mjs';

const [mode, input, report] = process.argv.slice(2);
if (mode === 'prepare') {
  const db = new Database(path.join(input, 'semantic.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT p.key,p.json AS encoded,COUNT(*) AS uses FROM sc_owned o JOIN sc_claims c ON c.id=o.claim
      JOIN sc_provenance p ON p.id=c.provenance GROUP BY p.id ORDER BY p.key`).all();
    for (const row of rows) { const value = JSON.parse(row.encoded); assert.equal(model.canonical(value), row.encoded); assert.equal(model.semanticKey('provenance', value), row.key); }
    const uses = rows.reduce((n, r) => n + r.uses, 0), bytes = rows.reduce((n, r) => n + r.uses * Buffer.byteLength(r.encoded), 0);
    assert.equal(uses, 234946); assert.equal(bytes, 72341290);
    await writeFile(report, JSON.stringify({ uses, bytes, rows })); console.log(JSON.stringify({ groups: rows.length, uses, bytes }));
  } finally { db.close(); }
} else {
  assert.ok(['reference', 'candidate'].includes(mode));
  const dataset = JSON.parse(await readFile(input, 'utf8'));
  const rows = dataset.rows.map(row => ({ ...row, fact: { provenance: JSON.parse(row.encoded) } }));
  const encode = mode === 'candidate' ? provenanceReuseCandidate(model) : fact => {
    const encoded = model.canonical(fact.provenance);
    return { encoded, key: model.semanticKey('provenance', fact.provenance), reused: false };
  };
  const resources = () => ({ atMs: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), v8: getHeapStatistics(), usage: process.resourceUsage() });
  const session = new Session(); session.connect();
  const post = (method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
  await post('HeapProfiler.enable'); await post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false });
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
  const witness = createHash('sha256'); let count = 0, bytes = 0, reused = 0;
  const before = resources();
  for (const row of rows) for (let i = 0; i < row.uses; i++) {
    const value = encode(row.fact);
    assert.equal(value.encoded, row.encoded); assert.equal(value.key, row.key);
    witness.update(value.key); count++; bytes += Buffer.byteLength(value.encoded); if (value.reused) reused++;
  }
  const after = resources();
  const { profile: cpu } = await post('Profiler.stop'); const { profile: allocation } = await post('HeapProfiler.stopSampling'); session.disconnect();
  const self = new Map(), nodes = new Map(cpu.nodes.map(n => [n.id, n.callFrame]));
  for (let i = 0; i < cpu.samples.length; i++) { const frame = nodes.get(cpu.samples[i]), key = `${frame.url}:${frame.lineNumber + 1}:${frame.functionName}`; self.set(key, (self.get(key) ?? 0) + (cpu.timeDeltas[i] ?? 0)); }
  const result = { mode, count, bytes, reused, exactEncodedAndKeyComparisons: count, keySequenceSha256: witness.digest('hex'),
    before, after, elapsedMs: after.atMs - before.atMs, processCpuUs: after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system,
    allocatedBytes: after.v8.total_allocated_bytes - before.v8.total_allocated_bytes,
    selfSamples: [...self].sort((a, b) => b[1] - a[1]).slice(0, 25), sampledSurvivingBytes: allocation.samples.reduce((n, s) => n + s.size, 0),
    limits: 'Encoding-region replay, not addFact/SQL/analysis. Weighted real provenance groups reused as input across operations; no cached encodings. Assertions, counters and key-witness hashing are common timed overhead. Profile setup/teardown, input loading and artifact writes excluded from resource interval. No forced GC or Core-only RSS attribution. Aggregate V8 deltas include background and boundary-observer allocation.' };
  await writeFile(report, JSON.stringify(result, null, 2) + '\n'); await writeFile(report + '.cpuprofile', JSON.stringify(cpu));
  console.log(JSON.stringify({ mode, elapsedMs: result.elapsedMs, cpuUs: result.processCpuUs, allocatedBytes: result.allocatedBytes, reused, maxRssKiB: after.usage.maxRSS, witness: result.keySequenceSha256 }));
}
