import type { AdapterResult, FrameworkAdapter, LanguageAdapter, RepositorySnapshot } from "../adapters/contracts.js";
import type { AdapterRun } from "../graph/schema.js";

export async function runAdapter(adapter: LanguageAdapter | FrameworkAdapter, snapshot: RepositorySnapshot, graph: AdapterResult, framework: boolean): Promise<{ result: AdapterResult; run: AdapterRun }> {
  const applicable = !framework && (adapter as LanguageAdapter).appliesTo;
  if (applicable) snapshot = { ...snapshot, files: snapshot.files.filter(applicable) };
  const started = performance.now();
  let detected = false;
  let result: AdapterResult = { nodes: [], edges: [], diagnostics: [], metadata: {} };
  try {
    if (snapshot.config.adapters[adapter.name as keyof typeof snapshot.config.adapters] === false) return { result, run: { adapter: adapter.name, detected: false, durationMs: 0, fileCount: 0, nodeCount: 0, edgeCount: 0, diagnosticCount: 0 } };
    detected = framework
      ? await (adapter as FrameworkAdapter).detect(snapshot, graph)
      : await (adapter as LanguageAdapter).detect(snapshot);
    if (detected) {
      result = framework ? await (adapter as FrameworkAdapter).analyze(snapshot, graph) : await (adapter as LanguageAdapter).analyze(snapshot);
    }
  } catch (error) {
    result.diagnostics.push({
      code: "adapter-failure",
      severity: "error",
      message: `Adapter ${adapter.name} failed: ${String(error)}`,
      adapter: adapter.name,
      metadata: {},
    });
  }
  return {
    result,
    run: {
      adapter: adapter.name,
      metadata: { version: (adapter as LanguageAdapter).version, capabilities: (adapter as LanguageAdapter).capabilities, ...result.metadata },
      detected,
      durationMs: Math.round(performance.now() - started),
      fileCount: detected ? snapshot.files.length : 0,
      nodeCount: result.nodes.length,
      edgeCount: result.edges.length,
      diagnosticCount: result.diagnostics.length,
    },
  };
}

