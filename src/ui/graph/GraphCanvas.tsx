import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  Atom,
  BracketsCurly,
  Flask,
  GitBranch,
  HardDrives,
  Package,
  Plug,
  ShareNetwork,
  TerminalWindow,
  TreeStructure,
  type Icon,
} from "@phosphor-icons/react";
import { graphDomainOf, metadataOf, sourceCategoryOf } from "../../core/graph/metadata";
import type { GraphEdge, GraphNode } from "../../core/graph/schema";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/en";

const elk = new ELK();
export const graphNodeWidth = 210;
export const graphNodeHeight = 82;

export type ArchitectureLane = "frontend" | "api" | "bridge" | "rust" | "core" | "adapters" | "cli" | "tests" | "external" | "knowledge" | "other";

const domainOrder: ArchitectureLane[] = ["frontend", "bridge", "rust", "core", "api", "tests", "external", "cli", "adapters", "other", "knowledge"];
const domainCopy: Record<ArchitectureLane, { label: TranslationKey; icon: Icon; color: string }> = {
  frontend: { label: "domain.frontend", icon: Atom, color: "var(--color-react)" },
  api: { label: "domain.api", icon: ShareNetwork, color: "var(--color-api)" },
  bridge: { label: "domain.bridge", icon: GitBranch, color: "var(--color-bridge)" },
  rust: { label: "domain.rust", icon: BracketsCurly, color: "var(--color-rust)" },
  core: { label: "domain.core", icon: TreeStructure, color: "var(--color-core)" },
  adapters: { label: "domain.adapters", icon: Plug, color: "var(--color-adapters)" },
  cli: { label: "domain.cli", icon: TerminalWindow, color: "var(--color-cli)" },
  tests: { label: "domain.tests", icon: Flask, color: "var(--color-tests)" },
  external: { label: "domain.external", icon: Package, color: "var(--color-external)" },
  knowledge: { label: "domain.knowledge", icon: HardDrives, color: "var(--color-knowledge)" },
  other: { label: "domain.other", icon: HardDrives, color: "var(--color-muted)" },
};

const domainSlots: Record<ArchitectureLane, { x: number; y: number; minWidth: number }> = {
  frontend: { x: 160, y: 110, minWidth: 1040 },
  bridge: { x: 1320, y: 110, minWidth: 760 },
  rust: { x: 2200, y: 110, minWidth: 1040 },
  core: { x: 160, y: 650, minWidth: 1120 },
  api: { x: 1320, y: 520, minWidth: 780 },
  tests: { x: 1320, y: 900, minWidth: 1040 },
  external: { x: 2460, y: 650, minWidth: 880 },
  cli: { x: 160, y: 1320, minWidth: 760 },
  adapters: { x: 2460, y: 1140, minWidth: 880 },
  other: { x: 160, y: 1700, minWidth: 880 },
  knowledge: { x: 1320, y: 1480, minWidth: 720 },
};

const clusterPaddingX = 44;
const clusterPaddingRight = 48;
const clusterHeaderHeight = 74;
const clusterFooterPadding = 42;
const clusterColumnGap = 70;
const clusterRowGap = 56;

interface NodeCardData extends Record<string, unknown> {
  graphNode: GraphNode;
  lane: ArchitectureLane;
}

interface DomainGroupData extends Record<string, unknown> {
  lane: ArchitectureLane;
  label: TranslationKey;
  icon: Icon;
  color: string;
  count: number;
  layoutAudit?: ClusterLayoutAudit;
}

interface ClusterLayoutAudit {
  lane: ArchitectureLane;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  childCount: number;
  averageNodeWidth: number;
  averageNodeHeight: number;
  columns: number;
  rows: number;
}

export interface DomainBlockPosition {
  x: number;
  y: number;
}

export type DomainBlockPositions = Record<string, DomainBlockPosition>;

interface GraphEdgeData extends Record<string, unknown> {
  graphEdge: GraphEdge;
  labelKey: string;
  labelSuffix: string;
}

