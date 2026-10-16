import path from "node:path";
import type { RepositorySnapshot } from "../adapters/contracts.js";
import { canonical, digest, CLANG_SEMANTIC_VERSION, SCIP_SEMANTIC_VERSION, RUST_PROVIDER_VERSION, MANAGED_SCIP_VERSION } from "./model.js";
import { SemanticStore } from "./store.js";
import { digestFile } from "./inputs.js";
import { repositoryInputPaths } from "../repository/repository.js";
import Database from "better-sqlite3";
import { READABLE_SEMANTIC_SCHEMAS, SEMANTIC_FORMAT_VERSION } from "./model.js";
import { inputMatches, recordedDigest, recordedPath } from "./input-check.js";
import { qualifiedCallProjection } from "./passes.js";
const semanticInput = (file: string) => /\.(?:[cm]?tsx?|jsx?|pyi?|rs|c|h|cpp|cc|cxx|hpp|hxx|java|go|cs|proto|gql|graphql)$/.test(file) || /(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|Cargo\.(?:toml|lock)|go\.(?:mod|work|sum)|pyproject\.toml|pyrightconfig\.json|pom\.xml|build\.gradle(?:\.kts)?|compile_commands\.json|\.csproj|\.sln)$/.test(file);
const passSuffix = /\/pass:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
interface Inventory { root: string; inventory: string }
export interface RecordedInputStatus { state: "checked-recorded" | "changed" | "unavailable" | "unchecked"; checked: number; additionalChanges: number; reason?: string }

/** Recorded positive and negative dependencies supplement scanner freshness; not complete build coverage. */
export async function recordedInputStatus(filename: string, snapshot: RepositorySnapshot, scannerChanges: Set<string>): Promise<RecordedInputStatus> {
  let db: Database.Database | undefined;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
    const schema = db.prepare("SELECT value FROM sc_meta WHERE key='schema'").get() as { value: string } | undefined;
    const format = db.prepare("SELECT value FROM sc_meta WHERE key='format'").get() as { value: string } | undefined;
    if (format?.value !== String(SEMANTIC_FORMAT_VERSION) || !(READABLE_SEMANTIC_SCHEMAS as readonly string[]).includes(schema?.value ?? "")) throw Error("Unsupported semantic format/schema");
    const active = db.prepare("SELECT value FROM sc_meta WHERE key='active'").get() as { value: string } | undefined;
    if (!active) return { state: "unavailable", checked: 0, additionalChanges: 0, reason: "No published semantic snapshot" };
    if (!Number.isSafeInteger(Number(active.value)) || !db.prepare("SELECT 1 FROM sc_snapshots WHERE id=?").get(Number(active.value))) return { state: "unavailable", checked: 0, additionalChanges: 0, reason: "Published semantic snapshot is invalid" };
    const inputs = db.prepare("SELECT DISTINCT i.resource,i.digest FROM sc_partitions p JOIN sc_inputs i ON i.run=p.run WHERE p.snapshot=? LIMIT 100001").all(Number(active.value)) as Array<{ resource: string; digest: string }>;
    if (inputs.length > 100000) return { state: "unchecked", checked: 0, additionalChanges: 0, reason: "Recorded dependency catalogue exceeds status budget" };
    let checked = 0; let changed = false; let additionalChanges = 0;
    for (const input of inputs) {
      const file = input.resource.startsWith("source:") ? path.join(snapshot.repository.root, input.resource.slice(7)) : input.resource.startsWith("physical:") || input.resource.startsWith("artifact:") ? input.resource.slice(9) : undefined;
      if (input.resource.startsWith("tree:") || input.resource.startsWith("probe-")) {
        checked++;
        if (!await inputMatches(input, snapshot.repository.root)) {
          changed = true; const observed = recordedPath(input.resource);
          if (!observed || !scannerChanges.has(path.relative(snapshot.repository.root, observed).split(path.sep).join("/"))) additionalChanges++;
        }
        continue;
      }
      if (!file) continue;
      const relative = path.relative(snapshot.repository.root, file).split(path.sep).join("/");
      const text = snapshot.fileContents.get(relative); let matches = false;
      try { matches = (text !== undefined ? digest(text) : await digestFile(file)) === input.digest; } catch { /* Missing inputs invalidate their recorded assertions. */ }
      checked++;
      if (!matches) { changed = true; if (!scannerChanges.has(relative)) additionalChanges++; }
    }
    return { state: changed ? "changed" : "checked-recorded", checked, additionalChanges };
  } catch (error) { return { state: "unavailable", checked: 0, additionalChanges: 0, reason: String(error).slice(0, 160) }; }
  finally { db?.close(); }
}

