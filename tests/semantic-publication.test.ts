import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SemanticQuery } from "../src/core/semantic/query.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";
import type { FactInput } from "../src/core/semantic/model.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-publication-")); roots.push(root);
  const file = path.join(root, "semantic.sqlite"); const store = new SemanticStore(file);
  for (const key of ["caller", "target", "other"]) store.addSymbol({ key, name: key, qualifiedName: key, kind: "function", file: "src.ts", context: "ctx" });
  store.addOccurrence({ ...new SourceCoordinates("src.ts", "target()").range(0, 6, "ctx", "call"), key: "site" }, 8);
  const fact = (provider: string): FactInput => ({ predicate: "common.Declaration", context: "ctx", subject: "target", occurrence: "site", confidence: "resolved", provenance: { provider, version: "1", basis: "compiler", method: "fixture", context: "ctx", inputFingerprint: "inputs" } });
  const run = (partition: string, provider: string, values: Partial<FactInput>[] = [{}]) => {
    const id = store.begin(partition, "ctx", "inputs");
    const claims = store.batch(id, () => values.map(value => store.addFact(id, { ...fact(provider), ...value })));
    store.seal(id, { status: "partial" }); return { id, claims };
  };
  return { store, file, run, fact };
}
/** Independent full selected-ownership/OR-of-AND fixed point; no interval/projection inputs. */
function fullOracle(store: SemanticStore, snapshot: number): number[] {
  const owned = store.db.prepare("SELECT DISTINCT o.claim,c.support_group FROM sc_partitions p JOIN sc_owned o ON o.run=p.run JOIN sc_claims c ON c.id=o.claim WHERE p.snapshot=?").all(snapshot) as { claim: number; support_group: number | null }[];
  const selectors = new Map((store.db.prepare("SELECT rs.key,rs.digest FROM sc_run_selectors rs JOIN sc_partitions p ON p.run=rs.run WHERE p.snapshot=?").all(snapshot) as { key: string; digest: string }[]).map(x => [x.key, x.digest]));
  const active = new Set(owned.map(x => x.claim)); let changed = true;
  while (changed) {
    changed = false;
    for (const row of owned) if (active.has(row.claim) && row.support_group) {
      const alternatives = new Map<number, boolean>();
      for (const atom of store.db.prepare("SELECT * FROM sc_supports WHERE group_id=?").all(row.support_group) as { alternative: number; input_claim: number | null; selector: string; expected: string }[]) {
        alternatives.set(atom.alternative, (alternatives.get(atom.alternative) ?? true) && (atom.input_claim !== null ? active.has(atom.input_claim) : selectors.get(atom.selector) === atom.expected));
      }
      if (![...alternatives.values()].some(Boolean)) { active.delete(row.claim); changed = true; }
    }
  }
  return [...active].sort((a, b) => a - b);
}
function visible(store: SemanticStore, snapshot: number): number[] { return (store.db.prepare("SELECT claim FROM sc_active WHERE snapshot=? ORDER BY claim").all(snapshot) as { claim: number }[]).map(x => x.claim); }

