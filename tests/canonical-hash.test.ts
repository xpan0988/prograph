import { expect, test } from "vitest";
import { canonical, digest } from "../src/core/semantic/model.js";
import { canonicalDigest, writeCanonical, type CanonicalEncodingStats } from "../src/core/semantic/canonical-hash.js";

const SEED = 0x6501;
function bytes(value: unknown, fallback?: number) {
  const expected = canonical(value), chunks: string[] = [];
  const stats = writeCanonical(value, chunk => { chunks.push(chunk); });
  expect(chunks.join("")).toBe(expected);
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from(expected));
  const measured: CanonicalEncodingStats = { bytes: 0, chunks: 0, maxChunkBytes: 0, referenceFallback: 0 };
  expect(canonicalDigest(value, measured)).toBe(digest(expected));
  expect(measured).toEqual(stats); expect(stats.bytes).toBe(Buffer.byteLength(expected));
  expect(stats.chunks).toBe(chunks.length); expect(stats.maxChunkBytes).toBeLessThanOrEqual(49152);
  if (fallback !== undefined) expect(stats.referenceFallback).toBe(fallback);
  return stats;
}
function outcome(run: () => unknown) {
  try { return { value: run() }; } catch (error) { return { error: error instanceof Error ? [error.name, error.message] : error }; }
}

test("canonical bytes and SHA-256 preserve primitive, numeric, sparse and generic-object contracts", () => {
  for (const value of [null, true, false, "", 0, -0, 1, -3.125, Number.MIN_VALUE, Number.MAX_VALUE, Number.EPSILON, 1e-7, 1e21, [], {}, [null, {}, []], Array(1), Array(5), [1, , [, 2, ,], 3]]) bytes(value, 0);
  expect(canonical(Array(3))).toBe("[,,]"); expect(canonical(-0)).toBe("0");
  for (const value of [new Date(0), new Date(NaN), new Number(NaN), new String("🚀"), Object(2n), new Map([["a", 1]]), new Set([2]), /pattern/u, Buffer.from([1, 2, 255]), new Uint16Array([2, 1])]) bytes(value, 1);
  const nullPrototype = Object.assign(Object.create(null), { z: 2, a: 1 }); bytes(nullPrototype, 0);
  const hidden = { a: 1 }; Object.defineProperty(hidden, "toJSON", { value() { throw Error("must not invoke toJSON"); } }); bytes(hidden, 0);
});

test("unsupported identities retain the reference rejection, including explicit undefined rather than sparse holes", () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol("identity"), () => 1]) {
    for (const input of [value, [value], { a: value }, { nested: [0, { value }] }]) expect(outcome(() => canonicalDigest(input))).toEqual(outcome(() => digest(canonical(input))));
  }
  const object: Record<string, unknown> = {}; object.self = object;
  const array: unknown[] = []; array.push(array);
  for (const cyclic of [object, array]) expect(outcome(() => canonicalDigest(cyclic))).toEqual(outcome(() => digest(canonical(cyclic))));
});

test("binary key ordering preserves numeric names, supplementary/lone surrogates, escaping and shuffled wide objects", () => {
  const keys = ["10", "2", "a", "A", "漢", "🚀", "\uffff", "\ud800", "\udc00", "\0", "__proto__", '"\\\n', "k".repeat(4095) + "🚀"];
  for (let i = 0; i < 2048; i++) keys.push(`key-${(i * 997) % 2048}`);
  const first: Record<string, unknown> = Object.create(null), second: Record<string, unknown> = Object.create(null);
  for (const key of keys) first[key] = [key, -0, { unicode: "汉字😀" }];
  for (const key of [...keys].reverse()) second[key] = first[key];
  bytes(first, 0); bytes(second, 0); expect(canonicalDigest(first)).toBe(canonicalDigest(second));
});

test("string slices and flush boundaries preserve exact UTF-8 including controls and malformed surrogate sequences", () => {
  for (const at of [4094, 4095, 4096, 16381, 16382, 16383, 16384]) {
    for (const suffix of ["🚀漢é", "\ud800x\udc00", "\u0000\b\f\n\r\t\"\\", "\u2028\u2029", "\ud800\ud800\udc00\udc00"]) bytes({ key: "a".repeat(at) + suffix + "界".repeat(5000) }, 0);
  }
  const stats = bytes(["\u0001".repeat(18000), "界".repeat(22000), "🚀".repeat(17000)], 0);
  expect(stats.chunks).toBeGreaterThan(5);
});

