import type { SourceCoordinates } from "./coordinates.js";
import { parseScipSymbol, type ScipSymbol } from "./scip-symbol.js";

/** scip-python 0.6.6 emits named lambda locals outside the standard local-id grammar.
 * Keep the entire opaque ID and the importer's document/source scope; never promote it to global.
 */
export function python066Symbol(raw: string): ScipSymbol {
  if (/^local [0-9]+\([A-Za-z_][A-Za-z0-9_]*\)$/.test(raw)) return { raw, local: true, name: raw };
  return parseScipSymbol(raw);
}
type Tab = { before: number; after: number; extra: number };
const cache = new WeakMap<SourceCoordinates, Map<number, Tab[]>>();
/** javac LineMap columns expand tabs to stops of eight; scip-javac 0.13.1 leaves encoding unspecified.
 * Convert that qualified producer convention exactly, without clamping or guessing invalid ranges.
 */
export function javac0131Offset(source: SourceCoordinates, line: number, column: number, encoding: number): number {
  if (encoding !== 2 || !Number.isSafeInteger(column) || column < 0) throw Error("Qualified javac columns require UTF-16 and tab stops of eight");
  const start = source.lineStarts[line]; if (start === undefined) throw Error("Invalid javac source line");
  let lines = cache.get(source); if (!lines) { lines = new Map(); cache.set(source, lines); }
  let tabs = lines.get(line);
  if (!tabs) {
    tabs = []; let extra = 0; const end = source.lineStarts[line + 1] ?? source.text.length;
    for (let i = start; i < end; i++) if (source.text.charCodeAt(i) === 9) { const before = i - start + extra; const after = before + 8 - before % 8; extra += after - before - 1; tabs.push({ before, after, extra }); }
    if (lines.size >= 32) lines.clear(); lines.set(line, tabs);
  }
  let low = 0; let high = tabs.length;
  while (low < high) { const middle = (low + high) >>> 1; if (tabs[middle]!.after <= column) low = middle + 1; else high = middle; }
  const next = tabs[low]; if (next && column > next.before && column < next.after) throw Error("Javac column points inside an expanded tab");
  return source.offset(line, column - (low ? tabs[low - 1]!.extra : 0), 2);
}

export function javac0131Range(source: SourceCoordinates, range: number[], encoding: number): [number, number] {
  const start = source.lineStarts[range[0]!]; if (start === undefined) throw Error("Invalid javac source line");
  let count = 0; while (source.text.charCodeAt(start + count) === 9) count++;
  // Invert ScipVisitor.lineMapRange's leading-tab subtraction on BOTH endpoints,
  // then invert LineMap's tab expansion per line. Multiline negative advisory
  // endpoints remain invalid and are diagnosed by the importer before this hook.
  const correction = count * 7;
  return [javac0131Offset(source, range[0]!, range[1]! + correction, encoding), javac0131Offset(source, range[2]!, range[3]! + correction, encoding)];
}
