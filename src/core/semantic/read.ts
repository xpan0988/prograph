import type Database from "better-sqlite3";

export interface ClaimNavigation { claim: number; relation: string; subject: number; object: number | null; occurrence: number | null; confidence: string; context?: string; first?: number | null; last?: number | null }
/** Scan indexed immutable candidates before visibility filtering. Historical tombstones consume work.
 * Do not hide that work inside a view WHERE with an output-only LIMIT.
 */
export class SemanticRead {
  private visited = 0;
  private readonly started = performance.now();
  readonly epochs: boolean;
  constructor(private readonly db: Database.Database, readonly snapshot: number) {
    this.epochs = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_epoch_snapshots'").get()
      && !!db.prepare("SELECT 1 FROM sc_epoch_snapshots WHERE id=?").get(snapshot);
  }
  get candidateRows(): number { return this.visited; }
  private charge(): void {
    if (++this.visited > 10000 || performance.now() - this.started > 1000) throw Object.assign(Error("Semantic candidate/deadline budget exceeded; narrow the query or compact retained history"), { code: "QUERY_BUDGET_EXCEEDED" });
  }
  visible(claim: number): boolean {
    this.charge();
    if (!this.epochs) return !!this.db.prepare("SELECT 1 FROM sc_active WHERE snapshot=? AND claim=?").get(this.snapshot, claim);
    const row = this.db.prepare("SELECT last FROM sc_visibility WHERE claim=? AND first<=? ORDER BY first DESC LIMIT 1").get(claim, this.snapshot) as { last: number | null } | undefined;
    return !!row && (row.last === null || row.last > this.snapshot);
  }
  navigation(where: string, parameters: unknown[], order: string, limit: number): ClaimNavigation[] {
    const result: ClaimNavigation[] = [];
    const table = this.epochs ? "sc_claim_navigation" : "sc_navigation";
    const query = this.db.prepare(`SELECT n.* FROM ${table} n WHERE ${this.epochs ? "" : "n.snapshot=? AND "}${where} ORDER BY ${order}`);
    for (const raw of query.iterate(...(this.epochs ? [] : [this.snapshot]), ...parameters) as Iterable<ClaimNavigation>) {
      this.charge(); if (this.epochs && !this.visible(raw.claim)) continue;
      result.push(raw); if (result.length >= limit) break;
    }
    return result;
  }
  symbols(name: string, after: number, limit: number): Array<{ entity: number; evidence: ClaimNavigation }> {
    const result: Array<{ entity: number; evidence: ClaimNavigation }> = [];
    const table = this.epochs ? "sc_symbols" : "sc_visible_symbols";
    for (const row of this.db.prepare(`SELECT entity FROM ${table} WHERE ${this.epochs ? "" : "snapshot=? AND "}name=? AND entity>? ORDER BY entity`).iterate(...(this.epochs ? [] : [this.snapshot]), name, after) as Iterable<{ entity: number }>) {
      this.charge(); const evidence = this.navigation("n.relation='declaration' AND n.subject=?", [row.entity], "n.occurrence,n.claim", 1)[0];
      if (evidence) result.push({ entity: row.entity, evidence }); if (result.length >= limit) break;
    }
    return result;
  }
  calls(direction: "caller" | "callee", target: number, after: number, limit: number): Array<{ caller: number; callee: number; site_count: number; confidence: string; sample_claim: number }> {
    const other = direction === "caller" ? "callee" : "caller";
    const result: ReturnType<SemanticRead["calls"]> = [];
    const table = this.epochs ? "sc_call_epochs" : "sc_calls";
    for (const raw of this.db.prepare(`SELECT * FROM ${table} WHERE ${this.epochs ? "" : "snapshot=? AND "}${direction}=? AND ${other}>? ORDER BY ${other}${this.epochs ? ",first DESC" : ""}`).iterate(...(this.epochs ? [] : [this.snapshot]), target, after) as Iterable<ReturnType<SemanticRead["calls"]>[number] & { first: number; last: number | null }>) {
      this.charge(); if (this.epochs && (raw.first > this.snapshot || raw.last !== null && raw.last <= this.snapshot)) continue;
      result.push(raw); if (result.length >= limit) break;
    }
    return result;
  }
}
