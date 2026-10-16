#!/usr/bin/env node
import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import open from "open";
import { analyzeRepository } from "../core/analysis/analyze.js";
import { prepareQueryIndex } from "../core/analysis/prepare-queries.js";
import { repositoryStatus } from "../core/analysis/state.js";
import { syncRepository } from "../core/analysis/sync.js";
import { watchRepository } from "../core/analysis/watch.js";
import { type BoundedQuery, type ConfidenceQuery } from "../core/query/query-service.js";
import { isolatedQueryForRepository, isolatedSemanticRead, type AsyncQueryClient } from "../core/query/isolation.js";
import { indexManagedProject, toolReceipt } from "../core/semantic/managed-scip.js";
import { formatQueryOutput, type OutputMode } from "../core/query/output-mode.js";
import type { EdgeKind, GraphScope, NodeKind } from "../core/graph/schema.js";
import { resolveRepositoryRoot } from "../core/repository/repository.js";
import { startServer } from "../server/index.js";
import { startMcpServer } from "../mcp/index.js";
import { writeResult, type OutputFormat } from "./output.js";
import packageJson from "../../package.json" with { type: "json" };
import { SEMANTIC_OPERATIONS, type SemanticOperation } from "../core/semantic/query.js";
import { importScip, type ScipManifest } from "../core/semantic/scip-import.js";
import { indexClang } from "../core/semantic/clang.js";
import { SemanticStore } from "../core/semantic/store.js";
import { collectIndexGarbage } from "../core/semantic/provider-artifacts.js";
import { indexRust, type RustOptions } from "../core/semantic/rust.js";
import { readFile, stat } from "node:fs/promises";

interface FormatOptions {
  format: OutputFormat;
}

interface QueryOptions extends FormatOptions {
  repo?: string;
  index?: string;
  depth?: number;
  maxNodes?: number;
  edgeKind?: string[];
  nodeKind?: string[];
  includeProbable?: boolean;
  includeUnresolved?: boolean;
  mode?: OutputMode;
  maxEvidence?: number;
  maxFiles?: number;
  maxSymbols?: number;
  includeTests?: boolean;
  scope?: GraphScope;
}

function addFormat(command: Command): Command {
  return command.addOption(new Option("--format <format>", "output format").choices(["text", "json"]).default("text"));
}

function addQueryOptions(command: Command, includeRepo = false): Command {
  addFormat(command)
    .option("--index <path>", "custom ProGraph index directory or graph.sqlite path")
    .option("--include-probable", "include probable relationships")
    .option("--include-unresolved", "include probable and unresolved relationships")
    .option("--depth <number>", "bounded traversal depth", Number)
    .option("--max-nodes <number>", "maximum returned nodes", Number, 50)
    .option("--edge-kind <kind...>", "include only these edge kinds")
    .option("--node-kind <kind...>", "include only these node kinds")
    .addOption(new Option("--scope <scope>", "graph scope").choices(["code", "code+docs", "code+config", "code+tests", "full"]).default("code"));
  command
    .addOption(new Option("--mode <mode>", "agent output detail").choices(["compact", "standard", "full"]))
    .option("--max-evidence <number>", "maximum evidence pointers per relationship", Number);
  if (includeRepo) command.option("--repo <path>", "repository path", ".");
  return command;
}

function addIndex(command: Command): Command {
  return command.option("--index <path>", "custom ProGraph index directory or graph.sqlite path");
}

function addConfidence(command: Command): Command {
  return command
    .option("--include-probable", "include probable relationships")
    .option("--include-unresolved", "include probable and unresolved relationships")
    .addOption(new Option("--scope <scope>", "graph scope").choices(["code", "code+docs", "code+config", "code+tests", "full"]).default("code"));
}

