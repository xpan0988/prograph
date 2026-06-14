import path from "node:path";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { DEFAULT_EXCLUDE, loadConfig } from "../src/core/config/config.js";
import { edgeId, nodeId, validateIdentities } from "../src/core/graph/identity.js";
import type { GraphNode } from "../src/core/graph/schema.js";
import { QueryService, queryServiceForRepository } from "../src/core/query/query-service.js";
import { formatQueryOutput } from "../src/core/query/output-mode.js";
import { resolveRepositoryRoot, scanRepository } from "../src/core/repository/repository.js";
import { repositoryStatus } from "../src/core/analysis/state.js";
import { syncRepository } from "../src/core/analysis/sync.js";
import { createDebouncedRunner } from "../src/core/analysis/watch.js";
import { createProGraphMcpServer } from "../src/mcp/index.js";
import { writeResult } from "../src/cli/output.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appShellClassName } from "../src/ui/layout.js";
import { errorFingerprint, shouldDisplayError } from "../src/ui/api-client.js";
import { focusGraph } from "../src/ui/graph/GraphCanvas.js";
import { detectLanguage, initialLanguage, translate } from "../src/ui/i18n/index.js";
import { en } from "../src/ui/i18n/en.js";
import { zhCN } from "../src/ui/i18n/zh-CN.js";

const fixture = path.resolve("tests/fixtures/mixed");
const rustQualityFixture = path.resolve("tests/fixtures/rust-quality");
const rustVerifiedMissesFixture = path.resolve("tests/fixtures/rust-verified-misses");
let output: string;
let analysis: Awaited<ReturnType<typeof analyzeRepository>>;
let rustQualityOutput: string;
let rustQualityAnalysis: Awaited<ReturnType<typeof analyzeRepository>>;
let rustVerifiedMissesOutput: string;
let rustVerifiedMissesAnalysis: Awaited<ReturnType<typeof analyzeRepository>>;

beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), "prograph-test-"));
  analysis = await analyzeRepository(fixture, { output });
  rustQualityOutput = await mkdtemp(path.join(tmpdir(), "prograph-rust-quality-"));
  rustQualityAnalysis = await analyzeRepository(rustQualityFixture, { output: rustQualityOutput });
  rustVerifiedMissesOutput = await mkdtemp(path.join(tmpdir(), "prograph-rust-verified-misses-"));
  rustVerifiedMissesAnalysis = await analyzeRepository(rustVerifiedMissesFixture, { output: rustVerifiedMissesOutput });
});

afterAll(async () => {
  await Promise.all([
    rm(output, { recursive: true, force: true }),
    rm(rustQualityOutput, { recursive: true, force: true }),
    rm(rustVerifiedMissesOutput, { recursive: true, force: true }),
  ]);
});

