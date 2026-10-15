import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { QueryService } from "../src/core/query/query-service.js";
import { QueryService as Legacy } from "./oracles/legacy-global.js";
import { prepareQueryIndex } from "../src/core/analysis/prepare-queries.js";
import { QUERY_SCOPES, offlineCycles } from "../src/core/query/global-projections.js";
import type { GraphEdge } from "../src/core/graph/schema.js";
import { startServer } from "../src/server/index.js";
import { createProGraphMcpServer } from "../src/mcp/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let directory: string; let filename: string;
beforeAll(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "prograph-global-")); filename = path.join(directory, "graph.sqlite"); await analyzeRepository(path.resolve("tests/fixtures/mixed"), { output: directory }); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const transport = (value: unknown) => JSON.parse(JSON.stringify(value));

test("durable global results agree with the frozen scan oracle across scopes and confidence", () => {
  const current = new QueryService(filename); const old = new Legacy(filename);
  try {
    for (const scope of QUERY_SCOPES) {
      expect(transport(current.overview({ scope }))).toEqual(transport(old.overview({ scope })));
      expect(transport(current.files({ scope }))).toEqual(transport(old.files({ scope })));
      expect(transport(current.diagnostics())).toEqual(transport(old.diagnostics()));
      for (const term of ["greet", "command", "App", "invoke", ""]) expect(transport(current.searchSymbols(term, 20, { scope }))).toEqual(transport(old.searchSymbols(term, 20, { scope })));
      for (const confidence of [{}, { includeProbable: true }, { includeUnresolved: true }]) {
        const options = { scope, ...confidence };
        for (const max of [1, 5, 100]) expect(transport(current.architecture(max, options))).toEqual(transport(old.architecture(max, options)));
        expect(transport(current.cycles(options))).toEqual(transport(old.cycles(options)));
        expect(transport(current.context("greeting command security tests", options))).toEqual(transport(old.context("greeting command security tests", options)));
        for (const framework of [undefined, "tauri", "http"]) expect(transport(current.frameworkBindings(framework, options))).toEqual(transport(old.frameworkBindings(framework, options)));
      }
    }
  } finally { current.close(); old.close(); }
}, 60000);

