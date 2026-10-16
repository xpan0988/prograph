/** Trusted producer control data. Never accepted from an interchange sidecar. */
export interface ProviderRegistration {
  key: string;
  kind: "managed" | "rust" | "clang";
  recipe: Record<string, unknown>;
  trust: string;
  version: string;
  authorization: string;
}
export interface PreparedProvider {
  parent: number | undefined;
  prefix: string;
  runs: number[];
  registration: ProviderRegistration;
}
export interface ProviderPreparation {
  prepare?: (plan: PreparedProvider) => void;
  authorization?: ProviderRegistration;
}
export const ownsProviderPartition = (prefix: string, partition: string): boolean => partition === prefix || partition.startsWith(`${prefix}/`);
