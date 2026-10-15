import path from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRepositoryMetadata, resolveRepositoryRoot } from "../repository/repository.js";
import { canonical, digest, semanticKey, SCIP_SEMANTIC_VERSION, type Provenance } from "./model.js";
import { SemanticStore } from "./store.js";
import { SourceCoordinates } from "./coordinates.js";
import { ScipStream, SCIP_PROTOCOL_DIGEST, decodeScip, validateDocumentSize } from "./scip-wire.js";
import { parseScipSymbol, type ScipSymbol } from "./scip-symbol.js";
import { inventoryFromDisk, retainProviders } from "./provider-runs.js";
import { boundedInput, digestFile } from "./inputs.js";

export interface ScipManifest {
  format: 1;
  id: string;
  projectContext: string;
  sourceRoot: string;
  indexDigest: string;
  provider: { name: string; version: string; basis: Provenance["basis"] };
  sources: Record<string, string>;
  inputs?: Record<string, string>;
  originalProjectRoot?: string;
  legacyPositionEncoding?: 1 | 2 | 3;
  documentPathPrefix?: string;
  enclosingPolicy?: "diagnose";
  externalLocalPolicy?: "diagnose";
}
/** Supplied by a managed producer, never deserialized from a generic sidecar. */
export interface ScipExecution {
  version: string;
  environment: Record<string, unknown>;
  inputs: Record<string, string>;
  diagnostics: string[];
  /** Trusted runtime hook. Generic interchange can never opt into semantic derivations. */
  derive?(store: SemanticStore, documents: number[], context: string, fingerprint: string, prefix: string): Promise<number[]>;
  capabilities?: Record<string, string>;
  requireAllDocuments?: boolean;
  parseSymbol?(raw: string): ScipSymbol;
  sourceRange?(coordinates: SourceCoordinates, range: number[], encoding: number): [number, number];
  verify(signal?: AbortSignal): Promise<void>;
}
export interface ScipLimits { maxIndexBytes: number; maxDocumentBytes: number; maxSourceBytes: number; maxOccurrencesPerDocument: number; maxRelationshipsPerSymbol: number; maxDocuments: number; batch: number }
export const SCIP_LIMITS: ScipLimits = { maxIndexBytes: 10 * 1024 ** 3, maxDocumentBytes: 16 * 1024 ** 2, maxSourceBytes: 8 * 1024 ** 2, maxOccurrencesPerDocument: 100000, maxRelationshipsPerSymbol: 1024, maxDocuments: 100000, batch: 500 };
const yieldBatch = () => new Promise<void>(resolve => setImmediate(resolve));
type Message = Record<string, unknown>;
const messages = (value: unknown): Message[] => Array.isArray(value) ? value as Message[] : [];
function relativePath(file: string): void {
  if (!file || file.length > 4096 || file.includes("\\") || file.includes("\0") || file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.split("/").some(part => !part || part === "." || part === "..")) throw Error("Invalid SCIP source path");
}
function range(value: Message, enclosing = false): number[] | undefined {
  const single = value[enclosing ? "single_line_enclosing_range" : "single_line_range"] as Message | undefined;
  const multi = value[enclosing ? "multi_line_enclosing_range" : "multi_line_range"] as Message | undefined;
  if (single && multi) throw Error("Conflicting typed SCIP ranges");
  const typed = single ? [single.line, single.start_character, single.end_character] : multi ? [multi.start_line, multi.start_character, multi.end_line, multi.end_character] : undefined;
  const packed = value[enclosing ? "enclosing_range" : "range"] as number[] | undefined;
  const actual = typed ?? packed;
  if (!actual?.length) return undefined;
  if (actual.length !== 3 && actual.length !== 4 || actual.some(item => !Number.isSafeInteger(item) || Number(item) < 0)) throw Error("Invalid SCIP occurrence range");
  const result = actual.length === 3 ? [Number(actual[0]), Number(actual[1]), Number(actual[0]), Number(actual[2])] : actual.map(Number);
  if (typed && packed?.length) { const old = packed.length === 3 ? [packed[0], packed[1], packed[0], packed[2]] : packed; if (canonical(old) !== canonical(result)) throw Error("Typed/legacy SCIP ranges disagree"); }
  return result;
}

