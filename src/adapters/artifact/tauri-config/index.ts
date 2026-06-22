import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, createKnowledgeNode, ensureFileNode, sourceEvidence } from "../utils.js";

const CONFIG_KEYS = ["productName", "identifier", "build", "app", "windows", "bundle", "security", "csp", "capabilities"] as const;

function tauriConfigFiles(files: string[]): string[] {
  return files.filter((file) => /(?:^|\/)tauri\.conf\.json$/.test(file)).sort();
}

function findValue(manifest: unknown, key: string): unknown {
  if (!manifest || typeof manifest !== "object") return undefined;
  const record = manifest as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  for (const value of Object.values(record)) {
    const found = findValue(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const tauriConfigAdapter: FrameworkAdapter = {
  name: "tauriConfig",
  async detect(snapshot) {
    return snapshot.config.adapters.tauriConfig && tauriConfigFiles(snapshot.files).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.tauriConfig) return emptyAdapterResult();
    const graph = new GraphBuilder();
    for (const file of tauriConfigFiles(snapshot.files)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(source) as Record<string, unknown>;
      } catch (error) {
        graph.addDiagnostic({ code: "invalid-tauri-config", severity: "warning", message: `Unable to parse ${file}: ${String(error)}`, file, adapter: "tauriConfig", metadata: {} });
        continue;
      }
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "tauriConfig", "tauri_config", "config");
      for (const key of CONFIG_KEYS) {
        const value = findValue(manifest, key);
        if (value === undefined) continue;
        const index = source.indexOf(`"${key}"`);
        const evidence = sourceEvidence(file, source, index >= 0 ? index : 0, "tauriConfig", "tauri config", key, "literal-json-key");
        const kind = ["security", "csp", "capabilities"].includes(key) ? "security_boundary" : "configuration";
        const stableKey = `tauri-config:${file}:${key}`;
        const node = createKnowledgeNode(snapshot, {
          kind,
          name: `tauri ${key}`,
          qualifiedName: stableKey,
          adapter: "tauriConfig",
          artifactKind: "tauri_config",
          sourceCategory: "config",
          stableKey,
          file,
          line: evidence.line ?? 1,
          column: evidence.column ?? 1,
          literalValue: value,
          extractionMethod: kind === "security_boundary" ? "tauri_security_config" : "tauri_config_key",
        });
        graph.addNode(node);
        addKnowledgeEdge(graph, {
          source: fileNode.id,
          target: node.id,
          kind: "configures",
          confidence: "exact",
          evidence: [evidence],
          adapter: "tauriConfig",
          extractionMethod: kind === "security_boundary" ? "tauri_security_config" : "tauri_config_key",
        });
      }
    }
    return graph.result({ fileCount: tauriConfigFiles(snapshot.files).length });
  },
};