test("publication reuses unchanged navigation and memberships; readers retain a pinned snapshot", async () => {
  const { store, file, run } = await fixture();
  try {
    const a = run("a", "a"); const b = run("b", "b"); const first = store.publish([a.id, b.id]);
    const reader = new Database(file, { readonly: true }); reader.exec("BEGIN"); expect(reader.prepare("SELECT value FROM sc_meta WHERE key='active'").get()).toEqual({ value: String(first) });
    const before = store.db.prepare("SELECT * FROM sc_claim_navigation ORDER BY claim").all(); const intervals = store.db.prepare("SELECT * FROM sc_visibility ORDER BY claim").all();
    const noOp = store.publish([a.id, b.id]);
    expect(store.db.prepare("SELECT * FROM sc_claim_navigation ORDER BY claim").all()).toEqual(before);
    expect(store.db.prepare("SELECT * FROM sc_visibility ORDER BY claim").all()).toEqual(intervals);
    const replacement = run("a", "a2"); const next = store.publish([replacement.id, b.id]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_pending").get()).toEqual({ n: 2 });
    expect(visible(store, next)).toEqual(fullOracle(store, next)); expect(visible(store, first)).toEqual([1, 2]); expect(visible(store, noOp)).toEqual([1, 2]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sc_claim_navigation").get()).toEqual({ n: 3 });
    expect(store.db.prepare("SELECT last FROM sc_visibility WHERE claim=2").get()).toEqual({ last: null });
    expect(reader.prepare("SELECT value FROM sc_meta WHERE key='active'").get()).toEqual({ value: String(first) });
    reader.exec("ROLLBACK"); reader.close(); expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { store.close(); }
});

test("random owned/support/selector selections match a full oracle, including reactivation and fanout", async () => {
  const { store, run, fact } = await fixture();
  try {
    const a = run("a", "a"); const b = run("b", "b");
    const one = store.begin("selector", "ctx", "inputs"); store.selector(one, "candidates", "one"); store.seal(one, {});
    const two = store.begin("selector", "ctx", "inputs"); store.selector(two, "candidates", "two"); store.seal(two, {});
    const derived = store.begin("pass", "ctx", "inputs"); const derivedClaims: string[] = [];
    store.batch(derived, () => { for (let i = 0; i < 300; i++) derivedClaims.push(store.addFact(derived, { ...fact(`pass-${i}`), predicate: "common.CallSummary", subject: "caller", object: "target", supports: [[{ claim: a.claims[0]! }, { selector: "candidates", digest: "one" }], [{ claim: b.claims[0]! }]] })); });
    const downstream = store.batch(derived, () => store.addFact(derived, { ...fact("downstream"), predicate: "common.CallSummary", subject: "caller", object: "target", supports: [[{ claim: derivedClaims[0]! }]] })); expect(downstream).toBeTruthy(); store.seal(derived, {});
    let seed = 123456; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const history: [number, number[]][] = [];
    for (let i = 0; i < 60; i++) {
      const selected = [derived, random() & 1 ? one : two, ...(random() & 2 ? [a.id] : []), ...(random() & 4 ? [b.id] : [])];
      const snapshot = store.publish(selected); const expected = fullOracle(store, snapshot); expect(visible(store, snapshot)).toEqual(expected); history.push([snapshot, expected]);
    }
    for (const [snapshot, expected] of history) expect(visible(store, snapshot)).toEqual(expected);
  } finally { store.close(); }
});

test("replacing one of two owners preserves their shared old claim and adds independent new evidence", async () => {
  const { store, run } = await fixture();
  try {
    const a = run("a", "same"); const b = run("b", "same"); expect(a.claims).toEqual(b.claims);
    const first = store.publish([a.id, b.id]); expect(visible(store, first)).toHaveLength(1);
    const replacement = run("a", "different"); const next = store.publish([replacement.id, b.id]);
    expect(visible(store, next)).toEqual(fullOracle(store, next)); expect(visible(store, next)).toHaveLength(2); expect(visible(store, first)).toHaveLength(1);
  } finally { store.close(); }
});

test("new competing static targets invalidate retained call aggregates and removal restores them", async () => {
  const { store, file, run } = await fixture();
  try {
    const base = run("base", "compiler", [{ predicate: "common.CallSite", subject: "caller" }, { predicate: "common.CallTarget", subject: "caller", object: "target" }]);
    const pass = run("pass", "pass", [{ predicate: "common.CallSummary", subject: "caller", object: "target", supports: [[{ claim: base.claims[0]! }, { claim: base.claims[1]! }]] }]);
    const first = store.publish([base.id, pass.id]); const q = new SemanticQuery(file);
    try {
      expect(q.execute("callees", "caller").items).toHaveLength(1);
      const competitor = run("other", "other", [{ predicate: "common.CallTarget", subject: "caller", object: "other" }]);
      const next = store.publish([base.id, pass.id, competitor.id]); expect(q.execute("callees", "caller").items).toEqual([]);
      expect(q.execute("callees", "caller", { snapshot: first }).items).toHaveLength(1);
      store.publish([base.id, pass.id]); expect(q.execute("callees", "caller").items).toHaveLength(1); expect(q.execute("callees", "caller", { snapshot: next }).items).toEqual([]);
    } finally { q.close(); }
  } finally { store.close(); }
});

test("immutable navigation and historical call probes use ordered indexes without temporary sorting", async () => {
  const { store } = await fixture();
  try {
    for (const [sql, values, index] of [
      ["SELECT n.* FROM sc_claim_navigation n WHERE n.relation=? AND n.object=? AND n.occurrence>? ORDER BY n.occurrence,n.claim", ["reference", 1, 0], "sc_epoch_nav_object"],
      ["SELECT * FROM sc_call_epochs WHERE callee=? AND caller>? ORDER BY caller,first DESC", [1, 0], "sc_epoch_calls_callee_desc"],
      ["SELECT * FROM sc_call_epochs WHERE caller=? AND callee>? ORDER BY callee,first DESC", [1, 0], "sc_epoch_calls_caller"],
    ] as const) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[];
      expect(plan.some(x => x.detail.includes(index))).toBe(true); expect(plan.some(x => x.detail.includes("TEMP B-TREE"))).toBe(false);
    }
  } finally { store.close(); }
});

test("publication eligibility probes claim owners before selected partitions", async () => {
  const { store, run } = await fixture(); const sql = store.sql.bind(store); let checked = false;
  const spy = vi.spyOn(store, "sql").mockImplementation(query => {
    if (query.startsWith("INSERT INTO sc_eligible SELECT")) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1) as { detail: string }[];
      const owner = plan.findIndex(x => x.detail.includes("sc_owned_claim") && x.detail.includes("claim=?"));
      const partition = plan.findIndex(x => /sc_partitions_(run|owner)/.test(x.detail) && (x.detail.includes("snapshot=? AND run=?") || x.detail.includes("run=? AND snapshot=?")));
      expect(owner).toBeGreaterThanOrEqual(0); expect(partition).toBeGreaterThan(owner); checked = true;
    }
    return sql(query);
  });
  try { const a = run("a", "a"); store.publish([a.id]); store.publish([a.id]); expect(checked).toBe(true); }
  finally { spy.mockRestore(); store.close(); }
});

