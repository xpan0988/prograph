import path from "node:path";
import { readFileSync } from "node:fs";
import { ts } from "ts-morph";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import { canonical, digest, semanticKey } from "./model.js";

export interface ProjectUnit {
  key: string;
  project: string;
  language: string;
  context: string;
  fingerprint: string;
  sources: string[];
  inputs: Record<string, string>;
  options: Record<string, unknown>;
  gaps: string[];
  compilerOptions?: ts.CompilerOptions;
}
export interface ProjectPlan { fingerprint: string; units: ProjectUnit[]; diagnostics: string[] }
const tsSource = (file: string) => /\.(?:[cm]?ts|tsx|jsx?|mts|cts)$/.test(file);
const normalize = (file: string) => file.split(path.sep).join("/");

/** Discovery is read-only. An observed build command is data, never a process invocation. */
export function discoverProjects(snapshot: RepositorySnapshot): ProjectPlan {
  const root = snapshot.repository.root;
  const units: ProjectUnit[] = []; const diagnostics: string[] = [];
  const allTs = snapshot.files.filter(tsSource).sort();
  const selectedTs = new Set(allTs);
  const tsConfigs = snapshot.files.filter(file => /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/.test(file)).sort();
  const manifests = snapshot.files.filter(file => /(?:^|\/)(?:package(?:-lock)?\.json|Cargo\.(?:toml|lock)|go\.(?:mod|work|sum)|pyproject\.toml|pyrightconfig\.json|pom\.xml|build\.gradle(?:\.kts)?|compile_commands\.json)$|\.(?:csproj|sln)$/.test(file));
  const manifestDigests = Object.fromEntries(manifests.map(file => [file, digest(snapshot.fileContents.get(file) ?? "")]));
  const add = (project: string, language: string, sources: string[], inputs: Record<string, string>, options: Record<string, unknown>, gaps: string[], compilerOptions?: ts.CompilerOptions) => {
    const key = language === "typescript" && project === "tsconfig.json" ? "typescript/root" : `${language}/project:${project}`;
    const fingerprint = digest(canonical([inputs, options, sources]));
    const context = semanticKey("context", [snapshot.repository.identity, key, inputs, options, language === "typescript" ? ts.version : null]);
    units.push({ key, project, language, context, fingerprint, sources, inputs, options, gaps, ...(compilerOptions ? { compilerOptions } : {}) });
  };
  for (const config of tsConfigs) {
    const inputs: Record<string, string> = {};
    // Capture extends/package-config reads made by the actual TypeScript config parser.
    const read = (absolute: string): string | undefined => {
      try { const text = readFileSync(absolute, "utf8"); inputs[normalize(path.resolve(absolute))] = digest(text); return text; } catch { return undefined; }
    };
    const absolute = path.join(root, config); const text = snapshot.fileContents.get(config) ?? read(absolute);
    if (text === undefined) { diagnostics.push(`Unreadable TypeScript project: ${config}`); continue; }
    inputs[normalize(absolute)] = digest(text);
    const parsed = ts.parseConfigFileTextToJson(absolute, text);
    if (parsed.error) { diagnostics.push(`Invalid TypeScript project: ${config}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`); continue; }
    const command = ts.parseJsonConfigFileContent(parsed.config, { ...ts.sys, readFile: read }, path.dirname(absolute), undefined, absolute);
    const compilerOptions = command.options;
    const { configFile: _configFile, ...plainOptions } = compilerOptions;
    const options = JSON.parse(JSON.stringify(plainOptions)) as Record<string, unknown>;
    const sources = command.fileNames.map(file => normalize(path.relative(root, file))).filter(file => selectedTs.has(file)).sort();
    // Package changes can alter module resolution even when source text is unchanged.
    for (const manifest of manifests.filter(file => /(?:package(?:-lock)?\.json)$/.test(file))) inputs[normalize(path.join(root, manifest))] = manifestDigests[manifest]!;
    const references = command.projectReferences?.map(ref => normalize(ref.path)).sort() ?? [];
    const gaps = command.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, " ")).slice(0, 8);
    if (references.length) gaps.push("Referenced projects are separate units; emitted declaration build outputs must already exist");
    add(config, "typescript", sources, inputs, { compilerOptions: options, references, mode: "compiler-config" }, gaps, compilerOptions);
  }
  const assigned = new Set(units.flatMap(unit => unit.sources));
  const orphan = allTs.filter(file => !assigned.has(file));
  if (orphan.length) add("<inferred>", "typescript", orphan, {}, { mode: "inferred", allowJs: true, jsx: 1, target: ts.ScriptTarget.ES2022 }, ["Sources outside compiler-config selection use an explicit inferred unit"], { allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 });
  for (const file of manifests) {
    if (/(?:package(?:-lock)?\.json|Cargo\.lock|go\.sum)$/.test(file)) continue;
    const text = snapshot.fileContents.get(file) ?? ""; const base = path.posix.dirname(file);
    const inputs = { [normalize(path.join(root, file))]: digest(text) };
    const within = (source: string) => base === "." || source.startsWith(`${base}/`);
    if (file.endsWith("compile_commands.json")) {
      try {
        const commands: unknown = JSON.parse(text);
        if (!Array.isArray(commands) || commands.length > 100000) throw Error("Invalid or oversized compilation database");
        for (const [ordinal, raw] of commands.entries()) {
          const command = raw as { directory?: string; file?: string; arguments?: string[]; command?: string; output?: string };
          if (typeof command.directory !== "string" || typeof command.file !== "string") { diagnostics.push(`Invalid compilation entry ${file}:${ordinal}`); continue; }
          const directory = path.resolve(root, command.directory);
          const source = normalize(path.relative(root, path.resolve(directory, command.file)));
          const args = command.arguments;
          if (args && (!Array.isArray(args) || !args.every(arg => typeof arg === "string"))) { diagnostics.push(`Invalid compiler arguments ${file}:${ordinal}`); continue; }
          let explicitLanguage: string | undefined;
          args?.forEach((arg, i) => { if (arg === "-x") explicitLanguage = args[i + 1]; else if (arg.startsWith("-x") && arg.length > 2) explicitLanguage = arg.slice(2); });
          if (explicitLanguage === "none") explicitLanguage = undefined;
          if (explicitLanguage && !["c", "c-header", "c++", "c++-header"].includes(explicitLanguage)) { diagnostics.push(`Unsupported compilation language ${file}:${ordinal}: ${explicitLanguage}`); continue; }
          const mode = explicitLanguage ? explicitLanguage.startsWith("c++") ? "cpp" : "c" : args?.[0]?.includes("++") || /\.(?:cpp|cc|cxx|hpp|hxx)$/.test(source) ? "cpp" : "c";
          const identity = digest(canonical([directory, source, args ?? command.command ?? null, command.output ?? null])).slice(0, 20);
          add(`${file}#${identity}`, mode, snapshot.fileContents.has(source) ? [source] : [], inputs,
            { directory, source, arguments: args ?? null, command: command.command ?? null, output: command.output ?? null, interpretation: mode },
            ["Build invocation recorded without execution; include dependency closure/toolchain still require a qualified provider", ...(args ? [] : ["Shell command retained verbatim; no whitespace tokenization"])]);
        }
      } catch (error) { diagnostics.push(`${file}: ${String(error)}`); }
    } else {
      const language = file.endsWith("Cargo.toml") ? "rust" : file.includes("go.") ? "go" : /(?:pyproject|pyrightconfig)/.test(file) ? "python" : /(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(file) ? "java" : "csharp";
      const extension = language === "rust" ? /\.rs$/ : language === "go" ? /\.go$/ : language === "python" ? /\.pyi?$/ : language === "java" ? /\.java$/ : /\.cs$/;
      add(file, language, snapshot.files.filter(source => within(source) && extension.test(source)), inputs,
        { manifest: file, manifestDigest: digest(text), environment: "undiscovered", ...(language === "rust" ? { edition: text.match(/edition\s*=\s*"([^"]+)"/)?.[1] ?? null } : {}) },
        ["Manifest observed; interpreter/classpath/SDK/features/tags/targets are not compiler-qualified by discovery alone"]);
    }
  }
  return { fingerprint: digest(canonical([units.map(unit => [unit.key, unit.context, unit.fingerprint]), manifestDigests, diagnostics])), units, diagnostics };
}
