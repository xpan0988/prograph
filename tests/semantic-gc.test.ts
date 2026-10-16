import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SemanticStore } from "../src/core/semantic/store.js";
import { SourceCoordinates } from "../src/core/semantic/coordinates.js";
import { type FactInput } from "../src/core/semantic/model.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-gc-")); roots.push(root); const store = new SemanticStore(path.join(root, "semantic.sqlite"));
  for (const key of ["caller", "target"]) store.addSymbol({ key, name: key, qualifiedName: key, kind: "function", context: "ctx", file: "a.ts" });
  store.addOccurrence({ ...new SourceCoordinates("a.ts", "target()").range(0, 6, "ctx", "call"), key: "occ" }, 8);
  return store;
}
const fact = (name: string, supports?: FactInput["supports"]): FactInput => ({ predicate: supports ? "common.CallSummary" : "common.Reference", subject: "caller", object: "target", occurrence: "occ", context: "ctx", confidence: "resolved", provenance: { provider: name, version: "1", basis: "compiler", method: "test", context: "ctx", inputFingerprint: name }, ...(supports ? { supports } : {}) });
function run(store: SemanticStore, key: string, value?: FactInput) {
  const id = store.begin(key, "ctx", value?.provenance.inputFingerprint ?? key); const claim = value ? store.batch(id, () => store.addFact(id, value)) : undefined;
  store.input(id, "physical:/proof", key); store.seal(id, { status: "partial" }); return { id, claim };
}
function visible(store: SemanticStore, snapshot: number) { return store.sql("SELECT c.key FROM sc_active a JOIN sc_claims c ON c.id=a.claim WHERE a.snapshot=? ORDER BY c.key").all(snapshot); }

test("GC retains all alternative supports, historical snapshots, pins and immutable origin evidence", async () => {
  const store = await fixture();
  try {
    const a = run(store, "a", fact("a")); const b = run(store, "b", fact("b"));
    const derived = run(store, "derived", fact("derived", [[{ claim: a.claim! }], [{ claim: b.claim! }]]));
    const first = store.publish([a.id, b.id, derived.id]); store.pinSnapshot(first, "audit");
    const second = store.publish([b.id, derived.id]); const last = store.publish([derived.id]);
    const expected = [first, second, last].map(s => visible(store, s));
    const reader = new Database(store.filename, { readonly: true }); reader.exec("BEGIN"); expect(reader.prepare("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 3 });
    const abandoned = run(store, "abandoned", fact("unreachable"));
    const staging = store.begin("staging", "ctx", "staging"); store.batch(staging, () => store.addFact(staging, fact("staging")));
    const removed = store.collectGarbage({ keep: 1, retain: [second] });
    expect(removed.runs).toBe(2); expect(store.sql("SELECT 1 FROM sc_runs WHERE id=?").get(abandoned.id)).toBeUndefined();
    expect([first, second, last].map(s => visible(store, s))).toEqual(expected);
    expect(store.sql("SELECT COUNT(*) AS n FROM sc_claims").get()).toEqual({ n: 3 });
    store.unpinSnapshot(first, "audit"); const final = store.collectGarbage({ keep: 1 });
    expect(final.snapshots).toBe(2); expect(final.runs).toBe(2);
    expect(store.sql("SELECT COUNT(*) AS n FROM sc_claims").get()).toEqual({ n: 3 }); // Ineligible but owned derivation keeps both false alternative proofs.
    expect(store.sql("SELECT COUNT(*) AS n FROM sc_origin_runs").get()).toEqual({ n: 2 });
    expect(store.sql("SELECT COUNT(*) AS n FROM sc_claim_origins").get()).toEqual({ n: 2 });
    expect(reader.prepare("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 3 }); reader.exec("COMMIT"); reader.close();
    expect(store.db.pragma("foreign_key_check")).toEqual([]); expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
    store.publish([]); store.collectGarbage({ keep: 1 });
    for (const table of ["sc_claims", "sc_facts", "sc_entities", "sc_sources", "sc_provenance", "sc_groups", "sc_supports", "sc_origin_runs", "sc_claim_origins", "sc_occurrences"]) expect(store.sql(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  } finally { store.close(); }
});

test("GC keeps large projection payloads and rolls back failed collection atomically", async () => {
  const store = await fixture();
  try {
    const key = "payload"; store.addEntity(key, "artifact", { text: "x".repeat(70000) });
    const live = run(store, "live", { ...fact("payload"), predicate: "syntax.Node", subject: "caller", object: undefined, occurrence: undefined, value: { payloadEntity: key } });
    // FactInput optional fields must be omitted, not serialized as undefined.
    const first = store.publish([live.id]); const before = visible(store, first);
    const old = run(store, "old", fact("old")); store.publish([live.id, old.id]); store.publish([live.id]);
    store.db.exec("CREATE TEMP TRIGGER gc_failure BEFORE DELETE ON sc_facts BEGIN SELECT RAISE(ABORT,'injected GC failure'); END");
    expect(() => store.collectGarbage({ keep: 1 })).toThrow("injected GC failure");
    expect(store.sql("SELECT COUNT(*) AS n FROM sc_snapshots").get()).toEqual({ n: 3 }); expect(visible(store, first)).toEqual(before);
    store.db.exec("DROP TRIGGER gc_failure"); store.collectGarbage({ keep: 1 });
    expect(store.entity(key)).toBeGreaterThan(0); expect(() => store.pinSnapshot(first)).toThrow();
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
  } finally { store.close(); }
});

test("GC preserves selector admission and source-catalogue witnesses after their snapshots expire", async () => {
  const store = await fixture();
  try {
    const root = (value: string) => { const id = store.begin("catalogue", "ctx", value); store.selector(id, "catalogue", value); store.seal(id, {}); return id; };
    const index = (value: string, output: string) => { const id = store.begin("pass-index", "ctx", value); store.selector(id, "output", output, [{ key: "catalogue", digest: value }]); store.seal(id, {}); return id; };
    const oldRoot = root("one"), oldIndex = index("one", "bound");
    const output = run(store, "output", fact("output", [[{ selector: "output", digest: "bound" }]]));
    store.publish([oldRoot, oldIndex, output.id]);
    const newRoot = root("two"), newIndex = index("two", "ambiguous");
    const current = store.publish([newRoot, newIndex, output.id]); expect(visible(store, current)).toEqual([]);
    store.collectGarbage({ keep: 1 });
    const origins = store.sql("SELECT partition_key,selectors_json FROM sc_origin_runs ORDER BY partition_key").all() as Array<{ partition_key: string; selectors_json: string }>;
    expect(origins.map(row => row.partition_key)).toEqual(["catalogue", "pass-index"]);
    expect(JSON.parse(origins[1]!.selectors_json)).toEqual([{ key: "output", digest: "bound", requires: [{ key: "catalogue", digest: "one" }] }]);
    store.collectGarbage({ keep: 1 }); expect(store.sql("SELECT COUNT(*) AS n FROM sc_origin_runs").get()).toEqual({ n: 2 });
    expect(visible(store, current)).toEqual([]); expect(store.db.pragma("foreign_key_check")).toEqual([]);
    store.publish([]); store.collectGarbage({ keep: 1 }); expect(store.sql("SELECT COUNT(*) AS n FROM sc_origin_runs").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});
