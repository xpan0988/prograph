import type { FrameworkAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { EdgeKind, GraphNode, SourceEvidence } from "../../../core/graph/schema.js";

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function fileNode(nodes: GraphNode[], file: string): GraphNode | undefined {
  return nodes.find((node) => node.kind === "file" && node.file === file);
}

function ownerAt(nodes: GraphNode[], file: string, line: number): GraphNode | undefined {
  return nodes
    .filter(
      (node) =>
        node.file === file &&
        ["function", "method", "react_component"].includes(node.kind) &&
        node.startLine !== undefined &&
        node.endLine !== undefined &&
        node.startLine <= line &&
        node.endLine >= line,
    )
    .sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!))[0] ?? fileNode(nodes, file);
}

function evidence(file: string, line: number, syntax: string, bindingName: string, method: string): SourceEvidence {
  return { file, line, column: 1, adapter: "tauri", matchedSyntax: syntax, bindingName, resolutionMethod: method };
}

function frameworkNode(snapshot: RepositorySnapshot, kind: "framework_command" | "framework_event", name: string): GraphNode {
  return {
    id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "framework", kind, qualifiedName: `tauri:${kind}:${name}` }),
    kind,
    name,
    qualifiedName: `tauri:${kind}:${name}`,
    language: "framework",
    adapter: "tauri",
    metadata: { framework: "tauri" },
  };
}

