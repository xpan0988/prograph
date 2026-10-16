import type { SemanticStore } from "./store.js";
import { PREDICATES } from "./model.js";

// rs/p aliases identify a selector declaration and its selected snapshot. Qualifiers
// are ANDs of unconditional inputs; publication rejects gated-on-gated environments.
const admittedSelector = `NOT EXISTS(SELECT 1 FROM sc_selector_gates gate WHERE gate.run=rs.run AND gate.key=rs.key AND NOT EXISTS(
  SELECT 1 FROM sc_selector_inputs input WHERE input.snapshot=p.snapshot AND input.key=gate.required_key AND input.digest=gate.expected))`;

/** Immutable claim navigation plus visibility intervals. Only changed ownership/support closure is visited.
 * Snapshot IDs are monotonic CAS publication epochs; intervals never refer to deletable snapshot rows.
 * Legacy snapshots keep their original materialized rows. First publication after upgrade bootstraps once.
 */
export function publishProjections(store: SemanticStore, snapshot: number, parent: number | undefined, measure: (stage: string) => void): void {
  const db = store.db;
  const incremental = parent !== undefined && !!store.sql("SELECT 1 FROM sc_epoch_snapshots WHERE id=?").get(parent);
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS sc_pending(claim INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sc_eligible(claim INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sc_pairs(caller INTEGER,callee INTEGER,PRIMARY KEY(caller,callee));
    CREATE TEMP TABLE IF NOT EXISTS sc_new_calls(caller INTEGER,callee INTEGER,site_count INTEGER,confidence TEXT,sample_claim INTEGER,PRIMARY KEY(caller,callee));
    CREATE TEMP TABLE IF NOT EXISTS sc_changed_selectors(key TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sc_selector_inputs(snapshot INTEGER,key TEXT,digest TEXT,PRIMARY KEY(snapshot,key,digest));
    CREATE TEMP TABLE IF NOT EXISTS sc_effective_selectors(snapshot INTEGER,key TEXT,digest TEXT,PRIMARY KEY(snapshot,key,digest));
    DELETE FROM sc_pending; DELETE FROM sc_eligible; DELETE FROM sc_pairs; DELETE FROM sc_new_calls; DELETE FROM sc_changed_selectors;
    DELETE FROM sc_selector_inputs; DELETE FROM sc_effective_selectors;`);
  // Admission metadata is bounded by selected partitions/selectors, never historical
  // claim volume. Ownership-first joins avoid scanning old declarations on each atom.
  store.sql(`INSERT OR IGNORE INTO sc_selector_inputs SELECT p.snapshot,rs.key,rs.digest FROM sc_partitions p
    CROSS JOIN sc_run_selectors rs ON rs.run=p.run WHERE p.snapshot IN (?,?) AND NOT EXISTS(
      SELECT 1 FROM sc_selector_gates g WHERE g.run=rs.run AND g.key=rs.key)`).run(snapshot, parent ?? -1);
  store.sql(`INSERT OR IGNORE INTO sc_effective_selectors SELECT p.snapshot,rs.key,rs.digest FROM sc_partitions p
    CROSS JOIN sc_run_selectors rs ON rs.run=p.run WHERE p.snapshot IN (?,?) AND ${admittedSelector}`).run(snapshot, parent ?? -1);
  if (incremental) {
    // Changed runs, including deletion and a shared claim's last/alternative ownership path.
    store.sql(`INSERT OR IGNORE INTO sc_pending SELECT o.claim FROM sc_owned o JOIN sc_partitions p ON p.run=o.run WHERE p.snapshot=?
      AND NOT EXISTS(SELECT 1 FROM sc_partitions old WHERE old.snapshot=? AND old.run=p.run)`).run(snapshot, parent);
    store.sql(`INSERT OR IGNORE INTO sc_pending SELECT o.claim FROM sc_owned o JOIN sc_partitions p ON p.run=o.run WHERE p.snapshot=?
      AND NOT EXISTS(SELECT 1 FROM sc_partitions current WHERE current.snapshot=? AND current.run=p.run)`).run(parent, snapshot);
    // A selector changes on absence, new candidates, environment/version changes or a different digest.
    for (const [from, to] of [[parent, snapshot], [snapshot, parent]]) store.sql(`INSERT OR IGNORE INTO sc_changed_selectors SELECT key FROM (
      SELECT key,digest FROM sc_effective_selectors WHERE snapshot=?
      EXCEPT SELECT key,digest FROM sc_effective_selectors WHERE snapshot=?)`).run(from, to);
    store.sql(`INSERT OR IGNORE INTO sc_pending SELECT c.id FROM sc_changed_selectors k CROSS JOIN sc_supports s INDEXED BY sc_selector_reverse ON s.selector=k.key
      CROSS JOIN sc_claims c ON c.support_group=s.group_id
      WHERE EXISTS(SELECT 1 FROM sc_owned o CROSS JOIN sc_partitions p ON p.run=o.run WHERE o.claim=c.id AND p.snapshot IN (?,?))`).run(parent, snapshot);
    let changed = true; let rounds = 0;
    const expand = store.sql(`INSERT OR IGNORE INTO sc_pending SELECT c.id FROM sc_pending input CROSS JOIN sc_supports s INDEXED BY sc_support_reverse ON s.input_claim=input.claim
      CROSS JOIN sc_claims c ON c.support_group=s.group_id
      WHERE EXISTS(SELECT 1 FROM sc_owned o CROSS JOIN sc_partitions p ON p.run=o.run WHERE o.claim=c.id AND p.snapshot IN (?,?))`);
    while (changed) { changed = !!expand.run(parent, snapshot).changes; if (++rounds > 64 && changed) throw Error("Support depth exceeds foundation limit"); }
  } else {
    store.sql("INSERT OR IGNORE INTO sc_pending SELECT o.claim FROM sc_partitions p JOIN sc_owned o ON o.run=p.run WHERE p.snapshot=?").run(snapshot);
  }
  store.sql(`INSERT INTO sc_eligible SELECT pending.claim FROM sc_pending pending WHERE EXISTS(
    SELECT 1 FROM sc_owned o CROSS JOIN sc_partitions p ON p.run=o.run WHERE o.claim=pending.claim AND p.snapshot=?)`).run(snapshot);
  measure("membership");
  const candidates = incremental ? "sc_eligible a CROSS JOIN sc_claims c ON c.id=a.claim" : "sc_claims c INDEXED BY sc_claim_supported CROSS JOIN sc_eligible a ON a.claim=c.id";
  const prune = store.sql(`DELETE FROM sc_eligible WHERE claim IN (
    SELECT a.claim FROM ${candidates} WHERE c.support_group IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM sc_supports s WHERE s.group_id=c.support_group GROUP BY s.alternative HAVING SUM(
      CASE WHEN s.input_claim IS NOT NULL THEN CASE WHEN EXISTS(SELECT 1 FROM sc_eligible x WHERE x.claim=s.input_claim)
        OR (? AND NOT EXISTS(SELECT 1 FROM sc_pending pending WHERE pending.claim=s.input_claim)
          AND EXISTS(SELECT 1 FROM sc_visibility v WHERE v.claim=s.input_claim AND v.last IS NULL)) THEN 0 ELSE 1 END
      ELSE CASE WHEN EXISTS(SELECT 1 FROM sc_effective_selectors environment WHERE environment.snapshot=? AND environment.key=s.selector AND environment.digest=s.expected) THEN 0 ELSE 1 END END)=0))`);
  let changed = true; let rounds = 0;
  while (changed) { changed = !!prune.run(incremental ? 1 : 0, snapshot).changes; if (++rounds > 64 && changed) throw Error("Support depth exceeds foundation limit"); }
  measure("support-eligibility");
  // On a legacy bootstrap there are no open epoch intervals. Subsequent updates close only affected rows.
  store.sql(`UPDATE sc_visibility SET last=? WHERE last IS NULL AND claim IN (SELECT claim FROM sc_pending)
    AND NOT EXISTS(SELECT 1 FROM sc_eligible e WHERE e.claim=sc_visibility.claim)`).run(snapshot);
  store.sql(`INSERT INTO sc_visibility SELECT e.claim,?,NULL FROM sc_eligible e WHERE NOT EXISTS(
    SELECT 1 FROM sc_visibility v WHERE v.claim=e.claim AND v.last IS NULL)`).run(snapshot);
  store.hooks.fault?.("during-publish");
  const relation = Object.entries(PREDICATES).map(([key, value]) => `WHEN '${key}' THEN '${value.relation}'`).join(" ");
  store.sql(`INSERT INTO sc_claim_navigation SELECT c.id,CASE f.predicate ${relation} END,f.subject,f.object,f.occurrence,c.confidence,CASE WHEN f.predicate='context.Project' THEN f.context END
    FROM sc_eligible e CROSS JOIN sc_claims c ON c.id=e.claim CROSS JOIN sc_facts f ON f.id=c.fact
    WHERE NOT EXISTS(SELECT 1 FROM sc_claim_navigation n WHERE n.claim=e.claim)`).run();
  measure("navigation");
  // No per-snapshot symbol/context copies: indexed declarations/context claims are immutable navigation.
  measure("symbols");
  if (incremental) store.sql(`INSERT OR IGNORE INTO sc_pairs SELECT n.subject,n.object FROM sc_pending p CROSS JOIN sc_claim_navigation n ON n.claim=p.claim WHERE n.relation='calls'`).run();
  else store.sql(`INSERT OR IGNORE INTO sc_pairs SELECT n.subject,n.object FROM sc_claim_navigation n WHERE n.relation='calls'
    AND EXISTS(SELECT 1 FROM sc_visibility v WHERE v.claim=n.claim AND v.last IS NULL)`).run();
  // A competing call target can invalidate a summary without removing its positive supports.
  if (incremental) store.sql(`INSERT OR IGNORE INTO sc_pairs SELECT other.subject,other.object FROM sc_pending p CROSS JOIN sc_claims c ON c.id=p.claim
    CROSS JOIN sc_facts f ON f.id=c.fact CROSS JOIN sc_claim_navigation other ON other.occurrence=f.occurrence AND other.relation='calls'
    WHERE f.predicate='common.CallTarget'`).run();
  store.sql(`INSERT INTO sc_new_calls SELECT pair.caller,pair.callee,COUNT(DISTINCT n.occurrence),
    CASE WHEN MIN(CASE n.confidence WHEN 'exact' THEN 0 ELSE 1 END)=0 THEN 'exact' ELSE 'resolved' END,MIN(n.claim)
    FROM sc_pairs pair CROSS JOIN sc_claim_navigation n ON n.relation='calls' AND n.subject=pair.caller AND n.object=pair.callee
    WHERE n.confidence IN ('exact','resolved') AND EXISTS(SELECT 1 FROM sc_visibility v WHERE v.claim=n.claim AND v.last IS NULL)
    AND NOT EXISTS(SELECT 1 FROM sc_claim_navigation t JOIN sc_claim_navigation other ON other.relation='calltarget' AND other.occurrence=t.occurrence AND other.object<>t.object
      WHERE t.relation='calltarget' AND t.occurrence=n.occurrence AND t.object=n.object AND t.confidence IN ('exact','resolved') AND other.confidence IN ('exact','resolved')
      AND EXISTS(SELECT 1 FROM sc_visibility v WHERE v.claim=t.claim AND v.last IS NULL) AND EXISTS(SELECT 1 FROM sc_visibility v WHERE v.claim=other.claim AND v.last IS NULL))
    GROUP BY pair.caller,pair.callee`).run();
  store.sql(`UPDATE sc_call_epochs SET last=? WHERE last IS NULL AND (caller,callee) IN (SELECT caller,callee FROM sc_pairs)
    AND NOT EXISTS(SELECT 1 FROM sc_new_calls c WHERE c.caller=sc_call_epochs.caller AND c.callee=sc_call_epochs.callee AND c.site_count=sc_call_epochs.site_count AND c.confidence=sc_call_epochs.confidence AND c.sample_claim=sc_call_epochs.sample_claim)`).run(snapshot);
  store.sql(`INSERT INTO sc_call_epochs SELECT c.caller,c.callee,?,NULL,c.site_count,c.confidence,c.sample_claim FROM sc_new_calls c
    WHERE NOT EXISTS(SELECT 1 FROM sc_call_epochs old WHERE old.caller=c.caller AND old.callee=c.callee AND old.last IS NULL)`).run(snapshot);
  store.sql("INSERT INTO sc_epoch_snapshots VALUES(?)").run(snapshot);
  measure("call-summary");
}
