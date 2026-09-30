import path from "node:path";
import YAML from "yaml";
import { parse as parseGraphql, Kind } from "graphql";
import protobuf from "protobufjs";
import type { FrameworkAdapter } from "../../../core/adapters/contracts.js";
import { GraphBuilder } from "../../../core/graph/builder.js";
import { nodeId, withEdgeId } from "../../../core/graph/identity.js";
import { boundaryNode, type BoundaryProtocol } from "../../../core/graph/boundaries.js";
import type { GraphNode } from "../../../core/graph/schema.js";

export const architectureAdapter: FrameworkAdapter = {
  name: "architecture",
  async detect(snapshot) { return snapshot.files.some(f => /\.(proto|graphql|gql)$/.test(f) || (/\.(json|ya?ml)$/.test(f) && /\b(openapi|swagger|jobs|services)\b/.test((snapshot.fileContents.get(f) ?? "").slice(0, 10000)))); },
  async analyze(snapshot, existing) {
    const graph = new GraphBuilder();
    const existingFiles = new Map(existing.nodes.filter(n => n.kind === "file").map(n => [n.file, n]));
    for (const file of snapshot.files) {
      const source = snapshot.fileContents.get(file);
      if (!source || !/\.(proto|graphql|gql|sql|tf|ya?ml|json|toml)$/.test(file)) continue;
      const fileNode: GraphNode = existingFiles.get(file) ?? { id: nodeId({ repositoryIdentity: snapshot.repository.identity, file, kind: "file", qualifiedName: file }), kind: "file", name: path.posix.basename(file), qualifiedName: file, file, adapter: "architecture", metadata: {} };
      const add = (protocol: BoundaryProtocol, namespace: string, operation: string, line?: number) => {
        const node = boundaryNode(snapshot.repository.identity, { protocol, namespace, operation }, "architecture");
        graph.addNode(fileNode); graph.addNode(node);
        graph.addEdge(withEdgeId({ source: fileNode.id, target: node.id, kind: "contains", confidence: "exact", evidence: [{ adapter: "architecture", file, ...(line ? { line } : {}), basis: "syntax", resolutionMethod: "schema-declaration" }], metadata: {} }));
      };
      try {
        if (/\.proto$/.test(file)) {
          const root = protobuf.parse(source, { keepCase: true }).root;
          const visit = (object: protobuf.ReflectionObject): void => {
            if (object instanceof protobuf.Service) for (const method of object.methodsArray) add("grpc", file, `${object.fullName.replace(/^\./, "")}/${method.name}`);
            if (object instanceof protobuf.Namespace) for (const child of object.nestedArray) visit(child);
          };
          visit(root);
        } else if (/\.(graphql|gql)$/.test(file)) {
          const document = parseGraphql(source);
          for (const definition of document.definitions) if (definition.kind === Kind.OBJECT_TYPE_DEFINITION || definition.kind === Kind.OBJECT_TYPE_EXTENSION) {
            for (const field of definition.fields ?? []) add("graphql", file, `${definition.name.value}.${field.name.value}`, field.loc?.startToken.line);
          }
        } else if (/\.(json|ya?ml)$/.test(file)) {
          // Only recognizable schema/workflow documents participate. Arbitrary config stays quiet.
          if (!/\b(openapi|swagger|jobs|services)\b/.test(source.slice(0, 10000))) continue;
          const document = /\.json$/.test(file) ? JSON.parse(source) : YAML.parse(source, { maxAliasCount: 50 });
          if (!document || typeof document !== "object") continue;
          if (document.openapi || document.swagger) {
            for (const [route, operations] of Object.entries(document.paths ?? {})) {
              if (!operations || typeof operations !== "object") continue;
              for (const method of Object.keys(operations)) if (["get", "put", "post", "delete", "patch", "head", "options", "trace"].includes(method)) add("http", file, `${method.toUpperCase()} ${route}`);
            }
          } else if ((file.includes(".github/workflows/") && document.jobs) || (/compose[^/]*\.ya?ml$/.test(file) && document.services)) {
            graph.addNode(fileNode);
            const node: GraphNode = { ...fileNode, id: nodeId({ repositoryIdentity: snapshot.repository.identity, kind: "configuration", file, qualifiedName: file }), kind: "configuration", metadata: { sourceCategory: "config", graphDomain: "knowledge", extractionMethod: "structured-document", keys: Object.keys(document.jobs ?? document.services) } };
            graph.addNode(node);
            graph.addEdge(withEdgeId({ source: fileNode.id, target: node.id, kind: "contains", confidence: "exact", evidence: [{ adapter: "architecture", file, basis: "syntax" }], metadata: {} }));
          }
        }
      } catch (error) { graph.addDiagnostic({ code: "artifact-parse-failure", severity: "warning", message: String(error), file, adapter: "architecture", metadata: {} }); }
    }
    return graph.result({ formats: ["protobuf", "openapi-json", "openapi-yaml", "graphql", "github-workflow", "compose"], limitations: ["No external schema reference fetching", "No generated client or handler matching without explicit API namespace"] });
  },
};
