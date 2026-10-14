import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveRepositoryRoot } from "../repository/repository.js";
import { canonical, digest, SEMANTIC_FORMAT_VERSION, SEMANTIC_SCHEMA_VERSION } from "./model.js";

export type SemanticOperation = "status" | "find" | "definition" | "references" | "callers" | "callees" | "occurrence" | "explain";
export interface SemanticQueryOptions { limit?: number; cursor?: string; snapshot?: number; maxBytes?: number }
interface Cursor { snapshot: number; query: string; after: number }
interface NavigationRow { occurrence: number; claim_id: number; confidence: string; key: string; path: string; digest: string; start_byte: number; end_byte: number; line: number; column_num: number; end_line: number; end_column: number; role: string; provenance_json: string; claim_key: string; symbol_key: string; name: string; qualified_name: string }

export class SemanticQuery {
  readonly db: Database.Database;
  constructor(filename: string, private readonly manifestPath?: string) {
    this.db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const format = this.db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as { value: string } | undefined;
      const schema = this.db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as { value: string } | undefined;
      if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || schema?.value !== SEMANTIC_SCHEMA_VERSION) throw new Error("Unsupported semantic index format/schema");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  execute(operation: SemanticOperation, input = "", options: SemanticQueryOptions = {}): Record<string, unknown> {
    if (!["status", "find", "definition", "references", "callers", "callees", "occurrence", "explain"].includes(operation)) throw new Error("Unknown semantic operation");
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
      const base = { snapshot, activeSnapshot: Number(active?.value), format: SEMANTIC_FORMAT_VERSION, schema: SEMANTIC_SCHEMA_VERSION, variant: relevant[0]?.context ?? null, scope: "code", coverage, gaps,
        latestAttempt, semanticFreshness: "snapshot-only; source freshness unchecked", coverageTruncated,
        evidencePolicy: "sample claim per occurrence or relation; independent claims retained",
        columnEncoding: "utf-16", byteEncoding: "utf-8", truncated: false, limits: { maxItems: limit, maxBytes, maxCandidateRows: operation === "explain" || operation === "occurrence" ? 1 : limit + 1, maxSupportRows: 201, maxMetadataRows: 9 }, work: { candidateRows: 0, supportRows: 0, metadataRows: partitions.length, returnedRows: 0, globalGraphMaterialized: false } };
      const after = cursor?.after ?? 0;
      let rows: Array<Record<string, unknown>> = [];
      let examined = 0;
      let supportRows = 0;
      let continuation = after;
      if (operation === "status") {
        const page = this.db.prepare("SELECT r.id,r.partition_key,r.context,r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.run>? ORDER BY p.run LIMIT ?").all(snapshot, after, limit + 1) as typeof partitions;
        rows = page.map(p => ({ page_key: p.id, partition: p.partition_key, context: p.context, inputFingerprint: p.input_fingerprint, legacy: p.partition_key === "legacy/full" })); examined = rows.length;
      } else if (operation === "find") {
        if (input.length > 256) throw new Error("Symbol query exceeds 256 characters");
        const items = this.db.prepare(`SELECT s.entity AS page_key,e.key,s.name,s.qualified_name,s.kind,s.file FROM sc_visible_symbols v JOIN sc_symbols s ON s.entity=v.entity JOIN sc_entities e ON e.id=s.entity
          WHERE v.snapshot=? AND v.name=? AND v.entity>? ORDER BY v.entity LIMIT ?`).all(snapshot, input, after, limit + 1) as Array<Record<string, unknown>>;
        rows = items; examined = items.length;
        for (const item of rows) {
          const evidence = this.db.prepare("SELECT c.key AS evidenceClaim,c.confidence FROM sc_navigation n JOIN sc_claims c ON c.id=n.claim WHERE n.snapshot=? AND n.relation='declaration' AND n.subject=? ORDER BY n.occurrence,n.claim LIMIT 1").get(snapshot, item.page_key);
          Object.assign(item, evidence);
        }
      } else if (operation === "occurrence") {
        rows = this.db.prepare(`SELECT o.entity AS page_key,e.key,src.path,src.digest,o.start_byte,o.end_byte,o.line,o.column_num,o.end_line,o.end_column,o.role
          FROM sc_entities e JOIN sc_occurrences o ON o.entity=e.id JOIN sc_sources src ON src.id=o.source
          WHERE e.key=? AND EXISTS(SELECT 1 FROM sc_navigation n WHERE n.snapshot=? AND n.occurrence=o.entity) LIMIT 1`).all(input, snapshot) as Array<Record<string, unknown>>;
        examined = rows.length;
        if (rows[0]) Object.assign(rows[0], this.db.prepare("SELECT c.key AS evidenceClaim,c.confidence FROM sc_navigation n JOIN sc_claims c ON c.id=n.claim WHERE n.snapshot=? AND n.occurrence=? LIMIT 1").get(snapshot, rows[0].page_key));
      } else if (operation === "explain") {
        const claim = this.db.prepare(`SELECT c.id AS page_key,c.key,c.confidence,p.json AS provenance,f.predicate,f.value_json,c.support_group FROM sc_claims c JOIN sc_active a ON a.claim=c.id JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance WHERE a.snapshot=? AND c.key=? LIMIT 1`).get(snapshot, input) as Record<string, unknown> | undefined;
        if (claim) {
          const supports = this.db.prepare(`SELECT s.alternative,c.key AS claim,s.selector,s.expected FROM sc_supports s LEFT JOIN sc_claims c ON c.id=s.input_claim WHERE s.group_id=? ORDER BY s.alternative,s.position LIMIT 201`).all(claim.support_group ?? null);
          const { value_json, ...detail } = claim;
          rows = [{ ...detail, provenance: JSON.parse(String(claim.provenance)), value: JSON.parse(String(value_json)), supports: supports.slice(0, 200), supportTruncated: supports.length > 200 }]; examined = 1; supportRows = supports.length;
        }
      } else if (operation === "callers" || operation === "callees") {
        const target = this.db.prepare("SELECT id FROM sc_entities WHERE key=?").get(input) as { id: number } | undefined;
        if (target) {
          const direction = operation === "callers" ? "callee" : "caller"; const other = operation === "callers" ? "caller" : "callee";
          rows = this.db.prepare(`SELECT rel.${other} AS page_key,e.key,s.name,s.qualified_name,s.file,rel.site_count,rel.confidence,c.key AS evidenceClaim
            FROM sc_calls rel JOIN sc_symbols s ON s.entity=rel.${other} JOIN sc_entities e ON e.id=s.entity JOIN sc_claims c ON c.id=rel.sample_claim
            WHERE rel.snapshot=? AND rel.${direction}=? AND rel.${other}>? ORDER BY rel.${other} LIMIT ?`).all(snapshot, target.id, after, limit + 1) as Array<Record<string, unknown>>;
          examined = rows.length;
        }
      } else {
        const target = this.db.prepare("SELECT id FROM sc_entities WHERE key=?").get(input) as { id: number } | undefined;
        if (target) {
          const relation = operation === "definition" ? "definition" : "reference";
          // Restrict adjacency before joining payloads. No post-LIMIT global confidence scan.
          const selected = this.db.prepare(`SELECT n.occurrence,n.claim,n.confidence FROM sc_navigation n WHERE n.snapshot=? AND n.relation=? AND n.object=? AND n.occurrence>? ORDER BY n.occurrence LIMIT ?`).all(snapshot, relation, target.id, after, limit + 1) as Array<{ occurrence: number; claim: number; confidence: string }>;
          examined = selected.length;
          // Several providers may claim the same site; a page has its own stable membership cursor.
          const seen = new Set<number>();
          for (const item of selected) {
            if (seen.has(item.occurrence)) continue; seen.add(item.occurrence);
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
      return { ...base, items, truncated, truncationReasons: [...new Set(reasons)], ...(nextCursor ? { nextCursor } : {}), work: { ...base.work, candidateRows: examined, supportRows, returnedRows: items.length },
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
