// Compile pinned, already accepted ProGraph source. Never runs its package scripts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const baselines = { previous: '6eefca04b5032f3416fcc95bda23dec4bb8f65db', report: '892d91833cfd22639da3f34948969a24a1ea96bb', retention: 'd38b47b1f3fc0f917f9c1052c868fe29b92b173b' };
const selector = process.argv[3] ?? 'previous';
if (!Object.hasOwn(baselines, selector)) throw Error('Unsupported baseline selector');
const commit = baselines[selector];
if (!commit) throw Error('Unsupported baseline selector');
const repository = fileURLToPath(new URL('../', import.meta.url));
const destination = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: node scripts/prepare-semantic-baseline.mjs <parent-directory> [previous|report|retention]');
await mkdir(destination, { recursive: true });
try { await exec('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repository }); }
catch { await exec('git', ['fetch', '--no-tags', '--depth=1', 'origin', commit], { cwd: repository, timeout: 120000, maxBuffer: 1024 ** 2 }); }
const root = await mkdtemp(path.join(destination, 'accepted-'));
const archive = path.join(root, 'source.tar');
await exec('git', ['archive', '--format=tar', `--output=${archive}`, commit, 'src', 'package.json', 'tsconfig.json', 'tsconfig.node.json'], { cwd: repository, timeout: 30000 });
await exec('tar', ['xf', archive, '-C', root], { timeout: 30000 }); await rm(archive);
await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'dir');
await exec(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.node.json')], { cwd: repository, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
const files = ['core/semantic/model.js', 'core/semantic/managed-scip.js', 'core/semantic/provider-replay.js'];
const digests = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, 'dist', file))).digest('hex')])));
const receipt = { commit, runtime: root, node: process.version, compiler: JSON.parse(await readFile(path.join(repository, 'node_modules/typescript/package.json'), 'utf8')).version, scope: 'Accepted source compiled using current locked dependencies; not historical binary performance evidence', digests };
await writeFile(path.join(root, 'baseline-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(root);
