import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  ArrowsClockwise,
  Binoculars,
  BracketsCurly,
  CaretDown,
  ChartDonut,
  CirclesFour,
  Code,
  File,
  FlowArrow,
  Graph,
  MagnifyingGlass,
  Path,
  Pulse,
  ShieldWarning,
  TreeStructure,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Diagnostic, GraphEdge, GraphNode } from "../core/graph/schema";

interface Overview {
  repository: { root?: string; identity?: string };
  counts: { files: number; nodes: number; edges: number; diagnostics: number };
  nodesByKind: Array<{ kind: string; count: number }>;
  edgesByKind: Array<{ kind: string; count: number }>;
  adapters: Array<{ adapter: string; detected: number; durationMs: number; nodeCount: number; edgeCount: number; diagnosticCount: number }>;
}

interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
  center?: GraphNode;
}

type View = "architecture" | "dependencies" | "symbols" | "framework" | "impact" | "diagnostics";

const elk = new ELK();
const nodeWidth = 198;
const nodeHeight = 82;

function lane(node: GraphNode): string {
  if (node.kind === "repository" || node.kind === "directory") return "entry";
  if (node.kind === "framework_command" || node.kind === "framework_event") return "bridge";
  if (node.language === "rust") return "rust";
  if (node.kind === "external_package") return "external";
  return "typescript";
}

function colorFor(node: GraphNode): string {
  const colors: Record<string, string> = {
    entry: "#8d98a6",
    typescript: "#4a92ff",
    bridge: "#20b8b4",
    rust: "#f28b32",
    external: "#9da6b1",
  };
  return colors[lane(node)] ?? "#9da6b1";
}

function graphNode(node: GraphNode): Node {
  return {
    id: node.id,
    data: { label: node.name, graphNode: node },
    position: { x: 0, y: 0 },
    className: `graph-node lane-${lane(node)}`,
    style: { width: nodeWidth, height: nodeHeight, borderColor: colorFor(node) },
  };
}

function graphEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.kind,
    data: { graphEdge: edge },
    className: `graph-edge confidence-${edge.confidence}`,
    animated: edge.kind === "invokes",
  };
}

async function layoutGraph(nodes: Node[], edges: Edge[], architecture = false): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (architecture) {
    const order = new Map([["entry", 0], ["typescript", 1], ["bridge", 2], ["rust", 3], ["external", 4]]);
    const rows = new Map<string, number>();
    const positioned = [...nodes]
      .sort((a, b) => String(a.data.label).localeCompare(String(b.data.label)))
      .map((node) => {
        const nodeLane = lane(node.data.graphNode as GraphNode);
        const row = rows.get(nodeLane) ?? 0;
        rows.set(nodeLane, row + 1);
        return { ...node, position: { x: (order.get(nodeLane) ?? 0) * 300 + 55, y: row * 112 + 70 } };
      });
    return { nodes: positioned, edges };
  }
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "54",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: nodes.map((node) => ({ id: node.id, width: nodeWidth, height: nodeHeight })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map(result.children?.map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]) ?? []);
  return { nodes: nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })), edges };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

const nav: Array<{ id: View; label: string; detail: string; icon: typeof Graph }> = [
  { id: "architecture", label: "Architecture", detail: "System layers", icon: TreeStructure },
  { id: "dependencies", label: "Dependencies", detail: "File graph", icon: CirclesFour },
  { id: "symbols", label: "Symbols", detail: "Functions and types", icon: BracketsCurly },
  { id: "framework", label: "Frameworks", detail: "React and Tauri", icon: FlowArrow },
  { id: "impact", label: "Impact", detail: "Reverse reachability", icon: Pulse },
  { id: "diagnostics", label: "Diagnostics", detail: "Issues and smells", icon: ShieldWarning },
];

function nodeLabel(node: Node): React.ReactNode {
  const graphData = node.data.graphNode as GraphNode;
  return (
    <div className="node-content">
      <div className="node-title">{graphData.name}</div>
      <div className="node-kind">{graphData.kind.replaceAll("_", " ")}</div>
      <div className="node-file">{graphData.file ?? graphData.language ?? graphData.adapter}</div>
    </div>
  );
}

