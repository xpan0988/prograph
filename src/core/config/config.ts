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
  "**/generated/**",
  "**/.generated/**",
  "**/*.generated.*",
  "**/Cargo/registry/**",
];

export interface ProGraphConfig {
  include?: string[];
  exclude?: string[];
  adapters?: Partial<Record<"typescript" | "rust" | "react" | "tauri", boolean>>;
}

export interface LoadedConfig {
  include: string[];
  exclude: string[];
  adapters: Record<"typescript" | "rust" | "react" | "tauri", boolean>;
  sourcePath?: string;
}

export function defaultConfig(): LoadedConfig {
  return {
    include: DEFAULT_INCLUDE,
    exclude: DEFAULT_EXCLUDE,
    adapters: { typescript: true, rust: true, react: true, tauri: true },
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
      typescript: parsed.adapters?.typescript ?? true,
      rust: parsed.adapters?.rust ?? true,
      react: parsed.adapters?.react ?? true,
      tauri: parsed.adapters?.tauri ?? true,
    },
    ...(sourcePath ? { sourcePath } : {}),
  };
}
