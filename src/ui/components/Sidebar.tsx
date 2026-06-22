import React, { useState } from "react";
import {
  BracketsCurly,
  CaretDown,
  CaretRight,
  ChartDonut,
  CirclesFour,
  File,
  FlowArrow,
  Graph,
  Pulse,
  ShieldWarning,
  TreeStructure,
} from "@phosphor-icons/react";
import type { TranslationKey } from "../i18n/en";
import { useI18n } from "../i18n";
import type { FileSummary, GraphResult, Overview, View } from "../types";

const navGroups: Array<{ label: TranslationKey; items: Array<{ id: View; label: TranslationKey; detail: TranslationKey; icon: typeof Graph }> }> = [
  {
    label: "nav.explore",
    items: [
      { id: "architecture", label: "nav.architecture", detail: "nav.architecture.detail", icon: TreeStructure },
      { id: "dependencies", label: "nav.dependencies", detail: "nav.dependencies.detail", icon: CirclesFour },
      { id: "framework", label: "nav.framework", detail: "nav.framework.detail", icon: FlowArrow },
      { id: "symbols", label: "nav.symbols", detail: "nav.symbols.detail", icon: BracketsCurly },
    ],
  },
  {
    label: "nav.analysis",
    items: [
      { id: "context", label: "nav.context", detail: "nav.context.detail", icon: Pulse },
      { id: "affected", label: "nav.affected", detail: "nav.affected.detail", icon: Graph },
      { id: "diagnostics", label: "nav.diagnostics", detail: "nav.diagnostics.detail", icon: ShieldWarning },
    ],
  },
];

interface SidebarProps {
  view: View;
  overview?: Overview | undefined;
  files: FileSummary[];
  rawGraph: GraphResult;
  depth: number;
  onViewChange: (view: View) => void;
}

export function Sidebar({ view, overview, files, rawGraph, depth, onViewChange }: SidebarProps): React.ReactElement {
  const { locale, setLocale, t } = useI18n();
  const [filesOpen, setFilesOpen] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const repositoryRoot = overview?.repository.root;
  const filteredFiles = files.filter((file) => file.path.toLowerCase().includes(fileFilter.trim().toLowerCase()));
  const visibleFiles = filteredFiles.slice(0, 13);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><ChartDonut size={23} weight="duotone" /></span>
        <div><strong>ProGraph</strong><span>{t("app.subtitle")}</span></div>
        <b>{t("app.version")}</b>
      </div>
      <div className="repo-block">
        <span>{t("repo.title")}</span>
        <strong title={repositoryRoot}>{repositoryRoot?.split("/").at(-1) ?? t("repo.loading")}</strong>
        <code title={repositoryRoot}>{repositoryRoot}</code>
      </div>
      <nav aria-label="Primary">
        {navGroups.map((group) => (
          <section className="nav-group" key={group.label}>
            <h2>{t(group.label)}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={view === item.id ? "page" : undefined}
                  className={view === item.id ? "active" : ""}
                  key={item.id}
                  onClick={() => onViewChange(item.id)}
                  title={`${t(item.label)} — ${t(item.detail)}`}
                >
                  <Icon size={18} weight={view === item.id ? "fill" : "regular"} />
                  <span><strong>{t(item.label)}</strong><small>{t(item.detail)}</small></span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>
      <section className={`repository-panel ${filesOpen ? "open" : ""}`}>
        <button
          className="repository-panel-toggle"
          aria-expanded={filesOpen}
          aria-label={filesOpen ? t("repo.hideFiles") : t("repo.showFiles")}
          onClick={() => setFilesOpen((current) => !current)}
        >
          <span>{t("repo.files")}</span>
          {filesOpen ? <CaretDown size={14} /> : <CaretRight size={14} />}
        </button>
        {filesOpen && (
          <div className="file-list">
            <label className="file-filter">
              <span>{t("repo.filterFiles")}</span>
              <input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder={t("repo.filterFilesPlaceholder")} />
            </label>
            {visibleFiles.map((item) => (
              <div className="file-row" key={item.path} title={item.path}>
                <File size={13} /><code>{item.path}</code><b>{item.nodeCount}</b>
              </div>
            ))}
            {filteredFiles.length > visibleFiles.length && <small>{t("repo.moreFiles", { count: filteredFiles.length - visibleFiles.length })}</small>}
          </div>
        )}
      </section>
      <div className="scope-card">
        <div><span>{t("scope.title")}</span><b>{t(rawGraph.truncated ? "scope.bounded" : "scope.complete")}</b></div>
        <div><span>{t("scope.depth")}</span><strong>{depth}</strong></div>
        <div><span>{t("scope.nodes")}</span><strong>{rawGraph.nodes.length} / {overview?.counts.nodes ?? "…"}</strong></div>
        <div><span>{t("scope.edges")}</span><strong>{rawGraph.edges.length} / {overview?.counts.edges ?? "…"}</strong></div>
      </div>
      <label className="language-selector">
        <span>{t("language.label")}</span>
        <select aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
          <option value="en">{t("language.english")}</option>
          <option value="zh-CN">{t("language.chinese")}</option>
        </select>
      </label>
    </aside>
  );
}
