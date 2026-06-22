import path from "node:path";
import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import type { GraphNode, SourceEvidence } from "../../../core/graph/schema.js";
import { addKnowledgeEdge, commandStableKey, lineColumnAt } from "../../artifact/utils.js";

function isKnowledge(node: GraphNode): boolean {
  return node.metadata.graphDomain === "knowledge";
}

function isCodeSymbol(node: GraphNode): boolean {
  return !isKnowledge(node) && !["repository", "directory", "file", "external_package", "unresolved_symbol"].includes(node.kind);
}

function evidence(file: string, source: string, index: number, matchedSyntax: string, bindingName: string, method: string): SourceEvidence {
  const position = lineColumnAt(source, Math.max(0, index));
  return { file, line: position.line, column: position.column, adapter: "semanticLinker", matchedSyntax, bindingName, resolutionMethod: method };
}

function nodeEvidence(node: GraphNode, matchedSyntax: string, bindingName: string, method: string): SourceEvidence {
  return {
    ...(node.file ? { file: node.file } : {}),
    ...(node.startLine !== undefined ? { line: node.startLine } : {}),
    ...(node.startColumn !== undefined ? { column: node.startColumn } : {}),
    adapter: "semanticLinker",
    matchedSyntax,
    bindingName,
    resolutionMethod: method,
  };
}

function literalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headingDepth(node: GraphNode): number {
  const depth = Number(node.metadata.headingDepth);
  return Number.isFinite(depth) && depth > 0 ? depth : 1;
}

