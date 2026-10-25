import { expect, test } from "vitest";
import * as model from "../src/core/semantic/model.js";
import { SemanticStore } from "../src/core/semantic/store.js";
import { encodeFactProvenance } from "../src/core/semantic/provenance-encoding.js";

const base = () => ({ provider: "fixture", version: "1", basis: "syntax" as const, method: "test", context: "c", inputFingerprint: "f" });
const reference = (fact: { provenance: unknown }) => {
  const encoded = model.canonical(fact.provenance);
  return { encoded, key: model.semanticKey("provenance", fact.provenance), reused: false };
};
const candidate = encodeFactProvenance;
function equal(fact: { provenance: unknown }) {
  const actual = candidate(fact), expected = reference(fact);
  expect(actual.encoded).toBe(expected.encoded); expect(Buffer.from(actual.encoded)).toEqual(Buffer.from(expected.encoded)); expect(actual.key).toBe(expected.key);
  return actual;
}

test("bounded prototype preserves complete bytes/keys across independent equal objects and mutations between operations", () => {
  const provenance = base(); const a = equal({ provenance }), b = equal({ provenance: { ...provenance } });
  expect(a.reused).toBe(true); expect(b.key).toBe(a.key);
  provenance.method = "changed 🚀\n\ud800"; const changed = equal({ provenance });
  expect(changed.key).not.toBe(a.key); expect(equal({ provenance }).key).toBe(changed.key);
  const nullPrototype = Object.assign(Object.create(null), provenance); expect(equal({ provenance: nullPrototype }).reused).toBe(true);
  for (const n of [4094, 4095, 4096, 16383, 16384]) equal({ provenance: { ...base(), method: "界".repeat(n) + "🚀\ud800\u0000" } });
});

test("getters and proxies retain both legacy observations, mutation and rejection order", () => {
  const factories = [
    (log: string[]) => { let n = 0; return { get provenance() { log.push(`read:${++n}`); return { ...base(), method: String(n) }; } }; },
    (log: string[]) => ({ provenance: { ...base(), get extra() { log.push("extra"); if (log.length > 1) throw Error("second observation"); return 1; } } }),
    (log: string[]) => new Proxy({ provenance: base() }, { get(target, key) { log.push(String(key)); return Reflect.get(target, key); }, getOwnPropertyDescriptor() { throw Error("guard must not inspect proxy"); } }),
    (log: string[]) => ({ provenance: new Proxy(base(), { ownKeys(target) { log.push("keys"); return Reflect.ownKeys(target); }, get(target, key) { log.push(String(key)); return Reflect.get(target, key); } }) }),
  ];
  for (const factory of factories) {
    const run = (reuse: boolean) => { const log: string[] = []; try { const result = (reuse ? candidate : reference)(factory(log)); return { encoded: result.encoded, key: result.key, log }; } catch (error) { return { error: [(error as Error).name, (error as Error).message], log }; } };
    expect(run(true)).toEqual(run(false));
  }
});

test("nested/shared mutable data, sparse arrays and unsupported identities keep the reference path", () => {
  const shared = { names: ["a", , "函数"] }; const provenance = { ...base(), nested: [shared, shared] };
  expect(equal({ provenance }).reused).toBe(false); const before = equal({ provenance }).key;
  shared.names[0] = "mutated"; expect(equal({ provenance }).key).not.toBe(before);
  const large = { ...base(), nested: Array.from({ length: 2000 }, (_, n) => ({ n, value: "界🚀\n".repeat(n % 17) })) };
  expect(equal({ provenance: large }).reused).toBe(false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, Symbol("unsupported"), 1n, () => 1, cyclic, [1, undefined], { ...base(), extra: undefined }]) {
    const outcome = (encode: typeof reference) => { try { return encode({ provenance: value }); } catch (error) { return [(error as Error).name, (error as Error).message]; } };
    expect(outcome(candidate)).toEqual(outcome(reference));
  }
  expect(equal({ provenance: [1, , 2] }).reused).toBe(false);
});

