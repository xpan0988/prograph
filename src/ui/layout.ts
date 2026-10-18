import type { GraphResult } from "./types";

export function appShellClassName(inspectorOpen: boolean): string {
  return inspectorOpen ? "app-shell inspector-open" : "app-shell";
}

/** Bound the canvas independently of the complete, already bounded query response. */
export function limitCanvasGraph(graph: GraphResult, limit: number, centerId = graph.center?.id): GraphResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Canvas node limit must be between 1 and 500");
  if (graph.nodes.length <= limit) return graph;
  const available = new Set(graph.nodes.map(node => node.id));
  const selected = new Set<string>();
  const admit = (id: string) => { if (selected.size < limit && available.has(id)) selected.add(id); };
  if (centerId && available.has(centerId)) {
    admit(centerId);
    for (const edge of graph.edges) {
      if (edge.source === centerId) admit(edge.target);
      if (edge.target === centerId) admit(edge.source);
      if (selected.size === limit) break;
    }
  }
  // Framework payloads group commands before handlers. A plain node prefix can
  // therefore discard every binding; admit complete endpoint pairs first.
  for (const edge of graph.edges) {
    if (!available.has(edge.source) || !available.has(edge.target)) continue;
    const missing = new Set([edge.source, edge.target].filter(id => !selected.has(id)));
    if (selected.size + missing.size <= limit) { admit(edge.source); admit(edge.target); }
    if (selected.size === limit) break;
  }
  for (const node of graph.nodes) { admit(node.id); if (selected.size === limit) break; }
  return { ...graph, nodes: graph.nodes.filter(node => selected.has(node.id)),
    edges: graph.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)), truncated: true };
}

