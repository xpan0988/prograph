import React from "react";
import { CheckCircle, Info, Pulse, Warning, XCircle } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import type { Diagnostic } from "../../core/graph/schema";
import type { GraphResult, Overview, RepositoryState } from "../types";

interface StatusBarProps {
  state: RepositoryState;
  overview?: Overview | undefined;
  diagnostics: Diagnostic[];
  graph: GraphResult;
}

function StateIcon({ state }: { state: RepositoryState }): React.ReactElement {
  if (state === "fresh") return <CheckCircle size={14} weight="fill" />;
  if (state === "error" || state === "missing") return <XCircle size={14} weight="fill" />;
  if (state === "stale") return <Warning size={14} weight="fill" />;
  return <Pulse size={14} />;
}

export function StatusBar({ state, overview, diagnostics, graph }: StatusBarProps): React.ReactElement {
  const { t } = useI18n();
  const duration = overview?.adapters.reduce((total, adapter) => total + adapter.durationMs, 0) ?? 0;
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  const info = diagnostics.filter((item) => item.severity === "info").length;
  return (
    <footer className="statusbar" aria-live="polite">
      <div className={`status-chip state-${state}`}><StateIcon state={state} /><strong>{t(`status.${state}`)}</strong></div>
      <div className="status-chip"><span>{t("status.adapters")}</span>{overview?.adapters.filter((adapter) => adapter.detected).map((adapter) => <code key={adapter.adapter}>{adapter.adapter}</code>)}</div>
      <div className="status-chip"><span>{t("status.diagnostics")}</span><b className="severity-error"><XCircle size={12} />{errors}</b><b className="severity-warning"><Warning size={12} />{warnings}</b><b><Info size={12} />{info}</b></div>
      <div className="status-chip"><span>{t("toolbar.scope")}</span><strong>{t("status.scope", { nodes: graph.nodes.length, edges: graph.edges.length })}</strong></div>
      <div className="status-chip status-tail"><strong>{t("status.generated", { duration })}</strong></div>
    </footer>
  );
}
