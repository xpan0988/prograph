import Database from "better-sqlite3";
import { writeSnapshotReport, type SnapshotReportInput } from "./snapshot-report.js";
import { createHash } from "node:crypto";
import { SEMANTIC_SQL } from "./schema.js";
import { collectSemanticGarbage, type GarbageCollectionOptions } from "./gc.js";
import { publishProjections } from "./publication.js";
import type { ProviderRegistration } from "./provider-plan.js";
import path from "node:path";
import { realpathSync } from "node:fs";
import { IndexLease } from "./maintenance-lock.js";
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
  private lease: IndexLease | undefined;
  private readonly ownsLease: boolean;
  private sourceRoot: string | undefined;
  private sourceRootAlias: string | undefined;
  constructor(readonly filename: string, readonly hooks: PublicationHooks = {}, borrowedLease?: IndexLease) {
    this.lease = borrowedLease ?? (filename === ":memory:" ? undefined : new IndexLease(path.dirname(filename), "work")); this.ownsLease = !borrowedLease;
    if (this.lease && (!this.lease.active || this.lease.directory !== realpathSync(path.dirname(filename)))) throw Error("Invalid borrowed index lease");
    let opened: Database.Database | undefined;
    try {
      this.db = new Database(filename); opened = this.db;
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get();
      if (exists) {
        const format = this.db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as { value: string } | undefined;
        const schema = this.db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as { value: string } | undefined;
        if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || !READABLE_SEMANTIC_SCHEMAS.includes(schema?.value as typeof READABLE_SEMANTIC_SCHEMAS[number])) throw new Error("Unsupported Semantic Core storage/schema version; preserve this database and rebuild separately");
      }
      this.db.pragma("journal_mode=WAL"); this.db.pragma("synchronous=FULL"); this.db.pragma("foreign_keys=ON");
      this.db.transaction(() => {
        for (const table of ["active", "navigation", "calls", "visible_symbols", "context_lookup"]) {
          if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(`sc_${table}`)) this.db.exec(`ALTER TABLE sc_${table} RENAME TO sc_legacy_${table}`);
        }
        this.db.exec(SEMANTIC_SQL);
        this.sql("INSERT OR IGNORE INTO sc_meta VALUES('format',?)").run(String(SEMANTIC_FORMAT_VERSION));
        this.sql("INSERT INTO sc_meta VALUES('schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SEMANTIC_SCHEMA_VERSION);
      })();
    } catch (error) { opened?.close(); if (this.ownsLease) this.lease?.close(); throw error; }
  }
  sql(query: string): Database.Statement {
    let statement = this.statements.get(query);
    if (!statement) { statement = this.db.prepare(query); this.statements.set(query, statement); }
    return statement;
  }
  close(): void { this.db.close(); if (this.ownsLease) this.lease?.close(); }
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
  /** Reuse only a complete immutable partition already admitted by retained history.
   * A producer must still verify its current source/artifact/environment before publishing it.
   */
  reusable(partition: string, context: string, inputFingerprint: string): { id: number; coverage: Record<string, unknown> } | undefined {
    const row = this.sql("SELECT r.id,r.coverage_json FROM sc_runs r WHERE r.partition_key=? AND r.context=? AND r.input_fingerprint=? AND r.state='sealed' AND EXISTS(SELECT 1 FROM sc_partitions p WHERE p.run=r.id) ORDER BY r.id DESC LIMIT 1").get(partition, context, inputFingerprint) as { id: number; coverage_json: string } | undefined;
    if (row && this.sourceRoot && this.sql("SELECT 1 FROM sc_inputs WHERE run=? AND resource LIKE 'source:%' LIMIT 1").get(row.id) && !this.hasSourceRoot(row.id)) return undefined;
    return row ? { id: row.id, coverage: JSON.parse(row.coverage_json) as Record<string, unknown> } : undefined;
  }
  bindSourceRoot(root: string, expected?: string): void {
    const alias = path.resolve(root), resolved = realpathSync(root); if (expected && resolved !== expected) throw Error("Source root changed since repository discovery"); if (this.sourceRoot && (this.sourceRoot !== resolved || this.sourceRootAlias !== alias)) throw Error("One store operation cannot change its source root"); this.sourceRoot = resolved; this.sourceRootAlias = alias;
  }
  sourceBindingFingerprint(): string {
    if (!this.sourceRoot || !this.sourceRootAlias) throw Error("Source root must be bound before fingerprinting source observations");
    return createHash("sha256").update(canonical(["source-binding-1", this.sourceRootAlias, this.sourceRoot])).digest("hex");
  }
  hasSourceRoot(run: number): boolean {
    if (!this.sourceRoot) return false; const hash = createHash("sha256").update(this.sourceRoot).digest("hex");
    return !!this.sql("SELECT 1 FROM sc_inputs WHERE run=? AND resource=? AND digest=?").get(run, `source-root:${this.sourceRoot}`, hash) && !!this.sql("SELECT 1 FROM sc_inputs WHERE run=? AND resource=? AND digest=?").get(run, `probe-realpath:${this.sourceRootAlias}`, hash);
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
    if (resource.startsWith("source:") && this.sourceRoot) {
      const hash = createHash("sha256").update(this.sourceRoot).digest("hex"), probe = `probe-realpath:${this.sourceRootAlias}`;
      const observed = this.sql("SELECT digest FROM sc_inputs WHERE run=? AND resource=?").get(run, probe) as { digest: string } | undefined;
      if (observed && observed.digest !== hash) throw Error("Source root changed during compiler observation");
      this.sql("INSERT OR IGNORE INTO sc_inputs VALUES(?,?,?)").run(run, `source-root:${this.sourceRoot}`, hash);
      this.sql("INSERT OR IGNORE INTO sc_inputs VALUES(?,?,?)").run(run, probe, hash);
    }
  }
  selector(run: number, key: string, hash: string, requires: Array<{ key: string; digest: string }> = []): void {
    this.requireStaging(run);
    if (requires.length > 32 || new Set(requires.map(input => input.key)).size !== requires.length || requires.some(input => !input.key || !input.digest || input.key === key)) throw Error("Invalid selector admission requirements");
    this.db.transaction(() => {
      this.sql("INSERT INTO sc_run_selectors VALUES(?,?,?) ON CONFLICT(run,key) DO UPDATE SET digest=excluded.digest").run(run, key, hash);
      this.sql("DELETE FROM sc_selector_gates WHERE run=? AND key=?").run(run, key);
      for (const input of requires) this.sql("INSERT INTO sc_selector_gates VALUES(?,?,?,?)").run(run, key, input.key, input.digest);
    })();
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
    if (fact.predicate.startsWith("boundary.")) {
      ensureKind(subject, fact.predicate === "boundary.Operation" ? "artifact" : "symbol");
      if (object) ensureKind(object, fact.predicate === "boundary.Path" ? "symbol" : "artifact");
      if (object && fact.predicate !== "boundary.Path") {
        const identity = JSON.parse((this.sql("SELECT canonical FROM sc_entities WHERE id=?").get(object) as { canonical: string }).canonical) as Record<string, unknown>;
        if (!["protocol", "namespace", "operation"].every(field => typeof identity[field] === "string" && identity[field])) throw Error("Expected boundary operation endpoint");
      }
      if (occurrence) {
        ensureKind(occurrence, "occurrence");
        const evidence = this.sql("SELECT context,role FROM sc_occurrences WHERE entity=?").get(occurrence) as { context: string; role: string };
        if (evidence.context !== fact.context || evidence.role !== "call") throw Error("Expected call occurrence in boundary context");
      }
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
    for (const gate of this.sql("SELECT key,required_key,expected FROM sc_selector_gates WHERE run=? ORDER BY key,required_key").iterate(run)) content.update(canonical(["selector-admission", gate]));
    for (const input of this.sql("SELECT resource,digest FROM sc_inputs WHERE run=? ORDER BY resource").iterate(run)) content.update(canonical(input));
    for (const row of this.sql("SELECT resource FROM sc_observed_inputs WHERE run=? ORDER BY resource").iterate(run)) content.update(canonical(["observed-input", (row as { resource: string }).resource]));
    const result = content.digest("hex");
    this.sql("INSERT INTO sc_run_digests VALUES(?,?)").run(run, result);
    return result;
  }
  publish(runs: number[], expectedParent?: number, registrations: ProviderRegistration[] = [], report?: SnapshotReportInput): number {
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
      // Admission qualifiers may depend only on unconditional input selectors.
      // This keeps effective selector comparison independent of derived eligibility,
      // avoiding cyclic gates and invalidating only actually changed environments.
      if (this.sql(`SELECT 1 FROM sc_selector_gates g JOIN sc_partitions p ON p.run=g.run WHERE p.snapshot=? AND EXISTS(
        SELECT 1 FROM sc_selector_gates nested INDEXED BY sc_selector_gate_key JOIN sc_partitions owner ON owner.run=nested.run WHERE nested.key=g.required_key AND owner.snapshot=p.snapshot) LIMIT 1`).get(id)) throw Error("Selector admission requires unconditional input selectors");
      publishProjections(this, id, parent, measure);
      for (const registration of registrations) {
        if (!["managed", "rust", "clang"].includes(registration.kind) || !/^[A-Za-z0-9._-]{1,256}$/.test(registration.key) || !/^[a-f0-9]{64}$/.test(registration.trust) || !/^[a-f0-9]{64}$/.test(registration.authorization) || !registration.version || canonical(registration.recipe).length > 32768) throw Error("Invalid provider execution registration");
        if (!this.sql("SELECT 1 FROM sc_provider_recipes WHERE key=?").get(registration.key) && (this.sql("SELECT COUNT(*) AS n FROM sc_provider_recipes").get() as { n: number }).n >= 256) throw Error("Provider registration catalogue exceeds 256 entries");
        this.sql("INSERT INTO sc_provider_recipes VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,recipe_json=excluded.recipe_json,trust=excluded.trust,version=excluded.version,authorization=excluded.authorization,updated_at=excluded.updated_at")
          .run(registration.key, registration.kind, canonical(registration.recipe), registration.trust, registration.version, registration.authorization, new Date().toISOString());
      }
      if (report) { writeSnapshotReport(this, id, key, report); measure("snapshot-report"); }
      this.sql("INSERT INTO sc_meta VALUES('active',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
      return id;
    })();
    measure("pointer-and-commit");
    this.hooks.fault?.("after-publish");
    return snapshot;
  }
  pinSnapshot(snapshot: number, label = "user"): void {
    if (!Number.isSafeInteger(snapshot) || !this.sql("SELECT 1 FROM sc_snapshots WHERE id=?").get(snapshot) || !label || label.length > 256) throw Error("Invalid snapshot pin");
    this.sql("INSERT OR IGNORE INTO sc_snapshot_pins VALUES(?,?)").run(snapshot, label);
  }
  unpinSnapshot(snapshot: number, label = "user"): void { this.sql("DELETE FROM sc_snapshot_pins WHERE snapshot=? AND label=?").run(snapshot, label); }
  collectGarbage(options: GarbageCollectionOptions = {}): Record<string, number> {
    if (this.db.inTransaction) throw Error("Garbage collection cannot run inside a staging transaction");
    if (!this.lease || this.lease.mode === "maintenance") {
      try { return collectSemanticGarbage(this, options); } finally { this.entityCache.clear(); }
    }
    if (!this.ownsLease) throw Error("Garbage collection cannot run inside an indexing job");
    this.lease.close(); let maintenance: IndexLease | undefined;
    try {
      maintenance = new IndexLease(path.dirname(this.filename), "maintenance");
      return collectSemanticGarbage(this, options);
    } finally {
      maintenance?.close(); this.entityCache.clear();
      try { this.lease = new IndexLease(path.dirname(this.filename), "work"); }
      catch (error) { this.db.close(); throw error; }
    }
  }
  pruneHistory(keep = 3): void { this.collectGarbage({ keep }); }
}
