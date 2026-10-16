import { createHash } from "node:crypto";
import type { Confidence } from "../graph/schema.js";

export const SEMANTIC_FORMAT_VERSION = 2;
export const SEMANTIC_SCHEMA_VERSION = "2.0.0-step2.8";
export const READABLE_SEMANTIC_SCHEMAS = ["2.0.0-step1", "2.0.0-step2.1", "2.0.0-step2.2", "2.0.0-step2.3", "2.0.0-step2.4", "2.0.0-step2.5", "2.0.0-step2.6", "2.0.0-step2.7", SEMANTIC_SCHEMA_VERSION] as const;
export const RUST_PROVIDER_VERSION = "rust-scip-runner-6";
export const MANAGED_SCIP_VERSION = "managed-scip-3";
export const TYPESCRIPT_SEMANTIC_VERSION = "4";
export const CLANG_SEMANTIC_VERSION = "2";
export const SCIP_SEMANTIC_VERSION = "4";
export const CALL_PROJECTION_VERSION = "1";

/** Canonical JSON is a persisted identity contract, independent of insertion order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new Error("Semantic identity cannot contain undefined, non-finite numbers or unsupported values");
}
export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function semanticKey(kind: string, value: unknown): string {
  return `sc2:${kind}:${digest(canonical(value))}`;
}

export type EntityKind = "symbol" | "occurrence" | "artifact";
export interface SemanticSymbol {
  key: string;
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
  context: string;
}
export interface OccurrenceInput {
  key: string;
  file: string;
  sourceDigest: string;
  context: string;
  startByte: number;
  endByte: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  role: string;
}
export interface Provenance {
  provider: string;
  version: string;
  basis: "syntax" | "compiler" | "lsp" | "inference" | "unresolved";
  method: string;
  context: string;
  inputFingerprint: string;
}
export interface FactInput {
  predicate: Predicate;
  context: string;
  subject: string;
  object?: string;
  occurrence?: string;
  value?: Record<string, unknown>;
  confidence: Confidence;
  provenance: Provenance;
  supports?: SupportAlternative[];
}
export type SupportAtom = { claim: string } | { selector: string; digest: string };
export type SupportAlternative = SupportAtom[];
export const PREDICATES = {
  "common.Declaration": { version: 1, relation: "declaration", unique: false },
  "common.Definition": { version: 1, relation: "definition", unique: false },
  "common.Reference": { version: 1, relation: "reference", unique: false },
  "common.Import": { version: 1, relation: "import", unique: false },
  "common.CallSite": { version: 1, relation: "callsite", unique: false },
  "common.CallTarget": { version: 1, relation: "calltarget", unique: true },
  "common.CallSummary": { version: 1, relation: "calls", unique: false },
  "common.Facet": { version: 1, relation: "facet", unique: false },
  "context.Project": { version: 1, relation: "project-context", unique: false },
  "typescript.Signature": { version: 1, relation: "native-signature", unique: false },
  "scip.SymbolInformation": { version: 1, relation: "native-symbol", unique: false },
  "scip.Relationship": { version: 1, relation: "native-relationship", unique: false },
  "scip.Occurrence": { version: 1, relation: "native-occurrence", unique: false },
  "scip.SourceRole": { version: 1, relation: "native-declaration", unique: false },
  "cxx.Declaration": { version: 1, relation: "native-declaration", unique: false },
  "legacy.Node": { version: 1, relation: "legacy-node", unique: false },
  "legacy.Relation": { version: 1, relation: "legacy-relation", unique: false },
  "source.File": { version: 1, relation: "source-file", unique: false },
  "syntax.Diagnostic": { version: 1, relation: "syntax-diagnostic", unique: false },
  "syntax.Node": { version: 1, relation: "syntax-node", unique: false },
  "syntax.Relation": { version: 1, relation: "syntax-relation", unique: false },
  "projection.Node": { version: 1, relation: "projection-node", unique: false },
  "projection.Relation": { version: 1, relation: "projection-relation", unique: false },
  "projection.Dependency": { version: 1, relation: "file-dependency", unique: false },
  "framework.Component": { version: 1, relation: "framework-component", unique: false },
  "knowledge.Link": { version: 1, relation: "knowledge-link", unique: false },
  "support.Disjunction": { version: 1, relation: "support-disjunction", unique: false },
  "support.Conjunction": { version: 1, relation: "support-conjunction", unique: false },
  "boundary.Operation": { version: 1, relation: "boundary-operation", unique: false },
  "boundary.Invokes": { version: 1, relation: "boundary-invokes", unique: false },
  "boundary.Implements": { version: 1, relation: "boundary-implements", unique: false },
  "boundary.Emits": { version: 1, relation: "boundary-emits", unique: false },
  "boundary.Listens": { version: 1, relation: "boundary-listens", unique: false },
  "boundary.Registers": { version: 1, relation: "boundary-registers", unique: false },
  "boundary.Path": { version: 1, relation: "boundary-path", unique: false },
} as const;
export type Predicate = keyof typeof PREDICATES;

export function validateFact(input: FactInput): void {
  if (!Object.hasOwn(PREDICATES, input.predicate)) throw new Error(`Unregistered predicate: ${input.predicate}`);
  if (!["exact", "resolved", "probable", "unresolved"].includes(input.confidence)) throw new Error("Invalid confidence");
  if (!input.subject || !input.context || input.context !== input.provenance.context) throw new Error("Missing or incompatible fact context");
  if (!input.provenance.provider || !input.provenance.version || !input.provenance.method || !input.provenance.inputFingerprint) throw new Error("Incomplete provenance");
  if (!["syntax", "compiler", "lsp", "inference", "unresolved"].includes(input.provenance.basis)) throw new Error("Invalid provenance basis");
  if (Buffer.byteLength(canonical(input.provenance)) > 4096) throw new Error("Provenance exceeds 4 KiB");
  if (["common.Definition", "common.Reference", "common.Import", "common.CallTarget", "common.CallSummary"].includes(input.predicate) && !input.object) throw new Error("Binding requires an object");
  if (input.predicate.startsWith("common.") && input.predicate !== "common.CallSummary" && !input.occurrence) throw new Error("Observation requires occurrence evidence");
  if (input.predicate === "common.CallSummary" && !input.supports?.length) throw new Error("Derived call summary requires support");
  if (["projection.", "framework.", "knowledge.", "boundary.", "support."].some(prefix => input.predicate.startsWith(prefix)) && !input.supports?.length) throw new Error("Derived output requires input support");
  if (input.predicate.startsWith("boundary.") && input.predicate !== "boundary.Operation" && !input.object) throw Error("Boundary binding requires an object");
  if (["boundary.Invokes", "boundary.Emits", "boundary.Listens"].includes(input.predicate) && !input.occurrence) throw Error("Boundary invocation requires a call occurrence");
  if (input.predicate === "boundary.Operation" && (!["protocol", "namespace", "operation"].every(field => typeof input.value?.[field] === "string" && String(input.value[field]).trim()))) throw Error("Boundary operation requires explicit identity");
  if ((input.supports?.length ?? 0) > 32) throw new Error("Support exceeds 32 alternatives");
  for (const alternative of input.supports ?? []) {
    if (!alternative.length) throw new Error("Empty support conjunction");
    if (alternative.length > 32) throw new Error("Support exceeds 32 required atoms");
    for (const atom of alternative) if (!("claim" in atom ? atom.claim : atom.selector && atom.digest)) throw new Error("Invalid support atom");
  }
  if (Buffer.byteLength(canonical(input.value ?? {})) > 65536) throw new Error("Fact payload exceeds 64 KiB");
}
