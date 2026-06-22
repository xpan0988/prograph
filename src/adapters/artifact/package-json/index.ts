import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, createKnowledgeNode, ensureFileNode, sourceEvidence } from "../utils.js";

type ManifestSection = Record<string, string | Record<string, unknown>>;

function packageFiles(files: string[]): string[] {
  return files.filter((file) => file.endsWith("package.json")).sort();
}

function scriptCommand(script: string): string {
  if (script === "test") return "npm test";
  return `npm run ${script}`;
}

export const packageJsonAdapter: FrameworkAdapter = {
  name: "packageJson",
  async detect(snapshot) {
    return snapshot.config.adapters.packageJson && packageFiles(snapshot.files).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.packageJson) return emptyAdapterResult();
    const graph = new GraphBuilder();
    for (const file of packageFiles(snapshot.files)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(source) as Record<string, unknown>;
      } catch (error) {
        graph.addDiagnostic({ code: "invalid-package-json", severity: "warning", message: `Unable to parse ${file}: ${String(error)}`, file, adapter: "packageJson", metadata: {} });
        continue;
      }
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "packageJson", "package_json", "config");
      const packageName = typeof manifest.name === "string" ? manifest.name : file;
      const packageStableKey = `package:${file}:${packageName}`;
      const packageNode = createKnowledgeNode(snapshot, {
        kind: "configuration",
        name: `package ${packageName}`,
        qualifiedName: packageStableKey,
        adapter: "packageJson",
        artifactKind: "package_json",
        sourceCategory: "config",
        stableKey: packageStableKey,
        file,
        line: 1,
        column: 1,
        literalValue: packageName,
        extractionMethod: "package_manifest",
      });
      graph.addNode(packageNode);
      addKnowledgeEdge(graph, {
        source: fileNode.id,
        target: packageNode.id,
        kind: "configures",
        confidence: "exact",
        evidence: [sourceEvidence(file, source, 0, "packageJson", "package.json", packageName, "literal-manifest")],
        adapter: "packageJson",
        extractionMethod: "package_manifest",
      });

      const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts as ManifestSection : {};
      for (const [script, commandText] of Object.entries(scripts)) {
        const literal = typeof commandText === "string" ? commandText : JSON.stringify(commandText);
        const index = source.indexOf(`"${script}"`);
        const position = sourceEvidence(file, source, index >= 0 ? index : 0, "packageJson", "package script", script, "literal-manifest-key");
        const configKey = `package:${file}:script:${script}`;
        const scriptNode = createKnowledgeNode(snapshot, {
          kind: "configuration",
          name: `script ${script}`,
          qualifiedName: configKey,
          adapter: "packageJson",
          artifactKind: "package_json",
          sourceCategory: "config",
          stableKey: configKey,
          file,
          line: position.line ?? 1,
          column: position.column ?? 1,
          literalValue: literal,
          extractionMethod: "package_script",
        });
        graph.addNode(scriptNode);
        addKnowledgeEdge(graph, { source: packageNode.id, target: scriptNode.id, kind: "configures", confidence: "exact", evidence: [position], adapter: "packageJson", extractionMethod: "package_script" });
        const cli = scriptCommand(script);
        const cliKey = `cli:${cli}`;
        const cliNode = createKnowledgeNode(snapshot, {
          kind: "cli_command",
          name: cli,
          qualifiedName: cliKey,
          adapter: "packageJson",
          artifactKind: "package_json",
          sourceCategory: "config",
          stableKey: cliKey,
          file,
          line: position.line ?? 1,
          column: position.column ?? 1,
          literalValue: cli,
          extractionMethod: "package_script_command",
        });
        graph.addNode(cliNode);
        addKnowledgeEdge(graph, { source: scriptNode.id, target: cliNode.id, kind: "exposes_api", confidence: "exact", evidence: [position], adapter: "packageJson", extractionMethod: "package_script_command" });
      }

      for (const sectionName of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        const section = manifest[sectionName] && typeof manifest[sectionName] === "object" ? manifest[sectionName] as ManifestSection : {};
        for (const [dependency, version] of Object.entries(section)) {
          const index = source.indexOf(`"${dependency}"`);
          const evidence = sourceEvidence(file, source, index >= 0 ? index : 0, "packageJson", sectionName, dependency, "literal-manifest-key");
          const stableKey = `package:${file}:${sectionName}:${dependency}`;
          const dependencyNode = createKnowledgeNode(snapshot, {
            kind: "configuration",
            name: `${sectionName} ${dependency}`,
            qualifiedName: stableKey,
            adapter: "packageJson",
            artifactKind: "package_json",
            sourceCategory: "config",
            stableKey,
            file,
            line: evidence.line ?? 1,
            column: evidence.column ?? 1,
            literalValue: version,
            extractionMethod: "package_dependency",
          });
          graph.addNode(dependencyNode);
          addKnowledgeEdge(graph, { source: packageNode.id, target: dependencyNode.id, kind: "related_to", confidence: "exact", evidence: [evidence], adapter: "packageJson", extractionMethod: "package_dependency" });
        }
      }

      const bin = manifest.bin;
      const entries = typeof bin === "string" ? { [packageName]: bin } : bin && typeof bin === "object" ? bin as ManifestSection : {};
      for (const [name, target] of Object.entries(entries)) {
        const index = source.indexOf(`"${name}"`);
        const evidence = sourceEvidence(file, source, index >= 0 ? index : 0, "packageJson", "bin entry", name, "literal-manifest-key");
        const stableKey = `package:${file}:bin:${name}`;
        const binNode = createKnowledgeNode(snapshot, {
          kind: "cli_command",
          name,
          qualifiedName: stableKey,
          adapter: "packageJson",
          artifactKind: "package_json",
          sourceCategory: "config",
          stableKey,
          file,
          line: evidence.line ?? 1,
          column: evidence.column ?? 1,
          literalValue: target,
          extractionMethod: "package_bin",
        });
        graph.addNode(binNode);
        addKnowledgeEdge(graph, { source: packageNode.id, target: binNode.id, kind: "exposes_api", confidence: "exact", evidence: [evidence], adapter: "packageJson", extractionMethod: "package_bin" });
      }
    }
    return graph.result({ fileCount: packageFiles(snapshot.files).length });
  },
};
