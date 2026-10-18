import { fileURLToPath } from "node:url";
import type { AnalysisResult } from "./analyze.js";
import type { SyncResult } from "./sync.js";
import type { RepositoryStatus } from "./state.js";
import type { RustOptions } from "../semantic/rust.js";
import { runProviderProcess, ProviderProcessError } from "../semantic/process.js";

export type IndexOperation = "analyze" | "sync" | "status" | "managed" | "rust" | "clang" | "scip" | "export-compat" | "prepare-queries";
export interface IndexRequest { operation: IndexOperation; repository: string; index?: string; input?: string; snapshot?: number; manifestFile?: string; providerOptions?: Partial<Pick<RustOptions, "analyzer" | "analyzerSha256" | "toolchain" | "target" | "features" | "noDefaultFeatures" | "timeoutMs">> }
export interface IndexExecutionOptions { timeoutMs?: number; signal?: AbortSignal }
export type AnalysisSummary = Pick<AnalysisResult, "manifest" | "adapterRuns" | "outputDirectory">;
export class IndexExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const work = { active: false, waiting: [] as Array<() => void> };
const freshness = { active: false, waiting: [] as Array<() => void> };
/** One indexing child and one independent freshness child, four waiting requests
 * each per host process. Navigation admission remains independent. No persistent
 * worker or mutable compiler cache; a long compiler cannot occupy the status slot.
 */
async function acquire(slot: typeof work, deadline: number, signal?: AbortSignal): Promise<() => void> {
  const waiting = slot.waiting;
  if (signal?.aborted) throw new IndexExecutionError("INDEX_CANCELLED", "Index request cancelled before admission");
  if (slot.active) {
    if (waiting.length >= 4) throw new IndexExecutionError("INDEX_BUSY", "Index request queue is full");
    await new Promise<void>((resolve, reject) => {
      const remove = () => { const at = waiting.indexOf(ready); if (at >= 0) waiting.splice(at, 1); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const ready = () => { remove(); resolve(); };
      const abort = () => { remove(); reject(new IndexExecutionError("INDEX_CANCELLED", "Queued index request cancelled")); };
      const timer = setTimeout(() => { remove(); reject(new IndexExecutionError("INDEX_DEADLINE", "Index deadline exceeded in queue")); }, Math.max(1, deadline - performance.now()));
      waiting.push(ready); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
  } else slot.active = true;
  return () => { const next = waiting.shift(); if (next) next(); else slot.active = false; };
}

export function executeIndex(request: IndexRequest & { operation: "analyze" }, options?: IndexExecutionOptions): Promise<AnalysisSummary>;
export function executeIndex(request: IndexRequest & { operation: "sync" }, options?: IndexExecutionOptions): Promise<SyncResult>;
export function executeIndex(request: IndexRequest & { operation: "status" }, options?: IndexExecutionOptions): Promise<RepositoryStatus>;
export function executeIndex(request: IndexRequest & { operation: "managed" | "rust" | "clang" | "scip" | "export-compat" | "prepare-queries" }, options?: IndexExecutionOptions): Promise<Record<string, unknown>>;
export async function executeIndex(request: IndexRequest, options: IndexExecutionOptions = {}): Promise<unknown> {
  const timeout = options.timeoutMs ?? (request.operation === "status" ? 30000 : 1800000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000) throw Error("Invalid index request deadline");
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 32768) throw new IndexExecutionError("INDEX_INPUT_LIMIT", "Index control request exceeds 32 KiB");
  const deadline = performance.now() + timeout, release = await acquire(request.operation === "status" ? freshness : work, deadline, options.signal);
  try {
    if (options.signal?.aborted) throw new IndexExecutionError("INDEX_CANCELLED", "Index request cancelled before execution");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new IndexExecutionError("INDEX_DEADLINE", "Index deadline exceeded before execution");
    const worker = fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? "../../../dist/core/analysis/index-worker.js" : "./index-worker.js", import.meta.url));
    const result = await runProviderProcess(process.execPath, [request.operation === "status" ? "--max-old-space-size=512" : "--max-old-space-size=2048", worker, payload], process.cwd(), process.env,
      { timeoutMs: remaining, maxOutputBytes: 4 * 1024 ** 2, ...(options.signal ? { signal: options.signal } : {}) });
    const decoded = JSON.parse(result.stdout) as { value?: unknown; error?: string; code?: string };
    if (decoded.error) throw new IndexExecutionError(decoded.code ?? "INDEX_FAILED", decoded.error);
    return decoded.value;
  } catch (error) {
    if (error instanceof ProviderProcessError) throw new IndexExecutionError(`INDEX_${error.reason.toUpperCase()}`, `${error.message}. An index may already have committed; check status before retrying.`);
    throw error;
  } finally { release(); }
}