export async function inventoryFromDisk(root: string, index: string, maxFiles: number, signal?: AbortSignal): Promise<Inventory> {
  const paths = (await repositoryInputPaths(root, index, maxFiles)).filter(semanticInput);
  const pairs: string[][] = [];
  for (const file of paths) { signal?.throwIfAborted(); pairs.push([file, await digestFile(path.join(root, file), 10 * 1024 ** 3, signal)]); }
  return { root, inventory: digest(canonical(pairs.sort())) };
}

/** Conservative negative dependency: source/config additions also invalidate imported artifact/TU groups. */
export function semanticInventory(snapshot: RepositorySnapshot): string {
  const relevant = [...snapshot.fileContents].filter(([file]) => semanticInput(file));
  return digest(canonical(relevant.map(([file, text]) => [file, digest(text)]).sort()));
}
export async function retainProviders(store: SemanticStore, snapshot: RepositorySnapshot | Inventory, parent: number | undefined, exclude?: string): Promise<number[]> {
  if (!parent) return [];
  const inventory = "inventory" in snapshot ? snapshot.inventory : semanticInventory(snapshot);
  const root = "root" in snapshot ? snapshot.root : snapshot.repository.root;
  const rows = store.sql("SELECT partition_key,run FROM sc_partitions WHERE snapshot=?").all(parent) as Array<{ partition_key: string; run: number }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.partition_key.startsWith("scip/") ? row.partition_key.split("/").slice(0, 2).join("/") : row.partition_key.startsWith("clang/") ? row.partition_key.replace(passSuffix, "") : undefined;
    if (!key || key === exclude) continue; const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const retained: number[] = []; const checked = new Map<string, boolean>();
  for (const group of groups.values()) {
    let eligible = true; let hasInventory = false;
    for (const row of group) {
      if (!passSuffix.test(row.partition_key)) {
        const run = store.sql("SELECT coverage_json FROM sc_runs WHERE id=?").get(row.run) as { coverage_json: string };
        const coverage = JSON.parse(run.coverage_json) as { mappingVersion?: string; executionVersion?: string };
        if (coverage.mappingVersion !== (row.partition_key.startsWith("clang/") ? CLANG_SEMANTIC_VERSION : SCIP_SEMANTIC_VERSION) || coverage.executionVersion && ![RUST_PROVIDER_VERSION, MANAGED_SCIP_VERSION].includes(coverage.executionVersion)) eligible = false;
      }
      const inputs = store.sql("SELECT resource,digest FROM sc_inputs WHERE run=?").all(row.run) as Array<{ resource: string; digest: string }>;
      for (const input of inputs) {
        if (input.resource === "project-inventory") { hasInventory = true; if (input.digest !== inventory) eligible = false; continue; }
        const key = canonical(input); let matches = checked.get(key);
        if (matches === undefined) {
          try { const actual = await recordedDigest(input.resource, root); matches = actual === undefined || actual === input.digest; } catch { matches = false; }
          checked.set(key, matches);
        }
        if (!matches) eligible = false;
      }
    }
    if (eligible && hasInventory) {
      for (const row of group) {
        if (!row.partition_key.includes("/pass:")) retained.push(row.run);
        else if (row.partition_key.endsWith("/pass:call-summary@1")) {
          const partition = row.partition_key.replace(passSuffix, ""); const input = group.find(candidate => candidate.partition_key === `${partition}/pass:scip-native@1`) ?? group.find(candidate => candidate.partition_key === partition);
          if (!input) throw Error("Retained pass has no native owner");
          retained.push(...qualifiedCallProjection(store, input.run, partition, row.run));
        } else if (row.partition_key.endsWith("/pass:scip-native@1")) {
          const run = store.sql("SELECT coverage_json FROM sc_runs WHERE id=?").get(row.run) as { coverage_json: string };
          const coverage = JSON.parse(run.coverage_json) as Record<string, unknown>;
          if (coverage.configurationFingerprint !== "scip-ast-bound-static-1") throw Error("Retained native pass version is incompatible");
          retained.push(row.run);
        } else throw Error("Retained provider has an unrecognized pass contract");
      }
    }
  }
  return retained;
}
