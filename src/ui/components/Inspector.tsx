import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BracketsCurly, Code, Copy, File, Path, X } from "@phosphor-icons/react";
import { evidenceOf, metadataOf } from "../../core/graph/metadata";
import type { GraphEdge, GraphNode } from "../../core/graph/schema";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/en";

interface InspectorProps {
  node: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedEdge?: GraphEdge | undefined;
  onEdgeSelect: (edge: GraphEdge) => void;
  onClose: () => void;
}

function CopyButton({ value }: { value: string }): React.ReactElement {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);
  return (
    <button
      className="copy-button"
      title={copied ? t("inspector.copied") : t("inspector.copy")}
      aria-label={copied ? t("inspector.copied") : t("inspector.copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 1200);
      }}
    ><Copy size={13} />{copied ? t("inspector.copied") : t("inspector.copy")}</button>
  );
}

interface SymbolSummary {
  id?: string;
  name?: string;
  kind?: string;
  qualifiedName?: string;
  startLine?: number;
  endLine?: number;
}

interface UnderlyingRelationshipSummary {
  id?: string;
  kind?: string;
  confidence?: string;
  sourceSymbol?: string;
  targetSymbol?: string;
}

function symbolSummaries(value: unknown): SymbolSummary[] {
  return Array.isArray(value)
    ? value.filter((item): item is SymbolSummary => typeof item === "object" && item !== null && "name" in item)
    : [];
}

function underlyingRelationshipSummaries(value: unknown): UnderlyingRelationshipSummary[] {
  return Array.isArray(value)
    ? value.filter((item): item is UnderlyingRelationshipSummary => typeof item === "object" && item !== null)
    : [];
}

