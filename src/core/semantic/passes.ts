import { SemanticStore } from "./store.js";
import type { Predicate, Provenance } from "./model.js";

export interface FactPass {
  id: string;
  version: string;
  reads: Predicate[];
  writes: Predicate[];
  dependencies: string[];
  invalidation: "indexing-unit-and-selectors";
  bounds: { batch: number; maxRows: number };
  execute(store: SemanticStore, input: number, output: number, provenance: Provenance, selector: string, dependencies: ReadonlyMap<string, number>): void;
}
/** Validate the pass DAG before starting any output run. Providers do not mutate base facts. */
export function orderPasses(passes: FactPass[]): FactPass[] {
  const byId = new Map(passes.map(pass => [pass.id, pass]));
  if (byId.size !== passes.length) throw Error("Duplicate pass ID");
  const active = new Set<string>(); const done = new Set<string>(); const ordered: FactPass[] = [];
  const visit = (pass: FactPass) => {
    if (active.has(pass.id)) throw Error(`Pass dependency cycle: ${pass.id}`);
    if (done.has(pass.id)) return;
    active.add(pass.id);
    for (const id of pass.dependencies) { const dependency = byId.get(id); if (!dependency) throw Error(`Missing pass dependency: ${id}`); visit(dependency); }
    active.delete(pass.id); done.add(pass.id); ordered.push(pass);
  };
  passes.forEach(visit); return ordered;
}

// CROSS JOIN fixes the ownership -> site -> indexed target order; a second ownership scan is quadratic.
export const CALL_PASS_SQL = `SELECT c.id AS site_id,tc.id AS target_id,c.key AS site_key,tc.key AS target_key,owner.key AS owner,callee.key AS callee,occ.key AS occurrence,c.confidence AS site_confidence,tc.confidence
      FROM sc_owned o CROSS JOIN sc_claims c ON c.id=o.claim CROSS JOIN sc_facts s ON s.id=c.fact
      CROSS JOIN sc_facts t INDEXED BY sc_fact_occurrence ON t.predicate='common.CallTarget' AND t.context=s.context AND t.occurrence=s.occurrence AND t.subject=s.subject
      CROSS JOIN sc_claims tc INDEXED BY sc_claim_fact ON tc.fact=t.id
      CROSS JOIN sc_entities owner ON owner.id=s.subject CROSS JOIN sc_entities callee ON callee.id=t.object CROSS JOIN sc_entities occ ON occ.id=s.occurrence
      WHERE o.run=? AND s.predicate='common.CallSite' AND (o.claim>? OR (o.claim=? AND tc.id>?))
      AND EXISTS(SELECT 1 FROM sc_owned ot WHERE ot.run=o.run AND ot.claim=tc.id) ORDER BY o.claim,tc.id LIMIT ?`;

export const callPass: FactPass = {
  id: "call-summary", version: "1", reads: ["common.CallSite", "common.CallTarget"], writes: ["common.CallSummary"], dependencies: [],
  invalidation: "indexing-unit-and-selectors", bounds: { batch: 1000, maxRows: 1000000 },
  execute(store, input, output, provenance, selector) {
    let site = 0; let target = 0; let total = 0;
    type Row = { site_id: number; target_id: number; site_key: string; target_key: string; owner: string; callee: string; occurrence: string; site_confidence: "exact" | "resolved" | "probable" | "unresolved"; confidence: "exact" | "resolved" | "probable" | "unresolved" };
    const query = store.sql(CALL_PASS_SQL);
    while (true) {
      const rows = query.all(input, site, site, target, callPass.bounds.batch) as Row[];
      if (!rows.length) break;
      total += rows.length; if (total > callPass.bounds.maxRows) throw Error("Call pass exceeded row bound");
      const ranks = ["exact", "resolved", "probable", "unresolved"] as const;
      store.batch(output, () => { for (const row of rows) store.addFact(output, { predicate: "common.CallSummary", context: provenance.context, subject: row.owner, object: row.callee, occurrence: row.occurrence,
        confidence: ranks[Math.max(ranks.indexOf(row.confidence), ranks.indexOf(row.site_confidence))]!, provenance, supports: [[{ claim: row.site_key }, { claim: row.target_key }, { selector, digest: provenance.inputFingerprint }]] }); });
      site = rows.at(-1)!.site_id; target = rows.at(-1)!.target_id;
    }
  },
};

export function executePasses(store: SemanticStore, input: number, partition: string, provenance: Provenance, selector: string, passes: FactPass[] = [callPass]): number[] {
  const state = store.sql("SELECT state FROM sc_runs WHERE id=?").get(input) as { state: string } | undefined;
  if (state?.state !== "sealed") throw Error("Pass input must be sealed");
  const runs: number[] = []; const completed = new Map<string, number>();
  for (const pass of orderPasses(passes)) {
    const run = store.begin(`${partition}/pass:${pass.id}@${pass.version}`, provenance.context, provenance.inputFingerprint);
    const dependencies = new Map(pass.dependencies.map(id => [id, completed.get(id)!]));
    pass.execute(store, input, run, { ...provenance, provider: `pass:${pass.id}`, version: pass.version, method: "supported-fact-projection" }, selector, dependencies);
    store.seal(run, { status: "partial", pass: pass.id, version: pass.version, reads: pass.reads, writes: pass.writes, dependencies: pass.dependencies, invalidation: pass.invalidation, bounds: pass.bounds }); runs.push(run); completed.set(pass.id, run);
  }
  return runs;
}
