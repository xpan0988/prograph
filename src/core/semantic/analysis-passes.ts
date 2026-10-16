import { architectureAdapter } from "../../adapters/artifact/architecture/index.js";
import { markdownAdapter } from "../../adapters/artifact/markdown/index.js";
import { packageJsonAdapter } from "../../adapters/artifact/package-json/index.js";
import { cargoTomlAdapter } from "../../adapters/artifact/cargo-toml/index.js";
import { tauriConfigAdapter } from "../../adapters/artifact/tauri-config/index.js";
import { tauriCapabilityAdapter } from "../../adapters/artifact/tauri-capability/index.js";
import { testsAdapter } from "../../adapters/artifact/tests/index.js";
import { reactAdapter } from "../../adapters/framework/react/index.js";
import { tauriAdapter } from "../../adapters/framework/tauri/index.js";
import { semanticLinkerAdapter } from "../../adapters/overlay/semantic-linker/index.js";
import type { AdapterResult, FrameworkAdapter, RepositorySnapshot } from "../adapters/contracts.js";
import type { AdapterRun } from "../graph/schema.js";
import { GraphBuilder } from "../graph/builder.js";
import { validateIdentities } from "../graph/identity.js";
import { runAdapter } from "../analysis/adapter-run.js";
import { SemanticStore } from "./store.js";
import { canonical, digest, semanticKey, type Provenance, type FactInput } from "./model.js";
import { orderPasses, passContract, type PassContract } from "./passes.js";
import { OwnedWriter, readOwnedProjection, writeSyntaxBase, OWNED_PASS_VERSION, type OwnedProjection } from "./owned-projection.js";
import { partitionProjection } from "./projection-shards.js";
import { partitionBoundaries } from "./boundary-shards.js";

interface AnalysisPass extends PassContract { adapter?: FrameworkAdapter | undefined }
function adapterPass(id: string, adapter: FrameworkAdapter, dependencies: string[] = []): AnalysisPass {
  return { id, adapter, version: "3", configurationFingerprint: "assigned-per-execution", dependencies,
    reads: ["source.File", "syntax.Node", "syntax.Relation", "projection.Node", "projection.Relation"],
    writes: ["projection.Node", "projection.Relation", "support.Conjunction", "support.Disjunction"],
    requiredCapabilities: ["source-catalogue", "sealed-projections"], inputDomains: ["source", "syntax", ...dependencies],
    selectorDependencies: ["repository-source-and-config-catalogue", "qualified-output-admission"], negativeDependencies: ["repository-symbol-and-file-candidate-set"],
    ownershipShard: "source-file-output", invalidation: "indexing-unit-and-selectors", coverageBehavior: "preserve-adapter-evidence-and-gaps",
    bounds: { batch: 500, maxRows: 1000000 } };
}
/** Algorithm dependencies, rather than incidental adapter array ordering, define visibility. */
export const analysisPasses: AnalysisPass[] = [
  { ...adapterPass("framework-react", reactAdapter), writes: ["projection.Node", "projection.Relation", "framework.Component", "support.Conjunction", "support.Disjunction"] },
  adapterPass("framework-tauri", tauriAdapter, ["framework-react"]),
  adapterPass("schema-contracts", architectureAdapter),
  adapterPass("documentation", markdownAdapter),
  adapterPass("package-config", packageJsonAdapter),
  adapterPass("cargo-config", cargoTomlAdapter),
  adapterPass("tauri-config", tauriConfigAdapter, ["framework-tauri", "package-config"]),
  adapterPass("tauri-capabilities", tauriCapabilityAdapter, ["framework-tauri", "tauri-config"]),
  adapterPass("test-relevance", testsAdapter),
  { ...adapterPass("knowledge-links", semanticLinkerAdapter, ["framework-react", "framework-tauri", "schema-contracts", "documentation", "package-config", "cargo-config", "tauri-config", "tauri-capabilities", "test-relevance"]),
    writes: ["projection.Node", "projection.Relation", "knowledge.Link", "support.Conjunction", "support.Disjunction"] },
  { ...adapterPass("boundary-binding", architectureAdapter, ["framework-tauri", "schema-contracts"]), ownershipShard: "boundary-operation", adapter: undefined,
    writes: ["boundary.Operation", "boundary.Invokes", "boundary.Implements", "boundary.Registers", "boundary.Emits", "boundary.Listens", "boundary.Path", "support.Conjunction", "support.Disjunction"],
    coverageBehavior: "qualified-syntax-and-explicit-namespace-bindings;unsupported-families-unavailable" },
  { ...adapterPass("dependency-projection", architectureAdapter, ["knowledge-links", "boundary-binding"]), version: "3", ownershipShard: "source-file", selectorDependencies: ["owned-input-claims", "repository-source-and-config-catalogue", "qualified-output-admission"], negativeDependencies: ["support-eligibility"], adapter: undefined, reads: ["syntax.Node", "syntax.Relation", "projection.Node", "projection.Relation", "boundary.Path"],
    writes: ["projection.Dependency", "support.Conjunction", "support.Disjunction"], coverageBehavior: "observed-file-dependencies;not-runtime-completeness" },
];

