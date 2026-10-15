import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser, { type SyntaxNode } from "tree-sitter";
import { SourceCoordinates } from "./coordinates.js";
import { digest, type Provenance } from "./model.js";
import { executePasses, type FactPass } from "./passes.js";
import type { SemanticStore } from "./store.js";

export type NativeLanguage = "python" | "go" | "java" | "csharp" | "rust";
const declarations = new Set(["function_definition", "function_declaration", "method_declaration", "method_definition", "function_item", "constructor_declaration", "local_function_statement"]);
const calls = new Set(["call", "call_expression", "method_invocation", "invocation_expression", "type_conversion_expression"]);
const imports = new Set(["import_statement", "import_from_statement", "import_declaration", "import_spec", "using_directive", "use_declaration"]);
const barriers = new Set(["lambda", "lambda_expression", "func_literal", "closure_expression", "anonymous_method_expression"]);
const sourceRoles = new Map([
  ...["type_identifier", "predefined_type", "generic_type", "type"].map(x => [x, "type"] as const),
  ...["superclass", "super_interfaces", "extends_interfaces", "base_list", "trait_bounds"].map(x => [x, "inheritance"] as const),
  ...["annotation", "marker_annotation", "attribute", "decorator", "attribute_item"].map(x => [x, "annotation"] as const),
  ...["type_parameters", "type_parameter_list", "type_arguments", "type_argument_list"].map(x => [x, "generic"] as const),
]);
type Observation = { key: string; target: string; raw: string; roles: number; start: number; end: number; occurrence: string; error: boolean };
function* walk(root: SyntaxNode): Generator<SyntaxNode> { const stack = [root]; while (stack.length) { const n = stack.pop()!; yield n; for (let i = n.namedChildren.length - 1; i >= 0; i--) stack.push(n.namedChildren[i]!); } }
function callable(n: SyntaxNode): SyntaxNode | null {
  const first = n.childForFieldName("function") ?? n.childForFieldName("name") ?? n.childForFieldName("expression") ?? (n.type === "type_conversion_expression" ? n.childForFieldName("type") : null);
  if (!first) return null;
  let value: SyntaxNode = first;
  // Only the invoked name, never an argument, receiver or generic argument.
  while (["attribute", "selector_expression", "member_access_expression", "generic_function", "generic_name", "scoped_identifier", "field_expression", "generic_type", "qualified_type"].includes(value.type)) {
    const next: SyntaxNode | null | undefined = value.childForFieldName("attribute") ?? value.childForFieldName("field") ?? value.childForFieldName("name") ?? value.childForFieldName("function") ?? value.childForFieldName("type") ?? value.namedChildren.find(c => ["identifier", "field_identifier"].includes(c.type));
    if (!next || next.id === value.id) return null; value = next;
  }
  return ["identifier", "field_identifier", "type_identifier"].includes(value.type) ? value : null;
}

