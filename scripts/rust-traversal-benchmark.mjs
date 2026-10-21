// One fresh-process side of the bounded Stage 6.2 before/after pair.
// node --max-old-space-size=2048 scripts/rust-traversal-benchmark.mjs RUNTIME SOURCE REPORT
// RUNTIME is a compiled dist directory with its original dependency resolution.
import { Session } from 'node:inspector';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [runtime, source, report] = process.argv.slice(2);
const load = file => import(pathToFileURL(path.join(runtime, file + '.js')).href);
const { rustAdapter } = await load('adapters/language/rust/index');
const { scanRepository } = await load('core/repository/repository');
const { installAnalysisDiagnostics } = await load('core/analysis/diagnostics');
const { canonical, digest } = await load('core/semantic/model');
const scan = await scanRepository(source);
const inventory = digest(canonical([...scan.snapshot.fileContents].map(([f, t]) => [f, digest(t)]).sort()));
if (inventory !== '729c1eb199f09ccd9739634699bdc004388402544fcc8806c674ba471b6365b8') throw Error('Pinned source inventory mismatch');
const events = [], metrics = () => ({ atMs: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), usage: process.resourceUsage() });
const detach = installAnalysisDiagnostics(event => events.push({ ...event, ...metrics() }));
const session = new Session(); session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
const before = metrics();
const result = await rustAdapter.analyze(scan.snapshot);
const after = metrics();
const { profile } = await post('Profiler.stop'); session.disconnect(); detach();
await writeFile(report + '.cpuprofile', JSON.stringify(profile));
const serialized = JSON.stringify(result);
const sha256 = createHash('sha256').update(serialized).digest('hex');
await writeFile(report + '.output.json', serialized);
const summary = { format: 1, runtime, source, node: process.version, inventory, elapsedMs: after.atMs - before.atMs, before, after, events,
  counts: { nodes: result.nodes.length, edges: result.edges.length, diagnostics: result.diagnostics.length }, orderedJsonBytes: Buffer.byteLength(serialized), orderedJsonSha256: sha256 };
await writeFile(report, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ report, elapsedMs: summary.elapsedMs, peakRssKiB: after.usage.maxRSS, counts: summary.counts, sha256 }));
