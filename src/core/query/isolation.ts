import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import type { QueryService } from "./query-service.js";
import type { SemanticOperation, SemanticQueryOptions } from "../semantic/query.js";
import { resolveRepositoryRoot } from "../repository/repository.js";
import { runProviderProcess, ProviderProcessError } from "../semantic/process.js";

export const LEGACY_READ_OPERATIONS = ["overview", "adapters", "architecture", "files", "filePage", "fileDetails", "searchSymbols", "symbol", "callers", "callees", "neighborhood", "cycles", "frameworkBindings", "context", "affected", "diagnostics", "diagnosticPage"] as const;
const operations = LEGACY_READ_OPERATIONS;
type Operation = typeof operations[number];
export type AsyncQueryClient = { [K in Operation]: (...args: Parameters<QueryService[K]>) => Promise<ReturnType<QueryService[K]>> };
export interface ReadExecutionOptions { timeoutMs?: number; signal?: AbortSignal }
export class QueryExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
let active = 0;
const waiting: Array<() => void> = [];
/** Two active children and sixteen waiting requests per host process. Queue time counts. */
async function acquire(deadline: number, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new QueryExecutionError("QUERY_CANCELLED", "Query cancelled before admission");
  if (active >= 2) {
    if (waiting.length >= 16) throw new QueryExecutionError("QUERY_BUSY", "Query queue is full");
    await new Promise<void>((resolve, reject) => {
      const remove = () => { const at = waiting.indexOf(ready); if (at >= 0) waiting.splice(at, 1); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { remove(); reject(new QueryExecutionError("QUERY_CANCELLED", "Query cancelled while queued")); };
      const ready = () => { remove(); resolve(); };
      const timer = setTimeout(() => { remove(); reject(new QueryExecutionError("QUERY_DEADLINE", "Query deadline exceeded while queued")); }, Math.max(1, deadline - performance.now()));
      waiting.push(ready); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } else active++;
  // A release hands its existing slot directly to the next waiter.
  return () => { const next = waiting.shift(); if (next) next(); else active--; };
}
export async function executeRead(filename: string, domain: "legacy" | "semantic", operation: string, args: unknown[], manifest?: string, options: ReadExecutionOptions = {}): Promise<unknown> {
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10000) throw Error("Invalid read deadline");
  if (domain === "legacy" && !(operations as readonly string[]).includes(operation)) throw Error("Invalid read operation");
  const payload = JSON.stringify({ domain, filename, manifest, operation, args });
  if (Buffer.byteLength(payload) > 32768) throw new QueryExecutionError("QUERY_INPUT_LIMIT", "Read request exceeds 32 KiB");
  const deadline = performance.now() + timeout;
  const release = await acquire(deadline, options.signal);
  try {
    if (options.signal?.aborted) throw new QueryExecutionError("QUERY_CANCELLED", "Query cancelled before execution");
    const worker = new URL("./query-worker.js", import.meta.url);
    // npm test builds Node artifacts before source-mode integration tests.
    const executable = fileURLToPath(import.meta.url).endsWith(".ts") ? fileURLToPath(new URL("../../../dist/core/query/query-worker.js", import.meta.url)) : fileURLToPath(worker);
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new QueryExecutionError("QUERY_DEADLINE", "Query deadline exceeded");
    const result = await runProviderProcess(process.execPath, ["--max-old-space-size=192", executable, payload], path.dirname(filename), process.env,
      { timeoutMs: remaining, maxOutputBytes: domain === "semantic" ? 262144 : 4 * 1024 ** 2, ...(options.signal ? { signal: options.signal } : {}) });
    const decoded = JSON.parse(result.stdout) as { value?: unknown; error?: string; code?: string };
    if (decoded.error) throw new QueryExecutionError(decoded.code ?? "QUERY_FAILED", decoded.error);
    return decoded.value;
  } catch (error) {
    if (error instanceof ProviderProcessError) throw new QueryExecutionError(`QUERY_${error.reason.toUpperCase()}`, error.message.replace(/^Provider /, "Query worker "));
    if (options.signal?.aborted) throw new QueryExecutionError("QUERY_CANCELLED", "Query cancelled");
    throw error;
  } finally { release(); }
}
export async function isolatedQueryForRepository(input = ".", index?: string, options: ReadExecutionOptions = {}): Promise<AsyncQueryClient> {
  const root = await resolveRepositoryRoot(input); const selected = index ? path.resolve(index) : path.join(root, ".prograph");
  const filename = selected.endsWith(".sqlite") ? selected : path.join(selected, "graph.sqlite");
  try { await access(filename); } catch { throw Error(`No ProGraph index found at ${filename}. Run "prograph analyze ${input}" first.`); }
  return Object.fromEntries(operations.map(operation => [operation, (...args: unknown[]) => executeRead(filename, "legacy", operation, args, undefined, options)])) as AsyncQueryClient;
}
export async function isolatedSemanticRead(input: string, index: string | undefined, operation: SemanticOperation, value = "", queryOptions: SemanticQueryOptions = {}, options: ReadExecutionOptions = {}): Promise<Record<string, unknown>> {
  const root = await resolveRepositoryRoot(input); const selected = index ? path.resolve(index) : path.join(root, ".prograph");
  const directory = selected.endsWith(".sqlite") ? path.dirname(selected) : selected;
  return await executeRead(path.join(directory, "semantic.sqlite"), "semantic", operation, [value, queryOptions], path.join(directory, "manifest.json"), options) as Record<string, unknown>;
}
