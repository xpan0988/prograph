import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { executeIndex, type IndexRequest } from "../src/core/analysis/index-execution.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { executeRead } from "../src/core/query/isolation.js";
import { startServer } from "../src/server/index.js";
import { createProGraphMcpServer } from "../src/mcp/index.js";
import { formatQueryOutput } from "../src/core/query/output-mode.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(indexed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-index-worker-")); roots.push(root);
  const repository = path.join(root, "source"), index = path.join(root, "custom-index");
  await mkdir(repository); await writeFile(path.join(repository, "a.ts"), "export function target(){return 1} export function run(){return target()}\n");
  await writeFile(path.join(repository, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  const analyzed = indexed ? await executeIndex({ operation: "analyze", repository, index }) : undefined;
  return { repository, index, analyzed };
}

test("index workers preserve custom-root summaries and CLI, HTTP and MCP status/sync contracts", async () => {
  const { repository, index, analyzed } = await fixture();
  expect(Object.keys(analyzed!).sort()).toEqual(["adapterRuns", "manifest", "outputDirectory"]);
  expect(analyzed!.manifest.schemaVersion).toBe("1.2.0"); expect(analyzed!.manifest.semanticCore?.status).toBe("partial");
  const expected = await repositoryStatus(repository, index);
  expect(await executeIndex({ operation: "status", repository, index })).toEqual(expected);
  const cli = await promisify(execFile)(process.execPath, ["dist/cli/index.js", "status", repository, "--index", index, "--format", "json"]);
  expect(JSON.parse(cli.stdout)).toEqual(expected);
  const { server } = await startServer(repository, { index, port: 0 });
  const mcp = createProGraphMcpServer(repository, index), client = new Client({ name: "index-worker-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(b); await client.connect(a);
    const response = await client.callTool({ name: "get_status", arguments: {} });
    const content = response.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(formatQueryOutput(expected, { mode: "compact", maxEvidence: 1 }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual(expected);
    const synced = await fetch(`${base}/api/sync`, { method: "POST" }); expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ statusBefore: expected, statusAfter: expected, incremental: true, filesReanalyzed: 0 });
    await writeFile(path.join(repository, "a.ts"), "export function target(){return 2} export function run(){return target()}\n");
    const changed = await executeIndex({ operation: "sync", repository, index });
    expect(changed.statusAfter.state).toBe("fresh"); expect(changed.filesModified).toBe(1); expect(changed).not.toHaveProperty("graph");
    await expect(access(path.join(repository, ".prograph"))).rejects.toMatchObject({ code: "ENOENT" });
    const store = new SemanticStore(path.join(index, "semantic.sqlite"));
    try { expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(store.db.pragma("foreign_key_check")).toEqual([]); } finally { store.close(); }
  } finally { await client.close(); await mcp.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 60000);

test("fixed index RPC rejects malformed and oversized control before indexing and recovers", async () => {
  const { repository, index } = await fixture(false);
  for (const invalid of [
    { operation: "eval", repository, index },
    { operation: "analyze", repository, index, providerOptions: [] },
    { operation: "analyze", repository, index, providerOptions: { features: [false] } },
    { operation: "analyze", repository, index, providerOptions: { timeoutMs: "1" } },
    { operation: "analyze", repository, index, providerOptions: { authorization: "forged" } },
  ]) await expect(executeIndex(invalid as IndexRequest & { operation: "analyze" })).rejects.toMatchObject({ code: "INDEX_FAILED" });
  await expect(access(index)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(executeIndex({ operation: "analyze", repository: "x".repeat(32769), index })).rejects.toMatchObject({ code: "INDEX_INPUT_LIMIT" });
  expect((await executeIndex({ operation: "status", repository, index })).state).toBe("missing");
}, 30000);

test("index admission bounds both queues, cancellation drains them and status has its own slot", async () => {
  const { repository, index } = await fixture(false), controller = new AbortController();
  const all = Promise.allSettled(Array.from({ length: 6 }, () => executeIndex({ operation: "analyze", repository, index }, { signal: controller.signal })));
  controller.abort(); const result = await all;
  expect(result.filter(row => row.status === "rejected" && row.reason.code === "INDEX_BUSY")).toHaveLength(1);
  expect(result.every(row => row.status === "rejected" && ["INDEX_CANCELLED", "INDEX_BUSY"].includes(row.reason.code))).toBe(true);
  const statusController = new AbortController();
  const statuses = Promise.allSettled(Array.from({ length: 6 }, () => executeIndex({ operation: "status", repository, index }, { signal: statusController.signal })));
  statusController.abort();
  expect((await statuses).filter(row => row.status === "rejected" && row.reason.code === "INDEX_BUSY")).toHaveLength(1);
  await expect(executeIndex({ operation: "status", repository, index }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "INDEX_CANCELLED" });
  expect((await executeIndex({ operation: "status", repository, index })).state).toBe("missing");
});

test("native SQLite work is cancellable and cannot block host heartbeats or subsequent requests", async () => {
  const { repository, index } = await fixture();
  const db = new Database(path.join(index, "semantic.sqlite"));
  const run = (db.prepare("SELECT run FROM sc_partitions WHERE snapshot=(SELECT value FROM sc_meta WHERE key='active') LIMIT 1").get() as { run: number }).run;
  // A malformed expensive input exercises cancellation inside native synchronous SQL.
  // The DISTINCT constant cannot reach LIMIT until the billion-row CTE finishes.
  db.pragma("foreign_keys=OFF"); db.exec(`DROP TABLE sc_inputs; CREATE VIEW sc_inputs AS WITH RECURSIVE spin(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM spin WHERE n<1000000000) SELECT ${run} AS run,'env:PROGRAPH_FAULT_PROBE' AS resource,'x' AS digest FROM spin`); db.close();
  let heartbeats = 0; const interval = setInterval(() => heartbeats++, 20);
  try {
    await expect(executeIndex({ operation: "status", repository, index }, { timeoutMs: 2000 })).rejects.toMatchObject({ code: "INDEX_DEADLINE" });
    expect(heartbeats).toBeGreaterThan(2);
    const controller = new AbortController(), running = executeIndex({ operation: "status", repository, index }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1000); await expect(running).rejects.toMatchObject({ code: "INDEX_CANCELLED" });
  } finally { clearInterval(interval); }
  const good = await fixture(false); expect((await executeIndex({ operation: "status", repository: good.repository, index: good.index })).state).toBe("missing");
}, 30000);

test("a blocked legacy writer leaves status/navigation admitted and cancelled work retains semantic history without promising rollback", async () => {
  const { repository, index } = await fixture();
  const db = new Database(path.join(index, "graph.sqlite"));
  const semantic = new Database(path.join(index, "semantic.sqlite"), { readonly: true });
  const snapshot = Number((semantic.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string }).value);
  const historical = semantic.prepare("SELECT claim FROM sc_active WHERE snapshot=? ORDER BY claim").all(snapshot);
  const manifest = await readFile(path.join(index, "manifest.json"));
  db.exec("BEGIN IMMEDIATE"); const controller = new AbortController();
  const running = executeIndex({ operation: "analyze", repository, index }, { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  try {
    // Read-only progress cannot steal the worker's SHARED lease. Repeated
    // EXCLUSIVE probes can themselves make its timeout-zero acquisition fail.
    let finished: Awaited<typeof running> | undefined;
    void running.then(outcome => { finished = outcome; });
    const until = performance.now() + 10000;
    while (Number((semantic.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string }).value) === snapshot && performance.now() < until) {
      if (finished) throw Error(`Index worker finished before semantic publication: ${"error" in finished ? String(finished.error) : "unexpected completion"}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(Number((semantic.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string }).value)).toBeGreaterThan(snapshot);
    expect(finished, "Writer must remain blocked after semantic publication").toBeUndefined();
    const [queued, status, navigation] = await Promise.all([
      executeIndex({ operation: "sync", repository, index }, { timeoutMs: 30 }).then(value => ({ value }), error => ({ error })),
      executeIndex({ operation: "status", repository, index }),
      executeRead(path.join(index, "graph.sqlite"), "legacy", "symbol", ["__missing__"]),
    ]);
    expect(queued).toHaveProperty("error.code", "INDEX_DEADLINE");
    expect(status).toMatchObject({ state: "stale", semanticPublication: { state: "out-of-sync" } });
    expect(navigation).toBeUndefined();
    controller.abort(); const outcome = await running; expect(outcome, "error" in outcome ? String(outcome.error) : "unexpected completion").toHaveProperty("error.code", "INDEX_CANCELLED");
    expect(outcome).toHaveProperty("error.message", expect.stringContaining("may already have committed"));
    expect(Number((semantic.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string }).value)).toBeGreaterThanOrEqual(snapshot);
    expect(semantic.prepare("SELECT claim FROM sc_active WHERE snapshot=? ORDER BY claim").all(snapshot)).toEqual(historical);
    expect(semantic.pragma("integrity_check", { simple: true })).toBe("ok"); expect(semantic.pragma("foreign_key_check")).toEqual([]);
    expect(await readFile(path.join(index, "manifest.json"))).toEqual(manifest);
  } finally { controller.abort(); await running; db.exec("ROLLBACK"); db.close(); semantic.close(); }
  expect((await executeIndex({ operation: "sync", repository, index })).statusAfter.state).toBe("fresh");
}, 30000);
