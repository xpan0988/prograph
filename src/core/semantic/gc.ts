import type { SemanticStore } from "./store.js";

export interface GarbageCollectionOptions { keep?: number; retain?: number[] }
/** Offline maintenance. Publication never relies on collecting obsolete rows. FULL/WAL is unchanged. */
export function collectSemanticGarbage(store: SemanticStore, options: GarbageCollectionOptions = {}): Record<string, number> {
  const keep = options.keep ?? 3;
  if (!Number.isSafeInteger(keep) || keep < 1) throw Error("Retention must keep at least one snapshot");
  const tables = ["sc_snapshots", "sc_runs", "sc_claims", "sc_facts", "sc_sources", "sc_provenance", "sc_groups", "sc_entities", "sc_origin_runs"];
  const count = () => Object.fromEntries(tables.map(table => [table, (store.sql(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
  return store.db.transaction(() => {
    const before = count();
    store.db.exec(`CREATE TEMP TABLE sc_gc_snapshots(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sc_gc_claims(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sc_gc_entities(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sc_gc_published(run INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sc_gc_receipts(run INTEGER NOT NULL,claim INTEGER NOT NULL,PRIMARY KEY(run,claim));
      CREATE TEMP TABLE sc_gc_selector_witness(key TEXT NOT NULL,digest TEXT NOT NULL,run INTEGER NOT NULL,PRIMARY KEY(key,digest));
      INSERT INTO sc_gc_published SELECT DISTINCT run FROM sc_partitions;
      INSERT INTO sc_gc_snapshots SELECT id FROM sc_snapshots ORDER BY id DESC LIMIT ${keep};
      INSERT OR IGNORE INTO sc_gc_snapshots SELECT snapshot FROM sc_snapshot_pins;
      INSERT OR IGNORE INTO sc_gc_snapshots SELECT id FROM sc_snapshots WHERE id=CAST((SELECT value FROM sc_meta WHERE key='active') AS INTEGER)`);
    try {
      for (const id of options.retain ?? []) {
        if (!Number.isSafeInteger(id) || !store.sql("SELECT 1 FROM sc_snapshots WHERE id=?").get(id)) throw Error("Cannot retain unknown snapshot");
        store.sql("INSERT OR IGNORE INTO sc_gc_snapshots VALUES(?)").run(id);
      }
      // Numeric visibility intervals need no rewritten endpoints: retain an interval exactly
      // when it intersects a retained epoch, even if its original first snapshot is removed.
      store.db.exec(`UPDATE sc_snapshots SET parent=NULL WHERE parent NOT IN(SELECT id FROM sc_gc_snapshots);
        DELETE FROM sc_snapshots WHERE id NOT IN(SELECT id FROM sc_gc_snapshots);
        DELETE FROM sc_visibility WHERE NOT EXISTS(SELECT 1 FROM sc_epoch_snapshots s WHERE s.id>=first AND (last IS NULL OR s.id<last));
        DELETE FROM sc_call_epochs WHERE NOT EXISTS(SELECT 1 FROM sc_epoch_snapshots s WHERE s.id>=first AND (last IS NULL OR s.id<last));
        INSERT OR IGNORE INTO sc_gc_claims SELECT o.claim FROM sc_partitions p JOIN sc_owned o ON o.run=p.run;
        INSERT OR IGNORE INTO sc_gc_claims SELECT claim FROM sc_visibility;
        INSERT OR IGNORE INTO sc_gc_claims SELECT sample_claim FROM sc_call_epochs;
        INSERT OR IGNORE INTO sc_gc_claims SELECT claim FROM sc_legacy_active;
        INSERT OR IGNORE INTO sc_gc_claims SELECT claim FROM sc_legacy_navigation;
        INSERT OR IGNORE INTO sc_gc_claims SELECT sample_claim FROM sc_legacy_calls;
        WITH RECURSIVE reachable(id) AS (
          SELECT id FROM sc_gc_claims UNION
          SELECT s.input_claim FROM reachable r JOIN sc_claims c ON c.id=r.id JOIN sc_supports s ON s.group_id=c.support_group WHERE s.input_claim IS NOT NULL
        ) INSERT OR IGNORE INTO sc_gc_claims SELECT id FROM reachable;
        INSERT OR IGNORE INTO sc_gc_receipts SELECT o.run,o.claim FROM sc_owned o JOIN sc_gc_claims k ON k.id=o.claim WHERE NOT EXISTS(SELECT 1 FROM sc_partitions p WHERE p.run=o.run);
        INSERT INTO sc_gc_selector_witness SELECT rs.key,rs.digest,MAX(rs.run) FROM sc_run_selectors rs JOIN sc_gc_published old ON old.run=rs.run
          WHERE NOT EXISTS(SELECT 1 FROM sc_partitions p WHERE p.run=rs.run)
          AND NOT EXISTS(SELECT 1 FROM sc_run_selectors current JOIN sc_partitions p ON p.run=current.run WHERE current.key=rs.key AND current.digest=rs.digest)
          GROUP BY rs.key,rs.digest;
        INSERT OR IGNORE INTO sc_gc_receipts SELECT witness.run,c.id FROM sc_gc_claims k JOIN sc_claims c ON c.id=k.id JOIN sc_supports s ON s.group_id=c.support_group
          JOIN sc_gc_selector_witness witness ON witness.key=s.selector AND witness.digest=s.expected;
        INSERT OR IGNORE INTO sc_gc_receipts SELECT witness.run,c.id FROM sc_gc_claims k JOIN sc_claims c ON c.id=k.id JOIN sc_supports s ON s.group_id=c.support_group
          JOIN sc_run_selectors rs ON rs.key=s.selector AND rs.digest=s.expected JOIN sc_partitions p ON p.run=rs.run JOIN sc_selector_gates g ON g.run=rs.run AND g.key=rs.key
          JOIN sc_gc_selector_witness witness ON witness.key=g.required_key AND witness.digest=g.expected;
        INSERT OR IGNORE INTO sc_gc_receipts SELECT witness.run,receipt.claim FROM sc_gc_receipts receipt JOIN sc_selector_gates g ON g.run=receipt.run
          JOIN sc_gc_selector_witness witness ON witness.key=g.required_key AND witness.digest=g.expected;
        INSERT OR IGNORE INTO sc_origin_runs
          SELECT json_array(r.partition_key,r.context,r.input_fingerprint,r.created_at,r.id,d.digest),r.partition_key,r.context,r.input_fingerprint,r.state,r.coverage_json,r.created_at,d.digest,
            COALESCE((SELECT json_group_array(json_object('resource',resource,'digest',digest)) FROM sc_inputs WHERE run=r.id),'[]'),
            COALESCE((SELECT json_group_array(json_object('key',rs.key,'digest',rs.digest,'requires',json(COALESCE((SELECT json_group_array(json_object('key',required_key,'digest',expected)) FROM sc_selector_gates WHERE run=rs.run AND key=rs.key),'[]')))) FROM sc_run_selectors rs WHERE rs.run=r.id),'[]')
          FROM sc_runs r LEFT JOIN sc_run_digests d ON d.run=r.id WHERE NOT EXISTS(SELECT 1 FROM sc_partitions p WHERE p.run=r.id)
            AND EXISTS(SELECT 1 FROM sc_gc_receipts receipt WHERE receipt.run=r.id);
        INSERT OR IGNORE INTO sc_claim_origins SELECT receipt.claim,origin.id FROM sc_gc_receipts receipt JOIN sc_runs r ON r.id=receipt.run LEFT JOIN sc_run_digests d ON d.run=r.id JOIN sc_origin_runs origin ON origin.id=json_array(r.partition_key,r.context,r.input_fingerprint,r.created_at,r.id,d.digest);
        DELETE FROM sc_claim_origins WHERE claim NOT IN(SELECT id FROM sc_gc_claims);
        DELETE FROM sc_origin_runs WHERE id NOT IN(SELECT origin FROM sc_claim_origins);
        DELETE FROM sc_projection_rows WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_run_selectors WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_inputs WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_diagnostics WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_owned WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_run_digests WHERE run NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_runs WHERE id NOT IN(SELECT run FROM sc_partitions);
        DELETE FROM sc_claim_navigation WHERE claim NOT IN(SELECT id FROM sc_gc_claims);
        DELETE FROM sc_supports WHERE group_id NOT IN(SELECT support_group FROM sc_claims WHERE support_group IS NOT NULL AND id IN(SELECT id FROM sc_gc_claims));
        DELETE FROM sc_claims WHERE id NOT IN(SELECT id FROM sc_gc_claims);
        DELETE FROM sc_groups WHERE id NOT IN(SELECT support_group FROM sc_claims WHERE support_group IS NOT NULL);
        DELETE FROM sc_facts WHERE id NOT IN(SELECT fact FROM sc_claims);
        DELETE FROM sc_provenance WHERE id NOT IN(SELECT provenance FROM sc_claims);
        INSERT OR IGNORE INTO sc_gc_entities SELECT subject FROM sc_facts UNION SELECT object FROM sc_facts WHERE object IS NOT NULL UNION SELECT occurrence FROM sc_facts WHERE occurrence IS NOT NULL;
        INSERT OR IGNORE INTO sc_gc_entities SELECT e.id FROM sc_facts f JOIN sc_entities e ON e.key=json_extract(f.value_json,'$.payloadEntity');
        INSERT OR IGNORE INTO sc_gc_entities SELECT subject FROM sc_legacy_navigation UNION SELECT object FROM sc_legacy_navigation WHERE object IS NOT NULL UNION SELECT occurrence FROM sc_legacy_navigation WHERE occurrence IS NOT NULL;
        INSERT OR IGNORE INTO sc_gc_entities SELECT caller FROM sc_call_epochs UNION SELECT callee FROM sc_call_epochs UNION SELECT caller FROM sc_legacy_calls UNION SELECT callee FROM sc_legacy_calls;
        INSERT OR IGNORE INTO sc_gc_entities SELECT entity FROM sc_legacy_visible_symbols;
        DELETE FROM sc_occurrences WHERE entity NOT IN(SELECT id FROM sc_gc_entities);
        DELETE FROM sc_sources WHERE id NOT IN(SELECT source FROM sc_occurrences);
        DELETE FROM sc_symbols WHERE entity NOT IN(SELECT id FROM sc_gc_entities);
        DELETE FROM sc_entities WHERE id NOT IN(SELECT id FROM sc_gc_entities)`);
      if ((store.db.pragma("foreign_key_check") as unknown[]).length) throw Error("Garbage collection violated reachability");
      const after = count(); return Object.fromEntries(tables.map(table => [table.slice(3), before[table]! - after[table]!]));
    } finally { store.db.exec("DROP TABLE sc_gc_selector_witness; DROP TABLE sc_gc_receipts; DROP TABLE sc_gc_published; DROP TABLE sc_gc_entities; DROP TABLE sc_gc_claims; DROP TABLE sc_gc_snapshots"); }
  })();
}
