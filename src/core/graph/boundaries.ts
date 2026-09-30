import { nodeId, withEdgeId } from "./identity.js";
import type { Confidence, GraphNode, GraphEdge, SourceEvidence } from "./schema.js";

export type BoundaryProtocol = "tauri-command" | "tauri-event" | "http" | "graphql" | "grpc" | "ffi" | "jni" | "pinvoke" | "subprocess" | "ipc" | "websocket" | "message" | "database";
export interface BoundaryIdentity { protocol: BoundaryProtocol; namespace: string; operation: string }
export interface BoundaryObservation {
  identity: BoundaryIdentity;
  participant: string;
  role: "invokes" | "implements" | "emits" | "listens";
  confidence: Confidence;
  evidence: SourceEvidence[];
}
/** Namespace is an explicit deployment/API identity, never guessed from a bare operation name. */
export function boundaryNode(repositoryIdentity: string, identity: BoundaryIdentity, adapter: string): GraphNode {
  const qualifiedName = JSON.stringify([identity.protocol, identity.namespace, identity.operation]);
  return { id: nodeId({ repositoryIdentity, kind: "boundary", qualifiedName }), kind: "boundary", name: identity.operation, qualifiedName, adapter, metadata: { boundary: identity } };
}
export function boundaryContribution(repositoryIdentity: string, observation: BoundaryObservation, adapter: string): { node: GraphNode; edge: GraphEdge } {
  const node = boundaryNode(repositoryIdentity, observation.identity, adapter);
  return { node, edge: withEdgeId({ source: observation.participant, target: node.id, kind: observation.role, confidence: observation.confidence, evidence: observation.evidence, metadata: { boundary: observation.identity } }) };
}
