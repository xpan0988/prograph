import React, { useEffect, useState } from "react";
import { useI18n } from "../i18n";

interface Candidate { key: string; name: string; qualified_name: string; variant: string; confidence?: string }
interface Evidence { occurrence: string; file: string; range: { line: number; column: number }; confidence: string; provenance: { provider: string; basis: string } }
interface Page<T> { snapshot: number; items: T[]; truncated: boolean; coverageTruncated: boolean; semanticFreshness: string; gaps: string[] }
async function page<T>(operation: string, input: string, signal: AbortSignal, snapshot?: number): Promise<Page<T>> {
  const params = new URLSearchParams({ input, limit: "5", maxBytes: "16384", ...(snapshot !== undefined ? { snapshot: String(snapshot) } : {}) });
  const result = await fetch(`/api/semantic/${operation}?${params}`, { signal });
  if (!result.ok) throw Error("Semantic index unavailable"); return await result.json() as Page<T>;
}
/** Occurrence evidence stays in the inspector; it never becomes a React Flow node set. */
export function SemanticEvidence({ name }: { name: string }): React.ReactElement {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [candidates, setCandidates] = useState<Page<Candidate> | undefined>();
  const [selected, setSelected] = useState<string>();
  const [evidence, setEvidence] = useState<{ definitions: Page<Evidence>; references: Page<Evidence> }>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setSelected(undefined); setEvidence(undefined); setCandidates(undefined); setUnavailable(false);
    void page<Candidate>("find", name, controller.signal).then(result => { if (!controller.signal.aborted) setCandidates(result); }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, [name]);
  useEffect(() => {
    if (!selected || !candidates) return;
    const controller = new AbortController(); setEvidence(undefined);
    void Promise.all([page<Evidence>("definition", selected, controller.signal, candidates.snapshot), page<Evidence>("references", selected, controller.signal, candidates.snapshot)])
      .then(([definitions, references]) => { if (!controller.signal.aborted) setEvidence({ definitions, references }); }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, [selected, candidates]);
  return <section data-testid="semantic-evidence">
    <details>
      <summary>{zh ? "语义定义与引用" : "Semantic definitions and references"}</summary>
      {unavailable ? <p className="muted-copy">{zh ? "语义索引不可用；现有图谱证据仍可使用。" : "Semantic index unavailable; existing graph evidence remains available."}</p> : candidates ? <>
        <p className="muted-copy">{zh ? "静态分析覆盖不完整；尚未验证源码新鲜度。" : "Static coverage is partial; source freshness is unchecked."} · snapshot {candidates.snapshot}</p>
        <div className="relationship-list">{candidates.items.map(candidate => <button key={candidate.key} className={selected === candidate.key ? "active" : ""} onClick={() => { setUnavailable(false); setSelected(candidate.key); }}>
          <span><strong>{candidate.name} · {candidate.confidence ?? (zh ? "无定义声明" : "no definition claim")}</strong><small>{candidate.qualified_name}</small><small>{zh ? "项目变体" : "Project variant"}: {candidate.variant.slice(-16)}</small></span>
        </button>)}</div>
        {!candidates.items.length && <p className="muted-copy">{zh ? "未找到已索引定义；这不代表代码中不存在。" : "No indexed definition found; this does not establish absence in code."}</p>}
        {candidates.truncated && <p className="muted-copy">{zh ? "候选结果已截断。" : "Candidate results truncated."}</p>}
        {evidence && ([ [zh ? "定义" : "Definitions", evidence.definitions], [zh ? "引用样本" : "Reference samples", evidence.references] ] as const).map(([label, result]) => <div key={label}>
          <strong>{label}</strong>{result.items.map(item => <article className="evidence-card" key={item.occurrence}>
            <code>{item.file}:{item.range.line}:{item.range.column}</code>
            <small>{item.confidence} · {item.provenance.provider} · {item.provenance.basis}</small>
          </article>)}{result.truncated && <p className="muted-copy">{zh ? "仅显示有界样本。" : "Showing a bounded sample."}</p>}
          {result.gaps.slice(0, 2).map(gap => <p className="muted-copy" key={gap}>{gap}</p>)}
        </div>)}
      </> : <p className="muted-copy">{zh ? "正在加载语义覆盖信息…" : "Loading semantic coverage…"}</p>}
    </details>
  </section>;
}
