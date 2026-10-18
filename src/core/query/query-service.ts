import {resolveCompatibilityDatabase} from "../semantic/authority.js";
import path from "node:path";
import { access } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Diagnostic, EdgeKind, GraphEdge, GraphNode, GraphScope, NodeKind } from "../graph/schema.js";
import { graphNodeFromRow, type NodeRow } from "../storage/sqlite.js";
import { resolveRepositoryRoot } from "../repository/repository.js";
import { CompatibilityGlobalRead } from "./compatibility-global-read.js";
import { GlobalRead, type FilePageOptions } from "./global-read.js";
import { NavigationRead, type NavigationLimits } from "./navigation.js";

export interface ScopeQuery {
  scope?: GraphScope;
}

export interface ConfidenceQuery extends ScopeQuery {
  includeProbable?: boolean;
  includeUnresolved?: boolean;
}

export interface BoundedQuery extends ConfidenceQuery {
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface SymbolSearchOptions extends ScopeQuery {
  includeUnresolved?: boolean;
}

export interface ContextQuery extends ConfidenceQuery {
  maxFiles?: number;
  maxSymbols?: number;
}

export interface AffectedQuery extends ConfidenceQuery {
  depth?: number;
  includeTests?: boolean;
  maxNodes?: number;
}

export { scopedNodes, scopedEdges, isKnowledgeNode, nodeInScope } from "./scope.js";
import { scopedNodes, scopedEdges, nodeInScope, isKnowledgeEdge, includedConfidences, scope } from "./scope.js";

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.[^.]+$/.test(file) || /(?:^|\/)__tests__(?:\/|$)/.test(file) || /(?:^|\/)tests?\/[^/]+$/.test(file);
}

export class QueryService {
  readonly database: Database.Database;
  private readonly semanticCompatibility: boolean;
  private activeRead: NavigationRead | undefined;
  private activeGlobal: CompatibilityGlobalRead | undefined;

  constructor(databasePath: string, private readonly navigationLimits: NavigationLimits = {}) {
    this.database = new Database(databasePath, { readonly: true, fileMustExist: true });
    this.semanticCompatibility=!!this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='sc_meta'").get();
  }

  close(): void {
    this.database.close();
  }

  overview(options: ScopeQuery = {}): Record<string, unknown> {
    return this.readGlobal(view => {
      const data = view.summary(scope(options)); const adapters = this.adapters();
      const repository = Object.fromEntries((this.database.prepare("SELECT key, value FROM repository_metadata").all() as Array<{ key: string; value: string }>).map(item => [item.key, item.value]));
      return { repository, ...data, adapters, scope: scope(options) };
    });
  }

  adapters(): unknown[] { return this.readNavigation(()=>this.readAdapters()); }

  private readAdapters(): unknown[] {
    const stored = this.database.prepare("SELECT CASE WHEN length(value)<=1048576 THEN value END AS value FROM schema_metadata WHERE key = ?").get("adapterMetadata") as { value: string | null } | undefined;
    if (stored?.value === null) throw Error("Adapter metadata exceeds 1 MiB");
    const metadata = JSON.parse(stored?.value ?? "{}") as Record<string, unknown>;
    const runs = this.database.prepare("SELECT adapter, detected, duration_ms AS durationMs, file_count AS fileCount, node_count AS nodeCount, edge_count AS edgeCount, diagnostic_count AS diagnosticCount FROM adapter_runs ORDER BY adapter LIMIT 101").all() as Array<{ adapter: string }>;
    if (runs.length > 100) throw Error("Adapter list exceeds 100 rows");
    return runs.map(run => ({ ...run, metadata: metadata[run.adapter] ?? {} }));
  }

  architecture(maxNodes = 100, options: ConfidenceQuery = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    return this.readGlobal(view => view.architecture(maxNodes, scope(options), options.includeUnresolved ? 2 : options.includeProbable ? 1 : 0));
  }

  files(options: ScopeQuery = {}): Array<Record<string, unknown>> {
    return this.readGlobal(view => view.files(scope(options)));
  }

  filePage(options: FilePageOptions = {}): Record<string, unknown> {
    return this.readGlobal(view => view.filePage(options));
  }

