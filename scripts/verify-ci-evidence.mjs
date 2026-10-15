// A green job must contain executed producer tests, complete build and recovery evidence.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const tests = JSON.parse(await readFile(process.argv[2] ?? 'semantic-test-results.json', 'utf8'));
assert.equal(tests.success, true);
assert.ok(tests.numTotalTests > 0);
assert.equal(tests.numPassedTests, tests.numTotalTests);
assert.equal(tests.numPendingTests, 0);
const rust = tests.testResults.find(file => /[/\\]semantic-rust\.test\.ts$/.test(file.name));
assert.ok(rust && rust.assertionResults.length >= 9, 'Actual Rust qualification suite must execute');
assert.ok(rust.assertionResults.every(test => test.status === 'passed'));
const managed = tests.testResults.find(file => /[/\\]semantic-managed\.test\.ts$/.test(file.name));
for (const language of ['python', 'go', 'java', 'csharp']) assert.ok(managed?.assertionResults.some(test => test.title.startsWith(`real ${language} producer`) && test.status === 'passed'), `Actual ${language} qualification must execute`);
const recovery = JSON.parse(await readFile(process.argv[3] ?? 'semantic-recovery-results.json', 'utf8'));
assert.deepEqual(recovery.probes.map(probe => probe.point).sort(), ['after-publish', 'before-publish', 'before-seal', 'during-publish']);
assert.ok(recovery.probes.every(probe => probe.integrity === 'ok' && probe.baselineRetained));
assert.deepEqual(recovery.corruption, { refused: true, unchanged: true });
await Promise.all(['dist/cli/index.js', 'dist/core/query/query-worker.js', 'dist/ui/index.html'].map(file => access(file)));
console.log(`Verified ${tests.numPassedTests} passed tests, actual Rust/Python/Go/Java/C# qualification, complete build, four recovery probes and corruption refusal`);