export function App(): React.ReactElement {
  const [overview, setOverview] = useState<Overview>();
  const [files, setFiles] = useState<Array<{ path: string; language: string; nodeCount: number }>>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [view, setView] = useState<View>("architecture");
  const [rawGraph, setRawGraph] = useState<GraphResult>({ nodes: [], edges: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode>();
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge>();
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(75);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [languages, setLanguages] = useState(new Set(["typescript", "rust", "framework"]));

  const refreshArchitecture = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await getJson<GraphResult>(`/api/architecture?maxNodes=${maxNodes}`);
      setRawGraph(result);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [maxNodes]);

  useEffect(() => {
    void Promise.all([
      getJson<Overview>("/api/overview").then(setOverview),
      getJson<Array<{ path: string; language: string; nodeCount: number }>>("/api/files").then(setFiles),
      getJson<Diagnostic[]>("/api/diagnostics").then(setDiagnostics),
      refreshArchitecture(),
    ]).catch((caught) => setError(String(caught)));
  }, [refreshArchitecture]);

  useEffect(() => {
    const allowed = rawGraph.nodes.filter((node) => !node.language || languages.has(node.language));
    const ids = new Set(allowed.map((node) => node.id));
    const relevantEdges = rawGraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    void layoutGraph(allowed.map(graphNode), relevantEdges.map(graphEdge), view === "architecture").then((layout) => {
      setNodes(layout.nodes.map((node) => ({ ...node, data: { ...node.data, label: nodeLabel(node) } })));
      setEdges(layout.edges);
    });
  }, [rawGraph, languages, view, setNodes, setEdges]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(undefined);
    try {
      const symbols = await getJson<GraphNode[]>(`/api/symbols/search?q=${encodeURIComponent(query)}&maxNodes=10`);
      const first = symbols[0];
      if (!first) throw new Error(`No symbol matches "${query}"`);
      const result = await getJson<GraphResult>(`/api/symbols/${encodeURIComponent(first.id)}/neighborhood?depth=${depth}&maxNodes=${maxNodes}`);
      setRawGraph(result);
      setSelectedNode(first);
      setView("symbols");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [query, depth, maxNodes]);

  const changeView = useCallback(async (next: View) => {
    setView(next);
    setSelectedEdge(undefined);
    if (next === "architecture" || next === "dependencies") {
      await refreshArchitecture();
      return;
    }
    if (next === "framework") {
      const result = await getJson<GraphResult>("/api/frameworks");
      setRawGraph(result);
      return;
    }
    if ((next === "impact" || next === "symbols") && selectedNode) {
      const nextDepth = next === "impact" ? Math.max(depth, 3) : depth;
      setRawGraph(await getJson<GraphResult>(`/api/symbols/${encodeURIComponent(selectedNode.id)}/neighborhood?depth=${nextDepth}&maxNodes=${maxNodes}`));
    }
  }, [refreshArchitecture, selectedNode, depth, maxNodes]);

  const filteredFiles = useMemo(() => files.slice(0, 18), [files]);
  const relationship = selectedEdge ?? rawGraph.edges.find((edge) => edge.source === selectedNode?.id || edge.target === selectedNode?.id);
  const relatedEdges = selectedNode ? rawGraph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id) : [];

  return (
    <ReactFlowProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <ChartDonut size={25} weight="duotone" />
            <div><strong>ProGraph</strong><span>Evidence Workbench</span></div>
            <b>v0.1</b>
          </div>
          <div className="repo-block">
            <span>Repository</span>
            <strong>{overview?.repository.root?.split("/").at(-1) ?? "Loading..."}</strong>
            <small>{overview?.repository.root}</small>
          </div>
          <nav>
            {nav.map((item) => {
              const Icon = item.icon;
              return (
                <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => void changeView(item.id)}>
                  <Icon size={19} /><span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </button>
              );
            })}
          </nav>
          <div className="tree">
            <div className="section-title"><span>Repository files</span><CaretDown size={14} /></div>
            {filteredFiles.map((item) => <button key={item.path} title={item.path}><File size={14} /><span>{item.path}</span><b>{item.nodeCount}</b></button>)}
          </div>
          <div className="scope-card">
            <div><span>Graph scope</span><b>{rawGraph.truncated ? "Bounded" : "Complete view"}</b></div>
            <div><span>Depth</span><strong>{depth}</strong></div>
            <div><span>Nodes</span><strong>{rawGraph.nodes.length} / {overview?.counts.nodes ?? "..."}</strong></div>
            <div><span>Edges</span><strong>{rawGraph.edges.length} / {overview?.counts.edges ?? "..."}</strong></div>
          </div>
        </aside>

        <main className="workspace">
          <header className="toolbar">
            <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <MagnifyingGlass size={19} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbols, files, or packages..." />
              <kbd>⌘ K</kbd>
            </form>
            <label>Max depth <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Max nodes <select value={maxNodes} onChange={(event) => setMaxNodes(Number(event.target.value))}>{[25, 50, 75, 100, 150].map((item) => <option key={item}>{item}</option>)}</select></label>
            <button className="rebuild" onClick={() => void refreshArchitecture()}><ArrowsClockwise size={17} /> Refresh view</button>
          </header>
          <div className="subtoolbar">
            <div><span>View</span><strong>{nav.find((item) => item.id === view)?.label}</strong><span>›</span><b>{rawGraph.nodes.length} nodes</b></div>
            <div className="legend">
              {["typescript", "rust", "framework"].map((language) => (
                <button key={language} className={languages.has(language) ? "enabled" : ""} onClick={() => setLanguages((current) => {
                  const next = new Set(current);
                  if (next.has(language)) next.delete(language); else next.add(language);
                  return next;
                })}><i className={`dot ${language}`} />{language === "framework" ? "Bridge" : language}</button>
              ))}
            </div>
          </div>
          <section className="canvas-wrap">
            {view === "architecture" && <div className="lane-labels">{["L0 Entry points", "L1 TypeScript / React", "L2 Framework bridge", "L3 Rust core", "L4 External"].map((item) => <span key={item}>{item}</span>)}</div>}
            {view === "diagnostics" ? (
              <div className="diagnostic-view">
                <div><ShieldWarning size={30} /><h2>Diagnostics</h2><p>Parser failures and uncertain relationships remain visible instead of disappearing.</p></div>
                {diagnostics.map((item, index) => <article key={`${item.code}-${index}`}><WarningCircle size={19} /><span><strong>{item.code}</strong><p>{item.message}</p><small>{item.file ? `${item.file}:${item.line ?? ""}` : item.adapter}</small></span><b className={item.severity}>{item.severity}</b></article>)}
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_event, node) => { setSelectedNode(node.data.graphNode as GraphNode); setSelectedEdge(undefined); }}
                onEdgeClick={(_event, edge) => { setSelectedEdge(edge.data?.graphEdge as GraphEdge); }}
                fitView
                minZoom={0.15}
                maxZoom={1.8}
              >
                <MiniMap pannable zoomable nodeColor={(node) => colorFor(node.data.graphNode as GraphNode)} />
                <Controls showInteractive={false} />
                <Background color="#27313c" gap={24} size={1} />
              </ReactFlow>
            )}
            {loading && <div className="loading"><ArrowsClockwise size={20} className="spin" /> Loading bounded graph...</div>}
            {error && <div className="error"><WarningCircle size={18} />{error}</div>}
          </section>
        </main>

        <aside className="inspector">
          <div className="inspector-title"><span>Evidence Inspector</span><Binoculars size={18} /></div>
          {selectedNode ? (
            <>
              <section className="selected-symbol">
                <div><Code size={22} /><span><strong>{selectedNode.name}</strong><small>{selectedNode.kind.replaceAll("_", " ")}</small></span><b>{selectedNode.language ?? selectedNode.adapter}</b></div>
                <a>{selectedNode.file ?? selectedNode.qualifiedName}{selectedNode.startLine ? `:${selectedNode.startLine}` : ""}</a>
              </section>
              <section>
                <div className="section-title"><span>Confidence</span><b>{relationship?.confidence ?? "exact"}</b></div>
                <div className="confidence">{[1, 2, 3, 4, 5, 6].map((item) => <i key={item} />)}</div>
              </section>
              <section>
                <div className="section-title"><span>Relationships</span><b>{relatedEdges.length}</b></div>
                <div className="relationship-list">
                  {relatedEdges.slice(0, 8).map((edge) => <button key={edge.id} onClick={() => setSelectedEdge(edge)}><Path size={16} /><span><strong>{edge.kind}</strong><small>{edge.source === selectedNode.id ? "outgoing" : "incoming"} · {edge.confidence}</small></span></button>)}
                </div>
              </section>
              <section>
                <div className="section-title"><span>Source evidence</span><b>{relationship?.evidence.length ?? 0}</b></div>
                {relationship?.evidence.map((item, index) => <div className="evidence" key={index}><File size={15} /><span><strong>{item.matchedSyntax ?? relationship.kind}</strong><a>{item.file}:{item.line}:{item.column}</a><small>{item.resolutionMethod ?? item.adapter}</small></span></div>)}
              </section>
              <section>
                <div className="section-title"><span>Stable graph ID</span></div>
                <code>{selectedNode.id}</code>
              </section>
            </>
          ) : (
            <div className="empty-inspector"><Graph size={30} /><strong>Select a graph node</strong><p>Inspect the same stable ID, relationship confidence, and source evidence available through the CLI.</p></div>
          )}
        </aside>

        <footer className="statusbar">
          <div><span>Adapters</span>{overview?.adapters.map((adapter) => <b key={adapter.adapter} className={adapter.detected ? "ok" : ""}>{adapter.adapter}<small>{adapter.detected ? " indexed" : " idle"}</small></b>)}</div>
          <div><span>Diagnostics</span><b className="errors">{diagnostics.filter((item) => item.severity === "error").length} errors</b><b className="warnings">{diagnostics.filter((item) => item.severity === "warning").length} warnings</b><b>{diagnostics.filter((item) => item.severity === "info").length} info</b></div>
        </footer>
      </div>
    </ReactFlowProvider>
  );
}