export interface OwnedAnalysis {
  parent: number | undefined;
  runs: number[];
  result: AdapterResult;
  adapterRuns: AdapterRun[];
}

export async function deriveOwnedAnalysis(snapshot: RepositorySnapshot, source: AdapterResult, filename: string): Promise<OwnedAnalysis> {
  const ordered = orderPasses(analysisPasses); // Validate before creating any run.
  const store = new SemanticStore(filename);
  try {
    store.bindSourceRoot(snapshot.repository.root, snapshot.sourceRoot);
    const parent = store.activeSnapshot();
    const context = semanticKey("analysis-context", [snapshot.repository.identity, OWNED_PASS_VERSION]);
    const fingerprint = digest(canonical({ sourceBinding: store.sourceBindingFingerprint(), files: [...snapshot.fileContents].map(([file, text]) => [file, digest(text)]).sort(),
      config: snapshot.config, passes: ordered.map(pass => passContract(pass)), nodes: [...source.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...source.edges].sort((a, b) => a.id.localeCompare(b.id)) }));
    const base = writeSyntaxBase(store, snapshot, source, context, fingerprint);
    const baseProjection = base.projection;
    const completed = new Map<string, OwnedProjection>(); const passOwners = new Map<string, number[]>(); const runs = [...base.runs]; const adapterRuns: AdapterRun[] = [];
    const final = new GraphBuilder();
    for (const template of ordered) {
      const pass = { ...template, configurationFingerprint: digest(canonical(snapshot.config)) };
      const input = new GraphBuilder(); input.merge(baseProjection.result);
      const inputNodes = new Map(baseProjection.nodeClaims); const inputEdges = new Map(baseProjection.edgeClaims);
      const ancestors = new Set<string>();
      const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); ordered.find(p => p.id === id)!.dependencies.forEach(visit); };
      pass.dependencies.forEach(visit);
      for (const predecessor of ordered) if (ancestors.has(predecessor.id)) {
        const projection = completed.get(predecessor.id)!; input.merge(projection.result);
        projection.nodeClaims.forEach((claim, id) => inputNodes.set(id, claim)); projection.edgeClaims.forEach((claim, id) => inputEdges.set(id, claim));
      }
      const run = store.begin(`analysis/pass:${pass.id}@${pass.version}`, context, fingerprint);
      const provenance: Provenance = { provider: `pass:${pass.id}`, version: pass.version, basis: "inference", method: "owned-semantic-pass", context, inputFingerprint: fingerprint };
      const writer = new OwnedWriter(store, run, snapshot, provenance, base.selector, base.fileClaims, inputNodes);
      let result: AdapterResult = { nodes: [], edges: [], diagnostics: [], metadata: {} };
      if (pass.adapter) {
        const executed = await runAdapter(pass.adapter, snapshot, input.result(), true); result = executed.result; adapterRuns.push(executed.run);
      }
      result.diagnostics.push(...validateIdentities(result.nodes, result.edges));
      // Current evaluation, including negative resolution, admits stable output shards.
      // The index run owns the source-catalogue receipt and child admission selectors.
      store.input(run, "source-catalogue", fingerprint);
      const shards = pass.adapter ? partitionProjection(store, run, `analysis/pass:${pass.id}@${pass.version}`, pass, snapshot, provenance, base.fileClaims, inputNodes, [...input.nodes.values()], result, base.selector) : undefined;
      const projection = shards ?? writer.write(result);
      if (pass.id === "framework-react") {
        const components = result.nodes.filter(node => node.kind === "react_component");
        for (let offset = 0; offset < components.length; offset += pass.bounds.batch) store.batch(run, () => {
          for (const node of components.slice(offset, offset + pass.bounds.batch)) {
            const output = shards?.forNode(node.id); if (!output) continue;
            output.fact({ predicate: "framework.Component", subject: output.reference(node.id), value: { framework: "react" }, confidence: "probable" }, [[projection.nodeClaims.get(node.id)!]]);
          }
        });
      }
      if (pass.id === "knowledge-links") for (let offset = 0; offset < result.edges.length; offset += pass.bounds.batch) store.batch(run, () => {
        for (const edge of result.edges.slice(offset, offset + pass.bounds.batch)) {
          const output = shards?.forEdge(edge.id); if (!output) continue;
          output.fact({ predicate: "knowledge.Link", subject: output.reference(edge.source), object: output.reference(edge.target), value: { kind: edge.kind, legacyId: edge.id }, confidence: edge.confidence }, [[projection.edgeClaims.get(edge.id)!]]);
        }
      });
      if (pass.id === "boundary-binding") {
        const boundaries = partitionBoundaries(store, run, `analysis/pass:${pass.id}@${pass.version}`, pass, snapshot, provenance, base.fileClaims, inputNodes, input.result(), inputEdges, base.selector);
        result.metadata = boundaries.metadata; passOwners.set(pass.id, boundaries.runs); runs.push(...boundaries.runs);
      }
      if (pass.id === "dependency-projection") {
        const nodes = new Map(input.nodes);
        let count = 0; let plannedBytes = 0;
        const shards = new Map<string, Array<{ input: Omit<FactInput, "context" | "provenance" | "supports">; support: string }>>();
        const dependency = (file: string, input: Omit<FactInput, "context" | "provenance" | "supports">, support: string) => {
          plannedBytes += Buffer.byteLength(canonical({ input, support }));
          if (plannedBytes > 128 * 1024 ** 2) throw Error("Dependency shard plan exceeds offline byte bound");
          const facts = shards.get(file) ?? []; facts.push({ input, support }); shards.set(file, facts);
        };
        const edges = [...input.edges.values()];
        for (let offset = 0; offset < edges.length; offset += pass.bounds.batch) store.batch(run, () => {
          for (const edge of edges.slice(offset, offset + pass.bounds.batch)) {
            const from = nodes.get(edge.source)?.file; const to = nodes.get(edge.target)?.file;
            if (!from || !to || from === to || edge.kind === "contains") continue;
            if (++count > pass.bounds.maxRows) throw Error("Dependency pass exceeds row bound");
            dependency(from, { predicate: "projection.Dependency", subject: writer.reference(edge.source), object: writer.reference(edge.target),
              value: { from, to, kind: edge.kind, legacyId: edge.id }, confidence: edge.confidence }, inputEdges.get(edge.id)!);
          }
        });
        for (const boundaryRun of passOwners.get("boundary-binding") ?? [completed.get("boundary-binding")!.run]) {
          let after = 0;
          while (true) {
            const rows = store.sql(`SELECT c.id,c.key,c.confidence,a.key AS subject,b.key AS object,s.file AS source,t.file AS target FROM sc_owned o
              CROSS JOIN sc_claims c ON c.id=o.claim CROSS JOIN sc_facts f ON f.id=c.fact CROSS JOIN sc_entities a ON a.id=f.subject CROSS JOIN sc_entities b ON b.id=f.object
              CROSS JOIN sc_symbols s ON s.entity=f.subject CROSS JOIN sc_symbols t ON t.entity=f.object WHERE o.run=? AND o.claim>? AND f.predicate='boundary.Path' ORDER BY o.claim LIMIT ?`).all(boundaryRun, after, pass.bounds.batch) as
              { id: number; key: string; confidence: import("../graph/schema.js").Confidence; subject: string; object: string; source: string; target: string }[];
            if (!rows.length) break;
            store.batch(run, () => { for (const row of rows) {
              if (!row.source || !row.target || row.source === row.target) continue;
              if (++count > pass.bounds.maxRows) throw Error("Dependency pass exceeds row bound");
              dependency(row.source, { predicate: "projection.Dependency", subject: row.subject, object: row.object,
                value: { from: row.source, to: row.target, kind: "boundary-path" }, confidence: row.confidence }, row.key);
            } });
            after = rows.at(-1)!.id;
          }
        }
        for (const [file, facts] of [...shards].sort(([a], [b]) => a.localeCompare(b))) {
          facts.sort((a, b) => canonical(a).localeCompare(canonical(b)));
          const inputFingerprint = digest(canonical([context, passContract(pass), file, facts]));
          const partition = `analysis/pass:${pass.id}@${pass.version}/file:${file}`;
          const selector = { key: `dependency-inputs:${context}:${file}`, digest: inputFingerprint };
          // The current pass index owns selector admission. A stale child partition
          // cannot declare its own old environment and resurrect a removed input.
          store.selector(run, selector.key, selector.digest, [base.selector]);
          const cached = store.reusable(partition, context, inputFingerprint);
          if (cached?.coverage.configurationFingerprint === pass.configurationFingerprint) { runs.push(cached.id); continue; }
          const shard = store.begin(partition, context, inputFingerprint);
          const output = new OwnedWriter(store, shard, snapshot, { ...provenance, inputFingerprint }, selector, base.fileClaims, inputNodes);
          for (let at = 0; at < facts.length; at += pass.bounds.batch) store.batch(shard, () => {
            for (const fact of facts.slice(at, at + pass.bounds.batch)) output.fact(fact.input, [[fact.support]]);
          });
          store.seal(shard, { ...passContract(pass), status: "partial", file, metadata: { dependencies: facts.length } }); runs.push(shard);
        }
        result.metadata = { dependencies: count, ownershipShards: shards.size };
      }
      const failure = result.diagnostics.some(diagnostic => diagnostic.code === "adapter-failure");
      if (failure) throw Error(`Owned pass ${pass.id} failed: ${result.diagnostics.map(item => item.message).join("; ")}`);
      // Declarations are an executable contract: an accidental anonymous output cannot be sealed.
      const emitted = store.sql("SELECT DISTINCT f.predicate FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=?").all(run) as { predicate: string }[];
      for (const row of emitted) if (!(pass.writes as string[]).includes(row.predicate)) throw Error(`Pass ${pass.id} wrote undeclared predicate ${row.predicate}`);
      const count = store.sql("SELECT COUNT(*) AS n FROM sc_owned WHERE run=?").get(run) as { n: number };
      if (count.n > pass.bounds.maxRows) throw Error(`Pass ${pass.id} exceeds declared row budget`);
      for (const diagnostic of result.diagnostics) store.diagnostic(run, diagnostic.code, diagnostic.message);
      store.seal(run, { ...passContract(pass), status: "partial", metadata: result.metadata });
      // Compatibility is hydrated only from sealed output; algorithms never mutate the source layer.
      const sealed = shards?.seal() ?? readOwnedProjection(store, run); if (shards) runs.push(...shards.runs);
      sealed.result.diagnostics = result.diagnostics; completed.set(pass.id, sealed);
      final.merge(sealed.result); runs.push(run);
    }
    return { parent, runs, result: final.result(), adapterRuns };
  } finally { store.close(); }
}
