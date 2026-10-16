import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { Project, ts } from "ts-morph";
import { isTypeScriptFile } from "../../adapters/language/typescript/index.js";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import type { GraphData } from "../graph/schema.js";
import { canonical, digest, semanticKey, TYPESCRIPT_SEMANTIC_VERSION, type FactInput, type Provenance } from "./model.js";
import { SourceCoordinates } from "./coordinates.js";
import { SemanticStore } from "./store.js";
import { discoverProjects, type ProjectUnit } from "./projects.js";
import { executePasses, qualifiedCallProjection } from "./passes.js";
import { retainProviders } from "./provider-runs.js";
import { inputMatches } from "./input-check.js";
import { traceCompilerInputs } from "./typescript-inputs.js";

export interface SemanticIndexResult { snapshot: number; context: string; inputFingerprint: string; coverage: Record<string, unknown>; durationMs: number }

async function indexTypeScriptUnit(snapshot: RepositorySnapshot, unit: ProjectUnit, store: SemanticStore): Promise<{ runs: number[]; context: string; inputFingerprint: string; coverage: Record<string, unknown> }> {
  const started = performance.now();
  const require = createRequire(import.meta.url);
  const compilerBundle = require.resolve("@ts-morph/common");
  const selected = unit.sources;
  const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: unit.compilerOptions ?? {} });
  const compilerInputs = traceCompilerInputs(project.getFileSystem());
  // These are exact scanner-selected files, not glob patterns. Glob expansion also
  // enumerates unrelated output directories and cannot qualify module-search inputs.
  for (const file of selected) project.addSourceFileAtPath(snapshot.absoluteFiles.get(file)!);
  const program = project?.getProgram().compilerObject;
  const context = unit.context;
  const inputFingerprint = digest(canonical({ plan: unit.fingerprint, compiler: program.getSourceFiles().map(source => [source.fileName, digest(source.text)]).sort() }));
  const provenance: Provenance = { provider: "typescript/compiler-api", version: `${ts.version}/${TYPESCRIPT_SEMANTIC_VERSION}`, basis: "compiler", method: "compiler-binding", context, inputFingerprint };
  const run = store.begin(unit.key, context, inputFingerprint);
  store.batch(run, () => { for (const input of unit.probes) store.input(run, input.resource, input.digest); });
  const documentRuns: number[] = [];
  let pending: FactInput[] = []; let pendingBytes = 0;
  const emit = (fact: FactInput): string => {
    pendingBytes += Buffer.byteLength(canonical(fact));
    if (pending.length >= 250000 || pendingBytes > 32 * 1024 ** 2) throw Error("TypeScript document exceeds semantic fact budget");
    pending.push(fact); return fact.subject; // Declaration bookkeeping uses membership only.
  };
  let occurrenceCount = 0; let unresolved = 0; let compilerErrors = 0; let externalImports = 0;
  let coverage: Record<string, unknown> = { language: "typescript", provider: provenance.provider, mappingVersion: TYPESCRIPT_SEMANTIC_VERSION, symbols: "partial", definitions: "partial", references: "partial", calls: "partial", project: unit.project, projectMode: unit.options.mode, gaps: [...unit.gaps, "Static targets do not enumerate runtime dispatch"] };
  try {
    if (program) {
      const checker = program.getTypeChecker();
      const symbols = new Map<ts.Symbol, string>();
      const scopes = new Map<ts.Node, string>();
      const declarationClaims = new Map<string, string>();
      const inputFiles = new Map<string, string>();
      const relative = (file: string) => path.relative(snapshot.repository.root, file).split(path.sep).join("/");
      const ensure = (symbol: ts.Symbol, declaration?: ts.Declaration): string => {
        let found = symbols.get(symbol); if (found) return found;
        const declarations = symbol.getDeclarations() ?? (declaration ? [declaration] : []);
        const d = declarations[0]; const file = d ? relative(d.getSourceFile().fileName) : "<external>";
        const ancestry: string[] = [];
        let current: ts.Node | undefined = d;
        while (current && !ts.isSourceFile(current)) {
          const named = current as ts.NamedDeclaration;
          if (named.name) ancestry.push(`${ts.getCombinedModifierFlags(current as ts.Declaration) & ts.ModifierFlags.Static ? "static " : ""}${named.name.getText()}`);
          else if (ts.isFunctionLike(current)) ancestry.push(`<anonymous@${current.getStart()}>`);
          else if (ts.isBlock(current) && !ts.isFunctionLike(current.parent)) ancestry.push(`<block@${current.getStart()}>`);
          current = current.parent;
        }
        // JS inferred properties can be declared by `this.x = ...` BinaryExpressions;
        // their owner ancestry alone would collapse x and y into the same identity.
        if (d && !(d as ts.NamedDeclaration).name) ancestry.unshift(symbol.getName());
        const qualified = `${file}::${ancestry.reverse().join("::") || symbol.getName()}`;
        // Local bindings with the same spelling in distinct blocks retain a location discriminator.
        const local = d && (ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isBindingElement(d));
        found = semanticKey("symbol", [snapshot.repository.identity, context, qualified, symbol.flags, local ? d.getStart() : null]);
        store.addSymbol({ key: found, name: symbol.getName(), qualifiedName: qualified, kind: d ? ts.SyntaxKind[d.kind] : "external", file, context });
        symbols.set(symbol, found); return found;
      };
      const moduleScope = (source: ts.SourceFile): string => {
        const symbol = checker.getSymbolAtLocation(source);
        if (symbol) return ensure(symbol);
        const file = relative(source.fileName); const key = semanticKey("symbol", [snapshot.repository.identity, context, file, "module-initializer"]);
        store.addSymbol({ key, name: `<module:${file}>`, qualifiedName: file, kind: "module", file, context }); return key;
      };
      const originalSymbol = (node: ts.Node): ts.Symbol | undefined => {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) { try { symbol = checker.getAliasedSymbol(symbol); } catch { return undefined; } }
        return symbol && symbol.getName() !== "unknown" ? symbol : undefined;
      };
      for (const source of program.getSourceFiles()) {
        // Track actual compiler inputs, including libraries/config dependencies, without indexing dependency trees.
        // ts-morph embeds default library texts in this bundle under virtual paths.
        // Track the physical bundle, rather than pretending /node_modules/... exists.
        if (!program.isSourceFileDefaultLibrary(source)) inputFiles.set(source.fileName, digest(source.text));
      }
      for (const file of [compilerBundle, path.join(path.dirname(compilerBundle), "typescript.js")]) inputFiles.set(file, digest(await readFile(file)));
      // A compiler must see the exact scanner snapshot; do not publish a mixed source version.
      for (const file of selected) {
        const source = program.getSourceFile(snapshot.absoluteFiles.get(file)!);
        if (!source || source.text !== snapshot.fileContents.get(file)) throw new Error(`Source changed before semantic extraction: ${file}`);
      }
      for (const file of selected) {
        pending = []; pendingBytes = 0;
        const source = program.getSourceFile(snapshot.absoluteFiles.get(file)!)!;
        const errors = program.getSemanticDiagnostics(source).filter(d => d.category === ts.DiagnosticCategory.Error && d.start !== undefined);
        compilerErrors += errors.length;
        for (const error of errors) store.diagnostic(run, `typescript-${error.code}`, ts.flattenDiagnosticMessageText(error.messageText, "\n"));
        const coordinates = new SourceCoordinates(file, source.text); const bytes = Buffer.byteLength(source.text);
        const nodes: ts.Node[] = []; const walk = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, walk); }; walk(source);
        let module = "";
        store.batch(run, () => {
          module = moduleScope(source);
          const o = coordinates.range(0, 0, context, "module"); store.addOccurrence(o, bytes);
          emit({ predicate: "common.Declaration", context, subject: module, occurrence: o.key, confidence: "exact", provenance });
          emit({ predicate: "common.Definition", context, subject: module, object: module, occurrence: o.key, confidence: "exact", provenance });
        });
        // First pass creates declarations and execution-scope identities, including nested lambdas.
        for (let offset = 0; offset < nodes.length; offset += 1000) store.batch(run, () => {
          for (const node of nodes.slice(offset, offset + 1000)) {
            const named = node as ts.NamedDeclaration;
            if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name)) && (ts.isDeclarationStatement(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isBindingElement(node))) {
              const symbol = checker.getSymbolAtLocation(named.name);
              if (symbol) {
                const target = ensure(symbol, node as ts.Declaration);
                const o = coordinates.range(named.name.getStart(source), named.name.getEnd(), context, "definition"); store.addOccurrence(o, bytes); occurrenceCount++;
                const declaration = emit({ predicate: "common.Declaration", context, subject: target, occurrence: o.key, value: { signature: node.getText(source).slice(0, 512) }, confidence: "exact", provenance });
                declarationClaims.set(target, declaration);
                if (ts.isFunctionLike(node)) emit({ predicate: "typescript.Signature", context, subject: target, occurrence: o.key, value: { syntaxKind: ts.SyntaxKind[node.kind], signature: node.getText(source).slice(0, 1024), compilerVersion: ts.version }, confidence: "exact", provenance });
                emit({ predicate: "common.Definition", context, subject: target, object: target, occurrence: o.key, value: { hasBody: "body" in node && !!node.body }, confidence: "exact", provenance });
                if (ts.isFunctionLike(node)) scopes.set(node, target);
              }
            }
            if (ts.isFunctionLike(node) && !scopes.has(node)) {
              const variable = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
              const symbol = variable ? checker.getSymbolAtLocation(variable.name) : undefined;
              const key = symbol ? ensure(symbol, variable) : semanticKey("symbol", [snapshot.repository.identity, context, file, "execution-scope", node.getStart(source)]);
              if (!symbol) store.addSymbol({ key, name: `<lambda@${node.getStart(source)}>`, qualifiedName: `${file}::<lambda@${node.getStart(source)}>`, kind: "lambda", file, context });
              scopes.set(node, key);
              const o = coordinates.range(node.getStart(source), node.getStart(source), context, "execution-scope"); store.addOccurrence(o, bytes);
              if (!declarationClaims.has(key)) declarationClaims.set(key, emit({ predicate: "common.Declaration", context, subject: key, occurrence: o.key, confidence: "exact", provenance }));
            }
          }
        });
        const owner = (node: ts.Node): string => {
          let current: ts.Node | undefined = node.parent;
          while (current) { const found = scopes.get(current); if (found) return found; current = current.parent; } return module;
        };
        for (let offset = 0; offset < nodes.length; offset += 1000) store.batch(run, () => {
          for (const node of nodes.slice(offset, offset + 1000)) {
            if (ts.isIdentifier(node) || ts.isStringLiteral(node) && ts.isImportDeclaration(node.parent)) {
              const parentName = (node.parent as ts.NamedDeclaration).name;
              if (parentName === node && !ts.isPropertyAccessExpression(node.parent)) continue;
              const symbol = originalSymbol(node);
              if (symbol) {
                const target = ensure(symbol); const o = coordinates.range(node.getStart(source), node.getEnd(), context, "reference"); store.addOccurrence(o, bytes); occurrenceCount++;
                emit({ predicate: "common.Reference", context, subject: owner(node), object: target, occurrence: o.key, confidence: "resolved", provenance });
              }
            }
            if (ts.isImportDeclaration(node)) {
              if (ts.isStringLiteral(node.moduleSpecifier) && !node.moduleSpecifier.text.startsWith(".")) externalImports++;
              const symbol = originalSymbol(node.moduleSpecifier); const o = coordinates.range(node.moduleSpecifier.getStart(source), node.moduleSpecifier.getEnd(), context, "import"); store.addOccurrence(o, bytes);
              if (symbol) emit({ predicate: "common.Import", context, subject: module, object: ensure(symbol), occurrence: o.key, value: { specifier: node.moduleSpecifier.getText(source) }, confidence: "resolved", provenance });
              else { unresolved++; store.diagnostic(run, "unresolved-import", node.moduleSpecifier.getText(source)); }
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
              const caller = owner(node); const o = coordinates.range(node.getStart(source), node.getEnd(), context, "call"); store.addOccurrence(o, bytes); occurrenceCount++;
              const site = emit({ predicate: "common.CallSite", context, subject: caller, occurrence: o.key, value: { expression: node.expression.getText(source).slice(0, 256) }, confidence: "exact", provenance: { ...provenance, basis: "syntax", method: "call-expression" } });
              const signature = checker.getResolvedSignature(node); const declaration = signature?.declaration;
              const targetNode = declaration && (declaration as ts.NamedDeclaration).name;
              const symbol = targetNode ? originalSymbol(targetNode) : originalSymbol(node.expression);
              const hasErrorType = !!((checker.getTypeAtLocation(node.expression).flags) & ts.TypeFlags.Any);
              const erroneous = errors.some(d => d.start! < node.getEnd() && d.start! + (d.length ?? 0) >= node.getStart(source));
              if (symbol && declaration && !hasErrorType && !erroneous) {
                const target = ensure(symbol, declaration);
                const binding = emit({ predicate: "common.CallTarget", context, subject: caller, object: target, occurrence: o.key, value: { dispatch: "static", signature: checker.signatureToString(signature!).slice(0, 512) }, confidence: "resolved", provenance });
              } else { unresolved++; store.diagnostic(run, "unresolved-call", node.expression.getText(source)); }
            }
            if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
              const o = coordinates.range(node.getStart(source), node.getEnd(), context, "jsx"); store.addOccurrence(o, bytes);
              emit({ predicate: "common.Facet", context, subject: owner(node), occurrence: o.key, value: { facet: "jsx-bearing-function" }, confidence: "exact", provenance: { ...provenance, basis: "syntax", method: "jsx-observation" } });
            }
          }
        });
        // Resolution still observes the complete compiler project. Output ownership is per
        // document: unchanged output (including inferred signatures/targets) reuses its seal.
        const fingerprint = digest(canonical(["typescript-document-ownership-1", context, file, digest(source.text),
          TYPESCRIPT_SEMANTIC_VERSION, pending.map(fact => ({ ...fact, provenance: { ...fact.provenance, inputFingerprint: "" } }))]));
        const partition = `${unit.key}/document:${file}`; const selector = `typescript:${context}:document:${file}`;
        const cached = store.reusable(partition, context, fingerprint);
        if (cached?.coverage.mappingVersion === TYPESCRIPT_SEMANTIC_VERSION) {
          const previous = store.reusable(`${partition}/pass:call-summary@1`, context, fingerprint);
          documentRuns.push(cached.id, ...qualifiedCallProjection(store, cached.id, partition, previous?.id));
        } else {
          const document = store.begin(partition, context, fingerprint);
          for (let at = 0; at < pending.length; at += 500) store.batch(document, () => {
            for (const fact of pending.slice(at, at + 500)) store.addFact(document, { ...fact, provenance: { ...fact.provenance, inputFingerprint: fingerprint } });
          });
          store.input(document, `source:${file}`, digest(source.text)); store.selector(document, selector, fingerprint);
          store.seal(document, { status: "partial", mappingVersion: TYPESCRIPT_SEMANTIC_VERSION, ownershipShard: "compiler-document", file, facts: pending.length });
          documentRuns.push(document, ...executePasses(store, document, partition, { ...provenance, inputFingerprint: fingerprint }, selector));
        }
      }
      // Project-level inputs and negative search-space inventory qualify every document.
      // A source/config change reruns resolution; identical document outputs reuse storage.
      store.batch(run, () => { for (const file of selected) store.input(run, `source:${file}`, digest(snapshot.fileContents.get(file)!)); for (const [file, hash] of Object.entries(unit.inputs)) store.input(run, `physical:${file}`, hash); for (const [file, hash] of inputFiles) store.input(run, `physical:${file}`, hash); store.input(run, "inventory", unit.fingerprint); store.selector(run, `typescript:${context}:inventory`, inputFingerprint); });
      // Verify loaded compiler dependencies too; missing/changing ambient inputs cannot be called fresh.
      for (const [file, hash] of inputFiles) if (digest(await readFile(file)) !== hash) throw new Error(`Compiler input changed during extraction: ${relative(file)}`);
      await compilerInputs.verify();
      store.batch(run, () => { for (const input of compilerInputs.entries()) store.input(run, input.resource, input.digest); });
      coverage = { ...coverage, status: "partial", sourceFiles: selected.length, occurrences: occurrenceCount, unresolved, compilerErrors, externalImports, gaps: [...coverage.gaps as string[], "Declarations/references from supported compiler AST forms; not an exhaustive native type index"] };
    } else coverage = { language: "typescript", status: "unavailable", gaps: ["TypeScript adapter disabled or no applicable sources"] };
    // No source/config edit during the second pass may be silently published.
    for (const file of selected) if (digest(await readFile(snapshot.absoluteFiles.get(file)!)) !== digest(snapshot.fileContents.get(file)!)) throw new Error(`Repository input changed during semantic indexing: ${file}`);
    for (const [file, hash] of Object.entries(unit.inputs)) if (digest(await readFile(file)) !== hash) throw Error(`Project configuration changed during extraction: ${file}`);
    for (const input of unit.probes) if (!await inputMatches(input, snapshot.repository.root)) throw Error(`Project resolution input changed during extraction: ${input.resource}`);
    store.seal(run, coverage);
    return { runs: [run, ...documentRuns], context, inputFingerprint, coverage };
  } catch (error) { store.diagnostic(run, "provider-failure", String(error)); throw error; }
}

