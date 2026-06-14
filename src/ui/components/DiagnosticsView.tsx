import React, { useMemo, useState } from "react";
import { Info, ShieldWarning, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { Diagnostic, DiagnosticSeverity } from "../../core/graph/schema";
import { useI18n } from "../i18n";

export function DiagnosticsView({ diagnostics }: { diagnostics: Diagnostic[] }): React.ReactElement {
  const { t } = useI18n();
  const [severity, setSeverity] = useState<DiagnosticSeverity | "all">("all");
  const [adapter, setAdapter] = useState("all");
  const [code, setCode] = useState("all");
  const [file, setFile] = useState("");
  const adapters = useMemo(() => [...new Set(diagnostics.map((item) => item.adapter).filter(Boolean))].sort() as string[], [diagnostics]);
  const codes = useMemo(() => [...new Set(diagnostics.map((item) => item.code))].sort(), [diagnostics]);
  const visible = diagnostics.filter((item) => (
    (severity === "all" || item.severity === severity)
    && (adapter === "all" || item.adapter === adapter)
    && (code === "all" || item.code === code)
    && (!file.trim() || item.file?.toLowerCase().includes(file.trim().toLowerCase()))
  ));
  const icon = (item: Diagnostic): React.ReactElement => item.severity === "error" ? <XCircle size={18} /> : item.severity === "warning" ? <WarningCircle size={18} /> : <Info size={18} />;

  return (
    <div className="diagnostic-view">
      <div className="diagnostic-filters">
        <span>{t("diagnostics.filters")}</span>
        <label>{t("diagnostics.severity")}<select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}><option value="all">{t("diagnostics.all")}</option><option value="error">{t("diagnostics.error")}</option><option value="warning">{t("diagnostics.warning")}</option><option value="info">{t("diagnostics.info")}</option></select></label>
        <label>{t("diagnostics.adapter")}<select value={adapter} onChange={(event) => setAdapter(event.target.value)}><option value="all">{t("diagnostics.all")}</option>{adapters.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{t("diagnostics.type")}<select value={code} onChange={(event) => setCode(event.target.value)}><option value="all">{t("diagnostics.all")}</option>{codes.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{t("diagnostics.file")}<input aria-label={t("diagnostics.file")} value={file} onChange={(event) => setFile(event.target.value)} placeholder={t("diagnostics.filePlaceholder")} /></label>
      </div>
      {visible.length ? <div className="diagnostic-list">
        {visible.map((item, index) => (
          <article className={`severity-${item.severity}`} key={`${item.code}-${index}`}>
            {icon(item)}
            <span><strong>{item.code}</strong><p>{item.message}</p><code>{item.file ? `${item.file}:${item.line ?? ""}` : item.adapter}</code></span>
            <b>{t(`diagnostics.${item.severity}`)}</b>
          </article>
        ))}
      </div> : <div className="diagnostic-empty"><ShieldWarning size={24} /><p>{t("diagnostics.noResults")}</p></div>}
    </div>
  );
}
