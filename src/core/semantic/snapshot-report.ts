/** Immutable analysis metadata; format 2 is published with verified owned compatibility projections. */
import Database from "better-sqlite3";
import type { AnalysisManifest } from "../graph/schema.js";
import type { IndexState } from "../analysis/state.js";
import { canonical, digest, semanticKey } from "./model.js";
import { OWNED_PASS_VERSION } from "./owned-projection.js";
import type { SemanticStore } from "./store.js";
export interface SnapshotReportInput { manifest: AnalysisManifest; stateHeader: Omit<IndexState, "files">; inherited?: { snapshot: number; reportKey: string } }
export interface SnapshotReport extends SnapshotReportInput { format: 1 | 2; snapshot: number; snapshotKey: string; sourceCatalogue: string; sourceBinding: string; phase: "semantic-publication-before-commit"; compatibilityReady: boolean }
function valid(report: SnapshotReport) {
  const m = report.manifest, s = report.stateHeader;
  if (![1,2].includes(report.format) || !Number.isSafeInteger(report.snapshot) || report.snapshot < 1 || report.phase !== "semantic-publication-before-commit" || report.compatibilityReady !== (report.format === 2) || !m || !s || Object.hasOwn(s, "files")
    || m.schemaVersion !== "1.2.0" || s.schemaVersion !== m.schemaVersion || !m.repositoryRoot || s.repositoryRoot !== m.repositoryRoot || !m.repositoryIdentity || s.repositoryIdentity !== m.repositoryIdentity || s.generatedAt !== m.generatedAt || s.toolVersion !== m.toolVersion
    || !m.semanticCore || m.semanticCore.format !== 2 || m.semanticCore.snapshot !== report.snapshot || !["partial", "unavailable"].includes(m.semanticCore.status) || !/^[a-f0-9]{64}$/.test(s.configHash) || !/^[a-f0-9]{64}$/.test(report.sourceBinding) || !/^[a-f0-9]{64}$/.test(report.sourceCatalogue)) throw Error("Invalid snapshot-bound analysis report");
}
/** Called only after native retention and the final observed-input barrier qualified these owners. */
export function retainedAnalysisReport(store: SemanticStore, runs: number[], parent: number | undefined): SnapshotReportInput | undefined {
  if (!parent) return undefined;
  const previous = readSnapshotReport(store.db, parent);
  if (previous?.format !== 2 || !previous.compatibilityReady || previous.sourceBinding !== store.sourceBindingFingerprint()) return undefined;
  const selected = new Set(runs);
  const source = store.sql("SELECT run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/%'").all(parent) as Array<{run:number}>;
  if (!source.length || source.some(row => !selected.has(row.run))) return undefined;
  return { manifest:previous.manifest, stateHeader:previous.stateHeader, inherited:{snapshot:parent,reportKey:previous.reportKey} };
}
function canInheritReport(store: SemanticStore, snapshot: number, receipt: NonNullable<SnapshotReportInput['inherited']>) {
  const parent=store.sql("SELECT parent FROM sc_snapshots WHERE id=?").get(snapshot) as {parent:number}|undefined;
  if(parent?.parent!==receipt.snapshot)return false;
  const previous=readSnapshotReport(store.db,receipt.snapshot);
  if (previous?.format!==2 || !previous.compatibilityReady || previous.reportKey!==receipt.reportKey || previous.sourceBinding!==store.sourceBindingFingerprint()) return false;
  const changed=store.sql(`SELECT 1 FROM (
    SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/%'
    EXCEPT SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/%'
  ) LIMIT 1`).get(receipt.snapshot,snapshot) || store.sql(`SELECT 1 FROM (
    SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/%'
    EXCEPT SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND partition_key LIKE 'analysis/%'
  ) LIMIT 1`).get(snapshot,receipt.snapshot);
  if (changed) return false;
  // Retained owners alone are insufficient: a native support/selector change may
  // alter their effective visibility. The complete support closure has just run.
  return !store.sql(`SELECT 1 FROM sc_pending p CROSS JOIN cg_candidates c INDEXED BY cg_candidate_claim ON c.claim=p.claim
    WHERE EXISTS(SELECT 1 FROM (SELECT first,last FROM sc_visibility v WHERE v.claim=p.claim ORDER BY first DESC LIMIT 1) latest WHERE latest.first=? OR latest.last=?) LIMIT 1`).get(snapshot,snapshot);
}
export function writeSnapshotReport(store: SemanticStore, snapshot: number, snapshotKey: string, input: SnapshotReportInput) {
  if (!store.db.inTransaction) throw Error("Snapshot report requires the publication transaction");
  if (input.inherited) {
    const previous=readSnapshotReport(store.db,input.inherited.snapshot);
    if (!canInheritReport(store,snapshot,input.inherited) || canonical(input.manifest)!==canonical(previous!.manifest) || canonical(input.stateHeader)!==canonical(previous!.stateHeader)) return undefined;
  }
  const context = semanticKey("analysis-context", [input.stateHeader.repositoryIdentity, OWNED_PASS_VERSION]);
  const catalogue = store.sql("SELECT r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key='analysis/catalogue' AND r.context=? AND r.state='sealed'").get(snapshot, context) as { input_fingerprint: string } | undefined;
  if (!catalogue || !store.sql("SELECT 1 FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key='analysis/source' AND r.context=? AND r.state='sealed'").get(snapshot, context)) throw Error("Analysis report requires its selected sealed source catalogue and structure");
  const copy = JSON.parse(JSON.stringify(input)) as SnapshotReportInput;
  const report: SnapshotReport = { ...copy, format: 2, snapshot, snapshotKey, sourceCatalogue: catalogue.input_fingerprint, sourceBinding: store.sourceBindingFingerprint(), phase: "semantic-publication-before-commit", compatibilityReady: true,
    manifest: { ...copy.manifest, semanticCore: { ...copy.manifest.semanticCore!, snapshot } } };
  valid(report); const json = canonical(report); if (Buffer.byteLength(json) > 1048576) throw Error("Snapshot report exceeds 1 MiB");
  const key = `sc2:report-v2:${digest(json)}`; store.sql("INSERT INTO sc_snapshot_reports VALUES(?,?,?)").run(snapshot, key, json); return key;
}
export function readSnapshotReport(db: Database.Database, snapshot: number): (SnapshotReport & { reportKey: string }) | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sc_snapshot_reports'").get()) return undefined;
  const row = db.prepare("SELECT key,CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json END AS json FROM sc_snapshot_reports WHERE snapshot=?").get(snapshot) as { key: string; json: string | null } | undefined;
  if (!row) return undefined; if (row.json === null || !([1,2].some(version => row.key === `sc2:report-v${version}:${digest(row.json!)}`))) throw Error("Invalid or oversized snapshot report receipt");
  const report = JSON.parse(row.json) as SnapshotReport; valid(report);
  if (row.key !== `sc2:report-v${report.format}:${digest(row.json)}`) throw Error("Snapshot report format/key mismatch");
  if (report.snapshot !== snapshot || !(db.prepare("SELECT 1 FROM sc_snapshots WHERE id=? AND key=?").get(snapshot, report.snapshotKey))) throw Error("Snapshot report identity mismatch");
  return { ...report, reportKey: row.key };
}

