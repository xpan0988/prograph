#!/usr/bin/env node
import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import open from "open";
import { analyzeRepository } from "../core/analysis/analyze.js";
import { repositoryStatus } from "../core/analysis/state.js";
import { syncRepository } from "../core/analysis/sync.js";
import { watchRepository } from "../core/analysis/watch.js";
import { queryServiceForRepository, type BoundedQuery, type ConfidenceQuery, type QueryService } from "../core/query/query-service.js";
import { formatQueryOutput, type OutputMode } from "../core/query/output-mode.js";
import type { EdgeKind, NodeKind } from "../core/graph/schema.js";
import { resolveRepositoryRoot } from "../core/repository/repository.js";
import { startServer } from "../server/index.js";
import { startMcpServer } from "../mcp/index.js";
import { writeResult, type OutputFormat } from "./output.js";
import packageJson from "../../package.json" with { type: "json" };

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
    .option("--node-kind <kind...>", "include only these node kinds");
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
    .option("--include-unresolved", "include probable and unresolved relationships");
}

async function withQuery<T>(repo: string, index: string | undefined, callback: (query: QueryService) => T | Promise<T>): Promise<T> {
  const query = await queryServiceForRepository(repo, index);
  try {
    return await callback(query);
  } finally {
    query.close();
  }
}

function confidence(options: QueryOptions): ConfidenceQuery {
  return {
    ...(options.includeProbable ? { includeProbable: true } : {}),
    ...(options.includeUnresolved ? { includeUnresolved: true } : {}),
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
    adapters: { typescript: true, rust: true, react: true, tauri: true },
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

const simpleQueries: Array<[string, string, (query: QueryService) => unknown]> = [
  ["overview [path]", "show repository overview", (query) => query.overview()],
  ["files [path]", "list indexed files", (query) => query.files()],
  ["diagnostics [path]", "show diagnostics", (query) => query.diagnostics()],
  ["adapters [path]", "show adapter runs", (query) => query.adapters()],
];
for (const [signature, description, callback] of simpleQueries) {
  addFormat(addIndex(program.command(signature).description(description))).action(async (input = ".", options: FormatOptions & { index?: string }) => {
    writeResult(await withQuery(input, options.index, callback), options.format);
  });
}

addFormat(addConfidence(addIndex(program.command("file <file>").description("show file nodes and dependencies").option("--repo <path>", "repository path", ".")))).action(async (file: string, options: QueryOptions & { repo: string }) => {
  writeResult(queryOutput(await withQuery(options.repo, options.index, (query) => query.fileDetails(file, confidence(options))), options), options.format);
});

addQueryOptions(program.command("symbol <query>").description("search symbols"), true).action(async (search: string, options: QueryOptions) => {
  writeResult(queryOutput(await withQuery(options.repo ?? ".", options.index, (query) => query.searchSymbols(search, options.maxNodes, {
    ...(options.includeUnresolved ? { includeUnresolved: true } : {}),
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

const framework = program.command("framework").description("framework-specific queries");
addFormat(addConfidence(addIndex(framework.command("tauri [path]").description("show Tauri commands and events")))).action(async (input = ".", options: QueryOptions) => {
  writeResult(await withQuery(input, options.index, (query) => query.frameworkBindings("tauri", confidence(options))), options.format);
});

program.showHelpAfterError();
program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`prograph: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
