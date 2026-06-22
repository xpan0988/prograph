import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, createKnowledgeNode, ensureFileNode, sourceEvidence } from "../utils.js";

function capabilityFiles(files: string[]): string[] {
  return files.filter((file) => /(?:^|\/)src-tauri\/capabilit(?:y|ies)\/[^/]+\.json$/.test(file)).sort();
}

function literalItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" ? [JSON.stringify(item)] : []);
  if (typeof value === "string") return [value];
  return [];
}

export const tauriCapabilityAdapter: FrameworkAdapter = {
  name: "tauriCapability",
  async detect(snapshot) {
    return snapshot.config.adapters.tauriCapability && capabilityFiles(snapshot.files).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.tauriCapability) return emptyAdapterResult();
    const graph = new GraphBuilder();
    for (const file of capabilityFiles(snapshot.files)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      let capability: Record<string, unknown>;
      try {
        capability = JSON.parse(source) as Record<string, unknown>;
      } catch (error) {
        graph.addDiagnostic({ code: "invalid-tauri-capability", severity: "warning", message: `Unable to parse ${file}: ${String(error)}`, file, adapter: "tauriCapability", metadata: {} });
        continue;
      }
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "tauriCapability", "tauri_capability", "config");
      const identifier = typeof capability.identifier === "string" ? capability.identifier : file.replace(/.*\/|\.json$/g, "");
      const index = source.indexOf('"identifier"');
      const evidence = sourceEvidence(file, source, index >= 0 ? index : 0, "tauriCapability", "capability identifier", identifier, "literal-json-key");
      const stableKey = `tauri-capability:${file}:${identifier}`;
      const boundary = createKnowledgeNode(snapshot, {
        kind: "security_boundary",
        name: `capability ${identifier}`,
        qualifiedName: stableKey,
        adapter: "tauriCapability",
        artifactKind: "tauri_capability",
        sourceCategory: "config",
        stableKey,
        file,
        line: evidence.line ?? 1,
        column: evidence.column ?? 1,
        literalValue: capability,
        extractionMethod: "tauri_capability_identifier",
      });
      graph.addNode(boundary);
      addKnowledgeEdge(graph, { source: fileNode.id, target: boundary.id, kind: "configures", confidence: "exact", evidence: [evidence], adapter: "tauriCapability", extractionMethod: "tauri_capability_identifier" });

      for (const [field, items] of [
        ["permissions", literalItems(capability.permissions)],
        ["windows", literalItems(capability.windows)],
        ["webviews", literalItems(capability.webviews)],
      ] as const) {
        for (const item of items) {
          const itemIndex = source.indexOf(JSON.stringify(item));
          const itemEvidence = sourceEvidence(file, source, itemIndex >= 0 ? itemIndex : 0, "tauriCapability", `capability ${field}`, item, "literal-json-value");
          const itemKey = `tauri-capability:${file}:${identifier}:${field}:${item}`;
          const node = createKnowledgeNode(snapshot, {
            kind: "configuration",
            name: `${field} ${item}`,
            qualifiedName: itemKey,
            adapter: "tauriCapability",
            artifactKind: "tauri_capability",
            sourceCategory: "config",
            stableKey: itemKey,
            file,
            line: itemEvidence.line ?? 1,
            column: itemEvidence.column ?? 1,
            literalValue: item,
            extractionMethod: `tauri_capability_${field}`,
          });
          graph.addNode(node);
          addKnowledgeEdge(graph, { source: boundary.id, target: node.id, kind: field === "permissions" ? "contains" : "related_to", confidence: "exact", evidence: [itemEvidence], adapter: "tauriCapability", extractionMethod: `tauri_capability_${field}` });
        }
      }
    }
    return graph.result({ fileCount: capabilityFiles(snapshot.files).length });
  },
};
