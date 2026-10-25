import { expect, test } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonical } from "../src/core/semantic/model.js";
import { AUDIT_KEY, encodingAudit, instrumentCanonicalModule } from "../scripts/semantic-encoding-audit.mjs";

test("opt-in canonical audit leaves recursive reference bytes and argument/getter rejection order intact", async () => {
  const text = await readFile("dist/core/semantic/model.js", "utf8");
  const instrumented = await instrumentCanonicalModule(text, "dist/core/semantic/model.js");
  expect(instrumented.sites.length).toBe(3);
  const referenceBody = text.slice(text.indexOf("export function canonical"), text.indexOf("export function digest"));
  expect(instrumented.text).toContain(referenceBody);
  const directory = await mkdtemp(path.join(os.tmpdir(), "prograph-canonical-audit-"));
  const audit = encodingAudit(instrumented.sites);
  (globalThis as Record<symbol, unknown>)[AUDIT_KEY] = audit;
  try {
    const file = path.join(directory, "model.mjs"); await writeFile(file, instrumented.text.replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
    const observed = await import(/* @vite-ignore */ pathToFileURL(file).href);
    const factories = [
      () => ({ b: ["界🚀", , -0], a: 1 }),
      (log: string[]) => ({ get b() { log.push("b"); return 1; }, get a() { log.push("a"); throw TypeError("rejection"); } }),
      (log: string[]) => new Proxy({ value: undefined }, { get(target, key) { log.push(String(key)); return Reflect.get(target, key); }, ownKeys(target) { log.push("keys"); return Reflect.ownKeys(target); } }),
    ];
    const original = await import("../src/core/semantic/model.js");
    for (const factory of factories) {
      const outcome = (module: typeof original) => { const log: string[] = []; try { return { value: module.semanticKey("fact", factory(log)), log }; } catch (error) { return { error: [(error as Error).name, (error as Error).message], log }; } };
      expect(outcome(observed)).toEqual(outcome(original));
    }
    expect(audit.result().rows.reduce((n: number, row: { calls: number }) => n + row.calls, 0)).toBe(3);
  } finally { delete (globalThis as Record<symbol, unknown>)[AUDIT_KEY]; await rm(directory, { recursive: true, force: true }); }
});

test("audit compares actual operation-local bytes and clears them on failure, retry and nested calls", () => {
  const sites = ["validate-provenance", "validate-value", "persist-provenance", "persist-value", "semantic-key"].map((category, id) => ({ id, category }));
  const audit = encodingAudit(sites);
  const encode = (id: number, value: unknown, kind: string | null = null) => audit.encode(id, canonical, kind, value);
  audit.operation(() => {
    encode(0, { value: "same" }); encode(1, ["界🚀", , 1]); encode(2, { value: "same" }); encode(3, ["界🚀", , 1]); encode(4, { value: "same" }, "provenance");
    audit.operation(() => { encode(0, { value: "nested" }); encode(2, { value: "changed" }); }, null, []);
    encode(4, { value: "same" }, "provenance");
  }, null, []);
  expect(() => audit.operation(() => { encode(0, { value: "failed" }); encode(1, undefined); }, null, [])).toThrow();
  audit.operation(() => { encode(2, { value: "retry" }); encode(4, { value: "retry" }, "provenance"); }, null, []);
  const result = audit.result();
  expect(result.operations).toBe(4); expect(result.operationFailures).toBe(1);
  expect(result.comparisons["provenance-validation-persistence"]).toMatchObject({ comparisons: 2, equal: 1, different: 1 });
  expect(result.comparisons["provenance-persistence-key"]).toMatchObject({ comparisons: 3, equal: 3 });
  expect(result.comparisons["value-validation-persistence"]).toMatchObject({ comparisons: 1, equal: 1 });
  expect(JSON.stringify(result)).not.toContain("failed");
});

test("instrumented calls preserve multiline/nested arguments and finite diagnostic buckets", async () => {
  const code = 'import {canonical} from "./model.js";\nexport const encode = value => canonical(\n canonical(value)\n);';
  const result = await instrumentCanonicalModule(code, "dist/core/semantic/fixture.js");
  expect(result.sites.length).toBe(2); expect(result.text.split("\n").length).toBe(code.split("\n").length);
  const audit = encodingAudit([{ id: 0, category: "other" }]);
  for (let i = 0; i < 1000; i++) audit.encode(0, canonical, `unknown-${i}`, i);
  expect(audit.result().rows).toHaveLength(1);
  expect(audit.result().rows[0]).toMatchObject({ calls: 1000, failures: 0 });
});
