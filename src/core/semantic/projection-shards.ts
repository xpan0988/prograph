import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import type { GraphEdge, GraphNode } from "../graph/schema.js";
import { canonical, digest, type Provenance } from "./model.js";
import { OwnedWriter, readOwnedProjection, normalizeProjection, type OwnedProjection } from "./owned-projection.js";
import { passContract, type PassContract } from "./passes.js";
import type { SemanticStore } from "./store.js";

/** Full pass evaluation admits output shards. Reuse saves immutable writes, never skips
 * negative resolution checks. Only the current pass index declares admission selectors.
 */
export function partitionProjection(store: SemanticStore, index: number, partition: string, pass: PassContract,
  snapshot: RepositorySnapshot, provenance: Provenance, fileClaims: Map<string, string>, inputNodes: Map<string, string>,
  input: GraphNode[], result: AdapterResult, sourceSelector: { key: string; digest: string }) {
  // Match the existing JSON compatibility payload contract before fingerprinting.
  // Optional undefined fields must not become a different identity from persisted data.
  result = normalizeProjection(result);
  const outputNodes = new Map(result.nodes.map(node => [node.id, node]));
  const nodes = new Map([...input, ...result.nodes].map(node => [node.id, node]));
  const groups = new Map<string, { nodes: GraphNode[]; edges: GraphEdge[] }>();
  const own = (file: string | undefined) => file && snapshot.fileContents.has(file) ? file : "";
  const group = (file: string) => { let value = groups.get(file); if (!value) { value = { nodes: [], edges: [] }; groups.set(file, value); } return value; };
  const nodeFiles = new Map<string, Set<string>>();
  for (const edge of result.edges) for (const id of [edge.source, edge.target]) {
    const files = nodeFiles.get(id) ?? new Set<string>();
    for (const evidence of edge.evidence) if (evidence.file && fileClaims.has(evidence.file)) files.add(evidence.file);
    nodeFiles.set(id, files);
  }
  const nodeInputs = (node: GraphNode) => ({ input: inputNodes.get(node.id) ?? null,
    files: [...new Set([...(node.file && fileClaims.has(node.file) ? [node.file] : []), ...(nodeFiles.get(node.id) ?? [])])].sort().map(file => [file, fileClaims.get(file)!]) });
  const nodeProofs = new Map(result.nodes.map(node => [node.id, digest(canonical({ node, ...nodeInputs(node) }))]));
  const endpoint = (id: string) => nodeProofs.get(id) ?? inputNodes.get(id) ?? null;
  for (const node of result.nodes) group(own(node.file)).nodes.push(node);
  const edgeOwners = new Map<string, string>();
  for (const edge of result.edges) {
    const file = own(edge.evidence.find(e => e.file && snapshot.fileContents.has(e.file))?.file ?? nodes.get(edge.source)?.file);
    group(file).edges.push(edge); edgeOwners.set(edge.id, file);
  }
  if (result.nodes.length + result.edges.length > pass.bounds.maxRows) throw Error("Pass shard plan exceeds row bound");
  const contract = passContract(pass); const combinedNodes = new Map(inputNodes);
  const nodeClaims = new Map<string, string>(); const edgeClaims = new Map<string, string>();
  const children: Array<{ file: string; run: number; facts?: number; writer?: OwnedWriter; nodes: GraphNode[]; edges: GraphEdge[] }> = [];
  let bytes = 0;
  for (const [file, value] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const content = { nodes: value.nodes.map(node => ({ node, proof: nodeProofs.get(node.id)! })), edges: value.edges.map(edge => ({ edge, endpoints: [endpoint(edge.source), endpoint(edge.target)] })) };
    const encoded = canonical(content); bytes += Buffer.byteLength(encoded);
    if (bytes > 128 * 1024 ** 2) throw Error("Pass shard plan exceeds offline byte bound");
    const fingerprint = digest(canonical([provenance.context, contract, file, content]));
    const key = `${partition}/file:${file || "<structure>"}`;
    const selector = { key: `pass-output:${provenance.context}:${pass.id}:${file}`, digest: fingerprint };
    store.selector(index, selector.key, selector.digest, [sourceSelector]);
    const cached = store.reusable(key, provenance.context, fingerprint);
    if (cached?.coverage.configurationFingerprint === pass.configurationFingerprint && cached.coverage.version === pass.version) {
      const projection = readOwnedProjection(store, cached.id);
      projection.nodeClaims.forEach((claim, id) => { nodeClaims.set(id, claim); combinedNodes.set(id, claim); });
      projection.edgeClaims.forEach((claim, id) => edgeClaims.set(id, claim));
      children.push({ file, run: cached.id, facts: Number(cached.coverage.facts), ...value });
    } else {
      const run = store.begin(key, provenance.context, fingerprint);
      const writer = new OwnedWriter(store, run, snapshot, { ...provenance, inputFingerprint: fingerprint }, selector, fileClaims, combinedNodes);
      // All nodes precede all cross-shard edges. Node support never depends on an
      // edge claim, so cycles in the projected graph do not create support cycles.
      writer.write({ nodes: value.nodes, edges: [], diagnostics: [], metadata: {} }, nodeFiles);
      writer.nodeClaims.forEach((claim, id) => { nodeClaims.set(id, claim); combinedNodes.set(id, claim); });
      children.push({ file, run, writer, ...value });
    }
  }
  for (const child of children) if (child.writer) {
    child.writer.write({ nodes: [], edges: child.edges, diagnostics: [], metadata: {} });
    child.writer.edgeClaims.forEach((claim, id) => edgeClaims.set(id, claim));
  }
  const childByFile = new Map(children.map(child => [child.file, child]));
  return {
    runs: children.map(child => child.run), nodeClaims, edgeClaims,
    forNode(id: string) { const node = outputNodes.get(id); return node ? childByFile.get(own(node.file))?.writer : undefined; },
    forEdge(id: string) { const file = edgeOwners.get(id); return file === undefined ? undefined : childByFile.get(file)?.writer; },
    seal(): OwnedProjection {
      const sealed: OwnedProjection = { run: index, result: { nodes: [], edges: [], diagnostics: [], metadata: {} }, nodeClaims: new Map(), edgeClaims: new Map() };
      let total = 0;
      for (const child of children) {
        if (child.writer) {
          const emitted = store.sql("SELECT f.predicate,COUNT(*) AS n FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=? GROUP BY f.predicate").all(child.run) as Array<{ predicate: string; n: number }>;
          if (emitted.some(row => !(pass.writes as string[]).includes(row.predicate))) throw Error("Undeclared sharded pass output");
          child.facts = emitted.reduce((n, row) => n + row.n, 0);
          store.seal(child.run, { ...contract, status: "partial", file: child.file, facts: child.facts, metadata: { nodes: child.nodes.length, edges: child.edges.length } });
        }
        if (!Number.isSafeInteger(child.facts) || child.facts! < 0) throw Error("Missing shard fact-count seal");
        total += child.facts!; if (total > pass.bounds.maxRows) throw Error("Pass shards exceed output bound");
        const projection = readOwnedProjection(store, child.run);
        for (const node of projection.result.nodes) sealed.result.nodes.push(node);
        for (const edge of projection.result.edges) sealed.result.edges.push(edge);
        projection.nodeClaims.forEach((claim, id) => sealed.nodeClaims.set(id, claim)); projection.edgeClaims.forEach((claim, id) => sealed.edgeClaims.set(id, claim));
      }
      return sealed;
    },
  };
}