async function withCancellation<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    return await execute(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
async function withQuery<T>(repo: string, index: string | undefined, callback: (query: AsyncQueryClient) => T | Promise<T>): Promise<T> {
  return withCancellation(async signal => callback(await isolatedQueryForRepository(repo, index, { signal })));
}

function confidence(options: QueryOptions): ConfidenceQuery {
  return {
    ...(options.includeProbable ? { includeProbable: true } : {}),
    ...(options.includeUnresolved ? { includeUnresolved: true } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };
}

function bounded(options: QueryOptions): BoundedQuery {
  return {
    ...confidence(options),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.edgeKind ? { edgeKinds: options.edgeKind as EdgeKind[] } : {}),
    ...(options.nodeKind ? { nodeKinds: options.nodeKind as NodeKind[] } : {}),
  };
}

function queryOutput(value: unknown, options: QueryOptions): unknown {
  return formatQueryOutput(value, {
    mode: options.mode ?? (options.format === "json" ? "compact" : "standard"),
    ...(options.maxEvidence !== undefined ? { maxEvidence: options.maxEvidence } : {}),
  });
}

const program = new Command();
program.name("prograph").description("Local-first repository dependency graph and code intelligence").version(packageJson.version);

addFormat(program.command("init [path]", { isDefault: false }).description("create an optional prograph.config.json").action(async (input = ".", options: FormatOptions) => {
  const root = await resolveRepositoryRoot(input);
  const configPath = path.join(root, "prograph.config.json");
  try {
    await access(configPath);
    throw new Error(`Configuration already exists: ${configPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = {
    include: ["src/**/*.ts", "src/**/*.tsx", "src-tauri/src/**/*.rs"],
    exclude: ["node_modules/**", "dist/**", "build/**", "target/**", ".git/**"],
    adapters: {
      typescript: true,
      rust: true,
      react: true,
      tauri: true,
      markdown: true,
      packageJson: true,
      cargoToml: true,
      tauriConfig: true,
      tauriCapability: true,
      tests: true,
      semanticLinker: true,
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeResult({ configPath }, options.format);
}));

addFormat(program.command("analyze [path]").description("analyze a repository and write its ProGraph index").option("--output <path>", "alternative output directory").action(async (input = ".", options: FormatOptions & { output?: string }) => {
  const result = await analyzeRepository(input, { ...(options.output ? { output: options.output } : {}) });
  writeResult({ outputDirectory: result.outputDirectory, ...result.manifest, adapters: result.adapterRuns }, options.format);
}));

addFormat(addIndex(program.command("status [path]").description("show index freshness and repository changes"))).action(async (input = ".", options: FormatOptions & { index?: string }) => {
  writeResult(await repositoryStatus(input, options.index), options.format);
});

addFormat(addIndex(program.command("sync [path]").description("synchronize a repository index conservatively"))).action(async (input = ".", options: FormatOptions & { index?: string }) => {
  writeResult(await syncRepository(input, options.index), options.format);
});

addIndex(program.command("watch [path]").description("watch a repository and synchronize on changes")).action(async (input = ".", options: { index?: string }) => {
  const stop = await watchRepository(input, options.index, (result) => {
    process.stdout.write(`ProGraph sync: ${result.statusAfter.state}; ${result.filesAdded} added, ${result.filesModified} modified, ${result.filesDeleted} deleted${result.fallbackReason ? `; ${result.fallbackReason}` : ""}\n`);
  });
  process.stdout.write("ProGraph watch started. Press Ctrl+C to stop.\n");
  const shutdown = (): void => {
    stop();
    process.stdout.write("ProGraph watch stopped.\n");
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

addIndex(program.command("mcp [path]").description("serve bounded ProGraph tools over MCP stdio")).action(async (input = ".", options: { index?: string }) => {
  await startMcpServer(input, options.index);
});

addIndex(program.command("serve [path]").description("serve the local visualization and query API").option("--port <number>", "localhost port", Number, 43117)).action(async (input = ".", options: { port: number; index?: string }) => {
  const { url } = await startServer(input, { port: options.port, ...(options.index ? { index: options.index } : {}) });
  process.stdout.write(`ProGraph serving ${url}\n`);
});

addIndex(program.command("open [path]").description("serve and open the local visualization").option("--port <number>", "localhost port", Number, 43117)).action(async (input = ".", options: { port: number; index?: string }) => {
  const { url } = await startServer(input, { port: options.port, ...(options.index ? { index: options.index } : {}) });
  await open(url);
  process.stdout.write(`ProGraph opened ${url}\n`);
});

const simpleQueries: Array<[string, string, (query: AsyncQueryClient, options: QueryOptions) => unknown]> = [
  ["overview [path]", "show repository overview", (query, options) => query.overview({ ...(options.scope ? { scope: options.scope } : {}) })],
  ["files [path]", "list indexed files", (query, options) => query.files({ ...(options.scope ? { scope: options.scope } : {}) })],
  ["diagnostics [path]", "show diagnostics", (query) => query.diagnostics()],
  ["adapters [path]", "show adapter runs", (query) => query.adapters()],
];
for (const [signature, description, callback] of simpleQueries) {
  addFormat(addConfidence(addIndex(program.command(signature).description(description)))).action(async (input = ".", options: QueryOptions & { index?: string }) => {
    writeResult(await withQuery(input, options.index, (query) => callback(query, options)), options.format);
  });
}

addFormat(addConfidence(addIndex(program.command("file <file>").description("show file nodes and dependencies").option("--repo <path>", "repository path", ".")))).action(async (file: string, options: QueryOptions & { repo: string }) => {
  writeResult(queryOutput(await withQuery(options.repo, options.index, (query) => query.fileDetails(file, confidence(options))), options), options.format);
});

addQueryOptions(program.command("symbol <query>").description("search symbols"), true).action(async (search: string, options: QueryOptions) => {
  writeResult(queryOutput(await withQuery(options.repo ?? ".", options.index, (query) => query.searchSymbols(search, options.maxNodes, {
    ...(options.includeUnresolved ? { includeUnresolved: true } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  })), options), options.format);
});

addQueryOptions(program.command("callers <symbol-id>").description("show direct callers"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(queryOutput(await withQuery(options.repo ?? ".", options.index, (query) => query.callers(id, options.maxNodes, confidence(options))), options), options.format);
});

addQueryOptions(program.command("callees <symbol-id>").description("show direct callees"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(queryOutput(await withQuery(options.repo ?? ".", options.index, (query) => query.callees(id, options.maxNodes, confidence(options))), options), options.format);
});

addQueryOptions(program.command("neighborhood <symbol-id>").description("show a bounded symbol neighborhood"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(queryOutput(await withQuery(options.repo ?? ".", options.index, (query) => query.neighborhood(id, bounded(options))), options), options.format);
});

addQueryOptions(program.command("context <task>").description("build deterministic task context"), true)
  .option("--max-files <number>", "maximum ranked files", Number, 20)
  .option("--max-symbols <number>", "maximum ranked symbols", Number, 50)
  .action(async (task: string, options: QueryOptions) => {
    const result = await withQuery(options.repo ?? ".", options.index, (query) => query.context(task, {
      ...confidence(options),
      ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
      ...(options.maxSymbols !== undefined ? { maxSymbols: options.maxSymbols } : {}),
    }));
    writeResult(queryOutput(result, options), options.format);
  });

addQueryOptions(program.command("affected <file-or-symbol>").description("show bounded reverse change impact"), true)
  .option("--include-tests", "include related candidate tests")
  .action(async (input: string, options: QueryOptions) => {
    const result = await withQuery(options.repo ?? ".", options.index, (query) => query.affected(input, {
      ...confidence(options),
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
      ...(options.includeTests ? { includeTests: true } : {}),
    }));
    writeResult(queryOutput(result, options), options.format);
  });

addFormat(addConfidence(addIndex(program.command("cycles [path]").description("find import and call cycles")))).action(async (input = ".", options: QueryOptions) => {
  writeResult(await withQuery(input, options.index, (query) => query.cycles(confidence(options))), options.format);
});

addFormat(addConfidence(addIndex(program.command("boundaries [path]").description("show bounded cross-language boundary evidence")))).action(async (input = ".", options: QueryOptions) => {
  writeResult(await withQuery(input, options.index, (query) => query.frameworkBindings(undefined, confidence(options))), options.format);
});

const semanticCommand = program.command("semantic").description("Semantic Core snapshot navigation and verified interchange");
for (const operation of ["gc", "pin", "unpin"] as const) addFormat(addIndex(semanticCommand.command(`${operation} [path]`).description(operation === "gc" ? "Collect unreachable Semantic Core history, preserving active and pinned snapshots" : `${operation} a retained Semantic Core snapshot`)))
  .option("--keep <number>", "latest snapshots retained by garbage collection", Number, 3)
  .option("--snapshot <number>", "snapshot to pin or unpin", Number)
  .option("--label <text>", "pin owner label", "user")
  .action(async (input = ".", options: FormatOptions & { index?: string; keep: number; snapshot?: number; label: string }) => {
    const root = await resolveRepositoryRoot(input); const selected = path.resolve(options.index ?? path.join(root, ".prograph"));
    const filename = path.join(selected.endsWith(".sqlite") ? path.dirname(selected) : selected, "semantic.sqlite");
    await access(filename); // Maintenance cannot silently create an empty replacement index.
    if (operation === "gc") { writeResult(await collectIndexGarbage(filename, { keep: options.keep }), options.format); return; }
    const store = new SemanticStore(filename);
    try {
      if (!Number.isSafeInteger(options.snapshot)) throw Error("--snapshot is required"); store[operation === "pin" ? "pinSnapshot" : "unpinSnapshot"](options.snapshot!, options.label); writeResult({ operation, snapshot: options.snapshot, label: options.label }, options.format);
    } finally { store.close(); }
  });

addFormat(semanticCommand.command("tool-receipt <path>").description("Hash an explicit immutable semantic tool or SDK directory"))
  .action(async (file: string, options: FormatOptions) => { const receipt = await toolReceipt(path.resolve(file)); writeResult({ path: path.resolve(file), sha256: receipt.sha256, files: receipt.files, bytes: receipt.bytes }, options.format); });
addFormat(addIndex(semanticCommand.command("index-project <configuration>").description("Explicit pinned Python/Go/Java/C# SCIP production from a declared compiler context")))
  .option("--repo <path>", "repository path", ".")
  .option("--timeout-ms <number>", "total provider deadline before publication", Number, 300000)
  .action(async (configuration: string, options: FormatOptions & { repo: string; index?: string; timeoutMs: number }) => {
    writeResult(await withCancellation(signal => indexManagedProject(options.repo, configuration, options.index, { timeoutMs: options.timeoutMs, signal })), options.format);
  });
addFormat(addIndex(semanticCommand.command("index-rust <manifest>").description("Explicit pinned offline Rust workspace navigation in an isolated source copy")))
  .option("--repo <path>", "repository path", ".")
  .requiredOption("--analyzer <path>", "absolute rust-analyzer executable")
  .requiredOption("--analyzer-sha256 <digest>", "pinned analyzer binary SHA-256")
  .requiredOption("--toolchain <path>", "absolute directory containing cargo and rustc")
  .option("--features <feature...>", "explicit Cargo feature selection")
  .option("--no-default-features", "disable default Cargo features")
  .option("--target <triple>", "explicit Rust target triple")
  .option("--timeout-ms <number>", "total provider deadline before publication", Number, 120000)
  .action(async (manifest: string, options: FormatOptions & RustOptions & { repo: string; index?: string; defaultFeatures?: boolean }) => {
    writeResult(await withCancellation(signal => indexRust(options.repo, manifest, { ...options, noDefaultFeatures: options.defaultFeatures === false, signal }, options.index)), options.format);
  });
addFormat(addIndex(semanticCommand.command("index-clang <unit>").description("Explicit syntax-only Clang extraction for an arguments-array compilation unit")))
  .option("--repo <path>", "repository path", ".")
  .action(async (unit: string, options: FormatOptions & { repo: string; index?: string }) => writeResult(await indexClang(options.repo, unit, options.index), options.format));
addFormat(addIndex(semanticCommand.command("import-scip <artifact>").description("Import a source-verified SCIP artifact without running its indexer")))
  .requiredOption("--manifest <path>", "source digest and producer sidecar")
  .option("--repo <path>", "repository path", ".")
  .action(async (artifact: string, options: FormatOptions & { manifest: string; repo: string; index?: string }) => {
    if ((await stat(options.manifest)).size > 16777216) throw Error("SCIP sidecar exceeds 16 MiB");
    const manifest = JSON.parse(await readFile(options.manifest, "utf8")) as ScipManifest;
    writeResult(await importScip(options.repo, artifact, manifest, options.index), options.format);
  });
for (const operation of SEMANTIC_OPERATIONS) {
  addFormat(addIndex(semanticCommand.command(`${operation} [input]`).description(`Semantic ${operation}`)))
    .option("--repo <path>", "repository path", ".")
    .option("--limit <number>", "bounded result page", Number, 50)
    .option("--cursor <cursor>", "snapshot-bound continuation")
    .option("--snapshot <number>", "retained snapshot", Number)
    .option("--max-bytes <number>", "bounded JSON response budget", Number, 32768)
    .action(async (input = "", options: FormatOptions & { repo: string; index?: string; limit: number; cursor?: string; snapshot?: number; maxBytes: number }) => {
      const result = await withCancellation(signal => isolatedSemanticRead(options.repo, options.index, operation as SemanticOperation, input, { limit: options.limit, maxBytes: options.maxBytes, ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}) }, { signal }));
      // Keep the semantic JSON transport within the query's byte budget; indentation adds unbounded overhead.
      if (options.format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
      else writeResult(result, options.format);
    });
}

addFormat(addIndex(program.command("prepare-queries [path]").description("Offline preparation of bounded global query projections for an existing graph")))
  .action(async (input = ".", options: FormatOptions & { index?: string }) => {
    const root = await resolveRepositoryRoot(input); const selected = path.resolve(options.index ?? path.join(root, ".prograph"));
    writeResult(prepareQueryIndex(selected.endsWith(".sqlite") ? selected : path.join(selected, "graph.sqlite")), options.format);
  });
addFormat(addIndex(program.command("files-page [path]").description("Read a bounded keyset page of indexed files")))
  .addOption(new Option("--scope <scope>", "graph scope").choices(["code", "code+docs", "code+config", "code+tests", "full"]).default("code"))
  .option("--limit <number>", "maximum file summaries", Number, 200).option("--cursor <cursor>", "index-generation-bound cursor")
  .action(async (input = ".", options: QueryOptions & { limit: number; cursor?: string }) => writeResult(await withQuery(input, options.index, query => query.filePage({ ...(options.scope ? { scope: options.scope } : {}), limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) })), options.format));

const framework = program.command("framework").description("framework-specific queries");
addFormat(addIndex(program.command("diagnostics-page [path]").description("Read a bounded keyset page of diagnostics")))
  .option("--limit <number>", "maximum diagnostics", Number, 200).option("--cursor <cursor>", "index-generation-bound cursor")
  .action(async (input = ".", options: QueryOptions & { limit: number; cursor?: string }) => writeResult(await withQuery(input, options.index, query => query.diagnosticPage({ limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) })), options.format));
addFormat(addConfidence(addIndex(framework.command("tauri [path]").description("show Tauri commands and events")))).action(async (input = ".", options: QueryOptions) => {
  writeResult(await withQuery(input, options.index, (query) => query.frameworkBindings("tauri", confidence(options))), options.format);
});

program.showHelpAfterError();
program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`prograph: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
