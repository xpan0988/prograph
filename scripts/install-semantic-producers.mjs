// Explicit CI/qualification bootstrap, never called by repository discovery or indexing.
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { toolReceipt } from '../dist/core/semantic/managed-scip.js';
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Bootstrap qualified for Linux x64; other hosts supply explicit receipts');
const root = path.resolve(process.argv[2]); await mkdir(root, { recursive: true });
async function download(name, url, sha256) {
  const response = await fetch(url); if (!response.ok) throw Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error(`Artifact digest mismatch: ${name}`);
  const file = path.join(root, name); await writeFile(file, bytes); return file;
}
async function receipt(file, entry) { const value = await toolReceipt(file); return { path: file, sha256: value.sha256, ...(entry ? { entry } : {}) }; }
const pythonTar = await download('scip-python.tgz', 'https://registry.npmjs.org/@sourcegraph/scip-python/-/scip-python-0.6.6.tgz', 'be8e0a1ec180423c60e9f2c2672c208f49a35ab690ac0f8f1259e4223dbd6e42');
const pythonRoot = path.join(root, 'python'); await mkdir(pythonRoot); execFileSync('tar', ['-xzf', pythonTar, '-C', pythonRoot]);
const goTar = await download('scip-go.tgz', 'https://github.com/scip-code/scip-go/releases/download/v0.2.7/scip-go-linux-amd64.tar.gz', '5bfe39016ca04f5b3b1cce41d1b63ea120a7d7e93b55407bfb17a6b02d18135a');
const goRoot = path.join(root, 'go'); await mkdir(goRoot); execFileSync('tar', ['-xzf', goTar, '-C', goRoot]);
const java = await download('scip-java', 'https://github.com/scip-code/scip-java/releases/download/v0.13.1/scip-java-v0.13.1', 'a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe');
const plugins = [];
for (const [name, url, hash] of [
  ['javac.jar', 'org/scip-code/scip-javac/0.13.1/scip-javac-0.13.1.jar', '1c7ad1c8361f6ea9f9758e4b55decd4869b0ac7bb8610127aca045173ff590ef'],
  ['shared.jar', 'org/scip-code/scip-shared/0.13.1/scip-shared-0.13.1.jar', '8c58e069af784b178347849f9b0e127781d9070210201ac6617947ace4f895be'],
  ['bindings.jar', 'org/scip-code/scip-java-bindings/0.9.0/scip-java-bindings-0.9.0.jar', 'ab1c627cb9ff6a8b0f05d91ee329c0ef281819ed011a2b2806fa7ea5f16c1006'],
  ['protobuf.jar', 'com/google/protobuf/protobuf-java/4.34.2/protobuf-java-4.34.2.jar', '780e269712d59ae34b87b702ce26aede7982804299dd56a65aa84bda6c145268'],
]) plugins.push(await receipt(await download(name, `https://repo.maven.apache.org/maven2/${url}`, hash)));
const nuget = await download('scip-dotnet.nupkg', 'https://api.nuget.org/v3-flatcontainer/scip-dotnet/0.2.14/scip-dotnet.0.2.14.nupkg', 'e2d183fe39b9a56cb8bb2ed2d8b96828fb5434c6db084002bf8a5c6009391b52');
const dotnetRoot = path.join(root, 'scip-dotnet'); await mkdir(dotnetRoot); execFileSync('unzip', ['-q', nuget, '-d', dotnetRoot]);
const base = { format: 1, root: '.', package: { name: 'prograph-probe', version: '0.1.0' } };
const goSdk = execFileSync('go', ['env', 'GOROOT'], { env: { ...process.env, GOROOT: '' }, encoding: 'utf8' }).trim();
const profiles = {
  python: { ...base, id: 'python', language: 'python', runtime: await receipt(path.dirname(path.dirname(process.execPath)), 'bin/node'), producer: await receipt(path.join(pythonRoot, 'package'), 'index.js'), python: { interpreter: await receipt(process.env.pythonLocation, 'bin/python3'), version: '3.11' } },
  go: { ...base, id: 'go', language: 'go', package: { name: 'example.org/prographprobe', version: '0.1.0' }, runtime: await receipt(goSdk, 'bin/go'), producer: await receipt(path.join(goRoot, 'scip-go')), go: { os: 'linux', arch: 'amd64' } },
  java: { ...base, id: 'java', language: 'java', runtime: await receipt(process.env.JAVA_HOME, 'bin/java'), producer: await receipt(java), java: { release: 17, plugins } },
  csharp: { ...base, id: 'csharp', language: 'csharp', runtime: await receipt(process.env.DOTNET_INSTALL_DIR, 'dotnet'), producer: await receipt(path.join(dotnetRoot, 'tools/net10.0/any'), 'scip-dotnet.dll'), csharp: { projects: [{ file: 'Probe.csproj', targetFramework: 'net10.0', assembly: 'Probe', sources: ['Foo.cs'] }] } },
};
const output = path.join(root, 'profiles.json'); await writeFile(output, JSON.stringify(profiles, null, 2));
await writeFile(path.join(root, 'receipt.json'), JSON.stringify({ format: 1, profiles, timestamp: new Date().toISOString() }, null, 2));
if (process.env.GITHUB_ENV) await writeFile(process.env.GITHUB_ENV, `${await readFile(process.env.GITHUB_ENV, 'utf8')}PROGRAPH_TEST_MANAGED_PROFILES=${output}\n`);
console.log(`Pinned Python/Go/Java/C# producers and full SDK receipts written to ${output}`);