test("deep and shared structures preserve bytes without imposing new semantic admission bounds", () => {
  for (const depth of [32, 64, 65, 66, 256, 512]) {
    let value: unknown = "end"; for (let i = 0; i < depth; i++) value = i % 2 ? [value, , null] : { z: value, a: i };
    bytes(value, depth > 65 ? 1 : 0);
  }
  const shared = { value: ["shared", null, -0] }; bytes([shared, shared, { shared }], 0);
  const previous = canonicalDigest(shared); shared.value[0] = "changed";
  bytes(shared, 0); expect(canonicalDigest(shared)).not.toBe(previous);
});

test("fallback preserves getters, proxy traps, array mutation, map/species/join behavior and thrown values", () => {
  const factories: Array<(log: string[]) => unknown> = [
    log => ({ get z() { log.push("z"); return { get a() { log.push("nested"); return 1; } }; }, get a() { log.push("a"); return 2; } }),
    log => new Proxy({ b: 1, a: 2 }, { ownKeys(target) { log.push("keys"); return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { log.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); }, get(target, key) { log.push(`get:${String(key)}`); return Reflect.get(target, key); } }),
    log => { const value = [1, 2, 3]; Object.defineProperty(value, "0", { get() { log.push("index"); delete value[1]; value.push(4); return 9; } }); return value; },
    log => { const value: unknown[] = Array(2); Object.defineProperty(value, "1", { get() { log.push("late"); Object.defineProperty(Array.prototype, "0", { value: "late", writable: true, configurable: true }); return 0; } }); return value; },
    log => { const value = [1]; Object.defineProperty(value, "map", { get() { log.push("map"); return (callback: typeof canonical) => { log.push(callback.name); return { join(separator: string) { log.push(separator); return "custom"; } }; }; } }); return value; },
    log => { class Observed extends Array { static get [Symbol.species]() { log.push("species"); return Array; } } return new Observed(1, 2); },
    log => ({ get a() { log.push("throw"); throw new TypeError("fixture getter failure"); } }),
    () => Object.assign([1], { map: undefined }),
  ];
  for (const factory of factories) {
    const evaluate = (stream: boolean) => {
      const log: string[] = [];
      try { const value = factory(log); return { ...outcome(() => stream ? canonicalDigest(value) : digest(canonical(value))), log }; }
      finally { delete (Array.prototype as unknown as Record<string, unknown>)["0"]; }
    };
    expect(evaluate(true)).toEqual(evaluate(false));
  }
});

test(`seeded byte/hash oracle (seed 0x${SEED.toString(16)}) covers valid and invalid nested identities`, () => {
  let seed = SEED;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const strings = ["", "a\0b", "汉🚀", "\ud800", '"\\\n', "\u2028", "0123456789"];
  const value = (depth: number): unknown => {
    const kind = next() % (depth ? 9 : 5);
    if (kind === 0) return null;
    if (kind === 1) return !!(next() & 1);
    if (kind === 2) return (next() - 0x80000000) / ((next() % 100) + 1);
    if (kind === 3) return strings[next() % strings.length];
    if (kind === 4) return [undefined, NaN, 1n, Infinity][next() % 4];
    if (kind < 7) { const array = Array(next() % 7); for (let i = 0; i < array.length; i++) if (next() % 3) array[i] = value(depth - 1); return array; }
    const object: Record<string, unknown> = Object.create(null); for (let n = next() % 7; n > 0; n--) object[`${strings[next() % strings.length]}-${next() % 20}`] = value(depth - 1); return object;
  };
  for (let i = 0; i < 2000; i++) {
    const input = value(6), expected = outcome(() => canonical(input));
    if ("error" in expected) expect(outcome(() => canonicalDigest(input))).toEqual(expected);
    else bytes(input);
  }
});

test("large graph-like payload has matching complete bytes and only bounded output chunks", () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `node:${i}`, metadata: { unicode: "函数 🚀", flags: [false, null, i / 3], body: "sample\n".repeat(i % 13) }, range: { start: i, end: i + 1 } }));
  const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i]!.id, target: node.id, confidence: "probable", evidence: [{ file: "lib.rs", line: i + 1 }] }));
  const stats = bytes({ nodes, edges, configuration: { strict: true } }, 0);
  expect(stats.bytes).toBeGreaterThan(1000000); expect(stats.maxChunkBytes).toBeLessThanOrEqual(49152);
});
