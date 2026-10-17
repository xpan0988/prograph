import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BoundaryProtocol } from "../graph/boundaries.js";

export interface BoundaryConfiguration {
  protocol: BoundaryProtocol;
  namespace: string;
  contracts: string[];
  bindings: { file: string; symbol: string; operation: string; role: "invokes" | "implements" | "emits" | "listens"; line?: number; column?: number }[];
}

export const DEFAULT_INCLUDE = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mts",
  "**/*.cts",
  "**/*.rs",
  "**/*.{py,pyi,java,c,h,cc,cpp,cxx,hpp,hxx,go,cs,proto,sql,graphql,gql,tf}",
  "**/*.{yaml,yml,toml,json}",
  "README.md",
  "**/*.md",
  "**/package.json",
  "**/Cargo.toml",
  "**/tauri.conf.json",
  "**/src-tauri/capabilities/*.json",
  "**/src-tauri/capability/*.json",
  "**/tsconfig.json",
  "**/jsconfig.json",
  "**/*.config.json",
  "**/.eslintrc.json",
  "**/.prettierrc.json",
];

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.prograph/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/obj/**",
  "**/generated/**",
  "**/.generated/**",
  "**/*.generated.*",
  "**/Cargo/registry/**",
];

export type AdapterName =
  | "typescript"
  | "python" | "java" | "c" | "cpp" | "go" | "csharp" | "architecture"
  | "rust"
  | "react"
  | "tauri"
  | "markdown"
  | "packageJson"
  | "cargoToml"
  | "tauriConfig"
  | "tauriCapability"
  | "tests"
  | "semanticLinker";

export interface ProGraphConfig {
  include?: string[];
  exclude?: string[];
  adapters?: Partial<Record<AdapterName, boolean>>;
  boundaries?: BoundaryConfiguration[];
}

export interface LoadedConfig {
  include: string[];
  exclude: string[];
  adapters: Record<AdapterName, boolean>;
  sourcePath?: string;
  boundaries?: BoundaryConfiguration[];
}

export function defaultConfig(): LoadedConfig {
  return {
    include: DEFAULT_INCLUDE,
    exclude: DEFAULT_EXCLUDE,
    adapters: {
      typescript: true,
      python: true, java: true, c: true, cpp: true, go: true, csharp: true, architecture: true,
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
}

export async function readProGraphConfiguration(repositoryRoot: string): Promise<{ source: string | null; fingerprint: string }> {
  try {
    const source = await readFile(path.join(repositoryRoot, "prograph.config.json"), "utf8");
    return { source, fingerprint: createHash("sha256").update(source).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: null, fingerprint: "absent" };
    throw error;
  }
}

export async function loadConfig(repositoryRoot: string, observedSource?: string | null): Promise<LoadedConfig> {
  const configPath = path.join(repositoryRoot, "prograph.config.json");
  let parsed: ProGraphConfig = {};
  let sourcePath: string | undefined;
  try {
    const source = observedSource === undefined ? await readFile(configPath, "utf8") : observedSource;
    if (source !== null) { parsed = JSON.parse(source) as ProGraphConfig; sourcePath = configPath; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid ProGraph configuration at ${configPath}: ${String(error)}`);
    }
  }
  return {
    ...defaultConfig(),
    ...(parsed.boundaries ? { boundaries: validateBoundaries(parsed.boundaries) } : {}),
    include: parsed.include?.length ? parsed.include : DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(parsed.exclude ?? [])],
    adapters: {
      ...defaultConfig().adapters,
      ...parsed.adapters,

    },
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function validateBoundaries(value: BoundaryConfiguration[]): BoundaryConfiguration[] {
  const protocols = ["tauri-command", "tauri-event", "http", "graphql", "grpc", "ffi", "jni", "pinvoke", "subprocess", "ipc", "websocket", "message", "database"];
  const relative = (file: string) => typeof file === "string" && file.length > 0 && !path.posix.isAbsolute(file) && !file.includes("\\") && !file.split("/").includes("..");
  if (!Array.isArray(value) || value.length > 1000) throw Error("Invalid boundary configuration");
  for (const entry of value) {
    if (!entry || !protocols.includes(entry.protocol) || typeof entry.namespace !== "string" || !entry.namespace.trim() || entry.namespace.length > 512 ||
      !Array.isArray(entry.contracts) || !entry.contracts.length || !entry.contracts.every(relative) || !Array.isArray(entry.bindings) || entry.bindings.length > 10000) throw Error("Invalid boundary namespace/contract configuration");
    for (const binding of entry.bindings) if (!binding || !relative(binding.file) || typeof binding.symbol !== "string" || !binding.symbol ||
      typeof binding.operation !== "string" || !binding.operation || !["invokes", "implements", "emits", "listens"].includes(binding.role) ||
      (binding.line !== undefined && (!Number.isSafeInteger(binding.line) || binding.line < 1)) || (binding.column !== undefined && (!Number.isSafeInteger(binding.column) || binding.column < 1))) throw Error("Invalid boundary participant configuration");
  }
  return value;
}
