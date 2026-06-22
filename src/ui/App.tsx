import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useEdgesState, useNodesState, type Edge, type Node } from "@xyflow/react";
import type { Diagnostic, GraphEdge, GraphNode } from "../core/graph/schema";
import { ApiError, errorFingerprint, getJson, postJson, shouldDisplayError } from "./api-client";
import { DiagnosticsView } from "./components/DiagnosticsView";
import { EmptyState, ErrorToast, LoadingState } from "./components/GraphStates";
import { Inspector } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopToolbar } from "./components/TopToolbar";
import { AffectedSummary, ArchitectureLanes, ContextSummary, GraphLegend, ViewHeader } from "./components/ViewChrome";
import { architectureLane, focusGraph, GraphCanvas, layoutGraph, nodeLanguage, toFlowEdge, toFlowNode, type DomainBlockPosition, type DomainBlockPositions } from "./graph/GraphCanvas";
import { I18nProvider, useI18n, type Locale } from "./i18n";
import type { TranslationKey } from "./i18n/en";
import { appShellClassName } from "./layout";
import type {
  AffectedResult,
  ConfidenceLevel,
  ContextResult,
  ErrorNotice,
  EvidenceMode,
  FileSummary,
  GraphResult,
  GraphMode,
  KnowledgeScope,
  Overview,
  RepositoryState,
  RepositoryStatus,
  View,
} from "./types";

const UI_PREFS_KEY = "prograph.ui.preferences";
const VIEW_VALUES: View[] = ["architecture", "dependencies", "symbols", "framework", "context", "affected", "diagnostics"];
const CONFIDENCE_VALUES: ConfidenceLevel[] = ["trusted", "probable", "unresolved"];
const EVIDENCE_VALUES: EvidenceMode[] = ["compact", "standard", "full"];
const GRAPH_MODE_VALUES: GraphMode[] = ["code", "knowledge"];
const SCOPE_VALUES: KnowledgeScope[] = ["code", "code+docs", "code+config", "code+tests", "full"];
const EDGE_KIND_VALUES = ["readable", "all", "contains", "imports", "calls", "renders", "uses_type", "invokes", "registers", "emits", "listens", "documents", "explains", "mentions", "configured_by", "configures", "exposes_api", "describes_workflow", "tests", "related_to"];
const DEFAULT_READABLE_EDGE_KINDS = new Set(["imports", "calls", "renders", "invokes", "registers", "emits", "listens"]);
const DEFAULT_LANGUAGES = ["typescript", "rust", "framework", "frontend", "api", "bridge", "core", "adapters", "cli", "tests", "external", "knowledge", "other"];

interface UiPreferences {
  view: View;
  depth: number;
  maxNodes: number;
  confidence: ConfidenceLevel;
  evidenceMode: EvidenceMode;
  graphMode: GraphMode;
  knowledgeScope: KnowledgeScope;
  edgeKind: string;
  languages: string[];
}

const defaultUiPreferences: UiPreferences = {
  view: "architecture",
  depth: 3,
  maxNodes: 75,
  confidence: "trusted",
  evidenceMode: "standard",
  graphMode: "code",
  knowledgeScope: "code",
  edgeKind: "readable",
  languages: DEFAULT_LANGUAGES,
};

function pickString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

function readUiPreferences(): UiPreferences {
  if (typeof localStorage === "undefined") return defaultUiPreferences;
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}") as Partial<UiPreferences>;
    const graphMode = pickString(parsed.graphMode, GRAPH_MODE_VALUES, defaultUiPreferences.graphMode);
    const knowledgeScope = graphMode === "code" ? "code" : pickString(parsed.knowledgeScope, SCOPE_VALUES, "full");
    return {
      view: pickString(parsed.view, VIEW_VALUES, defaultUiPreferences.view),
      depth: pickNumber(parsed.depth, [1, 2, 3, 4, 5], defaultUiPreferences.depth),
      maxNodes: pickNumber(parsed.maxNodes, [25, 50, 75, 100, 150], defaultUiPreferences.maxNodes),
      confidence: pickString(parsed.confidence, CONFIDENCE_VALUES, defaultUiPreferences.confidence),
      evidenceMode: pickString(parsed.evidenceMode, EVIDENCE_VALUES, defaultUiPreferences.evidenceMode),
      graphMode,
      knowledgeScope,
      edgeKind: pickString(parsed.edgeKind, EDGE_KIND_VALUES, defaultUiPreferences.edgeKind),
      languages: Array.isArray(parsed.languages) ? parsed.languages.filter((item): item is string => typeof item === "string") : defaultUiPreferences.languages,
    };
  } catch {
    return defaultUiPreferences;
  }
}

