import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { queryServiceForRepository, type ConfidenceQuery } from "../core/query/query-service.js";
import { formatQueryOutput, type OutputMode } from "../core/query/output-mode.js";
import { repositoryStatus } from "../core/analysis/state.js";
import { syncRepository } from "../core/analysis/sync.js";

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
  return {
    ...(query.includeProbable === "true" ? { includeProbable: true } : {}),
    ...(query.includeUnresolved === "true" ? { includeUnresolved: true } : {}),
  };
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
  const query = await queryServiceForRepository(repository, options.index);
  const app = express();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43117;
  const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
  app.get("/api/overview", (_request, response) => response.json(query.overview()));
  app.get("/api/status", async (_request, response) => response.json(await repositoryStatus(repository, options.index)));
  app.post("/api/sync", async (_request, response) => response.json(await syncRepository(repository, options.index)));
  app.get("/api/architecture", (request, response) => sendQuery(response, query.architecture(numberParam(request.query.maxNodes, 100), confidenceParams(request.query)), request.query));
  app.get("/api/files", (_request, response) => response.json(query.files()));
  app.get("/api/files/{*path}", (request, response) => sendQuery(response, query.fileDetails((request.params.path as unknown as string[]).join("/"), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/search", (request, response) => sendQuery(response, query.searchSymbols(String(request.query.q ?? ""), numberParam(request.query.maxNodes, 50), { includeUnresolved: request.query.includeUnresolved === "true" }), request.query));
  app.get("/api/symbols/:id", (request, response) => {
    const symbol = query.symbol(request.params.id);
    if (!symbol) return response.status(404).json({ error: "Symbol not found" });
    return sendQuery(response, symbol, request.query);
  });
  app.get("/api/symbols/:id/callers", (request, response) => sendQuery(response, query.callers(request.params.id, numberParam(request.query.maxNodes, 50), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/:id/callees", (request, response) => sendQuery(response, query.callees(request.params.id, numberParam(request.query.maxNodes, 50), confidenceParams(request.query)), request.query));
  app.get("/api/symbols/:id/neighborhood", (request, response) => {
    try {
      const edgeKinds = listParam(request.query.edgeKind) as import("../core/graph/schema.js").EdgeKind[] | undefined;
      const nodeKinds = listParam(request.query.nodeKind) as import("../core/graph/schema.js").NodeKind[] | undefined;
      sendQuery(response, query.neighborhood(request.params.id, {
        depth: numberParam(request.query.depth, 2),
        maxNodes: numberParam(request.query.maxNodes, 50),
        ...confidenceParams(request.query),
        ...(edgeKinds ? { edgeKinds } : {}),
        ...(nodeKinds ? { nodeKinds } : {}),
      }), request.query);
    } catch (error) {
      response.status(404).json({ error: String(error) });
    }
  });
  app.get("/api/cycles", (request, response) => sendQuery(response, query.cycles(confidenceParams(request.query)), request.query));
  app.get("/api/frameworks", (request, response) => sendQuery(response, query.frameworkBindings(undefined, confidenceParams(request.query)), request.query));
  app.get("/api/frameworks/tauri", (request, response) => sendQuery(response, query.frameworkBindings("tauri", confidenceParams(request.query)), request.query));
  app.get("/api/diagnostics", (_request, response) => response.json(query.diagnostics()));
  app.get("/api/context", (request, response) => sendQuery(response, query.context(String(request.query.task ?? ""), {
    ...confidenceParams(request.query),
    maxFiles: numberParam(request.query.maxFiles, 20),
    maxSymbols: numberParam(request.query.maxSymbols, 50),
  }), request.query));
  app.get("/api/affected", (request, response) => {
    try {
      sendQuery(response, query.affected(String(request.query.input ?? ""), {
        ...confidenceParams(request.query),
        depth: numberParam(request.query.depth, 3),
        maxNodes: numberParam(request.query.maxNodes, 100),
        includeTests: request.query.includeTests === "true",
      }), request.query);
    } catch (error) {
      response.status(404).json({ error: String(error) });
    }
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
  server.on("close", () => query.close());
  return { server, url: `http://${host}:${port}` };
}
