import path from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { DEFAULT_EXCLUDE, loadConfig } from "../src/core/config/config.js";
import { edgeId, nodeId, validateIdentities } from "../src/core/graph/identity.js";
import type { GraphNode } from "../src/core/graph/schema.js";
import { QueryService } from "../src/core/query/query-service.js";
import { resolveRepositoryRoot, scanRepository } from "../src/core/repository/repository.js";
import { writeResult } from "../src/cli/output.js";

const fixture = path.resolve("tests/fixtures/mixed");
let output: string;
let analysis: Awaited<ReturnType<typeof analyzeRepository>>;

beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), "prograph-test-"));
  analysis = await analyzeRepository(fixture, { output });
});

afterAll(async () => {
  await rm(output, { recursive: true, force: true });
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
