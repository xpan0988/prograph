import { ts } from "ts-morph";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { AdapterResult } from "../adapters/contracts.js";
import type { GraphNode, GraphEdge, Confidence } from "../graph/schema.js";
import { tauriRoots, tauriScope, type BoundaryIdentity } from "../graph/boundaries.js";
import { SourceCoordinates } from "./coordinates.js";
import { semanticKey, type Predicate } from "./model.js";
import { OwnedWriter } from "./owned-projection.js";


interface CallRange { start: number; end: number; callee: string; argument?: string; tauri: boolean; macro?: boolean }
function callRanges(file: string, source: string): CallRange[] {
  const ranges: CallRange[] = [];
  if (/\.(?:tsx?|jsx?|mts|cts)$/.test(file)) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
    host.getSourceFile = name => name === file ? tree : undefined; host.fileExists = name => name === file; host.readFile = name => name === file ? source : undefined;
    const program = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, host); const checker = program.getTypeChecker();
    const tauriBinding = (expression: ts.Expression) => {
      const leaf = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      const declarations = checker.getSymbolAtLocation(leaf)?.getDeclarations() ?? [];
      return declarations.some(declaration => {
        let cursor: ts.Node | undefined = declaration;
        while (cursor && !ts.isImportDeclaration(cursor)) cursor = cursor.parent;
        return cursor && ts.isImportDeclaration(cursor) && ts.isStringLiteral(cursor.moduleSpecifier) && /^@tauri-apps\/api(?:\/|$)/.test(cursor.moduleSpecifier.text);
      });
    };
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) ranges.push({ start: node.getStart(tree), end: node.end, callee: node.expression.getText(tree), tauri: tauriBinding(node.expression),
        ...(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? { argument: node.arguments[0].text } : {}) });
      ts.forEachChild(node, walk);
    }; walk(tree);
  } else if (file.endsWith(".rs")) {
    const parser = new Parser(); parser.setLanguage(Rust as unknown as Parser.Language);
    const tree = parser.parse(source);
    {
      for (const node of tree.rootNode.descendantsOfType("macro_invocation")) {
        if (!node.hasError) ranges.push({ start: node.startIndex, end: node.endIndex, callee: node.childForFieldName("macro")?.text ?? "", tauri: true, macro: true });
      }
      for (const node of tree.rootNode.descendantsOfType("call_expression")) {
        if (node.hasError) continue;
        const callee = node.childForFieldName("function")?.text ?? "";
        // tree-sitter's JS binding exposes UTF-16 indices, as used by the existing Rust adapter.
        ranges.push({ start: node.startIndex, end: node.endIndex, callee, tauri: true });
      }
    }
  }
  return ranges;
}

