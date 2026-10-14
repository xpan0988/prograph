import path from "node:path";
import { readFile } from "node:fs/promises";
import { ts } from "ts-morph";
import { createProject, isTypeScriptFile } from "../../adapters/language/typescript/index.js";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import type { GraphData } from "../graph/schema.js";
import { canonical, digest, semanticKey, TYPESCRIPT_SEMANTIC_VERSION, type FactInput, type Provenance } from "./model.js";
import { SourceCoordinates } from "./coordinates.js";
import { SemanticStore } from "./store.js";

export interface SemanticIndexResult { snapshot: number; context: string; inputFingerprint: string; coverage: Record<string, unknown>; durationMs: number }

export async function indexSemanticFoundation(snapshot: RepositorySnapshot, graph: GraphData, filename: string): Promise<SemanticIndexResult> {
  const started = performance.now();
  const selected = snapshot.files.filter(isTypeScriptFile);
  const project = snapshot.config.adapters.typescript && selected.length ? createProject(snapshot) : undefined;
  const program = project?.getProgram().compilerObject;
  const store = new SemanticStore(filename);
  const parent = store.activeSnapshot();
  const context = semanticKey("context", [snapshot.repository.identity, "typescript-root-project", snapshot.fileContents.get("tsconfig.json") ?? snapshot.fileContents.get("jsconfig.json") ?? "inferred", ts.version]);
  const inputFingerprint = digest(canonical({ repository: [...snapshot.fileContents].map(([file, text]) => [file, digest(text)]).sort(), compiler: program?.getSourceFiles().map(source => [source.fileName, digest(source.text)]).sort() ?? [] }));
  const provenance: Provenance = { provider: "typescript/compiler-api", version: `${ts.version}/${TYPESCRIPT_SEMANTIC_VERSION}`, basis: "compiler", method: "compiler-binding", context, inputFingerprint };
  const run = store.begin("typescript/root", context, inputFingerprint);
  const bridge = store.begin("legacy/full", "legacy", inputFingerprint);
  const projection = store.begin("typescript/call-projection-v1", context, inputFingerprint);
  const projectionProvenance: Provenance = { ...provenance, provider: "call-projection", version: "1", method: "call-site-and-compiler-target" };
  const calls: Array<{ owner: string; target: string; occurrence: string; site: string; binding: string }> = [];
  let occurrenceCount = 0; let unresolved = 0;
  let coverage: Record<string, unknown> = { language: "typescript", provider: provenance.provider, symbols: "partial", definitions: "partial", references: "partial", calls: "partial", projectMode: "root-tsconfig-compatibility", gaps: ["Root project only; full project/build discovery is Step 2", "Static targets do not enumerate runtime dispatch"] };
  try {
    // Legacy data is explicitly bridged; it is never used as compiler semantic evidence.
    const bridgeProvenance: Provenance = { provider: "legacy-graph", version: graph.schemaVersion, basis: "syntax", method: "compatibility-bridge", context: "legacy", inputFingerprint };
    for (let offset = 0; offset < graph.nodes.length; offset += 1000) store.batch(bridge, () => {
      for (const original of graph.nodes.slice(offset, offset + 1000)) {
        const node = JSON.parse(JSON.stringify(original)) as typeof original;
        const key = `legacy:${node.id}:${digest(canonical(node))}`;
        store.addEntity(key, "artifact", node);
        store.addFact(bridge, { predicate: "legacy.Node", context: "legacy", subject: key, value: { node }, confidence: "exact", provenance: bridgeProvenance });
      }
    });
    for (let offset = 0; offset < graph.edges.length; offset += 1000) store.batch(bridge, () => {
      for (const original of graph.edges.slice(offset, offset + 1000)) {
        const edge = JSON.parse(JSON.stringify(original)) as typeof original;
        const key = `legacy:${edge.id}:${digest(canonical(edge))}`;
        store.addEntity(key, "artifact", edge);
        store.addFact(bridge, { predicate: "legacy.Relation", context: "legacy", subject: key, value: { edge }, confidence: edge.confidence, provenance: bridgeProvenance });
      }
    });
    if (program) {
      const checker = program.getTypeChecker();
      const symbols = new Map<ts.Symbol, string>();
      const scopes = new Map<ts.Node, string>();
      const declarationClaims = new Map<string, string>();
      const inputFiles = new Map<string, string>();
      const bundledLibraries = new Set<string>();
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
        inputFiles.set(source.fileName, digest(source.text));
        if (program.isSourceFileDefaultLibrary(source)) bundledLibraries.add(source.fileName);
      }
      // A compiler must see the exact scanner snapshot; do not publish a mixed source version.
      for (const file of selected) {
        const source = program.getSourceFile(snapshot.absoluteFiles.get(file)!);
        if (!source || source.text !== snapshot.fileContents.get(file)) throw new Error(`Source changed before semantic extraction: ${file}`);
      }
      for (const file of selected) {
        const source = program.getSourceFile(snapshot.absoluteFiles.get(file)!)!;
        const errors = program.getSemanticDiagnostics(source).filter(d => d.category === ts.DiagnosticCategory.Error && d.start !== undefined);
        for (const error of errors) store.diagnostic(run, `typescript-${error.code}`, ts.flattenDiagnosticMessageText(error.messageText, "\n"));
        const coordinates = new SourceCoordinates(file, source.text); const bytes = Buffer.byteLength(source.text);
        const nodes: ts.Node[] = []; const walk = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, walk); }; walk(source);
        let module = "";
        store.batch(run, () => {
          module = moduleScope(source);
          const o = coordinates.range(0, 0, context, "module"); store.addOccurrence(o, bytes);
          store.addFact(run, { predicate: "common.Declaration", context, subject: module, occurrence: o.key, confidence: "exact", provenance });
          store.addFact(run, { predicate: "common.Definition", context, subject: module, object: module, occurrence: o.key, confidence: "exact", provenance });
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
                const declaration = store.addFact(run, { predicate: "common.Declaration", context, subject: target, occurrence: o.key, value: { signature: node.getText(source).slice(0, 512) }, confidence: "exact", provenance });
                declarationClaims.set(target, declaration);
                store.addFact(run, { predicate: "common.Definition", context, subject: target, object: target, occurrence: o.key, value: { hasBody: "body" in node && !!node.body }, confidence: "exact", provenance });
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
              if (!declarationClaims.has(key)) declarationClaims.set(key, store.addFact(run, { predicate: "common.Declaration", context, subject: key, occurrence: o.key, confidence: "exact", provenance }));
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
                store.addFact(run, { predicate: "common.Reference", context, subject: owner(node), object: target, occurrence: o.key, confidence: "resolved", provenance });
              }
            }
            if (ts.isImportDeclaration(node)) {
              const symbol = originalSymbol(node.moduleSpecifier); const o = coordinates.range(node.moduleSpecifier.getStart(source), node.moduleSpecifier.getEnd(), context, "import"); store.addOccurrence(o, bytes);
              if (symbol) store.addFact(run, { predicate: "common.Import", context, subject: module, object: ensure(symbol), occurrence: o.key, value: { specifier: node.moduleSpecifier.getText(source) }, confidence: "resolved", provenance });
              else { unresolved++; store.diagnostic(run, "unresolved-import", node.moduleSpecifier.getText(source)); }
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
              const caller = owner(node); const o = coordinates.range(node.getStart(source), node.getEnd(), context, "call"); store.addOccurrence(o, bytes); occurrenceCount++;
              const site = store.addFact(run, { predicate: "common.CallSite", context, subject: caller, occurrence: o.key, value: { expression: node.expression.getText(source).slice(0, 256) }, confidence: "exact", provenance: { ...provenance, basis: "syntax", method: "call-expression" } });
              const signature = checker.getResolvedSignature(node); const declaration = signature?.declaration;
              const targetNode = declaration && (declaration as ts.NamedDeclaration).name;
              const symbol = targetNode ? originalSymbol(targetNode) : originalSymbol(node.expression);
              const hasErrorType = !!((checker.getTypeAtLocation(node.expression).flags) & ts.TypeFlags.Any);
              const erroneous = errors.some(d => d.start! < node.getEnd() && d.start! + (d.length ?? 0) >= node.getStart(source));
              if (symbol && declaration && !hasErrorType && !erroneous) {
                const target = ensure(symbol, declaration);
                const binding = store.addFact(run, { predicate: "common.CallTarget", context, subject: caller, object: target, occurrence: o.key, value: { dispatch: "static", signature: checker.signatureToString(signature!).slice(0, 512) }, confidence: "resolved", provenance });
                calls.push({ owner: caller, target, occurrence: o.key, site, binding });
              } else { unresolved++; store.diagnostic(run, "unresolved-call", node.expression.getText(source)); }
            }
            if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
              const o = coordinates.range(node.getStart(source), node.getEnd(), context, "jsx"); store.addOccurrence(o, bytes);
              store.addFact(run, { predicate: "common.Facet", context, subject: owner(node), occurrence: o.key, value: { facet: "jsx-bearing-function" }, confidence: "exact", provenance: { ...provenance, basis: "syntax", method: "jsx-observation" } });
            }
          }
        });
      }
      // This foundation is project-granular and records the whole source inventory as a selector.
      store.batch(run, () => { for (const [file, text] of snapshot.fileContents) store.input(run, file, digest(text)); for (const [file, hash] of inputFiles) store.input(run, `compiler:${relative(file)}`, hash); store.selector(run, `typescript:${context}:inventory`, inputFingerprint); });
      // Verify loaded compiler dependencies too; missing/changing ambient inputs cannot be called fresh.
      for (const [file, hash] of inputFiles) if (!bundledLibraries.has(file) && digest(await readFile(file)) !== hash) throw new Error(`Compiler input changed during extraction: ${relative(file)}`);
      coverage = { ...coverage, status: "partial", sourceFiles: selected.length, occurrences: occurrenceCount, unresolved, gaps: [...coverage.gaps as string[], "Declarations/references from supported compiler AST forms; not an exhaustive native type index"] };
    } else coverage = { language: "typescript", status: "unavailable", gaps: ["TypeScript adapter disabled or no applicable sources"] };
    // No source/config edit during the second pass may be silently published.
    for (const [file, text] of snapshot.fileContents) if (digest(await readFile(snapshot.absoluteFiles.get(file)!)) !== digest(text)) throw new Error(`Repository input changed during semantic indexing: ${file}`);
    for (let offset = 0; offset < calls.length; offset += 1000) store.batch(projection, () => {
      for (const call of calls.slice(offset, offset + 1000)) store.addFact(projection, { predicate: "common.CallSummary", context, subject: call.owner, object: call.target, occurrence: call.occurrence, confidence: "resolved", provenance: projectionProvenance,
        supports: [[{ claim: call.site }, { claim: call.binding }, { selector: `typescript:${context}:inventory`, digest: inputFingerprint }]] });
    });
    store.seal(run, coverage); store.seal(bridge, { status: "legacy", schema: graph.schemaVersion, gaps: ["Legacy facts have no safe per-file ownership; whole-run replacement only"] }); store.seal(projection, { status: "partial", pass: "call-projection", version: "1" });
    const published = store.publish([run, bridge, projection], parent);
    return { snapshot: published, context, inputFingerprint, coverage, durationMs: Math.round(performance.now() - started) };
  } finally { store.close(); }
}
