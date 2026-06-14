import React from "react";
import { ArrowsClockwise, Graph, WarningCircle, X } from "@phosphor-icons/react";
import type { TranslationKey } from "../i18n/en";
import { useI18n } from "../i18n";
import type { ErrorNotice } from "../types";

export function EmptyState({ title, description }: { title: TranslationKey; description: TranslationKey }): React.ReactElement {
  const { t } = useI18n();
  return <div className="empty-state"><span><Graph size={25} /></span><strong>{t(title)}</strong><p>{t(description)}</p></div>;
}

export function LoadingState(): React.ReactElement {
  const { t } = useI18n();
  return <div className="loading-state" aria-live="polite"><ArrowsClockwise size={17} className="spin" />{t("graph.loading")}</div>;
}

export function ErrorToast({ error, onDismiss }: { error: ErrorNotice; onDismiss: () => void }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="error-toast" role="alert">
      <WarningCircle size={18} />
      <div><strong>{t("error.requestFailed", { operation: t(error.operation) })}</strong><p>{error.messageKey ? t(error.messageKey) : error.message}</p></div>
      <button aria-label={t("error.dismiss")} onClick={onDismiss}><X size={15} /></button>
    </div>
  );
}