export function Inspector({ node, nodes, edges, selectedEdge, onEdgeSelect, onClose }: InspectorProps): React.ReactElement {
  const { t } = useI18n();
  const nodeNames = useMemo(() => new Map(nodes.map((item) => [item.id, item.name])), [nodes]);
  const related = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const incoming = related.filter((edge) => edge.target === node.id);
  const outgoing = related.filter((edge) => edge.source === node.id);
  const callers = incoming.filter((edge) => ["calls", "invokes", "renders", "listens"].includes(edge.kind));
  const callees = outgoing.filter((edge) => ["calls", "invokes", "renders", "emits", "uses_type"].includes(edge.kind));
  const dependencies = related.filter((edge) => edge.kind === "imports");
  const framework = related.filter((edge) => ["invokes", "registers", "emits", "listens"].includes(edge.kind));
  const knowledge = related.filter((edge) => ["documents", "explains", "mentions", "configured_by", "configures", "exposes_api", "describes_workflow", "tests", "related_to"].includes(edge.kind));
  const nodeMetadata = metadataOf(node);
  const relationshipCounts = [
    [t("inspector.incoming"), incoming.length, <ArrowDownLeft size={14} />],
    [t("inspector.outgoing"), outgoing.length, <ArrowUpRight size={14} />],
    [t("inspector.callers"), callers.length, <ArrowDownLeft size={14} />],
    [t("inspector.callees"), callees.length, <ArrowUpRight size={14} />],
    [t("inspector.dependencies"), dependencies.length, <Path size={14} />],
    [t("inspector.frameworkBindings"), framework.length, <Path size={14} />],
    [t("inspector.knowledge"), knowledge.length, <Path size={14} />],
  ] as const;
  const relationship = selectedEdge ?? related[0];
  const relationshipEvidence = evidenceOf(relationship);
  const relationshipMetadata = metadataOf(relationship);
  const underlyingRelationships = underlyingRelationshipSummaries(relationshipMetadata.underlyingEdges);
  const containedSymbols = symbolSummaries(nodeMetadata.containedSymbols);
  const translatedKindKey = `node.${node.kind}` as TranslationKey;
  const translatedKind = t(translatedKindKey) === translatedKindKey ? node.kind : t(translatedKindKey);
  const lineRange = node.startLine ? `${node.startLine}${node.endLine && node.endLine !== node.startLine ? `-${node.endLine}` : ""}` : undefined;
  return (
    <aside className="inspector" data-testid="evidence-inspector" aria-label={t("inspector.title")}>
      <div className="inspector-title">
        <span>{t("inspector.title")}</span>
        <button aria-label={t("inspector.close")} title={t("inspector.close")} onClick={onClose}><X size={16} /></button>
      </div>
      <section className="inspector-identity">
        <div className="identity-heading"><span className="identity-icon"><Code size={19} /></span><div><strong>{node.name}</strong><small>{translatedKind}</small></div><b>{node.language ?? node.adapter}</b></div>
        <dl>
          <div><dt>{t("inspector.kind")}</dt><dd><code>{translatedKind}</code></dd></div>
          <div><dt>{t("inspector.language")}</dt><dd><code>{node.language ?? "unknown"}</code></dd></div>
          <div><dt>{t("inspector.qualifiedName")}</dt><dd><code>{node.qualifiedName}</code><CopyButton value={node.qualifiedName} /></dd></div>
          {lineRange && <div><dt>{t("inspector.lineRange")}</dt><dd><code>{lineRange}</code></dd></div>}
          {["artifactKind", "sourceCategory", "stableKey", "generatedByAdapter", "extractionMethod"].map((key) => (
            nodeMetadata[key] ? <div key={key}><dt>{key}</dt><dd><code>{String(nodeMetadata[key])}</code></dd></div> : null
          ))}
        </dl>
      </section>
      <section>
        <div className="section-title"><span>{t("inspector.relationships")}</span><b>{related.length}</b></div>
        <div className="relationship-summary">
          {relationshipCounts.map(([label, count, icon]) => <div key={label}>{icon}<span>{label}</span><b>{count}</b></div>)}
        </div>
        <div className="relationship-list">
          {related.slice(0, 12).map((edge) => {
            const outgoingEdge = edge.source === node.id;
            const otherName = nodeNames.get(outgoingEdge ? edge.target : edge.source);
            const edgeMetadata = metadataOf(edge);
            const underlyingCount = typeof edgeMetadata.underlyingEdgeCount === "number" ? edgeMetadata.underlyingEdgeCount : undefined;
            return (
              <button className={relationship?.id === edge.id ? "active" : ""} key={edge.id} onClick={() => onEdgeSelect(edge)}>
                <Path size={15} />
                <span><strong>{t(`edge.${edge.kind}` as TranslationKey)}{underlyingCount && underlyingCount > 1 ? ` ×${underlyingCount}` : ""}</strong><small>{otherName ?? (outgoingEdge ? edge.target : edge.source)}</small></span>
                {outgoingEdge ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}
              </button>
            );
          })}
        </div>
      </section>
      {node.file && <section>
        <div className="section-title"><span>{t("inspector.source")}</span></div>
        <div className="source-location"><File size={14} /><code>{node.file}{node.startLine ? `:${node.startLine}${node.startColumn ? `:${node.startColumn}` : ""}` : ""}</code><CopyButton value={node.file} /></div>
      </section>}
      <section>
        <div className="section-title"><span>{t("inspector.evidence")}</span><b>{relationshipEvidence.length}</b></div>
        {relationshipEvidence.length ? relationshipEvidence.map((item, index) => (
          <article className="evidence-card" key={`${item.file}-${item.line}-${index}`}>
            <div><File size={14} /><code>{item.file ?? "unknown"}{item.line ? `:${item.line}` : ""}{item.column ? `:${item.column}` : ""}</code></div>
            {item.matchedSyntax && <pre>{item.matchedSyntax}</pre>}
            <dl>
              {item.bindingName && <div><dt>binding</dt><dd>{item.bindingName}</dd></div>}
              <div><dt>resolution</dt><dd>{item.resolutionMethod ?? item.adapter ?? "unknown"}</dd></div>
              {relationship && <div><dt>{t("toolbar.confidence")}</dt><dd>{relationship.confidence}</dd></div>}
            </dl>
          </article>
        )) : <p className="muted-copy">{t("inspector.noEvidence")}</p>}
      </section>
      {underlyingRelationships.length > 0 && <section>
        <div className="section-title"><span>{t("inspector.underlyingRelationships")}</span><b>{underlyingRelationships.length}</b></div>
        <div className="underlying-list">
          {underlyingRelationships.slice(0, 12).map((item, index) => (
            <article key={item.id ?? index}>
              <span>
                <strong>{item.kind ? t(`edge.${item.kind}` as TranslationKey) : t("inspector.relationships")}</strong>
                <small>{item.confidence ?? "trusted"}</small>
              </span>
              <code>{item.sourceSymbol ?? "source"} {"->"} {item.targetSymbol ?? "target"}</code>
            </article>
          ))}
        </div>
      </section>}
      <section>
        <div className="section-title"><span>{t("inspector.symbols")}</span><b>{containedSymbols.length}</b></div>
        {containedSymbols.length ? (
          <div className="symbol-list">
            {containedSymbols.slice(0, 20).map((symbol) => (
              <div className="symbol-row" key={symbol.id ?? symbol.qualifiedName ?? symbol.name}>
                <BracketsCurly size={14} />
                <span><strong>{symbol.name ?? symbol.qualifiedName}</strong><small>{symbol.kind ?? "symbol"}{symbol.startLine ? ` · line ${symbol.startLine}` : ""}</small></span>
              </div>
            ))}
          </div>
        ) : <p className="muted-copy">{t("inspector.noSymbols")}</p>}
      </section>
      <details className="metadata-section">
        <summary>{t("inspector.metadata")}</summary>
        <div><span>{t("inspector.stableId")}</span><CopyButton value={node.id} /><code>{node.id}</code></div>
        <pre>{JSON.stringify(nodeMetadata, null, 2)}</pre>
      </details>
    </aside>
  );
}
