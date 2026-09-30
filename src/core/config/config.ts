import { readFile } from "node:fs/promises";
import path from "node:path";

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
}

export interface LoadedConfig {
  include: string[];
  exclude: string[];
  adapters: Record<AdapterName, boolean>;
  sourcePath?: string;
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

export async function loadConfig(repositoryRoot: string): Promise<LoadedConfig> {
  const configPath = path.join(repositoryRoot, "prograph.config.json");
  let parsed: ProGraphConfig = {};
  let sourcePath: string | undefined;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as ProGraphConfig;
    sourcePath = configPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid ProGraph configuration at ${configPath}: ${String(error)}`);
    }
  }
  return {
    ...defaultConfig(),
    include: parsed.include?.length ? parsed.include : DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(parsed.exclude ?? [])],
    adapters: {
      ...defaultConfig().adapters,
      ...parsed.adapters,

    },
    ...(sourcePath ? { sourcePath } : {}),
  };
}
