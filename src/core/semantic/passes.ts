import { SemanticStore } from "./store.js";
import type { Predicate, Provenance } from "./model.js";

export interface PassContract {
  id: string;
  version: string;
  reads: Predicate[];
  writes: Predicate[];
  dependencies: string[];
  configurationFingerprint: string;
  requiredCapabilities: string[];
  inputDomains: string[];
  selectorDependencies: string[];
  negativeDependencies: string[];
  ownershipShard: string;
  coverageBehavior: string;
  invalidation: "indexing-unit-and-selectors";
  bounds: { batch: number; maxRows: number };
}
export interface FactPass extends PassContract {
  execute(store: SemanticStore, input: number, output: number, provenance: Provenance, selector: string, dependencies: ReadonlyMap<string, number>): void;
}
/** Validate the pass DAG before starting any output run. Providers do not mutate base facts. */
export function orderPasses<T extends { id: string; dependencies: string[] }>(passes: T[]): T[] {
  const byId = new Map(passes.map(pass => [pass.id, pass]));
  if (byId.size !== passes.length) throw Error("Duplicate pass ID");
  const active = new Set<string>(); const done = new Set<string>(); const ordered: T[] = [];
  const visit = (pass: T) => {
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
  configurationFingerprint: "static-target-policy-1", requiredCapabilities: ["callsite", "static-calltarget"], inputDomains: ["native-semantic"],
  selectorDependencies: ["indexing-unit-inputs"], negativeDependencies: ["calltarget-candidate-set"], ownershipShard: "indexing-unit", coverageBehavior: "partial-static-targets",
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
    const contract = passContract(pass);
    const run = store.begin(`${partition}/pass:${pass.id}@${pass.version}`, provenance.context, provenance.inputFingerprint);
    const dependencies = new Map(pass.dependencies.map(id => [id, completed.get(id)!]));
    pass.execute(store, input, run, { ...provenance, provider: `pass:${pass.id}`, version: pass.version, method: "supported-fact-projection" }, selector, dependencies);
    const emitted = store.sql("SELECT f.predicate,COUNT(*) AS n FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=? GROUP BY f.predicate").all(run) as { predicate: string; n: number }[];
    if (emitted.some(row => !(pass.writes as string[]).includes(row.predicate)) || emitted.reduce((n, row) => n + row.n, 0) > pass.bounds.maxRows) throw Error(`Pass ${pass.id} violated its output contract`);
    store.seal(run, { ...contract, status: "partial" }); runs.push(run); completed.set(pass.id, run);
  }
  return runs;
}

export function passContract(pass: PassContract): Record<string, unknown> {
  if (!/^[a-z][a-z0-9-]*$/.test(pass.id) || !pass.version || !pass.configurationFingerprint || !pass.ownershipShard) throw Error("Incomplete pass contract");
  return { pass: pass.id, version: pass.version, configurationFingerprint: pass.configurationFingerprint, reads: pass.reads, writes: pass.writes, dependencies: pass.dependencies,
    requiredCapabilities: pass.requiredCapabilities, inputDomains: pass.inputDomains, selectorDependencies: pass.selectorDependencies, negativeDependencies: pass.negativeDependencies,
    ownershipShard: pass.ownershipShard, invalidation: pass.invalidation, coverageBehavior: pass.coverageBehavior, bounds: pass.bounds };
}

/** Upgrade pass declarations from retained base facts without relaunching a compiler. */
export function qualifiedCallProjection(store: SemanticStore, input: number, partition: string, previous?: number): number[] {
  if (previous) {
    const coverage = JSON.parse((store.sql("SELECT coverage_json FROM sc_runs WHERE id=? AND state='sealed'").get(previous) as { coverage_json: string }).coverage_json) as Record<string, unknown>;
    if (coverage.configurationFingerprint === callPass.configurationFingerprint && coverage.ownershipShard === callPass.ownershipShard) return [previous];
  }
  const row = store.sql("SELECT context,input_fingerprint FROM sc_runs WHERE id=? AND state='sealed'").get(input) as { context: string; input_fingerprint: string };
  const selector = store.sql("SELECT key FROM sc_run_selectors WHERE run=? AND digest=? ORDER BY key LIMIT 1").get(input, row.input_fingerprint) as { key: string } | undefined;
  if (!selector) throw Error("Cannot qualify call pass without its native input selector");
  const origin = store.sql("SELECT p.json FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance WHERE o.run=? AND f.predicate='common.CallTarget' LIMIT 1").get(input) as { json: string } | undefined;
  return executePasses(store, input, partition, { provider: "pass:call-summary", version: callPass.version, basis: origin ? (JSON.parse(origin.json) as Provenance).basis : "unresolved", method: "supported-fact-projection", context: row.context, inputFingerprint: row.input_fingerprint }, selector.key);
}
