import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { SEMANTIC_SQL } from "./schema.js";
import { canonical, semanticKey, PREDICATES, SEMANTIC_FORMAT_VERSION, SEMANTIC_SCHEMA_VERSION, READABLE_SEMANTIC_SCHEMAS, validateFact,
  type EntityKind, type FactInput, type OccurrenceInput, type SemanticSymbol, type SupportAlternative } from "./model.js";

export interface PublicationHooks {
  fault?: (point: "before-seal" | "before-publish" | "during-publish" | "after-publish") => void;
  measure?: (stage: string, durationMs: number) => void;
}
export class SemanticStore {
  readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly entityCache = new Map<string, number>();
  constructor(readonly filename: string, readonly hooks: PublicationHooks = {}) {
    this.db = new Database(filename);
    try {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get();
      if (exists) {
        const format = this.db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as { value: string } | undefined;
        const schema = this.db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as { value: string } | undefined;
        if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || !READABLE_SEMANTIC_SCHEMAS.includes(schema?.value as typeof READABLE_SEMANTIC_SCHEMAS[number])) throw new Error("Unsupported Semantic Core storage/schema version; preserve this database and rebuild separately");
      }
      this.db.exec(SEMANTIC_SQL);
      this.sql("INSERT OR IGNORE INTO sc_meta VALUES('format',?)").run(String(SEMANTIC_FORMAT_VERSION));
      this.sql("INSERT INTO sc_meta VALUES('schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SEMANTIC_SCHEMA_VERSION);
    } catch (error) { this.db.close(); throw error; }
  }
  sql(query: string): Database.Statement {
    let statement = this.statements.get(query);
    if (!statement) { statement = this.db.prepare(query); this.statements.set(query, statement); }
    return statement;
  }
  close(): void { this.db.close(); }
  activeSnapshot(): number | undefined {
    const row = this.sql("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string } | undefined;
    return row ? Number(row.value) : undefined;
  }
  entity(key: string): number {
    let id = this.entityCache.get(key);
    if (id === undefined) {
      const row = this.sql("SELECT id FROM sc_entities WHERE key=?").get(key) as { id: number } | undefined;
      if (!row) throw new Error(`Unknown entity: ${key}`);
      id = row.id;
      if (this.entityCache.size >= 4096) this.entityCache.clear();
      this.entityCache.set(key, id);
    }
    return id;
  }
  addEntity(key: string, kind: EntityKind, identity: unknown): number {
    const serialized = canonical(identity);
    const inserted = this.sql("INSERT OR IGNORE INTO sc_entities(key,kind,canonical) VALUES(?,?,?)").run(key, kind, serialized);
    const row = this.sql("SELECT id,kind,canonical FROM sc_entities WHERE key=?").get(key) as { id: number; kind: string; canonical: string };
    if (!inserted.changes && (row.kind !== kind || row.canonical !== serialized)) throw new Error(`Entity collision: ${key}`);
    if (this.entityCache.size >= 4096) this.entityCache.clear();
    this.entityCache.set(key, row.id);
    return row.id;
  }
  addSymbol(symbol: SemanticSymbol): number {
    const id = this.addEntity(symbol.key, "symbol", symbol);
    this.sql("INSERT OR IGNORE INTO sc_symbols VALUES(?,?,?,?,?,?)").run(id, symbol.name, symbol.qualifiedName, symbol.kind, symbol.file, symbol.context);
    return id;
  }
  addOccurrence(occurrence: OccurrenceInput, sourceSize: number): number {
    for (const value of [occurrence.startByte, occurrence.endByte, occurrence.line, occurrence.column, occurrence.endLine, occurrence.endColumn, sourceSize]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid occurrence coordinate");
    }
    if (occurrence.endByte < occurrence.startByte || occurrence.endByte > sourceSize || occurrence.line < 1 || occurrence.column < 1 || occurrence.endLine < occurrence.line || occurrence.endColumn < 1) throw new Error("Occurrence range outside source");
    this.sql("INSERT OR IGNORE INTO sc_sources(path,digest,size) VALUES(?,?,?)").run(occurrence.file, occurrence.sourceDigest, sourceSize);
    const source = this.sql("SELECT id,size FROM sc_sources WHERE path=? AND digest=?").get(occurrence.file, occurrence.sourceDigest) as { id: number; size: number };
    if (source.size !== sourceSize) throw new Error("Source digest/size collision");
    const entity = this.addEntity(occurrence.key, "occurrence", occurrence);
    this.sql("INSERT OR IGNORE INTO sc_occurrences VALUES(?,?,?,?,?,?,?,?,?,?)").run(entity, source.id, occurrence.context, occurrence.startByte, occurrence.endByte, occurrence.line, occurrence.column, occurrence.endLine, occurrence.endColumn, occurrence.role);
    return entity;
  }
  begin(partition: string, context: string, inputFingerprint: string): number {
    if (!partition || !context || !inputFingerprint) throw new Error("Incomplete indexing unit");
    return Number(this.sql("INSERT INTO sc_runs(partition_key,context,input_fingerprint,state,created_at) VALUES(?,?,?,'staging',?)").run(partition, context, inputFingerprint, new Date().toISOString()).lastInsertRowid);
  }
  private requireStaging(run: number): { context: string; input_fingerprint: string } {
    const row = this.sql("SELECT context,input_fingerprint,state FROM sc_runs WHERE id=?").get(run) as { context: string; input_fingerprint: string; state: string } | undefined;
    if (row?.state !== "staging") throw new Error("Run is not staging");
    return row;
  }
  batch<T>(run: number, operation: () => T): T {
    try { return this.db.transaction(() => { this.requireStaging(run); return operation(); })(); }
    catch (error) { this.entityCache.clear(); throw error; }
  }
  input(run: number, resource: string, hash: string): void {
    this.requireStaging(run);
    this.sql("INSERT INTO sc_inputs VALUES(?,?,?) ON CONFLICT(run,resource) DO UPDATE SET digest=excluded.digest").run(run, resource, hash);
  }
  selector(run: number, key: string, hash: string): void {
    this.requireStaging(run);
    this.sql("INSERT INTO sc_run_selectors VALUES(?,?,?) ON CONFLICT(run,key) DO UPDATE SET digest=excluded.digest").run(run, key, hash);
  }
  private support(alternatives: SupportAlternative[]): number {
    // OR of interned, deduplicated AND alternatives. Atom order has no meaning.
    const normalized = [...new Map(alternatives.map(a => {
      const atoms = [...new Map(a.map(x => [canonical(x), x])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
      return [canonical(atoms), atoms] as const;
    })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const key = semanticKey("support", normalized);
    const inserted = this.sql("INSERT OR IGNORE INTO sc_groups(key) VALUES(?)").run(key);
    const { id } = this.sql("SELECT id FROM sc_groups WHERE key=?").get(key) as { id: number };
    if (inserted.changes) normalized.forEach((alternative, index) => alternative.forEach((atom, position) => {
      const claim = "claim" in atom ? (this.sql("SELECT id FROM sc_claims WHERE key=?").get(atom.claim) as { id: number } | undefined)?.id : null;
      if ("claim" in atom && !claim) throw new Error("Support references an unknown claim");
      this.sql("INSERT INTO sc_supports VALUES(?,?,?,?,?,?)").run(id, index, position, claim, "selector" in atom ? atom.selector : null, "digest" in atom ? atom.digest : null);
    }));
    return id;
  }
  addFact(run: number, fact: FactInput): string {
    if (!this.db.inTransaction) throw new Error("Fact writes require an atomic bounded batch");
    validateFact(fact);
    const unit = this.requireStaging(run);
    if (unit.context !== fact.context || unit.input_fingerprint !== fact.provenance.inputFingerprint) throw new Error("Fact does not match indexing unit inputs");
    const subject = this.entity(fact.subject); const object = fact.object ? this.entity(fact.object) : null;
    const occurrence = fact.occurrence ? this.entity(fact.occurrence) : null;
    const ensureKind = (id: number, kind: EntityKind) => {
      const row = this.sql("SELECT kind FROM sc_entities WHERE id=?").get(id) as { kind: string };
      if (row.kind !== kind) throw new Error(`Expected ${kind} endpoint`);
    };
    if (fact.predicate.startsWith("common.")) {
      ensureKind(subject, "symbol");
      if (object) ensureKind(object, "symbol");
      if (occurrence) ensureKind(occurrence, "occurrence");
      if (occurrence && (this.sql("SELECT context FROM sc_occurrences WHERE entity=?").get(occurrence) as { context: string }).context !== fact.context) throw new Error("Occurrence context mismatch");
    }
    const value = canonical(fact.value ?? {});
    const logical = semanticKey("logical", [fact.predicate, PREDICATES[fact.predicate].version, fact.context, fact.subject, fact.occurrence ?? null]);
    const key = semanticKey("fact", [logical, fact.object ?? null, value]);
    this.sql("INSERT OR IGNORE INTO sc_facts(key,logical_key,predicate,context,subject,object,occurrence,value_json) VALUES(?,?,?,?,?,?,?,?)").run(key, logical, fact.predicate, fact.context, subject, object, occurrence, value);
    const f = this.sql("SELECT id FROM sc_facts WHERE key=?").get(key) as { id: number };
    const provenanceJson = canonical(fact.provenance); const provenanceKey = semanticKey("provenance", fact.provenance);
    this.sql("INSERT OR IGNORE INTO sc_provenance(key,json) VALUES(?,?)").run(provenanceKey, provenanceJson);
    const p = this.sql("SELECT id FROM sc_provenance WHERE key=?").get(provenanceKey) as { id: number };
    const group = fact.supports ? this.support(fact.supports) : null;
    const groupKey = group ? (this.sql("SELECT key FROM sc_groups WHERE id=?").get(group) as { key: string }).key : null;
    const claimKey = semanticKey("claim", [key, provenanceKey, fact.confidence, groupKey]);
    this.sql("INSERT OR IGNORE INTO sc_claims(key,fact,provenance,confidence,support_group) VALUES(?,?,?,?,?)").run(claimKey, f.id, p.id, fact.confidence, group);
    const c = this.sql("SELECT id FROM sc_claims WHERE key=?").get(claimKey) as { id: number };
    this.sql("INSERT OR IGNORE INTO sc_owned VALUES(?,?)").run(run, c.id);
    return claimKey;
  }
  diagnostic(run: number, code: string, message: string): void {
    this.requireStaging(run);
    const { n } = this.sql("SELECT COUNT(*) AS n FROM sc_diagnostics WHERE run=?").get(run) as { n: number };
    if (n < 200) this.sql("INSERT INTO sc_diagnostics VALUES(?,?,?,?)").run(run, n, code, message.slice(0, 2048));
  }
  seal(run: number, coverage: Record<string, unknown>): void {
    this.requireStaging(run); this.hooks.fault?.("before-seal");
    const json = canonical(coverage);
    if (Buffer.byteLength(json) > 4096) throw new Error("Coverage exceeds 4 KiB");
    this.db.transaction(() => {
      this.requireStaging(run);
      this.sql("UPDATE sc_runs SET state='sealed',coverage_json=? WHERE id=?").run(json, run);
      this.runDigest(run);
    })();
  }
  private runDigest(run: number): string {
    const existing = this.sql("SELECT digest FROM sc_run_digests WHERE run=?").get(run) as { digest: string } | undefined;
    if (existing) return existing.digest;
    const row = this.sql("SELECT partition_key,context,input_fingerprint,coverage_json,state FROM sc_runs WHERE id=?").get(run) as Record<string, string> | undefined;
    if (row?.state !== "sealed") throw new Error("Digest requires sealed run");
    const content = createHash("sha256");
    content.update(canonical(row));
    for (const claim of this.sql("SELECT c.key FROM sc_owned o JOIN sc_claims c ON c.id=o.claim WHERE o.run=? ORDER BY c.key").iterate(run) as Iterable<{ key: string }>) content.update(claim.key);
    for (const selector of this.sql("SELECT key,digest FROM sc_run_selectors WHERE run=? ORDER BY key").iterate(run)) content.update(canonical(selector));
    for (const input of this.sql("SELECT resource,digest FROM sc_inputs WHERE run=? ORDER BY resource").iterate(run)) content.update(canonical(input));
    const result = content.digest("hex");
    this.sql("INSERT INTO sc_run_digests VALUES(?,?)").run(run, result);
    return result;
  }
  publish(runs: number[], expectedParent?: number): number {
    // An explicit undefined is a first-publication CAS, not permission to rebase a stale plan.
    const parent = arguments.length < 2 ? this.activeSnapshot() : expectedParent;
    this.hooks.fault?.("before-publish");
    let measuredAt = performance.now();
    const measure = (stage: string) => { const now = performance.now(); this.hooks.measure?.(stage, now - measuredAt); measuredAt = now; };
    const snapshot = this.db.transaction(() => {
      if (this.activeSnapshot() !== parent) throw new Error("Snapshot publication parent changed");
      const selected = runs.map(id => {
        const row = this.sql("SELECT * FROM sc_runs WHERE id=?").get(id) as { id: number; state: string; partition_key: string; context: string; input_fingerprint: string } | undefined;
        if (row?.state !== "sealed") throw new Error("Cannot publish unsealed partition");
        return row;
      });
      if (new Set(selected.map(r => r.partition_key)).size !== selected.length) throw new Error("Duplicate selected partition");
      const content = createHash("sha256");
      for (const run of [...selected].sort((a, b) => a.partition_key < b.partition_key ? -1 : 1)) {
        content.update(canonical([run.partition_key, this.runDigest(run.id)]));
      }
      const key = `sc2:snapshot-v2:${content.digest("hex")}`;
      measure("content-key");
      const id = Number(this.sql("INSERT INTO sc_snapshots(parent,key,created_at) VALUES(?,?,?)").run(parent ?? null, key, new Date().toISOString()).lastInsertRowid);
      for (const run of selected) this.sql("INSERT INTO sc_partitions VALUES(?,?,?)").run(id, run.partition_key, run.id);
      const conflicts = this.sql(`SELECT rs.key FROM sc_run_selectors rs JOIN sc_partitions p ON p.run=rs.run WHERE p.snapshot=? GROUP BY rs.key HAVING COUNT(DISTINCT rs.digest)>1 LIMIT 1`).get(id);
      if (conflicts) throw new Error("Conflicting selector environments");
      this.sql("INSERT OR IGNORE INTO sc_active SELECT ?,o.claim FROM sc_owned o JOIN sc_partitions p ON p.run=o.run WHERE p.snapshot=?").run(id, id);
      measure("membership");
      // Removing a supporting claim invalidates an AND; another valid OR alternative survives.
      const prune = this.sql(`DELETE FROM sc_active WHERE snapshot=? AND claim IN (
        SELECT c.id FROM sc_claims c INDEXED BY sc_claim_supported CROSS JOIN sc_active a ON a.claim=c.id AND a.snapshot=? WHERE c.support_group IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM sc_supports s WHERE s.group_id=c.support_group GROUP BY s.alternative HAVING SUM(
          CASE WHEN s.input_claim IS NOT NULL THEN CASE WHEN EXISTS(SELECT 1 FROM sc_active x WHERE x.snapshot=? AND x.claim=s.input_claim) THEN 0 ELSE 1 END
          ELSE CASE WHEN EXISTS(SELECT 1 FROM sc_run_selectors rs JOIN sc_partitions p ON p.run=rs.run WHERE p.snapshot=? AND rs.key=s.selector AND rs.digest=s.expected) THEN 0 ELSE 1 END END)=0))`);
      let changed = true; let rounds = 0;
      while (changed) { changed = !!prune.run(id, id, id, id).changes; if (++rounds > 64 && changed) throw new Error("Support depth exceeds foundation limit"); }
      measure("support-eligibility");
      this.hooks.fault?.("during-publish");
      const relation = Object.entries(PREDICATES).map(([predicate, descriptor]) => `WHEN '${predicate}' THEN '${descriptor.relation}'`).join(" ");
      this.sql(`INSERT INTO sc_navigation SELECT ?,CASE f.predicate ${relation} END,f.subject,f.object,f.occurrence,c.id,c.confidence FROM sc_active a JOIN sc_claims c ON c.id=a.claim JOIN sc_facts f ON f.id=c.fact WHERE a.snapshot=?`).run(id, id);
      measure("navigation");
      this.sql(`INSERT INTO sc_visible_symbols SELECT DISTINCT ?,s.entity,s.name FROM sc_symbols s JOIN sc_navigation n ON n.subject=s.entity WHERE n.snapshot=? AND n.relation='declaration'`).run(id, id);
      this.sql(`INSERT INTO sc_context_lookup SELECT ?,n.claim,f.context FROM sc_navigation n JOIN sc_claims c ON c.id=n.claim JOIN sc_facts f ON f.id=c.fact WHERE n.snapshot=? AND n.relation='project-context'`).run(id, id);
      measure("symbols");
      // Unique static binding conflicts are excluded; unresolved observations stay inspectable.
      this.sql(`INSERT INTO sc_calls SELECT ?,n.subject,n.object,COUNT(DISTINCT n.occurrence),CASE WHEN MIN(CASE n.confidence WHEN 'exact' THEN 0 ELSE 1 END)=0 THEN 'exact' ELSE 'resolved' END,MIN(n.claim)
        FROM sc_navigation n WHERE n.snapshot=? AND n.relation='calls' AND n.confidence IN ('exact','resolved')
        AND NOT EXISTS(SELECT 1 FROM sc_navigation t JOIN sc_navigation other ON other.snapshot=t.snapshot AND other.relation='calltarget' AND other.occurrence=t.occurrence AND other.object<>t.object AND other.confidence IN ('exact','resolved')
          WHERE t.snapshot=n.snapshot AND t.relation='calltarget' AND t.occurrence=n.occurrence AND t.object=n.object AND t.confidence IN ('exact','resolved')) GROUP BY n.subject,n.object`).run(id, id);
      measure("call-summary");
      this.sql("INSERT INTO sc_meta VALUES('active',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
      return id;
    })();
    measure("pointer-and-commit");
    this.hooks.fault?.("after-publish");
    return snapshot;
  }
  /** Explicit maintenance keeps published history; abandoned staging never becomes active. */
  pruneHistory(keep = 3): void {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("Retention must keep at least one snapshot");
    this.db.transaction(() => {
      this.db.exec("UPDATE sc_snapshots SET parent=NULL");
      this.sql("DELETE FROM sc_snapshots WHERE id NOT IN(SELECT id FROM sc_snapshots ORDER BY id DESC LIMIT ?)").run(keep);
      this.db.exec("DELETE FROM sc_run_selectors WHERE run NOT IN(SELECT run FROM sc_partitions); DELETE FROM sc_inputs WHERE run NOT IN(SELECT run FROM sc_partitions); DELETE FROM sc_diagnostics WHERE run NOT IN(SELECT run FROM sc_partitions); DELETE FROM sc_owned WHERE run NOT IN(SELECT run FROM sc_partitions); DELETE FROM sc_run_digests WHERE run NOT IN(SELECT run FROM sc_partitions); DELETE FROM sc_runs WHERE id NOT IN(SELECT run FROM sc_partitions)");
    })();
    // Fact/claim/entity GC is deliberately not attempted until shared-support reachability is qualified.
  }
}