test("legacy materialized snapshots upgrade without copying or changing their rows", async () => {
  const { store, file, run } = await fixture(); const base = run("base", "base"); const first = store.publish([base.id]);
  const tables = ["active", "navigation", "calls", "visible_symbols", "context_lookup"];
  // Reconstruct the previous physical schema from a tiny known snapshot, retaining exact old rows.
  for (const table of tables) store.db.exec(`INSERT INTO sc_legacy_${table} SELECT * FROM sc_${table}`);
  for (const table of [...tables].reverse()) store.db.exec(`DROP VIEW sc_${table}`);
  store.db.exec("DELETE FROM sc_epoch_snapshots; DELETE FROM sc_visibility; DELETE FROM sc_call_epochs; DELETE FROM sc_claim_navigation;");
  for (const table of tables) store.db.exec(`ALTER TABLE sc_legacy_${table} RENAME TO sc_${table}`);
  store.db.prepare("UPDATE sc_meta SET value='2.0.0-step2.3' WHERE key='schema'").run(); store.close();
  const old = new SemanticQuery(file); try { expect(old.execute("find", "target").items).toHaveLength(1); } finally { old.close(); }
  const upgraded = new SemanticStore(file);
  try { const next = upgraded.publish([base.id]); expect(visible(upgraded, next)).toEqual(visible(upgraded, first)); expect(upgraded.db.prepare("SELECT COUNT(*) AS n FROM sc_legacy_active").get()).toEqual({ n: 1 }); }
  finally { upgraded.close(); }
});

test("expired navigation candidates consume read work rather than an unbounded post-filter scan", async () => {
  const { store, file } = await fixture();
  try {
    const run = store.begin("many", "ctx", "inputs");
    store.batch(run, () => { for (let i = 0; i < 5100; i++) store.addFact(run, { predicate: "common.Reference", subject: "caller", object: "target", occurrence: "site", context: "ctx", confidence: "resolved", value: { i }, provenance: { provider: "test", version: "1", basis: "compiler", method: "test", context: "ctx", inputFingerprint: "inputs" } }); });
    store.seal(run, {}); store.publish([run]); store.publish([]);
    const q = new SemanticQuery(file); try { expect(() => q.execute("references", "target")).toThrow("budget"); } finally { q.close(); }
  } finally { store.close(); }
});
