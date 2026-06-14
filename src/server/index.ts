import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { queryServiceForRepository } from "../core/query/query-service.js";

export interface ServerOptions {
  host?: string;
  port?: number;
}

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listParam(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export async function startServer(repository = ".", options: ServerOptions = {}): Promise<{ server: Server; url: string }> {
  const query = await queryServiceForRepository(repository);
  const app = express();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43117;
  const staticDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
  app.get("/api/overview", (_request, response) => response.json(query.overview()));
  app.get("/api/architecture", (request, response) => response.json(query.architecture(numberParam(request.query.maxNodes, 100))));
  app.get("/api/files", (_request, response) => response.json(query.files()));
  app.get("/api/files/{*path}", (request, response) => response.json(query.fileDetails((request.params.path as unknown as string[]).join("/"))));
  app.get("/api/symbols/search", (request, response) => response.json(query.searchSymbols(String(request.query.q ?? ""), numberParam(request.query.maxNodes, 50))));
  app.get("/api/symbols/:id", (request, response) => {
    const symbol = query.symbol(request.params.id);
    if (!symbol) return response.status(404).json({ error: "Symbol not found" });
    return response.json(symbol);
  });
  app.get("/api/symbols/:id/callers", (request, response) => response.json(query.callers(request.params.id, numberParam(request.query.maxNodes, 50))));
  app.get("/api/symbols/:id/callees", (request, response) => response.json(query.callees(request.params.id, numberParam(request.query.maxNodes, 50))));
  app.get("/api/symbols/:id/neighborhood", (request, response) => {
    try {
      const edgeKinds = listParam(request.query.edgeKind) as import("../core/graph/schema.js").EdgeKind[] | undefined;
      const nodeKinds = listParam(request.query.nodeKind) as import("../core/graph/schema.js").NodeKind[] | undefined;
      response.json(query.neighborhood(request.params.id, {
        depth: numberParam(request.query.depth, 2),
        maxNodes: numberParam(request.query.maxNodes, 50),
        ...(edgeKinds ? { edgeKinds } : {}),
        ...(nodeKinds ? { nodeKinds } : {}),
      }));
    } catch (error) {
      response.status(404).json({ error: String(error) });
    }
  });
  app.get("/api/cycles", (_request, response) => response.json(query.cycles()));
  app.get("/api/frameworks", (_request, response) => response.json(query.frameworkBindings()));
  app.get("/api/frameworks/tauri", (_request, response) => response.json(query.frameworkBindings("tauri")));
  app.get("/api/diagnostics", (_request, response) => response.json(query.diagnostics()));
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
