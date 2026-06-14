import path from "node:path";
import type { FrameworkAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { GraphNode, SourceEvidence } from "../../../core/graph/schema.js";
import { isTypeScriptFile } from "../../language/typescript/index.js";

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function ownerAt(nodes: GraphNode[], file: string, line: number): GraphNode | undefined {
  return nodes
    .filter((node) => node.file === file && node.startLine !== undefined && node.endLine !== undefined && node.startLine <= line && node.endLine >= line)
    .sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!))[0];
}

function sourceEvidence(file: string, line: number, syntax: string, bindingName: string): SourceEvidence {
  return { file, line, column: 1, adapter: "react", matchedSyntax: syntax, bindingName };
}

export const reactAdapter: FrameworkAdapter = {
  name: "react",
  async detect(snapshot) {
    if (!snapshot.config.adapters.react) return false;
    return snapshot.files.some((file) => /\.(tsx|jsx)$/.test(file)) || [...snapshot.fileContents.values()].some((value) => /from\s+["']react["']/.test(value));
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.react) return emptyAdapterResult();
    const graph = new GraphBuilder();
    const candidates = graphInput.nodes.filter(
      (node) =>
        node.language === "typescript" &&
        (node.kind === "function" || node.kind === "method") &&
        (/^[A-Z]/.test(node.name) || node.metadata.jsxCandidate === true),
    );
    const byName = new Map<string, GraphNode[]>();
    for (const candidate of candidates) {
      const component: GraphNode = {
        ...candidate,
        kind: "react_component",
        adapter: "react",
        metadata: { ...candidate.metadata, originalKind: candidate.kind, originalAdapter: candidate.adapter },
      };
      graph.addNode(component);
      byName.set(component.name, [...(byName.get(component.name) ?? []), component]);
    }
    const functionNodes = graphInput.nodes.filter((node) => node.language === "typescript" && (node.kind === "function" || node.kind === "method" || node.kind === "react_component"));
    for (const file of snapshot.files.filter(isTypeScriptFile)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)) {
        const name = match[1]?.split(".").at(-1);
        if (!name || match.index === undefined) continue;
        const line = lineAt(source, match.index);
        const owner = ownerAt([...candidates, ...functionNodes], file, line);
        if (!owner) continue;
        const targets = byName.get(name) ?? [];
        let target = targets.length === 1 ? targets[0] : undefined;
        let confidence: "resolved" | "probable" | "unresolved" = targets.length === 1 ? "resolved" : targets.length > 1 ? "probable" : "unresolved";
        if (!target) {
          target = {
            id: nodeId({
              repositoryIdentity: snapshot.repository.identity,
              language: "typescript",
              file,
              kind: "unresolved_symbol",
              qualifiedName: `jsx:${name}`,
              discriminator: String(match.index),
            }),
            kind: "unresolved_symbol",
            name,
            qualifiedName: `jsx:${name}`,
            language: "typescript",
            file,
            startLine: line,
            adapter: "react",
            metadata: { category: "jsx-component", candidateCount: targets.length },
          };
          graph.addNode(target);
        }
        graph.addEdge(
          withEdgeId({
            source: owner.id,
            target: target.id,
            kind: "renders",
            confidence,
            evidence: [{ ...sourceEvidence(file, line, "jsx-element", name), resolutionMethod: confidence === "resolved" ? "unique-component-name" : "component-name-heuristic" }],
            metadata: {},
          }),
        );
      }
      for (const match of source.matchAll(/\b(on[A-Z][A-Za-z0-9_]*)\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g)) {
        const prop = match[1];
        const callback = match[2];
        if (!prop || !callback || match.index === undefined) continue;
        const line = lineAt(source, match.index);
        const owner = ownerAt([...candidates, ...functionNodes], file, line);
        const targets = functionNodes.filter((node) => node.name === callback);
        if (!owner || targets.length !== 1) {
          graph.addDiagnostic({
            code: "unresolved-react-callback",
            severity: "info",
            message: `Unable to uniquely resolve React callback prop ${prop}={${callback}}`,
            file,
            line,
            adapter: "react",
            metadata: { prop, callback, candidateCount: targets.length },
          });
          continue;
        }
        graph.addEdge(
          withEdgeId({
            source: owner.id,
            target: targets[0]!.id,
            kind: "passes_callback",
            confidence: "resolved",
            evidence: [{ ...sourceEvidence(file, line, "jsx-attribute", callback), resolutionMethod: "unique-function-name" }],
            metadata: { prop },
          }),
        );
      }
    }
    return graph.result({ componentCount: candidates.length });
  },
};
