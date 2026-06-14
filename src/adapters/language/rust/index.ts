import path from "node:path";
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
  nodeMap: Map<SyntaxNode, GraphNode>;
}

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

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
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

function inlineModulePath(node: SyntaxNode, source: string, base: string[]): string[] {
  const names: string[] = [];
  let current = node.parent;
  while (current) {
    if (current.type === "mod_item" && current.childForFieldName("body")) {
      const name = getName(current, source);
      if (name) names.unshift(name);
    }
    current = current.parent;
  }
  return [...base, ...names];
}

function enclosing(node: SyntaxNode, type: string): SyntaxNode | undefined {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return undefined;
}

function enclosingFunctionNode(node: SyntaxNode): SyntaxNode | undefined {
  return enclosing(node, "function_item");
}

function enclosingOwner(node: SyntaxNode, nodeMap: Map<SyntaxNode, GraphNode>, fileNode: GraphNode): GraphNode {
  let current: SyntaxNode | null = node;
  while (current) {
    const found = nodeMap.get(current);
    if (found) return found;
    current = current.parent;
  }
  return fileNode;
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

export const rustAdapter: LanguageAdapter = {
  name: "rust",
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
    const functionsByPath = new Map<string, Definition[]>();
    const functionsByName = new Map<string, Definition[]>();
    const methodsByTypeAndName = new Map<string, Definition[]>();
    const importsByModule = new Map<string, ImportBinding[]>();
    const unresolvedNodes = new Map<string, GraphNode>();

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
      parsedFiles.push({ file, source, tree, fileNode, baseModulePath, nodeMap: new Map() });
    }

    for (const parsed of parsedFiles) {
      const macros: Array<{ text: string; evidence: SourceEvidence; ownerId: string }> = [];
      walk(parsed.tree.rootNode, (syntaxNode) => {
        const impl = enclosing(syntaxNode, "impl_item");
        const trait = enclosing(syntaxNode, "trait_item");
        const kinds: Partial<Record<string, NodeKind>> = {
          function_item: impl || trait ? "method" : "function",
          function_signature_item: "method",
          struct_item: "struct",
          enum_item: "enum",
          trait_item: "trait",
          mod_item: "module",
        };
        const kind = kinds[syntaxNode.type];
        if (kind) {
          const name = getName(syntaxNode, parsed.source);
          if (!name) return;
          const modulePath = inlineModulePath(syntaxNode, parsed.source, parsed.baseModulePath);
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
          parsed.nodeMap.set(syntaxNode, symbolNode);
          const definition: Definition = { graphNode: symbolNode, syntaxNode, modulePath, ...(ownerType ? { ownerType } : {}), ...(traitOwner ? { traitOwner } : {}) };
          definitions.push(definition);
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
        if (syntaxNode.type === "use_declaration") {
          const modulePath = inlineModulePath(syntaxNode, parsed.source, parsed.baseModulePath);
          const functionOwner = enclosingFunctionNode(syntaxNode);
          const ownerId = functionOwner ? parsed.nodeMap.get(functionOwner)?.id : undefined;
          const bindings = useBindings(syntaxNode, parsed.source).map((binding) => ({ ...binding, ...(ownerId ? { ownerId } : {}) }));
          importsByModule.set(moduleKey(modulePath), [...(importsByModule.get(moduleKey(modulePath)) ?? []), ...bindings]);
        }
        if (syntaxNode.type === "macro_invocation") {
          macros.push({ text: text(syntaxNode, parsed.source), evidence: sourceEvidence(parsed.file, syntaxNode), ownerId: enclosingOwner(syntaxNode, parsed.nodeMap, parsed.fileNode).id });
        }
      });
      parsed.fileNode.metadata = { ...parsed.fileNode.metadata, macros };
    }

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
    const inferredReceiverType = (call: SyntaxNode, receiver: string, parsed: ParsedFile, modulePath: string[], ownerId: string, implType?: string): string | undefined => {
      if (receiver === "self" && implType) return typeKeyFor(implType, modulePath, ownerId);
      const fn = enclosingFunctionNode(call);
      if (!fn) return undefined;
      const parameters = fn.childForFieldName("parameters");
      for (const parameter of parameters?.namedChildren ?? []) {
        if (parameter.type !== "parameter") continue;
        const pattern = parameter.childForFieldName("pattern") ?? parameter.namedChildren[0];
        const type = parameter.childForFieldName("type") ?? parameter.namedChildren.at(-1);
        if (pattern && type && text(pattern, parsed.source) === receiver) return typeKeyFor(text(type, parsed.source), modulePath, ownerId);
      }
      const lets: SyntaxNode[] = [];
      walk(fn, (node) => {
        if (node.type === "let_declaration" && node.startIndex < call.startIndex) lets.push(node);
      });
      for (const declaration of lets.reverse()) {
        const pattern = declaration.childForFieldName("pattern") ?? declaration.namedChildren[0];
        if (!pattern || text(pattern, parsed.source) !== receiver) continue;
        const type = declaration.childForFieldName("type");
        if (type) return typeKeyFor(text(type, parsed.source), modulePath, ownerId);
        const value = declaration.childForFieldName("value");
        const constructor = value?.type === "call_expression" ? value.childForFieldName("function") : undefined;
        if (constructor?.type === "scoped_identifier") {
          const constructorParts = text(constructor, parsed.source).split("::");
          if (constructorParts.length >= 2) return typeKeyFor(constructorParts.at(-2)!, modulePath, ownerId);
        }
      }
      return undefined;
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

    for (const parsed of parsedFiles) {
      walk(parsed.tree.rootNode, (syntaxNode) => {
        if (syntaxNode.type !== "call_expression") return;
        const fnNode = syntaxNode.childForFieldName("function");
        if (!fnNode) return;
        const callText = text(fnNode, parsed.source);
        const owner = enclosingOwner(syntaxNode, parsed.nodeMap, parsed.fileNode);
        const ownerDefinition = definitions.find((item) => item.graphNode.id === owner.id);
        const modulePath = ownerDefinition?.modulePath ?? inlineModulePath(syntaxNode, parsed.source, parsed.baseModulePath);
        const implType = ownerDefinition?.ownerType;
        let candidates: Definition[] = [];
        let resolutionMethod = "unresolved-name";
        let resolvedConfidence: Confidence = "resolved";
        if (fnNode.type === "field_expression") {
          const receiverNode = fnNode.childForFieldName("value");
          const methodNode = fnNode.childForFieldName("field");
          const receiver = receiverNode ? text(receiverNode, parsed.source) : "";
          const method = methodNode ? text(methodNode, parsed.source) : "";
          const receiverType = inferredReceiverType(syntaxNode, receiver, parsed, modulePath, owner.id, implType);
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
      });
    }
    return graph.result({ moduleCount: new Set(definitions.map((item) => moduleKey(item.modulePath))).size, unresolvedNodePolicy: "scoped-and-common-method-aggregated" });
  },
};
