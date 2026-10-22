/** Process-local, opt-in diagnostic boundaries. No source/graph objects are retained.
 * Observer failures cannot change indexing results. Consumers own metric sampling.
 */
export interface AnalysisDiagnostic {
  kind: "begin" | "end" | "measure";
  phase: string;
  id: number;
  atMs: number;
  counts?: Readonly<Record<string, number>>;
}
type Observer = (event: AnalysisDiagnostic) => void;
let observer: Observer | undefined;
let emitting = false;
let sequence = 0;
const noop = () => {};

export function installAnalysisDiagnostics(next: Observer): () => void {
  if (observer) throw Error("Analysis diagnostics already installed");
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}
function emit(target: Observer, event: AnalysisDiagnostic): void {
  if (emitting || observer !== target) return;
  emitting = true;
  try { target(event); } catch { /* Diagnostics never participate in publication. */ }
  finally { emitting = false; }
}
export function beginAnalysisPhase(phase: string): (counts?: Readonly<Record<string, number>>) => void {
  const target = observer;
  if (!target) return noop;
  const id = ++sequence;
  emit(target, { kind: "begin", phase, id, atMs: performance.now() });
  let ended = false;
  return counts => {
    if (ended) return;
    ended = true;
    emit(target, { kind: "end", phase, id, atMs: performance.now(), ...(counts ? { counts } : {}) });
  };
}
export function measureAnalysisPhase(phase: string, durationMs: number): void {
  if (observer) emit(observer, { kind: "measure", phase, id: ++sequence, atMs: performance.now(), counts: { durationMs } });
}

/** Evaluate numeric collection sizes only when diagnostics are installed. */
export function measureAnalysisCollections(phase: string, counts: () => Readonly<Record<string, number>>): void {
  if (!observer) return;
  try { emit(observer, { kind: "measure", phase, id: ++sequence, atMs: performance.now(), counts: counts() }); }
  catch { /* Collection observation cannot affect analysis. */ }
}
