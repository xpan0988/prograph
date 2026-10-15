import { useCallback, useEffect, useState } from "react";
import type { TranslationKey } from "./i18n/en.js";
import { getJson } from "./api-client.js";

interface Page<T> { items: T[]; nextCursor: string | null; generation: string; truncated: boolean; counts?: Record<string, number> }
/** Two bounded lists share cancellation and generation-aware navigation, never accumulated items. */
export function useIndexedPage<T>(url: string, operation: TranslationKey, onError: (operation: TranslationKey, error: unknown) => void) {
  const [controls, setControls] = useState<{ url: string; cursor: string | undefined; history: Array<string | undefined> }>({ url, cursor: undefined, history: [] });
  const [page, setPage] = useState<{ url: string; cursor: string | undefined; data: Page<T> }>(); const [loading, setLoading] = useState(false); const [revision, setRevision] = useState(0);
  const current = controls.url === url ? controls : { url, cursor: undefined, history: [] };
  const cursor = current.cursor;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void getJson<Page<T>>(`${url}${url.includes("?") ? "&" : "?"}${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ""}limit=200`, operation, controller.signal)
      .then(data => { if (!controller.signal.aborted) setPage({ url, cursor, data }); })
      .catch(error => { if (!controller.signal.aborted) onError(operation, error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, operation, cursor, revision, onError]);
  const data = page?.url === url && page.cursor === cursor ? page.data : undefined;
  const next = () => { if (!loading && data?.nextCursor) setControls({ url, cursor: data.nextCursor, history: [...current.history.slice(-999), cursor] }); };
  const previous = () => { if (!loading && current.history.length) setControls({ url, cursor: current.history.at(-1), history: current.history.slice(0, -1) }); };
  const reload = useCallback(() => { setControls({ url, cursor: undefined, history: [] }); setRevision(value => value + 1); }, [url]);
  return { items: data?.items ?? [], counts: data?.counts, loading, hasNext: !!data?.nextCursor, hasPrevious: current.history.length > 0, next, previous, reload };
}
