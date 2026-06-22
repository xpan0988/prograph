import path from "node:path";
import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { addKnowledgeEdge, createKnowledgeNode, ensureFileNode, lineColumnAt, sourceEvidence } from "../utils.js";

function isTsTestFile(file: string): boolean {
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file) || /(?:^|\/)tests?\/.*\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file);
}

function testFiles(files: string[], contents: Map<string, string>): string[] {
  return files.filter((file) => isTsTestFile(file) || (file.endsWith(".rs") && /#\s*\[\s*test\s*\]/.test(contents.get(file) ?? ""))).sort();
}

function detectedFramework(file: string, source: string): string {
  if (file.endsWith(".rs")) return "cargo";
  if (/from\s+["']vitest["']|vitest/.test(source)) return "vitest";
  if (/from\s+["']node:test["']/.test(source)) return "node:test";
  if (/\bjest\b/.test(source)) return "jest";
  return "unknown";
}

function resolveImport(file: string, specifier: string, existingFiles: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, path.posix.join(base, "index.ts"), path.posix.join(base, "index.tsx")];
  return candidates.find((candidate) => existingFiles.has(candidate));
}

function filenameTarget(file: string, existingFiles: Set<string>): string | undefined {
  const direct = file.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
  if (direct !== file && existingFiles.has(direct)) return direct;
  const basename = path.posix.basename(direct);
  const srcCandidate = path.posix.join("src", basename);
  if (existingFiles.has(srcCandidate)) return srcCandidate;
  return undefined;
}

export const testsAdapter: FrameworkAdapter = {
  name: "tests",
  async detect(snapshot) {
    return snapshot.config.adapters.tests && testFiles(snapshot.files, snapshot.fileContents).length > 0;
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.tests) return emptyAdapterResult();
    const graph = new GraphBuilder();
    const existingFiles = new Set(snapshot.files);
    const fileNodes = new Map(graphInput.nodes.filter((node) => node.kind === "file" && node.file).map((node) => [node.file!, node]));
    for (const file of testFiles(snapshot.files, snapshot.fileContents)) {
      const source = snapshot.fileContents.get(file);
      if (!source) continue;
      const fileNode = ensureFileNode(graph, snapshot, graphInput, file, "tests", "test", "tests");
      const framework = detectedFramework(file, source);
      const tests: Array<{ name: string; index: number; method: string }> = [];
      if (file.endsWith(".rs")) {
        for (const match of source.matchAll(/#\s*\[\s*test\s*\][\s\S]*?\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
          if (match[1] && match.index !== undefined) tests.push({ name: match[1], index: match.index, method: "rust_test_attribute" });
        }
      } else {
        for (const match of source.matchAll(/\b(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
          if (match[1] && match.index !== undefined) tests.push({ name: match[1], index: match.index, method: "test_call" });
        }
      }
      if (!tests.length) tests.push({ name: path.posix.basename(file), index: 0, method: "test_file" });
      const createdTests = tests.map((test, index) => {
        const position = lineColumnAt(source, test.index);
        const stableKey = `test:${file}:${test.method}:${test.name}:${index}`;
        const node = createKnowledgeNode(snapshot, {
          kind: "test_artifact",
          name: test.name,
          qualifiedName: stableKey,
          adapter: "tests",
          artifactKind: "test",
          sourceCategory: "tests",
          stableKey,
          file,
          line: position.line,
          column: position.column,
          literalValue: test.name,
          extractionMethod: test.method,
          discriminator: `${test.index}:${index}`,
        });
        graph.addNode(node);
        addKnowledgeEdge(graph, { source: fileNode.id, target: node.id, kind: "contains", confidence: "exact", evidence: [sourceEvidence(file, source, test.index, "tests", test.method, test.name, "literal-test-syntax")], adapter: "tests", extractionMethod: test.method });
        node.metadata = { ...node.metadata, detectedFramework: framework };
        return node;
      });

      const linkedTargets = new Set<string>();
      for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const specifier = match[1] ?? match[2];
        if (!specifier || match.index === undefined) continue;
        const targetFile = resolveImport(file, specifier, existingFiles);
        const target = targetFile ? fileNodes.get(targetFile) : undefined;
        if (!target || linkedTargets.has(target.id)) continue;
        linkedTargets.add(target.id);
        for (const test of createdTests) {
          addKnowledgeEdge(graph, { source: test.id, target: target.id, kind: "tests", confidence: "resolved", evidence: [sourceEvidence(file, source, match.index, "tests", "test import", specifier, "test_import_match")], adapter: "tests", extractionMethod: "test_import_match" });
        }
      }
      const filenameMatch = filenameTarget(file, existingFiles);
      const filenameNode = filenameMatch ? fileNodes.get(filenameMatch) : undefined;
      if (filenameNode && !linkedTargets.has(filenameNode.id)) {
        for (const test of createdTests) {
          addKnowledgeEdge(graph, { source: test.id, target: filenameNode.id, kind: "tests", confidence: "resolved", evidence: [sourceEvidence(file, source, 0, "tests", "test filename", path.posix.basename(file), "test_file_name_match")], adapter: "tests", extractionMethod: "test_file_name_match" });
        }
      }
    }
    return graph.result({ fileCount: testFiles(snapshot.files, snapshot.fileContents).length });
  },
};
