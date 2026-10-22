import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginAnalysisPhase, installAnalysisDiagnostics, measureAnalysisPhase, measureAnalysisCollections, type AnalysisDiagnostic } from "../src/core/analysis/diagnostics.js";
import { analyzeRepository } from "../src/core/analysis/analyze.js";
import { semanticSnapshot } from "./oracles/semantic-snapshot.js";

let uninstall: (() => void) | undefined;
const roots: string[] = [];
afterEach(async () => { uninstall?.(); uninstall = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("diagnostics are opt-in, paired once, detachable, and reject competing observers", () => {
  const absent = beginAnalysisPhase("disabled");
  const events: AnalysisDiagnostic[] = [];
  uninstall = installAnalysisDiagnostics(event => events.push(event));
  absent();
  expect(events).toHaveLength(0);
  expect(() => installAnalysisDiagnostics(() => {})).toThrow("already installed");
  const end = beginAnalysisPhase("work"); end({ rows: 4 }); end();
  measureAnalysisPhase("publish", 2);
  expect(events.map(e => [e.kind, e.phase])).toEqual([["begin", "work"], ["end", "work"], ["measure", "publish"]]);
  expect(events[1]!.id).toBe(events[0]!.id);
  expect(events[1]!.counts).toEqual({ rows: 4 });
  uninstall(); beginAnalysisPhase("detached")();
  expect(events).toHaveLength(3);
});

test("observer failures and reentrant observations do not escape into indexing", () => {
  let calls = 0;
  uninstall = installAnalysisDiagnostics(() => { calls++; beginAnalysisPhase("recursive")(); throw Error("observer failure"); });
  expect(() => beginAnalysisPhase("outer")()).not.toThrow();
  expect(calls).toBe(2);
});

test("collection diagnostics are lazy, numeric, and cannot fail analysis", () => {
  let calls = 0;
  const counts = () => { calls++; return { rows: 3 }; };
  measureAnalysisCollections("disabled", counts); expect(calls).toBe(0);
  const events: AnalysisDiagnostic[] = [];
  uninstall = installAnalysisDiagnostics(event => events.push(event));
  measureAnalysisCollections("collections", counts);
  expect(calls).toBe(1); expect(events[0]!.counts).toEqual({ rows: 3 });
  expect(() => measureAnalysisCollections("broken", () => { throw Error("observation failed"); })).not.toThrow();
  expect(events).toHaveLength(1);
});

test("enabled diagnostics preserve complete fixture semantic and compatibility results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prograph-profile-test-")); roots.push(root);
  const repo = path.join(root, "source"), plain = path.join(root, "plain"), profiled = path.join(root, "profiled");
  await mkdir(repo);
  await writeFile(path.join(repo, "a.ts"), "export function target(){return 1} export function run(){return target()}");
  await writeFile(path.join(repo, "lib.rs"), "fn target() {} fn run() { target(); }");
  await writeFile(path.join(repo, "README.md"), "# Example\n");
  const first = await analyzeRepository(repo, { output: plain });
  const events: AnalysisDiagnostic[] = [];
  uninstall = installAnalysisDiagnostics(event => events.push(event));
  const second = await analyzeRepository(repo, { output: profiled });
  uninstall();
  expect(second.manifest.semanticCore?.status).toBe(first.manifest.semanticCore?.status);
  expect(second.manifest.semanticCore?.status).not.toBe("failed");
  expect(await semanticSnapshot(profiled)).toEqual(await semanticSnapshot(plain));
  expect(second.graph.edges).toEqual(first.graph.edges);
  expect(second.graph.diagnostics).toEqual(first.graph.diagnostics);
  expect(second.graph.nodes.filter(n => n.kind !== "repository")).toEqual(first.graph.nodes.filter(n => n.kind !== "repository"));
  expect(events.some(e => e.phase === "publication:pointer-and-commit")).toBe(true);
  const begun = events.filter(e => e.kind === "begin").map(e => e.id).sort((a, b) => a - b);
  expect(events.filter(e => e.kind === "end").map(e => e.id).sort((a, b) => a - b)).toEqual(begun);
}, 30000);
