import type { FrameworkAdapter, RepositorySnapshot } from "../../../core/adapters/contracts.js";
import { emptyAdapterResult } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import type { EdgeKind, GraphNode, SourceEvidence } from "../../../core/graph/schema.js";

interface Position {
  line: number;
  column: number;
}

interface StringConstant {
  file: string;
  modulePath: string[];
  ownerId: string;
  name: string;
  expression: string;
  index: number;
  evidence: SourceEvidence;
}

function positionAt(source: string, index: number): Position {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
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

function evidence(file: string, position: Position, syntax: string, bindingName: string, method: string): SourceEvidence {
  return { file, line: position.line, column: position.column, adapter: "tauri", matchedSyntax: syntax, bindingName, resolutionMethod: method };
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

function rustModulePath(file: string): string[] {
  const parts = file.split("/");
  const sourceIndex = parts.lastIndexOf("src");
  const relative = parts.slice(sourceIndex >= 0 ? sourceIndex + 1 : 0);
  const final = relative.at(-1)?.replace(/\.rs$/, "");
  if (!final || final === "lib" || final === "main" || final === "mod") return relative.slice(0, -1);
  return [...relative.slice(0, -1), final];
}

function moduleKey(parts: string[]): string {
  return parts.join("::");
}

function relativePath(parts: string[], currentModule: string[]): string[] {
  const result = [...parts];
  if (result[0] === "crate") return result.slice(1);
  if (result[0] === "self") return [...currentModule, ...result.slice(1)];
  let module = [...currentModule];
  while (result[0] === "super") {
    module = module.slice(0, -1);
    result.shift();
  }
  return [...module, ...result];
}

function parseUseBindings(source: string): Array<{ alias: string; path: string[] }> {
  const bindings: Array<{ alias: string; path: string[] }> = [];
  for (const match of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const brace = raw.match(/^(.*?)::\{([\s\S]*)\}$/);
    const entries = brace ? (brace[2] ?? "").split(",").map((item) => `${brace[1]}::${item.trim()}`) : [raw];
    for (const entry of entries) {
      const [rawPath, rawAlias] = entry.split(/\s+as\s+/);
      const parts = rawPath?.split("::").filter(Boolean) ?? [];
      const alias = rawAlias?.trim() || parts.at(-1);
      if (alias && !entry.endsWith("::*")) bindings.push({ alias, path: parts });
    }
  }
  return bindings;
}

function stringLiteral(expression: string): string | undefined {
  const trimmed = expression.trim();
  const match = trimmed.match(/^"([^"]*)"$/) ?? trimmed.match(/^r#*"([\s\S]*?)"#*$/);
  return match?.[1];
}

function eventArgumentPatterns(): Array<{ pattern: RegExp; kind: EdgeKind; expressionGroup: number }> {
  return [
    { pattern: /\.emit(?:_filter)?\s*\(\s*([^,\n)]+)/g, kind: "emits", expressionGroup: 1 },
    { pattern: /\.emit_to\s*\(\s*[^,\n)]+\s*,\s*([^,\n)]+)/g, kind: "emits", expressionGroup: 1 },
    { pattern: /\.listen(?:_global|_any)?\s*\(\s*([^,\n)]+)/g, kind: "listens", expressionGroup: 1 },
  ];
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
    const unresolvedEventNodes = new Map<string, GraphNode>();
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
    const unresolvedEvent = (file: string, expression: string): GraphNode => {
      const key = `${file}:${expression}`;
      const existing = unresolvedEventNodes.get(key);
      if (existing) return existing;
      const created: GraphNode = {
        id: nodeId({ repositoryIdentity: snapshot.repository.identity, language: "framework", file, kind: "unresolved_symbol", qualifiedName: `tauri:event-expression:${key}` }),
        kind: "unresolved_symbol",
        name: expression,
        qualifiedName: `tauri:event-expression:${key}`,
        language: "framework",
        file,
        adapter: "tauri",
        metadata: { framework: "tauri", category: "event-expression" },
      };
      unresolvedEventNodes.set(key, created);
      graph.addNode(created);
      return created;
    };

    for (const node of graphInput.nodes.filter((item) => item.language === "rust" && (item.kind === "function" || item.kind === "method"))) {
      const attributes = Array.isArray(node.metadata.attributes) ? node.metadata.attributes : [];
      const attributeIndex = attributes.findIndex((attribute) => typeof attribute === "string" && /^tauri\s*::\s*command(?:\s*\(.*\))?$/.test(attribute));
      if (attributeIndex < 0) continue;
      rustCommands.set(node.name, [...(rustCommands.get(node.name) ?? []), node]);
      const commandNode = command(node.name);
      const attributeEvidence = Array.isArray(node.metadata.attributeEvidence) ? node.metadata.attributeEvidence[attributeIndex] as SourceEvidence | undefined : undefined;
      graph.addEdge(withEdgeId({
        source: commandNode.id,
        target: node.id,
        kind: "invokes",
        confidence: "exact",
        evidence: attributeEvidence
          ? [{ ...attributeEvidence, adapter: "tauri", bindingName: node.name, resolutionMethod: "structured-rust-attribute" }]
          : [evidence(node.file ?? "", { line: node.startLine ?? 1, column: node.startColumn ?? 1 }, "tauri::command attribute", node.name, "structured-rust-attribute")],
        metadata: { framework: "tauri", role: "command-definition" },
      }));
    }
    for (const [name, definitions] of rustCommands) {
      if (definitions.length > 1) {
        graph.addDiagnostic({ code: "duplicate-tauri-command-name", severity: "error", message: `Multiple Rust Tauri commands use the name ${name}`, adapter: "tauri", metadata: { ids: definitions.map((item) => item.id) } });
      }
    }

    const constants: StringConstant[] = [];
    const importsByModule = new Map<string, Array<{ alias: string; path: string[] }>>();
    for (const [file, source] of snapshot.fileContents) {
      if (!file.endsWith(".rs")) continue;
      const modulePath = rustModulePath(file);
      importsByModule.set(moduleKey(modulePath), parseUseBindings(source));
      for (const match of source.matchAll(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);/g)) {
        if (!match[1] || !match[2] || match.index === undefined) continue;
        const position = positionAt(source, match.index);
        constants.push({
          file,
          modulePath,
          ownerId: ownerAt(graphInput.nodes, file, position.line)?.id ?? fileNode(graphInput.nodes, file)?.id ?? file,
          name: match[1],
          expression: match[2].trim(),
          index: match.index,
          evidence: evidence(file, position, "const string", match[1], "constant-definition"),
        });
      }
    }
    const constantsByPath = new Map<string, StringConstant[]>();
    for (const constant of constants) {
      const key = moduleKey([...constant.modulePath, constant.name]);
      constantsByPath.set(key, [...(constantsByPath.get(key) ?? []), constant]);
    }
    const resolveEventExpression = (expression: string, file: string, ownerId: string, callIndex: number, seen = new Set<string>()): { name: string; evidence: SourceEvidence[] } | undefined => {
      const literal = stringLiteral(expression);
      if (literal !== undefined) return { name: literal, evidence: [] };
      const modulePath = rustModulePath(file);
      const parts = expression.trim().replace(/^&/, "").split("::").filter(Boolean);
      if (!parts.length) return undefined;
      let paths: string[][];
      if (parts.length === 1) {
        const imported = importsByModule.get(moduleKey(modulePath))?.filter((binding) => binding.alias === parts[0]) ?? [];
        paths = [...imported.map((binding) => relativePath(binding.path, modulePath)), [...modulePath, parts[0]!], parts];
      } else {
        paths = [relativePath(parts, modulePath), parts];
      }
      const candidates = [...new Map(paths.flatMap((candidate) => constantsByPath.get(moduleKey(candidate)) ?? []).map((item) => [`${item.file}:${item.index}`, item])).values()]
        .filter((item) => item.file !== file || item.index < callIndex)
        .filter((item) => {
          const itemOwner = graphInput.nodes.find((node) => node.id === item.ownerId);
          return itemOwner?.kind === "file" || item.ownerId === ownerId;
        })
        .sort((a, b) => (a.file === file ? -1 : 1) - (b.file === file ? -1 : 1) || b.index - a.index);
      const selected = candidates[0];
      if (!selected || (candidates[1] && selected.file !== file && candidates[1].file !== file)) return undefined;
      const key = `${selected.file}:${selected.index}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      const resolved = resolveEventExpression(selected.expression, selected.file, selected.ownerId, selected.index, seen);
      return resolved ? { name: resolved.name, evidence: [selected.evidence, ...resolved.evidence] } : undefined;
    };

    for (const [file, source] of snapshot.fileContents) {
      if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(file)) {
        for (const match of source.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
          const name = match[1];
          if (!name || match.index === undefined) continue;
          const position = positionAt(source, match.index);
          const owner = ownerAt(graphInput.nodes, file, position.line);
          if (!owner) continue;
          invocations.set(name, (invocations.get(name) ?? 0) + 1);
          graph.addEdge(withEdgeId({ source: owner.id, target: command(name).id, kind: "invokes", confidence: "exact", evidence: [evidence(file, position, "invoke()", name, "literal-command-name")], metadata: { framework: "tauri" } }));
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
            const position = positionAt(source, match.index);
            const owner = ownerAt(graphInput.nodes, file, position.line);
            if (!owner) continue;
            counts.set(name, (counts.get(name) ?? 0) + 1);
            graph.addEdge(withEdgeId({
              source: kind === "emits" ? owner.id : event(name).id,
              target: kind === "emits" ? event(name).id : owner.id,
              kind,
              confidence: "exact",
              evidence: [evidence(file, position, `${kind}()`, name, "literal-event-name")],
              metadata: { framework: "tauri" },
            }));
          }
        }
      }
      if (!file.endsWith(".rs")) continue;
      for (const match of source.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)) {
        const body = match[1] ?? "";
        const macroIndex = match.index ?? 0;
        const bodyIndex = macroIndex + match[0].indexOf(body);
        const macroPosition = positionAt(source, macroIndex);
        let segmentStart = 0;
        for (const segment of body.split(",")) {
          const token = segment.match(/(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)/);
          const name = token?.[1];
          if (name && token?.index !== undefined) {
            const tokenIndex = bodyIndex + segmentStart + token.index + token[0].lastIndexOf(name);
            const tokenPosition = positionAt(source, tokenIndex);
            const owner = fileNode(graphInput.nodes, file);
            if (owner) {
              registrations.set(name, (registrations.get(name) ?? 0) + 1);
              graph.addEdge(withEdgeId({
                source: owner.id,
                target: command(name).id,
                kind: "registers",
                confidence: "exact",
                evidence: [evidence(file, tokenPosition, "generate_handler! handler", name, "literal-handler-token")],
                metadata: { framework: "tauri", macroLocation: { file, ...macroPosition } },
              }));
            }
          }
          segmentStart += segment.length + 1;
        }
      }
      for (const { pattern, kind, expressionGroup } of eventArgumentPatterns()) {
        for (const match of source.matchAll(pattern)) {
          const expression = match[expressionGroup]?.trim();
          if (!expression || match.index === undefined) continue;
          const position = positionAt(source, match.index);
          const owner = ownerAt(graphInput.nodes, file, position.line);
          if (!owner) continue;
          const resolved = resolveEventExpression(expression, file, owner.id, match.index);
          if (resolved) {
            const counts = kind === "emits" ? eventProducers : eventConsumers;
            counts.set(resolved.name, (counts.get(resolved.name) ?? 0) + 1);
            graph.addEdge(withEdgeId({
              source: kind === "emits" ? owner.id : event(resolved.name).id,
              target: kind === "emits" ? event(resolved.name).id : owner.id,
              kind,
              confidence: "probable",
              evidence: [evidence(file, position, `Rust ${kind}`, expression, resolved.evidence.length ? "repository-string-constant" : "literal-event-name"), ...resolved.evidence],
              metadata: { framework: "tauri", eventExpression: expression },
            }));
          } else {
            const unresolved = unresolvedEvent(file, expression);
            graph.addEdge(withEdgeId({
              source: kind === "emits" ? owner.id : unresolved.id,
              target: kind === "emits" ? unresolved.id : owner.id,
              kind,
              confidence: "unresolved",
              evidence: [evidence(file, position, `Rust ${kind}`, expression, "unresolved-event-expression")],
              metadata: { framework: "tauri", eventExpression: expression },
            }));
          }
        }
      }
    }
    for (const [name, count] of invocations) {
      if (!rustCommands.has(name)) graph.addDiagnostic({ code: "unmatched-tauri-invoke", severity: "warning", message: `Frontend invokes ${name}, but no matching Rust command was detected`, adapter: "tauri", metadata: { name, invocationCount: count } });
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
    return graph.result({ commandCount: commandNodes.size, eventCount: eventNodes.size, unresolvedEventExpressionCount: unresolvedEventNodes.size });
  },
};