describe("repository and configuration", () => {
  test("resolves a repository root from a nested working directory", async () => {
    expect(await resolveRepositoryRoot(".", path.join(fixture, "src"))).toBe(fixture);
  });

  test("loads defaults without requiring configuration", async () => {
    const config = await loadConfig(fixture);
    expect(config.include).toContain("**/*.rs");
    expect(DEFAULT_EXCLUDE).toContain("**/node_modules/**");
    expect(config.adapters.tauri).toBe(true);
  });

  test("applies exclusions and reads source without installed packages", async () => {
    const scan = await scanRepository(fixture);
    expect(scan.snapshot.files).toContain("src/App.tsx");
    expect(scan.snapshot.files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(scan.snapshot.fileContents.has("src-tauri/Cargo.toml")).toBe(true);
  });
});

describe("deterministic graph identities", () => {
  test("generates stable node and edge IDs", () => {
    const node = { repositoryIdentity: "repo", language: "typescript", file: "src/a.ts", kind: "function" as const, qualifiedName: "src/a.ts::run" };
    expect(nodeId(node)).toBe(nodeId(node));
    const edge = { source: "a", target: "b", kind: "calls" as const };
    expect(edgeId(edge)).toBe(edgeId(edge));
  });

  test("reports duplicate identities", () => {
    const duplicate: GraphNode = { id: "same", kind: "file", name: "a", qualifiedName: "a", adapter: "test", metadata: {} };
    expect(validateIdentities([duplicate, duplicate], [])).toMatchObject([{ code: "duplicate-node-id" }]);
  });
});

describe("mixed repository analysis", () => {
  test("detects all supported adapters", () => {
    expect(analysis.manifest.enabledAdapters).toEqual(expect.arrayContaining(["typescript", "rust", "react", "tauri"]));
  });

  test("extracts TypeScript, React, and Rust symbols", () => {
    const nodes = analysis.graph.nodes;
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "formatGreeting", kind: "function", language: "typescript" }),
      expect.objectContaining({ name: "App", kind: "react_component" }),
      expect.objectContaining({ name: "Greeting", kind: "struct", language: "rust" }),
      expect.objectContaining({ name: "GreetingKind", kind: "enum", language: "rust" }),
      expect.objectContaining({ name: "RenderGreeting", kind: "trait", language: "rust" }),
    ]));
  });

  test("extracts imports, calls, renders, callbacks, and Tauri bindings", () => {
    const kinds = new Set(analysis.graph.edges.map((edge) => edge.kind));
    for (const kind of ["imports", "calls", "renders", "passes_callback", "invokes", "registers", "emits", "listens"]) {
      expect(kinds.has(kind as import("../src/core/graph/schema.js").EdgeKind)).toBe(true);
    }
    expect(analysis.graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "greet", kind: "framework_command" })]));
    const command = analysis.graph.nodes.find((node) => node.kind === "framework_command" && node.name === "greet");
    const frontendInvocation = analysis.graph.edges.find((edge) => edge.kind === "invokes" && edge.target === command?.id);
    expect(analysis.graph.nodes.find((node) => node.id === frontendInvocation?.source)?.kind).toBe("function");
  });

  test("persists SQLite, manifest, diagnostics, and JSON export", async () => {
    await Promise.all([
      access(path.join(output, "graph.sqlite")),
      access(path.join(output, "manifest.json")),
      access(path.join(output, "diagnostics.json")),
      access(path.join(output, "exports/graph.json")),
    ]);
    const exported = JSON.parse(await readFile(path.join(output, "exports/graph.json"), "utf8")) as { schemaVersion: string };
    expect(exported.schemaVersion).toBe("1.0.0");
  });

  test("serves symbol search, callers, callees, and bounded neighborhoods from SQLite", () => {
    const query = new QueryService(path.join(output, "graph.sqlite"));
    try {
      const symbol = query.searchSymbols("formatGreeting")[0];
      expect(symbol).toBeDefined();
      expect(query.callers(symbol!.id).edges.length).toBeGreaterThan(0);
      expect(query.neighborhood(symbol!.id, { depth: 1, maxNodes: 3 }).nodes.length).toBeLessThanOrEqual(3);
      expect(query.overview()).toHaveProperty("counts");
      expect(query.frameworkBindings("tauri")).toHaveProperty("nodes");
    } finally {
      query.close();
    }
  });

  test("writes compact machine-readable CLI output", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    writeResult({ ok: true }, "json");
    expect(write).toHaveBeenCalledWith('{\n  "ok": true\n}\n');
    write.mockRestore();
  });
});

