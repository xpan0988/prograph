// A green job must contain executed producer tests, complete build and recovery evidence.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const tests = JSON.parse(await readFile(process.argv[2] ?? 'semantic-test-results.json', 'utf8'));
assert.equal(tests.success, true);
assert.ok(tests.numTotalTests > 0);
assert.equal(tests.numPassedTests, tests.numTotalTests);
assert.equal(tests.numPendingTests, 0);
for (const [pattern, count] of [[/[/\\]canonical-hash\.test\.ts$/, 8], [/[/\\]fingerprint-runtime\.test\.ts$/, 1], [/[/\\]encoding-audit\.test\.ts$/, 3], [/[/\\]encoding-reuse\.test\.ts$/, 5], [/[/\\]encoding-reuse-runtime\.test\.ts$/, 2]]) {
  const file = tests.testResults.find(file => pattern.test(file.name));
  assert.ok(file && file.assertionResults.length === count && file.assertionResults.every(test => test.status === 'passed'), 'Canonical byte/hash and accepted-runtime fingerprint oracles must execute');
}
const ownedResidency = tests.testResults.find(file => /[/\\]owned-residency\.test\.ts$/.test(file.name));
assert.ok(ownedResidency && ownedResidency.assertionResults.length === 3 && ownedResidency.assertionResults.every(test => test.status === 'passed'), 'Accepted-runtime owned output, history, failure and cancellation oracles must execute');
const rust = tests.testResults.find(file => /[/\\]semantic-rust\.test\.ts$/.test(file.name));
assert.ok(rust && rust.assertionResults.length >= 9, 'Actual Rust qualification suite must execute');
assert.ok(rust.assertionResults.every(test => test.status === 'passed'));
const managed = tests.testResults.find(file => /[/\\]semantic-managed\.test\.ts$/.test(file.name));
for (const language of ['python', 'go', 'java', 'csharp']) assert.ok(managed?.assertionResults.some(test => test.title.startsWith(`real ${language} producer`) && test.status === 'passed'), `Actual ${language} qualification must execute`);
const replay = tests.testResults.find(file => /[/\\]semantic-replay\.test\.ts$/.test(file.name));
assert.ok(replay && replay.assertionResults.length >= 8 && replay.assertionResults.every(test => test.status === 'passed'), 'Authenticated preparation/replay tests must all execute');
for (const language of ['Clang', 'Rust', 'python', 'go', 'java', 'csharp']) assert.ok(replay.assertionResults.some(test => test.title.startsWith(`registered ${language}`) && test.status === 'passed'), `Actual registered ${language} replay must execute`);
const maintenance = tests.testResults.find(file => /[/\\]semantic-artifacts\.test\.ts$/.test(file.name));
assert.ok(maintenance && maintenance.assertionResults.length >= 13 && maintenance.assertionResults.every(test => test.status === 'passed'), 'Artifact retention and cross-process maintenance recovery must execute');
const clangInputs = tests.testResults.find(file => /[/\\]semantic-clang-inputs\.test\.ts$/.test(file.name));
assert.ok(clangInputs && clangInputs.assertionResults.length >= 8 && clangInputs.assertionResults.every(test => test.status === 'passed'), 'Actual Clang negative-search, macro-anchor, host context and extraction input barriers must execute');
const inputWitnesses = tests.testResults.find(file => /[/\\]semantic-inputs\.test\.ts$/.test(file.name));
assert.ok(inputWitnesses && inputWitnesses.assertionResults.length >= 7 && inputWitnesses.assertionResults.every(test => test.status === 'passed'), 'Compiler inputs and source-root binding qualification must execute');
const oracle = tests.testResults.find(file => /[/\\]semantic-multiprovider\.test\.ts$/.test(file.name));
assert.ok(oracle && oracle.assertionResults.length >= 2 && oracle.assertionResults.every(test => test.status === 'passed'), 'Actual multi-provider and accepted-writer upgrade oracles must execute');
for (const [suite, count] of [['provider-guard', 3], ['index-execution', 5], ['watch-isolation', 2], ['index-provider-cli', 6], ['semantic-diagnostics', 3], ['snapshot-report', 5], ['semantic-retention', 14], ['source-reuse', 6], ['semantic-authority', 5], ['authority-support', 1], ['authority-migration', 7], ['compatibility-cache', 2], ['compatibility-global', 1], ['compatibility-query-oracle', 4], ['compatibility-support', 1], ['compatibility-snapshot', 3], ['compatibility-export', 4]]) {
  const file = tests.testResults.find(file => file.name.replaceAll('\\', '/').endsWith(`/${suite}.test.ts`));
  assert.ok(file && file.assertionResults.length >= count && file.assertionResults.every(test => test.status === 'passed'), `Actual ${suite} qualification must execute`);
}
const oracleEvidence = JSON.parse(await readFile(process.argv[4] ?? 'semantic-oracle-results.json', 'utf8'));
assert.equal(oracleEvidence.complete, true); assert.equal(oracleEvidence.expectedChecks, 18); assert.equal(oracleEvidence.evidence.length, 18);
for (const edit of ['add Python module without editing importer', 'modify exported TS overload', 'rename Java source', 'delete shadow Python module', 'C header dependency', 'project compiler configuration', 'Rust feature variant', 'Go target tags', 'Java language level', 'Csharp variant defines', 'schema contract replacement', 'documentation only', 'producer receipt mismatch', 'restore qualified producer']) assert.ok(oracleEvidence.evidence.some(row => row.edit === edit), `Missing oracle edit ${edit}`);
const upgrade = JSON.parse(await readFile(process.argv[5] ?? 'semantic-upgrade-results.json', 'utf8'));
assert.equal(upgrade.baseline.commit, '6eefca04b5032f3416fcc95bda23dec4bb8f65db'); assert.equal(upgrade.freshness, 'fresh'); assert.equal(upgrade.unpinnedGc, 'complete');
const retentionUpgrade = JSON.parse(await readFile(process.argv[6] ?? 'semantic-retention-upgrade-results.json', 'utf8'));
assert.equal(retentionUpgrade.baseline.commit, '892d91833cfd22639da3f34948969a24a1ea96bb'); assert.equal(retentionUpgrade.freshness, 'fresh');
assert.match(retentionUpgrade.historicalReportHash, /^[a-f0-9]{64}$/); assert.ok(retentionUpgrade.unpinnedGc.snapshot_reports >= 1);
const authorityUpgrade=JSON.parse(await readFile(process.argv[7] ?? 'semantic-authority-upgrade-results.json','utf8'));
assert.equal(authorityUpgrade.baseline.commit,'b96118fc7513191b33af5d82caef387ad2c8e01e');assert.equal(authorityUpgrade.authority,'semantic');assert.equal(authorityUpgrade.freshness,'fresh');assert.equal(authorityUpgrade.rollbackOldReader,'passed');assert.ok(authorityUpgrade.unpinnedGc.snapshot_reports>=1);
const recovery = JSON.parse(await readFile(process.argv[3] ?? 'semantic-recovery-results.json', 'utf8'));
assert.deepEqual(recovery.probes.map(probe => probe.point).sort(), ['after-publish', 'before-publish', 'before-seal', 'during-publish']);
assert.ok(recovery.probes.every(probe => probe.integrity === 'ok' && probe.baselineRetained));
assert.deepEqual(recovery.corruption, { refused: true, unchanged: true });
await Promise.all(['dist/cli/index.js', 'dist/core/query/query-worker.js', 'dist/core/analysis/index-worker.js', 'dist/core/semantic/provider-guard.js', 'dist/ui/index.html'].map(file => access(file)));
console.log(`Verified ${tests.numPassedTests} passed tests, actual Rust/Python/Go/Java/C# qualification and Clang/Rust/Python/Go/Java/C# registered replay, owned artifact/maintenance recovery, qualified Clang input tracking, 18 multi-provider clean rebuild checks, actual prior-writer and report-writer upgrades, qualified native-only retention, guarded indexing cancellation/admission and actual provider CLI transport, atomic default authority, verified migration rollback/pins and old-reader export, complete build, four recovery probes and corruption refusal`);