test("global queries do not hydrate whole source tables or run degree subqueries", () => {
  const query = new QueryService(filename); const prepare = query.database.prepare.bind(query.database);
  const spy = vi.spyOn(query.database, "prepare").mockImplementation(((sql: string) => {
    if (/SELECT \* FROM (nodes|edges)\s*$/i.test(sql) || /COUNT\(\*\).*FROM edges/i.test(sql)) throw Error("interactive whole graph scan");
    return prepare(sql);
  }) as typeof query.database.prepare);
  try {
    query.overview(); query.files(); query.architecture(); query.architecture(100, { scope: "full" }); query.context("greeting"); query.cycles(); query.frameworkBindings("tauri"); query.searchSymbols("greet"); query.diagnosticPage();
    const pairPlan = prepare("EXPLAIN QUERY PLAN SELECT ordinal,id FROM q_edges INDEXED BY q_edges_pair WHERE source=? AND target=? AND ordinal>? ORDER BY ordinal LIMIT 1").all("a", "b", 0) as { detail: string }[];
    expect(pairPlan.some(row => row.detail.includes("q_edges_pair") && row.detail.includes("source=? AND target=? AND ordinal>?"))).toBe(true);
    const searchPlan = prepare("EXPLAIN QUERY PLAN SELECT rowid FROM q_search WHERE q_search MATCH ? ORDER BY rowid LIMIT 10001").all('"greet"') as { detail: string }[];
    expect(searchPlan.some(row => row.detail.includes("VIRTUAL TABLE INDEX"))).toBe(true); expect(searchPlan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally { spy.mockRestore(); query.close(); }
});

test("pages bind scope and generation, mutation invalidates cache, offline repair is atomic", () => {
  const query = new QueryService(filename); let cursor: string;
  try {
    const first = query.filePage({ limit: 1, scope: "full" }); cursor = String(first.nextCursor); expect(first.truncated).toBe(true);
    const second = query.filePage({ limit: 1, scope: "full", cursor }); expect(second.items).not.toEqual(first.items);
    expect(() => query.filePage({ scope: "code", cursor })).toThrow("cursor");
  } finally { query.close(); }
  const writer = new Database(filename);
  writer.prepare("UPDATE nodes SET name=name WHERE rowid=(SELECT MIN(rowid) FROM nodes)").run(); writer.close();
  const stale = new QueryService(filename); try { expect(() => stale.overview()).toThrow("prepare-queries"); } finally { stale.close(); }
  prepareQueryIndex(filename);
  const repaired = new QueryService(filename);
  try { expect(repaired.overview()).toBeTruthy(); expect(() => repaired.filePage({ scope: "full", cursor })).toThrow("generation"); } finally { repaired.close(); }
  const corrupt = new Database(filename); corrupt.prepare("UPDATE q_meta SET value='bad' WHERE key='version'").run(); corrupt.close();
  prepareQueryIndex(filename);
});

test("global work budgets include metadata, rejected pair probes and candidate ranking", () => {
  for (const operation of ["overview", "architecture", "context", "frameworkBindings"] as const) {
    const query = new QueryService(filename, { maxCandidates: 1 });
    try { expect(() => operation === "context" ? query.context("greet") : query[operation]()).toThrow("budget"); } finally { query.close(); }
  }
  const query = new QueryService(filename, { maxPayloadBytes: 1 }); try { expect(() => query.overview()).toThrow("payload"); } finally { query.close(); }
});

test("offline cycle computation handles deep graphs without a recursive call stack", () => {
  const edges: GraphEdge[] = Array.from({ length: 20000 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${(i + 1) % 20000}`, kind: "calls", confidence: "resolved", evidence: [], metadata: {} }));
  const result = offlineCycles(edges); expect(result.error).toBeUndefined(); expect(result.cycles).toHaveLength(1); expect(result.cycles[0]).toHaveLength(20000);
});

test("failed offline cache construction retains the prior coherent generation", () => {
  const writer = new Database(filename);
  const generation = writer.prepare("SELECT value FROM q_meta WHERE key='generation'").get();
  writer.exec("CREATE TRIGGER fail_query_projection AFTER INSERT ON q_context BEGIN SELECT RAISE(ABORT,'injected projection fault'); END"); writer.close();
  expect(() => prepareQueryIndex(filename)).toThrow("injected projection fault");
  const read = new QueryService(filename);
  try { expect(read.database.prepare("SELECT value FROM q_meta WHERE key='generation'").get()).toEqual(generation); expect(read.overview()).toBeTruthy(); expect(read.searchSymbols("greet").length).toBeGreaterThan(0); } finally { read.close(); }
  const cleanup = new Database(filename); cleanup.exec("DROP TRIGGER fail_query_projection"); cleanup.close();
});

test("HTTP and MCP expose bounded pages and reject cursors from another operation", async () => {
  const root = path.resolve("tests/fixtures/mixed"); const { server, url } = await startServer(root, { index: directory, port: 0 });
  const mcp = await createProGraphMcpServer(root, directory); const client = new Client({ name: "global-pages", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(a); await client.connect(b);
    const first = await (await fetch(`${url}/api/file-page?scope=full&limit=1`)).json() as { items: unknown[]; nextCursor: string };
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const second = await (await fetch(`${url}/api/file-page?scope=full&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as { items: unknown[] }; expect(second.items).not.toEqual(first.items);
    const result = await client.callTool({ name: "list_diagnostics_page", arguments: { limit: 1 } });
    const diagnostics = JSON.parse((result.content as { text: string }[])[0]!.text) as { items: unknown[]; counts: Record<string, number> }; expect(diagnostics.items).toHaveLength(1); expect(diagnostics.counts).toHaveProperty("warning");
    const q = new QueryService(filename); try { expect(() => q.diagnosticPage({ cursor: first.nextCursor })).toThrow("cursor"); } finally { q.close(); }
  } finally { await client.close(); await mcp.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
