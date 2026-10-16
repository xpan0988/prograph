import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import type { GraphNode, GraphEdge, Diagnostic } from "../graph/schema.js";
import { SemanticStore } from "./store.js";
import { canonical, digest, semanticKey, type FactInput, type Provenance, type SupportAtom } from "./model.js";

export const OWNED_PASS_VERSION = "analysis-passes-3";
export interface OwnedProjection {
  run: number;
  result: AdapterResult;
  nodeClaims: Map<string, string>;
  edgeClaims: Map<string, string>;
}
export function graphReference(repository: string, id: string): string { return semanticKey("graph-reference", [repository, id]); }
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Normalize exactly the compatibility JSON payload, charging before accumulation. */
export function normalizeProjection(result: AdapterResult): AdapterResult {
  if (result.nodes.length + result.edges.length + result.diagnostics.length > 1000000) throw Error("Projection exceeds offline row bound");
  let bytes = 0;
  const item = <T>(value: T): T => {
    const encoded = JSON.stringify(value); bytes += Buffer.byteLength(encoded);
    if (bytes > 128 * 1024 ** 2) throw Error("Projection exceeds offline byte bound");
    return JSON.parse(encoded) as T;
  };
  return { ...result, nodes: result.nodes.map(item), edges: result.edges.map(item), diagnostics: result.diagnostics.map(item) };
}


/** Mutable objects exist only as offline algorithm inputs/compatibility views, never as authority. */
export function readOwnedProjection(store: SemanticStore, run: number): OwnedProjection {
  const state = store.sql("SELECT state FROM sc_runs WHERE id=?").get(run) as { state: string } | undefined;
  if (state?.state !== "sealed") throw Error("Projection input is not sealed");
  const result: AdapterResult = { nodes: [], edges: [], diagnostics: [], metadata: {} };
  const nodeClaims = new Map<string, string>(); const edgeClaims = new Map<string, string>(); let bytes = 0; let count = 0;
  for (const raw of store.sql(`SELECT c.key,f.predicate,f.value_json FROM sc_projection_rows o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact
    WHERE o.run=? AND f.predicate IN ('syntax.Node','syntax.Relation','projection.Node','projection.Relation','syntax.Diagnostic') ORDER BY o.kind,o.ordinal`).iterate(run)) {
    const row = raw as { key: string; predicate: string; value_json: string };
    if (++count > 1000000 || (bytes += Buffer.byteLength(row.value_json)) > 128 * 1024 ** 2) throw Error("Owned projection input exceeds offline work bounds");
    let value = JSON.parse(row.value_json) as { node?: GraphNode; edge?: GraphEdge; diagnostic?: Diagnostic; payloadEntity?: string };
    if (value.payloadEntity) {
      const entity = store.sql("SELECT canonical FROM sc_entities WHERE key=?").get(value.payloadEntity) as { canonical: string };
      bytes += Buffer.byteLength(entity.canonical); if (bytes > 128 * 1024 ** 2) throw Error("Owned projection payload exceeds offline byte bound");
      value = JSON.parse(entity.canonical) as typeof value;
    }
    if (value.node) { result.nodes.push(value.node); nodeClaims.set(value.node.id, row.key); }
    if (value.edge) { result.edges.push(value.edge); edgeClaims.set(value.edge.id, row.key); }
    if (value.diagnostic) result.diagnostics.push(value.diagnostic);
  }
  return { run, result, nodeClaims, edgeClaims };
}