export const tauriAdapter: FrameworkAdapter = {
  name: "tauri",
  async detect(snapshot) {
    if (!snapshot.config.adapters.tauri) return false;
    return [...snapshot.fileContents.entries()].some(([file, source]) => {
      if (/tauri\.conf\.(json|json5)$/.test(file)) return true;
      if (file.endsWith("package.json")) {
        try {
          const manifest = JSON.parse(source) as Record<string, Record<string, string> | undefined>;
          return Object.keys(manifest.dependencies ?? {}).some((key) => key.startsWith("@tauri-apps/")) ||
            Object.keys(manifest.devDependencies ?? {}).some((key) => key.startsWith("@tauri-apps/"));
        } catch {
          return false;
        }
      }
      if (file.endsWith("Cargo.toml")) return /^\s*tauri(?:-build)?\s*=/m.test(source);
      return /\bfrom\s+["']@tauri-apps\/api|\bimport\s*\(\s*["']@tauri-apps\/api|\btauri::Builder\b|\buse\s+tauri::/.test(source);
    });
  },
  async analyze(snapshot, graphInput) {
    if (!snapshot.config.adapters.tauri) return emptyAdapterResult();
    const graph = new GraphBuilder();
    const commandNodes = new Map<string, GraphNode>();
    const eventNodes = new Map<string, GraphNode>();
    const invocations = new Map<string, number>();
    const registrations = new Map<string, number>();
    const rustCommands = new Map<string, GraphNode[]>();
    const eventProducers = new Map<string, number>();
    const eventConsumers = new Map<string, number>();
    const command = (name: string): GraphNode => {
      const existing = commandNodes.get(name);
      if (existing) return existing;
      const created = frameworkNode(snapshot, "framework_command", name);
      commandNodes.set(name, created);
      graph.addNode(created);
      return created;
    };
    const event = (name: string): GraphNode => {
      const existing = eventNodes.get(name);
      if (existing) return existing;
      const created = frameworkNode(snapshot, "framework_event", name);
      eventNodes.set(name, created);
      graph.addNode(created);
      return created;
    };
    for (const node of graphInput.nodes.filter((item) => item.language === "rust" && (item.kind === "function" || item.kind === "method"))) {
      const attributes = Array.isArray(node.metadata.attributes) ? node.metadata.attributes : [];
      if (attributes.some((attribute) => typeof attribute === "string" && /tauri\s*::\s*command/.test(attribute))) {
        rustCommands.set(node.name, [...(rustCommands.get(node.name) ?? []), node]);
        const commandNode = command(node.name);
        graph.addEdge(
          withEdgeId({
            source: commandNode.id,
            target: node.id,
            kind: "invokes",
            confidence: "exact",
            evidence: [evidence(node.file ?? "", node.startLine ?? 1, "tauri::command attribute", node.name, "attribute-name")],
            metadata: { framework: "tauri", role: "command-definition" },
          }),
        );
      }
    }
    for (const [name, definitions] of rustCommands) {
      if (definitions.length > 1) {
        graph.addDiagnostic({
          code: "duplicate-tauri-command-name",
          severity: "error",
          message: `Multiple Rust Tauri commands use the name ${name}`,
          adapter: "tauri",
          metadata: { ids: definitions.map((item) => item.id) },
        });
      }
    }
    for (const [file, source] of snapshot.fileContents) {
      if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(file)) {
        for (const match of source.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
          const name = match[1];
          if (!name || match.index === undefined) continue;
          const line = lineAt(source, match.index);
          const owner = ownerAt(graphInput.nodes, file, line);
          if (!owner) continue;
          invocations.set(name, (invocations.get(name) ?? 0) + 1);
          graph.addEdge(
            withEdgeId({
              source: owner.id,
              target: command(name).id,
              kind: "invokes",
              confidence: "exact",
              evidence: [evidence(file, line, "invoke()", name, "literal-command-name")],
              metadata: { framework: "tauri" },
            }),
          );
        }
        const eventPatterns: Array<[RegExp, EdgeKind, Map<string, number>]> = [
          [/\blisten\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g, "listens", eventConsumers],
          [/\bonce\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g, "listens", eventConsumers],
          [/\bemit\s*\(\s*["'`]([^"'`]+)["'`]/g, "emits", eventProducers],
        ];
        for (const [pattern, kind, counts] of eventPatterns) {
          for (const match of source.matchAll(pattern)) {
            const name = match[1];
            if (!name || match.index === undefined) continue;
            const line = lineAt(source, match.index);
            const owner = ownerAt(graphInput.nodes, file, line);
            if (!owner) continue;
            counts.set(name, (counts.get(name) ?? 0) + 1);
            graph.addEdge(
              withEdgeId({
                source: kind === "emits" ? owner.id : event(name).id,
                target: kind === "emits" ? event(name).id : owner.id,
                kind,
                confidence: "exact",
                evidence: [evidence(file, line, `${kind}()`, name, "literal-event-name")],
                metadata: { framework: "tauri" },
              }),
            );
          }
        }
      }
      if (file.endsWith(".rs")) {
        for (const match of source.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)) {
          const body = match[1] ?? "";
          const baseIndex = match.index ?? 0;
          for (const name of body.split(",").map((item) => item.trim().split("::").at(-1)).filter((item): item is string => Boolean(item && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)))) {
            const line = lineAt(source, baseIndex);
            const owner = fileNode(graphInput.nodes, file);
            if (!owner) continue;
            registrations.set(name, (registrations.get(name) ?? 0) + 1);
            graph.addEdge(
              withEdgeId({
                source: owner.id,
                target: command(name).id,
                kind: "registers",
                confidence: "exact",
                evidence: [evidence(file, line, "generate_handler!", name, "literal-handler-name")],
                metadata: { framework: "tauri" },
              }),
            );
          }
        }
        const eventPatterns: Array<[RegExp, EdgeKind, Map<string, number>]> = [
          [/\.emit(?:_to|_filter)?\s*\(\s*["']([^"']+)["']/g, "emits", eventProducers],
          [/\.listen(?:_global|_any)?\s*\(\s*["']([^"']+)["']/g, "listens", eventConsumers],
        ];
        for (const [pattern, kind, counts] of eventPatterns) {
          for (const match of source.matchAll(pattern)) {
            const name = match[1];
            if (!name || match.index === undefined) continue;
            const line = lineAt(source, match.index);
            const owner = ownerAt(graphInput.nodes, file, line);
            if (!owner) continue;
            counts.set(name, (counts.get(name) ?? 0) + 1);
            graph.addEdge(
              withEdgeId({
                source: kind === "emits" ? owner.id : event(name).id,
                target: kind === "emits" ? event(name).id : owner.id,
                kind,
                confidence: "probable",
                evidence: [evidence(file, line, `Rust ${kind}`, name, "literal-event-name")],
                metadata: { framework: "tauri" },
              }),
            );
          }
        }
      }
    }
    for (const [name, count] of invocations) {
      if (!rustCommands.has(name)) {
        graph.addDiagnostic({ code: "unmatched-tauri-invoke", severity: "warning", message: `Frontend invokes ${name}, but no matching Rust command was detected`, adapter: "tauri", metadata: { name, invocationCount: count } });
      }
    }
    for (const name of rustCommands.keys()) {
      if (!registrations.has(name)) graph.addDiagnostic({ code: "unregistered-tauri-command", severity: "warning", message: `Rust command ${name} is not present in a detected generate_handler! registration`, adapter: "tauri", metadata: { name } });
      if (!invocations.has(name)) graph.addDiagnostic({ code: "unused-tauri-command", severity: "info", message: `Registered Rust command ${name} has no detected frontend invocation`, adapter: "tauri", metadata: { name } });
    }
    for (const name of registrations.keys()) {
      if (!rustCommands.has(name)) graph.addDiagnostic({ code: "registered-tauri-command-missing-definition", severity: "warning", message: `Registered Tauri command ${name} has no detected #[tauri::command] definition`, adapter: "tauri", metadata: { name } });
    }
    for (const name of new Set([...eventProducers.keys(), ...eventConsumers.keys()])) {
      if (!eventProducers.has(name)) graph.addDiagnostic({ code: "tauri-event-no-producer", severity: "info", message: `Tauri event ${name} has consumers but no detected producer`, adapter: "tauri", metadata: { name } });
      if (!eventConsumers.has(name)) graph.addDiagnostic({ code: "tauri-event-no-consumer", severity: "info", message: `Tauri event ${name} has producers but no detected consumer`, adapter: "tauri", metadata: { name } });
    }
    return graph.result({ commandCount: commandNodes.size, eventCount: eventNodes.size });
  },
};