describe("Rust and Tauri quality regressions", () => {
  test("resolves all 17 source-verified Rust direct-call misses with evidence", () => {
    const expected = [
      ["replay_checks_event_preview_envelope_and_request_ids", "validate_control_event"],
      ["received_inbox_persistence_defaults_to_enabled", "load_or_create"],
      ["received_inbox_persistence_roundtrips", "load_or_create"],
      ["transfer_window_update_is_persisted_when_dev_tools_are_enabled", "load_or_create"],
      ["dev_tools_toggle_is_persisted", "load_or_create"],
      ["micro_flow_group_mode_persists_and_invalid_values_fall_back_to_dynamic", "load_or_create"],
      ["load_or_create", "default_micro_flow_group_mode"],
      ["run_peer_link_benchmark", "quality_label"],
      ["run_loopback_benchmark", "quality_label"],
      ["quick_capability_probe_skips_runtime_commands", "probe_device_capabilities_with_mode"],
      ["battery_devices_are_not_given_heavy_roles", "probe_device_capabilities_with_mode"],
      ["burn_preserves_completed_inbox_file_for_room", "burn_room"],
      ["burn_does_not_delete_completed_file_from_another_room", "burn_room"],
      ["burn_deletes_transient_received_file_for_room", "burn_room"],
      ["burn_skips_saved_path_outside_allowed_roots", "burn_room"],
      ["burn_deletes_pastey_parts_file_for_room_item", "burn_room"],
      ["burned_room_cannot_be_resurrected_or_receive_late_finalized_item", "burn_room"],
    ];
    const names = new Map(rustVerifiedMissesAnalysis.graph.nodes.map((node) => [node.id, node.name]));
    for (const [source, target] of expected) {
      const edge = rustVerifiedMissesAnalysis.graph.edges.find((item) =>
        item.kind === "calls" && names.get(item.source) === source && names.get(item.target) === target);
      expect(edge, `${source} -> ${target}`).toBeDefined();
      expect(edge?.confidence, `${source} -> ${target}`).toBe("resolved");
      expect(edge?.evidence[0]).toMatchObject({ adapter: "rust", bindingName: target });
      expect(edge?.evidence[0]?.line).toBeGreaterThan(0);
    }
  });

  test("binds Rust attributes only to the syntactically decorated item", () => {
    const commands = rustQualityAnalysis.graph.nodes.filter((node) => node.kind === "framework_command").map((node) => node.name);
    expect(commands).toEqual(expect.arrayContaining(["real_command", "command_one", "single_line_command"]));
    expect(commands).not.toEqual(expect.arrayContaining(["ordinary_function", "command_two"]));
  });

  test("resolves repository-local Rust module paths and imported functions", () => {
    const resolvedBindings = rustQualityAnalysis.graph.edges
      .filter((edge) => edge.kind === "calls" && edge.confidence === "resolved")
      .flatMap((edge) => edge.evidence.map((item) => item.bindingName));
    for (const binding of [
      "logging::write_transfer_line",
      "crate::logging::write_transfer_line",
      "self::logging::write_transfer_line",
      "super::logging::write_transfer_line",
      "imported_write",
      "nested_imported_write",
      "nested_write",
      "reexported_write",
      "module_calls",
    ]) {
      expect(resolvedBindings).toContain(binding);
    }
    expect(rustQualityAnalysis.graph.edges.find((edge) => edge.evidence.some((item) => item.bindingName === "external_crate::external_call"))?.confidence).toBe("unresolved");
    expect(rustQualityAnalysis.graph.edges.find((edge) => edge.evidence.some((item) => item.bindingName === "duplicate"))?.confidence).toBe("unresolved");
    const scopedWrites = rustQualityAnalysis.graph.edges.filter((edge) => edge.evidence.some((item) => item.bindingName === "scoped_write"));
    expect(scopedWrites.map((edge) => edge.confidence).sort()).toEqual(["resolved", "unresolved"]);
  });

  test("resolves typed and constructor-inferred inherent methods conservatively", () => {
    const calls = rustQualityAnalysis.graph.edges.filter((edge) => edge.kind === "calls");
    const serviceCalls = calls.filter((edge) => edge.evidence.some((item) => item.bindingName === "service.send"));
    expect(serviceCalls.length).toBeGreaterThanOrEqual(2);
    expect(serviceCalls.every((edge) => edge.confidence === "resolved")).toBe(true);
    expect(calls.find((edge) => edge.evidence.some((item) => item.bindingName === "other.send"))?.confidence).toBe("resolved");
    expect(calls.find((edge) => edge.evidence.some((item) => item.bindingName === "trait_only.send"))?.confidence).toBe("unresolved");
    expect(calls.find((edge) => edge.evidence.some((item) => item.bindingName === "Self::new"))?.confidence).toBe("resolved");
    expect(calls.find((edge) => edge.evidence.some((item) => item.bindingName === "TransferService::new"))?.confidence).toBe("resolved");
  });

  test("resolves Tauri event constants and preserves unknown expressions without false diagnostics", () => {
    const transferEdges = rustQualityAnalysis.graph.edges.filter((edge) => edge.kind === "emits" && edge.evidence[0]?.bindingName === "TRANSFER_EVENT");
    expect(transferEdges).toHaveLength(1);
    expect(transferEdges[0]!.evidence.some((item) => item.matchedSyntax === "const string")).toBe(true);
    expect(rustQualityAnalysis.graph.edges.find((edge) => edge.kind === "emits" && edge.evidence[0]?.bindingName === "LOCAL_EVENT")?.evidence.some((item) => item.matchedSyntax === "const string")).toBe(true);
    expect(rustQualityAnalysis.graph.edges.find((edge) => edge.kind === "emits" && edge.evidence.some((item) => item.bindingName === "events::ALIAS_EVENT"))?.evidence.filter((item) => item.matchedSyntax === "const string")).toHaveLength(2);
    expect(rustQualityAnalysis.graph.edges.find((edge) => edge.kind === "emits" && edge.evidence.some((item) => item.bindingName === "runtime_event"))?.confidence).toBe("unresolved");
    expect(rustQualityAnalysis.graph.diagnostics.some((item) => item.code === "tauri-event-no-producer" && item.message.includes("transfer-progress"))).toBe(false);
  });

  test("points each Tauri registration edge at the individual handler token", async () => {
    const source = await readFile(path.join(rustQualityFixture, "src/lib.rs"), "utf8");
    const lines = source.split("\n");
    const registrations = rustQualityAnalysis.graph.edges.filter((edge) => edge.kind === "registers");
    expect(registrations).toHaveLength(3);
    for (const edge of registrations) {
      const item = edge.evidence[0]!;
      expect(lines[item.line! - 1]!.slice(item.column! - 1)).toMatch(new RegExp(`^(?:commands::)?${item.bindingName}\\b`));
      expect(edge.metadata).toHaveProperty("macroLocation");
    }
  });

  test("defaults queries to trusted relationships and supports a custom index", async () => {
    const query = await queryServiceForRepository(rustQualityFixture, rustQualityOutput);
    try {
      const moduleCalls = query.searchSymbols("module_calls").find((node) => node.name === "module_calls")!;
      expect(query.callees(moduleCalls.id).edges.some((edge) => edge.confidence === "unresolved")).toBe(false);
      expect(query.callees(moduleCalls.id, 50, { includeUnresolved: true }).edges.some((edge) => edge.confidence === "unresolved")).toBe(true);
      expect(query.neighborhood(moduleCalls.id, { depth: 1 }).edges.some((edge) => edge.confidence === "unresolved")).toBe(false);
      const framework = query.frameworkBindings("tauri") as { nodes: GraphNode[]; edges: Array<{ source: string; target: string }> };
      const frameworkIds = new Set(framework.nodes.map((node) => node.id));
      expect(framework.edges.every((edge) => frameworkIds.has(edge.source) && frameworkIds.has(edge.target))).toBe(true);
    } finally {
      query.close();
    }
  });

  test("deduplicates scoped unresolved targets and remains deterministic", async () => {
    const eventCalls = rustQualityAnalysis.graph.nodes.find((node) => node.name === "event_calls" && node.kind === "function")!;
    const unresolvedEmitTargets = new Set(rustQualityAnalysis.graph.edges.filter((edge) => edge.source === eventCalls.id && edge.confidence === "unresolved" && edge.evidence.some((item) => item.bindingName === "app.emit")).map((edge) => edge.target));
    expect(unresolvedEmitTargets.size).toBe(1);
    const secondOutput = await mkdtemp(path.join(tmpdir(), "prograph-rust-quality-repeat-"));
    try {
      const second = await analyzeRepository(rustQualityFixture, { output: secondOutput });
      expect(second.graph.nodes.map((node) => node.id).sort()).toEqual(rustQualityAnalysis.graph.nodes.map((node) => node.id).sort());
      expect(second.graph.edges.map((edge) => edge.id).sort()).toEqual(rustQualityAnalysis.graph.edges.map((edge) => edge.id).sort());
    } finally {
      await rm(secondOutput, { recursive: true, force: true });
    }
  });
});

