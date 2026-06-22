import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, commandStableKey, createKnowledgeNode, ensureFileNode, lineColumnAt, slugify, sourceEvidence } from "../utils.js";

const COMMAND_PATTERN = /^(?:\$ |> )?\s*((?:prograph|npm|npm run|npx|cargo|git|pnpm|yarn)\b[^\n]*)/;
const API_PATTERN = /\b(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/api\/[A-Za-z0-9_./:{}*-]+)/g;

function markdownFiles(files: string[]): string[] {
  return files.filter((file) => file.endsWith(".md")).sort();
}

export const markdownAdapter: FrameworkAdapter = {
  name: "markdown",
  async detect(snapshot) {
    return snapshot.config.adapters.markdown && markdownFiles(snapshot.files).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.markdown) return emptyAdapterResult();
    const graph = new GraphBuilder();
    for (const file of markdownFiles(snapshot.files)) {
      const source = snapshot.fileContents.get(file);
      if (source === undefined) continue;
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "markdown", "markdown", "docs");
      const headingCounts = new Map<string, number>();
      let currentSection = fileNode;
      let inFence = false;
      let offset = 0;
      for (const line of source.split(/\n/)) {
        const trimmed = line.trim();
        if (/^```/.test(trimmed)) {
          inFence = !inFence;
          offset += line.length + 1;
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading?.[1] && heading[2]) {
          const position = lineColumnAt(source, offset);
          const baseSlug = slugify(heading[2]);
          const nextCount = (headingCounts.get(baseSlug) ?? 0) + 1;
          headingCounts.set(baseSlug, nextCount);
          const slug = nextCount === 1 ? baseSlug : `${baseSlug}-${nextCount}`;
          const stableKey = `docs:${file}#${slug}`;
          const section = createKnowledgeNode(snapshot, {
            kind: "doc_section",
            name: heading[2].trim(),
            qualifiedName: stableKey,
            adapter: "markdown",
            artifactKind: "markdown",
            sourceCategory: "docs",
            stableKey,
            file,
            line: position.line,
            column: position.column,
            headingDepth: heading[1].length,
            extractionMethod: "markdown_heading",
          });
          graph.addNode(section);
          addKnowledgeEdge(graph, {
            source: fileNode.id,
            target: section.id,
            kind: "contains",
            confidence: "exact",
            evidence: [sourceEvidence(file, source, offset, "markdown", "markdown heading", section.name, "literal-heading")],
            adapter: "markdown",
            extractionMethod: "markdown_heading",
          });
          currentSection = section;
        }

        const command = trimmed.match(COMMAND_PATTERN)?.[1];
        if (command && (inFence || !/[.!?]$/.test(command))) {
          const position = lineColumnAt(source, offset + line.indexOf(command));
          const stableKey = `cli:${commandStableKey(command)}`;
          const commandNode = createKnowledgeNode(snapshot, {
            kind: "cli_command",
            name: commandStableKey(command),
            qualifiedName: stableKey,
            adapter: "markdown",
            artifactKind: "markdown",
            sourceCategory: "docs",
            stableKey,
            file,
            line: position.line,
            column: position.column,
            literalValue: commandStableKey(command),
            extractionMethod: inFence ? "fenced_command" : "literal_command_line",
          });
          graph.addNode(commandNode);
          addKnowledgeEdge(graph, {
            source: currentSection.id,
            target: commandNode.id,
            kind: "contains",
            confidence: "exact",
            evidence: [sourceEvidence(file, source, offset + line.indexOf(command), "markdown", inFence ? "fenced command" : "command line", commandStableKey(command), "literal-command")],
            adapter: "markdown",
            extractionMethod: inFence ? "fenced_command" : "literal_command_line",
          });
          addKnowledgeEdge(graph, {
            source: currentSection.id,
            target: commandNode.id,
            kind: "describes_workflow",
            confidence: "exact",
            evidence: [sourceEvidence(file, source, offset + line.indexOf(command), "markdown", "command workflow", commandStableKey(command), "literal-command")],
            adapter: "markdown",
            extractionMethod: "literal_command_workflow",
          });
        }

        for (const match of line.matchAll(API_PATTERN)) {
          const route = match[2];
          if (!route) continue;
          const method = match[1] ?? "ANY";
          const start = offset + (match.index ?? 0);
          const position = lineColumnAt(source, start);
          const name = `${method} ${route}`;
          const stableKey = `api:${name}`;
          const routeNode = createKnowledgeNode(snapshot, {
            kind: "api_surface",
            name,
            qualifiedName: stableKey,
            adapter: "markdown",
            artifactKind: "markdown",
            sourceCategory: "docs",
            stableKey,
            file,
            line: position.line,
            column: position.column,
            literalValue: name,
            extractionMethod: "api_route_mention",
          });
          graph.addNode(routeNode);
          addKnowledgeEdge(graph, {
            source: currentSection.id,
            target: routeNode.id,
            kind: "exposes_api",
            confidence: "exact",
            evidence: [sourceEvidence(file, source, start, "markdown", "api route mention", name, "literal-api-route")],
            adapter: "markdown",
            extractionMethod: "api_route_mention",
          });
        }
        offset += line.length + 1;
      }
    }
    return graph.result({ fileCount: markdownFiles(snapshot.files).length });
  },
};
