import { QueryService } from "./query-service.js";
import { SemanticQuery } from "../semantic/query.js";
import { LEGACY_READ_OPERATIONS } from "./isolation.js";

// Fixed read-only RPC surface. Never dispatch arbitrary methods, SQL or code.
const request = JSON.parse(process.argv[2] ?? "null") as { domain: string; filename: string; manifest?: string; operation: string; args: unknown[] };
try {
  if (!request || !Array.isArray(request.args) || request.args.length > 4 || typeof request.filename !== "string") throw Error("Invalid read request");
  const query = request.domain === "semantic" ? new SemanticQuery(request.filename, request.manifest) : request.domain === "legacy" ? new QueryService(request.filename) : undefined;
  if (!query) throw Error("Invalid read domain");
  try {
    const db = query instanceof SemanticQuery ? query.db : query.database;
    db.pragma("cache_size = -8192"); db.pragma("mmap_size = 0"); db.pragma("busy_timeout = 500");
    let value: unknown;
    if (query instanceof SemanticQuery) {
      value = query.execute(request.operation as Parameters<SemanticQuery["execute"]>[0], request.args[0] as string, request.args[1] as Parameters<SemanticQuery["execute"]>[2]);
    } else {
      if (!(LEGACY_READ_OPERATIONS as readonly string[]).includes(request.operation)) throw Error("Invalid legacy read operation");
      const method = query[request.operation as typeof LEGACY_READ_OPERATIONS[number]] as (...args: unknown[]) => unknown;
      value = db.transaction(() => method.apply(query, request.args)).deferred();
    }
    process.stdout.write(JSON.stringify({ value }));
  } finally { query.close(); }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ error: detail.slice(0, 2048), code: (error as { code?: string }).code ?? "QUERY_FAILED" }));
}