export interface SnapshotReportStatus {
  state: "matches-semantic-snapshot" | "matches-legacy-report" | "out-of-sync" | "unreported" | "unavailable";
  snapshot?: number;
  reason?: string;
}

/** Metadata coherence only; legacy graph projection readiness remains unqualified. */
export function snapshotReportStatus(filename: string, manifest?: AnalysisManifest, state?: Omit<IndexState, "files">): SnapshotReportStatus {
  let db: Database.Database | undefined;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
    return db.transaction((): SnapshotReportStatus => {
      const active = db!.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string } | undefined;
      if (!active) return { state: "unreported" };
      const snapshot = Number(active.value);
      const report = readSnapshotReport(db!, snapshot);
      if (!report) return { state: "unreported", snapshot };
      // Timing is deliberately measured before commit in the durable report and
      // after commit in the filesystem manifest. Compare the bound state header.
      const agrees = manifest?.semanticCore?.snapshot === snapshot && manifest.repositoryIdentity === report.manifest.repositoryIdentity
        && manifest.repositoryRoot === report.manifest.repositoryRoot && manifest.generatedAt === report.manifest.generatedAt
        && manifest.semanticCore.status === report.manifest.semanticCore!.status && !!state && canonical(state) === canonical(report.stateHeader);
      return { state: agrees ? "matches-legacy-report" : "out-of-sync", snapshot };
    })();
  } catch (error) { return { state: "unavailable", reason: String(error).slice(0, 160) }; }
  finally { db?.close(); }
}