export function nodeLanguage(node: GraphNode): string | undefined {
  const sourceCategory = sourceCategoryOf(node);
  if (sourceCategory === "docs") return "docs";
  if (sourceCategory === "config") return "config";
  if (sourceCategory === "tests") return "tests";
  if (sourceCategory === "semantic") return "semantic";
  if (graphDomainOf(node) === "knowledge") return "knowledge";
  if (node.language) return node.language;
  if (node.kind === "react_component") return "typescript";
  if (node.kind === "framework_command" || node.kind === "framework_event") return "framework";
  if (node.file?.endsWith(".rs")) return "rust";
  if (node.file && /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(node.file)) return "typescript";
  return undefined;
}

export function architectureLane(node: GraphNode): ArchitectureLane {
  const path = (node.file ?? node.qualifiedName ?? "").replaceAll("\\", "/");
  const lowered = path.toLowerCase();
  const metadata = metadataOf(node);
  const framework = typeof metadata.framework === "string" ? metadata.framework.toLowerCase() : undefined;
  if (graphDomainOf(node) === "knowledge") return "knowledge";
  if (node.kind === "external_package") return "external";
  if (/(^|\/)(__tests__|tests?)\//.test(lowered) || /\.(test|spec)\.[^/]+$/.test(lowered) || sourceCategoryOf(node) === "tests") return "tests";
  if (node.kind === "react_component" || framework === "react" || lowered.endsWith(".tsx") || /(^|\/)(src\/ui|src\/frontend|src\/components|components)\//.test(lowered)) return "frontend";
  if (node.kind === "framework_command" || node.kind === "framework_event" || /(^|\/)(src\/bridge|src\/runtime|bridge|tauri|invoke|event|window)s?\//.test(lowered) || /(^|\/)(commands|events|event-bus|window|invoke)\.[tj]sx?$/.test(lowered)) return "bridge";
  if (node.language === "rust" || lowered.endsWith(".rs") || lowered.includes("src-tauri/src/")) return "rust";
  if (/(^|\/)(src\/server|src\/api|api|routes|controllers|services)\//.test(lowered) || lowered.includes("/server.")) return "api";
  if (/(^|\/)src\/adapters\//.test(lowered)) return "adapters";
  if (/(^|\/)(src\/cli|src\/mcp)\//.test(lowered)) return "cli";
  if (/(^|\/)(src\/core|src\/lib|src\/shared|src\/types|src\/utils|domain|graph|query|storage|analysis)\//.test(lowered)) return "core";
  if (node.kind === "repository" || node.kind === "directory") return "core";
  if (node.kind === "api_surface") return "api";
  if (node.kind === "cli_command") return "cli";
  if (node.kind === "test_artifact") return "tests";
  return "other";
}

export function nodeAccent(node: GraphNode): string {
  return domainCopy[architectureLane(node)].color;
}

function languageBadge(node: GraphNode): string {
  const language = nodeLanguage(node);
  if (node.kind === "external_package") return "PKG";
  if (language === "rust") return "RS";
  if (node.file?.endsWith(".tsx")) return "TSX";
  if (node.file?.endsWith(".ts")) return "TS";
  if (language === "typescript") return "TS";
  return (language ?? node.kind).slice(0, 4).toUpperCase();
}

function clusterColumns(lane: ArchitectureLane, count: number): number {
  if (count <= 1) return 1;
  if (lane === "tests" || lane === "frontend" || lane === "core" || lane === "rust") return Math.min(4, Math.max(2, Math.ceil(count / 5)));
  if (lane === "external" || lane === "adapters") return Math.min(3, Math.max(2, Math.ceil(count / 5)));
  if (lane === "bridge" || lane === "api" || lane === "cli") return Math.min(3, count);
  return Math.min(3, Math.max(1, Math.ceil(Math.sqrt(count))));
}

function layoutClusterChildren(group: Node<NodeCardData>[], columns: number): { nodes: Node[]; audit: ClusterLayoutAudit } {
  const positioned = group
    .sort((a, b) => String(a.data.graphNode.qualifiedName).localeCompare(String(b.data.graphNode.qualifiedName)))
    .map((node, index) => ({
      ...node,
      extent: "parent" as const,
      position: {
        x: clusterPaddingX + (index % columns) * (graphNodeWidth + clusterColumnGap),
        y: clusterHeaderHeight + Math.floor(index / columns) * (graphNodeHeight + clusterRowGap),
      },
    }));
  const rows = Math.ceil(group.length / columns);
  const minX = Math.min(...positioned.map((node) => node.position.x));
  const minY = Math.min(...positioned.map((node) => node.position.y));
  const maxX = Math.max(...positioned.map((node) => node.position.x + graphNodeWidth));
  const maxY = Math.max(...positioned.map((node) => node.position.y + graphNodeHeight));
  return {
    nodes: positioned,
    audit: {
      lane: group[0]?.data.lane ?? "other",
      minX,
      maxX,
      minY,
      maxY,
      width: maxX + clusterPaddingRight,
      height: maxY + clusterFooterPadding,
      childCount: group.length,
      averageNodeWidth: graphNodeWidth,
      averageNodeHeight: graphNodeHeight,
      columns,
      rows,
    },
  };
}

function emitClusterLayoutAudit(rows: ClusterLayoutAudit[]): void {
  if (typeof window === "undefined") return;
  const enabled = window.localStorage?.getItem("prograph.layoutAudit") === "1" || window.location.search.includes("layoutAudit=1");
  if (!enabled) return;
  console.table(rows.map((row) => ({
    lane: row.lane,
    minX: row.minX,
    maxX: row.maxX,
    minY: row.minY,
    maxY: row.maxY,
    width: row.width,
    height: row.height,
    childCount: row.childCount,
    averageNodeSize: `${row.averageNodeWidth}x${row.averageNodeHeight}`,
    columns: row.columns,
    rows: row.rows,
  })));
}

function dominantKind(node: GraphNode): string {
  const metadata = metadataOf(node);
  const symbols = Array.isArray(metadata.containedSymbols) ? metadata.containedSymbols : [];
  const kinds = symbols.reduce((map, item) => {
    if (item && typeof item === "object" && "kind" in item && typeof item.kind === "string") map.set(item.kind, (map.get(item.kind) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const topKind = [...kinds.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (node.kind === "external_package") return "Package";
  if (node.kind !== "file") return node.kind;
  if (topKind === "react_component") return "Component";
  if (topKind === "framework_command") return "Command";
  if (topKind === "function" || topKind === "method") return "Service";
  if (topKind === "type_alias" || topKind === "interface") return "Types";
  if (architectureLane(node) === "tests") return "Test";
  if (architectureLane(node) === "rust") return "Module";
  return "Source File";
}

const GraphNodeCard = memo(function GraphNodeCard({ data }: NodeProps<Node<NodeCardData>>): React.ReactElement {
  const node = data.graphNode;
  const metadata = metadataOf(node);
  const symbolCount = typeof metadata.symbolCount === "number" ? metadata.symbolCount : undefined;
  const incomingCount = typeof metadata.incomingCount === "number" ? metadata.incomingCount : 0;
  const outgoingCount = typeof metadata.outgoingCount === "number" ? metadata.outgoingCount : 0;
  const badges = [
    architectureLane(node) === "frontend" ? "React" : undefined,
    architectureLane(node) === "bridge" ? "Tauri" : undefined,
    architectureLane(node) === "rust" ? "Rust" : undefined,
    architectureLane(node) === "tests" ? "Test" : undefined,
  ].filter(Boolean);
  return (
    <article className="graph-node-card" title={`${node.qualifiedName}\n${node.file ?? ""}`}>
      <Handle className="graph-handle" type="target" position={Position.Left} />
      <div className="graph-node-accent" style={{ background: nodeAccent(node) }} />
      <div className="graph-node-body">
        <div className="graph-node-heading">
          <strong>{node.name}</strong>
          <span>{languageBadge(node)}</span>
        </div>
        <div className="graph-node-subline"><b>{dominantKind(node)}</b></div>
        <div className="graph-node-badges">
          {badges.map((badge) => <i key={badge}>{badge}</i>)}
          {symbolCount !== undefined && <i>{symbolCount} sym</i>}
          {(incomingCount > 0 || outgoingCount > 0) && <i>{incomingCount} in · {outgoingCount} out</i>}
        </div>
      </div>
      <Handle className="graph-handle" type="source" position={Position.Right} />
    </article>
  );
});

const DomainGroupNode = memo(function DomainGroupNode({ data }: NodeProps<Node<DomainGroupData>>): React.ReactElement {
  const { t } = useI18n();
  const IconComponent = data.icon;
  return (
    <section className={`domain-cluster domain-${data.lane}`} style={{ "--domain-color": data.color } as React.CSSProperties}>
      <header className="domain-cluster-drag-handle"><span><IconComponent size={18} weight="duotone" /></span><strong>{t(data.label)}</strong><b>{data.count}</b></header>
    </section>
  );
});

const nodeTypes = { graphNode: GraphNodeCard, domainGroup: DomainGroupNode };

export function toFlowNode(node: GraphNode): Node<NodeCardData> {
  return {
    id: node.id,
    type: "graphNode",
    data: { graphNode: node, lane: architectureLane(node) },
    position: { x: 0, y: 0 },
    className: `graph-node lane-${architectureLane(node)}`,
    draggable: false,
    style: { width: graphNodeWidth, height: graphNodeHeight },
  };
}

export function toFlowEdge(edge: GraphEdge): Edge<GraphEdgeData> {
  const metadata = metadataOf(edge);
  const count = typeof metadata.underlyingEdgeCount === "number" && metadata.underlyingEdgeCount > 1 ? ` ×${metadata.underlyingEdgeCount}` : "";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { graphEdge: edge, labelKey: `edge.${edge.kind}`, labelSuffix: count },
    className: `graph-edge edge-${edge.kind} confidence-${edge.confidence}`,
    animated: false,
    type: "smoothstep",
  };
}

export function focusGraph(nodes: Node[], edges: Edge[], selectedNodeId?: string, selectedEdgeId?: string): { nodes: Node[]; edges: Edge[] } {
  const connectedIds = new Set<string>();
  if (selectedNodeId) {
    connectedIds.add(selectedNodeId);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) connectedIds.add(edge.target);
      if (edge.target === selectedNodeId) connectedIds.add(edge.source);
    }
  }
  const hasConnections = connectedIds.size > 1;
  return {
    nodes: nodes.map((node) => ({
      ...node,
      className: [
        String(node.className ?? "").replace(/\s(?:is-selected|is-connected|is-dimmed)\b/g, ""),
        selectedNodeId && node.id === selectedNodeId ? "is-selected" : "",
        selectedNodeId && node.id !== selectedNodeId && connectedIds.has(node.id) ? "is-connected" : "",
        selectedNodeId && hasConnections && !connectedIds.has(node.id) ? "is-dimmed" : "",
      ].filter(Boolean).join(" "),
    })),
    edges: edges.map((edge) => ({
      ...edge,
      className: [
        String(edge.className ?? "").replace(/\s(?:is-selected|is-incoming|is-outgoing|is-dimmed)\b/g, ""),
        selectedEdgeId === edge.id ? "is-selected" : "",
        selectedNodeId && edge.target === selectedNodeId ? "is-incoming" : "",
        selectedNodeId && edge.source === selectedNodeId ? "is-outgoing" : "",
        selectedNodeId && hasConnections && edge.source !== selectedNodeId && edge.target !== selectedNodeId ? "is-dimmed" : "",
      ].filter(Boolean).join(" "),
    })),
  };
}

export async function layoutGraph(nodes: Node[], edges: Edge[], architecture = false, blockPositions: DomainBlockPositions = {}): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (architecture) {
    const grouped = new Map<ArchitectureLane, Node<NodeCardData>[]>();
    for (const node of nodes as Node<NodeCardData>[]) {
      const lane = node.data.lane;
      const current = grouped.get(lane) ?? [];
      current.push(node);
      grouped.set(lane, current);
    }
    const clusterNodes: Node<DomainGroupData>[] = [];
    const childNodes: Node[] = [];
    const auditRows: ClusterLayoutAudit[] = [];
    for (const lane of domainOrder) {
      const group = grouped.get(lane);
      if (!group?.length) continue;
      const columns = clusterColumns(lane, group.length);
      const { nodes: positionedNodes, audit } = layoutClusterChildren(group, columns);
      const width = Math.max(domainSlots[lane].minWidth, audit.width);
      const height = Math.max(240, audit.height);
      const slot = domainSlots[lane];
      const groupId = `domain:${lane}`;
      const layoutAudit = { ...audit, width, height };
      auditRows.push(layoutAudit);
      clusterNodes.push({
        id: groupId,
        type: "domainGroup",
        data: { lane, ...domainCopy[lane], count: group.length, layoutAudit },
        position: blockPositions[groupId] ?? { x: slot.x, y: slot.y },
        selectable: false,
        draggable: true,
        dragHandle: ".domain-cluster-drag-handle",
        className: `domain-group-node lane-${lane}`,
        style: { width, height, zIndex: -1 },
      });
      childNodes.push(...positionedNodes.map((node) => ({ ...node, parentId: groupId })));
    }
    emitClusterLayoutAudit(auditRows);
    return {
      nodes: [...clusterNodes, ...childNodes],
      edges,
    };
  }
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "220",
      "elk.layered.spacing.edgeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "96",
      "elk.spacing.edgeEdge": "28",
      "elk.spacing.edgeNode": "52",
      "elk.spacing.componentComponent": "180",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes.map((node) => ({ id: node.id, width: graphNodeWidth, height: graphNodeHeight })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map(result.children?.map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]) ?? []);
  return { nodes: nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })), edges };
}

interface GraphCanvasProps {
  nodes: Node[];
  edges: Edge[];
  fitKey: string;
  fitRequest: number;
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onDeselect: () => void;
  onBlockPositionChange?: (id: string, position: DomainBlockPosition) => void;
  onResetLayout?: () => void;
  manualLayoutActive?: boolean;
}

export function GraphCanvas({ nodes, edges, fitKey, fitRequest, onNodesChange, onEdgesChange, onNodeSelect, onEdgeSelect, onDeselect, onBlockPositionChange, onResetLayout, manualLayoutActive = false }: GraphCanvasProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  const { t } = useI18n();
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const displayEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    label: showEdgeLabels || String(edge.className).includes("is-selected") || String(edge.className).includes("is-incoming") || String(edge.className).includes("is-outgoing")
      ? `${t(edge.data?.labelKey as Parameters<typeof t>[0])}${edge.data?.labelSuffix ?? ""}`
      : undefined,
  })), [edges, showEdgeLabels, t]);

  useEffect(() => {
    if (!nodes.length) return;
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.18, minZoom: 0.2, maxZoom: 0.78, duration: 260 }));
    return () => cancelAnimationFrame(frame);
  }, [fitKey, fitRequest, fitView, nodes.length]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousWidth = 0;
    let previousHeight = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0 || (width === previousWidth && height === previousHeight)) return;
      previousWidth = width;
      previousHeight = height;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fitView({ padding: 0.18, minZoom: 0.2, maxZoom: 0.78, duration: 220 }), 140);
    });
    observer.observe(element);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitView]);

  return (
    <div className="graph-viewport" data-testid="graph-viewport" ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => {
          const graphNode = (node.data as Partial<NodeCardData>).graphNode;
          if (graphNode) onNodeSelect(graphNode);
        }}
        onEdgeClick={(_event, edge) => onEdgeSelect(edge.data?.graphEdge as GraphEdge)}
        onNodeDragStop={(_event, node) => {
          if (node.type === "domainGroup" && node.id.startsWith("domain:")) onBlockPositionChange?.(node.id, node.position);
        }}
        onPaneClick={onDeselect}
        onMove={(_event, viewport) => setShowEdgeLabels(viewport.zoom >= 0.82)}
        minZoom={0.15}
        maxZoom={1.8}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap pannable zoomable nodeColor={(node) => {
          const graphNode = (node.data as Partial<NodeCardData>).graphNode;
          return graphNode ? nodeAccent(graphNode) : "rgba(80, 92, 108, .45)";
        }} />
        <Controls showInteractive={false} />
        <Background color="var(--color-grid)" gap={28} size={1} />
      </ReactFlow>
      {onResetLayout && (
        <div className="graph-layout-actions">
          <button type="button" disabled={!manualLayoutActive} onClick={onResetLayout}>{t("graph.resetLayout")}</button>
        </div>
      )}
    </div>
  );
}
