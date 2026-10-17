/** Offline small-fixture oracle. It never imports facts from the incremental DB. */
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { SemanticStore } from "../../src/core/semantic/store.js";
import { canonical, digest } from "../../src/core/semantic/model.js";
import { ScipStream, decodeScip } from "../../src/core/semantic/scip-wire.js";
import { readSnapshotReport } from "../../src/core/semantic/snapshot-report.js";

type Row = Record<string, unknown>;
/** Execution paths/raw byte digests differ in independent tool runs. Retain and
 * verify those receipts, then compare their complete interpreted SCIP content.
 * Only known owned workspace paths and their authenticated receipt fingerprints
 * are renamed. Symbols, ranges, confidence, versions and support are not dropped. */
export async function semanticSnapshot(index: string) {
  const store = new SemanticStore(path.join(index, "semantic.sqlite"));
  try {
    const snapshot = store.activeSnapshot()!;
    const runs = store.sql("SELECT r.* FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? ORDER BY p.partition_key").all(snapshot) as Array<{ id: number; partition_key: string; context: string; input_fingerprint: string; coverage_json: string }>;
    const replacements = new Map<string, string>();
    const artifacts = new Map<string, { file: string; context: string }>();
    for (const run of runs.filter(run => run.partition_key.startsWith("scip/"))) {
      for (const row of store.sql("SELECT resource,digest FROM sc_inputs WHERE run=? AND resource LIKE 'artifact:%'").all(run.id) as Array<{ resource: string; digest: string }>) {
        const file = row.resource.slice(9); assert.equal(digest(await readFile(file)), row.digest, "Original artifact receipt must remain readable");
        const workspace = path.dirname(file); assert.match(path.basename(workspace), /^[a-f0-9-]{36}$/);
        const marker = JSON.parse(await readFile(path.join(workspace, ".prograph-provider.json"), "utf8")) as Row;
        assert.equal(marker.index, await realpath(index)); assert.equal(marker.id, path.basename(workspace));
        replacements.set(workspace, `<owned-workspace:${run.context}>`);
        artifacts.set(row.digest, { file, context: run.context });
      }
    }
    const rename = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (replacements.has(value)) return replacements.get(value)!;
        for (const [from, to] of replacements) if (value.includes(from)) value = value.replaceAll(from, to);
        return value;
      }
      if (Array.isArray(value)) return value.map(rename);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
      return value;
    };
    const artifactDigests = new Map<string, string>();
    for (const [raw, artifact] of artifacts) {
      const stream = await ScipStream.open(artifact.file, 64 * 1024 ** 2); const fields: string[] = [];
      try {
        while (true) {
          const tag = await stream.integer(true); if (tag === undefined) break;
          const field = tag >>> 3, wire = tag & 7;
          if (![1, 2, 3].includes(field)) { await stream.skip(wire); continue; }
          assert.equal(wire, 2);
          const decoded = decodeScip(field === 1 ? "Metadata" : field === 2 ? "Document" : "SymbolInformation", await stream.bytes((await stream.integer())!, true));
          if (field === 2) for (const key of ["symbols", "occurrences"]) if (Array.isArray(decoded[key])) decoded[key] = (decoded[key] as unknown[]).map(canonical).sort();
          fields.push(canonical([field, rename(decoded)]));
        }
        assert.equal(stream.digest(), raw);
      } finally { await stream.close(); }
      const interpreted = digest(canonical(fields.sort())); artifactDigests.set(raw, interpreted);
    }
    for (const [raw, interpreted] of artifactDigests) replacements.set(raw, `scip-content:${interpreted}`);
    // Summary fingerprints are execution receipts. Bind each renamed fingerprint
    // to its context, complete context value and independently verified artifact.
    for (const run of runs.filter(run => run.partition_key.startsWith("scip/") && run.partition_key.endsWith("/index"))) {
      const receipt = store.sql("SELECT f.value_json FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=? AND f.predicate='context.Project'").get(run.id) as { value_json: string };
      replacements.set(run.input_fingerprint, `execution-receipt:${digest(canonical([run.context, rename(JSON.parse(receipt.value_json))]))}`);
    }
    const claims = store.sql(`SELECT c.id,c.key,c.confidence,c.support_group,f.key AS fact,f.predicate,f.context,e.key AS subject,o.key AS object,x.key AS occurrence,f.value_json,p.json AS provenance
      FROM sc_claims c JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject
      LEFT JOIN sc_entities o ON o.id=f.object LEFT JOIN sc_entities x ON x.id=f.occurrence JOIN sc_provenance p ON p.id=c.provenance`).all() as Array<Row & { id: number; key: string; support_group: number | null; value_json: string; provenance: string }>;
    const byId = new Map(claims.map(claim => [claim.id, claim])); const keys = new Map<number, string>(), visiting = new Set<number>();
    const claimKey = (id: number): string => {
      if (keys.has(id)) return keys.get(id)!;
      assert.ok(!visiting.has(id), "Support must remain acyclic"); visiting.add(id);
      const row = byId.get(id)!; assert.ok(row);
      const alternatives = new Map<number, unknown[]>();
      for (const atom of row.support_group ? store.sql("SELECT alternative,input_claim,selector,expected FROM sc_supports WHERE group_id=? ORDER BY alternative,position").all(row.support_group) as Array<{ alternative: number; input_claim: number | null; selector: string | null; expected: string | null }> : []) {
        const group = alternatives.get(atom.alternative) ?? [];
        group.push(atom.input_claim === null ? { selector: atom.selector, digest: rename(atom.expected) } : { claim: digest(claimKey(atom.input_claim)) }); alternatives.set(atom.alternative, group);
      }
      const value = { predicate: row.predicate, context: row.context, subject: row.subject, object: row.object, occurrence: row.occurrence,
        value: rename(JSON.parse(row.value_json)), confidence: row.confidence, provenance: rename(JSON.parse(row.provenance)),
        support: [...alternatives.values()].map(group => group.map(canonical).sort()).map(canonical).sort() };
      const key = canonical(value); keys.set(id, key); visiting.delete(id); return key;
    };
    const visible = store.sql("SELECT claim FROM sc_active WHERE snapshot=?").all(snapshot) as Array<{ claim: number }>;
    const byKey = new Map(claims.map(row => [row.key, row.id]));
    const normalized = (key: string) => digest(claimKey(byKey.get(key)!));
    const facts = visible.map(row => {
      const claim = byId.get(row.claim)!;
      return canonical([claim.predicate, claim.context, claim.subject, claim.object, claim.occurrence, rename(JSON.parse(claim.value_json))]);
    });
    const navigation = store.sql(`SELECT n.relation,s.key AS subject,o.key AS object,x.key AS occurrence,c.key AS claim,n.confidence FROM sc_navigation n
      JOIN sc_entities s ON s.id=n.subject LEFT JOIN sc_entities o ON o.id=n.object LEFT JOIN sc_entities x ON x.id=n.occurrence JOIN sc_claims c ON c.id=n.claim WHERE snapshot=?`).all(snapshot) as Array<Row & { claim: string }>;
    const calls = store.sql(`SELECT s.key AS caller,o.key AS callee,c.site_count,c.confidence FROM sc_calls c JOIN sc_entities s ON s.id=c.caller JOIN sc_entities o ON o.id=c.callee WHERE snapshot=?`).all(snapshot);
    const projections = store.sql(`SELECT r.partition_key,p.kind,p.ordinal,c.key FROM sc_partitions r JOIN sc_projection_rows p ON p.run=r.run JOIN sc_claims c ON c.id=p.claim WHERE r.snapshot=?`).all(snapshot) as Array<Row & { key: string }>;
    assert.equal(store.db.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(store.db.pragma("foreign_key_check"), []);
    const report = readSnapshotReport(store.db, snapshot);
    let analysisReport: unknown;
    if (report) {
      const { generatedAt: _generated, analysisDuration: _duration, adapterRuns, semanticCore, ...manifest } = report.manifest;
      const { durationMs: _semanticDuration, snapshot: _snapshot, ...semantic } = semanticCore!;
      const { generatedAt: _stateGenerated, ...stateHeader } = report.stateHeader;
      analysisReport = { format: report.format, phase: report.phase, compatibilityReady: report.compatibilityReady, sourceCatalogue: report.sourceCatalogue, sourceBinding: report.sourceBinding, stateHeader,
        manifest: { ...manifest, semanticCore: semantic, adapterRuns: adapterRuns.map(({ durationMs: _time, ...run }) => run) } };
    }
    return {
      analysisReports: analysisReport ? [canonical(analysisReport)] : [],
      facts: [...new Set(facts)].sort(), claims: visible.map(row => claimKey(row.claim)).sort(),
      coverage: runs.map(run => canonical([run.partition_key, JSON.parse(run.coverage_json)])).sort(),
      navigation: navigation.map(row => canonical({ ...row, claim: normalized(row.claim) })).sort(),
      calls: calls.map(canonical).sort(), projections: projections.map(row => canonical({ ...row, key: normalized(row.key) })).sort(),
    };
  } finally { store.close(); }
}
