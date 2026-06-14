import path from "node:path";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { SyntaxNode } from "tree-sitter";
import type { LanguageAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { GraphNode, NodeKind, SourceEvidence } from "../../../core/graph/schema.js";

function rustFiles(snapshot: RepositorySnapshot): string[] {
  return snapshot.files.filter((file) => path.extname(file) === ".rs");
}

function text(node: SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of namedChildren(node)) walk(child, visit);
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

function enclosingFunction(node: SyntaxNode, byRange: Map<SyntaxNode, GraphNode>, fileNode: GraphNode): GraphNode {
  let current: SyntaxNode | null = node;
  while (current) {
    const found = byRange.get(current);
    if (found) return found;
    current = current.parent;
  }
  return fileNode;
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
    const nodesByName = new Map<string, GraphNode[]>();
    for (const file of rustFiles(snapshot)) {
      const source = snapshot.fileContents.get(file);
      if (source === undefined) continue;
      const fileNode: GraphNode = {
        id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "rust", file, kind: "file", qualifiedName: file }),
        kind: "file",
        name: path.basename(file),
        qualifiedName: file,
        language: "rust",
        file,
        adapter: "rust",
        metadata: {},
      };
      graph.addNode(fileNode);
      let tree: Parser.Tree;
      try {
        tree = parser.parse(source);
      } catch (error) {
        graph.addDiagnostic({
          code: "rust-parser-failure",
          severity: "error",
          message: `Unable to parse ${file}: ${String(error)}`,
          file,
          adapter: "rust",
          metadata: {},
        });
        continue;
      }
      if (tree.rootNode.hasError) {
        graph.addDiagnostic({
          code: "rust-parser-error-node",
          severity: "warning",
          message: `Tree-sitter recovered from invalid or unsupported Rust syntax in ${file}`,
          file,
          adapter: "rust",
          metadata: {},
        });
      }
      const nodeMap = new Map<SyntaxNode, GraphNode>();
      const macros: Array<{ text: string; evidence: SourceEvidence; ownerId: string }> = [];
      walk(tree.rootNode, (syntaxNode) => {
        const kinds: Partial<Record<string, NodeKind>> = {
          function_item: syntaxNode.parent?.type === "declaration_list" && syntaxNode.parent.parent?.type === "impl_item" ? "method" : "function",
          struct_item: "struct",
          enum_item: "enum",
          trait_item: "trait",
          mod_item: "module",
        };
        const kind = kinds[syntaxNode.type];
        if (kind) {
          const name = getName(syntaxNode, source);
          if (!name) return;
          const prefix = source.slice(Math.max(0, syntaxNode.startIndex - 300), syntaxNode.startIndex);
          const attributes = [...prefix.matchAll(/#\s*\[\s*([^\]]+)\]/g)].map((match) => match[1]?.trim()).filter((item): item is string => Boolean(item));
          const qn = `${file}::${name}`;
          const symbolNode: GraphNode = {
            id: nodeId({
              repositoryIdentity: snapshot.repository.identity,
              language: "rust",
              file,
              kind,
              qualifiedName: qn,
              discriminator: String(syntaxNode.startIndex),
            }),
            kind,
            name,
            qualifiedName: qn,
            language: "rust",
            file,
            startLine: syntaxNode.startPosition.row + 1,
            startColumn: syntaxNode.startPosition.column + 1,
            endLine: syntaxNode.endPosition.row + 1,
            endColumn: syntaxNode.endPosition.column + 1,
            adapter: "rust",
            metadata: { attributes },
          };
          graph.addNode(symbolNode);
          nodeMap.set(syntaxNode, symbolNode);
          nodesByName.set(name, [...(nodesByName.get(name) ?? []), symbolNode]);
          graph.addEdge(
            withEdgeId({
              source: fileNode.id,
              target: symbolNode.id,
              kind: "contains",
              confidence: "exact",
              evidence: [sourceEvidence(file, syntaxNode)],
              metadata: {},
            }),
          );
        }
        if (syntaxNode.type === "macro_invocation") {
          macros.push({ text: text(syntaxNode, source), evidence: sourceEvidence(file, syntaxNode), ownerId: enclosingFunction(syntaxNode, nodeMap, fileNode).id });
        }
      });
      walk(tree.rootNode, (syntaxNode) => {
        if (syntaxNode.type !== "call_expression") return;
        const fnNode = syntaxNode.childForFieldName("function");
        if (!fnNode) return;
        const callText = text(fnNode, source);
        const name = callText.split(/::|\./).at(-1)?.replace(/[^A-Za-z0-9_]/g, "");
        if (!name) return;
        const candidates = nodesByName.get(name) ?? [];
        let target: GraphNode;
        let confidence: "resolved" | "probable" | "unresolved";
        if (candidates.length === 1) {
          target = candidates[0]!;
          confidence = callText.includes(".") ? "probable" : "resolved";
        } else {
          target = {
            id: nodeId({
              repositoryIdentity: snapshot.repository.identity,
              language: "rust",
              file,
              kind: "unresolved_symbol",
              qualifiedName: `call:${callText}`,
              discriminator: String(syntaxNode.startIndex),
            }),
            kind: "unresolved_symbol",
            name: callText,
            qualifiedName: `call:${callText}`,
            language: "rust",
            file,
            startLine: syntaxNode.startPosition.row + 1,
            startColumn: syntaxNode.startPosition.column + 1,
            endLine: syntaxNode.endPosition.row + 1,
            endColumn: syntaxNode.endPosition.column + 1,
            adapter: "rust",
            metadata: { category: "call", candidateCount: candidates.length },
          };
          confidence = "unresolved";
          graph.addNode(target);
          graph.addDiagnostic({
            code: callText.includes(".") ? "unresolved-method-call" : "unresolved-function-call",
            severity: "info",
            message: `Unable to uniquely resolve Rust call ${callText}`,
            file,
            line: syntaxNode.startPosition.row + 1,
            column: syntaxNode.startPosition.column + 1,
            adapter: "rust",
            metadata: { candidateCount: candidates.length },
          });
        }
        graph.addEdge(
          withEdgeId({
            source: enclosingFunction(syntaxNode, nodeMap, fileNode).id,
            target: target.id,
            kind: "calls",
            confidence,
            evidence: [{ ...sourceEvidence(file, syntaxNode, callText), resolutionMethod: confidence === "resolved" ? "unique-name" : confidence === "probable" ? "heuristic-method-name" : "unresolved-name" }],
            metadata: {},
          }),
        );
      });
      fileNode.metadata = { macros };
    }
    return graph.result();
  },
};
