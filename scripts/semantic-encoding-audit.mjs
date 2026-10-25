// Explicit, opt-in build-copy diagnostic. Never rewrites the production runtime.
// prepare RUNTIME AUDITED_COPY; run AUDITED_COPY SOURCE INDEX PHASE_REPORT
import { SourceMap } from 'node:module';
import { readFile, writeFile, readdir, mkdir, cp, symlink, access } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import path from 'node:path';

export const AUDIT_KEY = Symbol.for('prograph.encoding-audit');
const hash = text => createHash('sha256').update(text).digest('hex');

/** Prefix-only edits preserve argument evaluation and original line numbers.
 * canonical's recursive implementation is deliberately NOT instrumented.
 */
export async function instrumentCanonicalModule(text, file, mapping, first = 0) {
  const { default: ts } = await import('typescript'); // preparation only, never the measured runner
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imported = source.statements.some(node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text.endsWith('model.js') && node.importClause?.namedBindings?.elements?.some(item => item.name.text === 'canonical'));
  if (!imported && !file.endsWith('/semantic/model.js')) return { text, sites: [] };
  const edits = [], sites = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'canonical') return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'canonical') {
      if (node.arguments.length !== 1) throw Error('Audit requires the accepted one-argument call contract');
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const location = mapping?.findEntry(position.line, position.character);
      const id = first + sites.length;
      const expression = node.arguments[0].getText(source);
      const semanticKey = file.endsWith('/semantic/model.js') && expression === 'value';
      const category = file.endsWith('/semantic/model.js') && expression === 'input.provenance' ? 'validate-provenance'
        : file.endsWith('/semantic/model.js') && expression === 'input.value ?? {}' ? 'validate-value'
        : file.endsWith('/semantic/store.js') && expression === 'fact.provenance' ? 'persist-provenance'
        : file.endsWith('/semantic/store.js') && expression === 'fact.value ?? {}' ? 'persist-value'
        : semanticKey ? 'semantic-key' : 'other';
      sites.push({ id, file, line: position.line + 1, column: position.character + 1,
        source: location?.originalSource, sourceLine: location ? location.originalLine + 1 : undefined, expression, category });
      const open = node.getChildren(source).find(child => child.kind === ts.SyntaxKind.OpenParenToken);
      edits.push([node.expression.getStart(source), node.expression.end, 'globalThis[Symbol.for("prograph.encoding-audit")].encode']);
      edits.push([open.end, open.end, `${id}, canonical, ${semanticKey ? '(typeof kind === "string" ? kind : null)' : 'null'}, `]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return { text, sites };
}

/** Fixed site counters, sampled allocation deltas and at most three encoded
 * strings in the current synchronous addFact operation. No payload objects or
 * cross-operation encoding cache. Equality compares actual returned strings.
 */
export function encodingAudit(sites) {
  const kinds = new Set(['provenance', 'logical', 'fact', 'claim', 'support']);
  const rows = new Map(), comparisons = {}, samplesEvery = 512;
  let active, operations = 0, operationFailures = 0;
  const row = (id, kind) => {
    const key = `${id}:${kinds.has(kind) ? kind : 'other'}`;
    let value = rows.get(key);
    if (!value) { value = { site: id, kind: kinds.has(kind) ? kind : undefined, calls: 0, failures: 0, bytes: 0, utf16Units: 0, wallMs: 0, allocationSamples: 0, sampledAllocationBytes: 0 }; rows.set(key, value); }
    return value;
  };
  const compare = (name, previous, text, bytes) => {
    if (previous === undefined) return;
    const value = comparisons[name] ??= { comparisons: 0, equal: 0, different: 0, equalBytes: 0 };
    value.comparisons++; if (previous === text) { value.equal++; value.equalBytes += bytes; } else value.different++;
  };
  return {
    encode(id, original, kind, value) {
      const stats = row(id, kind), sample = stats.calls++ % samplesEvery === 0;
      const allocation = sample ? getHeapStatistics().total_allocated_bytes : 0;
      const start = performance.now(); let text;
      try { text = original(value); }
      catch (error) { stats.failures++; throw error; }
      finally { stats.wallMs += performance.now() - start; }
      if (sample) { stats.sampledAllocationBytes += getHeapStatistics().total_allocated_bytes - allocation; stats.allocationSamples++; }
      const bytes = Buffer.byteLength(text); stats.bytes += bytes; stats.utf16Units += text.length;
      if (active) {
        switch (sites[id].category) {
          case 'validate-provenance': active.validatedProvenance = text; break;
          case 'validate-value': active.validatedValue = text; break;
          case 'persist-value': compare('value-validation-persistence', active.validatedValue, text, bytes); break;
          case 'persist-provenance': compare('provenance-validation-persistence', active.validatedProvenance, text, bytes); active.persistedProvenance = text; break;
          case 'semantic-key': if (kind === 'provenance') compare('provenance-persistence-key', active.persistedProvenance, text, bytes); break;
        }
      }
      return text;
    },
    operation(original, target, args) {
      const previous = active; active = {}; operations++;
      try { return original.apply(target, args); }
      catch (error) { operationFailures++; throw error; }
      finally { active = previous; }
    },
    result() { return { sites, rows: [...rows.values()], comparisons, operations, operationFailures, allocationSampling: { every: samplesEvery, exact: false, includesObserverAndBackgroundAllocation: true },
      limits: 'Direct consumer calls, not recursive canonical visits. wallMs is synchronous elapsed time including GC/native work, not exact CPU. Module initialization included. Allocation samples include getHeapStatistics overhead and background work; do not equate canonical bytes with heap allocation or retained memory. Diagnostics retain at most three encoded strings per active addFact until return; instrumented production metrics include that overhead.' }; },
  };
}

async function prepare(runtime, destination) {
  runtime = path.resolve(runtime); destination = path.resolve(destination);
  if (destination === runtime || destination.startsWith(runtime + path.sep)) throw Error('Use an external fresh build copy');
  try { await access(destination); throw Error('Destination exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(destination, { recursive: true });
  await cp(path.join(runtime, 'dist'), path.join(destination, 'dist'), { recursive: true });
  await cp(path.join(runtime, 'package.json'), path.join(destination, 'package.json'));
  await mkdir(path.join(destination, 'scripts'));
  await cp(path.join(runtime, 'scripts/semantic-profile.mjs'), path.join(destination, 'scripts/semantic-profile.mjs'));
  await symlink(path.join(runtime, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
  const sites = [], files = {};
  const visit = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const file = path.relative(destination, full), text = await readFile(full, 'utf8');
        let map; try { map = new SourceMap(JSON.parse(await readFile(full + '.map', 'utf8'))); } catch { /* source map optional */ }
        const result = await instrumentCanonicalModule(text, file, map, sites.length);
        if (result.sites.length) { sites.push(...result.sites); files[file] = { originalSha256: hash(text), instrumentedSha256: hash(result.text) }; await writeFile(full, result.text); }
      }
    }
  };
  await visit(path.join(destination, 'dist'));
  await writeFile(path.join(destination, 'encoding-sites.json'), JSON.stringify({ runtime, sites, files }, null, 2) + '\n');
  console.log(JSON.stringify({ destination, sites: sites.length, files: Object.keys(files).length }));
}

async function run(runtime, source, output, report) {
  const { sites } = JSON.parse(await readFile(path.join(runtime, 'encoding-sites.json'), 'utf8'));
  if (globalThis[AUDIT_KEY]) throw Error('Encoding audit already active');
  const audit = encodingAudit(sites); globalThis[AUDIT_KEY] = audit;
  const { SemanticStore } = await import(pathToFileURL(path.join(runtime, 'dist/core/semantic/store.js')).href);
  const original = SemanticStore.prototype.addFact;
  SemanticStore.prototype.addFact = function (...args) { return audit.operation(original, this, args); };
  const argv = process.argv;
  try {
    process.argv = [process.execPath, path.join(runtime, 'scripts/semantic-profile.mjs'), 'phases', source, output, report];
    await import(pathToFileURL(path.join(runtime, 'scripts/semantic-profile.mjs')).href);
    await writeFile(report + '.encoding.json', JSON.stringify(audit.result(), null, 2) + '\n');
  } finally { process.argv = argv; SemanticStore.prototype.addFact = original; delete globalThis[AUDIT_KEY]; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare' && args.length === 2) await prepare(...args);
  else if (mode === 'run' && args.length === 4) await run(...args);
  else throw Error('prepare RUNTIME AUDITED_COPY | run AUDITED_COPY SOURCE INDEX PHASE_REPORT');
}
