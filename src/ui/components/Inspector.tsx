import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Code, Copy, File, Path, X } from "@phosphor-icons/react";
import type { GraphEdge, GraphNode } from "../../core/graph/schema";
import { useI18n } from "../i18n";

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
  const relationshipCounts = [
    [t("inspector.incoming"), incoming.length, <ArrowDownLeft size={14} />],
    [t("inspector.outgoing"), outgoing.length, <ArrowUpRight size={14} />],
    [t("inspector.callers"), callers.length, <ArrowDownLeft size={14} />],
    [t("inspector.callees"), callees.length, <ArrowUpRight size={14} />],
    [t("inspector.dependencies"), dependencies.length, <Path size={14} />],
    [t("inspector.frameworkBindings"), framework.length, <Path size={14} />],
  ] as const;
  const relationship = selectedEdge ?? related[0];
  return (
    <aside className="inspector" data-testid="evidence-inspector" aria-label={t("inspector.title")}>
      <div className="inspector-title">
        <span>{t("inspector.title")}</span>
        <button aria-label={t("inspector.close")} title={t("inspector.close")} onClick={onClose}><X size={16} /></button>
      </div>
      <section className="inspector-identity">
        <div className="identity-heading"><span className="identity-icon"><Code size={19} /></span><div><strong>{node.name}</strong><small>{t(`node.${node.kind}`)}</small></div><b>{node.language ?? node.adapter}</b></div>
        <dl>
          <div><dt>{t("inspector.qualifiedName")}</dt><dd><code>{node.qualifiedName}</code><CopyButton value={node.qualifiedName} /></dd></div>
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
            return (
              <button className={relationship?.id === edge.id ? "active" : ""} key={edge.id} onClick={() => onEdgeSelect(edge)}>
                <Path size={15} />
                <span><strong>{t(`edge.${edge.kind}`)}</strong><small>{otherName ?? (outgoingEdge ? edge.target : edge.source)}</small></span>
                <em>{outgoingEdge ? "→" : "←"}</em>
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
        <div className="section-title"><span>{t("inspector.evidence")}</span><b>{relationship?.evidence.length ?? 0}</b></div>
        {relationship?.evidence.length ? relationship.evidence.map((item, index) => (
          <article className="evidence-card" key={`${item.file}-${item.line}-${index}`}>
            <div><File size={14} /><code>{item.file}:{item.line}:{item.column}</code></div>
            {item.matchedSyntax && <pre>{item.matchedSyntax}</pre>}
            <dl>
              {item.bindingName && <div><dt>binding</dt><dd>{item.bindingName}</dd></div>}
              <div><dt>resolution</dt><dd>{item.resolutionMethod ?? item.adapter}</dd></div>
              <div><dt>{t("toolbar.confidence")}</dt><dd>{relationship.confidence}</dd></div>
            </dl>
          </article>
        )) : <p className="muted-copy">{t("inspector.noEvidence")}</p>}
      </section>
      <details className="metadata-section">
        <summary>{t("inspector.metadata")}</summary>
        <div><span>{t("inspector.stableId")}</span><CopyButton value={node.id} /><code>{node.id}</code></div>
        <pre>{JSON.stringify(node.metadata, null, 2)}</pre>
      </details>
    </aside>
  );
}