/** Qualified syntax/explicit-configuration evidence; this pass never emits ordinary call targets. */
export function deriveBoundaries(writer: OwnedWriter, input: AdapterResult, edgeClaims: Map<string, string>): Record<string, unknown> {
  const { snapshot, store, run } = writer; const context = writer.provenance.context;
  const nodes = new Map(input.nodes.map(node => [node.id, node]));
  const roots = tauriRoots(snapshot); const calls = new Map<string, CallRange[]>();
  const operations = new Map<string, { identity: BoundaryIdentity; key: string; claim: string }>();
  const participants: { predicate: Predicate; symbol: string; operation: string; claim: string; confidence: Confidence }[] = [];
  let rejected = 0;
  const operation = (identity: BoundaryIdentity, supports: string[][]) => {
    const encoded = JSON.stringify([identity.protocol, identity.namespace, identity.operation]);
    const existing = operations.get(encoded); if (existing) return existing;
    const key = semanticKey("boundary-operation", [snapshot.repository.identity, identity]); store.addEntity(key, "artifact", { key, ...identity });
    const claim = store.batch(run, () => writer.fact({ predicate: "boundary.Operation", subject: key, value: { ...identity }, confidence: "exact" }, supports));
    const value = { identity, key, claim }; operations.set(encoded, value); return value;
  };
  const symbol = (node: GraphNode) => {
    const key = semanticKey("boundary-participant", [snapshot.repository.identity, context, node.id]);
    store.addSymbol({ key, name: node.name, qualifiedName: node.qualifiedName, kind: String(node.metadata.originalKind ?? node.kind), file: node.file ?? "", context }); return key;
  };
  const occurrence = (file: string, line: number, column: number | undefined, role: string, expectedArgument?: string, requireTauri = false) => {
    const source = snapshot.fileContents.get(file); if (source === undefined) return undefined;
    const coordinates = new SourceCoordinates(file, source, true);
    let position: number; try { position = coordinates.offset(line - 1, (column ?? 1) - 1, 2); } catch { return undefined; }
    let ranges = calls.get(file); if (!ranges) { ranges = callRanges(file, source); calls.set(file, ranges); }
    const candidates = ranges.filter(range => !range.macro && (column === undefined ? coordinates.position(range.start).line === line : range.start <= position && position < range.end) &&
      (expectedArgument === undefined || range.argument === expectedArgument) && (!requireTauri || range.tauri));
    // Multiple calls on an unqualified line are ambiguous, even if their target strings match.
    if (candidates.length !== 1) return undefined;
    const range = candidates[0]!; const value = coordinates.range(range.start, range.end, context, role);
    store.addOccurrence(value, Buffer.byteLength(source)); return value.key;
  };
  const participant = (predicate: Predicate, node: GraphNode, op: ReturnType<typeof operation>, supports: string[][], confidence: Confidence, occ?: string) => {
    const owner = writer.inputNodes.get(node.id); if (!owner) throw Error("Boundary participant has no owned observation");
    const key = symbol(node); const claim = store.batch(run, () => writer.fact({ predicate, subject: key, object: op.key, ...(occ ? { occurrence: occ } : {}),
      value: { legacyId: node.id, maturity: "syntax-or-explicit-configuration" }, confidence }, supports.map(alternative => [...alternative, owner, op.claim])));
    participants.push({ predicate, symbol: key, operation: op.key, claim, confidence });
  };
  {
    // Schema identity remains file-scoped unless a reviewed namespace configuration explicitly joins it.
    const declarations = input.nodes.filter(node => node.kind === "boundary" && node.metadata.boundary);
    const schemaGroups = new Map<string, { identity: BoundaryIdentity; supports: string[][] }>();
    for (const node of declarations) {
      const identity = node.metadata.boundary as BoundaryIdentity;
      const configurations = (snapshot.config.boundaries ?? []).filter(config => config.protocol === identity.protocol && config.contracts.includes(identity.namespace));
      const namespaces = configurations.length ? [...new Set(configurations.map(config => config.namespace))] : [identity.namespace];
      const support = writer.inputNodes.get(node.id); if (!support) throw Error("Schema declaration is not owned");
      for (const namespace of namespaces) {
        const qualified = { ...identity, namespace }; const key = JSON.stringify(qualified);
        const group = schemaGroups.get(key) ?? { identity: qualified, supports: [] }; group.supports.push([support]); schemaGroups.set(key, group);
      }
    }
    for (const group of schemaGroups.values()) {
      operation(group.identity, group.supports);
    }
    const tauriEdges = input.edges.filter(edge => edge.metadata.framework === "tauri" && edge.confidence !== "unresolved");
    const tauriGroups = new Map<string, { identity: BoundaryIdentity; edges: GraphEdge[] }>();
    for (const edge of tauriEdges) {
      const boundary = [nodes.get(edge.source), nodes.get(edge.target)].find(node => node?.metadata.boundary);
      if (!boundary) continue;
      const evidence = edge.evidence[0]; const file = evidence?.file; if (!file) continue;
      if (edge.kind === "registers") {
        const source = snapshot.fileContents.get(file); let position = -1;
        if (source !== undefined && evidence.line && evidence.column) try { position = new SourceCoordinates(file, source, true).offset(evidence.line - 1, evidence.column - 1, 2); } catch { /* Reject invalid anchors. */ }
        let ranges = calls.get(file); if (!ranges && source !== undefined) { ranges = callRanges(file, source); calls.set(file, ranges); }
        if (!ranges?.some(range => range.macro && range.callee === "tauri::generate_handler" && range.start <= position && position < range.end)) { rejected++; continue; }
      }
      const identity = { ...(boundary.metadata.boundary as BoundaryIdentity), namespace: `tauri:${tauriScope(roots, file)}` };
      const key = JSON.stringify(identity); const group = tauriGroups.get(key) ?? { identity, edges: [] }; group.edges.push(edge); tauriGroups.set(key, group);
    }
    for (const group of tauriGroups.values()) {
      const op = operation(group.identity, group.edges.map(edge => [edgeClaims.get(edge.id)!]));
      const definitions = group.edges.filter(edge => edge.metadata.role === "command-definition");
      const registrations = group.edges.filter(edge => edge.kind === "registers");
      for (const edge of group.edges) {
        const support = edgeClaims.get(edge.id)!;
        const node = nodes.get(edge.metadata.role === "command-definition" || edge.kind === "listens" ? edge.target : edge.source);
        if (!node) continue;
        if (edge.metadata.role === "command-definition") {
          const expected = [...(Array.isArray(node.metadata.modulePath) ? node.metadata.modulePath as string[] : []), node.name].join("::");
          const qualifiedRegistrations = registrations.filter(registration => {
            const path = String(registration.metadata.handlerPath ?? "").replace(/^crate::/, "");
            const owner = nodes.get(registration.source); const module = Array.isArray(owner?.metadata.modulePath) ? owner.metadata.modulePath as string[] : [];
            return path === expected || [...module, path.replace(/^self::/, "")].join("::") === expected;
          });
          if (definitions.length === 1 && qualifiedRegistrations.length) participant("boundary.Implements", node, op, qualifiedRegistrations.map(item => [support, edgeClaims.get(item.id)!]), "resolved");
          else rejected++;
        } else if (edge.kind === "registers") participant("boundary.Registers", node, op, [[support]], edge.confidence);
        else {
          const evidence = edge.evidence[0]; const role = edge.kind === "invokes" ? "boundary.Invokes" : edge.kind === "emits" ? "boundary.Emits" : "boundary.Listens";
          const occ = evidence?.file && evidence.line ? occurrence(evidence.file, evidence.line, evidence.column, "call", /\.[cm]?[jt]sx?$/.test(evidence.file) ? group.identity.operation : undefined, true) : undefined;
          if (occ) participant(role, node, op, [[support]], edge.confidence, occ); else rejected++;
        }
      }
    }
    for (const config of snapshot.config.boundaries ?? []) {
      if (!["http", "graphql", "grpc"].includes(config.protocol)) { rejected += config.bindings.length; continue; }
      for (const binding of config.bindings) {
        const op = operations.get(JSON.stringify([config.protocol, config.namespace, binding.operation]));
        const candidates = input.nodes.filter(node => node.file === binding.file && ["function", "method", "class", "react_component"].includes(node.kind) &&
          (node.name === binding.symbol || node.qualifiedName === binding.symbol));
        if (!op || candidates.length !== 1) { rejected++; continue; }
        const node = candidates[0]!;
        const occ = binding.role === "implements" ? undefined : binding.line ? occurrence(binding.file, binding.line, binding.column, "call") : undefined;
        if (binding.role !== "implements" && !occ) { rejected++; continue; }
        if (occ) {
          const row = store.sql("SELECT line,end_line FROM sc_occurrences WHERE entity=?").get(store.entity(occ)) as { line: number; end_line: number };
          if (!node.startLine || !node.endLine || row.line < node.startLine || row.end_line > node.endLine) { rejected++; continue; }
        }
        participant(`boundary.${binding.role[0]!.toUpperCase()}${binding.role.slice(1)}` as Predicate, node, op, [[]], "resolved", occ);
      }
    }
    const ranks: Confidence[] = ["exact", "resolved", "probable", "unresolved"];
    let paths = 0;
    const handlers = new Map<string, typeof participants>();
    for (const item of participants) if (item.predicate === "boundary.Implements") { const group = handlers.get(item.operation) ?? []; group.push(item); handlers.set(item.operation, group); }
    for (const caller of participants.filter(item => item.predicate === "boundary.Invokes")) for (const handler of handlers.get(caller.operation) ?? []) {
      if (++paths > 1000000) throw Error("Boundary path pass exceeds row bound");
      store.batch(run, () => writer.fact({ predicate: "boundary.Path", subject: caller.symbol, object: handler.symbol, value: { operation: caller.operation }, confidence: ranks[Math.max(ranks.indexOf(caller.confidence), ranks.indexOf(handler.confidence))]! }, [[caller.claim, handler.claim]]));
    }
  }
  return { operations: operations.size, participants: participants.length, rejected,
    qualified: ["tauri-command", "tauri-event", "http/openapi-explicit", "graphql-explicit", "grpc/protobuf-explicit"],
    gaps: ["Explicit HTTP/GraphQL/gRPC namespace and participant declarations required", "No runtime completeness or dynamic routing", "Call evidence presently qualified for TS/JS and Rust syntax", "Other protocol families model-only"] };
}
