/** Native-only publication reuses qualified owned groups, never arbitrary neighbours. */
import path from "node:path";
import { ADAPTER_VERSIONS } from "../analysis/state.js";
import { canonical, digest, semanticKey, TYPESCRIPT_SEMANTIC_VERSION } from "./model.js";
import { inputMatches, type RecordedInput } from "./input-check.js";
import { inventoryFromDisk, type Inventory } from "./provider-runs.js";
import type { SemanticStore } from "./store.js";

type Owner = { partition_key: string; run: number; coverage_json: string; input_fingerprint: string };
const MAX_PARTITIONS = 200000;
const MAX_INPUTS = 2000000;
export async function qualifyRetainedAnalysis(store: SemanticStore, inventory: Inventory, parent: number | undefined): Promise<number[]> {
  if (!parent) return [];
  const rows = store.sql("SELECT p.partition_key,p.run,r.coverage_json,r.input_fingerprint FROM sc_partitions p JOIN sc_runs r ON r.id=p.run WHERE p.snapshot=? LIMIT ?").all(parent, MAX_PARTITIONS + 1) as Owner[];
  if (rows.length > MAX_PARTITIONS) throw Error("Owned analysis retention exceeds partition budget");
  const versions = digest(canonical(ADAPTER_VERSIONS)), checked = new Map<string, boolean>(), retained: number[] = [], gaps = new Set<string>();
  const observed = new Map<number, RecordedInput[]>(); let inputCount = 0, priorTruncation = false;
  const inputs = (row: Owner) => {
    let result = observed.get(row.run);
    if (!result) {
      result = [];
      for (const value of store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").iterate(row.run)) {
        if (++inputCount > MAX_INPUTS) throw Error("Owned analysis retention exceeds input budget");
        result.push(value as RecordedInput);
      }
      observed.set(row.run, result);
    }
    return result;
  };
  const matches = async (group: Owner[], required: string[]) => {
    const observations = group.flatMap(inputs);
    for (const key of required) if (!observations.some(input => input.resource === key)) return false;
    for (const row of group) if (inputs(row).some(input => input.resource.startsWith("source:")) && !store.hasSourceRoot(row.run)) return false;
    for (const input of observations) {
      let eligible: boolean;
      if (input.resource === "project-inventory") eligible = input.digest === inventory.inventory;
      else if (input.resource === "source-inventory") eligible = input.digest === inventory.sourceInventory;
      else if (input.resource === "analysis-versions") eligible = input.digest === versions;
      else if (input.resource === "source-inputs-qualified") eligible = input.digest === "true";
      else if (input.resource === "source-catalogue") eligible = input.digest === rows.find(row => row.partition_key === "analysis/catalogue")?.input_fingerprint;
      else if (input.resource === "configuration:prograph") eligible = input.digest === inventory.configurationInput;
      // A TS unit's own selection fingerprint is covered by the complete current
      // project inventory/config/tool policy and its observed search inputs.
      else if (input.resource === "inventory" || input.resource.startsWith("source-root:")) eligible = true;
      else if (/^(?:source:|physical:|artifact:|tree:|probe-)/.test(input.resource) || ["environment:host", "environment:cwd"].includes(input.resource)) {
        const key = canonical(input); let cached = checked.get(key);
        if (cached === undefined) { cached = await inputMatches(input, inventory.root); checked.set(key, cached); }
        eligible = cached;
      } else eligible = false; // New logical input types require explicit qualification.
      if (!eligible) return false;
    }
    return true;
  };
  const source = rows.filter(row => row.partition_key.startsWith("analysis/"));
  if (source.length) {
    const required = ["source-inputs-qualified", "source-inventory", "analysis-versions", "configuration:prograph", `probe-realpath:${inventory.root}`];
    if (source.some(row => row.partition_key === "analysis/catalogue") && await matches(source, required)) retained.push(...source.map(row => row.run));
    else gaps.add("analysis/source-and-derived-passes");
  }
  const typescript = new Map<string, Owner[]>();
  for (const row of rows.filter(row => row.partition_key.startsWith("typescript/"))) {
    const key = row.partition_key.split("/document:")[0]!.split("/pass:")[0]!;
    const group = typescript.get(key) ?? []; group.push(row); typescript.set(key, group);
  }
  for (const [key, group] of typescript) {
    const summary = group.find(row => row.partition_key === key), coverage = summary ? JSON.parse(summary.coverage_json) as Record<string, unknown> : {};
    if (summary && coverage.mappingVersion === TYPESCRIPT_SEMANTIC_VERSION && coverage.unresolved === 0 && coverage.compilerErrors === 0 && coverage.externalImports === 0
      && await matches(group, ["project-inventory", "configuration:prograph", "analysis-versions"])) retained.push(...group.map(row => row.run));
    else gaps.add(key);
  }
  for (const row of rows.filter(row => row.partition_key.startsWith("context/"))) {
    if (JSON.parse(row.coverage_json).version === "project-discovery-2" && await matches([row], ["project-inventory", "configuration:prograph", "analysis-versions", `probe-realpath:${inventory.root}`])) retained.push(row.run);
    else gaps.add("project-discovery");
  }
  for (const row of rows.filter(row => !["analysis/", "typescript/", "context/", "scip/", "clang/"].some(prefix => row.partition_key.startsWith(prefix)))) {
    if (row.partition_key === "retention/gaps") {
      const previous = JSON.parse(row.coverage_json) as { gaps?: string[]; detailsTruncated?: boolean };
      previous.gaps?.forEach(gap => gaps.add(gap)); priorTruncation ||= !!previous.detailsTruncated;
    } else gaps.add(row.partition_key.startsWith("provider/failure:") ? "registered-provider-unavailable" : row.partition_key);
  }
  if (gaps.size || priorTruncation) {
    const names = [...gaps].sort().slice(0, 64), detailsTruncated = priorTruncation || gaps.size > names.length;
    const fingerprint = digest(canonical([inventory, versions, names, detailsTruncated])), context = semanticKey("retention-context", [inventory.root]), run = store.begin("retention/gaps", context, fingerprint);
    const subject = semanticKey("retention-gap", [context, names]);
    store.batch(run, () => {
      store.addEntity(subject, "artifact", { key: subject, kind: "retention-gap" });
      store.addFact(run, { predicate: "context.Project", context, subject, value: { status: "unavailable", domains: names, detailsTruncated, reason: "Unqualified previous analysis hidden; run analyze/sync to rebuild" }, confidence: "exact",
        provenance: { provider: "owned-retention-qualification", version: "1", basis: "inference", method: "observed-retention-gap", context, inputFingerprint: fingerprint } });
    });
    store.seal(run, { status: "unavailable", provider: "owned-retention-qualification", gaps: names, detailsTruncated }); retained.push(run);
  }
  return retained;
}

/** Cross-provider barrier after every retention decision, before the single CAS. */
export async function verifyPublicationInputs(store: SemanticStore, runs: number[], inventory: Inventory, maxFiles: number, signal?: AbortSignal) {
  const checked = new Set<string>(); let count = 0;
  for (const run of runs) for (const value of store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").iterate(run)) {
    if (++count > MAX_INPUTS) throw Error("Publication input verification exceeds input budget");
    const input = value as RecordedInput, key = canonical(input); if (checked.has(key)) continue; checked.add(key); signal?.throwIfAborted();
    if (!await inputMatches(input, inventory.root, signal)) throw Error(`Retained publication input changed: ${input.resource}`);
  }
  const final = await inventoryFromDisk(inventory.root, path.dirname(store.filename), maxFiles, signal);
  if (final.inventory !== inventory.inventory || final.sourceInventory !== inventory.sourceInventory || final.configurationInput !== inventory.configurationInput) throw Error("Repository inventory changed after retention qualification");
}