export const semanticLinkerAdapter: FrameworkAdapter = {
  name: "semanticLinker",
  async detect(snapshot) {
    return snapshot.config.adapters.semanticLinker && graphHasKnowledgeCandidates(snapshot.fileContents);
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.semanticLinker) return emptyAdapterResult();
    const graph = new GraphBuilder();
    const fileNodes = new Map(graphInput.nodes.filter((node) => node.kind === "file" && node.file).map((node) => [node.file!, node]));
    const codeSymbols = graphInput.nodes.filter(isCodeSymbol);
    const symbolsByName = new Map<string, GraphNode[]>();
    for (const node of codeSymbols) symbolsByName.set(node.name, [...(symbolsByName.get(node.name) ?? []), node]);
    const commandNodes = graphInput.nodes.filter((node) => node.kind === "framework_command");
    const packageScriptConfigs = graphInput.nodes.filter((node) => node.kind === "configuration" && node.adapter === "packageJson" && String(node.metadata.stableKey ?? "").includes(":script:"));
    const cliCommands = graphInput.nodes.filter((node) => node.kind === "cli_command");
    const apiSurfaces = graphInput.nodes.filter((node) => node.kind === "api_surface");
    const docSections = graphInput.nodes.filter((node) => node.kind === "doc_section" && node.file);
    const configurations = graphInput.nodes.filter((node) => ["configuration", "security_boundary"].includes(node.kind));
    const tests = graphInput.nodes.filter((node) => node.kind === "test_artifact");

    for (const section of docSections) {
      const file = section.file!;
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      const lines = source.split("\n");
      const startLine = section.startLine ?? 1;
      const currentDepth = headingDepth(section);
      const nextHeadingLine = graphInput.nodes
        .filter((node) => node.kind === "doc_section" && node.file === file && (node.startLine ?? 0) > startLine && headingDepth(node) <= currentDepth)
        .map((node) => node.startLine!)
        .sort((a, b) => a - b)[0] ?? lines.length + 1;
      const body = lines.slice(startLine - 1, nextHeadingLine - 1).join("\n");
      const bodyOffset = lines.slice(0, startLine - 1).join("\n").length + (startLine > 1 ? 1 : 0);
      for (const [candidatePath, target] of fileNodes) {
        if (target.id === section.id || candidatePath === file) continue;
        const index = body.indexOf(candidatePath);
        if (index < 0) continue;
        addKnowledgeEdge(graph, {
          source: section.id,
          target: target.id,
          kind: "mentions",
          confidence: "exact",
          evidence: [evidence(file, source, bodyOffset + index, "file path mention", candidatePath, "exact_path_mention")],
          adapter: "semanticLinker",
          extractionMethod: "exact_path_mention",
          metadata: { targetEvidence: { file: candidatePath } },
        });
      }
      for (const match of body.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        const name = match[1];
        if (!name || name.length < 3) continue;
        const candidates = symbolsByName.get(name) ?? [];
        if (candidates.length !== 1 || match.index === undefined) continue;
        addKnowledgeEdge(graph, {
          source: section.id,
          target: candidates[0]!.id,
          kind: "mentions",
          confidence: "resolved",
          evidence: [evidence(file, source, bodyOffset + match.index, "code span symbol mention", name, "unique_symbol_mention")],
          adapter: "semanticLinker",
          extractionMethod: "unique_symbol_mention",
          metadata: { targetEvidence: { id: candidates[0]!.id, file: candidates[0]!.file } },
        });
      }
      for (const command of cliCommands.filter((node) => node.file === file && (node.startLine ?? 0) >= startLine && (node.startLine ?? Number.POSITIVE_INFINITY) < nextHeadingLine)) {
        addKnowledgeEdge(graph, {
          source: section.id,
          target: command.id,
          kind: "describes_workflow",
          confidence: "exact",
          evidence: [nodeEvidence(command, "markdown command", command.name, "literal-command-under-heading")],
          adapter: "semanticLinker",
          extractionMethod: "literal_command_under_heading",
        });
      }
    }

    for (const command of cliCommands) {
      const literal = commandStableKey(String(command.metadata.literalValue ?? command.name));
      const script = literal.match(/^npm\s+run\s+([A-Za-z0-9_.:-]+)$/)?.[1] ?? (literal === "npm test" ? "test" : undefined);
      if (!script) continue;
      const config = packageScriptConfigs.find((node) => String(node.metadata.stableKey ?? "").endsWith(`:script:${script}`));
      if (!config) continue;
      addKnowledgeEdge(graph, {
        source: command.id,
        target: config.id,
        kind: "related_to",
        confidence: "exact",
        evidence: [nodeEvidence(command, "npm script command", literal, "npm_script_match")],
        adapter: "semanticLinker",
        extractionMethod: "npm_script_match",
        metadata: { targetEvidence: { id: config.id, file: config.file } },
      });
    }

    for (const api of apiSurfaces) {
      const literal = literalString(api.metadata.literalValue) ?? api.name;
      const route = literal.match(/(?:GET|POST|PUT|PATCH|DELETE|ANY)\s+(.+)$/)?.[1] ?? literal;
      for (const [file, source] of snapshot.fileContents) {
        if (!/\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file)) continue;
        const index = source.indexOf(route);
        if (index < 0) continue;
        const target = fileNodes.get(file);
        if (!target) continue;
        addKnowledgeEdge(graph, {
          source: api.id,
          target: target.id,
          kind: "mentions",
          confidence: "resolved",
          evidence: [evidence(file, source, index, "api route literal", route, "api_route_literal_match")],
          adapter: "semanticLinker",
          extractionMethod: "api_route_literal_match",
          metadata: { targetEvidence: { file } },
        });
      }
    }

    for (const config of configurations) {
      const literal = literalString(config.metadata.literalValue);
      if (literal) {
        const target = fileNodes.get(path.posix.normalize(literal));
        if (target) {
          addKnowledgeEdge(graph, {
            source: config.id,
            target: target.id,
            kind: "configures",
            confidence: "exact",
            evidence: [nodeEvidence(config, "config path", literal, "config_path_match")],
            adapter: "semanticLinker",
            extractionMethod: "config_path_match",
            metadata: { targetEvidence: { file: target.file } },
          });
        }
        for (const command of commandNodes) {
          if (!literal.includes(command.name)) continue;
          const parentBoundaries = graphInput.edges
            .filter((edge) => edge.target === config.id)
            .map((edge) => graphInput.nodes.find((node) => node.id === edge.source))
            .filter((node): node is GraphNode => node !== undefined && node.kind === "security_boundary");
          for (const sourceNode of [config, ...parentBoundaries]) {
            addKnowledgeEdge(graph, {
              source: sourceNode.id,
              target: command.id,
              kind: "configures",
              confidence: "resolved",
              evidence: [nodeEvidence(config, "tauri permission", literal, "tauri_permission_match")],
              adapter: "semanticLinker",
              extractionMethod: "tauri_permission_match",
              metadata: { targetEvidence: { id: command.id } },
            });
          }
        }
      }
    }

    for (const test of tests) {
      const candidates = [...new Set([...test.name.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((match) => match[0]))]
        .flatMap((name) => symbolsByName.get(name) ?? []);
      if (candidates.length === 1) {
        addKnowledgeEdge(graph, {
          source: test.id,
          target: candidates[0]!.id,
          kind: "tests",
          confidence: "probable",
          evidence: [nodeEvidence(test, "test name", test.name, "unique_symbol_mention")],
          adapter: "semanticLinker",
          extractionMethod: "unique_symbol_mention",
          metadata: { targetEvidence: { id: candidates[0]!.id, file: candidates[0]!.file } },
        });
      }
    }
    return graph.result({ linkedEdgeCount: graph.edges.size });
  },
};

function graphHasKnowledgeCandidates(contents: Map<string, string>): boolean {
  return [...contents.keys()].some((file) => /\.(?:md|json|toml|ts|tsx|rs)$/.test(file));
}
