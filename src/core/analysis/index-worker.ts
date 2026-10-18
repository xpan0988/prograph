/** Fixed indexing RPC. Public transports receive summaries, never GraphData. */
import { analyzeRepository } from "./analyze.js";
import { syncRepository } from "./sync.js";
import { repositoryStatus } from "./state.js";
import { indexManagedProject } from "../semantic/managed-scip.js";
import { indexRust } from "../semantic/rust.js";
import { indexClang } from "../semantic/clang.js";
import { importScip, type ScipManifest } from "../semantic/scip-import.js";
import path from "node:path";
import { exportCompatibilitySnapshot } from "../semantic/compatibility-export.js";
import { prepareQueryIndex } from "./prepare-queries.js";
import { boundedInput } from "../semantic/inputs.js";
import type { IndexRequest } from "./index-execution.js";

try {
  const payload = process.argv[2] ?? "";
  if (Buffer.byteLength(payload) > 32768) throw Error("Index control request exceeds 32 KiB");
  const request = JSON.parse(payload) as IndexRequest;
  if (!request || !["analyze", "sync", "status", "managed", "rust", "clang", "scip", "export-compat", "prepare-queries"].includes(request.operation) || typeof request.repository !== "string" || request.repository.length > 4096 || Object.keys(request).some(key => !["operation", "repository", "index", "input", "manifestFile", "providerOptions", "snapshot"].includes(key)) || [request.index, request.input, request.manifestFile].some(value => value !== undefined && (typeof value !== "string" || value.length > 4096))) throw Error("Invalid index request");
  if (request.snapshot !== undefined && (!Number.isSafeInteger(request.snapshot) || request.snapshot < 1 || request.operation !== "export-compat")) throw Error("Invalid export snapshot");
  const options = request.providerOptions;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["analyzer", "analyzerSha256", "toolchain", "target", "features", "noDefaultFeatures", "timeoutMs"].includes(key))
    || [options.analyzer, options.analyzerSha256, options.toolchain, options.target].some(value => value !== undefined && (typeof value !== "string" || value.length > 4096))
    || options.features !== undefined && (!Array.isArray(options.features) || options.features.length > 256 || options.features.some(value => typeof value !== "string" || value.length > 1024))
    || options.noDefaultFeatures !== undefined && typeof options.noDefaultFeatures !== "boolean"
    || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3600000))) throw Error("Invalid provider request options");
  let value: unknown;
  if (request.operation === "analyze") {
    const result = await analyzeRepository(request.repository, request.index ? { output: request.index } : {});
    value = { manifest: result.manifest, adapterRuns: result.adapterRuns, outputDirectory: result.outputDirectory };
  } else if (request.operation === "sync") value = await syncRepository(request.repository, request.index);
  else if (request.operation === "status") value = await repositoryStatus(request.repository, request.index);
  else if(request.operation==="prepare-queries"){const selected=path.resolve(request.index??path.join(request.repository,".prograph"));value=prepareQueryIndex(selected);}
  else {
    if (!request.input) throw Error("Provider input required");
    if (request.operation === "export-compat") {
      const selected = path.resolve(request.index ?? path.join(request.repository, ".prograph"));
      value = await exportCompatibilitySnapshot(selected, request.input, request.snapshot);
    } else if (request.operation === "managed") value = await indexManagedProject(request.repository, request.input, request.index, options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
    else if (request.operation === "clang") value = await indexClang(request.repository, request.input, request.index);
    else if (request.operation === "rust") {
      if (!options?.analyzer || !options.analyzerSha256 || !options.toolchain) throw Error("Explicit Rust tool receipts required");
      value = await indexRust(request.repository, request.input, options as Parameters<typeof indexRust>[2], request.index);
    } else {
      if (!request.manifestFile) throw Error("SCIP sidecar file required");
      const manifest = JSON.parse((await boundedInput(request.manifestFile, 16 * 1024 ** 2)).toString("utf8")) as ScipManifest;
      value = await importScip(request.repository, request.input, manifest, request.index);
    }
  }
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error).slice(0, 2048), code: "INDEX_FAILED" }));
}
