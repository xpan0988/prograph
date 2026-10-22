/** Bounded equivalent of `${JSON.stringify(value, null, 2)}\n` for export only.
 * This is not canonical encoding and must never be used for persistent IDs.
 */
import { types } from "node:util";
import type { FileHandle } from "node:fs/promises";

const STRING_SLICE = 4096;
const CHUNK_CHARACTERS = 16384; // At most 49,152 UTF-8 bytes, including escaped strings.
const INDENTS = Array.from({ length: 33 }, (_, depth) => "  ".repeat(depth));
type Container = Record<string, unknown> | unknown[];
type Frame = { kind: "value"; value: unknown; depth: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number; emitted: boolean; depth: number }
  | { kind: "array"; value: unknown[]; length: number; index: number; depth: number };

function prepared(value: unknown, key: string): unknown {
  if ((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "bigint") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value, key);
  }
  if (types.isBoxedPrimitive(value)) {
    if (types.isNumberObject(value)) value = +(value as number);
    else if (types.isStringObject(value)) value = String(value);
    else if (types.isBooleanObject(value)) value = Boolean.prototype.valueOf.call(value);
    else if (types.isBigIntObject(value)) value = BigInt.prototype.valueOf.call(value);
  }
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  return value;
}
function unsupported(value: unknown) { return value === undefined || typeof value === "function" || typeof value === "symbol"; }
function safeEnd(text: string, start: number, size: number) {
  let end = Math.min(text.length, start + size);
  if (end < text.length && end > start) {
    const high = text.charCodeAt(end - 1), low = text.charCodeAt(end);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
  }
  return end;
}
function* quoted(text: string): Generator<string> {
  if (text.length <= STRING_SLICE) { yield JSON.stringify(text); return; }
  yield '"';
  for (let start = 0; start < text.length;) {
    const end = safeEnd(text, start, STRING_SLICE);
    yield JSON.stringify(text.slice(start, end)).slice(1, -1); start = end;
  }
  yield '"';
}
function* indent(depth: number): Generator<string> {
  if (depth < INDENTS.length) { yield INDENTS[depth]!; return; }
  while (depth > 0) { const n = Math.min(depth, 2048); yield "  ".repeat(n); depth -= n; }
}
function* fragments(input: unknown): Generator<string> {
  const root = prepared(input, "");
  if (unsupported(root)) { yield "undefined\n"; return; }
  const frames: Frame[] = [{ kind: "value", value: root, depth: 0 }];
  const ancestors = new Set<Container>();
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.kind === "object") {
      let found = false;
      while (frame.index < frame.keys.length) {
        const key = frame.keys[frame.index++]!, value = prepared(frame.value[key], key);
        if (unsupported(value)) continue;
        const separator = frame.emitted ? ",\n" : "\n"; frame.emitted = true;
        if (key.length <= STRING_SLICE && frame.depth + 1 < INDENTS.length)
          yield separator + INDENTS[frame.depth + 1]! + JSON.stringify(key) + ": ";
        else { yield separator; yield* indent(frame.depth + 1); yield* quoted(key); yield ": "; }
        frames.push({ kind: "value", value, depth: frame.depth + 1 }); found = true; break;
      }
      if (found) continue;
      frames.pop(); ancestors.delete(frame.value);
      if (frame.emitted) { yield "\n"; yield* indent(frame.depth); }
      yield "}"; continue;
    }
    if (frame.kind === "array") {
      if (frame.index < frame.length) {
        const index = frame.index++, value = prepared(frame.value[index], String(index));
        yield index ? ",\n" : "\n"; yield* indent(frame.depth + 1);
        frames.push({ kind: "value", value: unsupported(value) ? null : value, depth: frame.depth + 1 });
      } else {
        frames.pop(); ancestors.delete(frame.value);
        if (frame.length) { yield "\n"; yield* indent(frame.depth); }
        yield "]";
      }
      continue;
    }
    frames.pop(); const value = frame.value;
    if (typeof value === "string") { yield* quoted(value); continue; }
    if (value === null || typeof value !== "object") { yield JSON.stringify(value)!; continue; }
    const raw = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean };
    if (raw.isRawJSON?.(value)) { yield (value as { rawJSON: string }).rawJSON; continue; }
    const container = value as Container;
    if (ancestors.has(container)) throw new TypeError("Converting circular structure to JSON");
    ancestors.add(container);
    if (Array.isArray(container)) {
      // Capture length once, as SerializeJSONArray does (including array proxies).
      const length = Math.min(Math.max(Math.trunc(+container.length) || 0, 0), Number.MAX_SAFE_INTEGER);
      frames.push({ kind: "array", value: container, length, index: 0, depth: frame.depth }); yield "[";
    } else {
      const keys = Object.keys(container);
      frames.push({ kind: "object", value: container, keys, index: 0, emitted: false, depth: frame.depth }); yield "{";
    }
  }
  yield "\n";
}

export function* prettyJsonChunks(value: unknown): Generator<string> {
  let parts: string[] = [], characters = 0;
  for (const fragment of fragments(value)) {
    for (let start = 0; start < fragment.length;) {
      const end = safeEnd(fragment, start, CHUNK_CHARACTERS - characters);
      if (end === start) { yield parts.join(""); parts = []; characters = 0; continue; }
      parts.push(fragment.slice(start, end)); characters += end - start; start = end;
      if (characters === CHUNK_CHARACTERS) { yield parts.join(""); parts = []; characters = 0; }
    }
  }
  if (characters) yield parts.join("");
}

export interface JsonWriteStats { bytes: number; buffers: number; maxBufferBytes: number }
/** One encoded chunk and one in-flight write. The caller owns publication/cleanup. */
export async function writePrettyJson(handle: Pick<FileHandle, "write">, value: unknown, signal?: AbortSignal): Promise<JsonWriteStats> {
  const stats = { bytes: 0, buffers: 0, maxBufferBytes: 0 };
  for (const chunk of prettyJsonChunks(value)) {
    signal?.throwIfAborted();
    const buffer = Buffer.from(chunk, "utf8"); stats.buffers++; stats.maxBufferBytes = Math.max(stats.maxBufferBytes, buffer.length);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
      if (bytesWritten <= 0) throw Error("JSON export write made no progress");
      offset += bytesWritten; stats.bytes += bytesWritten;
    }
  }
  signal?.throwIfAborted();
  return stats;
}
