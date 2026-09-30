import path from "node:path";
import { createRequire } from "node:module";
import Parser, { type SyntaxNode } from "tree-sitter";
import { providerAdapter, capabilities } from "../../../core/adapters/providers.js";
import type { RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { GraphNode, NodeKind, EdgeKind, SourceEvidence } from "../../../core/graph/schema.js";

const require = createRequire(import.meta.url);
interface Frontend { name: string; grammar: string; extensions: string[]; declarations: Record<string, NodeKind> }
const common: Record<string, NodeKind> = {
  class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum",
  record_declaration: "class", struct_declaration: "struct", method_declaration: "method",
  constructor_declaration: "method", namespace_declaration: "module",
};
export const frontends: Frontend[] = [
  { name: "python", grammar: "python", extensions: [".py", ".pyi"], declarations: { function_definition: "function", class_definition: "class", type_alias_statement: "type_alias" } },
  { name: "java", grammar: "java", extensions: [".java"], declarations: { ...common, annotation_type_declaration: "interface", module_declaration: "module" } },
  { name: "c", grammar: "c", extensions: [".c", ".h"], declarations: { function_definition: "function", struct_specifier: "struct", enum_specifier: "enum", union_specifier: "struct", type_definition: "type_alias" } },
  { name: "cpp", grammar: "cpp", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx"], declarations: { function_definition: "function", class_specifier: "class", struct_specifier: "struct", enum_specifier: "enum", union_specifier: "struct", type_definition: "type_alias", alias_declaration: "type_alias", namespace_definition: "module" } },
  { name: "go", grammar: "go", extensions: [".go"], declarations: { function_declaration: "function", method_declaration: "method", type_spec: "type_alias" } },
  { name: "csharp", grammar: "c-sharp", extensions: [".cs"], declarations: { ...common, file_scoped_namespace_declaration: "module", local_function_statement: "function", delegate_declaration: "type_alias" } },
];
const importTypes = new Set(["import_statement", "import_from_statement", "import_declaration", "import_spec", "preproc_include", "using_directive"]);
const callTypes = new Set(["call", "call_expression", "method_invocation", "invocation_expression", "object_creation_expression"]);
const typeTypes = new Set(["type_identifier", "generic_type", "predefined_type"]);
const inheritanceTypes = new Set(["superclass", "super_interfaces", "extends_interfaces", "base_list", "base_class_clause"]);
const annotationTypes = new Set(["decorator", "annotation", "marker_annotation", "attribute"]);
function *walk(root: SyntaxNode): Generator<SyntaxNode> {
  const stack = [root];
  while (stack.length) { const current = stack.pop()!; yield current; const children = current.namedChildren; for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!); }
}
function declarationName(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "type_alias_statement") return node.childForFieldName("left")?.descendantsOfType("identifier")[0] ?? null;
  const direct = node.childForFieldName("name");
  if (direct) return direct;
  let declarator = node.childForFieldName("declarator");
  while (declarator) {
    const inner = declarator.childForFieldName("declarator");
    if (!inner) return declarator;
    declarator = inner;
  }
  return null;
}
async function extract(snapshot: RepositorySnapshot, frontend: Frontend) {
  const graph = new GraphBuilder();
  const parser = new Parser();
  parser.setLanguage((await import(`tree-sitter-${frontend.grammar}`)).default);
  const provider = `tree-sitter-${frontend.grammar}`;
  const buildContexts = new Map<string, Array<{ directory: string; arguments?: string[]; command?: string }>>();
  if (["c", "cpp"].includes(frontend.name)) {
    for (const [databaseFile, content] of snapshot.fileContents) {
      if (path.posix.basename(databaseFile) !== "compile_commands.json") continue;
      try {
        const entries: unknown = JSON.parse(content);
        if (!Array.isArray(entries)) throw Error("Expected an array of compilation commands");
        for (const entry of entries) {
          if (!entry || typeof entry.file !== "string" || typeof entry.directory !== "string") continue;
          const directory = path.resolve(snapshot.repository.root, path.posix.dirname(databaseFile), entry.directory);
          const relative = path.relative(snapshot.repository.root, path.resolve(directory, entry.file)).split(path.sep).join("/");
          const contexts = buildContexts.get(relative) ?? [];
          contexts.push({ directory, ...(Array.isArray(entry.arguments) ? { arguments: entry.arguments.filter((v: unknown) => typeof v === "string") } : {}), ...(typeof entry.command === "string" ? { command: entry.command } : {}) });
          buildContexts.set(relative, contexts);
        }
      } catch (error) { graph.addDiagnostic({ code: "invalid-compilation-database", severity: "warning", message: String(error), file: databaseFile, adapter: frontend.name, metadata: {} }); }
    }
  }
  for (const file of snapshot.files.filter(f => frontend.extensions.includes(path.extname(f)))) {
    const source = snapshot.fileContents.get(file);
    if (source === undefined) continue;
    let tree: Parser.Tree | undefined;
    try {
      tree = parser.parse(source);
      const evidence = (n: SyntaxNode, basis: SourceEvidence["basis"] = "syntax"): SourceEvidence => ({ adapter: frontend.name, provider, basis, file, line: n.startPosition.row + 1, column: n.startPosition.column + 1, endLine: n.endPosition.row + 1, endColumn: n.endPosition.column + 1, matchedSyntax: n.type, resolutionMethod: basis === "syntax" ? "syntax-extraction" : "no-semantic-provider" });
      const makeNode = (kind: NodeKind, name: string, qualifiedName: string, syntax: SyntaxNode, metadata: Record<string, unknown> = {}): GraphNode => ({ id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: frontend.name, file, kind, qualifiedName }), kind, name, qualifiedName, language: frontend.name, file, startLine: syntax.startPosition.row + 1, startColumn: syntax.startPosition.column + 1, endLine: syntax.endPosition.row + 1, endColumn: syntax.endPosition.column + 1, adapter: frontend.name, metadata: { provider, extractionMethod: "syntax", ...metadata } });
      const fileNode = makeNode("file", path.posix.basename(file), file, tree.rootNode, { translationUnit: frontend.name === "c" || frontend.name === "cpp", compileCommandsPresent: buildContexts.has(file), compilationContexts: buildContexts.get(file) ?? [] });
      graph.addNode(fileNode);
      const packageSyntax = tree.rootNode.namedChildren.find(n => ["package_clause", "package_declaration"].includes(n.type));
      if (["python", "java", "go"].includes(frontend.name)) {
        const moduleName = packageSyntax?.namedChildren[0]?.text ?? file.replace(/\.[^.]+$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
        const module = makeNode("module", moduleName, `${file}::module`, packageSyntax ?? tree.rootNode, { package: moduleName });
        graph.addNode(module);
        graph.addEdge(withEdgeId({ source: module.id, target: fileNode.id, kind: "contains", confidence: "exact", evidence: [evidence(packageSyntax ?? tree.rootNode)], metadata: {} }));
      }
      const owners = new Map<number, GraphNode>();
      const names = new Map<string, GraphNode[]>();
      const owner = (n: SyntaxNode): GraphNode => { let parent = n.parent; while (parent) { const found = owners.get(parent.id); if (found) return found; parent = parent.parent; } return fileNode; };
      for (const n of walk(tree.rootNode)) {
        if (n.type === "ERROR" || n.isMissing) graph.addDiagnostic({ code: "syntax-recovery", severity: "warning", message: `Parser recovered unsupported or malformed ${frontend.name} syntax`, adapter: frontend.name, file, line: n.startPosition.row + 1, metadata: { syntax: n.type } });
        let kind = frontend.declarations[n.type];
        if (["c", "cpp"].includes(frontend.name) && n.type === "function_declarator" && ["declaration", "field_declaration"].includes(n.parent?.type ?? "")) kind = "function";
        if (frontend.name === "go" && ["method_elem", "method_spec"].includes(n.type)) kind = "method";
        const name = declarationName(n);
        if (!kind || !name) continue;
        if (frontend.name === "go" && n.type === "type_spec") { const type = n.childForFieldName("type"); kind = type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type_alias"; }
        const parent = owner(n);
        if (kind === "function" && ["class", "struct"].includes(parent.kind)) kind = "method";
        const key = `${parent.qualifiedName}::${name.text}`;
        const overloads = names.get(key) ?? [];
        const node = makeNode(kind, name.text, overloads.length ? `${key}#${overloads.length}` : key, n, {
          declarationSyntax: n.type,
          ...(n.childForFieldName("type_parameters") ? { generics: n.childForFieldName("type_parameters")!.text } : {}),
          ...(n.parent?.type === "template_declaration" ? { template: n.parent.childForFieldName("parameters")?.text } : {}),
          ...(n.childForFieldName("receiver") ? { receiver: n.childForFieldName("receiver")!.text } : {}),
        });
        names.set(key, [...overloads, node]); owners.set(n.id, node); graph.addNode(node);
        graph.addEdge(withEdgeId({ source: parent.id, target: node.id, kind: "contains", confidence: "exact", evidence: [evidence(n)], metadata: {} }));
      }
      for (const n of walk(tree.rootNode)) {
        let parent = owner(n);
        if (annotationTypes.has(n.type) && n.parent?.type === "decorated_definition") { const definition = n.parent.childForFieldName("definition"); parent = definition ? owners.get(definition.id) ?? parent : parent; }
        let kind: EdgeKind | undefined;
        let targetText: string | undefined;
        if (importTypes.has(n.type)) { if (n.type === "import_declaration" && n.namedChildren.some(c => c.type === "import_spec" || c.type === "import_spec_list")) continue; kind = "imports"; targetText = n.text; }
        else if (callTypes.has(n.type)) { kind = "calls"; targetText = (n.childForFieldName("function") ?? n.childForFieldName("name") ?? n.childForFieldName("type") ?? n.namedChildren[0])?.text; }
        else if ((frontend.name === "go" && n.type === "field_declaration" && !n.childForFieldName("name")) || inheritanceTypes.has(n.type) || (frontend.name === "python" && n.parent?.type === "class_definition" && n.id === n.parent.childForFieldName("superclasses")?.id)) { kind = n.type.includes("interfaces") ? "implements" : "extends"; targetText = n.text; }
        else if (typeTypes.has(n.type) || annotationTypes.has(n.type) || (frontend.name === "python" && n.type === "type")) { kind = "uses_type"; targetText = n.text; }
        if (n.type.startsWith("preproc_") && n.type !== "preproc_include") {
          fileNode.metadata.preprocessor = true;
          if (n.type === "preproc_def" || n.type === "preproc_function_def") { const name = n.childForFieldName("name"); if (name) { const macro = makeNode("type_alias", name.text, `${file}::macro::${name.text}`, n, { macro: true }); graph.addNode(macro); graph.addEdge(withEdgeId({ source: fileNode.id, target: macro.id, kind: "contains", confidence: "exact", evidence: [evidence(n)], metadata: {} })); } }
        }
        if (!kind || !targetText) continue;
        // Preserve unresolved evidence even when a lexical candidate can be offered.
        // A local name is only probable: Python rebinding, overloads and preprocessing
        // cannot be proved by these syntax frontends.
        if (kind === "calls" && /^[A-Za-z_][A-Za-z_0-9]*$/.test(targetText)) {
          const candidates = names.get(`${file}::${targetText}`) ?? [];
          if (candidates.length === 1) graph.addEdge(withEdgeId({ source: parent.id, target: candidates[0]!.id, kind, confidence: "probable", evidence: [{ ...evidence(n, "inference"), resolutionMethod: "same-file-name-candidate" }], metadata: { candidateOnly: true } }));
        }
        const target = makeNode("unresolved_symbol", targetText.slice(0, 240), `${parent.qualifiedName}::${kind}::${targetText}`, n, { category: kind });
        graph.addNode(target);
        graph.addEdge(withEdgeId({ source: parent.id, target: target.id, kind, confidence: "unresolved", evidence: [evidence(n, "unresolved")], metadata: { syntaxObserved: true } }));
      }
      const packageNode = tree.rootNode.namedChildren.find(n => ["package_clause", "package_declaration"].includes(n.type));
      fileNode.metadata.module = packageNode?.text ?? file.replace(/\.[^.]+$/, "").replaceAll("/", ".");
    } catch (error) {
      graph.addDiagnostic({ code: "parser-failure", severity: "error", message: String(error), adapter: frontend.name, file, metadata: {} });
    }
  }
  return graph.result();
}
export const polyglotAdapters = frontends.map(frontend => providerAdapter({
  name: frontend.name, version: "1", appliesTo: file => frontend.extensions.includes(path.extname(file)),
  capabilities: capabilities({ syntax: "syntax", symbols: "syntax", modules: "syntax", calls: "heuristic", types: "syntax", inheritance: frontend.name === "c" ? "unsupported" : "syntax", generics: ["java", "cpp", "go", "csharp", "python"].includes(frontend.name) ? "syntax" : "unsupported", macros: ["c", "cpp"].includes(frontend.name) ? "syntax" : "unsupported" }),
  syntax: { descriptor: { id: `tree-sitter-${frontend.grammar}`, version: require(`tree-sitter-${frontend.grammar}/package.json`).version as string, kind: "syntax" }, async extract(snapshot) { return extract(snapshot, frontend); } },
}));