/** Entire artifact replacement; each verified document seals independently, then one atomic snapshot. */
export async function importScip(repository: string, artifact: string, manifest: ScipManifest, index?: string, overrides: Partial<ScipLimits> = {}, signal?: AbortSignal, execution?: ScipExecution): Promise<Record<string, unknown>> {
  const started = performance.now(); const limits = { ...SCIP_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0 || value > SCIP_LIMITS[key as keyof ScipLimits]) throw Error(`Invalid SCIP resource limit: ${key}`);
  const record = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
  if (manifest.format !== 1 || typeof manifest.id !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(manifest.id) || typeof manifest.projectContext !== "string" || !manifest.projectContext || manifest.projectContext.length > 256 || typeof manifest.sourceRoot !== "string" || typeof manifest.provider?.name !== "string" || !manifest.provider.name || typeof manifest.provider.version !== "string" || !manifest.provider.version || !["compiler", "lsp", "syntax", "inference"].includes(manifest.provider.basis) || !record(manifest.sources) || Object.keys(manifest.sources).length > limits.maxDocuments || manifest.inputs !== undefined && (!record(manifest.inputs) || Object.keys(manifest.inputs).length > 4096) || typeof manifest.indexDigest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.indexDigest)) throw Error("Incomplete/unsupported SCIP sidecar manifest");
  if (manifest.documentPathPrefix !== undefined) relativePath(manifest.documentPathPrefix);
  if (manifest.enclosingPolicy !== undefined && manifest.enclosingPolicy !== "diagnose") throw Error("Unsupported enclosing range policy");
  if (manifest.externalLocalPolicy !== undefined && manifest.externalLocalPolicy !== "diagnose") throw Error("Unsupported external local-symbol policy");
  const root = await resolveRepositoryRoot(repository); const repositoryInfo = await getRepositoryMetadata(root);
  if (await realpath(manifest.sourceRoot) !== await realpath(root)) throw Error("SCIP sidecar source root does not match repository");
  const artifactPath = path.resolve(artifact);
  const artifactInfo = await lstat(artifactPath); if (!artifactInfo.isFile() || artifactInfo.size > limits.maxIndexBytes) throw Error("SCIP artifact exceeds file/resource limit");
  signal?.throwIfAborted();
  if (await digestFile(artifactPath, limits.maxIndexBytes, signal) !== manifest.indexDigest) throw Error("SCIP artifact digest mismatch");
  const directory = path.resolve(index?.endsWith(".sqlite") ? path.dirname(index) : index ?? path.join(root, ".prograph")); await mkdir(directory, { recursive: true });
  const stages: Record<string, number> = {};
  const store = new SemanticStore(path.join(directory, "semantic.sqlite"), { measure(stage, ms) { stages[stage] = +ms.toFixed(3); } });
  let stream: ScipStream | undefined;
  try {
    const parent = store.activeSnapshot();
    const context = semanticKey("context", [repositoryInfo.identity, "scip", manifest.projectContext, manifest.inputs ?? {}, SCIP_SEMANTIC_VERSION,
      ...(manifest.documentPathPrefix || manifest.enclosingPolicy || manifest.externalLocalPolicy ? [{ prefix: manifest.documentPathPrefix ?? "", enclosingPolicy: manifest.enclosingPolicy ?? "strict", ...(manifest.externalLocalPolicy ? { externalLocalPolicy: manifest.externalLocalPolicy } : {}) }] : [])]);
    const inputFingerprint = digest(canonical(manifest)); const prefix = `scip/${manifest.id}/`;
    const parseSymbol = execution?.parseSymbol ?? parseScipSymbol;
    const provenance: Provenance = { provider: manifest.provider.name, version: `${manifest.provider.version}/scip-map-${SCIP_SEMANTIC_VERSION}`, basis: manifest.provider.basis, method: "source-verified-scip", context, inputFingerprint };
    const summary = store.begin(`${prefix}index`, context, inputFingerprint); const accepted: number[] = [];
    const inventory = await inventoryFromDisk(root, directory, limits.maxDocuments * 2, signal);
    store.input(summary, "project-inventory", inventory.inventory);
    store.input(summary, `artifact:${artifactPath}`, manifest.indexDigest);
    for (const [resource, hash] of Object.entries(execution?.inputs ?? {})) store.input(summary, resource, hash);
    for (const message of execution?.diagnostics ?? []) store.diagnostic(summary, "producer-diagnostic", message);
    let documentCount = 0; let rejected = 0; let occurrences = 0; let metadata: Message | undefined; let externalSymbols = 0; let excludedExternalLocals = 0;
    stream = await ScipStream.open(artifactPath, limits.maxIndexBytes);
    store.db.exec("CREATE TEMP TABLE sc_import_seen(path TEXT PRIMARY KEY)");
    const symbol = (raw: string, file: string, sourceDigest: string): string => {
      const parsed = parseSymbol(raw);
      const key = semanticKey("scip-symbol", [repositoryInfo.identity, context, parsed.local ? [manifest.id, file, sourceDigest] : null, raw]);
      store.addSymbol({ key, name: parsed.name, qualifiedName: raw, kind: parsed.local ? "scip-local" : "scip-global", file: parsed.local ? file : "<scip-package>", context }); return key;
    };
    const information = (run: number, info: Message, file: string, sourceDigest: string) => {
      const raw = String(info.symbol ?? ""); const parsed = parseSymbol(raw);
      if (file === "<external>" && parsed.local) throw Error("SCIP external symbol cannot be document-local");
      if (file === "<external>" && messages(info.relationships).some(r => parseSymbol(String(r.symbol ?? "")).local)) throw Error("SCIP external relationship cannot be document-local");
      const subject = symbol(raw, file, sourceDigest);
      const documentation = Array.isArray(info.documentation) ? info.documentation.slice(0, 4).map(value => String(value).slice(0, 2048)) : [];
      const signature = info.signature_documentation as Message | undefined;
      store.addFact(run, { predicate: "scip.SymbolInformation", context, subject, value: { rawSymbol: raw, package: parsed.local ? null : { scheme: parsed.scheme, manager: parsed.manager, name: parsed.package, version: parsed.version }, kind: info.kind ?? 0, displayName: String(info.display_name ?? "").slice(0, 512), documentation,
        signature: signature ? String(signature.text ?? "").slice(0, 4096) : null, enclosingSymbol: String(info.enclosing_symbol ?? "").slice(0, 4096), documentationTruncated: Array.isArray(info.documentation) && (info.documentation.length > 4 || info.documentation.some(value => String(value).length > 2048)) }, confidence: "exact", provenance });
      for (const relation of messages(info.relationships)) {
        store.addFact(run, { predicate: "scip.Relationship", context, subject, object: symbol(String(relation.symbol ?? ""), file, sourceDigest),
          value: { isReference: !!relation.is_reference, isImplementation: !!relation.is_implementation, isTypeDefinition: !!relation.is_type_definition, isDefinition: !!relation.is_definition }, confidence: ["compiler", "lsp"].includes(provenance.basis) ? "resolved" : "probable", provenance });
      }
    };
    for (const [file, expected] of Object.entries(manifest.inputs ?? {})) { relativePath(file); const input = path.join(root, file); if (!(await realpath(input)).startsWith(`${await realpath(root)}${path.sep}`) || await digestFile(input) !== expected) throw Error(`SCIP environment input mismatch: ${file}`); store.input(summary, `source:${file}`, expected); }
    while (true) {
      signal?.throwIfAborted();
      const tag = await stream.integer(true); if (tag === undefined) break;
      const field = tag >>> 3; const wire = tag & 7; if (!field || tag > 0xffffffff) throw Error("Invalid SCIP index field");
      if (!metadata && field !== 1) throw Error("SCIP metadata must be first");
      if (![1, 2, 3].includes(field)) { await stream.skip(wire); continue; }
      if (wire !== 2) throw Error("Invalid SCIP index framing");
      const size = (await stream.integer())!;
      if (field === 2 && ++documentCount > limits.maxDocuments) throw Error("SCIP document quota exceeded");
      if (field === 1) {
        if (metadata || size > 262144) throw Error("Duplicate/oversized SCIP metadata");
        const bytes = await stream.bytes(size, true); validateDocumentSize(bytes, limits.maxOccurrencesPerDocument, "Metadata"); metadata = decodeScip("Metadata", bytes);
        if (metadata.version !== 0 || ![0, 1].includes(Number(metadata.text_document_encoding))) throw Error("Unsupported SCIP protocol/source encoding");
        const tool = metadata.tool_info as Message | undefined;
        if (tool?.name !== manifest.provider.name || tool.version !== manifest.provider.version) throw Error("SCIP producer does not match sidecar");
        const original = String(metadata.project_root ?? "");
        if (new URL(original).protocol !== "file:") throw Error("SCIP source root must be a file URI");
        if (manifest.originalProjectRoot ? original !== manifest.originalProjectRoot : path.resolve(fileURLToPath(original)) !== path.resolve(root)) throw Error("SCIP source-root mapping missing or incompatible");
        store.batch(summary, () => {
          const key = semanticKey("project", [repositoryInfo.identity, `scip/${manifest.id}`]); store.addEntity(key, "artifact", { key, kind: "project" });
          store.addFact(summary, { predicate: "context.Project", context, subject: key, value: { unit: `scip/${manifest.id}`, project: manifest.projectContext, sourceRoot: root, originalProjectRoot: original, producer: manifest.provider, indexDigest: manifest.indexDigest, declaredSources: Object.keys(manifest.sources).length, environmentInputs: Object.keys(manifest.inputs ?? {}).length, limits,
            documentPathPrefix: manifest.documentPathPrefix ?? null, enclosingPolicy: manifest.enclosingPolicy ?? "strict", ...(execution ? { execution: { version: execution.version, environment: execution.environment } } : {}), gaps: ["Producer/environment completeness is capability-specific; SCIP does not establish calls"] }, confidence: "exact", provenance });
        });
        continue;
      }
      if (size > limits.maxDocumentBytes) {
        await stream.bytes(size, false); rejected++; store.diagnostic(summary, "scip-oversized-field", `Skipped field ${field}, ${size} bytes`); continue;
      }
      const bytes = await stream.bytes(size, true);
      if (field === 3) {
        externalSymbols++; if (externalSymbols > limits.maxDocuments) throw Error("SCIP external-symbol quota exceeded"); validateDocumentSize(bytes, limits.maxOccurrencesPerDocument, "SymbolInformation", limits.maxRelationshipsPerSymbol);
        const info = decodeScip("SymbolInformation", bytes);
        const unscoped = parseSymbol(String(info.symbol ?? "")).local || messages(info.relationships).some(r => parseSymbol(String(r.symbol ?? "")).local);
        if (unscoped && manifest.externalLocalPolicy === "diagnose") { excludedExternalLocals++; store.diagnostic(summary, "scip-unscoped-external-local-excluded", "Excluded external symbol information without a document-local identity; no semantic binding inferred"); }
        else store.batch(summary, () => information(summary, info, "<external>", manifest.indexDigest));
        await yieldBatch(); continue;
      }
      let file = "<malformed>";
      try {
        validateDocumentSize(bytes, limits.maxOccurrencesPerDocument, "Document", limits.maxRelationshipsPerSymbol);
        const doc = decodeScip("Document", bytes); file = String(doc.relative_path ?? ""); relativePath(file);
        if (manifest.documentPathPrefix) file = `${manifest.documentPathPrefix}/${file}`;
        if (store.sql("SELECT 1 FROM sc_import_seen WHERE path=?").get(file)) throw Error("Duplicate SCIP document"); store.sql("INSERT INTO sc_import_seen VALUES(?)").run(file);
        const expected = manifest.sources[file]; if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw Error("SCIP source digest missing");
        const source = path.join(root, file); const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxSourceBytes || !(await realpath(source)).startsWith(`${await realpath(root)}${path.sep}`)) throw Error("SCIP source path/resource boundary rejected");
        const rawSource = await boundedInput(source, limits.maxSourceBytes); if (digest(rawSource) !== expected) throw Error("SCIP source/index mismatch");
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawSource);
        if (text.includes("\0")) throw Error("SCIP binary/UTF-16 disk sources are unsupported");
        if (doc.text && doc.text !== text) throw Error("SCIP embedded source differs from verified source");
        const encoding = Number(doc.position_encoding) || manifest.legacyPositionEncoding;
        if (!encoding || ![1, 2, 3].includes(encoding)) throw Error("SCIP range encoding is unspecified");
        const coordinates = new SourceCoordinates(file, text, true); const observations = messages(doc.occurrences);
        const sourceRange = (location: number[]): [number, number] => execution?.sourceRange ? execution.sourceRange(coordinates, location, encoding) : [coordinates.offset(location[0]!, location[1]!, encoding), coordinates.offset(location[2]!, location[3]!, encoding)];
        const run = store.begin(`${prefix}document:${file}`, context, inputFingerprint);
        const module = semanticKey("scip-document", [manifest.id, context, file]);
        store.batch(run, () => { store.addSymbol({ key: module, name: `<document:${file}>`, qualifiedName: file, kind: "scip-document", file, context }); });
        const infos = messages(doc.symbols);
        const infoBatch = Math.max(1, Math.floor(limits.batch / (1 + infos.reduce((max, info) => Math.max(max, messages(info.relationships).length), 0))));
        for (let offset = 0; offset < infos.length; offset += infoBatch) { signal?.throwIfAborted(); store.batch(run, () => infos.slice(offset, offset + infoBatch).forEach(value => information(run, value, file, expected))); await yieldBatch(); }
        for (let offset = 0; offset < observations.length; offset += limits.batch) { store.batch(run, () => {
          signal?.throwIfAborted();
          for (const value of observations.slice(offset, offset + limits.batch)) {
            const location = range(value); if (!location) throw Error("SCIP occurrence has no range");
            const [start, end] = sourceRange(location);
            const roles = Number(value.symbol_roles) || 0;
            if (!Number.isSafeInteger(roles) || roles < 0) throw Error("Invalid SCIP occurrence roles");
            const definition = !!(roles & 1) || !!(roles & 64);
            const diagnostics = messages(value.diagnostics).slice(0, 5).map(item => ({ severity: Number(item.severity), code: String(item.code ?? "").slice(0, 128), message: String(item.message ?? "").slice(0, 2048) }));
            const occurrence = coordinates.range(start, end, context, definition ? "definition" : roles & 2 ? "import" : "reference"); store.addOccurrence(occurrence, rawSource.length);
            const target = value.symbol ? symbol(String(value.symbol), file, expected) : module;
            let enclosing: number[] | undefined; let enclosingInvalid = false;
            try { enclosing = range(value, true); if (enclosing) { const [a, b] = sourceRange(enclosing); if (a > b || a > start || b < end) throw Error("SCIP enclosing range does not contain occurrence"); } }
            catch (error) { if (manifest.enclosingPolicy !== "diagnose") throw error; enclosingInvalid = true; store.diagnostic(run, "scip-enclosing-advisory-invalid", `${file}: ${String(error)}`); }
            store.addFact(run, { predicate: "scip.Occurrence", context, subject: target, occurrence: occurrence.key, value: { rawSymbol: value.symbol ?? "", roles, syntaxKind: value.syntax_kind ?? 0, enclosing: enclosingInvalid ? null : enclosing ?? null,
              ...(diagnostics.length ? { diagnostics, diagnosticsTruncated: messages(value.diagnostics).length > diagnostics.length } : {}),
              ...(enclosingInvalid ? { enclosingStatus: "invalid-advisory-excluded", reportedEnclosing: value.enclosing_range ?? [], reportedTypedEnclosing: value.single_line_enclosing_range ?? value.multi_line_enclosing_range ?? null } : {}) }, confidence: "exact", provenance });
            if (!value.symbol) continue;
            const confidence = ["compiler", "lsp"].includes(provenance.basis) ? "resolved" : "probable";
            if (definition) {
              store.addFact(run, { predicate: "common.Declaration", context, subject: target, occurrence: occurrence.key, value: { forward: !!(roles & 64) }, confidence: "exact", provenance });
              store.addFact(run, { predicate: "common.Definition", context, subject: target, object: target, occurrence: occurrence.key, value: { forward: !!(roles & 64), body: "not-established-by-scip" }, confidence: "exact", provenance });
            } else store.addFact(run, { predicate: "common.Reference", context, subject: module, object: target, occurrence: occurrence.key, confidence, provenance });
            if (roles & 2) store.addFact(run, { predicate: "common.Import", context, subject: module, object: target, occurrence: occurrence.key, confidence, provenance });
          }
        }); await yieldBatch(); }
        if (await digestFile(source, limits.maxSourceBytes, signal) !== expected) throw Error("SCIP source changed during ingestion");
        store.input(run, `source:${file}`, expected);
        store.seal(run, { status: "partial", mappingVersion: SCIP_SEMANTIC_VERSION, language: String(doc.language), provider: provenance.provider, definitions: "partial", references: "partial", calls: execution?.derive ? "see-owned-native-pass" : "unsupported", gaps: ["SCIP references/highlighting alone do not establish calls", "Coverage depends on producer and declared dependency environment"] });
        accepted.push(run); occurrences += observations.length;
      } catch (error) { if (signal?.aborted) throw error; rejected++; store.diagnostic(summary, "scip-document-rejected", `${file}: ${String(error)}`); }
    }
    if (!metadata || stream.digest() !== manifest.indexDigest) throw Error("SCIP framing/artifact changed during ingestion");
    for (const run of accepted) {
      const input = store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").get(run) as { resource: string; digest: string };
      if (await digestFile(path.join(root, input.resource.slice(7)), limits.maxSourceBytes, signal) !== input.digest) throw Error("Accepted SCIP source changed before publication");
    }
    for (const [file, expected] of Object.entries(manifest.inputs ?? {})) if (await digestFile(path.join(root, file)) !== expected) throw Error(`SCIP environment input changed before publication: ${file}`);
    if (execution?.requireAllDocuments && (rejected || !accepted.length)) throw Error("Managed producer requires all source documents to pass verification");
    store.seal(summary, { status: "partial", mappingVersion: SCIP_SEMANTIC_VERSION, provider: provenance.provider, ...(execution ? { executionVersion: execution.version } : {}), documents: documentCount, accepted: accepted.length, rejected, occurrences, excludedExternalLocals, protocolDigest: SCIP_PROTOCOL_DIGEST, calls: "unsupported", gaps: [execution ? "Managed producer; see context execution coverage" : "Artifact-level replacement; no compiler execution", ...(rejected ? ["Some documents rejected; previous assertions excluded"] : []), ...(excludedExternalLocals ? ["Unscoped external local-symbol metadata was diagnosed and excluded"] : [])] });
    if ((await inventoryFromDisk(root, directory, limits.maxDocuments * 2, signal)).inventory !== inventory.inventory) throw Error("SCIP repository inventory changed during ingestion");
    const derived = await execution?.derive?.(store, accepted, context, inputFingerprint, prefix.slice(0, -1)) ?? [];
    await execution?.verify(signal);
    const native = await retainProviders(store, inventory, parent, prefix.slice(0, -1));
    const others = parent ? (store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=?").all(parent) as Array<{ partition_key: string; run: number }>).filter(row => !row.partition_key.startsWith("scip/") && !row.partition_key.startsWith("clang/")).map(row => row.run) : [];
    signal?.throwIfAborted(); const publicationStarted = performance.now();
    const published = store.publish([...others, ...native, summary, ...accepted, ...derived], parent);
    const publicationMs = +(performance.now() - publicationStarted).toFixed(3);
    return { snapshot: published, context, status: "partial", documents: documentCount, accepted: accepted.length, rejected, occurrences, excludedExternalLocals, calls: "unsupported", durationMs: Math.round(performance.now() - started), publicationMs, publicationStagesMs: stages, sqlitePragmas: Object.fromEntries(["journal_mode", "synchronous"].map(name => [name, store.db.pragma(name, { simple: true })])), limits, protocolDigest: SCIP_PROTOCOL_DIGEST };
  } finally { try { await stream?.close(); } finally { store.close(); } }
}
