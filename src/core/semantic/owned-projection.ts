import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import type { GraphNode, GraphEdge, Diagnostic } from "../graph/schema.js";
import { SemanticStore } from "./store.js";
import { canonical, digest, semanticKey, type FactInput, type Provenance, type SupportAtom } from "./model.js";

export const OWNED_PASS_VERSION = "analysis-passes-1";
export interface OwnedProjection {
  run: number;
  result: AdapterResult;
  nodeClaims: Map<string, string>;
  edgeClaims: Map<string, string>;
}
export function graphReference(repository: string, id: string): string { return semanticKey("graph-reference", [repository, id]); }
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
  write(result: AdapterResult): OwnedProjection {
    if (result.nodes.length + result.edges.length > 1000000) throw Error("Pass output exceeds row bound");
    let bytes = 0;
    const nodeFiles = new Map<string, Set<string>>();
    for (const edge of result.edges) for (const id of [edge.source, edge.target]) {
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

export function writeSyntaxBase(store: SemanticStore, snapshot: RepositorySnapshot, graph: AdapterResult, context: string, fingerprint: string) {
  if (graph.nodes.length + graph.edges.length + graph.diagnostics.length + snapshot.files.length > 1000000) throw Error("Source observation layer exceeds offline row bound");
  let bytes = 0;
  const run = store.begin("analysis/source", context, fingerprint); const selector = { key: `analysis:catalogue:${snapshot.repository.identity}`, digest: fingerprint };
  const provenance: Provenance = { provider: "source-and-language-observations", version: OWNED_PASS_VERSION, basis: "syntax", method: "immutable-provider-observations", context, inputFingerprint: fingerprint };
  const fileClaims = new Map<string, string>(); const nodeClaims = new Map<string, string>();
  store.batch(run, () => store.selector(run, selector.key, selector.digest));
  const files = [...snapshot.fileContents].sort(([a], [b]) => a.localeCompare(b));
  for (let at = 0; at < files.length; at += 500) store.batch(run, () => { for (const [file, source] of files.slice(at, at + 500)) {
    const hash = digest(source); const key = semanticKey("source-file", [snapshot.repository.identity, file, hash]); store.addEntity(key, "artifact", { key, file, digest: hash });
    store.input(run, `source:${file}`, hash);
    fileClaims.set(file, store.addFact(run, { predicate: "source.File", context, subject: key, value: { file, digest: hash, bytes: Buffer.byteLength(source) }, confidence: "exact", provenance }));
  } });
  for (const [predicate, items, kind] of [["syntax.Node", graph.nodes, "node"], ["syntax.Relation", graph.edges, "edge"]] as const) {
    for (let offset = 0; offset < items.length; offset += 500) store.batch(run, () => {
      for (const [index, original] of items.slice(offset, offset + 500).entries()) {
        const value = json(original); const subject = graphReference(snapshot.repository.identity, value.id); store.addEntity(subject, "artifact", { key: subject, legacyId: value.id });
        const payload = { [kind]: value }; bytes += Buffer.byteLength(canonical(payload));
        if (bytes > 128 * 1024 ** 2) throw Error("Source observation layer exceeds offline byte bound");
        let bounded: Record<string, unknown> = payload;
        if (Buffer.byteLength(canonical(payload)) > 65536) { const key = semanticKey("projection-payload", [canonical(payload)]); store.addEntity(key, "artifact", payload); bounded = { payloadEntity: key }; }
        const claim = store.addFact(run, { predicate, context, subject, value: bounded, confidence: "confidence" in value ? value.confidence : "exact", provenance });
        store.sql("INSERT INTO sc_projection_rows(run,kind,ordinal,claim) SELECT ?,?,?,id FROM sc_claims WHERE key=?").run(run, kind, offset + index, claim);
        if (kind === "node") nodeClaims.set(value.id, claim);
      }
    });
  }
  for (let offset = 0; offset < graph.diagnostics.length; offset += 500) store.batch(run, () => {
    for (const [index, item] of graph.diagnostics.slice(offset, offset + 500).entries()) {
      const value = json(item); const subject = semanticKey("syntax-diagnostic", [snapshot.repository.identity, value]);
      store.addEntity(subject, "artifact", { key: subject }); const payload = { diagnostic: value }; let bounded: Record<string, unknown> = payload;
      const encoded = canonical(payload); bytes += Buffer.byteLength(encoded); if (bytes > 128 * 1024 ** 2) throw Error("Source diagnostics exceed offline byte bound");
      if (Buffer.byteLength(encoded) > 65536) { const key = semanticKey("projection-payload", [encoded]); store.addEntity(key, "artifact", payload); bounded = { payloadEntity: key }; }
      const claim = store.addFact(run, { predicate: "syntax.Diagnostic", context, subject, value: bounded, confidence: "exact", provenance });
      store.sql("INSERT INTO sc_projection_rows(run,kind,ordinal,claim) SELECT ?,?,?,id FROM sc_claims WHERE key=?").run(run, "diagnostic", offset + index, claim);
    }
  });
  store.seal(run, { status: "partial", provider: "source-and-language-observations", version: OWNED_PASS_VERSION, gaps: ["Syntax evidence preserves existing language maturity; native facts remain separate"] });
  return { run, selector, fileClaims, nodeClaims };
}