export class OwnedWriter {
  readonly nodeClaims = new Map<string, string>();
  readonly edgeClaims = new Map<string, string>();
  constructor(readonly store: SemanticStore, readonly run: number, readonly snapshot: RepositorySnapshot, readonly provenance: Provenance,
    readonly selector: { key: string; digest: string }, readonly fileClaims: Map<string, string>, readonly inputNodes: Map<string, string>) {}
  reference(id: string): string {
    const key = graphReference(this.snapshot.repository.identity, id);
    this.store.addEntity(key, "artifact", { key, legacyId: id }); return key;
  }
  /** Conjunction trees preserve ALL supports without exceeding per-fact expansion bounds. */
  support(claims: string[]): SupportAtom[] {
    let level = [...new Set(claims)].sort();
    while (level.length > 28) {
      const next: string[] = [];
      for (let at = 0; at < level.length; at += 28) {
        const members = level.slice(at, at + 28); const key = semanticKey("support-conjunction", [this.provenance.context, members]);
        this.store.addEntity(key, "artifact", { key });
        next.push(this.store.addFact(this.run, { predicate: "support.Conjunction", context: this.provenance.context, subject: key, value: { members: members.length }, confidence: "exact", provenance: this.provenance,
          supports: [members.map(claim => ({ claim }))] }));
      }
      level = next;
    }
    return [...level.map(claim => ({ claim })), { selector: this.selector.key, digest: this.selector.digest }];
  }
  fact(input: Omit<FactInput, "context" | "provenance" | "supports">, alternatives: string[][]): string {
    if (!alternatives.length || alternatives.length > 1000000) throw Error("Invalid alternative support count");
    alternatives = [...new Map(alternatives.map(group => { const members = [...new Set(group)].sort(); return [canonical(members), members] as const; })).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
    while (alternatives.length > 28) {
      const next: string[][] = [];
      for (let at = 0; at < alternatives.length; at += 28) {
        const group = alternatives.slice(at, at + 28); const key = semanticKey("support-disjunction", [this.provenance.context, group]);
        this.store.addEntity(key, "artifact", { key });
        next.push([this.store.addFact(this.run, { predicate: "support.Disjunction", subject: key, context: this.provenance.context,
          value: { alternatives: group.length }, confidence: "exact", provenance: this.provenance, supports: group.map(claims => this.support(claims)) })]);
      }
      alternatives = next;
    }
    return this.store.addFact(this.run, { ...input, context: this.provenance.context, provenance: this.provenance, supports: alternatives.map(claims => this.support(claims)) });
  }
  write(result: AdapterResult, evidenceNodes?: Map<string, Set<string>>): OwnedProjection {
    if (result.nodes.length + result.edges.length > 1000000) throw Error("Pass output exceeds row bound");
    let bytes = 0;
    const nodeFiles = evidenceNodes ?? new Map<string, Set<string>>();
    if (!evidenceNodes) for (const edge of result.edges) for (const id of [edge.source, edge.target]) {
      const files = nodeFiles.get(id) ?? new Set<string>();
      for (const evidence of edge.evidence) if (evidence.file) files.add(evidence.file);
      nodeFiles.set(id, files);
    }
    const write = (kind: "node" | "edge", original: GraphNode | GraphEdge, ordinal: number) => {
      const value = json(original); const payload = { [kind]: value }; const encoded = canonical(payload);
      bytes += Buffer.byteLength(encoded); if (bytes > 128 * 1024 ** 2) throw Error("Pass output exceeds byte bound");
      const subject = this.reference(value.id); let bounded: Record<string, unknown> = payload;
      if (Buffer.byteLength(encoded) > 65536) { const key = semanticKey("projection-payload", [encoded]); this.store.addEntity(key, "artifact", payload); bounded = { payloadEntity: key }; }
      const supporting: string[] = [];
      if (kind === "node") {
        const node = value as GraphNode; const input = this.inputNodes.get(node.id); if (input) supporting.push(input);
        if (node.file && this.fileClaims.has(node.file)) supporting.push(this.fileClaims.get(node.file)!);
        for (const file of nodeFiles.get(node.id) ?? []) if (this.fileClaims.has(file)) supporting.push(this.fileClaims.get(file)!);
      } else {
        const edge = value as GraphEdge;
        for (const id of [edge.source, edge.target]) {
          const claim = this.nodeClaims.get(id) ?? this.inputNodes.get(id);
          if (!claim) throw Error(`Derived relation endpoint is unsupported: ${id}`); supporting.push(claim);
        }
        for (const file of new Set(edge.evidence.flatMap(item => item.file && this.fileClaims.has(item.file) ? [item.file] : []))) supporting.push(this.fileClaims.get(file)!);
      }
      const claim = this.fact({ predicate: kind === "node" ? "projection.Node" : "projection.Relation", subject, value: bounded,
        confidence: kind === "edge" ? (value as GraphEdge).confidence : "exact" }, [supporting]);
      this.store.sql("INSERT INTO sc_projection_rows(run,kind,ordinal,claim) SELECT ?,?,?,id FROM sc_claims WHERE key=?").run(this.run, kind, ordinal, claim);
      (kind === "node" ? this.nodeClaims : this.edgeClaims).set(value.id, claim);
    };
    for (const kind of ["node", "edge"] as const) {
      const items = kind === "node" ? result.nodes : result.edges;
      for (let offset = 0; offset < items.length; offset += 500) this.store.batch(this.run, () => { items.slice(offset, offset + 500).forEach((item, index) => write(kind, item, offset + index)); });
    }
    return { run: this.run, result, nodeClaims: this.nodeClaims, edgeClaims: this.edgeClaims };
  }
}

/** Reconstruct offline adapter input from source-owned partitions, never derived output. */
export function readSyntaxProjection(store: SemanticStore, snapshot: number): OwnedProjection | undefined {
  const rows = store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=? AND (partition_key='analysis/source' OR partition_key LIKE 'analysis/source/file:%') ORDER BY partition_key").all(snapshot) as Array<{ partition_key: string; run: number }>;
  if (!rows.some(row => row.partition_key === "analysis/source")) return undefined;
  const combined: OwnedProjection = { run: rows.find(row => row.partition_key === "analysis/source")!.run, result: { nodes: [], edges: [], diagnostics: [], metadata: {} }, nodeClaims: new Map(), edgeClaims: new Map() };
  let bytes = 0; let count = 0;
  for (const row of rows) {
    const projection = readOwnedProjection(store, row.run);
    for (const field of ["nodes", "edges", "diagnostics"] as const) {
      for (const item of projection.result[field]) { bytes += Buffer.byteLength(canonical(item)); if (++count > 1000000 || bytes > 128 * 1024 ** 2) throw Error("Source projection exceeds offline work bounds"); }
    }
    for (const node of projection.result.nodes) combined.result.nodes.push(node);
    for (const edge of projection.result.edges) combined.result.edges.push(edge);
    for (const diagnostic of projection.result.diagnostics) combined.result.diagnostics.push(diagnostic);
    projection.nodeClaims.forEach((value, key) => combined.nodeClaims.set(key, value)); projection.edgeClaims.forEach((value, key) => combined.edgeClaims.set(key, value));
  }
  return combined;
}

export function writeSyntaxBase(store: SemanticStore, snapshot: RepositorySnapshot, graph: AdapterResult, context: string, fingerprint: string) {
  store.bindSourceRoot(snapshot.repository.root, snapshot.sourceRoot);
  graph = normalizeProjection(graph);
  if (graph.nodes.length + graph.edges.length + graph.diagnostics.length + snapshot.files.length > 1000000) throw Error("Source observation layer exceeds offline row bound");
  const selector = { key: `analysis:catalogue:${snapshot.repository.identity}`, digest: fingerprint };
  const catalogue = store.begin("analysis/catalogue", context, fingerprint); store.selector(catalogue, selector.key, selector.digest);
  store.seal(catalogue, { status: "partial", version: OWNED_PASS_VERSION, ownershipShard: "source-candidate-catalogue" });
  const runs = [catalogue]; const fileClaims = new Map<string, string>(); const nodeClaims = new Map<string, string>(); const edgeClaims = new Map<string, string>();
  const groups = new Map<string, AdapterResult>([["", { nodes: [], edges: [], diagnostics: [], metadata: {} }]]);
  const group = (file: string | undefined) => {
    const key = file && snapshot.fileContents.has(file) ? file : "";
    let value = groups.get(key); if (!value) { value = { nodes: [], edges: [], diagnostics: [], metadata: {} }; groups.set(key, value); } return value;
  };
  for (const file of snapshot.fileContents.keys()) group(file);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) group(node.file).nodes.push(node);
  for (const edge of graph.edges) {
    const owner = nodes.get(edge.source)?.file;
    group(owner && snapshot.fileContents.has(owner) ? owner : edge.evidence.find(item => item.file && snapshot.fileContents.has(item.file))?.file).edges.push(edge);
  }
  for (const diagnostic of graph.diagnostics) group(diagnostic.file).diagnostics.push(diagnostic);
  let bytes = 0; let run = 0;
  for (const [file, result] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const source = file ? snapshot.fileContents.get(file)! : undefined;
    const inputFingerprint = digest(canonical([OWNED_PASS_VERSION, context, store.sourceBindingFingerprint(), snapshot.config, file, source === undefined ? null : digest(source), result]));
    const partition = file ? `analysis/source/file:${file}` : "analysis/source";
    const cached = store.reusable(partition, context, inputFingerprint);
    const current = cached?.coverage.version === OWNED_PASS_VERSION ? cached.id : store.begin(partition, context, inputFingerprint);
    if (!file) run = current;
    runs.push(current);
    const provenance: Provenance = { provider: "source-and-language-observations", version: OWNED_PASS_VERSION, basis: "syntax", method: "immutable-provider-observations", context, inputFingerprint };
    if (!cached || current !== cached.id) {
      if (source !== undefined) store.batch(current, () => {
        const hash = digest(source); const key = semanticKey("source-file", [snapshot.repository.identity, file, hash]); store.addEntity(key, "artifact", { key, file, digest: hash });
        store.input(current, `source:${file}`, hash);
        fileClaims.set(file, store.addFact(current, { predicate: "source.File", context, subject: key, value: { file, digest: hash, bytes: Buffer.byteLength(source) }, confidence: "exact", provenance }));
      });
      const write = (predicate: "syntax.Node" | "syntax.Relation" | "syntax.Diagnostic", kind: string, items: Array<GraphNode | GraphEdge | Diagnostic>) => {
        for (let offset = 0; offset < items.length; offset += 500) store.batch(current, () => {
          for (const [index, original] of items.slice(offset, offset + 500).entries()) {
            const value = json(original); const subject = "id" in value ? graphReference(snapshot.repository.identity, value.id) : semanticKey("syntax-diagnostic", [snapshot.repository.identity, value]);
            store.addEntity(subject, "artifact", "id" in value ? { key: subject, legacyId: value.id } : { key: subject });
            const payload = { [kind]: value }; const encoded = canonical(payload); let bounded: Record<string, unknown> = payload;
            if (Buffer.byteLength(encoded) > 65536) { const key = semanticKey("projection-payload", [encoded]); store.addEntity(key, "artifact", payload); bounded = { payloadEntity: key }; }
            const claim = store.addFact(current, { predicate, context, subject, value: bounded, confidence: "confidence" in value ? value.confidence : "exact", provenance });
            store.sql("INSERT INTO sc_projection_rows(run,kind,ordinal,claim) SELECT ?,?,?,id FROM sc_claims WHERE key=?").run(current, kind, offset + index, claim);
          }
        });
      };
      write("syntax.Node", "node", result.nodes); write("syntax.Relation", "edge", result.edges); write("syntax.Diagnostic", "diagnostic", result.diagnostics);
      store.seal(current, { status: "partial", provider: "source-and-language-observations", version: OWNED_PASS_VERSION, ownershipShard: file ? "source-file" : "source-structure", gaps: ["Syntax evidence preserves existing language maturity; native facts remain separate"] });
    } else if (file) {
      const row = store.sql("SELECT c.key FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=? AND f.predicate='source.File'").get(current) as { key: string } | undefined;
      if (!row) throw Error("Source shard has no file evidence"); fileClaims.set(file, row.key);
    }
    const projection = readOwnedProjection(store, current);
    for (const field of ["nodes", "edges", "diagnostics"] as const) for (const item of projection.result[field]) { bytes += Buffer.byteLength(canonical(item)); if (bytes > 128 * 1024 ** 2) throw Error("Source observation layer exceeds offline byte bound"); }
    projection.nodeClaims.forEach((value, key) => nodeClaims.set(key, value)); projection.edgeClaims.forEach((value, key) => edgeClaims.set(key, value));
  }
  return { run, runs, selector, fileClaims, nodeClaims, projection: { run, result: graph, nodeClaims, edgeClaims } satisfies OwnedProjection };
}
