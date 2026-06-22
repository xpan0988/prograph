import path from "node:path";
import { GraphBuilder } from "../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../core/graph/identity.js";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, SourceEvidence } from "../../core/graph/schema.js";
import type { AdapterResult, RepositorySnapshot } from "../../core/adapters/contracts.js";

export type ArtifactKind =
  | "markdown"
  | "package_json"
  | "cargo_toml"
  | "tauri_config"
  | "tauri_capability"
  | "test"
  | "semantic_linker";

export type SourceCategory = "docs" | "config" | "tests" | "semantic";

export function lineColumnAt(source: string, index: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, index));
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function sourceEvidence(file: string, source: string, index: number, adapter: string, matchedSyntax: string, bindingName?: string, resolutionMethod?: string): SourceEvidence {
  const position = lineColumnAt(source, index);
  return {
    file,
    line: position.line,
    column: position.column,
    adapter,
    matchedSyntax,
    ...(bindingName ? { bindingName } : {}),
    ...(resolutionMethod ? { resolutionMethod } : {}),
  };
}

export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[`*_~[\](){}:;,.!?/\\]+/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function commandStableKey(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function knowledgeMetadata(input: {
  artifactKind: ArtifactKind;
  sourceCategory: SourceCategory;
  stableKey: string;
  generatedByAdapter: string;
  sourceFile?: string | undefined;
  sourceLine?: number | undefined;
  sourceColumn?: number | undefined;
  headingDepth?: number | undefined;
  literalValue?: unknown;
  extractionMethod?: string;
}): Record<string, unknown> {
  return {
    graphDomain: "knowledge",
    artifactKind: input.artifactKind,
    sourceCategory: input.sourceCategory,
    stableKey: input.stableKey,
    generatedByAdapter: input.generatedByAdapter,
    ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    ...(input.sourceLine !== undefined ? { sourceLine: input.sourceLine } : {}),
    ...(input.sourceColumn !== undefined ? { sourceColumn: input.sourceColumn } : {}),
    ...(input.headingDepth !== undefined ? { headingDepth: input.headingDepth } : {}),
    ...(input.literalValue !== undefined ? { literalValue: input.literalValue } : {}),
    ...(input.extractionMethod ? { extractionMethod: input.extractionMethod } : {}),
  };
}

export function createKnowledgeNode(snapshot: RepositorySnapshot, input: {
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  adapter: string;
  artifactKind: ArtifactKind;
  sourceCategory: SourceCategory;
  stableKey: string;
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  headingDepth?: number | undefined;
  literalValue?: unknown;
  extractionMethod?: string;
  discriminator?: string;
}): GraphNode {
  return {
    id: nodeId({
      repositoryIdentity: snapshot.repository.identity,
      language: "knowledge",
      ...(input.file ? { file: input.file } : {}),
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(input.discriminator ? { discriminator: input.discriminator } : {}),
    }),
    kind: input.kind,
    name: input.name,
    qualifiedName: input.qualifiedName,
    language: "knowledge",
    ...(input.file ? { file: input.file } : {}),
    ...(input.line !== undefined ? { startLine: input.line } : {}),
    ...(input.column !== undefined ? { startColumn: input.column } : {}),
    adapter: input.adapter,
    metadata: knowledgeMetadata({
      artifactKind: input.artifactKind,
      sourceCategory: input.sourceCategory,
      stableKey: input.stableKey,
      generatedByAdapter: input.adapter,
      ...(input.file ? { sourceFile: input.file } : {}),
      ...(input.line !== undefined ? { sourceLine: input.line } : {}),
      ...(input.column !== undefined ? { sourceColumn: input.column } : {}),
      ...(input.headingDepth !== undefined ? { headingDepth: input.headingDepth } : {}),
      ...(input.literalValue !== undefined ? { literalValue: input.literalValue } : {}),
      ...(input.extractionMethod ? { extractionMethod: input.extractionMethod } : {}),
    }),
  };
}

export function fileLanguage(file: string): string {
  if (file.endsWith(".md")) return "markdown";
  if (file.endsWith(".toml")) return "toml";
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".rs")) return "rust";
  if (/\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file)) return "typescript";
  return "knowledge";
}

export function ensureFileNode(graph: GraphBuilder, snapshot: RepositorySnapshot, graphInput: AdapterResult, file: string, adapter: string, artifactKind: ArtifactKind, sourceCategory: SourceCategory): GraphNode {
  const existing = graphInput.nodes.find((node) => node.kind === "file" && node.file === file);
  if (existing) return existing;
  const language = fileLanguage(file);
  const created: GraphNode = {
    id: nodeId({ repositoryIdentity: snapshot.repository.identity, language, file, kind: "file", qualifiedName: file }),
    kind: "file",
    name: path.basename(file),
    qualifiedName: file,
    language,
    file,
    adapter,
    metadata: knowledgeMetadata({
      artifactKind,
      sourceCategory,
      stableKey: file,
      generatedByAdapter: adapter,
      sourceFile: file,
    }),
  };
  graph.addNode(created);
  return created;
}

export function addKnowledgeEdge(graph: GraphBuilder, input: Omit<GraphEdge, "id" | "metadata"> & { metadata?: Record<string, unknown>; extractionMethod?: string; adapter: string }): void {
  graph.addEdge(withEdgeId({
    source: input.source,
    target: input.target,
    kind: input.kind,
    confidence: input.confidence,
    evidence: input.evidence,
    metadata: {
      graphDomain: "knowledge",
      generatedByAdapter: input.adapter,
      ...(input.extractionMethod ? { extractionMethod: input.extractionMethod } : {}),
      ...(input.metadata ?? {}),
    },
  }));
}
