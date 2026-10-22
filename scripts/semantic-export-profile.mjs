// One serial before/after export pair, using accepted saved outputs as inputs.
// node --max-old-space-size=2048 scripts/semantic-export-profile.mjs before|after INPUT_INDEX FRESH_OUTPUT REPORT
// Hashing occurs after timing. No GC, inspector, compiler, or analysis is invoked.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import path from 'node:path';
import { writeJsonExports } from '../dist/core/storage/json-export.js';

const [mode, input, output, report] = process.argv.slice(2);
if (!['before', 'after'].includes(mode) || !input || !output || !report) throw Error('MODE INPUT_INDEX FRESH_OUTPUT REPORT required');
if (path.resolve(input) === path.resolve(output)) throw Error('Use a fresh output');
try { await stat(output); throw Error('Output exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const resources = () => ({ atMs: performance.now(), memory: process.memoryUsage(), v8: getHeapStatistics(), cpu: process.cpuUsage(), usage: process.resourceUsage() });
const startedAt = new Date().toISOString(), initial = resources(), samples = [], gc = [];
const values = {};
for (const [key, name] of Object.entries({ graph: 'exports/graph.json', manifest: 'manifest.json', diagnostics: 'diagnostics.json', state: 'state.json' }))
  values[key] = JSON.parse(await readFile(path.join(input, name), 'utf8'));
await mkdir(path.join(output, 'exports'), { recursive: true });
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gc.push({ startMs: e.startTime, durationMs: e.duration, kind: e.detail.kind }); });
observer.observe({ entryTypes: ['gc'] });
const before = resources(), timer = setInterval(() => samples.push(resources()), 20);
let writerStats;
try {
  if (mode === 'before') {
    // Exact accepted arguments and concurrency; deliberately no optimized helper.
    await Promise.all([
      writeFile(path.join(output, 'exports/graph.json'), `${JSON.stringify(values.graph, null, 2)}\n`),
      writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(values.manifest, null, 2)}\n`),
      writeFile(path.join(output, 'diagnostics.json'), `${JSON.stringify(values.diagnostics, null, 2)}\n`),
      writeFile(path.join(output, 'state.json'), `${JSON.stringify(values.state, null, 2)}\n`),
    ]);
  } else writerStats = await writeJsonExports(output, values);
} finally { clearInterval(timer); }
const after = resources();
await new Promise(resolve => setImmediate(() => setImmediate(resolve))); observer.disconnect();
const files = {};
for (const name of ['exports/graph.json', 'manifest.json', 'diagnostics.json', 'state.json']) {
  const h = createHash('sha256'); for await (const chunk of createReadStream(path.join(output, name))) h.update(chunk);
  files[name] = { bytes: (await stat(path.join(output, name))).size, sha256: h.digest('hex') };
}
const result = { format: 1, mode, input, output, startedAt, node: process.version, argv: process.execArgv,
  initial, before, after, elapsedMs: after.atMs - before.atMs, samples, gc, writerStats, files,
  limits: 'Fresh process for each arm; input parsing before timing but included in cumulative maxRSS. 20ms memory samples omit synchronous peaks. No forced GC. Native before buffers are not individually instrumented. OS cache/order and GC variation remain confounders.' };
await writeFile(report, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ mode, elapsedMs: result.elapsedMs, maxRssKiB: after.usage.maxRSS, beforeMemory: before.memory, afterMemory: after.memory, writerStats, files }));
