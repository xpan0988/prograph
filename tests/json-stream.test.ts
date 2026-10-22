import { expect, test } from "vitest";
import { prettyJsonChunks, writePrettyJson } from "../src/core/storage/json-stream.js";
import { acceptedPrettyJson } from "./oracles/legacy-json-stage6-2.js";

function compare(value: unknown) {
  const chunks = [...prettyJsonChunks(value)];
  expect(chunks.every(c => c.length <= 16384)).toBe(true);
  expect(Buffer.concat(chunks.map(c => Buffer.from(c))).equals(Buffer.from(acceptedPrettyJson(value)))).toBe(true);
}

test("pretty bytes retain empty/sparse/unsupported values, enumeration order, nested arrays and diagnostics", () => {
  const sparse = new Array(5); sparse[1] = undefined; sparse[3] = Symbol("x");
  for (const value of [undefined, () => 1, Symbol("x"), null, {}, [], NaN, Infinity, -0,
    { 2: "second", 1: "first", z: undefined, f: () => 1, s: Symbol(), a: [sparse, [], {}, null] },
    { schemaVersion: "1.2.0", repository: { root: "/x", identity: "x" }, nodes: [], edges: [], diagnostics: [{ code: "x", metadata: { nested: [[{}], { values: [null, false, 1e-8] }] } }] }]) compare(value);
});

test("Unicode, escaping, long keys/strings and surrogate pairs across every chunk boundary match native bytes", () => {
  for (const n of [4094, 4095, 4096, 4097, 16382, 16383, 16384, 16385]) {
    const text = "x".repeat(n) + "🙂\ud800\udc00\udfff\u0000\b\t\n\r\"\\\u2028\u2029日本語" + "\u0001".repeat(5000);
    compare({ [text]: text, nested: [text, { text }] });
  }
});

test("boxed primitives, dates, typed arrays, toJSON keys and repeated references preserve native behavior", () => {
  const shared = { value: "same" }, fn = () => 1;
  Object.assign(fn, { toJSON: (key: string) => ({ key }) });
  compare({ number: new Number(3), string: new String("🙂"), boolean: new Boolean(false), symbol: Object(Symbol("x")),
    date: new Date("2000-01-02T03:04:05Z"), invalid: new Date(NaN), typed: new Uint8Array([1, 2]), buffer: Buffer.from("ok"),
    shared: [shared, shared], fn, hook: { toJSON(key: string) { return { key, value: 2 }; } } });
  const raw = JSON as typeof JSON & { rawJSON?: (text: string) => unknown };
  if (raw.rawJSON) compare({ raw: raw.rawJSON("12345678901234567890") });
  const boxed = new Number(1); boxed.valueOf = () => 7; compare(boxed);
});

test("property reads and toJSON calls occur once in accepted property/array order", () => {
  function make(log: string[]) {
    const value = { get first() { log.push("first"); return { toJSON(key: string) { log.push(key); return 1; } }; },
      get second() { log.push("second"); return [undefined, { toJSON(key: string) { log.push(key); return 3; } }]; } };
    return value;
  }
  const oldLog: string[] = [], newLog: string[] = [];
  expect([...prettyJsonChunks(make(newLog))].join("")).toBe(acceptedPrettyJson(make(oldLog)));
  expect(newLog).toEqual(oldLog);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  expect(() => [...prettyJsonChunks(cycle)]).toThrow(TypeError);
  expect(() => [...prettyJsonChunks(1n)]).toThrow(TypeError);
});

test("captured array lengths and object keys retain native behavior when getters change later entries", () => {
  function fixture() {
    const array = [1, 2, 3];
    Object.defineProperty(array, "0", { get() { array.length = 1; return "first"; } });
    const object: Record<string, unknown> = {};
    Object.defineProperty(object, "first", { enumerable: true, get() { delete object.later; object.added = "omitted"; return array; } });
    object.later = "deleted";
    return object;
  }
  expect([...prettyJsonChunks(fixture())].join("")).toBe(acceptedPrettyJson(fixture()));
  const inherited = Object.assign(Object.create({ inherited: "omitted" }), { own: "included" });
  compare(inherited);
  const symbolKey = { own: 1, [Symbol("omitted")]: "symbol" };
  compare(symbolKey);
  const badBox = new Number(1); Object.defineProperty(badBox, Symbol.toPrimitive, { value: () => 1n });
  expect(() => acceptedPrettyJson(badBox)).toThrow(TypeError);
  expect(() => [...prettyJsonChunks(badBox)]).toThrow(TypeError);
});

test("seeded metadata and large graph arrays match every output byte", () => {
  let seed = 0x6a31;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  function value(depth: number): unknown {
    const n = random() % (depth ? 9 : 6);
    if (n === 0) return undefined; if (n === 1) return null; if (n === 2) return random() / 1000;
    if (n === 3) return Boolean(random() & 1); if (n === 4) return "🙂\n\ud800" + random(); if (n === 5) return NaN;
    if (n === 6) return Array.from({ length: random() % 6 }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: random() % 6 }, (_, i) => [String(i) + "é", value(depth - 1)]));
  }
  for (let i = 0; i < 300; i++) compare(value(5));
  compare({ nodes: Array.from({ length: 20000 }, (_, id) => ({ id, metadata: { text: "🙂\n", values: [id, null] } })), edges: [], diagnostics: [] });
  let nested: unknown = null; for (let i = 0; i < 500; i++) nested = { nested }; compare(nested);
});

test("partial writes apply backpressure with one bounded buffer and report exact encoded bytes", async () => {
  const value = { text: "🙂\u0000".repeat(20000) }, chunks: Buffer[] = [];
  let active = 0, peak = 0;
  const handle = { async write(buffer: Uint8Array, offset: number, length: number) {
    active++; peak = Math.max(peak, active); await Promise.resolve();
    const count = Math.min(length, 113); chunks.push(Buffer.from(buffer.subarray(offset, offset + count))); active--;
    return { bytesWritten: count, buffer };
  } };
  const stats = await writePrettyJson(handle as never, value);
  expect(peak).toBe(1); expect(stats.maxBufferBytes).toBeLessThanOrEqual(49152);
  expect(stats.bytes).toBe(Buffer.byteLength(acceptedPrettyJson(value)));
  expect(Buffer.concat(chunks).equals(Buffer.from(acceptedPrettyJson(value)))).toBe(true);
  await expect(writePrettyJson({ write: async () => ({ bytesWritten: 0 }) } as never, {})).rejects.toThrow(/no progress/);
  const controller = new AbortController(); controller.abort();
  await expect(writePrettyJson(handle as never, value, controller.signal)).rejects.toBeDefined();
});
