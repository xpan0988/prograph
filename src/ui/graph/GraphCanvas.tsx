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
import type { GraphEdge, GraphNode } from "../../core/graph/schema";
import { useI18n } from "../i18n";

const elk = new ELK();
export const graphNodeWidth = 224;
export const graphNodeHeight = 78;

export type ArchitectureLane = "entry" | "typescript" | "bridge" | "rust" | "external";

interface NodeCardData extends Record<string, unknown> {
  graphNode: GraphNode;
  lane: ArchitectureLane;
}

export function nodeLanguage(node: GraphNode): string | undefined {
  if (node.language) return node.language;
  if (node.kind === "react_component") return "typescript";
  if (node.kind === "framework_command" || node.kind === "framework_event") return "framework";
  if (node.file?.endsWith(".rs")) return "rust";
  if (node.file && /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(node.file)) return "typescript";
  return undefined;
}

export function architectureLane(node: GraphNode): ArchitectureLane {
  if (node.kind === "repository" || node.kind === "directory") return "entry";
  if (node.kind === "framework_command" || node.kind === "framework_event") return "bridge";
  if (nodeLanguage(node) === "rust") return "rust";
  if (node.kind === "external_package") return "external";
  return "typescript";
}

export function nodeAccent(node: GraphNode): string {
  const language = nodeLanguage(node);
  if (node.kind === "react_component") return "var(--color-react)";
  if (language === "rust") return "var(--color-rust)";
  if (language === "framework") return "var(--color-bridge)";
  if (node.kind === "external_package") return "var(--color-muted)";
  return "var(--color-typescript)";
}

function shortLocation(node: GraphNode): string {
  const location = node.file ?? node.qualifiedName;
  const segments = location.split("/");
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : location;
}

const GraphNodeCard = memo(function GraphNodeCard({ data }: NodeProps<Node<NodeCardData>>): React.ReactElement {
  const { t } = useI18n();
  const node = data.graphNode;
  return (
    <article className="graph-node-card" title={`${node.qualifiedName}\n${node.file ?? ""}`}>
      <Handle className="graph-handle" type="target" position={Position.Left} />
      <div className="graph-node-accent" style={{ background: nodeAccent(node) }} />
      <div className="graph-node-body">
        <div className="graph-node-heading">
          <strong>{node.name}</strong>
          <span>{t(`node.${node.kind}`)}</span>
        </div>
        <code>{shortLocation(node)}</code>
      </div>
      <Handle className="graph-handle" type="source" position={Position.Right} />
    </article>
  );
});

const nodeTypes = { graphNode: GraphNodeCard };

export function toFlowNode(node: GraphNode): Node<NodeCardData> {
  return {
    id: node.id,
    type: "graphNode",
    data: { graphNode: node, lane: architectureLane(node) },
    position: { x: 0, y: 0 },
    className: `graph-node lane-${architectureLane(node)}`,
    style: { width: graphNodeWidth, height: graphNodeHeight },
  };
}

export function toFlowEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { graphEdge: edge, labelKey: `edge.${edge.kind}` },
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

export async function layoutGraph(nodes: Node[], edges: Edge[], architecture = false): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (architecture) {
    const order = new Map<ArchitectureLane, number>([["entry", 0], ["typescript", 1], ["bridge", 2], ["rust", 3], ["external", 4]]);
    const rows = new Map<ArchitectureLane, number>();
    return {
      nodes: [...nodes]
        .sort((a, b) => String((a.data as NodeCardData).graphNode.qualifiedName).localeCompare(String((b.data as NodeCardData).graphNode.qualifiedName)))
        .map((node) => {
          const lane = (node.data as NodeCardData).lane;
          const row = rows.get(lane) ?? 0;
          rows.set(lane, row + 1);
          return { ...node, position: { x: (order.get(lane) ?? 0) * 330 + 70, y: row * 118 + 92 } };
        }),
      edges,
    };
  }
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "150",
      "elk.spacing.nodeNode": "68",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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
}

export function GraphCanvas({ nodes, edges, fitKey, fitRequest, onNodesChange, onEdgesChange, onNodeSelect, onEdgeSelect, onDeselect }: GraphCanvasProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  const { t } = useI18n();
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const displayEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    label: showEdgeLabels || String(edge.className).includes("is-selected") || String(edge.className).includes("is-incoming") || String(edge.className).includes("is-outgoing")
      ? t(edge.data?.labelKey as Parameters<typeof t>[0])
      : undefined,
  })), [edges, showEdgeLabels, t]);

  useEffect(() => {
    if (!nodes.length) return;
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.14, minZoom: 0.28, maxZoom: 0.9, duration: 220 }));
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
      timer = setTimeout(() => void fitView({ padding: 0.14, minZoom: 0.28, maxZoom: 0.9, duration: 180 }), 140);
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
        onNodeClick={(_event, node) => onNodeSelect((node.data as NodeCardData).graphNode)}
        onEdgeClick={(_event, edge) => onEdgeSelect(edge.data?.graphEdge as GraphEdge)}
        onPaneClick={onDeselect}
        onMove={(_event, viewport) => setShowEdgeLabels(viewport.zoom >= 0.82)}
        minZoom={0.15}
        maxZoom={1.8}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap pannable zoomable nodeColor={(node) => nodeAccent((node.data as NodeCardData).graphNode)} />
        <Controls showInteractive={false} />
        <Background color="var(--color-grid)" gap={28} size={1} />
      </ReactFlow>
    </div>
  );
}
