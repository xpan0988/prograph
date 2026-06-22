import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, createKnowledgeNode, ensureFileNode, lineColumnAt, sourceEvidence } from "../utils.js";

interface TomlEntry {
  section: string;
  key: string;
  value: string;
  index: number;
}

function cargoFiles(files: string[]): string[] {
  return files.filter((file) => file.endsWith("Cargo.toml")).sort();
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index - 1] !== "\\") inString = !inString;
    if (character === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

function parseToml(source: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  let section = "";
  let offset = 0;
  let binIndex = -1;
  for (const line of source.split(/\n/)) {
    const trimmed = stripComment(line).trim();
    const sectionMatch = trimmed.match(/^\[\[?([^\]]+)\]?\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].trim();
      if (section === "bin") binIndex += 1;
      offset += line.length + 1;
      continue;
    }
    const entry = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (entry?.[1] && entry[2]) {
      entries.push({
        section: section === "bin" ? `bin:${binIndex}` : section,
        key: entry[1],
        value: entry[2].trim().replace(/^"|"$/g, ""),
        index: offset + Math.max(0, line.indexOf(entry[1])),
      });
    }
    offset += line.length + 1;
  }
  return entries;
}

export const cargoTomlAdapter: FrameworkAdapter = {
  name: "cargoToml",
  async detect(snapshot) {
    return snapshot.config.adapters.cargoToml && cargoFiles(snapshot.files).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.cargoToml) return emptyAdapterResult();
    const graph = new GraphBuilder();
    for (const file of cargoFiles(snapshot.files)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "cargoToml", "cargo_toml", "config");
      const entries = parseToml(source);
      const packageName = entries.find((entry) => entry.section === "package" && entry.key === "name")?.value ?? file;
      const packageEvidence = entries.find((entry) => entry.section === "package" && entry.key === "name");
      const packagePosition = packageEvidence ? lineColumnAt(source, packageEvidence.index) : { line: 1, column: 1 };
      const packageKey = `cargo:${file}:package:${packageName}`;
      const packageNode = createKnowledgeNode(snapshot, {
        kind: "configuration",
        name: `cargo package ${packageName}`,
        qualifiedName: packageKey,
        adapter: "cargoToml",
        artifactKind: "cargo_toml",
        sourceCategory: "config",
        stableKey: packageKey,
        file,
        line: packagePosition.line,
        column: packagePosition.column,
        literalValue: packageName,
        extractionMethod: "cargo_package",
      });
      graph.addNode(packageNode);
      addKnowledgeEdge(graph, {
        source: fileNode.id,
        target: packageNode.id,
        kind: "configures",
        confidence: "exact",
        evidence: [sourceEvidence(file, source, packageEvidence?.index ?? 0, "cargoToml", "Cargo package", packageName, "literal-toml")],
        adapter: "cargoToml",
        extractionMethod: "cargo_package",
      });

      for (const entry of entries) {
        const baseSection = entry.section.replace(/:\d+$/, "");
        if (!["dependencies", "dev-dependencies", "features"].includes(baseSection) && !entry.section.startsWith("bin:")) continue;
        const evidence = sourceEvidence(file, source, entry.index, "cargoToml", baseSection, entry.key, "literal-toml");
        const stableKey = `cargo:${file}:${entry.section}:${entry.key}`;
        const node = createKnowledgeNode(snapshot, {
          kind: "configuration",
          name: `${baseSection} ${entry.key}`,
          qualifiedName: stableKey,
          adapter: "cargoToml",
          artifactKind: "cargo_toml",
          sourceCategory: "config",
          stableKey,
          file,
          line: evidence.line ?? 1,
          column: evidence.column ?? 1,
          literalValue: entry.value,
          extractionMethod: entry.section.startsWith("bin:") ? "cargo_bin" : baseSection === "features" ? "cargo_feature" : "cargo_dependency",
        });
        graph.addNode(node);
        addKnowledgeEdge(graph, {
          source: packageNode.id,
          target: node.id,
          kind: entry.section.startsWith("bin:") ? "exposes_api" : "related_to",
          confidence: "exact",
          evidence: [evidence],
          adapter: "cargoToml",
          extractionMethod: entry.section.startsWith("bin:") ? "cargo_bin" : baseSection === "features" ? "cargo_feature" : "cargo_dependency",
        });
      }
    }
    return graph.result({ fileCount: cargoFiles(snapshot.files).length });
  },
};
