import React from "react";
import { ArrowRight, ArrowsClockwise, CornersOut, MagnifyingGlass, SlidersHorizontal } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import type { ConfidenceLevel, EvidenceMode, GraphMode, KnowledgeScope } from "../types";

interface TopToolbarProps {
  query: string;
  depth: number;
  maxNodes: number;
  confidence: ConfidenceLevel;
  evidenceMode: EvidenceMode;
  graphMode: GraphMode;
  scope: KnowledgeScope;
  edgeKind: string;
  syncing: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onDepthChange: (depth: number) => void;
  onMaxNodesChange: (maxNodes: number) => void;
  onConfidenceChange: (confidence: ConfidenceLevel) => void;
  onEvidenceModeChange: (mode: EvidenceMode) => void;
  onGraphModeChange: (mode: GraphMode) => void;
  onScopeChange: (scope: KnowledgeScope) => void;
  onEdgeKindChange: (edgeKind: string) => void;
  onSync: () => void;
  onFit: () => void;
  onReset: () => void;
}

export function TopToolbar(props: TopToolbarProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <header className="toolbar">
      <form className="search-control" onSubmit={(event) => { event.preventDefault(); props.onSearch(); }}>
        <span className="control-caption">{t("toolbar.search")}</span>
        <div className="search-field">
          <MagnifyingGlass size={17} />
          <input
            aria-label={t("toolbar.searchPlaceholder")}
            ref={props.searchInputRef}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t("toolbar.searchPlaceholder")}
          />
          <kbd>⌘K</kbd>
          <button type="submit" aria-label={t("toolbar.search")} title={t("toolbar.search")}><ArrowRight size={14} /></button>
        </div>
      </form>
      <div className="toolbar-group">
        <span className="control-caption">{t("toolbar.graph")}</span>
        <div className="control-row">
          <select aria-label={t("toolbar.graph")} value={props.graphMode} onChange={(event) => props.onGraphModeChange(event.target.value as GraphMode)}>
            <option value="code">{t("graphMode.code")}</option>
            <option value="knowledge">{t("graphMode.knowledgeBeta")}</option>
          </select>
          <select aria-label={t("toolbar.scope")} value={props.scope} onChange={(event) => props.onScopeChange(event.target.value as KnowledgeScope)}>
            <option value="code">{t("scope.code")}</option>
            <option value="code+docs">{t("scope.docs")}</option>
            <option value="code+config">{t("scope.config")}</option>
            <option value="code+tests">{t("scope.tests")}</option>
            <option value="full">{t("scope.full")}</option>
          </select>
        </div>
      </div>
      <div className="toolbar-group">
        <span className="control-caption">{t("toolbar.bounds")}</span>
        <div className="control-row">
          <label><span>{t("toolbar.maxDepth")}</span><select value={props.depth} onChange={(event) => props.onDepthChange(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>{t("toolbar.maxNodes")}</span><select value={props.maxNodes} onChange={(event) => props.onMaxNodesChange(Number(event.target.value))}>{[25, 50, 75, 100, 150].map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
      </div>
      <div className="toolbar-group">
        <span className="control-caption">{t("toolbar.confidence")}</span>
        <select aria-label={t("toolbar.confidence")} value={props.confidence} onChange={(event) => props.onConfidenceChange(event.target.value as ConfidenceLevel)}>
          <option value="trusted">{t("confidence.trusted")}</option>
          <option value="probable">{t("confidence.probable")}</option>
          <option value="unresolved">{t("confidence.unresolved")}</option>
        </select>
      </div>
      <div className="toolbar-group">
        <span className="control-caption">{t("toolbar.edgeKind")}</span>
        <select aria-label={t("toolbar.edgeKind")} value={props.edgeKind} onChange={(event) => props.onEdgeKindChange(event.target.value)}>
          <option value="readable">{t("edgeFilter.readable")}</option>
          <option value="all">{t("edgeFilter.all")}</option>
          {["imports", "calls", "renders", "invokes", "registers", "emits", "listens", "tests", "contains", "uses_type", "documents", "explains", "mentions", "configured_by", "configures", "exposes_api", "describes_workflow", "related_to"].map((kind) => <option value={kind} key={kind}>{t(`edge.${kind}` as Parameters<typeof t>[0])}</option>)}
        </select>
      </div>
      <div className="toolbar-group">
        <span className="control-caption">{t("toolbar.evidence")}</span>
        <select aria-label={t("toolbar.evidence")} value={props.evidenceMode} onChange={(event) => props.onEvidenceModeChange(event.target.value as EvidenceMode)}>
          <option value="compact">{t("evidence.compact")}</option>
          <option value="standard">{t("evidence.standard")}</option>
          <option value="full">{t("evidence.full")}</option>
        </select>
      </div>
      <div className="toolbar-group toolbar-actions">
        <span className="control-caption">{t("toolbar.actions")}</span>
        <div className="control-row">
          <button className="button secondary" title={t("toolbar.fit")} onClick={props.onFit}><CornersOut size={16} /><span>{t("toolbar.fit")}</span></button>
          <button className="button secondary icon-only" aria-label={t("toolbar.reset")} title={t("toolbar.reset")} onClick={props.onReset}><SlidersHorizontal size={16} /></button>
          <button className="button primary" aria-label={t("toolbar.sync")} title={t("toolbar.sync")} disabled={props.syncing} onClick={props.onSync}><ArrowsClockwise className={props.syncing ? "spin" : ""} size={16} /><span>{t("toolbar.sync")}</span></button>
        </div>
      </div>
    </header>
  );
}
