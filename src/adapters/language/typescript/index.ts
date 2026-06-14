import path from "node:path";
import {
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  NewExpression,
  Node,
  Project,
  ScriptTarget,
  SourceFile,
  SyntaxKind,
  TypeAliasDeclaration,
  VariableDeclaration,
} from "ts-morph";
import type { LanguageAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { GraphNode, NodeKind, SourceEvidence } from "../../../core/graph/schema.js";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

function relative(snapshot: RepositorySnapshot, sourceFile: SourceFile): string {
  return path.relative(snapshot.repository.root, sourceFile.getFilePath()).split(path.sep).join("/");
}

function evidence(file: string, node: Node, adapter = "typescript"): SourceEvidence {
  const start = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  const end = node.getSourceFile().getLineAndColumnAtPos(node.getEnd());
  return {
    file,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    adapter,
    matchedSyntax: node.getKindName(),
  };
}

function location(node: Node): Pick<GraphNode, "startLine" | "startColumn" | "endLine" | "endColumn"> {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function declarationName(node: Node): string | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isVariableDeclaration(node)
  ) {
    return node.getName();
  }
  return undefined;
}

function qualifiedName(file: string, node: Node, name: string): string {
  const parentClass = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName();
  return `${file}::${parentClass ? `${parentClass}.` : ""}${name}`;
}

function declarationKey(node: Node): string {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
}

function nearestOwner(node: Node, nodeByDeclaration: Map<string, GraphNode>, fileNode: GraphNode): GraphNode {
  let current: Node | undefined = node;
  while (current) {
    const found = nodeByDeclaration.get(declarationKey(current));
    if (found) return found;
    current = current.getParent();
  }
  return fileNode;
}

function makeSymbolNode(
  snapshot: RepositorySnapshot,
  file: string,
  node: Node,
  name: string,
  kind: NodeKind,
  metadata: Record<string, unknown> = {},
): GraphNode {
  const qn = qualifiedName(file, node, name);
  return {
    id: nodeId({
      repositoryIdentity: snapshot.repository.identity,
      language: "typescript",
      file,
      kind,
      qualifiedName: qn,
      discriminator: String(node.getStart()),
    }),
    kind,
    name,
    qualifiedName: qn,
    language: "typescript",
    file,
    adapter: "typescript",
    metadata,
    ...location(node),
  };
}

function createProject(snapshot: RepositorySnapshot): Project {
  const tsconfig = ["tsconfig.json", "jsconfig.json"].find((item) => snapshot.fileContents.has(item));
  const project = new Project({
    ...(tsconfig ? { tsConfigFilePath: path.join(snapshot.repository.root, tsconfig) } : {}),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: 1,
      target: ScriptTarget.ES2022,
    },
  });
  project.addSourceFilesAtPaths(
    snapshot.files
      .filter((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)))
      .map((file) => snapshot.absoluteFiles.get(file))
      .filter((file): file is string => Boolean(file)),
  );
  return project;
}