async function reusableUnit(store: SemanticStore, snapshot: RepositorySnapshot, unit: ProjectUnit, previous: Map<string, number>): Promise<number[] | undefined> {
  const run = previous.get(unit.key);
  if (!run) return undefined;
  const row = store.sql("SELECT context,coverage_json FROM sc_runs WHERE id=?").get(run) as { context: string; coverage_json: string };
  const coverage = JSON.parse(row.coverage_json) as Record<string, unknown>;
  // Reuse remains conservative: closed, error-free local units plus observed negative search inputs.
  if (row.context !== unit.context || coverage.mappingVersion !== TYPESCRIPT_SEMANTIC_VERSION || coverage.unresolved !== 0 || coverage.compilerErrors !== 0 || coverage.externalImports !== 0) return undefined;
  const inputs = store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").all(run) as Array<{ resource: string; digest: string }>;
  if (!inputs.some(input => input.resource === "inventory" && input.digest === unit.fingerprint)) return undefined;
  for (const input of inputs) {
    if (input.resource.startsWith("probe-") && !await inputMatches(input, snapshot.repository.root)) return undefined;
    if (input.resource.startsWith("source:")) { const text = snapshot.fileContents.get(input.resource.slice(7)); if (text === undefined || digest(text) !== input.digest) return undefined; }
    else if (input.resource.startsWith("physical:")) {
      const file = input.resource.slice(9);
      const require = createRequire(import.meta.url); const bundle = require.resolve("@ts-morph/common");
      const sdk = new Set([bundle, path.join(path.dirname(bundle), "typescript.js")]);
      // Only embedded compiler artifacts are exempt from the closed local-unit rule.
      // Outside source/ambient/module search spaces still prevent compiler skipping.
      if (!sdk.has(file) && (file.includes("/node_modules/") || !file.startsWith(`${snapshot.repository.root}/`))) return undefined;
      try { if (digest(await readFile(file)) !== input.digest) return undefined; } catch { return undefined; }
    }
  }
  const documents = [...previous].filter(([key]) => key.startsWith(`${unit.key}/document:`));
  if (documents.filter(([key]) => !key.includes("/pass:")).length !== unit.sources.length) return undefined;
  return [run, ...documents.map(([, id]) => id)];
}