/** Syntax supplies roles, never a target. Every binding below requires an exact compiler occurrence. */
export async function deriveScipNative(store: SemanticStore, runs: number[], root: string, language: NativeLanguage, context: string, fingerprint: string, signal?: AbortSignal): Promise<number[]> {
  const parser = new Parser(); parser.setLanguage((await import(`tree-sitter-${language === "csharp" ? "c-sharp" : language}`)).default);
  const outputs: number[] = [];
  for (const input of runs) {
    signal?.throwIfAborted();
    const unit = store.sql("SELECT partition_key FROM sc_runs WHERE id=? AND state='sealed'").get(input) as { partition_key: string };
    const fileInput = store.sql("SELECT resource,digest FROM sc_inputs WHERE run=? AND resource LIKE 'source:%'").get(input) as { resource: string; digest: string };
    const file = fileInput.resource.slice(7); const text = await readFile(path.join(root, file), "utf8");
    if (digest(Buffer.from(text)) !== fileInput.digest) throw Error("Native pass source changed");
    const coordinates = new SourceCoordinates(file, text, true); const tree = parser.parse(text);
    if (tree.rootNode.hasError) throw Error(`Native pass syntax recovery in ${file}; no partial call guesses published`);
    const rows = store.sql(`SELECT c.key,e.key AS target,o.start_byte AS start,o.end_byte AS end,oe.key AS occurrence,f.value_json
      FROM sc_owned own CROSS JOIN sc_claims c ON c.id=own.claim CROSS JOIN sc_facts f ON f.id=c.fact
      CROSS JOIN sc_entities e ON e.id=f.subject CROSS JOIN sc_occurrences o ON o.entity=f.occurrence CROSS JOIN sc_entities oe ON oe.id=o.entity
      WHERE own.run=? AND f.predicate='scip.Occurrence' ORDER BY own.claim LIMIT 100001`).all(input) as Array<Omit<Observation, "raw" | "roles" | "error"> & { value_json: string }>;
    if (rows.length > 100000) throw Error("Native pass occurrence bound exceeded");
    const observations: Observation[] = rows.map(row => { const value = JSON.parse(row.value_json) as { rawSymbol: string; roles: number; diagnostics?: Array<{ severity: number }> }; return { ...row, raw: value.rawSymbol, roles: value.roles, error: !!value.diagnostics?.some(d => d.severity === 1) }; });
    const byRange = new Map<string, Observation[]>();
    for (const o of observations) { const key = `${o.start}:${o.end}`; byRange.set(key, [...(byRange.get(key) ?? []), o]); }
    const at = (n: SyntaxNode, definition: boolean) => (byRange.get(`${coordinates.position(n.startIndex).byte}:${coordinates.position(n.endIndex).byte}`) ?? []).filter(o => !!(o.roles & 65) === definition && !!o.raw);
    const nodes = [...walk(tree.rootNode)]; if (nodes.length > 500000) throw Error("Native pass syntax bound exceeded");
    const module = store.sql(`SELECT e.key FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_entities e ON e.id=f.subject WHERE o.run=? AND f.predicate='common.Reference' LIMIT 1`).get(input) as { key: string } | undefined;
    const owners = new Map<number, Observation>();
    for (const n of nodes) if (declarations.has(n.type)) {
      const name = n.childForFieldName("name"); if (!name) continue;
      const defs = at(name, true).filter(o => /\([^)]*\)\.$/.test(o.raw)); if (defs.length === 1) owners.set(n.id, defs[0]!);
    }
    const selector = `scip-native:${unit.partition_key}:${context}`;
    const origin = store.sql("SELECT p.json FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact JOIN sc_provenance p ON p.id=c.provenance WHERE o.run=? AND f.predicate='scip.Occurrence' LIMIT 1").get(input) as { json: string } | undefined;
    const basis: Provenance["basis"] = origin ? (JSON.parse(origin.json) as Provenance).basis : "unresolved";
    if (origin && basis !== "compiler" && basis !== "lsp") throw Error("Native declared targets require compiler/typechecker bindings");
    const provenance: Provenance = { provider: "pass:scip-native", version: "1", basis, method: "compiler-binding-and-source-role", context, inputFingerprint: fingerprint };
    const pass: FactPass = {
      id: "scip-native", version: "1", configurationFingerprint: "scip-ast-bound-static-1", reads: ["scip.Occurrence", "scip.SymbolInformation", "scip.Relationship"], writes: ["common.Import", "common.CallSite", "common.CallTarget", "scip.SourceRole"], dependencies: [],
      requiredCapabilities: ["verified-source", "compiler-bindings"], inputDomains: ["scip", language], selectorDependencies: ["producer-context", "document-source"], negativeDependencies: ["same-range-compiler-target-set"], ownershipShard: "scip-document", invalidation: "indexing-unit-and-selectors", coverageBehavior: "partial-declared-static-targets-no-runtime-dispatch", bounds: { batch: 500, maxRows: 500000 },
      execute(view, _input, output, p) {
        view.selector(output, selector, fingerprint);
        view.input(output, `source:${file}`, fileInput.digest);
        view.batch(output, () => {
          for (const n of nodes) {
            signal?.throwIfAborted();
            if (calls.has(n.type)) {
              const name = callable(n); if (!name) continue;
              const candidates = at(name, false); if (candidates.some(o => o.error)) continue;
              const refs = candidates.filter(o => /\([^)]*\)\.$/.test(o.raw)); if (refs.length !== 1) continue;
              let parent = n.parent; let owner: Observation | undefined;
              while (parent) { if (barriers.has(parent.type)) break; if (declarations.has(parent.type)) { const body = parent.childForFieldName("body") ?? parent.namedChildren.find(c => c.type === "arrow_expression_clause"); if (body && n.startIndex >= body.startIndex && n.endIndex <= body.endIndex) owner = owners.get(parent.id); break; } parent = parent.parent; }
              if (!owner) continue;
              const ref = refs[0]!; const occurrence = coordinates.range(n.startIndex, n.endIndex, context, "call"); view.addOccurrence(occurrence, Buffer.byteLength(text));
              const supports = [[{ claim: owner.key }, { claim: ref.key }, { selector, digest: fingerprint }]];
              view.addFact(output, { predicate: "common.CallSite", context, subject: owner.target, occurrence: occurrence.key, value: { language, syntax: n.type, dispatch: "declared-target-only" }, confidence: "exact", provenance: p, supports });
              view.addFact(output, { predicate: "common.CallTarget", context, subject: owner.target, object: ref.target, occurrence: occurrence.key, value: { dispatch: "declared-target-only", runtimeDispatchComplete: false }, confidence: "resolved", provenance: p, supports });
            }
            const role = imports.has(n.type) ? "import" : sourceRoles.get(n.type);
            if (!role) continue;
            // Range lookup limits each role to its actual source subtree; retain compiler evidence.
            for (const leaf of walk(n)) {
              if (leaf.namedChildCount) continue;
              for (const o of at(leaf, false)) {
                const supports = [[{ claim: o.key }, { selector, digest: fingerprint }]];
                view.addFact(output, { predicate: "scip.SourceRole", context, subject: o.target, occurrence: o.occurrence, value: { language, role, syntax: n.type }, confidence: "resolved", provenance: p, supports });
                if (role === "import" && module) view.addFact(output, { predicate: "common.Import", context, subject: module.key, object: o.target, occurrence: o.occurrence, confidence: "resolved", provenance: p, supports });
              }
            }
          }
        });
      },
    };
    const native = executePasses(store, input, unit.partition_key, provenance, selector, [pass]); outputs.push(...native);
    outputs.push(...executePasses(store, native[0]!, unit.partition_key, provenance, selector));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return outputs;
}
