import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type ConfidenceQuery } from "../core/query/query-service.js";
import { formatQueryOutput } from "../core/query/output-mode.js";
import { repositoryStatus } from "../core/analysis/state.js";
import packageJson from "../../package.json" with { type: "json" };
import type { GraphScope } from "../core/graph/schema.js";
import { SEMANTIC_OPERATIONS } from "../core/semantic/query.js";

import { isolatedQueryForRepository, isolatedSemanticRead, type AsyncQueryClient } from "../core/query/isolation.js";

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

function response(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(formatQueryOutput(value, { mode: "compact", maxEvidence: 1 })) }] };
}

async function withQuery<T>(repository: string, index: string | undefined, signal: AbortSignal, callback: (query: AsyncQueryClient) => T | Promise<T>): Promise<T> {
  return await callback(await isolatedQueryForRepository(repository, index, { signal }));
}

export function createProGraphMcpServer(defaultRepository = ".", defaultIndex?: string): McpServer {
  const server = new McpServer({ name: "prograph", version: packageJson.version });
  const repo = (input: { repository?: string | undefined }): string => input.repository ?? defaultRepository;
  const index = (input: { index?: string | undefined }): string | undefined => input.index ?? defaultIndex;
  server.registerTool("query_semantic", {
    description: "Bounded Semantic Core navigation, project/native details; returns snapshot, coverage and evidence; legacy workflows remain compatible",
    inputSchema: { ...contextShape, operation: z.enum(SEMANTIC_OPERATIONS), input: z.string().max(1024).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(1024).optional(), snapshot: z.number().int().positive().optional(), maxBytes: z.number().int().min(4096).max(131072).optional() },
  }, async (input, extra) => {
    const value = await isolatedSemanticRead(repo(input), index(input), input.operation, input.input ?? "", { limit: input.limit ?? 50, maxBytes: input.maxBytes ?? 32768, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}) }, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  });

  server.registerTool("get_repository_overview", { description: "Get the indexed repository overview", inputSchema: { ...contextShape, scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional() } }, async (input, extra) =>
    response(await withQuery(repo(input), index(input), extra.signal, (query) => query.overview({ ...(input.scope ? { scope: input.scope } : {}) }))));
  server.registerTool("get_status", { description: "Get repository index freshness", inputSchema: contextShape }, async (input, extra) =>
    response(await repositoryStatus(repo(input), index(input))));
  server.registerTool("list_files_page", {
    description: "Read a bounded file-summary page; continuation is bound to the index generation and scope",
    inputSchema: { ...contextShape, scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().max(1024).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, query => query.filePage({ ...(input.scope ? { scope: input.scope } : {}), limit: input.limit ?? 200, ...(input.cursor ? { cursor: input.cursor } : {}) }))));
  server.registerTool("list_diagnostics_page", {
    description: "Read a bounded diagnostics page, with repository-wide severity counts",
    inputSchema: { ...contextShape, limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().max(1024).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, query => query.diagnosticPage({ limit: input.limit ?? 200, ...(input.cursor ? { cursor: input.cursor } : {}) }))));
  server.registerTool("find_symbol", {
    description: "Find trusted concrete symbols by name or qualified name",
    inputSchema: { ...contextShape, query: z.string(), maxNodes: z.number().int().min(1).max(200).optional(), includeUnresolved: z.boolean().optional(), scope: z.enum(["code", "code+docs", "code+config", "code+tests", "full"]).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.searchSymbols(input.query, input.maxNodes ?? 20, { ...(input.includeUnresolved ? { includeUnresolved: true } : {}), ...(input.scope ? { scope: input.scope } : {}) }))));
  server.registerTool("get_symbol", {
    description: "Get one symbol by stable graph ID",
    inputSchema: { ...contextShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.symbol(input.id))));
  server.registerTool("get_callers", {
    description: "Get bounded trusted callers",
    inputSchema: { ...boundedShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.callers(input.id, input.maxNodes ?? 50, confidence(input)))));
  server.registerTool("get_callees", {
    description: "Get bounded trusted callees",
    inputSchema: { ...boundedShape, id: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.callees(input.id, input.maxNodes ?? 50, confidence(input)))));
  server.registerTool("get_file_dependencies", {
    description: "Get bounded file dependencies",
    inputSchema: { ...boundedShape, file: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, async (query) => {
    const details = await query.fileDetails(input.file, confidence(input));
    return { file: input.file, dependencies: details.dependencies };
  })));
  server.registerTool("get_reverse_dependencies", {
    description: "Get bounded reverse file dependencies",
    inputSchema: { ...boundedShape, file: z.string() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, async (query) => {
    const details = await query.fileDetails(input.file, confidence(input));
    return { file: input.file, reverseDependencies: details.reverseDependencies };
  })));
  server.registerTool("get_neighborhood", {
    description: "Get a compact bounded symbol neighborhood",
    inputSchema: { ...boundedShape, id: z.string(), depth: z.number().int().min(0).max(8).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.neighborhood(input.id, { ...confidence(input), depth: input.depth ?? 2, maxNodes: input.maxNodes ?? 50 }))));
  server.registerTool("get_cycles", {
    description: "Get trusted import and call cycles",
    inputSchema: boundedShape,
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, async (query) => (await query.cycles(confidence(input))).slice(0, input.maxNodes ?? 50))));
  server.registerTool("get_framework_bindings", {
    description: "Get bounded framework and cross-language boundary evidence; framework may be tauri or a protocol such as http, grpc, graphql",
    inputSchema: { ...boundedShape, framework: z.string().optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.frameworkBindings(input.framework ?? undefined, confidence(input)))));
  server.registerTool("get_context", {
    description: "Build deterministic lexical and graph-ranked task context",
    inputSchema: { ...boundedShape, task: z.string(), maxFiles: z.number().int().min(1).max(100).optional(), maxSymbols: z.number().int().min(1).max(200).optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.context(input.task, { ...confidence(input), maxFiles: input.maxFiles ?? 20, maxSymbols: input.maxSymbols ?? 50 }))));
  server.registerTool("get_affected", {
    description: "Get bounded reverse change impact and candidate related tests",
    inputSchema: { ...boundedShape, input: z.string(), depth: z.number().int().min(1).max(8).optional(), includeTests: z.boolean().optional() },
  }, async (input, extra) => response(await withQuery(repo(input), index(input), extra.signal, (query) => query.affected(input.input, { ...confidence(input), depth: input.depth ?? 3, maxNodes: input.maxNodes ?? 100, includeTests: input.includeTests ?? false }))));
  server.registerTool("get_diagnostics", { description: "Get structured analysis diagnostics", inputSchema: contextShape }, async (input, extra) =>
    response(await withQuery(repo(input), index(input), extra.signal, (query) => query.diagnostics())));
  return server;
}

export async function startMcpServer(repository = ".", index?: string): Promise<void> {
  const server = createProGraphMcpServer(repository, index);
  await server.connect(new StdioServerTransport());
}