export async function indexSemanticFoundation(snapshot: RepositorySnapshot, graph: GraphData, filename: string, owned?: { runs: number[]; parent: number | undefined }): Promise<SemanticIndexResult> {
  const started = performance.now(); const plan = discoverProjects(snapshot);
  if (plan.diagnostics.some(message => message.startsWith("Invalid TypeScript project")) && !plan.units.some(unit => unit.language === "typescript" && unit.project !== "<inferred>")) throw Error(plan.diagnostics.join("; "));
  const store = new SemanticStore(filename); const parent = store.activeSnapshot();
  const previous = new Map((parent ? store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=?").all(parent) : [] as unknown[]) .map(value => { const row = value as { partition_key: string; run: number }; return [row.partition_key, row.run] as const; }));
  const inputFingerprint = digest(canonical([...snapshot.fileContents].map(([file, text]) => [file, digest(text)]).sort()));
  const runs: number[] = [...(owned?.runs ?? [])]; const outcomes: Record<string, unknown>[] = [];
  try {
    if (owned && owned.parent !== parent) throw Error("Owned analysis parent changed before publication");
    if (!owned) {
    const bridge = store.begin("legacy/full", "legacy", inputFingerprint);
    const provenance: Provenance = { provider: "legacy-graph", version: graph.schemaVersion, basis: "syntax", method: "compatibility-bridge", context: "legacy", inputFingerprint };
    for (const [predicate, values] of [["legacy.Node", graph.nodes], ["legacy.Relation", graph.edges]] as const) {
      for (let offset = 0; offset < values.length; offset += 1000) store.batch(bridge, () => {
        for (const original of values.slice(offset, offset + 1000)) {
          const value = JSON.parse(JSON.stringify(original)) as typeof original; const key = `legacy:${value.id}:${digest(canonical(value))}`;
          store.addEntity(key, "artifact", value);
          const payload = predicate === "legacy.Node" ? { node: value } : { edge: value };
          // Legacy metadata/evidence can exceed common fact quotas. Preserve its complete immutable
          // artifact and graph.sqlite record; carry a bounded reference instead of failing all semantics.
          const boundedPayload = Buffer.byteLength(canonical(payload)) <= 65536 ? payload : { legacyId: value.id, payloadEntity: key, payloadBytes: Buffer.byteLength(canonical(value)), payloadStorage: "sc_entities.canonical" };
          store.addFact(bridge, { predicate, context: "legacy", subject: key, value: boundedPayload, confidence: "confidence" in value ? value.confidence : "exact", provenance });
        }
      });
    }
    store.seal(bridge, { status: "legacy", schema: graph.schemaVersion, gaps: ["Whole legacy partition replacement"] }); runs.push(bridge);
    }
    for (const unit of plan.units) {
      const discoveryGaps = [...unit.gaps, ...plan.diagnostics.slice(0, 4).map(message => message.slice(0, 256))];
      const run = store.begin(`context/${unit.key}`, unit.context, unit.fingerprint);
      store.batch(run, () => {
        const key = semanticKey("project", [snapshot.repository.identity, unit.key]); store.addEntity(key, "artifact", { key, kind: "project" });
        store.addFact(run, { predicate: "context.Project", context: unit.context, subject: key, value: { unit: unit.key, project: unit.project, language: unit.language, options: unit.options, sourceCount: unit.sources.length, fingerprint: unit.fingerprint, gaps: discoveryGaps }, confidence: "exact", provenance: { provider: "project-discovery", version: "1", basis: "syntax", method: "read-only-project-context", context: unit.context, inputFingerprint: unit.fingerprint } });
      });
      store.seal(run, { status: "partial", language: unit.language, gaps: discoveryGaps }); runs.push(run);
      if (unit.language === "typescript" && snapshot.config.adapters.typescript && unit.sources.length) {
        const reused = await reusableUnit(store, snapshot, unit, previous);
        if (reused) { runs.push(...reused); outcomes.push({ status: "partial", project: unit.project, reused: true }); }
        else { const indexed = await indexTypeScriptUnit(snapshot, unit, store); runs.push(...indexed.runs); outcomes.push(indexed.coverage); }
      }
    }
    const nativeRuns = await retainProviders(store, snapshot, parent); runs.push(...nativeRuns);
    // One final cross-unit barrier: an earlier unit's dependency can change while
    // a later compiler is running. Verify selected inputs before the single CAS.
    const checked = new Set<string>();
    for (const run of runs) for (const input of store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").all(run) as Array<{ resource: string; digest: string }>) {
      const key = canonical(input); if (checked.has(key)) continue; checked.add(key);
      if (!await inputMatches(input, snapshot.repository.root)) throw Error(`Semantic input changed before publication: ${input.resource}`);
    }
    const snapshotId = store.publish(runs, parent);
    const tsUnits = plan.units.filter(unit => unit.language === "typescript");
    return { snapshot: snapshotId, context: (tsUnits.find(unit => unit.key === "typescript/root") ?? tsUnits[0])?.context ?? "none", inputFingerprint, coverage: { status: outcomes.length || nativeRuns.length ? "partial" : "unavailable", projects: tsUnits.length, units: outcomes, reusedUnits: outcomes.filter(outcome => outcome.reused).length, retainedNativeRuns: nativeRuns.length }, durationMs: Math.round(performance.now() - started) };
  } finally { store.close(); }
}
