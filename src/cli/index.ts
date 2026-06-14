#!/usr/bin/env node
import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import open from "open";
import { analyzeRepository } from "../core/analysis/analyze.js";
import { queryServiceForRepository, type BoundedQuery, type QueryService } from "../core/query/query-service.js";
import type { EdgeKind, NodeKind } from "../core/graph/schema.js";
import { resolveRepositoryRoot } from "../core/repository/repository.js";
import { startServer } from "../server/index.js";
import { writeResult, type OutputFormat } from "./output.js";
import packageJson from "../../package.json" with { type: "json" };

interface FormatOptions {
  format: OutputFormat;
}

interface QueryOptions extends FormatOptions {
  repo?: string;
  depth?: number;
  maxNodes?: number;
  edgeKind?: string[];
  nodeKind?: string[];
}

function addFormat(command: Command): Command {
  return command.addOption(new Option("--format <format>", "output format").choices(["text", "json"]).default("text"));
}

function addQueryOptions(command: Command, includeRepo = false): Command {
  addFormat(command)
    .option("--depth <number>", "bounded traversal depth", Number)
    .option("--max-nodes <number>", "maximum returned nodes", Number, 50)
    .option("--edge-kind <kind...>", "include only these edge kinds")
    .option("--node-kind <kind...>", "include only these node kinds");
  if (includeRepo) command.option("--repo <path>", "repository path", ".");
  return command;
}

async function withQuery<T>(repo: string, callback: (query: QueryService) => T | Promise<T>): Promise<T> {
  const query = await queryServiceForRepository(repo);
  try {
    return await callback(query);
  } finally {
    query.close();
  }
}

function bounded(options: QueryOptions): BoundedQuery {
  return {
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.edgeKind ? { edgeKinds: options.edgeKind as EdgeKind[] } : {}),
    ...(options.nodeKind ? { nodeKinds: options.nodeKind as NodeKind[] } : {}),
  };
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

program.command("serve [path]").description("serve the local visualization and query API").option("--port <number>", "localhost port", Number, 43117).action(async (input = ".", options: { port: number }) => {
  const { url } = await startServer(input, { port: options.port });
  process.stdout.write(`ProGraph serving ${url}\n`);
});

program.command("open [path]").description("serve and open the local visualization").option("--port <number>", "localhost port", Number, 43117).action(async (input = ".", options: { port: number }) => {
  const { url } = await startServer(input, { port: options.port });
  await open(url);
  process.stdout.write(`ProGraph opened ${url}\n`);
});

const simpleQueries: Array<[string, string, (query: QueryService) => unknown]> = [
  ["overview [path]", "show repository overview", (query) => query.overview()],
  ["files [path]", "list indexed files", (query) => query.files()],
  ["cycles [path]", "find import and call cycles", (query) => query.cycles()],
  ["diagnostics [path]", "show diagnostics", (query) => query.diagnostics()],
  ["adapters [path]", "show adapter runs", (query) => query.adapters()],
];
for (const [signature, description, callback] of simpleQueries) {
  addFormat(program.command(signature).description(description).action(async (input = ".", options: FormatOptions) => {
    writeResult(await withQuery(input, callback), options.format);
  }));
}

addFormat(program.command("file <file>").description("show file nodes and dependencies").option("--repo <path>", "repository path", ".").action(async (file: string, options: FormatOptions & { repo: string }) => {
  writeResult(await withQuery(options.repo, (query) => query.fileDetails(file)), options.format);
}));

addQueryOptions(program.command("symbol <query>").description("search symbols"), true).action(async (search: string, options: QueryOptions) => {
  writeResult(await withQuery(options.repo ?? ".", (query) => query.searchSymbols(search, options.maxNodes)), options.format);
});

addQueryOptions(program.command("callers <symbol-id>").description("show direct callers"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(await withQuery(options.repo ?? ".", (query) => query.callers(id, options.maxNodes)), options.format);
});

addQueryOptions(program.command("callees <symbol-id>").description("show direct callees"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(await withQuery(options.repo ?? ".", (query) => query.callees(id, options.maxNodes)), options.format);
});

addQueryOptions(program.command("neighborhood <symbol-id>").description("show a bounded symbol neighborhood"), true).action(async (id: string, options: QueryOptions) => {
  writeResult(await withQuery(options.repo ?? ".", (query) => query.neighborhood(id, bounded(options))), options.format);
});

const framework = program.command("framework").description("framework-specific queries");
addFormat(framework.command("tauri [path]").description("show Tauri commands and events").action(async (input = ".", options: FormatOptions) => {
  writeResult(await withQuery(input, (query) => query.frameworkBindings("tauri")), options.format);
}));

program.showHelpAfterError();
program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`prograph: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
