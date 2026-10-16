import type { AdapterResult, RepositorySnapshot } from "../adapters/contracts.js";
import { canonical, digest, semanticKey, type FactInput, type Provenance } from "./model.js";
import { deriveBoundaries } from "./boundary-pass.js";
import { OwnedWriter } from "./owned-projection.js";
import { passContract, type PassContract } from "./passes.js";
import type { SemanticStore } from "./store.js";
type Input = Omit<FactInput, "context" | "provenance" | "supports">;
interface Recipe { key: string; input: Input; supports: string[][] }
class BoundaryRecipes extends OwnedWriter {
  readonly recipes = new Map<string, Recipe>();
  private bytes = 0;
  override fact(input: Input, supports: string[][]): string {
    supports = [...new Map(supports.map(atoms => { const value = [...new Set(atoms)].sort(); return [canonical(value), value] as const; })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const encoded = canonical({ input, supports }); const key = semanticKey("boundary-plan", encoded);
    if (!this.recipes.has(key)) {
      this.bytes += Buffer.byteLength(encoded); if (this.recipes.size >= 1000000 || this.bytes > 128 * 1024 ** 2) throw Error("Boundary recipe plan exceeds offline bound");
      this.recipes.set(key, { key, input, supports });
    }
    return key;
  }
}
/** Binding evaluation is unchanged. Recipes partition its support DAG before immutable
 * assertions are written, so an unchanged operation never has its claims rewritten.
 */
export function partitionBoundaries(store: SemanticStore, index: number, partition: string, pass: PassContract, snapshot: RepositorySnapshot,
  provenance: Provenance, fileClaims: Map<string, string>, inputNodes: Map<string, string>, input: AdapterResult, edges: Map<string, string>, sourceSelector: { key: string; digest: string }) {
  const planner = new BoundaryRecipes(store, index, snapshot, provenance, { key: "recipe-only", digest: "not-published" }, fileClaims, inputNodes);
  const metadata = deriveBoundaries(planner, input, edges); const groups = new Map<string, Recipe[]>();
  for (const recipe of planner.recipes.values()) {
    const operation = recipe.input.predicate === "boundary.Operation" ? recipe.input.subject : recipe.input.predicate === "boundary.Path" ? recipe.input.value?.operation : recipe.input.object;
    if (typeof operation !== "string") throw Error("Boundary output has no operation owner");
    const group = groups.get(operation) ?? []; group.push(recipe); groups.set(operation, group);
  }
  const contract = passContract(pass); const runs: number[] = []; let count = 0;
  for (const [operation, recipes] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const rank = (recipe: Recipe) => recipe.input.predicate === "boundary.Operation" ? 0 : recipe.input.predicate === "boundary.Path" ? 2 : 1;
    recipes.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    const fingerprint = digest(canonical([provenance.context, contract, operation, recipes]));
    const owner = `${partition}/operation:${digest(operation)}`; const selector = { key: `boundary-output:${provenance.context}:${operation}`, digest: fingerprint };
    store.selector(index, selector.key, selector.digest, [sourceSelector]);
    const cached = store.reusable(owner, provenance.context, fingerprint);
    if (cached?.coverage.configurationFingerprint === pass.configurationFingerprint && cached.coverage.version === pass.version && Number.isSafeInteger(cached.coverage.facts)) {
      count += Number(cached.coverage.facts); runs.push(cached.id);
    } else {
      const run = store.begin(owner, provenance.context, fingerprint); const resolved = new Map<string, string>();
      const output = new OwnedWriter(store, run, snapshot, { ...provenance, inputFingerprint: fingerprint }, selector, fileClaims, inputNodes);
      const claim = (key: string) => { if (!key.startsWith("sc2:boundary-plan:")) return key; const actual = resolved.get(key); if (!actual) throw Error("Boundary recipe has a forward or cross-operation dependency"); return actual; };
      for (let at = 0; at < recipes.length; at += pass.bounds.batch) store.batch(run, () => {
        for (const recipe of recipes.slice(at, at + pass.bounds.batch)) resolved.set(recipe.key, output.fact(recipe.input, recipe.supports.map(alternative => alternative.map(claim))));
      });
      const emitted = store.sql("SELECT f.predicate,COUNT(*) AS n FROM sc_owned o JOIN sc_claims c ON c.id=o.claim JOIN sc_facts f ON f.id=c.fact WHERE o.run=? GROUP BY f.predicate").all(run) as Array<{ predicate: string; n: number }>;
      if (emitted.some(row => !(pass.writes as string[]).includes(row.predicate))) throw Error("Undeclared boundary shard output");
      const facts = emitted.reduce((n, row) => n + row.n, 0); count += facts;
      store.seal(run, { ...contract, status: "partial", operation, facts }); runs.push(run);
    }
    if (count > pass.bounds.maxRows) throw Error("Boundary shards exceed declared output bound");
  }
  return { runs, metadata: { ...metadata, ownershipShards: groups.size } };
}