function confidenceQuery(level: ConfidenceLevel): string {
  if (level === "unresolved") return "&includeUnresolved=true";
  if (level === "probable") return "&includeProbable=true";
  return "";
}

function scopeQuery(scope: KnowledgeScope): string {
  return `&scope=${encodeURIComponent(scope)}`;
}

function blockLayoutStorageKey(overview?: Overview): string | undefined {
  const repositoryId = overview?.repository.identity ?? overview?.repository.root;
  return repositoryId ? `prograph.layout.blocks:${repositoryId}:code:file` : undefined;
}

function isValidBlockPosition(value: unknown): value is DomainBlockPosition {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<DomainBlockPosition>;
  return Number.isFinite(maybe.x) && Number.isFinite(maybe.y) && Math.abs(maybe.x ?? 0) < 100_000 && Math.abs(maybe.y ?? 0) < 100_000;
}

function readBlockPositions(key?: string): DomainBlockPositions {
  if (!key || typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, position]) => id.startsWith("domain:") && isValidBlockPosition(position))) as DomainBlockPositions;
  } catch {
    return {};
  }
}

function writeBlockPosition(key: string | undefined, id: string, position: DomainBlockPosition): void {
  if (!key || typeof localStorage === "undefined" || !id.startsWith("domain:") || !isValidBlockPosition(position)) return;
  try {
    const current = readBlockPositions(key);
    localStorage.setItem(key, JSON.stringify({ ...current, [id]: { x: position.x, y: position.y } }));
  } catch {
    // Manual layout state should never affect graph rendering.
  }
}

function clearBlockPositions(key?: string): void {
  if (!key || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Manual layout state should never affect graph rendering.
  }
}

function promptForView(view: View, hasSelection: boolean): { title: TranslationKey; description: TranslationKey } | undefined {
  if (view === "symbols" && !hasSelection) return { title: "graph.symbolPrompt", description: "graph.symbolPrompt.description" };
  if (view === "context") return { title: "graph.contextPrompt", description: "graph.contextPrompt.description" };
  if (view === "affected" && !hasSelection) return { title: "graph.affectedPrompt", description: "graph.affectedPrompt.description" };
  return undefined;
}

