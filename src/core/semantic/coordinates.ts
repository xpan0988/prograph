import { digest, semanticKey, type OccurrenceInput } from "./model.js";

/** TS uses UTF-16 string offsets; the store uses validated half-open UTF-8 byte ranges. */
export class SourceCoordinates {
  readonly sourceDigest: string;
  readonly lineStarts = [0];
  private readonly bytes: Uint32Array;
  private readonly codepointLines = new Map<number, number[]>();
  constructor(readonly file: string, readonly text: string, private readonly physicalLines = false) {
    this.sourceDigest = digest(Buffer.from(text, "utf8"));
    this.bytes = new Uint32Array(text.length + 1);
    let offset = 0;
    for (let i = 0; i < text.length; i++) {
      this.bytes[i] = offset;
      const point = text.codePointAt(i)!;
      const width = point > 0xffff ? 2 : 1;
      offset += Buffer.byteLength(String.fromCodePoint(point), "utf8");
      if (width === 2) { this.bytes[++i] = 0xffffffff; }
      if (point === 10 || point === 13 && text.charCodeAt(i + 1) !== 10 || !physicalLines && (point === 0x2028 || point === 0x2029)) this.lineStarts.push(i + 1);
    }
    this.bytes[text.length] = offset;
  }
  position(offset: number): { line: number; column: number; byte: number } {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length || this.bytes[offset] === 0xffffffff) throw new Error("Invalid UTF-16 source boundary");
    let low = 0; let high = this.lineStarts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (this.lineStarts[mid]! <= offset) low = mid; else high = mid; }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1, byte: this.bytes[offset]! };
  }
  /** SCIP uses zero-based lines and UTF-8/16/32 columns; convert without per-occurrence line scans. */
  utf16AtByte(byte: number): number {
    if (!Number.isSafeInteger(byte) || byte < 0) throw Error("Invalid byte boundary");
    let low = 0; let high = this.text.length;
    while (low < high) { let mid = (low + high) >>> 1; if (this.bytes[mid] === 0xffffffff) mid--;
      if (this.bytes[mid]! < byte) low = mid + (this.text.codePointAt(mid)! > 0xffff ? 2 : 1); else high = mid;
    }
    if (this.bytes[low] !== byte) throw Error("Byte offset splits a codepoint or exceeds source"); return low;
  }
  offset(line: number, column: number, encoding: number): number {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 0 || column < 0 || line >= this.lineStarts.length) throw Error("Invalid source line/column");
    const start = this.lineStarts[line]!; let end = this.lineStarts[line + 1] ?? this.text.length;
    const terminators = this.physicalLines ? [10, 13] : [10, 13, 0x2028, 0x2029];
    while (end > start && terminators.includes(this.text.charCodeAt(end - 1))) end--;
    if (encoding === 2) { const value = start + column; if (value > end) throw Error("UTF-16 column outside line"); this.position(value); return value; }
    if (encoding === 1) {
      const target = this.bytes[start]! + column; let low = start; let high = end;
      while (low < high) { let mid = (low + high) >>> 1; if (this.bytes[mid] === 0xffffffff) mid--;
        if (this.bytes[mid]! < target) low = mid + (this.text.codePointAt(mid)! > 0xffff ? 2 : 1); else high = mid;
      }
      if (low > end || this.bytes[low] !== target) throw Error("UTF-8 column splits a codepoint or exceeds line"); return low;
    }
    if (encoding === 3) {
      let offsets = this.codepointLines.get(line);
      if (!offsets) { offsets = [start]; for (let i = start; i < end;) { i += this.text.codePointAt(i)! > 0xffff ? 2 : 1; offsets.push(i); }
        if (this.codepointLines.size >= 32) this.codepointLines.clear(); this.codepointLines.set(line, offsets); }
      const value = offsets[column]; if (value === undefined) throw Error("UTF-32 column outside line"); return value;
    }
    throw Error("Unspecified/unsupported source position encoding");
  }
  range(start: number, end: number, context: string, role: string): OccurrenceInput {
    if (end < start) throw new Error("Reversed source range");
    const a = this.position(start); const b = this.position(end);
    const identity = [this.file, this.sourceDigest, context, a.byte, b.byte, role];
    // Preserve Step 1's TS identity; native physical-line mapping has an explicit discriminator.
    if (this.physicalLines) identity.push("physical-lines-1");
    return { key: semanticKey("occurrence", identity), file: this.file,
      sourceDigest: this.sourceDigest, context, startByte: a.byte, endByte: b.byte, line: a.line, column: a.column,
      endLine: b.line, endColumn: b.column, role };
  }
}