test("prototype bytes agree with authoritative SQL; quotas, duplicate ownership and failed-batch retry remain enforced", () => {
  const store = new SemanticStore(":memory:"), run = store.begin("fixture", "c", "f");
  const provenance = base(); const fact = { predicate: "source.File" as const, context: "c", subject: "subject", value: { name: "界🚀" }, confidence: "exact" as const, provenance };
  try {
    store.addEntity("subject", "artifact", { name: "subject" });
    const write = () => store.batch(run, () => { const encoded = candidate(fact); const claim = store.addFact(run, fact); expect(store.sql("SELECT json FROM sc_provenance WHERE key=?").get(encoded.key)).toEqual({ json: encoded.encoded }); return claim; });
    const first = write(); expect(write()).toBe(first); expect(store.sql("SELECT COUNT(*) n FROM sc_claims").get()).toEqual({ n: 1 });
    fact.value.name = "different fact"; expect(write()).not.toBe(first); expect(store.sql("SELECT COUNT(*) n FROM sc_provenance").get()).toEqual({ n: 1 });
    provenance.method = "next operation"; write(); expect(store.sql("SELECT COUNT(*) n FROM sc_provenance").get()).toEqual({ n: 2 });
    const count = store.sql("SELECT COUNT(*) n FROM sc_claims").get();
    expect(() => store.batch(run, () => { fact.value.name = "rolled back"; store.addFact(run, fact); throw Error("rollback"); })).toThrow("rollback");
    expect(store.sql("SELECT COUNT(*) n FROM sc_claims").get()).toEqual(count); write();
    provenance.method = ""; provenance.method = "x".repeat(4096 - Buffer.byteLength(model.canonical(provenance)));
    expect(Buffer.byteLength(model.canonical(provenance))).toBe(4096); write(); provenance.method += "x"; expect(write).toThrow("Provenance exceeds 4 KiB");
    provenance.method = "quota";
    fact.value.name = "x".repeat(65536 - Buffer.byteLength(model.canonical({ name: "" })));
    expect(Buffer.byteLength(model.canonical(fact.value))).toBe(65536); write(); fact.value.name += "x"; expect(write).toThrow("Fact payload exceeds 64 KiB");
  } finally { store.close(); }
});

test("changed quoting and iterator hooks force fallback without extra observable callbacks", () => {
  for (const variant of ["quoting", "iterator-return", "accessor-descriptor"]) {
    const run = (reuse: boolean) => {
      const fact = { provenance: base() }; let calls = 0;
      const target = variant !== "iterator-return" ? JSON : Object.getPrototypeOf([][Symbol.iterator]());
      const key = variant !== "iterator-return" ? "stringify" : "return";
      const previous = Object.getOwnPropertyDescriptor(target, key), stringify = JSON.stringify;
      if (variant === "accessor-descriptor") {
        const valueDescriptor = Object.assign(Object.create(null), { configurable: true, get() { calls++; return undefined; } });
        const quotingDescriptor = Object.assign(Object.create(null), { configurable: true, get() { calls++; return stringify; } });
        Object.defineProperty(Object.prototype, "value", valueDescriptor); Object.defineProperty(target, key, quotingDescriptor);
      } else Object.defineProperty(target, key, { configurable: true, writable: true, value: variant === "quoting" ? function (value: unknown) { if (++calls === 2) fact.provenance.method = "observed mutation"; return stringify(value); } : function () { calls++; return { done: true }; } });
      try { const result = (reuse ? candidate : reference)(fact); return { ...result, calls }; }
      finally { if (variant === "accessor-descriptor") delete (Object.prototype as Record<string, unknown>).value; if (previous) Object.defineProperty(target, key, previous); else delete (target as Record<string, unknown>)[key]; }
    };
    expect(run(true)).toEqual(run(false));
  }
});
