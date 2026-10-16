import { afterEach, expect, test } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runProviderProcess } from "../src/core/semantic/process.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { IndexLease } from "../src/core/semantic/maintenance-lock.js";
import { digest } from "../src/core/semantic/model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "prograph-guard-")); roots.push(root); return root; }
const processModule = pathToFileURL(path.resolve("dist/core/semantic/process.js")).href;
const storeModule = pathToFileURL(path.resolve("dist/core/semantic/store.js")).href;
async function waitFor(file: string) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) { try { await stat(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  throw Error(`Worker did not reach probe: ${file}`);
}

test("native guardian preserves complete multibyte output and logical nonzero exit", async () => {
  const root = await temporary(), expected = "🚀".repeat(262144);
  const result = await runProviderProcess(process.execPath, ["-e", "process.stdout.write('🚀'.repeat(262144))"], root, process.env, { timeoutMs: 5000, maxOutputBytes: 2 * 1024 ** 2 });
  expect(Buffer.byteLength(result.stdout)).toBe(1048576); expect(digest(result.stdout)).toBe(digest(expected));
  await expect(runProviderProcess(process.execPath, ["-e", "process.stderr.write('qualified-error');process.exitCode=7"], root, process.env, { timeoutMs: 5000, maxOutputBytes: 4096 })).rejects.toThrow("exit 7: qualified-error");
});

test.skipIf(process.platform === "win32")("hard death of the SDK owner also terminates detached native work and its descendants", async () => {
  const root = await temporary(), ready = path.join(root, "ready"), marker = path.join(root, "orphan");
  const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),800)`;
  const sdk = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({sdk:process.pid,descendant:c.pid}));setInterval(()=>{},1000)`;
  const worker = path.join(root, "worker.mjs");
  await writeFile(worker, `import{runProviderProcess}from ${JSON.stringify(processModule)};await runProviderProcess(process.execPath,['-e',${JSON.stringify(sdk)}],${JSON.stringify(root)},process.env,{timeoutMs:10000,maxOutputBytes:4096});`);
  const owner = spawn(process.execPath, [worker], { stdio: "ignore" });
  try {
    await waitFor(ready); const ids = JSON.parse(await readFile(ready, "utf8")) as { sdk: number; descendant: number };
    const closed = new Promise(resolve => owner.once("close", resolve)); owner.kill("SIGKILL"); await closed;
    await new Promise(resolve => setTimeout(resolve, 1100)); await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const states = await promisify(execFile)("/bin/ps", ["-o", "stat=", "-p", `${ids.sdk},${ids.descendant}`]).then(result => result.stdout.trim().split(/\s+/).filter(Boolean), error => { if (error.code === 1 && !error.stdout) return []; throw error; });
    expect(states.every(state => state.startsWith("Z"))).toBe(true);
  } finally { owner.kill("SIGKILL"); }
}, 20000);

test.skipIf(process.platform === "win32")("killed indexing owners release SDK staging leases and preserve atomic WAL publication at all four recovery points", async () => {
  for (const point of ["before-seal", "before-publish", "during-publish", "after-publish"]) {
    const root = await temporary(), filename = path.join(root, "semantic.sqlite"), ready = path.join(root, "ready");
    const store = new SemanticStore(filename); const baselineRun = store.begin("base", "ctx", "base");
    store.addEntity("base", "artifact", { kind: "probe" });
    store.batch(baselineRun, () => store.addFact(baselineRun, { predicate: "context.Project", context: "ctx", subject: "base", value: { probe: "baseline" }, confidence: "exact", provenance: { provider: "recovery-probe", version: "1", basis: "syntax", method: "test-context", context: "ctx", inputFingerprint: "base" } }));
    store.seal(baselineRun, {}); const baseline = store.publish([baselineRun]); store.close();
    const sdk = path.join(root, "sdk.mjs"), worker = path.join(root, "owner.mjs");
    await writeFile(sdk, `import{SemanticStore}from ${JSON.stringify(storeModule)};import{writeFileSync}from'node:fs';
      const s=new SemanticStore(${JSON.stringify(filename)},{fault(point){if(point===${JSON.stringify(point)}){writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}});
      const r=s.begin('replacement','ctx','changed');s.addEntity('changed','artifact',{kind:'probe'});s.batch(r,()=>s.addFact(r,{predicate:'context.Project',context:'ctx',subject:'changed',value:{probe:'changed'},confidence:'exact',provenance:{provider:'recovery-probe',version:'1',basis:'syntax',method:'test-context',context:'ctx',inputFingerprint:'changed'}}));s.seal(r,{});s.publish([r]);`);
    await writeFile(worker, `import{runProviderProcess}from ${JSON.stringify(processModule)};await runProviderProcess(process.execPath,[${JSON.stringify(sdk)}],${JSON.stringify(root)},process.env,{timeoutMs:10000,maxOutputBytes:4096});`);
    const owner = spawn(process.execPath, [worker], { stdio: "ignore" });
    try {
      await waitFor(ready); const closed = new Promise(resolve => owner.once("close", resolve)); owner.kill("SIGKILL"); await closed;
      // The guardian is outside the killed owner's process tree/group.
      // Its IPC EOF handler must release the SDK lease without PID lock stealing.
      let lease: IndexLease | undefined; const until = performance.now() + 5000;
      while (!lease && performance.now() < until) { try { lease = new IndexLease(root, "maintenance"); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
      expect(lease).toBeDefined(); lease!.close();
      const recovered = new SemanticStore(filename);
      try {
        expect(recovered.activeSnapshot()).toBe(point === "after-publish" ? baseline + 1 : baseline);
        expect(recovered.sql("SELECT COUNT(*) AS n FROM sc_active WHERE snapshot=?").get(baseline)).toEqual({ n: 1 });
        expect(recovered.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(recovered.db.pragma("foreign_key_check")).toEqual([]);
      } finally { recovered.close(); }
    } finally { owner.kill("SIGKILL"); }
  }
}, 60000);
