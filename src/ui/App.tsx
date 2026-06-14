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
import { focusGraph, GraphCanvas, layoutGraph, nodeLanguage, toFlowEdge, toFlowNode } from "./graph/GraphCanvas";
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
  Overview,
  RepositoryState,
  RepositoryStatus,
  View,
} from "./types";

function confidenceQuery(level: ConfidenceLevel): string {
  if (level === "unresolved") return "&includeUnresolved=true";
  if (level === "probable") return "&includeProbable=true";
  return "";
}

function promptForView(view: View, hasSelection: boolean): { title: TranslationKey; description: TranslationKey } | undefined {
  if (view === "symbols" && !hasSelection) return { title: "graph.symbolPrompt", description: "graph.symbolPrompt.description" };
  if (view === "context") return { title: "graph.contextPrompt", description: "graph.contextPrompt.description" };
  if (view === "affected" && !hasSelection) return { title: "graph.affectedPrompt", description: "graph.affectedPrompt.description" };
  return undefined;
}

function AppBody(): React.ReactElement {
  const { t } = useI18n();
  const [overview, setOverview] = useState<Overview>();
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [view, setView] = useState<View>("architecture");
  const [rawGraph, setRawGraph] = useState<GraphResult>({ nodes: [], edges: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode>();
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge>();
  const [contextResult, setContextResult] = useState<ContextResult>();
  const [affectedResult, setAffectedResult] = useState<AffectedResult>();
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(75);
  const [confidence, setConfidence] = useState<ConfidenceLevel>("trusted");
  const [evidenceMode, setEvidenceMode] = useState<EvidenceMode>("standard");
  const [status, setStatus] = useState<RepositoryStatus>();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<ErrorNotice>();
  const [languages, setLanguages] = useState(new Set(["typescript", "rust", "framework"]));
  const [fitRequest, setFitRequest] = useState(0);
  const errorHistory = useRef<{ fingerprint: string; at: number } | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const inspectorOpen = Boolean(selectedNode);

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
      setRawGraph(await getJson<GraphResult>(`/api/architecture?maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.architecture"));
      dismissError();
    } catch (caught) {
      reportError("operation.architecture", caught);
    } finally {
      setLoading(false);
    }
  }, [maxNodes, confidence, evidenceMode, dismissError, reportError]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getJson<Overview>("/api/overview", "operation.bootstrap"),
      getJson<FileSummary[]>("/api/files", "operation.bootstrap"),
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
  }, [dismissError, reportError]);

  useEffect(() => {
    if (view === "architecture" || view === "dependencies") {
      void refreshArchitecture();
      return;
    }
    if (view === "framework") {
      setLoading(true);
      void getJson<GraphResult>(`/api/frameworks?mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.framework")
        .then((result) => { setRawGraph(result); dismissError(); })
        .catch((caught) => reportError("operation.framework", caught))
        .finally(() => setLoading(false));
      return;
    }
    if (view === "symbols" && selectedNode) {
      setLoading(true);
      void getJson<GraphResult>(`/api/symbols/${encodeURIComponent(selectedNode.id)}/neighborhood?depth=${depth}&maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.symbol")
        .then((result) => { setRawGraph(result); dismissError(); })
        .catch((caught) => reportError("operation.symbol", caught))
        .finally(() => setLoading(false));
      return;
    }
    if (view === "affected" && selectedNode) {
      setLoading(true);
      void getJson<AffectedResult>(`/api/affected?input=${encodeURIComponent(selectedNode.id)}&depth=${Math.max(depth, 3)}&maxNodes=${maxNodes}&includeTests=true&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.affected")
        .then((result) => {
          setAffectedResult(result);
          setRawGraph({ nodes: [...result.roots, ...result.directlyAffectedSymbols, ...result.transitivelyAffectedSymbols], edges: result.relationships });
          dismissError();
        })
        .catch((caught) => reportError("operation.affected", caught))
        .finally(() => setLoading(false));
    }
  }, [view, confidence, selectedNode, depth, maxNodes, evidenceMode, refreshArchitecture, dismissError, reportError]);

  useEffect(() => {
    const allowed = rawGraph.nodes.filter((node) => {
      const language = nodeLanguage(node);
      return !language || languages.has(language);
    });
    const ids = new Set(allowed.map((node) => node.id));
    const relevantEdges = rawGraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    let active = true;
    void layoutGraph(allowed.map(toFlowNode), relevantEdges.map(toFlowEdge), view === "architecture").then((layout) => {
      if (!active) return;
      setNodes(layout.nodes);
      setEdges(layout.edges);
    });
    return () => { active = false; };
  }, [rawGraph, languages, view, setNodes, setEdges]);

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
        const result = await getJson<ContextResult>(`/api/context?task=${encodeURIComponent(query)}&maxSymbols=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.context");
        setContextResult(result);
        setRawGraph({ nodes: result.symbols.map((item) => item.node), edges: result.relationships });
      } else if (view === "affected") {
        const result = await getJson<AffectedResult>(`/api/affected?input=${encodeURIComponent(query)}&depth=${Math.max(depth, 3)}&maxNodes=${maxNodes}&includeTests=true&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.affected");
        setAffectedResult(result);
        setRawGraph({ nodes: [...result.roots, ...result.directlyAffectedSymbols, ...result.transitivelyAffectedSymbols], edges: result.relationships });
        setSelectedNode(result.roots[0]);
      } else {
        const symbols = await getJson<GraphNode[]>(`/api/symbols/search?q=${encodeURIComponent(query)}&maxNodes=10`, "operation.symbol");
        const first = symbols[0];
        if (!first) throw new Error(`No symbol matches "${query}"`);
        const result = await getJson<GraphResult>(`/api/symbols/${encodeURIComponent(first.id)}/neighborhood?depth=${depth}&maxNodes=${maxNodes}&mode=${evidenceMode}${confidenceQuery(confidence)}`, "operation.symbol");
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
  }, [query, view, maxNodes, evidenceMode, confidence, depth, dismissError, reportError]);

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
    setDepth(2);
    setMaxNodes(75);
    setConfidence("trusted");
    setEvidenceMode("standard");
    setLanguages(new Set(["typescript", "rust", "framework"]));
    setQuery("");
    setSelectedEdge(undefined);
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
          syncing={syncing}
          searchInputRef={searchInput}
          onQueryChange={setQuery}
          onSearch={() => void runSearch()}
          onDepthChange={setDepth}
          onMaxNodesChange={setMaxNodes}
          onConfidenceChange={setConfidence}
          onEvidenceModeChange={setEvidenceMode}
          onSync={() => void runSync()}
          onFit={() => setFitRequest((current) => current + 1)}
          onReset={resetFilters}
        />
        <ViewHeader view={view} nodes={rawGraph.nodes.length} edges={rawGraph.edges.length}>
          {view !== "diagnostics" && <GraphLegend languages={languages} onToggle={toggleLanguage} />}
        </ViewHeader>
        <section className="canvas-wrap">
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
              onEdgeSelect={setSelectedEdge}
              onDeselect={clearSelection}
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
