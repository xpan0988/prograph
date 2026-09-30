import { emptyAdapterResult } from "./contracts.js";
import type { AdapterResult, LanguageAdapter, RepositorySnapshot } from "./contracts.js";

export const CAPABILITY_CATEGORIES = ["syntax", "symbols", "modules", "references", "calls", "types", "inheritance", "generics", "macros", "dynamicDispatch"] as const;
export type CapabilityLevel = "unsupported" | "syntax" | "heuristic" | "semantic";
export type Capabilities = Record<typeof CAPABILITY_CATEGORIES[number], CapabilityLevel>;
export interface ProviderDescriptor {
  id: string;
  version: string;
  kind: "syntax" | "compiler" | "lsp";
}
export interface ProviderStatus extends ProviderDescriptor {
  available: boolean;
  reason?: string;
}
export interface SyntaxProvider {
  descriptor: ProviderDescriptor;
  extract(snapshot: RepositorySnapshot): Promise<AdapterResult>;
}
export interface SemanticProvider {
  descriptor: ProviderDescriptor & { kind: "compiler" | "lsp" };
  capabilities?: Partial<Capabilities>;
  probe(snapshot: RepositorySnapshot): Promise<ProviderStatus>;
  resolve(snapshot: RepositorySnapshot, syntax: AdapterResult): Promise<AdapterResult>;
}
export function capabilities(values: Partial<Capabilities>): Capabilities {
  return Object.fromEntries(CAPABILITY_CATEGORIES.map(key => [key, values[key] ?? "unsupported"])) as Capabilities;
}

/** Semantic contributions are additive: unresolved syntax evidence remains inspectable. */
export function providerAdapter(options: {
  name: string;
  version: string;
  appliesTo(file: string): boolean;
  capabilities: Capabilities;
  syntax: SyntaxProvider;
  semantic?: SemanticProvider;
}): LanguageAdapter {
  return {
    ...options,
    async detect(snapshot) { return snapshot.files.some(options.appliesTo); },
    async analyze(snapshot) {
      let syntax: AdapterResult;
      try {
        syntax = await options.syntax.extract(snapshot);
      } catch (error) {
        return { ...emptyAdapterResult(), diagnostics: [{ code: "syntax-provider-failure", severity: "error", message: String(error), adapter: options.name, metadata: {} }], metadata: { capabilities: capabilities({}), providers: [{ ...options.syntax.descriptor, available: false, reason: String(error) }], semanticProviderAvailable: false } };
      }
      const providers: ProviderStatus[] = [{ ...options.syntax.descriptor, available: true }];
      if (options.semantic) {
        try {
          const status = await options.semantic.probe(snapshot);
          providers.push(status);
          if (status.available) {
            const semantic = await options.semantic.resolve(snapshot, structuredClone(syntax));
            syntax.nodes.push(...semantic.nodes);
            syntax.edges.push(...semantic.edges);
            syntax.diagnostics.push(...semantic.diagnostics);
          } else {
            syntax.diagnostics.push({ code: "semantic-provider-unavailable", severity: "info", message: status.reason ?? `${status.id} unavailable; retaining syntax evidence`, adapter: options.name, metadata: { provider: status.id } });
          }
        } catch (error) {
          const previous = providers.findIndex(provider => provider.id === options.semantic!.descriptor.id);
          if (previous >= 0) providers.splice(previous, 1);
          providers.push({ ...options.semantic.descriptor, available: false, reason: String(error) });
          syntax.diagnostics.push({ code: "semantic-provider-failure", severity: "warning", message: String(error), adapter: options.name, metadata: {} });
        }
      }
      syntax.metadata = { ...syntax.metadata, capabilities: { ...options.capabilities, ...(providers.some(p => p.available && p.kind !== "syntax") ? options.semantic?.capabilities : {}) }, providers, semanticProviderAvailable: providers.some(p => p.available && p.kind !== "syntax") };
      return syntax;
    },
  };
}
