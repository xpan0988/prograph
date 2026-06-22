import React from "react";
import { Check, Graph, ListMagnifyingGlass } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import type { AffectedResult, ContextResult, View } from "../types";

const viewCopy: Record<View, { title: TranslationKey; description: TranslationKey }> = {
  architecture: { title: "view.architecture.title", description: "view.architecture.description" },
  dependencies: { title: "view.dependencies.title", description: "view.dependencies.description" },
  symbols: { title: "view.symbols.title", description: "view.symbols.description" },
  framework: { title: "view.framework.title", description: "view.framework.description" },
  context: { title: "view.context.title", description: "view.context.description" },
  affected: { title: "view.affected.title", description: "view.affected.description" },
  diagnostics: { title: "view.diagnostics.title", description: "view.diagnostics.description" },
};

export function ViewHeader({ view, nodes, edges, children }: { view: View; nodes: number; edges: number; children?: React.ReactNode }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="view-header">
      <div className="view-heading"><span><Graph size={17} /></span><div><h1>{t(viewCopy[view].title)}</h1><p>{t(viewCopy[view].description)}</p></div></div>
      <div className="view-meta"><b>{t("graph.nodes", { count: nodes })}</b><b>{t("graph.edges", { count: edges })}</b>{children}</div>
    </div>
  );
}

export function ArchitectureLanes(): React.ReactElement {
  const { t } = useI18n();
  return <div className="lane-labels">{(["domain.frontend", "domain.api", "domain.bridge", "domain.rust", "domain.core", "domain.adapters", "domain.external", "domain.cli", "domain.tests"] as TranslationKey[]).map((item) => <span key={item}>{t(item)}</span>)}</div>;
}

export function GraphLegend({ languages, onToggle }: { languages: Set<string>; onToggle: (language: string) => void }): React.ReactElement {
  const { t } = useI18n();
  const items: Array<{ id: string; label: TranslationKey }> = [
    { id: "frontend", label: "domain.frontendShort" },
    { id: "api", label: "domain.apiShort" },
    { id: "bridge", label: "domain.bridge" },
    { id: "rust", label: "domain.rust" },
    { id: "core", label: "domain.core" },
    { id: "adapters", label: "domain.adapters" },
    { id: "cli", label: "domain.cli" },
    { id: "tests", label: "domain.tests" },
    { id: "external", label: "domain.externalShort" },
  ];
  return (
    <div className="graph-legend" aria-label={t("graph.legend")}>
      {items.map((item) => <button className={languages.has(item.id) ? "enabled" : ""} key={item.id} onClick={() => onToggle(item.id)}><i className={`dot ${item.id}`} />{t(item.label)}</button>)}
      <span className="edge-style-sample direct">{t("legend.direct")}</span>
      <span className="edge-style-sample indirect">{t("legend.indirect")}</span>
      <span className="edge-style-sample inferred">{t("legend.inferred")}</span>
    </div>
  );
}

export function ContextSummary({ result }: { result: ContextResult }): React.ReactElement {
  const { t } = useI18n();
  const localizeReason = (reason: string): string => {
    if (reason.startsWith("matched task terms:")) return t("result.reason.matched", { terms: reason.slice("matched task terms:".length).trim() });
    if (reason.startsWith("graph degree ")) return t("result.reason.degree", { count: reason.slice("graph degree ".length).trim() });
    if (reason === "framework binding") return t("result.reason.framework");
    return reason;
  };
  return (
    <aside className="result-summary">
      <header><ListMagnifyingGlass size={17} /><div><strong>{t("view.context.title")}</strong><code>{result.task}</code></div></header>
      {result.files.slice(0, 5).map((item) => <div className="ranked-result" key={item.file}><Check size={13} /><span><code>{item.file}</code><small>{item.reasons.map(localizeReason).join(" · ")}</small></span></div>)}
    </aside>
  );
}

export function AffectedSummary({ result }: { result: AffectedResult }): React.ReactElement {
  const { t } = useI18n();
  const groups = [
    [t("result.direct"), result.directlyAffectedSymbols.length],
    [t("result.transitive"), result.transitivelyAffectedSymbols.length],
    [t("result.tests"), result.relatedTests.length],
    [t("result.boundaries"), result.frameworkBoundariesCrossed.length],
  ] as const;
  return (
    <aside className="result-summary compact">
      <header><ListMagnifyingGlass size={17} /><strong>{t("view.affected.title")}</strong></header>
      <div className="result-grid">{groups.map(([label, count]) => <div key={label}><b>{count}</b><span>{label}</span></div>)}</div>
    </aside>
  );
}
