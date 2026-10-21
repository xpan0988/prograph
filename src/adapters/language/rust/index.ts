import { createRequire } from "node:module";
import { capabilities } from "../../../core/adapters/providers.js";
import path from "node:path";
import { beginAnalysisPhase } from "../../../core/analysis/diagnostics.js";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { SyntaxNode } from "tree-sitter";
import type { LanguageAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { Confidence, GraphNode, NodeKind, SourceEvidence } from "../../../core/graph/schema.js";

interface ParsedFile {
  file: string;
  source: string;
  tree: Parser.Tree;
  fileNode: GraphNode;
  baseModulePath: string[];
  nodeMap: Map<number, GraphNode>;
  receivers: Map<number, ReceiverObservations>;
}

interface ReceiverObservations {
  parameters: Map<string, string>;
  locals: Map<string, { bindings: Array<{ start: number; type: string }>; ordered: boolean }>;
}
interface TraversalContext {
  modulePath: string[];
  owner: GraphNode;
  impl?: SyntaxNode;
  trait?: SyntaxNode;
  functionItem?: SyntaxNode;
}
const DEFINITION_KINDS: Partial<Record<string, NodeKind>> = {
  function_item: "function", function_signature_item: "method", struct_item: "struct",
  enum_item: "enum", trait_item: "trait", mod_item: "module",
};

interface Definition {
  graphNode: GraphNode;
  syntaxNode: SyntaxNode;
  modulePath: string[];
  ownerType?: string;
  traitOwner?: string;
}

interface ImportBinding {
  alias: string;
  path: string[];
  ownerId?: string;
  wildcard?: boolean;
}

const LOW_VALUE_METHODS = new Set(["new", "get", "send", "clone", "insert", "update", "default", "expect", "unwrap", "map", "collect", "into", "from"]);

function rustFiles(snapshot: RepositorySnapshot): string[] {
  return snapshot.files.filter((file) => path.extname(file) === ".rs").sort();
}

function text(node: SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

/** Same named-node preorder as the old recursive namedChildren walk. Anonymous
 * subtrees are skipped, including during recovery. Only selected callbacks need a
 * SyntaxNode wrapper; context is saved by depth rather than queried via parents.
 */
function walk<T>(root: SyntaxNode, initial: T, visit: (type: string, node: () => SyntaxNode, context: T) => T) {
  const cursor = root.walk();
  const contexts = [initial]; let depth = 0; let visited = 0; let materialized = 0;
  let current: SyntaxNode | undefined;
  const node = () => { if (!current) { current = cursor.currentNode; materialized++; } return current; };
  while (true) {
    current = undefined;
    if (depth === 0 || cursor.nodeIsNamed) {
      visited++;
      const context = visit(cursor.nodeType, node, contexts[depth]!);
      if (cursor.gotoFirstChild()) { contexts[++depth] = context; continue; }
    }
    while (!cursor.gotoNextSibling()) {
      if (depth === 0) return { visited, materialized };
      cursor.gotoParent(); contexts.pop(); depth--;
    }
  }
}

function sourceEvidence(file: string, node: SyntaxNode, bindingName?: string): SourceEvidence {
  return {
    file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    adapter: "rust",
    matchedSyntax: node.type,
    ...(bindingName ? { bindingName } : {}),
  };
}

function getName(node: SyntaxNode, source: string): string | undefined {
  const name = node.childForFieldName("name");
  return name ? text(name, source) : undefined;
}

function moduleKey(parts: string[]): string {
  return parts.join("::");
}

function normalizeType(value: string): string {
  return value
    .replace(/&(?:\s*'[A-Za-z_][A-Za-z0-9_]*)?\s*(?:mut\s+)?/, "")
    .replace(/<.*>/s, "")
    .replace(/[()\s]/g, "")
    .split("::")
    .at(-1) ?? value;
}

function fileModulePath(file: string): string[] {
  const parts = file.split("/");
  const sourceIndex = parts.lastIndexOf("src");
  const relative = parts.slice(sourceIndex >= 0 ? sourceIndex + 1 : 0);
  const final = relative.at(-1)?.replace(/\.rs$/, "");
  if (!final || final === "lib" || final === "main") return relative.slice(0, -1);
  if (final === "mod") return relative.slice(0, -1);
  return [...relative.slice(0, -1), final];
}

function itemAttributes(node: SyntaxNode, source: string, file: string): { names: string[]; evidence: SourceEvidence[] } {
  const attributes: SyntaxNode[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling?.type === "attribute_item") {
    attributes.unshift(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return {
    names: attributes.map((attribute) => text(attribute, source).replace(/^#\s*\[\s*|\s*\]$/g, "").trim()),
    evidence: attributes.map((attribute) => sourceEvidence(file, attribute)),
  };
}

function pathParts(node: SyntaxNode | null, source: string): string[] {
  return node ? text(node, source).split("::").filter(Boolean) : [];
}

function useBindings(node: SyntaxNode, source: string, prefix: string[] = []): ImportBinding[] {
  if (node.type === "use_declaration") {
    const argument = node.childForFieldName("argument");
    return argument ? useBindings(argument, source, prefix) : [];
  }
  if (node.type === "scoped_use_list") {
    const nextPrefix = [...prefix, ...pathParts(node.childForFieldName("path"), source)];
    const list = node.childForFieldName("list");
    return list ? useBindings(list, source, nextPrefix) : [];
  }
  if (node.type === "use_list") {
    return node.namedChildren.flatMap((child) => useBindings(child, source, prefix));
  }
  if (node.type === "use_as_clause") {
    const target = [...prefix, ...pathParts(node.childForFieldName("path"), source)];
    const alias = node.childForFieldName("alias");
    return alias ? [{ alias: text(alias, source), path: target }] : [];
  }
  if (node.type === "use_wildcard") {
    const raw = text(node, source).replace(/::\*$/, "").replace(/^\*$/, "");
    return [{ alias: "*", path: [...prefix, ...raw.split("::").filter(Boolean)], wildcard: true }];
  }
  const target = [...prefix, ...pathParts(node, source)];
  const alias = target.at(-1);
  return alias ? [{ alias, path: target }] : [];
}

function relativePath(parts: string[], currentModule: string[]): string[] {
  const result = [...parts];
  if (result[0] === "crate") return result.slice(1);
  if (result[0] === "self") return [...currentModule, ...result.slice(1)];
  let module = [...currentModule];
  while (result[0] === "super") {
    module = module.slice(0, -1);
    result.shift();
  }
  return [...module, ...result];
}

function candidateKeys(parts: string[], currentModule: string[]): string[] {
  if (["crate", "self", "super"].includes(parts[0] ?? "")) return [moduleKey(relativePath(parts, currentModule))];
  return [...new Set([moduleKey([...currentModule, ...parts]), moduleKey(parts)])];
}

function uniqueDefinitions(items: Definition[]): Definition[] {
  return [...new Map(items.map((item) => [item.graphNode.id, item])).values()];
}

function diagnosticForCall(graph: GraphBuilder, file: string, callNode: SyntaxNode, callText: string, candidates: number): void {
  graph.addDiagnostic({
    code: callText.includes(".") ? "unresolved-method-call" : "unresolved-function-call",
    severity: "info",
    message: `Unable to uniquely resolve Rust call ${callText}`,
    file,
    line: callNode.startPosition.row + 1,
    column: callNode.startPosition.column + 1,
    adapter: "rust",
    metadata: { candidateCount: candidates },
  });
}

const rustSyntaxAdapter: LanguageAdapter = {
  name: "rust",
  version: "4",
  appliesTo: file => file.endsWith(".rs"),
  async detect(snapshot) {
    return snapshot.config.adapters.rust && rustFiles(snapshot).length > 0;
  },
  async analyze(snapshot) {
    if (!snapshot.config.adapters.rust) return emptyAdapterResult();
    const graph = new GraphBuilder();
    const parser = new Parser();
    parser.setLanguage(Rust as unknown as Parser.Language);
    const parsedFiles: ParsedFile[] = [];
    const definitions: Definition[] = [];
    const definitionsById = new Map<string, Definition>();
    const functionsByPath = new Map<string, Definition[]>();
    const functionsByName = new Map<string, Definition[]>();
    const methodsByTypeAndName = new Map<string, Definition[]>();
    const importsByModule = new Map<string, ImportBinding[]>();
    const unresolvedNodes = new Map<string, GraphNode>();
    const parsedDone = beginAnalysisPhase("rust-parse");

    for (const file of rustFiles(snapshot)) {
      const source = snapshot.fileContents.get(file);
      if (source === undefined) continue;
      const baseModulePath = fileModulePath(file);
      const fileNode: GraphNode = {
        id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "rust", file, kind: "file", qualifiedName: file }),
        kind: "file",
        name: path.basename(file),
        qualifiedName: file,
        language: "rust",
        file,
        adapter: "rust",
        metadata: { modulePath: baseModulePath },
      };
      graph.addNode(fileNode);
      let tree: Parser.Tree;
      try {
        tree = parser.parse(source);
      } catch (error) {
        graph.addDiagnostic({ code: "rust-parser-failure", severity: "error", message: `Unable to parse ${file}: ${String(error)}`, file, adapter: "rust", metadata: {} });
        continue;
      }
      if (tree.rootNode.hasError) {
        graph.addDiagnostic({ code: "rust-parser-error-node", severity: "warning", message: `Tree-sitter recovered from invalid or unsupported Rust syntax in ${file}`, file, adapter: "rust", metadata: {} });
      }
      parsedFiles.push({ file, source, tree, fileNode, baseModulePath, nodeMap: new Map(), receivers: new Map() });
    }

    parsedDone({ trees: parsedFiles.length });
    const definitionsDone = beginAnalysisPhase("rust-definitions");
    let definitionVisits = 0; let definitionWrappers = 0;
    for (const parsed of parsedFiles) {
      const macros: Array<{ text: string; evidence: SourceEvidence; ownerId: string }> = [];
      const observed = walk<TraversalContext>(parsed.tree.rootNode, { modulePath: parsed.baseModulePath, owner: parsed.fileNode }, (type, readNode, context) => {
        if (!DEFINITION_KINDS[type] && type !== "impl_item" && type !== "use_declaration" && type !== "macro_invocation") return context;
        const syntaxNode = readNode();
        let children = context;
        if (type === "impl_item") children = { ...children, impl: syntaxNode };
        if (type === "trait_item") children = { ...children, trait: syntaxNode };
        if (type === "function_item") children = { ...children, functionItem: syntaxNode };
        const { impl, trait } = context;
        const kind = type === "function_item" && (impl || trait) ? "method" : DEFINITION_KINDS[type];
        if (kind) {
          const name = getName(syntaxNode, parsed.source);
          if (!name) return children;
          const modulePath = context.modulePath;
          if (type === "mod_item" && syntaxNode.childForFieldName("body")) children = { ...children, modulePath: [...modulePath, name] };
          const ownerType = impl?.childForFieldName("type") ? normalizeType(text(impl.childForFieldName("type")!, parsed.source)) : undefined;
          const implTrait = impl?.childForFieldName("trait");
          const traitOwner = trait ? getName(trait, parsed.source) : implTrait ? text(implTrait, parsed.source) : undefined;
          const attributes = itemAttributes(syntaxNode, parsed.source, parsed.file);
          const qn = `${parsed.file}::${ownerType ? `${ownerType}.` : ""}${name}`;
          const symbolNode: GraphNode = {
            id: nodeId({
              repositoryIdentity: snapshot.repository.identity,
              language: "rust",
              file: parsed.file,
              kind,
              qualifiedName: qn,
              discriminator: String(syntaxNode.startIndex),
            }),
            kind,
            name,
            qualifiedName: qn,
            language: "rust",
            file: parsed.file,
            startLine: syntaxNode.startPosition.row + 1,
            startColumn: syntaxNode.startPosition.column + 1,
            endLine: syntaxNode.endPosition.row + 1,
            endColumn: syntaxNode.endPosition.column + 1,
            adapter: "rust",
            metadata: {
              attributes: attributes.names,
              attributeEvidence: attributes.evidence,
              modulePath,
              ...(ownerType ? { ownerType } : {}),
              ...(traitOwner ? { traitOwner } : {}),
            },
          };
          graph.addNode(symbolNode);
          parsed.nodeMap.set(syntaxNode.id, symbolNode);
          children = { ...children, owner: symbolNode };
          const definition: Definition = { graphNode: symbolNode, syntaxNode, modulePath, ...(ownerType ? { ownerType } : {}), ...(traitOwner ? { traitOwner } : {}) };
          definitions.push(definition);
          // Match definitions.find: the first declaration wins even if a recovered
          // tree ever produces the same stable graph identity more than once.
          if (!definitionsById.has(symbolNode.id)) definitionsById.set(symbolNode.id, definition);
          if (kind === "function") {
            const key = moduleKey([...modulePath, name]);
            functionsByPath.set(key, [...(functionsByPath.get(key) ?? []), definition]);
            functionsByName.set(name, [...(functionsByName.get(name) ?? []), definition]);
          }
          if (kind === "method" && ownerType && !traitOwner) {
            const typeKey = moduleKey([...modulePath, ownerType, name]);
            methodsByTypeAndName.set(typeKey, [...(methodsByTypeAndName.get(typeKey) ?? []), definition]);
          }
          graph.addEdge(withEdgeId({
            source: parsed.fileNode.id,
            target: symbolNode.id,
            kind: "contains",
            confidence: "exact",
            evidence: [sourceEvidence(parsed.file, syntaxNode)],
            metadata: {},
          }));
        }
        if (type === "use_declaration") {
          const modulePath = context.modulePath;
          const ownerId = context.functionItem ? parsed.nodeMap.get(context.functionItem.id)?.id : undefined;
          const bindings = useBindings(syntaxNode, parsed.source).map((binding) => ({ ...binding, ...(ownerId ? { ownerId } : {}) }));
          importsByModule.set(moduleKey(modulePath), [...(importsByModule.get(moduleKey(modulePath)) ?? []), ...bindings]);
        }
        if (type === "macro_invocation") {
          macros.push({ text: text(syntaxNode, parsed.source), evidence: sourceEvidence(parsed.file, syntaxNode), ownerId: context.owner.id });
        }
        return children;
      });
      definitionVisits += observed.visited; definitionWrappers += observed.materialized;
      parsed.fileNode.metadata = { ...parsed.fileNode.metadata, macros };
    }

    definitionsDone({ definitions: definitions.length, visitedNodes: definitionVisits, selectedWrappers: definitionWrappers });
    const callsDone = beginAnalysisPhase("rust-calls");
    const visibleImports = (modulePath: string[], ownerId: string): ImportBinding[] =>
      (importsByModule.get(moduleKey(modulePath)) ?? []).filter((binding) => !binding.ownerId || binding.ownerId === ownerId);
    const resolveImportBinding = (binding: ImportBinding, modulePath: string[], seen = new Set<string>()): Definition[] => {
      const absolutePath = relativePath(binding.path, modulePath);
      const direct = functionsByPath.get(moduleKey(absolutePath)) ?? [];
      if (direct.length) return direct;
      const importedName = absolutePath.at(-1);
      const importedModule = absolutePath.slice(0, -1);
      const key = `${moduleKey(importedModule)}:${importedName}`;
      if (!importedName || seen.has(key)) return [];
      seen.add(key);
      return uniqueDefinitions((importsByModule.get(moduleKey(importedModule)) ?? [])
        .filter((candidate) => !candidate.ownerId && candidate.alias === importedName)
        .flatMap((candidate) => resolveImportBinding(candidate, importedModule, seen)));
    };
    const resolveFunctionPath = (parts: string[], modulePath: string[], ownerId: string, implType?: string): Definition[] => {
      if (parts[0] === "Self" && implType && parts.length === 2) {
        return uniqueDefinitions(methodsByTypeAndName.get(moduleKey([...modulePath, implType, parts[1]!])) ?? []);
      }
      if (parts.length > 1) {
        const importedPrefix = visibleImports(modulePath, ownerId).find((binding) => binding.alias === parts[0]);
        const expanded = importedPrefix ? [...importedPrefix.path, ...parts.slice(1)] : parts;
        const keys = candidateKeys(expanded, modulePath);
        return uniqueDefinitions([
          ...keys.flatMap((key) => methodsByTypeAndName.get(key) ?? []),
          ...keys.flatMap((key) => functionsByPath.get(key) ?? []),
        ]);
      }
      const name = parts[0];
      if (!name) return [];
      const imported = visibleImports(modulePath, ownerId).filter((binding) => binding.alias === name);
      const wildcardTargets = visibleImports(modulePath, ownerId)
        .filter((binding) => binding.wildcard)
        .flatMap((binding) => functionsByPath.get(moduleKey(relativePath([...binding.path, name], modulePath))) ?? []);
      const importedTargets = [...imported.flatMap((binding) => resolveImportBinding(binding, modulePath)), ...wildcardTargets];
      if (importedTargets.length) return uniqueDefinitions(importedTargets);
      const sameModule = functionsByPath.get(moduleKey([...modulePath, name])) ?? [];
      if (sameModule.length) return uniqueDefinitions(sameModule);
      return uniqueDefinitions(functionsByName.get(name) ?? []);
    };
    const stronglyResolvedDirectPath = (parts: string[], modulePath: string[], ownerId: string, implType?: string): boolean => {
      if (parts.length > 1) return parts[0] === "Self" ? Boolean(implType) : true;
      const name = parts[0];
      if (!name) return false;
      const imported = visibleImports(modulePath, ownerId).some((binding) => binding.alias === name || binding.wildcard);
      const sameModule = (functionsByPath.get(moduleKey([...modulePath, name])) ?? []).length > 0;
      return imported || sameModule;
    };

    const typeKeyFor = (typeName: string, modulePath: string[], ownerId: string): string => {
      const cleaned = typeName.replace(/&(?:\s*'[A-Za-z_][A-Za-z0-9_]*)?\s*(?:mut\s+)?/, "").replace(/<.*>/s, "").replace(/[()\s]/g, "");
      const parts = cleaned.split("::").filter(Boolean);
      if (parts.length === 1) {
        const imported = visibleImports(modulePath, ownerId).find((binding) => binding.alias === parts[0]);
        if (imported) return moduleKey(relativePath(imported.path, modulePath));
      }
      if (["crate", "self", "super"].includes(parts[0] ?? "")) return moduleKey(relativePath(parts, modulePath));
      if (parts.length > 1) return moduleKey(parts);
      return moduleKey([...modulePath, normalizeType(typeName)]);
    };
    let receiverLookups = 0; let receiverFunctions = 0; let receiverVisits = 0; let receiverBindings = 0;
    const inferredReceiverType = (call: SyntaxNode, receiver: string, parsed: ParsedFile, modulePath: string[], ownerId: string, implType: string | undefined, fn: SyntaxNode | undefined): string | undefined => {
      receiverLookups++;
      if (receiver === "self" && implType) return typeKeyFor(implType, modulePath, ownerId);
      if (!fn) return undefined;
      let observations = parsed.receivers.get(fn.id);
      if (!observations) {
        observations = { parameters: new Map(), locals: new Map() };
        parsed.receivers.set(fn.id, observations); receiverFunctions++;
        const parameters = fn.childForFieldName("parameters");
        for (const parameter of parameters?.namedChildren ?? []) {
          if (parameter.type !== "parameter") continue;
          const pattern = parameter.childForFieldName("pattern") ?? parameter.namedChildren[0];
          const type = parameter.childForFieldName("type") ?? parameter.namedChildren.at(-1);
          if (pattern && type) {
            const name = text(pattern, parsed.source);
            if (!observations.parameters.has(name)) observations.parameters.set(name, text(type, parsed.source));
          }
        }
        // Preserve the accepted function-subtree heuristic exactly: parameters
        // take precedence; nested-block/function lets are observed in preorder;
        // reassignment and uninferrable lets do not mask earlier typed evidence.
        // Store raw observations, resolving imports in each call's owner context.
        const locals = observations.locals;
        const observed = walk(fn, undefined, (kind, readNode) => {
          if (kind !== "let_declaration") return;
          const declaration = readNode();
          const pattern = declaration.childForFieldName("pattern") ?? declaration.namedChildren[0];
          if (!pattern) return;
          const type = declaration.childForFieldName("type");
          let typeName = type ? text(type, parsed.source) : undefined;
          if (typeName === undefined) {
            const value = declaration.childForFieldName("value");
            const constructor = value?.type === "call_expression" ? value.childForFieldName("function") : undefined;
            if (constructor?.type === "scoped_identifier") {
              const parts = text(constructor, parsed.source).split("::");
              if (parts.length >= 2) typeName = parts.at(-2)!;
            }
          }
          if (typeName === undefined) return;
          const name = text(pattern, parsed.source), start = declaration.startIndex;
          const local = locals.get(name) ?? { bindings: [], ordered: true };
          if (local.bindings.length && local.bindings.at(-1)!.start > start) local.ordered = false;
          local.bindings.push({ start, type: typeName }); locals.set(name, local); receiverBindings++;
        });
        receiverVisits += observed.visited;
      }
      const parameter = observations.parameters.get(receiver);
      if (parameter !== undefined) return typeKeyFor(parameter, modulePath, ownerId);
      const local = observations.locals.get(receiver);
      if (!local) return undefined;
      const start = call.startIndex;
      let binding: { start: number; type: string } | undefined;
      if (local.ordered) {
        let low = 0, high = local.bindings.length;
        while (low < high) { const mid = (low + high) >>> 1; if (local.bindings[mid]!.start < start) low = mid + 1; else high = mid; }
        binding = local.bindings[low - 1];
      } else {
        // Defensive recovery fallback: preserve reverse preorder even if a
        // future grammar/binding presents nonmonotone source positions.
        for (let i = local.bindings.length - 1; i >= 0; i--) if (local.bindings[i]!.start < start) { binding = local.bindings[i]; break; }
      }
      return binding === undefined ? undefined : typeKeyFor(binding.type, modulePath, ownerId);
    };

    const unresolvedTarget = (parsed: ParsedFile, owner: GraphNode, callNode: SyntaxNode, callText: string, candidateCount: number): GraphNode => {
      const methodName = callText.split(".").at(-1) ?? callText;
      const category = callText.includes(".") ? "method" : "call";
      const scopeName = category === "method" && LOW_VALUE_METHODS.has(methodName) ? "<common-method>" : callText;
      const key = `${owner.id}:${category}:${scopeName}`;
      const existing = unresolvedNodes.get(key);
      if (existing) return existing;
      const created: GraphNode = {
        id: nodeId({
          repositoryIdentity: snapshot.repository.identity,
          language: "rust",
          file: parsed.file,
          kind: "unresolved_symbol",
          qualifiedName: `call:${key}`,
        }),
        kind: "unresolved_symbol",
        name: scopeName,
        qualifiedName: `call:${key}`,
        language: "rust",
        file: parsed.file,
        startLine: callNode.startPosition.row + 1,
        startColumn: callNode.startPosition.column + 1,
        endLine: callNode.endPosition.row + 1,
        endColumn: callNode.endPosition.column + 1,
        adapter: "rust",
        metadata: { category, candidateCount, scopedOwner: owner.id, aggregated: scopeName !== callText },
      };
      unresolvedNodes.set(key, created);
      graph.addNode(created);
      return created;
    };

    let callVisits = 0; let callWrappers = 0; let definitionLookups = 0;
    for (const parsed of parsedFiles) {
      const observed = walk<TraversalContext>(parsed.tree.rootNode, { modulePath: parsed.baseModulePath, owner: parsed.fileNode }, (type, readNode, context) => {
        if (DEFINITION_KINDS[type]) {
          const syntaxNode = readNode();
          const owner = parsed.nodeMap.get(syntaxNode.id);
          let children = owner ? { ...context, owner } : context;
          if (type === "function_item") children = { ...children, functionItem: syntaxNode };
          if (type === "mod_item" && syntaxNode.childForFieldName("body")) {
            const name = getName(syntaxNode, parsed.source);
            if (name) children = { ...children, modulePath: [...context.modulePath, name] };
          }
          return children;
        }
        if (type !== "call_expression") return context;
        const syntaxNode = readNode();
        const fnNode = syntaxNode.childForFieldName("function");
        if (!fnNode) return context;
        const callText = text(fnNode, parsed.source);
        const owner = context.owner;
        const ownerDefinition = definitionsById.get(owner.id); definitionLookups++;
        const modulePath = ownerDefinition?.modulePath ?? context.modulePath;
        const implType = ownerDefinition?.ownerType;
        let candidates: Definition[] = [];
        let resolutionMethod = "unresolved-name";
        let resolvedConfidence: Confidence = "resolved";
        if (fnNode.type === "field_expression") {
          const receiverNode = fnNode.childForFieldName("value");
          const methodNode = fnNode.childForFieldName("field");
          const receiver = receiverNode ? text(receiverNode, parsed.source) : "";
          const method = methodNode ? text(methodNode, parsed.source) : "";
          const receiverType = inferredReceiverType(syntaxNode, receiver, parsed, modulePath, owner.id, implType, context.functionItem);
          if (receiverType && method) {
            candidates = uniqueDefinitions(methodsByTypeAndName.get(`${receiverType}::${method}`) ?? []);
            resolutionMethod = "syntactic-receiver-type";
          }
        } else {
          const parts = callText.split("::");
          candidates = resolveFunctionPath(parts, modulePath, owner.id, implType);
          const strong = stronglyResolvedDirectPath(parts, modulePath, owner.id, implType);
          resolvedConfidence = strong ? "resolved" : "probable";
          resolutionMethod = strong ? (callText.includes("::") ? "repository-module-path" : "module-or-import-binding") : "unique-repository-name";
        }
        let target: GraphNode;
        let confidence: Confidence;
        if (candidates.length === 1) {
          target = candidates[0]!.graphNode;
          confidence = resolvedConfidence;
        } else {
          target = unresolvedTarget(parsed, owner, syntaxNode, callText, candidates.length);
          confidence = "unresolved";
          diagnosticForCall(graph, parsed.file, syntaxNode, callText, candidates.length);
        }
        graph.addEdge(withEdgeId({
          source: owner.id,
          target: target.id,
          kind: "calls",
          confidence,
          evidence: [{ ...sourceEvidence(parsed.file, syntaxNode, callText), resolutionMethod: confidence === "unresolved" ? "unresolved-name" : resolutionMethod }],
          metadata: { ...(candidates.length > 1 ? { candidateIds: candidates.map((item) => item.graphNode.id) } : {}) },
        }));
        return context;
      });
      callVisits += observed.visited; callWrappers += observed.materialized;
    }
    callsDone({ nodes: graph.nodes.size, edges: graph.edges.size, visitedNodes: callVisits, selectedWrappers: callWrappers,
      definitionLookups, receiverLookups, receiverFunctions, receiverVisitedNodes: receiverVisits, receiverBindings });
    return graph.result({ moduleCount: new Set(definitions.map((item) => moduleKey(item.modulePath))).size, unresolvedNodePolicy: "scoped-and-common-method-aggregated" });
  },
};

export const rustAdapter: LanguageAdapter = {
  ...rustSyntaxAdapter,
  async analyze(snapshot) {
    const result = await rustSyntaxAdapter.analyze(snapshot);
    for (const edge of result.edges) for (const evidence of edge.evidence) {
      evidence.provider = "tree-sitter-rust";
      evidence.basis = edge.confidence === "exact" ? "syntax" : edge.confidence === "unresolved" ? "unresolved" : "inference";
    }
    result.metadata = { ...result.metadata, providers: [{ id: "tree-sitter-rust", version: createRequire(import.meta.url)("tree-sitter-rust/package.json").version, kind: "syntax", available: true }], semanticProviderAvailable: false, capabilities: capabilities({ syntax: "syntax", symbols: "syntax", modules: "heuristic", references: "heuristic", calls: "heuristic", types: "heuristic", inheritance: "syntax", macros: "syntax" }) };
    return result;
  },
};
