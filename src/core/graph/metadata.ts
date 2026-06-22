import type { SourceEvidence } from "./schema.js";

export interface MetadataEntity {
  metadata?: Record<string, unknown> | null;
}

export interface EvidenceEntity {
  evidence?: SourceEvidence[] | null;
}

export function metadataOf(entity: MetadataEntity | undefined | null): Record<string, unknown> {
  return entity?.metadata ?? {};
}

export function stringMetadata(entity: MetadataEntity | undefined | null, key: string): string | undefined {
  const value = metadataOf(entity)[key];
  return typeof value === "string" ? value : undefined;
}

export const metadataString = stringMetadata;

export function sourceCategoryOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "sourceCategory");
}

export function graphDomainOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "graphDomain");
}

export function artifactKindOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "artifactKind");
}

export function stableKeyOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "stableKey");
}

export function generatedByAdapterOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "generatedByAdapter");
}

export function extractionMethodOf(entity: MetadataEntity | undefined | null): string | undefined {
  return stringMetadata(entity, "extractionMethod");
}

export function isKnowledgeNode(entity: MetadataEntity & { kind?: string } | undefined | null): boolean {
  const kind = entity?.kind;
  return graphDomainOf(entity) === "knowledge"
    || kind === "doc_section"
    || kind === "configuration"
    || kind === "api_surface"
    || kind === "cli_command"
    || kind === "test_artifact"
    || kind === "external_service"
    || kind === "security_boundary"
    || kind === "concept"
    || kind === "feature"
    || kind === "workflow";
}

export function isCodeNode(entity: MetadataEntity & { kind?: string } | undefined | null): boolean {
  return !isKnowledgeNode(entity);
}

export function evidenceOf(entity: EvidenceEntity | undefined | null): SourceEvidence[] {
  return Array.isArray(entity?.evidence) ? entity.evidence : [];
}
