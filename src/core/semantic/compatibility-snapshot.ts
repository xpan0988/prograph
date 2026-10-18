/** Offline reconstruction from one immutable selected fact snapshot. No source reads. */
import type Database from "better-sqlite3";
import type { AnalysisManifest, GraphData, GraphNode, GraphEdge, Diagnostic } from "../graph/schema.js";
import type { IndexState } from "../analysis/state.js";
import { canonical, digest, READABLE_SEMANTIC_SCHEMAS, SEMANTIC_FORMAT_VERSION } from "./model.js";
import { readSnapshotReport } from "./snapshot-report.js";
import { orderPasses } from "./passes.js";
type Owner = {
  partition_key: string;
  run: number;
  coverage_json: string;
};
export function readCompatibilitySnapshot(db: Database.Database, snapshot: number) {
  if (!db.inTransaction)
    throw Error("Compatibility reconstruction requires a consistent read transaction");
  const format = db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as {
    value: string;
  } | undefined;
  const schema = db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as {
    value: string;
  } | undefined;
  if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || !(READABLE_SEMANTIC_SCHEMAS as readonly string[]).includes(schema?.value ?? ""))
    throw Error("Unsupported semantic format/schema for compatibility reconstruction");
  const report = readSnapshotReport(db, snapshot);
  if (!report)
    throw Error("Snapshot has no qualified analysis report");
  const owners = db.prepare("SELECT p.partition_key,p.run,r.coverage_json FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? AND p.partition_key LIKE 'analysis/%' LIMIT 200001").all(snapshot) as Owner[];
  if (owners.length > 200000)
    throw Error("Compatibility reconstruction exceeds owner budget");
  const catalogue = owners.find(row => row.partition_key === "analysis/catalogue");
  if (catalogue && (db.prepare("SELECT input_fingerprint FROM sc_runs WHERE id=?").get(catalogue.run) as {
    input_fingerprint: string;
  }).input_fingerprint !== report.sourceCatalogue)
    throw Error("Compatibility report catalogue mismatch");
  if (!catalogue || !owners.some(row => row.partition_key === "analysis/source"))
    throw Error("Compatibility source ownership is unavailable");
  const rules = owners.filter(row => /^analysis\/pass:[^/]+$/.test(row.partition_key)).map(row => {
    const contract = JSON.parse(row.coverage_json) as {
      pass: string;
      dependencies: string[];
    };
    return { id: contract.pass, dependencies: contract.dependencies };
  });
  const ranks = new Map(orderPasses(rules).map((rule, index) => [rule.id, index + 1]));
  const rank = (row: Owner) => {
    if (!row.partition_key.startsWith("analysis/pass:"))
      return 0;
    const contract = JSON.parse(row.coverage_json) as {
      pass: string;
    };
    const value = ranks.get(contract.pass);
    if (value === undefined)
      throw Error("Compatibility pass has no selected contract");
    return value;
  };
  const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  owners.sort((a, b) => rank(a) - rank(b) || binary(a.partition_key, b.partition_key));
  const nodes = new Map<string, GraphNode>(), edges = new Map<string, GraphEdge>(), diagnostics: Diagnostic[] = [];
  const files: Record<string, string> = {};
  let rows = 0, bytes = 0;
  const charge = (value: string) => {
    if (++rows > 1000000 || (bytes += Buffer.byteLength(value)) > 128 * 1024 ** 2)
      throw Error("Compatibility reconstruction exceeds offline row/byte budgets");
  };
  const query = db.prepare(`SELECT p.kind,p.ordinal,f.value_json FROM sc_projection_rows p CROSS JOIN sc_claims c ON c.id=p.claim CROSS JOIN sc_facts f ON f.id=c.fact
    WHERE p.run=? AND EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=p.claim) ORDER BY p.kind,p.ordinal`);
  for (const owner of owners) {
    for (const raw of query.iterate(owner.run, snapshot)) {
      const row = raw as {
        kind: string;
        ordinal: number;
        value_json: string;
      };
      charge(row.value_json);
      let payload = JSON.parse(row.value_json) as {
        node?: GraphNode;
        edge?: GraphEdge;
        diagnostic?: Diagnostic;
        payloadEntity?: string;
      };
      if (payload.payloadEntity) {
        const stored = db.prepare("SELECT CASE WHEN length(CAST(canonical AS BLOB))<=134217728 THEN canonical END AS data FROM sc_entities WHERE key=?").get(payload.payloadEntity) as {
          data: string | null;
        } | undefined;
        if (!stored?.data)
          throw Error("Compatibility payload unavailable or oversized");
        charge(stored.data);
        payload = JSON.parse(stored.data);
      }
      if (row.kind === "node" && payload.node)
        nodes.set(payload.node.id, payload.node);
      else if (row.kind === "edge" && payload.edge)
        edges.set(payload.edge.id, payload.edge);
      else if (row.kind === "diagnostic" && payload.diagnostic)
        diagnostics.push(payload.diagnostic);
      else
        throw Error("Invalid compatibility projection payload");
    }
    if (owner.partition_key.startsWith("analysis/source/file:")) {
      const source = db.prepare(`SELECT f.value_json FROM sc_owned o CROSS JOIN sc_claims c ON c.id=o.claim CROSS JOIN sc_facts f ON f.id=c.fact WHERE o.run=? AND f.predicate='source.File' AND EXISTS(SELECT 1 FROM sc_active a WHERE a.snapshot=? AND a.claim=o.claim)`).get(owner.run, snapshot) as {
        value_json: string;
      } | undefined;
      if (!source)
        throw Error("Missing visible compatibility source input");
      charge(source.value_json);
      const input = JSON.parse(source.value_json) as {
        file: string;
        digest: string;
      };
      if (Object.hasOwn(files, input.file) || !/^[a-f0-9]{64}$/.test(input.digest))
        throw Error("Invalid compatibility source catalogue");
      files[input.file] = input.digest;
    }
  }
  const manifest: AnalysisManifest = JSON.parse(JSON.stringify(report.manifest));
  if (!manifest.adapterRuns)
    throw Error("Analysis report has no adapter sequence");
  const repositoryNode = [...nodes.values()].find(node => node.kind === "repository");
  if (!repositoryNode)
    throw Error("Missing compatibility repository identity");
  repositoryNode.metadata = { ...repositoryNode.metadata, analysis: manifest.adapterRuns.map(({ adapter, detected, metadata }) => ({ adapter, detected, ...metadata })) };
  for (const edge of edges.values())
    if (!nodes.has(edge.source) || !nodes.has(edge.target))
      throw Error("Unsupported compatibility relation endpoint");
  if (nodes.size !== manifest.nodeCount || edges.size !== manifest.edgeCount || diagnostics.length !== manifest.diagnosticCount || Object.keys(files).length !== manifest.scannedFileCount)
    throw Error("Compatibility facts disagree with the snapshot-bound report");
  const graph: GraphData = { schemaVersion: "1.2.0", repository: { root: manifest.repositoryRoot, identity: manifest.repositoryIdentity, ...(manifest.gitCommit ? { gitCommit: manifest.gitCommit } : {}) }, nodes: [...nodes.values()], edges: [...edges.values()], diagnostics };
  const state: IndexState = { ...report.stateHeader, files };
  const normalized = { ...graph, nodes: [...graph.nodes].sort((a, b) => binary(a.id, b.id)), edges: [...graph.edges].sort((a, b) => binary(a.id, b.id)), diagnostics: graph.diagnostics.map(canonical).sort(binary) };
  return { graph, manifest, state, reportKey: report.reportKey, hash: digest(canonical(normalized)), work: { owners: owners.length, rows, bytes }, ordering: "owned-pass-DAG/partition/local-ordinal" };
}
