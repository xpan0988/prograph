import path from "node:path";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import { canonical, digest, semanticKey } from "./model.js";
import type { SemanticStore } from "./store.js";
import type { PreparedProvider, ProviderRegistration } from "./provider-plan.js";
import { ownsProviderPartition } from "./provider-plan.js";
import { verifyProviderAuthorization } from "./provider-grants.js";
import { recordedDigest, recordedPath, missingInput } from "./input-check.js";
import { semanticInventory } from "./provider-runs.js";
import { discoverProjects } from "./projects.js";

function registrationPrefix(registration: ProviderRegistration): string {
  return registration.kind === "managed" ? `scip/managed-${String(registration.recipe.id)}` : String(registration.recipe.prefix);
}

/** Qualified recipes are local execution grants, not semantic evidence or arbitrary build commands. */
export async function replayProviders(store: SemanticStore, snapshot: RepositorySnapshot, parent: number | undefined, retained: number[]): Promise<{ runs: number[]; registrations: ProviderRegistration[]; outcomes: Record<string, unknown>[] }> {
  const rows = store.sql("SELECT key,kind,recipe_json,trust,version,authorization FROM sc_provider_recipes ORDER BY key LIMIT 257").all() as Array<{ key: string; kind: ProviderRegistration["kind"]; recipe_json: string; trust: string; version: string; authorization: string }>;
  if (rows.length > 256) throw Error("Provider registration catalogue exceeds budget");
  const directory = path.dirname(store.filename), root = snapshot.repository.root;
  const previous = parent ? store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=?").all(parent) as Array<{ partition_key: string; run: number }> : [];
  const selected = new Set(retained); const runs = [...retained]; const registrations: ProviderRegistration[] = []; const outcomes: Record<string, unknown>[] = [];
  for (const row of rows) {
    const registration: ProviderRegistration = { key: row.key, kind: row.kind, recipe: JSON.parse(row.recipe_json), trust: row.trust, version: row.version, authorization: row.authorization };
    const prefix = registrationPrefix(registration);
    if (previous.some(partition => selected.has(partition.run) && ownsProviderPartition(prefix, partition.partition_key))) { outcomes.push({ provider: row.key, status: "partial", reused: true }); continue; }
    let authenticated = false;
    try {
      authenticated = await verifyProviderAuthorization(registration, root, directory);
      if (!authenticated) throw Error("Local provider execution grant unavailable or changed; explicit requalification required");
      let prepared: PreparedProvider | undefined;
      const prepare = (plan: PreparedProvider) => { if (prepared) throw Error("Provider prepared multiple publications"); if (plan.parent !== parent) throw Error("Provider snapshot parent changed during preparation"); prepared = plan; };
      if (registration.kind === "managed") {
        const { indexManagedProject } = await import("./managed-scip.js");
        await indexManagedProject(root, String(registration.recipe.configuration), directory, { prepare, authorization: registration });
      } else if (registration.kind === "rust") {
        const { indexRust } = await import("./rust.js");
        await indexRust(root, String(registration.recipe.manifest), { ...registration.recipe.options as import("./rust.js").RustOptions, prepare, authorization: registration }, directory);
      } else if (registration.kind === "clang") {
        const { indexClang } = await import("./clang.js");
        const units = discoverProjects(snapshot).units.filter(unit => ["c", "cpp"].includes(unit.language));
        let unit = units.find(candidate => candidate.key === registration.recipe.unitKey);
        if (!unit) {
          const candidates = units.filter(candidate => candidate.sources[0] === registration.recipe.source && candidate.project.split("#")[0] === registration.recipe.database);
          if (candidates.length !== 1) throw Error("Compilation variant selector is missing or ambiguous; explicit requalification required");
          unit = candidates[0]!;
        }
        await indexClang(root, unit.key, directory, { prepare, authorization: registration });
      } else throw Error("Unsupported registered provider kind");
      if (!prepared) throw Error("Provider did not seal a prepared result");
      const plan = prepared as PreparedProvider;
      runs.push(...plan.runs); registrations.push(plan.registration); outcomes.push({ provider: row.key, status: "partial", reexecuted: true });
    } catch (error) {
      // Never retain stale precise conclusions after an unavailable compiler. The gap
      // is an owned observation; restoring a dependency must make it stale/retryable.
      const reason = String(error).slice(0, 512), context = semanticKey("provider-gap", [snapshot.repository.identity, row.key]);
      const fingerprint = digest(canonical([semanticInventory(snapshot), row.key, row.version, reason]));
      const run = store.begin(`provider/failure:${row.key}`, context, fingerprint);
      const subject = semanticKey("provider-registration", [snapshot.repository.identity, row.key]);
      store.batch(run, () => {
        store.addEntity(subject, "artifact", { key: subject, kind: "provider-coverage" });
        store.addFact(run, { predicate: "context.Project", context, subject, value: { provider: row.key, status: "unavailable", reason, definitions: "unavailable", references: "unavailable", calls: "unavailable" }, confidence: "exact", provenance: { provider: "registered-provider-orchestrator", version: "1", basis: "inference", method: "observed-execution-gap", context, inputFingerprint: fingerprint } });
      });
      const resources = new Set<string>();
      if (authenticated && typeof registration.recipe.configuration === "string") resources.add(`physical:${registration.recipe.configuration}`);
      for (const partition of authenticated ? previous.filter(partition => ownsProviderPartition(prefix, partition.partition_key) || partition.partition_key === `provider/failure:${row.key}`) : []) {
        for (const input of store.sql("SELECT resource FROM sc_inputs WHERE run=?").all(partition.run) as Array<{ resource: string }>) {
          if (input.resource === "environment:host") { resources.add(input.resource); continue; }
          const file = recordedPath(input.resource) ?? (/^(?:physical|tree):/.test(input.resource) ? input.resource.slice(input.resource.indexOf(":") + 1) : undefined);
          if (file && file !== directory && !file.startsWith(`${directory}${path.sep}`)) resources.add(input.resource);
        }
      }
      for (const resource of resources) {
        try { const hash = await recordedDigest(resource, root); if (hash !== undefined) store.input(run, resource, hash); }
        catch (error) {
          if (missingInput(error)) { const file = recordedPath(resource) ?? resource.slice(resource.indexOf(":") + 1); store.input(run, `probe-present:${file}`, digest("false")); }
          else store.input(run, `unavailable-input:${resource}`, "unchecked");
        }
      }
      store.diagnostic(run, "registered-provider-unavailable", reason); store.seal(run, { status: "unavailable", provider: row.key, reason, retryableOnInputChange: true }); runs.push(run);
      outcomes.push({ provider: row.key, status: "unavailable", reason });
    }
  }
  return { runs, registrations, outcomes };
}
