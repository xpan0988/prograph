import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { type ConfidenceQuery } from "../core/query/query-service.js";
import { formatQueryOutput, type OutputMode } from "../core/query/output-mode.js";
import { repositoryStatus } from "../core/analysis/state.js";
import { syncRepository } from "../core/analysis/sync.js";
import type { GraphScope } from "../core/graph/schema.js";
import { type SemanticOperation } from "../core/semantic/query.js";

import { isolatedQueryForRepository, isolatedSemanticRead, QueryExecutionError, type AsyncQueryClient } from "../core/query/isolation.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  index?: string;
}

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listParam(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function confidenceParams(query: Record<string, unknown>): ConfidenceQuery {
  const selectedScope = scopeParam(query.scope);
  return {
    ...(query.includeProbable === "true" ? { includeProbable: true } : {}),
    ...(query.includeUnresolved === "true" ? { includeUnresolved: true } : {}),
    ...(selectedScope ? { scope: selectedScope } : {}),
  };
}

function scopeParam(value: unknown): GraphScope | undefined {
  return ["code", "code+docs", "code+config", "code+tests", "full"].includes(String(value)) ? String(value) as GraphScope : undefined;
}

function outputParams(query: Record<string, unknown>): { mode: OutputMode; maxEvidence?: number } {
  const mode = ["compact", "standard", "full"].includes(String(query.mode)) ? String(query.mode) as OutputMode : "standard";
  const maxEvidence = query.maxEvidence === undefined ? undefined : numberParam(query.maxEvidence, 3);
  return { mode, ...(maxEvidence !== undefined ? { maxEvidence } : {}) };
}

function sendQuery(response: express.Response, value: unknown, requestQuery: Record<string, unknown>): void {
  response.json(formatQueryOutput(value, outputParams(requestQuery)));
}

export async function startServer(repository = ".", options: ServerOptions = {}): Promise<{ server: Server; url: string }> {
  const probe = await isolatedQueryForRepository(repository, options.index);
  await probe.symbol("__prograph_startup_probe__");
  const app = express();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43117;
  const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
  const queryFor = (response: express.Response) => response.locals.query as AsyncQueryClient;
  app.use("/api", async (_request, response, next) => {
    const controller = new AbortController();
    response.on("close", () => controller.abort()); response.locals.signal = controller.signal;
    try { response.locals.query = await isolatedQueryForRepository(repository, options.index, { signal: controller.signal }); next(); }
    catch (error) { next(error); }
  });
  app.get("/api/overview", async (request, response) => {
    const selectedScope = scopeParam(request.query.scope);
    response.json(await queryFor(response).overview({ ...(selectedScope ? { scope: selectedScope } : {}) }));
  });
  app.get("/api/status", async (_request, response) => response.json(await repositoryStatus(repository, options.index)));
  app.get("/api/semantic/:operation", async (request, response) => {
    try {
      response.json(await isolatedSemanticRead(repository, options.index, request.params.operation as SemanticOperation, String(request.query.input ?? ""), {
        limit: numberParam(request.query.limit, 50), ...(typeof request.query.cursor === "string" ? { cursor: request.query.cursor } : {}),
        maxBytes: numberParam(request.query.maxBytes, 32768), ...(request.query.snapshot !== undefined ? { snapshot: Number(request.query.snapshot) } : {}),
      }, { signal: response.locals.signal as AbortSignal }));
    } catch (error) { response.status(409).json({ error: String(error), semanticAvailable: false, legacyAvailable: true, ...(error instanceof QueryExecutionError ? { code: error.code } : {}) }); }
  });
  app.post("/api/sync", async (_request, response) => response.json(await syncRepository(repository, options.index)));
  app.get("/api/architecture", async (request, response) => sendQuery(response, await queryFor(response).architecture(numberParam(request.query.maxNodes, 100), confidenceParams(request.query)), request.query));
  app.get("/api/files", async (request, response) => {
    const selectedScope = scopeParam(request.query.scope);
    response.json(await queryFor(response).files({ ...(selectedScope ? { scope: selectedScope } : {}) }));
  });
  app.get("/api/files/{*path}", async (request, response) => sendQuery(response, await queryFor(response).fileDetails((request.params.path as unknown as string[]).join("/"), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/search", async (request, response) => {
    const selectedScope = scopeParam(request.query.scope);
    sendQuery(response, await queryFor(response).searchSymbols(String(request.query.q ?? ""), numberParam(request.query.maxNodes, 50), {
      includeUnresolved: request.query.includeUnresolved === "true",
      ...(selectedScope ? { scope: selectedScope } : {}),
    }), request.query);
  });
  app.get("/api/symbols/:id", async (request, response) => {
    const symbol = await queryFor(response).symbol(request.params.id);
    if (!symbol) return response.status(404).json({ error: "Symbol not found" });
    return sendQuery(response, symbol, request.query);
  });
  app.get("/api/symbols/:id/callers", async (request, response) => sendQuery(response, await queryFor(response).callers(request.params.id, numberParam(request.query.maxNodes, 50), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/:id/callees", async (request, response) => sendQuery(response, await queryFor(response).callees(request.params.id, numberParam(request.query.maxNodes, 50), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/:id/neighborhood", async (request, response) => {
    try {
      const edgeKinds = listParam(request.query.edgeKind) as import("../core/graph/schema.js").EdgeKind[] | undefined;
      const nodeKinds = listParam(request.query.nodeKind) as import("../core/graph/schema.js").NodeKind[] | undefined;
      sendQuery(response, await queryFor(response).neighborhood(request.params.id, {
        depth: numberParam(request.query.depth, 2),
        maxNodes: numberParam(request.query.maxNodes, 50),
        ...confidenceParams(request.query),
        ...(edgeKinds ? { edgeKinds } : {}),
        ...(nodeKinds ? { nodeKinds } : {}),
      }), request.query);
    } catch (error) {
      if (error instanceof QueryExecutionError) throw error;
      response.status(404).json({ error: String(error) });
    }
  });
  app.get("/api/cycles", async (request, response) => sendQuery(response, await queryFor(response).cycles(confidenceParams(request.query)), request.query));
  app.get("/api/frameworks", async (request, response) => sendQuery(response, await queryFor(response).frameworkBindings(undefined, confidenceParams(request.query)), request.query));
  app.get("/api/frameworks/tauri", async (request, response) => sendQuery(response, await queryFor(response).frameworkBindings("tauri", confidenceParams(request.query)), request.query));
  app.get("/api/diagnostics", async (_request, response) => response.json(await queryFor(response).diagnostics()));
  app.get("/api/context", async (request, response) => sendQuery(response, await queryFor(response).context(String(request.query.task ?? ""), {
    ...confidenceParams(request.query),
    maxFiles: numberParam(request.query.maxFiles, 20),
    maxSymbols: numberParam(request.query.maxSymbols, 50),
  }), request.query));
  app.get("/api/affected", async (request, response) => {
    try {
      sendQuery(response, await queryFor(response).affected(String(request.query.input ?? ""), {
        ...confidenceParams(request.query),
        depth: numberParam(request.query.depth, 3),
        maxNodes: numberParam(request.query.maxNodes, 100),
        includeTests: request.query.includeTests === "true",
      }), request.query);
    } catch (error) {
      if (error instanceof QueryExecutionError) throw error;
      response.status(404).json({ error: String(error) });
    }
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (!(error instanceof QueryExecutionError)) return next(error);
    const status = error.code === "QUERY_BUSY" ? 429 : error.code === "QUERY_DEADLINE" ? 408 : 409;
    response.status(status).json({ error: error.message, code: error.code });
  });
  app.use(express.static(staticDirectory));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(port, host, (error?: Error) => {
      if (error) reject(error);
      else resolve(candidate);
    });
    candidate.on("error", reject);
  });
  return { server, url: `http://${host}:${port}` };
}
