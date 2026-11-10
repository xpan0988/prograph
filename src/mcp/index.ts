import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type ConfidenceQuery } from "../core/query/query-service.js";
import { formatQueryOutput } from "../core/query/output-mode.js";
import { executeIndex } from "../core/analysis/index-execution.js";
import packageJson from "../../package.json" with { type: "json" };
import type { GraphScope } from "../core/graph/schema.js";
import { SEMANTIC_OPERATIONS } from "../core/semantic/query.js";

import { isolatedQueryForRepository, isolatedSemanticRead, type AsyncQueryClient } from "../core/query/isolation.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const contextShape = {
  repository: z.string().optional().describe("Repository path; defaults to the path passed to prograph mcp"),
  index: z.string().optional().describe("Custom index directory or graph.sqlite path"),
};
const boundedShape = {
  ...contextShape,
  maxNodes: z.number().int().min(1).max(500).optional(),
  includeProbable: z.boolean().optional(),
  includeUnresolved: z.boolean().optional(),
  scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional(),
};

function confidence(input: { includeProbable?: boolean | undefined; includeUnresolved?: boolean | undefined; scope?: GraphScope | undefined }): ConfidenceQuery {
  return {
    ...(input.includeProbable ? { includeProbable: true } : {}),
    ...(input.includeUnresolved ? { includeUnresolved: true } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

function response(value: unknown, qualification?: Record<string, unknown>) {
  const payload = formatQueryOutput(value, { mode: "compact", maxEvidence: 1 }) ?? null;
  const structuredContent = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload, ...qualification } : { items: payload, ...qualification };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent };
}

async function withQuery<T>(repository: string, index: string | undefined, signal: AbortSignal, callback: (query: AsyncQueryClient) => T | Promise<T>): Promise<T> {
  return await callback(await isolatedQueryForRepository(repository, index, { signal }));
}

export function createProGraphMcpServer(defaultRepository = ".", defaultIndex?: string): McpServer {
  const server = new McpServer({ name: "prograph", version: packageJson.version }, {
    instructions: "Check get_status before using current source locations. Graph tools read indexed evidence with bounded scope. Use query_semantic for compiler-backed navigation, inspect coverage and truncation, and disambiguate by file, variant and key. Empty results do not establish absence of callers or dependencies.",
  });
  const repo = (input: { repository?: string | undefined }): string => input.repository ?? defaultRepository;
  const index = (input: { index?: string | undefined }): string | undefined => input.index ?? defaultIndex;
  server.registerTool("query_semantic", {
    annotations: readOnly,
    description: "Read bounded snapshot evidence. Use find with an exact name, then pass its key to definition, references, callers or callees. Check get_status for live freshness and use status pages for provider coverage. Empty pages do not prove absence.",
    inputSchema: { ...contextShape, operation: z.enum(SEMANTIC_OPERATIONS), input: z.string().max(1024).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(1024).optional(), snapshot: z.number().int().positive().optional(), maxBytes: z.number().int().min(4096).max(131072).optional() },
  }, async (input, extra) => {
    const value = await isolatedSemanticRead(repo(input), index(input), input.operation, input.input ?? "", { limit: input.limit ?? 50, maxBytes: input.maxBytes ?? 32768, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}) }, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  });

  server.registerTool("get_repository_overview", { annotations: readOnly, description: "Get the indexed repository overview", inputSchema: { ...contextShape, scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional() } }, async (input, extra) =>
    response(await withQuery(repo(input), index(input), extra.signal, (query) => query.overview({ ...(input.scope ? { scope: input.scope } : {}) }))));
  server.registerTool("get_status", { annotations: readOnly, description: "Get repository index freshness", inputSchema: contextShape }, async (input, extra) =>
    response(await executeIndex({ operation: "status", repository: repo(input), ...(index(input) !== undefined ? { index: index(input)! } : {}) }, { signal: extra.signal })));
  server.registerTool("list_files_page", {
    annotations: readOnly,
    description: "Read a bounded file-summary page; continuation is bound to the index generation and scope",
    inputSchema: { ...contextShape, scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().max(1024).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, query => query.filePage({ ...(input.scope ? { scope: input.scope } : {}), limit: input.limit ?? 200, ...(input.cursor ? { cursor: input.cursor } : {}) }))));
  server.registerTool("list_diagnostics_page", {
    annotations: readOnly,
    description: "Read a bounded diagnostics page, with repository-wide severity counts",
    inputSchema: { ...contextShape, limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().max(1024).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, query => query.diagnosticPage({ limit: input.limit ?? 200, ...(input.cursor ? { cursor: input.cursor } : {}) }))));
  server.registerTool("find_symbol", {
    annotations: readOnly,
    description: "Find a bounded set of indexed symbol candidates by name or qualified name. Use query_semantic find for variant-aware exact-name lookup.",
    inputSchema: { ...contextShape, query: z.string(), maxNodes: z.number().int().min(1).max(200).optional(), includeUnresolved: z.boolean().optional(), scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.searchSymbols(input.query, input.maxNodes ?? 20, { ...(input.includeUnresolved ? { includeUnresolved: true } : {}), ...(input.scope ? { scope: input.scope } : {}) }))));
  server.registerTool("get_symbol", {
    annotations: readOnly,
    description: "Get one symbol by stable graph ID",
    inputSchema: { ...contextShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.symbol(input.id))));
  server.registerTool("get_callers", {
    annotations: readOnly,
    description: "Get bounded compatibility graph callers. A reached limit may omit edges. Empty edges do not prove absence of callers.",
    inputSchema: { ...boundedShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.callers(input.id, input.maxNodes ?? 50, confidence(input)))));
  server.registerTool("get_callees", {
    annotations: readOnly,
    description: "Get bounded compatibility graph callees. A reached limit may omit edges. Empty edges do not prove absence of callees.",
    inputSchema: { ...boundedShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.callees(input.id, input.maxNodes ?? 50, confidence(input)))));
  server.registerTool("get_file_dependencies", {
    annotations: readOnly,
    description: "Get bounded file dependencies",
    inputSchema: { ...boundedShape, file: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, async (query) => {
    const details = await query.fileDetails(input.file, confidence(input));
    const dependencies = details.dependencies as unknown[];
    const limit = input.maxNodes ?? dependencies.length;
    return { file: input.file, dependencies: dependencies.slice(0, limit), truncated: dependencies.length > limit };
  })));
  server.registerTool("get_reverse_dependencies", {
    annotations: readOnly,
    description: "Get bounded reverse file dependencies",
    inputSchema: { ...boundedShape, file: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, async (query) => {
    const details = await query.fileDetails(input.file, confidence(input));
    const reverseDependencies = details.reverseDependencies as unknown[];
    const limit = input.maxNodes ?? reverseDependencies.length;
    return { file: input.file, reverseDependencies: reverseDependencies.slice(0, limit), truncated: reverseDependencies.length > limit };
  })));
  server.registerTool("get_neighborhood", {
    annotations: readOnly,
    description: "Get a compact bounded symbol neighborhood",
    inputSchema: { ...boundedShape, id: z.string(), depth: z.number().int().min(0).max(8).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.neighborhood(input.id, { ...confidence(input), depth: input.depth ?? 2, maxNodes: input.maxNodes ?? 50 }))));
  server.registerTool("get_cycles", {
    annotations: readOnly,
    description: "Get a bounded selection of representative import and call cycles. Structured output marks result truncation.",
    inputSchema: boundedShape,
  }, async (input, extra) => withQuery(repo(input), index(input), extra.signal, async (query) => {
    const cycles = await query.cycles(confidence(input));
    const limit = input.maxNodes ?? 50;
    return response(cycles.slice(0, limit), { truncated: cycles.length > limit });
  }));
  server.registerTool("get_framework_bindings", {
    annotations: readOnly,
    description: "Get bounded framework and cross-language boundary evidence; framework may be tauri or a protocol such as http, grpc, graphql",
    inputSchema: { ...boundedShape, framework: z.string().optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.frameworkBindings(input.framework ?? undefined, confidence(input)))));
  server.registerTool("get_context", {
    annotations: readOnly,
    description: "Build deterministic lexical and graph-ranked task context",
    inputSchema: { ...boundedShape, task: z.string(), maxFiles: z.number().int().min(1).max(100).optional(), maxSymbols: z.number().int().min(1).max(200).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.context(input.task, { ...confidence(input), maxFiles: input.maxFiles ?? 20, maxSymbols: input.maxSymbols ?? 50 }))));
  server.registerTool("get_affected", {
    annotations: readOnly,
    description: "Get bounded reverse change impact and candidate related tests",
    inputSchema: { ...boundedShape, input: z.string(), depth: z.number().int().min(1).max(8).optional(), includeTests: z.boolean().optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.affected(input.input, { ...confidence(input), depth: input.depth ?? 3, maxNodes: input.maxNodes ?? 100, includeTests: input.includeTests ?? false }))));
  server.registerTool("get_diagnostics", { annotations: readOnly, description: "Get structured analysis diagnostics", inputSchema: contextShape }, async (input, extra) =>
    response(await withQuery(repo(input), index(input), extra.signal, (query) => query.diagnostics())));
  return server;
}

export async function startMcpServer(repository = ".", index?: string): Promise<void> {
  const server = createProGraphMcpServer(repository, index);
  await server.connect(new StdioServerTransport());
}
