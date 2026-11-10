import { onTestFinished } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { typescriptAdapter } from "../../src/adapters/language/typescript/index.js";
import { ADAPTER_VERSIONS } from "../../src/core/analysis/state.js";

/** Hold the real producer policy constant when isolating storage and encoding changes. */
export async function useAcceptedTypeScript(runtime: string): Promise<void> {
  const moduleUrl = pathToFileURL(path.join(runtime, "dist/adapters/language/typescript/index.js")).href;
  const { typescriptAdapter: accepted } = await import(/* @vite-ignore */ moduleUrl) as { typescriptAdapter: typeof typescriptAdapter };
  const adapter = { version: typescriptAdapter.version, analyze: typescriptAdapter.analyze };
  const versions = ADAPTER_VERSIONS as { typescript: string };
  const version = versions.typescript;
  Object.assign(typescriptAdapter, { version: accepted.version, analyze: accepted.analyze });
  versions.typescript = accepted.version!;
  onTestFinished(() => {
    Object.assign(typescriptAdapter, adapter);
    versions.typescript = version;
  });
}