export const typescriptAdapter: LanguageAdapter = {
  name: "typescript",
  async detect(snapshot) {
    return snapshot.config.adapters.typescript && snapshot.files.some((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)));
  },
  async analyze(snapshot) {
    if (!snapshot.config.adapters.typescript) return emptyAdapterResult();
    const graph = new GraphBuilder();
    let project: Project;
    try {
      project = createProject(snapshot);
    } catch (error) {
      graph.addDiagnostic({
        code: "typescript-project-failure",
        severity: "error",
        message: `Unable to create TypeScript project: ${String(error)}`,
        adapter: "typescript",
        metadata: {},
      });
      return graph.result();
    }
    const nodeByDeclaration = new Map<string, GraphNode>();
    const fileNodes = new Map<string, GraphNode>();
    const externalNodes = new Map<string, GraphNode>();
    for (const sourceFile of project.getSourceFiles()) {
      const file = relative(snapshot, sourceFile);
      const fileNode: GraphNode = {
        id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "typescript", file, kind: "file", qualifiedName: file }),
        kind: "file",
        name: path.basename(file),
        qualifiedName: file,
        language: "typescript",
        file,
        adapter: "typescript",
        metadata: {},
      };
      graph.addNode(fileNode);
      fileNodes.set(file, fileNode);
      const declarations: Array<[Node, string | undefined, NodeKind, Record<string, unknown>]> = [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).map((item): [FunctionDeclaration, string | undefined, NodeKind, Record<string, unknown>] => [
          item,
          item.getName(),
          "function",
          { async: item.isAsync(), exported: item.isExported() },
        ]),
        ...sourceFile.getClasses().map((item): [ClassDeclaration, string | undefined, NodeKind, Record<string, unknown>] => [
          item,
          item.getName(),
          "class",
          { exported: item.isExported() },
        ]),
        ...sourceFile.getInterfaces().map((item): [InterfaceDeclaration, string | undefined, NodeKind, Record<string, unknown>] => [
          item,
          item.getName(),
          "interface",
          { exported: item.isExported() },
        ]),
        ...sourceFile.getTypeAliases().map((item): [TypeAliasDeclaration, string | undefined, NodeKind, Record<string, unknown>] => [
          item,
          item.getName(),
          "type_alias",
          { exported: item.isExported() },
        ]),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration).map(
          (item): [MethodDeclaration, string | undefined, NodeKind, Record<string, unknown>] => [item, item.getName(), "method", { async: item.isAsync() }],
        ),
        ...sourceFile
          .getVariableDeclarations()
          .filter((item) => Node.isArrowFunction(item.getInitializer()) || Node.isFunctionExpression(item.getInitializer()))
          .map((item): [VariableDeclaration, string | undefined, NodeKind, Record<string, unknown>] => {
            const initializer = item.getInitializer();
            return [
              item,
              item.getName(),
              "function",
              {
                arrow: Node.isArrowFunction(initializer),
                jsxCandidate: initializer ? initializer.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 || initializer.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 : false,
              },
            ];
          }),
      ];
      for (const [declaration, name, kind, metadata] of declarations) {
        if (!name) continue;
        const symbolNode = makeSymbolNode(snapshot, file, declaration, name, kind, {
          ...metadata,
          jsxCandidate:
            metadata.jsxCandidate ??
            (declaration.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0 ||
              declaration.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0),
        });
        graph.addNode(symbolNode);
        nodeByDeclaration.set(declarationKey(declaration), symbolNode);
        const declarationSymbol = declaration.getSymbol();
        for (const symbolDeclaration of declarationSymbol?.getDeclarations() ?? []) {
          nodeByDeclaration.set(declarationKey(symbolDeclaration), symbolNode);
        }
        graph.addEdge(
          withEdgeId({
            source: fileNode.id,
            target: symbolNode.id,
            kind: "contains",
            confidence: "exact",
            evidence: [evidence(file, declaration)],
            metadata: {},
          }),
        );
      }
    }
    for (const sourceFile of project.getSourceFiles()) {
      const file = relative(snapshot, sourceFile);
      const fileNode = fileNodes.get(file);
      if (!fileNode) continue;
      for (const importDeclaration of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
        const specifier = importDeclaration.getModuleSpecifierValue();
        if (!specifier) continue;
        const targetSource = importDeclaration.getModuleSpecifierSourceFile();
        let target: GraphNode | undefined;
        let confidence: "resolved" | "unresolved" = "resolved";
        if (targetSource) {
          target = fileNodes.get(relative(snapshot, targetSource));
        }
        if (!target && !specifier.startsWith(".")) {
          const name = packageName(specifier);
          target = externalNodes.get(name);
          if (!target) {
            target = {
              id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "typescript", kind: "external_package", qualifiedName: name }),
              kind: "external_package",
              name,
              qualifiedName: name,
              language: "typescript",
              adapter: "typescript",
              metadata: {},
            };
            externalNodes.set(name, target);
            graph.addNode(target);
          }
        } else if (!target) {
          confidence = "unresolved";
          target = {
            id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "typescript", file, kind: "unresolved_symbol", qualifiedName: `import:${specifier}` }),
            kind: "unresolved_symbol",
            name: specifier,
            qualifiedName: `import:${specifier}`,
            language: "typescript",
            file,
            adapter: "typescript",
            metadata: { category: "import" },
          };
          graph.addNode(target);
          graph.addDiagnostic({
            code: "unresolved-import",
            severity: "warning",
            message: `Unable to resolve import ${specifier}`,
            file,
            ...(evidence(file, importDeclaration).line ? { line: evidence(file, importDeclaration).line } : {}),
            adapter: "typescript",
            metadata: { specifier },
          });
        }
        if (target) {
          graph.addEdge(
            withEdgeId({
              source: fileNode.id,
              target: target.id,
              kind: "imports",
              confidence,
              evidence: [{ ...evidence(file, importDeclaration), bindingName: specifier, resolutionMethod: targetSource ? "compiler-source-file" : confidence }],
              metadata: {},
            }),
          );
        }
      }
      const calls = [...sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression), ...sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)];
      for (const call of calls as Array<CallExpression | NewExpression>) {
        const expression = call.getExpression();
        const symbol = expression.getSymbol() ?? expression.getType().getSymbol();
        const aliasedSymbol = symbol?.getAliasedSymbol();
        const targets = [...(symbol?.getDeclarations() ?? []), ...(aliasedSymbol?.getDeclarations() ?? [])]
          .map((item) => nodeByDeclaration.get(declarationKey(item)))
          .filter((item): item is GraphNode => Boolean(item));
        const uniqueTargets = [...new Map(targets.map((item) => [item.id, item])).values()];
        const source = nearestOwner(call, nodeByDeclaration, fileNode);
        const callEvidence = { ...evidence(file, call), bindingName: expression.getText() };
        if (uniqueTargets.length === 1) {
          graph.addEdge(
            withEdgeId({ source: source.id, target: uniqueTargets[0]!.id, kind: "calls", confidence: "resolved", evidence: [{ ...callEvidence, resolutionMethod: "compiler-symbol" }], metadata: {} }),
          );
        } else {
          const unresolvedName = expression.getText();
          const unresolved: GraphNode = {
            id: nodeId({
              repositoryIdentity: snapshot.repository.identity,
              language: "typescript",
              file,
              kind: "unresolved_symbol",
              qualifiedName: `call:${unresolvedName}`,
              discriminator: String(call.getStart()),
            }),
            kind: "unresolved_symbol",
            name: unresolvedName,
            qualifiedName: `call:${unresolvedName}`,
            language: "typescript",
            file,
            ...location(call),
            adapter: "typescript",
            metadata: { category: "call", candidateCount: uniqueTargets.length },
          };
          graph.addNode(unresolved);
          graph.addEdge(
            withEdgeId({
              source: source.id,
              target: unresolved.id,
              kind: "calls",
              confidence: "unresolved",
              evidence: [{ ...callEvidence, resolutionMethod: uniqueTargets.length ? "ambiguous-compiler-symbol" : "unresolved-compiler-symbol" }],
              metadata: {},
            }),
          );
          if (Node.isIdentifier(expression)) {
            graph.addDiagnostic({
              code: "unresolved-function-call",
              severity: "info",
              message: `Unable to uniquely resolve call ${unresolvedName}`,
              file,
              ...(callEvidence.line ? { line: callEvidence.line } : {}),
              ...(callEvidence.column ? { column: callEvidence.column } : {}),
              adapter: "typescript",
              metadata: { candidateCount: uniqueTargets.length },
            });
          }
        }
      }
      for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        const symbol = reference.getTypeName().getSymbol();
        const target = symbol?.getDeclarations().map((item) => nodeByDeclaration.get(declarationKey(item))).find(Boolean);
        if (!target) continue;
        const source = nearestOwner(reference, nodeByDeclaration, fileNode);
        graph.addEdge(
          withEdgeId({
            source: source.id,
            target: target.id,
            kind: "uses_type",
            confidence: "resolved",
            evidence: [{ ...evidence(file, reference), bindingName: reference.getText(), resolutionMethod: "compiler-symbol" }],
            metadata: {},
          }),
        );
      }
    }
    return graph.result({ projectFileCount: project.getSourceFiles().length });
  },
};

export function isTypeScriptFile(file: string): boolean {
  return TYPESCRIPT_EXTENSIONS.has(path.extname(file));
}