describe("agent queries and freshness", () => {
  test("formats compact output and limits evidence", () => {
    const query = new QueryService(path.join(output, "graph.sqlite"));
    try {
      const symbol = query.searchSymbols("formatGreeting")[0]!;
      const full = query.neighborhood(symbol.id, { depth: 2, maxNodes: 30 });
      const compact = formatQueryOutput(full, { mode: "compact", maxEvidence: 1 }) as { nodes: Array<Record<string, unknown>>; edges: Array<{ evidence: unknown[] }> };
      expect(compact.nodes[0]).not.toHaveProperty("metadata");
      expect(compact.edges.every((edge) => edge.evidence.length <= 1)).toBe(true);
      expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length);
    } finally {
      query.close();
    }
  });

  test("hides unresolved symbols by default and returns deterministic context and affected tests", () => {
    const query = new QueryService(path.join(output, "graph.sqlite"));
    try {
      expect(query.searchSymbols("invoke").some((node) => node.kind === "unresolved_symbol")).toBe(false);
      const context = query.context("format greeting action", { maxFiles: 5, maxSymbols: 10 }) as { symbols: Array<{ node: GraphNode }> };
      expect(context.symbols.some((item) => item.node.name === "formatGreeting")).toBe(true);
      const symbol = query.searchSymbols("formatGreeting")[0]!;
      const affected = query.affected(symbol.id, { depth: 3, includeTests: true }) as { relatedTests: string[]; directlyAffectedSymbols: GraphNode[] };
      expect(affected.directlyAffectedSymbols.some((node) => node.name === "testFormatGreeting")).toBe(true);
      expect(affected.relatedTests).toContain("test/actions.ts");
    } finally {
      query.close();
    }
  });

  test("detects hash freshness and preserves IDs through conservative sync", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "prograph-sync-repo-"));
    const index = await mkdtemp(path.join(tmpdir(), "prograph-sync-index-"));
    try {
      await cp(fixture, repository, { recursive: true });
      const first = await analyzeRepository(repository, { output: index });
      expect((await repositoryStatus(repository, index)).state).toBe("fresh");
      const actions = path.join(repository, "src/actions.ts");
      await writeFile(actions, `${await readFile(actions, "utf8")}\n// disposable sync edit\n`);
      const stale = await repositoryStatus(repository, index);
      expect(stale.modifiedFiles).toContain("src/actions.ts");
      const synced = await syncRepository(repository, index);
      expect(synced.fallbackReason).toContain("full adapter rebuild");
      expect(synced.statusAfter.state).toBe("fresh");
      const exported = JSON.parse(await readFile(path.join(index, "exports/graph.json"), "utf8")) as { nodes: GraphNode[] };
      const unchangedBefore = first.graph.nodes.find((node) => node.name === "App")?.id;
      expect(exported.nodes.find((node) => node.name === "App")?.id).toBe(unchangedBefore);
      expect((await syncRepository(repository, index)).filesReanalyzed).toBe(0);
    } finally {
      await Promise.all([rm(repository, { recursive: true, force: true }), rm(index, { recursive: true, force: true })]);
    }
  });

  test("incrementally reparses an isolated changed file", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "prograph-isolated-sync-repo-"));
    const index = await mkdtemp(path.join(tmpdir(), "prograph-isolated-sync-index-"));
    try {
      await writeFile(path.join(repository, "package.json"), '{"name":"isolated-sync","private":true}\n');
      await mkdir(path.join(repository, "src"));
      const source = path.join(repository, "src/isolated.ts");
      await writeFile(source, "export function value(): number { return 1; }\n");
      const first = await analyzeRepository(repository, { output: index });
      const firstId = first.graph.nodes.find((node) => node.name === "value")?.id;
      await writeFile(source, "export function value(): number { return 2; }\n");
      const synced = await syncRepository(repository, index);
      expect(synced.incremental).toBe(true);
      expect(synced.filesReanalyzed).toBe(1);
      expect(synced.fallbackReason).toBeUndefined();
      const exported = JSON.parse(await readFile(path.join(index, "exports/graph.json"), "utf8")) as { nodes: GraphNode[] };
      expect(exported.nodes.find((node) => node.name === "value")?.id).toBe(firstId);
    } finally {
      await Promise.all([rm(repository, { recursive: true, force: true }), rm(index, { recursive: true, force: true })]);
    }
  });

  test("removes a deleted isolated file and falls back on configuration or adapter changes", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "prograph-delete-sync-repo-"));
    const index = await mkdtemp(path.join(tmpdir(), "prograph-delete-sync-index-"));
    try {
      await mkdir(path.join(repository, "src"));
      await writeFile(path.join(repository, "package.json"), '{"name":"delete-sync","private":true}\n');
      const source = path.join(repository, "src/isolated.ts");
      await writeFile(source, "export function disposable(): number { return 1; }\n");
      await analyzeRepository(repository, { output: index });
      await rm(source);
      const deleted = await syncRepository(repository, index);
      expect(deleted.filesDeleted).toBe(1);
      expect(deleted.statusAfter.state).toBe("fresh");
      const exported = JSON.parse(await readFile(path.join(index, "exports/graph.json"), "utf8")) as { nodes: GraphNode[] };
      expect(exported.nodes.some((node) => node.name === "disposable")).toBe(false);

      await writeFile(path.join(repository, "prograph.config.json"), '{"exclude":["generated/**"]}\n');
      const configStatus = await repositoryStatus(repository, index);
      expect(configStatus.configChanged).toBe(true);
      expect((await syncRepository(repository, index)).fallbackReason).toBe("configuration changed");

      const statePath = path.join(index, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as { adapterVersions: Record<string, string> };
      state.adapterVersions.rust = "outdated-test-version";
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      const adapterStatus = await repositoryStatus(repository, index);
      expect(adapterStatus.adapterVersionsChanged).toBe(true);
      expect((await syncRepository(repository, index)).fallbackReason).toBe("adapter version changed");
    } finally {
      await Promise.all([rm(repository, { recursive: true, force: true }), rm(index, { recursive: true, force: true })]);
    }
  });

  test("debounces watch events into one synchronization", async () => {
    let syncCount = 0;
    const runner = createDebouncedRunner(async () => {
      syncCount += 1;
    }, 20);
    try {
      runner.schedule();
      runner.schedule();
      runner.schedule();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(syncCount).toBe(1);
    } finally {
      runner.close();
    }
  });

  test("exposes bounded compact MCP tools through the shared query layer", async () => {
    const server = createProGraphMcpServer(fixture, output);
    const client = new Client({ name: "prograph-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_status", "get_context", "get_affected", "get_neighborhood", "get_cycles"]));
      const result = await client.callTool({ name: "find_symbol", arguments: { query: "formatGreeting", maxNodes: 5 } });
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      expect(text).toContain("formatGreeting");
      expect(text).not.toContain("metadata");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("UI layout contract", () => {
  test("renders the no-selection workspace with grouped controls and no inspector", async () => {
    const [{ createElement }, { renderToStaticMarkup }, { App }] = await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("../src/ui/App.js"),
    ]);
    const markup = renderToStaticMarkup(createElement(App));
    expect(markup).toContain('data-inspector-open="false"');
    expect(markup).not.toContain('data-testid="evidence-inspector"');
    expect(markup).toContain("toolbar-group");
    expect(markup).toContain("Search symbols, files, or packages");
    expect(markup).toContain("Trusted only");
    expect(markup).toContain("Standard");
    expect(markup).toContain("Sync");
    expect(markup).toContain("Fit graph");
  });

  test("uses the full workspace without a selection and opens a bounded inspector class on selection", () => {
    expect(appShellClassName(false)).toBe("app-shell");
    expect(appShellClassName(true)).toBe("app-shell inspector-open");
  });

  test("anchors panes explicitly and preserves a measurable graph viewport", async () => {
    const css = await readFile(path.resolve("src/ui/styles.css"), "utf8");
    expect(css).toContain(".app-shell.inspector-open { grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--inspector-width); }");
    expect(css).toContain("grid-column: 1;");
    expect(css).toContain("grid-column: 2;");
    expect(css).toContain("grid-column: 3;");
    expect(css).toContain(".canvas-wrap, .graph-viewport { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }");
    expect(css).toContain("@media (max-width: 1280px)");
    expect(css).toContain(".app-shell, .app-shell.inspector-open { grid-template-columns: var(--sidebar-width) minmax(0, 1fr); }");
    expect(css).toContain("width: min(var(--inspector-width), calc(100vw - var(--sidebar-width)))");
  });

  test("renders the inspector conditionally and observes graph-container resizing", async () => {
    const [appSource, graphSource, inspectorSource] = await Promise.all([
      readFile(path.resolve("src/ui/App.tsx"), "utf8"),
      readFile(path.resolve("src/ui/graph/GraphCanvas.tsx"), "utf8"),
      readFile(path.resolve("src/ui/components/Inspector.tsx"), "utf8"),
    ]);
    expect(appSource).toContain("{selectedNode && <Inspector");
    expect(inspectorSource).toContain('data-testid="evidence-inspector"');
    expect(graphSource).toContain('data-testid="graph-viewport"');
    expect(graphSource).toContain("new ResizeObserver");
    expect(graphSource).toContain("onPaneClick={onDeselect}");
    expect(appSource).toContain('event.key === "Escape"');
  });

  test("localizes English and Simplified Chinese without translating source identities", async () => {
    const [{ createElement }, { renderToStaticMarkup }, { App }] = await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("../src/ui/App.js"),
    ]);
    const english = renderToStaticMarkup(createElement(App, { language: "en" }));
    const chinese = renderToStaticMarkup(createElement(App, { language: "zh-CN" }));
    expect(english).toContain("Repository architecture");
    expect(english).toContain("Diagnostics");
    expect(chinese).toContain("仓库架构");
    expect(chinese).toContain("诊断");
    expect(chinese).toContain("typescript");
    expect(chinese).toContain("rust");
  });

  test("detects browser language, persists preference, and falls back for missing translations", () => {
    expect(detectLanguage("zh-SG")).toBe("zh-CN");
    expect(detectLanguage("en-AU")).toBe("en");
    expect(initialLanguage({ getItem: () => "zh-CN" }, "en-US")).toBe("zh-CN");
    expect(initialLanguage({ getItem: () => null }, "zh-Hans")).toBe("zh-CN");
    expect(translate("zh-CN", "toolbar.maxDepth")).toBe("深度");
    expect(translate("zh-CN", "missing.key")).toBe("missing.key");
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  test("deduplicates transient errors and highlights only a selected neighborhood", () => {
    const fingerprint = errorFingerprint("query", new Error("failed"));
    expect(shouldDisplayError(undefined, fingerprint, 1000)).toBe(true);
    expect(shouldDisplayError({ fingerprint, at: 1000 }, fingerprint, 1500)).toBe(false);
    expect(shouldDisplayError({ fingerprint, at: 1000 }, fingerprint, 5000)).toBe(true);
    const focused = focusGraph(
      [
        { id: "a", position: { x: 0, y: 0 }, data: {}, className: "graph-node" },
        { id: "b", position: { x: 0, y: 0 }, data: {}, className: "graph-node" },
        { id: "c", position: { x: 0, y: 0 }, data: {}, className: "graph-node" },
      ],
      [{ id: "ab", source: "a", target: "b", className: "graph-edge" }],
      "a",
    );
    expect(focused.nodes.find((node) => node.id === "a")?.className).toContain("is-selected");
    expect(focused.nodes.find((node) => node.id === "b")?.className).toContain("is-connected");
    expect(focused.nodes.find((node) => node.id === "c")?.className).toContain("is-dimmed");
    expect(focused.edges[0]?.className).toContain("is-outgoing");
    const isolated = focusGraph(focused.nodes, [], "c");
    expect(isolated.nodes.find((node) => node.id === "a")?.className).not.toContain("is-dimmed");
  });

  test("keeps all seven views and current controls represented in the refactored frontend", async () => {
    const [sidebar, toolbar, status, diagnostics, app] = await Promise.all([
      readFile(path.resolve("src/ui/components/Sidebar.tsx"), "utf8"),
      readFile(path.resolve("src/ui/components/TopToolbar.tsx"), "utf8"),
      readFile(path.resolve("src/ui/components/StatusBar.tsx"), "utf8"),
      readFile(path.resolve("src/ui/components/DiagnosticsView.tsx"), "utf8"),
      readFile(path.resolve("src/ui/App.tsx"), "utf8"),
    ]);
    for (const view of ["architecture", "dependencies", "symbols", "framework", "context", "affected", "diagnostics"]) expect(sidebar).toContain(`"${view}"`);
    for (const control of ["maxDepth", "maxNodes", "confidence", "evidence", "sync", "fit", "reset"]) expect(toolbar).toContain(`toolbar.${control}`);
    expect(status).toContain("state-${state}");
    expect(diagnostics).toContain("diagnostic-filters");
    expect(app).toContain("setLanguages(new Set");
  });
});

test("recovers from malformed Rust source", async () => {
  const malformedOutput = await mkdtemp(path.join(tmpdir(), "prograph-malformed-"));
  try {
    const result = await analyzeRepository(path.resolve("tests/fixtures/malformed"), { output: malformedOutput });
    expect(result.graph.nodes.some((node) => node.name === "still_visible")).toBe(true);
    expect(result.graph.diagnostics.some((diagnostic) => diagnostic.code === "rust-parser-error-node")).toBe(true);
  } finally {
    await rm(malformedOutput, { recursive: true, force: true });
  }
});
