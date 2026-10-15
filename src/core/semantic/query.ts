import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveRepositoryRoot } from "../repository/repository.js";
import { canonical, digest, SEMANTIC_FORMAT_VERSION, READABLE_SEMANTIC_SCHEMAS } from "./model.js";
import { SemanticRead } from "./read.js";

export const SEMANTIC_OPERATIONS = ["status", "find", "definition", "references", "callers", "callees", "occurrence", "explain", "context", "native", "relationships", "boundaries", "boundary-participants"] as const;
export type SemanticOperation = typeof SEMANTIC_OPERATIONS[number];
export interface SemanticQueryOptions { limit?: number; cursor?: string; snapshot?: number; maxBytes?: number }
interface Cursor { snapshot: number; query: string; after: number }
interface NavigationRow { occurrence: number; claim_id: number; confidence: string; key: string; path: string; digest: string; start_byte: number; end_byte: number; line: number; column_num: number; end_line: number; end_column: number; role: string; provenance_json: string; claim_key: string; symbol_key: string; name: string; qualified_name: string }

export class SemanticQuery {
  readonly db: Database.Database;
  private readonly schema: string;
  private readonly hasContexts: boolean;
  constructor(filename: string, private readonly manifestPath?: string) {
    this.db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const format = this.db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as { value: string } | undefined;
      const schema = this.db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as { value: string } | undefined;
      if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || !READABLE_SEMANTIC_SCHEMAS.includes(schema?.value as typeof READABLE_SEMANTIC_SCHEMAS[number])) throw new Error("Unsupported semantic index format/schema");
      this.schema = schema!.value;
      this.hasContexts = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='sc_context_lookup'").get();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  execute(operation: SemanticOperation, input = "", options: SemanticQueryOptions = {}): Record<string, unknown> {
    if (!(SEMANTIC_OPERATIONS as readonly string[]).includes(operation)) throw new Error("Unknown semantic operation");
    if (input.length > 1024) throw new Error("Semantic input exceeds 1024 characters");
    const limit = Math.max(1, Math.min(200, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 50));
    const maxBytes = Math.max(4096, Math.min(131072, Number.isFinite(options.maxBytes) ? Math.floor(options.maxBytes!) : 32768));
    const fingerprint = digest(canonical([operation, input]));
    let cursor: Cursor | undefined;
    if (options.cursor) {
      if (options.cursor.length > 1024) throw new Error("Invalid cursor");
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Cursor; } catch { throw new Error("Invalid cursor"); }
      if (cursor.query !== fingerprint || !Number.isSafeInteger(cursor.after) || cursor.after < 0 || !Number.isSafeInteger(cursor.snapshot) || (options.snapshot !== undefined && cursor.snapshot !== options.snapshot)) throw new Error("Cursor does not match query/snapshot");
    }
    // Pin a coherent snapshot for all membership/evidence lookups on this connection.
    return this.db.transaction(() => {
      const active = this.db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string } | undefined;
      const snapshot = cursor?.snapshot ?? options.snapshot ?? Number(active?.value);
      if (!Number.isSafeInteger(snapshot) || !this.db.prepare("SELECT 1 FROM sc_snapshots WHERE id=?").get(snapshot)) throw new Error("Semantic snapshot unavailable or expired; run analyze/sync or restart pagination");
      const partitions = this.db.prepare("SELECT r.id,r.partition_key,r.context,r.coverage_json,r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? ORDER BY r.id LIMIT 9").all(snapshot) as Array<{ id: number; partition_key: string; context: string; coverage_json: string; input_fingerprint: string }>;
      const relevant = partitions.filter(p => p.partition_key !== "legacy/full");
      const coverage: Array<Record<string, unknown>> = [];
      let coverageBytes = 0; let coverageTruncated = partitions.length > 8;
      for (const partition of relevant.slice(0, 8)) {
        const detail = JSON.parse(partition.coverage_json) as Record<string, unknown>;
        const summary = { partition: partition.partition_key, status: detail.status ?? "partial", language: detail.language ?? null, provider: detail.provider ?? null,
          definitions: detail.definitions ?? null, references: detail.references ?? null, calls: detail.calls ?? null,
          gaps: Array.isArray(detail.gaps) ? detail.gaps.slice(0, 3).map(g => String(g).slice(0, 180)) : [] };
        coverageBytes += Buffer.byteLength(JSON.stringify(summary));
        if (coverageBytes > maxBytes / 2) { coverageTruncated = true; break; }
        coverage.push(summary);
      }
      const gaps = [...new Set(coverage.flatMap(c => Array.isArray(c.gaps) ? c.gaps.map(String) : []))];
      if (coverageTruncated) gaps.push("Coverage summary truncated");
      let latestAttempt: unknown = null;
      if (this.manifestPath) { try {
        if (statSync(this.manifestPath).size <= 1048576) {
          const attempt = (JSON.parse(readFileSync(this.manifestPath, "utf8")) as { semanticCore?: Record<string, unknown> }).semanticCore;
          latestAttempt = attempt ? { status: attempt.status, snapshot: attempt.snapshot ?? null, reason: attempt.reason ? String(attempt.reason).slice(0, 320) : null, matchesSnapshot: attempt.snapshot === snapshot } : { status: "not-recorded" };
        }
      } catch { latestAttempt = { status: "manifest-unavailable" }; } }
      if (operation === "context" && !this.hasContexts) gaps.push("Project contexts unavailable in this Step 1 index; analyze/sync upgrades the additive semantic schema");
      const variants = new Set(relevant.map(partition => partition.context));
      const base = { snapshot, activeSnapshot: Number(active?.value), format: SEMANTIC_FORMAT_VERSION, schema: this.schema, variant: !coverageTruncated && variants.size === 1 ? relevant[0]?.context ?? null : null, scope: "code", coverage, gaps,
        latestAttempt, semanticFreshness: "snapshot-only; source freshness unchecked", coverageTruncated,
        evidencePolicy: "sample claim per occurrence or relation; independent claims retained",
        columnEncoding: "utf-16", byteEncoding: "utf-8", truncated: false, limits: { maxItems: limit, maxBytes, maxCandidateRows: 10000, maxSupportRows: 201, maxMetadataRows: 9 }, work: { candidateRows: 0, supportRows: 0, metadataRows: partitions.length, returnedRows: 0, globalGraphMaterialized: false } };
      const after = cursor?.after ?? 0;
      const read = new SemanticRead(this.db, snapshot);
      let rows: Array<Record<string, unknown>> = [];
      let examined = 0;
      let supportRows = 0;
      let continuation = after;
      if (operation === "status") {
        const page = this.db.prepare("SELECT r.id,r.partition_key,r.context,r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.run>? ORDER BY p.run LIMIT ?").all(snapshot, after, limit + 1) as typeof partitions;
        rows = page.map(p => ({ page_key: p.id, partition: p.partition_key, context: p.context, inputFingerprint: p.input_fingerprint, legacy: p.partition_key === "legacy/full" })); examined = rows.length;
      } else if (operation === "boundaries" || operation === "boundary-participants") {
        const target = operation === "boundaries" ? undefined : this.db.prepare("SELECT id FROM sc_entities WHERE key=?").get(input) as { id: number } | undefined;
        const selected = operation === "boundaries"
          ? read.navigation("n.relation='boundary-operation' AND n.claim>?", [after], "n.claim", limit + 1)
          : target ? read.navigation("n.object=? AND n.relation IN ('boundary-invokes','boundary-implements','boundary-emits','boundary-listens','boundary-registers') AND n.claim>?", [target.id, after], "n.claim", limit + 1) : [];
        rows = selected.map(n => {
          const payload = this.db.prepare(`SELECT c.key AS evidenceClaim,f.value_json,p.json AS provenance,e.key AS operation,
            s.key AS symbol,sym.name,sym.file,o.key AS occurrence FROM sc_claims c JOIN sc_facts f ON f.id=c.fact
            JOIN sc_provenance p ON p.id=c.provenance JOIN sc_entities e ON e.id=f.subject
            LEFT JOIN sc_entities s ON s.id=f.subject LEFT JOIN sc_symbols sym ON sym.entity=f.subject LEFT JOIN sc_entities o ON o.id=f.occurrence WHERE c.id=?`).get(n.claim) as Record<string, unknown>;
          const { value_json, provenance, ...detail } = payload;
          if (operation === "boundaries") { delete detail.symbol; delete detail.name; delete detail.file; delete detail.occurrence; }
          else { delete detail.operation; detail.relation = n.relation; }
          return { page_key: n.claim, confidence: n.confidence, ...detail, value: JSON.parse(String(value_json)), provenance: JSON.parse(String(provenance)) };
        }); examined = selected.length;
      } else if (operation === "find") {
        if (input.length > 256) throw new Error("Symbol query exceeds 256 characters");
        rows = read.symbols(input, after, limit + 1).map(item => ({
          page_key: item.entity,
          ...this.db.prepare(`SELECT e.key,s.name,s.qualified_name,s.kind,s.file,s.context AS variant FROM sc_symbols s JOIN sc_entities e ON e.id=s.entity WHERE s.entity=?`).get(item.entity) as object,
          // Package-scoped SCIP identity is immutable; display the selected declaration's actual file.
          ...this.db.prepare("SELECT src.path AS file FROM sc_occurrences o JOIN sc_sources src ON src.id=o.source WHERE o.entity=?").get(item.evidence.occurrence) as object,
          ...this.db.prepare("SELECT key AS evidenceClaim,confidence FROM sc_claims WHERE id=?").get(item.evidence.claim) as object,
        })); examined = rows.length;
      } else if (operation === "occurrence") {
        rows = this.db.prepare(`SELECT o.entity AS page_key,e.key,src.path,src.digest,o.start_byte,o.end_byte,o.line,o.column_num,o.end_line,o.end_column,o.role
          FROM sc_entities e JOIN sc_occurrences o ON o.entity=e.id JOIN sc_sources src ON src.id=o.source WHERE e.key=? LIMIT 1`).all(input) as Array<Record<string, unknown>>;
        const evidence = rows[0] ? read.navigation("n.occurrence=?", [rows[0].page_key], "n.claim", 1)[0] : undefined;
        if (!evidence) rows = [];
        else Object.assign(rows[0]!, this.db.prepare("SELECT key AS evidenceClaim,confidence FROM sc_claims WHERE id=?").get(evidence.claim));
        examined = rows.length;
      } else if (operation === "explain") {
        const claim = this.db.prepare(`SELECT c.id AS page_key,c.key,c.confidence,p.json AS provenance,f.predicate,f.value_json,c.support_group FROM sc_claims c JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance WHERE c.key=? LIMIT 1`).get(input) as Record<string, unknown> | undefined;
        if (claim && read.visible(Number(claim.page_key))) {
          const supports = this.db.prepare(`SELECT s.alternative,c.key AS claim,s.selector,s.expected FROM sc_supports s LEFT JOIN sc_claims c ON c.id=s.input_claim WHERE s.group_id=? ORDER BY s.alternative,s.position LIMIT 201`).all(claim.support_group ?? null);
          const { value_json, ...detail } = claim;
          rows = [{ ...detail, provenance: JSON.parse(String(claim.provenance)), value: JSON.parse(String(value_json)), supports: supports.slice(0, 200), supportTruncated: supports.length > 200 }]; examined = 1; supportRows = supports.length;
        }
      } else if (operation === "context" || operation === "native" || operation === "relationships") {
        const target = this.db.prepare("SELECT e.id,s.context FROM sc_entities e LEFT JOIN sc_symbols s ON s.entity=e.id WHERE e.key=?").get(input) as { id: number; context?: string } | undefined;
        let selected: ReturnType<SemanticRead["navigation"]> = [];
        if (operation === "context" && this.hasContexts) {
          const context = target?.context ?? input;
          const selection = context ? (read.epochs ? "n.context=? AND " : "EXISTS(SELECT 1 FROM sc_claims c JOIN sc_facts f ON f.id=c.fact WHERE c.id=n.claim AND f.context=?) AND ") : "";
          selected = read.navigation(`n.relation='project-context' AND ${selection}n.claim>?`, [...(context ? [context] : []), after], "n.claim", limit + 1);
        } else if (operation !== "context" && target) {
          const condition = operation === "relationships" ? "n.relation='native-relationship'" : "n.relation IN ('native-symbol','native-signature','native-relationship','native-occurrence','native-declaration')";
          selected = read.navigation(`n.subject=? AND ${condition} AND n.claim>?`, [target.id, after], "n.claim", limit + 1);
        }
        rows = selected.map(n => {
          const payload = this.db.prepare(`SELECT c.key AS evidenceClaim,c.confidence,f.predicate,f.value_json,p.json AS provenance,e.key AS target
            FROM sc_claims c JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance LEFT JOIN sc_entities e ON e.id=f.object WHERE c.id=?`).get(n.claim) as Record<string, unknown>;
          const { value_json, provenance, ...detail } = payload;
          if (operation === "context") { delete detail.predicate; delete detail.target; }
          return { page_key: n.claim, ...detail, value: JSON.parse(String(value_json)), provenance: JSON.parse(String(provenance)) };
        }); examined = selected.length;
      } else if (operation === "callers" || operation === "callees") {
        const target = this.db.prepare("SELECT id FROM sc_entities WHERE key=?").get(input) as { id: number } | undefined;
        if (target) {
          const direction = operation === "callers" ? "callee" : "caller"; const other = operation === "callers" ? "caller" : "callee";
          rows = read.calls(direction, target.id, after, limit + 1).map(rel => ({ page_key: rel[other], site_count: rel.site_count, confidence: rel.confidence,
            ...this.db.prepare("SELECT e.key,s.name,s.qualified_name,s.file FROM sc_symbols s JOIN sc_entities e ON e.id=s.entity WHERE s.entity=?").get(rel[other]) as object,
            ...this.db.prepare("SELECT key AS evidenceClaim FROM sc_claims WHERE id=?").get(rel.sample_claim) as object,
          }));
          examined = rows.length;
        }
      } else {
        const target = this.db.prepare("SELECT id FROM sc_entities WHERE key=?").get(input) as { id: number } | undefined;
        if (target) {
          const relation = operation === "definition" ? "definition" : "reference";
          // Restrict adjacency before joining payloads. No post-LIMIT global confidence scan.
          const selected = read.navigation("n.relation=? AND n.object=? AND n.occurrence>?", [relation, target.id, after], "n.occurrence,n.claim", limit + 1);
          examined = selected.length;
          // Several providers may claim the same site; a page has its own stable membership cursor.
          const seen = new Set<number>();
          for (const item of selected) {
            if (seen.has(item.occurrence!)) continue; seen.add(item.occurrence!);
            const row = this.db.prepare(`SELECT o.entity AS occurrence,c.id AS claim_id,c.confidence,e.key,src.path,src.digest,o.start_byte,o.end_byte,o.line,o.column_num,o.end_line,o.end_column,o.role,p.json AS provenance_json,c.key AS claim_key,sym.key AS symbol_key,s.name,s.qualified_name
              FROM sc_occurrences o JOIN sc_entities e ON e.id=o.entity JOIN sc_sources src ON src.id=o.source JOIN sc_claims c ON c.id=? JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance JOIN sc_entities sym ON sym.id=f.object JOIN sc_symbols s ON s.entity=sym.id WHERE o.entity=?`).get(item.claim, item.occurrence) as NavigationRow;
            rows.push({ page_key: row.occurrence, occurrence: row.key, symbol: row.symbol_key, file: row.path, sourceDigest: row.digest,
              range: { startByte: row.start_byte, endByte: row.end_byte, line: row.line, column: row.column_num, endLine: row.end_line, endColumn: row.end_column }, role: row.role, confidence: row.confidence, evidenceClaim: row.claim_key, provenance: JSON.parse(row.provenance_json) });
          }
          // The lookahead may be a duplicate claim; continue from examined membership, not from a guessed total.
        }
      }
      const items: Array<Record<string, unknown>> = [];
      let size = Buffer.byteLength(JSON.stringify(base)); let truncated = rows.length > limit || examined > limit;
      const reasons: string[] = truncated ? ["item-or-candidate-budget"] : [];
      for (const row of rows.slice(0, limit)) {
        const { page_key, ...output } = row;
        const bytes = Buffer.byteLength(JSON.stringify(output));
        if (size + bytes > maxBytes - 512) { truncated = true; reasons.push("byte-budget"); break; }
        size += bytes; items.push(output); continuation = Number(page_key);
      }
      const nextCursor = truncated && continuation > after ? Buffer.from(JSON.stringify({ snapshot, query: fingerprint, after: continuation })).toString("base64url") : undefined;
      return { ...base, items, truncated, truncationReasons: [...new Set(reasons)], ...(nextCursor ? { nextCursor } : {}), work: { ...base.work, candidateRows: Math.max(read.candidateRows, examined), supportRows, returnedRows: items.length },
        noResult: !items.length, analysisComplete: !coverageTruncated && coverage.length > 0 && coverage.every(c => c.status === "complete") };
    })();
  }
}

export async function semanticQueryForRepository(input = ".", index?: string): Promise<SemanticQuery> {
  const root = await resolveRepositoryRoot(input);
  const requested = path.resolve(index ?? path.join(root, ".prograph"));
  const directory = requested.endsWith(".sqlite") ? path.dirname(requested) : requested;
  return new SemanticQuery(path.join(directory, "semantic.sqlite"), path.join(directory, "manifest.json"));
}
