/** Hash-only canonical encoding. model.canonical remains the independent string
 * contract for persistence, validation, sorting, quotas and collision checks.
 */
import { createHash } from "node:crypto";
import { constants } from "node:buffer";
import { types } from "node:util";
import { canonical } from "./model.js";

const STRING_SLICE = 4096;
const CHUNK_CHARACTERS = 16384;
const arrayPrototype = Array.prototype;
const arrayMap = arrayPrototype.map;
const arrayJoin = arrayPrototype.join;
const speciesGetter = Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get;
export interface CanonicalEncodingStats { bytes: number; chunks: number; maxChunkBytes: number; referenceFallback: number }

function safeEnd(text: string, start: number, size: number): number {
  let end = Math.min(text.length, start + size);
  if (end < text.length && end > start) {
    const high = text.charCodeAt(end - 1), low = text.charCodeAt(end);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
  }
  return end;
}

/** Qualification never invokes input getters or proxy traps. A fallback applies
 * to the WHOLE input before encoding, preserving Object.entries/map/join side
 * effects and rejection order. Weak sets are local to this operation, not caches
 * of identities; they do not retain measured objects or cross source revisions.
 */
function plainData(value: unknown): boolean {
  if (Object.getOwnPropertyDescriptor(arrayPrototype, "map")?.value !== arrayMap
    || Object.getOwnPropertyDescriptor(arrayPrototype, "join")?.value !== arrayJoin
    || Object.getOwnPropertyDescriptor(arrayPrototype, "constructor")?.value !== Array
    || Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get !== speciesGetter
    || [arrayPrototype, Object.prototype].some(prototype => Object.getOwnPropertyNames(prototype).some(key => /^(0|[1-9][0-9]*)$/.test(key)))) return false;
  const done = new WeakSet<object>(), active = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (!item || typeof item !== "object" || types.isProxy(item) || depth > 64) return false;
    if (active.has(item)) return false;
    if (done.has(item)) return true;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== arrayPrototype || Object.hasOwn(item, "map") || Object.hasOwn(item, "constructor") : prototype !== Object.prototype && prototype !== null) return false;
    active.add(item);
    // Array map observes non-enumerable indices too, but ignores extra fields.
    const keys = array ? Object.getOwnPropertyNames(item).filter(key => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length) : Object.keys(item);
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(property, "value") || !visit(property.value, depth + 1)) return false;
    }
    active.delete(item); done.add(item); return true;
  };
  return visit(value, 0);
}

/** Diagnostic sink must not mutate the input. Chunks are bounded to 16,384
 * UTF-16 units / 49,152 UTF-8 bytes and never bisect a surrogate pair.
 * Object.entries snapshots and binary key sorting match the reference exactly.
 * Wide-object entry lists and recursion depth remain proportional to input.
 * Observable/exotic or deep inputs retain reference materialization/resource
 * behavior. The threshold selects an algorithm; it never rejects an identity.
 * An error can follow partial sink writes; no digest is returned on failure.
 */
export function writeCanonical(value: unknown, sink: (chunk: string) => void): CanonicalEncodingStats {
  const stats = { bytes: 0, chunks: 0, maxChunkBytes: 0, referenceFallback: 0 };
  let canonicalCharacters = 0;
  const send = (chunk: string) => {
    canonicalCharacters += chunk.length;
    // The reference must return one V8 string. Do not admit an identity whose
    // canonical representation could not fit that existing engine limit.
    if (canonicalCharacters > constants.MAX_STRING_LENGTH) throw new RangeError("Invalid string length");
    const bytes = Buffer.byteLength(chunk);
    stats.bytes += bytes; stats.chunks++; stats.maxChunkBytes = Math.max(stats.maxChunkBytes, bytes);
    sink(chunk);
  };
  if (!plainData(value)) {
    stats.referenceFallback = 1;
    const encoded = canonical(value);
    // A reference call can mutate array prototypes. Do not use a parts array
    // after its observable callbacks; stream the already materialized result.
    for (let start = 0; start < encoded.length;) {
      const end = safeEnd(encoded, start, CHUNK_CHARACTERS);
      send(encoded.slice(start, end)); start = end;
    }
    return stats;
  }
  let parts: string[] = [], characters = 0;
  const flush = () => {
    if (!characters) return;
    const chunk = parts.join(""); parts = []; characters = 0;
    send(chunk);
  };
  const emit = (text: string) => {
    for (let start = 0; start < text.length;) {
      const end = safeEnd(text, start, CHUNK_CHARACTERS - characters);
      if (end === start) { flush(); continue; }
      parts.push(text.slice(start, end)); characters += end - start; start = end;
      if (characters === CHUNK_CHARACTERS) flush();
    }
  };
  const quote = (text: string) => {
    if (text.length <= STRING_SLICE) { emit(JSON.stringify(text)); return; }
    emit('"');
    for (let start = 0; start < text.length;) {
      const end = safeEnd(text, start, STRING_SLICE);
      emit(JSON.stringify(text.slice(start, end)).slice(1, -1)); start = end;
    }
    emit('"');
  };
  const visit = (item: unknown): void => {
    if (typeof item === "string") { quote(item); return; }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { emit(JSON.stringify(item)); return; }
    if (Array.isArray(item)) {
      const length = item.length; emit("[");
      for (let index = 0; index < length; index++) {
        if (index) emit(",");
        // map skips holes, including those removed by an earlier getter, while
        // observing inherited indexed values and its original length.
        if (index in item) visit(item[index]);
      }
      emit("]"); return;
    }
    if (item && typeof item === "object") {
      const entries = Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      emit("{");
      for (let index = 0; index < entries.length; index++) {
        if (index) emit(",");
        const [key, member] = entries[index]!; quote(key); emit(":"); visit(member);
      }
      emit("}"); return;
    }
    throw new Error("Semantic identity cannot contain undefined, non-finite numbers or unsupported values");
  };
  visit(value);
  flush(); return stats;
}

export function canonicalDigest(value: unknown, stats?: CanonicalEncodingStats): string {
  const hash = createHash("sha256");
  const measured = writeCanonical(value, chunk => { hash.update(chunk); });
  const result = hash.digest("hex");
  if (stats) Object.assign(stats, measured);
  return result;
}