  fileDetails(file: string, options: ConfidenceQuery = {}): Record<string, unknown> {
    return this.readNavigation(read => {
      const nodes = scopedNodes([...read.fileNodes(file)], options);
      const nodeIds = nodes.map((node) => node.id);
      const edges = [...read.fileEdges(nodeIds)].filter(edge => this.navigationEdge(read, edge, options));
      return { file, nodes, dependencies: edges.filter((edge) => nodeIds.includes(edge.source)), reverseDependencies: edges.filter((edge) => nodeIds.includes(edge.target)) };
    });
  }

  searchSymbols(query: string, maxNodes = 50, options: SymbolSearchOptions = {}): GraphNode[] {
    return this.readGlobal(view => view.search(query, maxNodes, scope(options), options.includeUnresolved ?? false));
  }

  symbol(id: string): GraphNode | undefined {
    return this.readNavigation(read=>read.node(id));
  }

  callers(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    return this.directional(id, "target", maxNodes, options, ["calls", "invokes", "renders", "listens"]);
  }

  callees(id: string, maxNodes = 50, options: ConfidenceQuery = {}): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    return this.directional(id, "source", maxNodes, options, ["calls", "invokes", "renders", "emits", "uses_type"]);
  }

  private directional(id: string, direction: "source" | "target", maxNodes: number, options: ConfidenceQuery, kinds: EdgeKind[]): { symbol?: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 0 || maxNodes > 500) throw Error("Navigation maxNodes must be 0..500");
    return this.readNavigation(read => {
      const symbol = read.node(id); const edges: GraphEdge[] = [];
      if (maxNodes) for (const edge of read.edges([id], direction)) {
        if (scope(options) === "code" && !kinds.includes(edge.kind) || !this.navigationEdge(read, edge, options)) continue;
        edges.push(edge); if (edges.length === maxNodes) break;
      }
      return { ...(symbol ? { symbol } : {}), nodes: this.nodesByIds(edges.map(edge => direction === "target" ? edge.source : edge.target)), edges };
    });
  }

  neighborhood(id: string, options: BoundedQuery = {}): Neighborhood {
    return this.readNavigation(read => {
      const center = read.node(id);
      if (!center) throw new Error(`Symbol not found: ${id}`);
      const depth = Math.max(0, Math.min(options.depth ?? 2, 8));
      const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 50, 500));
      const maxEdges = Math.max(1, Math.min(options.maxEdges ?? maxNodes * 4, 2000));
      const nodeIds = new Set([id]);
      const selectedEdges = new Map<string, GraphEdge>();
      let frontier = new Set([id]);
      let truncated = false;
      for (let level = 0; level < depth; level += 1) {
        const next = new Set<string>();
        for (const edge of read.edges(frontier, "both")) {
          if (options.edgeKinds?.length && !options.edgeKinds.includes(edge.kind) || !this.navigationEdge(read, edge, options)) continue;
          const candidate = frontier.has(edge.source) ? edge.target : edge.source;
          if (nodeIds.size >= maxNodes && !nodeIds.has(candidate)) {
            truncated = true;
            continue;
          }
          nodeIds.add(candidate);
          next.add(candidate);
          selectedEdges.set(edge.id, edge);
        }
        frontier = next;
      }
      let nodes = scopedNodes(this.nodesByIds([...nodeIds]), options);
      if (options.nodeKinds?.length) nodes = nodes.filter((node) => node.id === id || options.nodeKinds!.includes(node.kind));
      const finalIds = new Set(nodes.map((node) => node.id));
      const finalEdges = [...selectedEdges.values()].filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target));
      if (finalEdges.length > maxEdges) truncated = true;
      return { center, nodes, edges: finalEdges.slice(0, maxEdges), truncated };
    });
  }

  cycles(options: ConfidenceQuery = {}): Array<{ nodeIds: string[]; nodes: GraphNode[] }> {
    return this.readGlobal(view => view.cycles(scope(options), options.includeUnresolved ? 2 : options.includeProbable ? 1 : 0));
  }

  frameworkBindings(framework?: string, options: ConfidenceQuery = {}): Record<string, unknown> {
    return this.readGlobal((view, read) => {
      const result = view.framework(framework, options.includeUnresolved ? 2 : options.includeProbable ? 1 : 0);
      const ids = new Set(result.selected.map(node => node.id));
      const relatedIds = [...new Set(result.edges.flatMap(edge => [edge.source, edge.target]).filter(id => !ids.has(id)))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const nodes = scopedNodes([...result.selected, ...relatedIds.map(id => read.node(id)).filter((node): node is GraphNode => !!node)], options);
      return { framework: framework ?? "all", nodes, edges: scopedEdges(result.edges, nodes, options), truncated: result.truncated, bounded: { maxBoundaries: 200, maxEdges: 1000 } };
    });
  }

  context(task: string, options: ContextQuery = {}): Record<string, unknown> {
    return this.readGlobal((view, read) => {
    if (Buffer.byteLength(task) > 4096) throw Error("Context task exceeds 4096 bytes");
    const tokens = [...new Set(task.toLowerCase().split(/[^a-z0-9_]+/).filter(item => item.length >= 2))];
    if (tokens.length > 32) throw Error("Context task exceeds 32 distinct terms");
    const maxSymbols = Math.max(1, Math.min(options.maxSymbols ?? 50, 200));
    const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 20, 100));
    const ranked = view.contextCandidates(scope(options)).map(candidate => {
      const { name, qualified, file, degree } = candidate;
      const matched = tokens.filter(token => name.includes(token) || qualified.includes(token) || file.includes(token));
      const score = matched.reduce((total, token) => total + (name === token ? 20 : name.includes(token) ? 10 : file.includes(token) ? 6 : 4), 0) + Math.min(degree, 20) / 10;
      const reasons = [...(matched.length ? [`matched task terms: ${matched.join(", ")}`] : []), ...(degree ? [`graph degree ${degree}`] : []), ...(candidate.kind.startsWith("framework_") ? ["framework binding"] : [])];
      return { candidate, score, reasons };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.candidate.qualified_original.localeCompare(b.candidate.qualified_original)).slice(0, maxSymbols)
      .map(({ candidate, ...ranking }) => { const node = read.node(candidate.node); if (!node) throw Error("Context projection endpoint missing"); return { node, ...ranking }; });
    const selectedIds = new Set(ranked.map((item) => item.node.id));
    const trustedEdges = [...read.edges(selectedIds, "both")].filter(edge => this.navigationEdge(read, edge, options));
    const relationships = trustedEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .slice(0, maxSymbols * 3);
    const fileScores = new Map<string, { score: number; reasons: Set<string> }>();
    for (const item of ranked) {
      if (!item.node.file) continue;
      const current = fileScores.get(item.node.file) ?? { score: 0, reasons: new Set<string>() };
      current.score += item.score;
      item.reasons.forEach((reason) => current.reasons.add(reason));
      fileScores.set(item.node.file, current);
    }
    const files = [...fileScores].map(([file, value]) => ({ file, score: value.score, reasons: [...value.reasons] }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, maxFiles);
    const relatedNodeIds = [...new Set(trustedEdges.flatMap((edge) => selectedIds.has(edge.source) ? [edge.target] : selectedIds.has(edge.target) ? [edge.source] : []))];
    const relatedTests = [...new Set(relatedNodeIds.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(id => read.node(id))
      .map((node) => node?.file)
      .filter((file): file is string => typeof file === "string" && isTestFile(file)))].sort();
    return { task, files, symbols: ranked, relationships, relatedTests, bounded: { maxFiles, maxSymbols } };
    });
  }

  affected(input: string, options: AffectedQuery = {}): Record<string, unknown> {
    return this.readNavigation(read => {
      const depth = Math.max(1, Math.min(options.depth ?? 3, 8));
      const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 100, 500));
      const directSymbols = input.includes(":") ? scopedNodes([read.node(input)].filter((node): node is GraphNode => Boolean(node)), options) : [];
      const fileNodes = directSymbols.length ? [] : scopedNodes([...read.fileRoots(input)], options);
      const allRoots = directSymbols.length ? directSymbols : fileNodes.length ? fileNodes : this.searchSymbols(input, 20, options);
      if (!allRoots.length) throw new Error(`No indexed file or symbol matches: ${input}`);
      const selectedKinds = scope(options) === "code" ? new Set<EdgeKind>(["calls", "imports", "invokes", "renders", "listens", "uses_type"]) : undefined;
      const rootIds = new Set(allRoots.map((node) => node.id));
      const visited = new Set(rootIds);
      const selectedEdges: GraphEdge[] = [];
      const direct = new Set<string>();
      const transitive = new Set<string>();
      let frontier = new Set(rootIds);
      for (let level = 1; level <= depth; level += 1) {
        const next = new Set<string>();
        for (const edge of read.edges(frontier, "target")) {
          if (selectedKinds && !selectedKinds.has(edge.kind) || !this.navigationEdge(read, edge, options) || visited.has(edge.source)) continue;
          if (direct.size + transitive.size >= maxNodes) break;
          visited.add(edge.source);
          next.add(edge.source);
          selectedEdges.push(edge);
          (level === 1 ? direct : transitive).add(edge.source);
        }
        frontier = next;
      }
      const affectedNodes = this.nodesByIds([...direct, ...transitive]);
      const affectedFiles = [...new Set(affectedNodes.map((node) => node.file).filter((file): file is string => Boolean(file)))].sort();
      const relatedTests = options.includeTests ? affectedFiles.filter(isTestFile) : [];
      const frameworks = [...new Set(selectedEdges.filter((edge) => ["invokes", "listens", "emits", "registers"].includes(edge.kind)).map((edge) => edge.kind))];
      return {
        input,
        roots: allRoots.slice(0, maxNodes),
        rootCount: allRoots.length,
        directlyAffectedSymbols: this.nodesByIds([...direct]),
        transitivelyAffectedSymbols: this.nodesByIds([...transitive]),
        affectedFiles,
        relatedTests,
        frameworkBoundariesCrossed: frameworks,
        relationships: selectedEdges,
        confidenceSummary: Object.fromEntries(["exact", "resolved", "probable", "unresolved"].map((confidence) => [confidence, selectedEdges.filter((edge) => edge.confidence === confidence).length])),
        bounded: { depth, maxNodes, truncated: direct.size + transitive.size >= maxNodes || allRoots.length > maxNodes },
      };
    });
  }

  diagnostics(): Diagnostic[] {
    return this.readGlobal(view => {
      const page = view.diagnosticPage({ limit: 1000 }); if (page.truncated) throw Error("Diagnostics exceed 1000 items; use diagnostics-page / the diagnosticPage API cursor");
      return page.items as Diagnostic[];
    });
  }

  diagnosticPage(options: { limit?: number; cursor?: string } = {}): Record<string, unknown> {
    return this.readGlobal(view => view.diagnosticPage(options));
  }

  private nodesByIds(ids: string[]): GraphNode[] {
    if(!this.activeRead)return this.readNavigation(()=>this.nodesByIds(ids));
    return [...new Set(ids)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(id=>this.activeRead!.node(id)).filter((node):node is GraphNode=>!!node);
  }

  private edgesTouching(ids: string[], options: ConfidenceQuery = {}): GraphEdge[] {
    return this.readNavigation(read => [...read.edges(ids, "both")].filter(edge => this.navigationEdge(read, edge, options)));
  }

  private readNavigation<T>(execute: (read: NavigationRead) => T): T {
    if(this.activeRead)return execute(this.activeRead);
    return this.database.transaction(() => {
      const read = new NavigationRead(this.database, this.navigationLimits);
      this.activeRead=read;try{if(this.semanticCompatibility)this.activeGlobal=new CompatibilityGlobalRead(this.database,read);const result=execute(read);read.check();return result}finally{this.activeGlobal=undefined;this.activeRead=undefined}
    }).deferred();
  }

  private navigationEdge(read: NavigationRead, edge: GraphEdge, options: ConfidenceQuery): boolean {
    if (!includedConfidences(options).has(edge.confidence) || scope(options) === "code" && isKnowledgeEdge(edge)) return false;
    const source = read.node(edge.source); const target = read.node(edge.target);
    return !!source && !!target && nodeInScope(source, scope(options)) && nodeInScope(target, scope(options));
  }

  private readGlobal<T>(execute: (view: Pick<GlobalRead,keyof GlobalRead>, read: NavigationRead) => T): T {
    return this.readNavigation(read => execute(this.activeGlobal??new GlobalRead(this.database, read), read));
  }

}

export async function queryServiceForRepository(input = ".", index?: string): Promise<QueryService> {
  const root = await resolveRepositoryRoot(input);
  const requestedIndex = index ? path.resolve(index) : path.join(root, ".prograph");
  const databasePath = resolveCompatibilityDatabase(requestedIndex);
  try {
    await access(databasePath);
  } catch {
    throw new Error(`No ProGraph index found at ${databasePath}. Run "prograph analyze ${input}${index ? ` --output ${index}` : ""}" first.`);
  }
  return new QueryService(databasePath);
}