function AppBody(): React.ReactElement {
  const { t } = useI18n();
  const initialPreferences = useMemo(readUiPreferences, []);
  const [overview, setOverview] = useState<Overview>();
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [view, setView] = useState<View>(initialPreferences.view);
  const [rawGraph, setRawGraph] = useState<GraphResult>({ nodes: [], edges: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode>();
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge>();
  const [contextResult, setContextResult] = useState<ContextResult>();
  const [affectedResult, setAffectedResult] = useState<AffectedResult>();
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState(initialPreferences.depth);
  const [maxNodes, setMaxNodes] = useState(initialPreferences.maxNodes);
  const [confidence, setConfidence] = useState<ConfidenceLevel>(initialPreferences.confidence);
  const [evidenceMode, setEvidenceMode] = useState<EvidenceMode>(initialPreferences.evidenceMode);
  const [graphMode, setGraphMode] = useState<GraphMode>(initialPreferences.graphMode);
  const [knowledgeScope, setKnowledgeScope] = useState<KnowledgeScope>(initialPreferences.knowledgeScope);
  const [edgeKind, setEdgeKind] = useState(initialPreferences.edgeKind);
  const [status, setStatus] = useState<RepositoryStatus>();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<ErrorNotice>();
  const [languages, setLanguages] = useState(new Set(initialPreferences.languages));
  const [fitRequest, setFitRequest] = useState(0);
  const [layoutStorageVersion, setLayoutStorageVersion] = useState(0);
  const errorHistory = useRef<{ fingerprint: string; at: number } | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const inspectorOpen = Boolean(selectedNode);
  const layoutStorageKey = useMemo(() => blockLayoutStorageKey(overview), [overview]);
  const blockPositions = useMemo(() => readBlockPositions(layoutStorageKey), [layoutStorageKey, layoutStorageVersion]);
  const manualLayoutActive = Object.keys(blockPositions).length > 0;

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ view, depth, maxNodes, confidence, evidenceMode, graphMode, knowledgeScope, edgeKind, languages: [...languages] }));
    } catch {
      // Preferences should never affect graph rendering.
    }
  }, [view, depth, maxNodes, confidence, evidenceMode, graphMode, knowledgeScope, edgeKind, languages]);

  const dismissError = useCallback(() => setError(undefined), []);
  const reportError = useCallback((operation: TranslationKey, caught: unknown) => {
    const fingerprint = errorFingerprint(operation, caught);
    const now = Date.now();
    if (!shouldDisplayError(errorHistory.current, fingerprint, now)) return;
    errorHistory.current = { fingerprint, at: now };
    setError({
      operation,
      fingerprint,
      message: caught instanceof Error ? caught.message : String(caught),
      ...(caught instanceof ApiError && caught.returnedHtml ? { messageKey: "error.nonJson" as const } : {}),
    });
  }, []);

  const refreshArchitecture = useCallback(async () => {
    setLoading(true);
    try {
      setRawGraph(await getJson<GraphResult>(`/api/architecture?maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.architecture"));
      dismissError();
    } catch (caught) {
      reportError("operation.architecture", caught);
    } finally {
      setLoading(false);
    }
  }, [maxNodes, confidence, evidenceMode, knowledgeScope, dismissError, reportError]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getJson<Overview>(`/api/overview?scope=${encodeURIComponent(knowledgeScope)}`, "operation.bootstrap"),
      getJson<FileSummary[]>(`/api/files?scope=${encodeURIComponent(knowledgeScope)}`, "operation.bootstrap"),
      getJson<Diagnostic[]>("/api/diagnostics", "operation.bootstrap"),
      getJson<RepositoryStatus>("/api/status", "operation.bootstrap"),
    ]).then(([nextOverview, nextFiles, nextDiagnostics, nextStatus]) => {
      if (!active) return;
      setOverview(nextOverview);
      setFiles(nextFiles);
      setDiagnostics(nextDiagnostics);
      setStatus(nextStatus);
      dismissError();
    }).catch((caught) => reportError("operation.bootstrap", caught));
    return () => { active = false; };
  }, [knowledgeScope, dismissError, reportError]);

  useEffect(() => {
    if (view === "architecture" || view === "dependencies") {
      void refreshArchitecture();
      return;
    }
    if (view === "framework") {
      setLoading(true);
      void getJson<GraphResult>(`/api/frameworks?mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.framework")
        .then((result) => { setRawGraph(result); dismissError(); })
        .catch((caught) => reportError("operation.framework", caught))
        .finally(() => setLoading(false));
      return;
    }
    if (view === "symbols" && selectedNode) {
      setLoading(true);
      void getJson<GraphResult>(`/api/symbols/${encodeURIComponent(selectedNode.id)}/neighborhood?depth=${depth}&maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.symbol")
        .then((result) => { setRawGraph(result); dismissError(); })
        .catch((caught) => reportError("operation.symbol", caught))
        .finally(() => setLoading(false));
      return;
    }
    if (view === "affected" && selectedNode) {
      setLoading(true);
      void getJson<AffectedResult>(`/api/affected?input=${encodeURIComponent(selectedNode.id)}&depth=${Math.max(depth, 3)}&maxNodes=${maxNodes}&includeTests=true&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.affected")
        .then((result) => {
          setAffectedResult(result);
          setRawGraph({ nodes: [...result.roots, ...result.directlyAffectedSymbols, ...result.transitivelyAffectedSymbols], edges: result.relationships });
          dismissError();
        })
        .catch((caught) => reportError("operation.affected", caught))
        .finally(() => setLoading(false));
    }
  }, [view, confidence, selectedNode, depth, maxNodes, evidenceMode, knowledgeScope, refreshArchitecture, dismissError, reportError]);

  useEffect(() => {
    const allowed = rawGraph.nodes.filter((node) => {
      const language = nodeLanguage(node);
      const lane = architectureLane(node);
      if (view === "architecture") return languages.has(lane);
      return !language || languages.has(language) || languages.has(lane);
    });
    const ids = new Set(allowed.map((node) => node.id));
    const relevantEdges = rawGraph.edges.filter((edge) => {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return false;
      if (edgeKind === "all") return true;
      if (edgeKind === "readable") return graphMode !== "code" || DEFAULT_READABLE_EDGE_KINDS.has(edge.kind);
      return edge.kind === edgeKind;
    });
    let active = true;
    void layoutGraph(allowed.map(toFlowNode), relevantEdges.map(toFlowEdge), view === "architecture", blockPositions).then((layout) => {
      if (!active) return;
      setNodes(layout.nodes);
      setEdges(layout.edges);
    });
    return () => { active = false; };
  }, [rawGraph, languages, view, edgeKind, graphMode, blockPositions, setNodes, setEdges]);

  useEffect(() => {
    const focused = focusGraph(nodes, edges, selectedNode?.id, selectedEdge?.id);
    const nodeChanged = focused.nodes.some((node, index) => node.className !== nodes[index]?.className);
    const edgeChanged = focused.edges.some((edge, index) => edge.className !== edges[index]?.className);
    if (nodeChanged) setNodes(focused.nodes);
    if (edgeChanged) setEdges(focused.edges);
  }, [selectedNode?.id, selectedEdge?.id, nodes, edges, setNodes, setEdges]);

  useEffect(() => {
    if (selectedNode && !rawGraph.nodes.some((node) => node.id === selectedNode.id)) {
      setSelectedNode(undefined);
      setSelectedEdge(undefined);
    }
  }, [rawGraph, selectedNode]);

  const clearSelection = useCallback(() => {
    setSelectedNode(undefined);
    setSelectedEdge(undefined);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === "Escape" && selectedNode) clearSelection();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedNode, clearSelection]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      if (view === "context") {
        const result = await getJson<ContextResult>(`/api/context?task=${encodeURIComponent(query)}&maxSymbols=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.context");
        setContextResult(result);
        setRawGraph({ nodes: result.symbols.map((item) => item.node), edges: result.relationships });
      } else if (view === "affected") {
        const result = await getJson<AffectedResult>(`/api/affected?input=${encodeURIComponent(query)}&depth=${Math.max(depth, 3)}&maxNodes=${maxNodes}&includeTests=true&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.affected");
        setAffectedResult(result);
        setRawGraph({ nodes: [...result.roots, ...result.directlyAffectedSymbols, ...result.transitivelyAffectedSymbols], edges: result.relationships });
        setSelectedNode(result.roots[0]);
      } else {
        const symbols = await getJson<GraphNode[]>(`/api/symbols/search?q=${encodeURIComponent(query)}&maxNodes=10&scope=${encodeURIComponent(knowledgeScope)}`, "operation.symbol");
        const first = symbols[0];
        if (!first) throw new Error(`No symbol matches "${query}"`);
        const result = await getJson<GraphResult>(`/api/symbols/${encodeURIComponent(first.id)}/neighborhood?depth=${depth}&maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}${scopeQuery(knowledgeScope)}`, "operation.symbol");
        setRawGraph(result);
        setSelectedNode(first);
        setView("symbols");
      }
      dismissError();
    } catch (caught) {
      reportError(view === "context" ? "operation.context" : view === "affected" ? "operation.affected" : "operation.symbol", caught);
    } finally {
      setLoading(false);
    }
  }, [query, view, maxNodes, evidenceMode, confidence, depth, knowledgeScope, dismissError, reportError]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      await postJson<unknown>("/api/sync", "operation.sync");
      setStatus(await getJson<RepositoryStatus>("/api/status", "operation.sync"));
      await refreshArchitecture();
      dismissError();
    } catch (caught) {
      reportError("operation.sync", caught);
    } finally {
      setSyncing(false);
    }
  }, [refreshArchitecture, dismissError, reportError]);

  const changeView = useCallback((next: View) => {
    setView(next);
    setSelectedEdge(undefined);
    if (next === "symbols" && !selectedNode) setRawGraph({ nodes: [], edges: [] });
    if (next === "context" && !contextResult) setRawGraph({ nodes: [], edges: [] });
    if (next === "affected" && !selectedNode && !affectedResult) setRawGraph({ nodes: [], edges: [] });
  }, [contextResult, selectedNode, affectedResult]);

  const resetFilters = useCallback(() => {
    setDepth(3);
    setMaxNodes(75);
    setConfidence("trusted");
    setEvidenceMode("standard");
    setGraphMode("code");
    setKnowledgeScope("code");
    setEdgeKind("readable");
    setLanguages(new Set(DEFAULT_LANGUAGES));
    setQuery("");
    setSelectedEdge(undefined);
  }, []);

  const persistBlockPosition = useCallback((id: string, position: DomainBlockPosition) => {
    writeBlockPosition(layoutStorageKey, id, position);
    setLayoutStorageVersion((current) => current + 1);
  }, [layoutStorageKey]);

  const resetLayout = useCallback(() => {
    clearBlockPositions(layoutStorageKey);
    setLayoutStorageVersion((current) => current + 1);
    setFitRequest((current) => current + 1);
  }, [layoutStorageKey]);

  const changeGraphMode = useCallback((next: GraphMode) => {
    setGraphMode(next);
    setKnowledgeScope(next === "code" ? "code" : "full");
    setEdgeKind(next === "code" ? "readable" : "all");
    if (next === "code") setView("architecture");
  }, []);

  const changeScope = useCallback((next: KnowledgeScope) => {
    setKnowledgeScope(next);
    setGraphMode(next === "code" ? "code" : "knowledge");
    setEdgeKind(next === "code" ? "readable" : "all");
  }, []);

  const toggleLanguage = useCallback((language: string) => setLanguages((current) => {
    const next = new Set(current);
    if (next.has(language)) next.delete(language); else next.add(language);
    return next;
  }), []);

  const relatedEdges = selectedNode ? rawGraph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id) : [];
  const graphFitKey = `${view}:${inspectorOpen ? "inspector" : "full"}:${nodes.length}:${edges.length}:${nodes[0]?.id ?? ""}:${nodes.at(-1)?.id ?? ""}`;
  const prompt = promptForView(view, Boolean(selectedNode));
  const repositoryState: RepositoryState = syncing ? "syncing" : status?.state ?? "checking";

  return (
    <div className={appShellClassName(inspectorOpen)} data-inspector-open={inspectorOpen}>
      <Sidebar view={view} overview={overview} files={files} rawGraph={rawGraph} depth={depth} onViewChange={changeView} />
      <main className="workspace">
        <TopToolbar
          query={query}
          depth={depth}
          maxNodes={maxNodes}
          confidence={confidence}
          evidenceMode={evidenceMode}
          graphMode={graphMode}
          scope={knowledgeScope}
          edgeKind={edgeKind}
          syncing={syncing}
          searchInputRef={searchInput}
          onQueryChange={setQuery}
          onSearch={() => void runSearch()}
          onDepthChange={setDepth}
          onMaxNodesChange={setMaxNodes}
          onConfidenceChange={setConfidence}
          onEvidenceModeChange={setEvidenceMode}
          onGraphModeChange={changeGraphMode}
          onScopeChange={changeScope}
          onEdgeKindChange={setEdgeKind}
          onSync={() => void runSync()}
          onFit={() => setFitRequest((current) => current + 1)}
          onReset={resetFilters}
        />
        <ViewHeader view={view} nodes={rawGraph.nodes.length} edges={rawGraph.edges.length} />
        <section className="canvas-wrap">
          {view !== "diagnostics" && <GraphLegend languages={languages} onToggle={toggleLanguage} />}
          {status?.stale && <div className="stale-warning"><strong>{t("graph.stale")}</strong><span>{t("graph.stale.detail", { added: status.addedFiles.length, modified: status.modifiedFiles.length, deleted: status.deletedFiles.length })}</span></div>}
          {view === "architecture" && <ArchitectureLanes />}
          {view === "context" && contextResult && <ContextSummary result={contextResult} />}
          {view === "affected" && affectedResult && <AffectedSummary result={affectedResult} />}
          {view === "diagnostics" ? <DiagnosticsView diagnostics={diagnostics} /> : rawGraph.nodes.length ? (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              fitKey={graphFitKey}
              fitRequest={fitRequest}
              onNodeSelect={(node) => { setSelectedNode(node); setSelectedEdge(undefined); }}
              onEdgeSelect={(edge) => {
                setSelectedEdge(edge);
                setSelectedNode((current) => current ?? rawGraph.nodes.find((node) => node.id === edge.source) ?? rawGraph.nodes.find((node) => node.id === edge.target));
              }}
              onDeselect={clearSelection}
              onBlockPositionChange={persistBlockPosition}
              onResetLayout={resetLayout}
              manualLayoutActive={manualLayoutActive}
            />
          ) : !loading && prompt ? <EmptyState {...prompt} /> : !loading ? <EmptyState title="graph.empty" description="graph.empty.description" /> : null}
          {selectedNode && relatedEdges.length > 0 && <div className="selection-hint"><strong>{t("graph.selected")}</strong><span>{t("graph.selected.detail")}</span></div>}
          {loading && <LoadingState />}
          {error && <ErrorToast error={error} onDismiss={dismissError} />}
        </section>
      </main>
      {selectedNode && <Inspector node={selectedNode} nodes={rawGraph.nodes} edges={rawGraph.edges} selectedEdge={selectedEdge} onEdgeSelect={setSelectedEdge} onClose={clearSelection} />}
      <StatusBar state={repositoryState} overview={overview} diagnostics={diagnostics} graph={rawGraph} />
    </div>
  );
}

export function App({ language }: { language?: Locale } = {}): React.ReactElement {
  return <I18nProvider language={language}><ReactFlowProvider><AppBody /></ReactFlowProvider></I18nProvider>;
}
