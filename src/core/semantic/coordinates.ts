import { digest, semanticKey, type OccurrenceInput } from "./model.js";

/** TS uses UTF-16 string offsets; the store uses validated half-open UTF-8 byte ranges. */
export class SourceCoordinates {
  readonly sourceDigest: string;
  readonly lineStarts = [0];
  private readonly bytes: Uint32Array;
  constructor(readonly file: string, readonly text: string) {
    this.sourceDigest = digest(Buffer.from(text, "utf8"));
    this.bytes = new Uint32Array(text.length + 1);
    let offset = 0;
    for (let i = 0; i < text.length; i++) {
      this.bytes[i] = offset;
      const point = text.codePointAt(i)!;
      const width = point > 0xffff ? 2 : 1;
      offset += Buffer.byteLength(String.fromCodePoint(point), "utf8");
      if (width === 2) { this.bytes[++i] = 0xffffffff; }
      if (point === 10 || point === 13 && text.charCodeAt(i + 1) !== 10 || point === 0x2028 || point === 0x2029) this.lineStarts.push(i + 1);
    }
    this.bytes[text.length] = offset;
  }
  position(offset: number): { line: number; column: number; byte: number } {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length || this.bytes[offset] === 0xffffffff) throw new Error("Invalid UTF-16 source boundary");
    let low = 0; let high = this.lineStarts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (this.lineStarts[mid]! <= offset) low = mid; else high = mid; }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1, byte: this.bytes[offset]! };
  }
  range(start: number, end: number, context: string, role: string): OccurrenceInput {
    if (end < start) throw new Error("Reversed source range");
    const a = this.position(start); const b = this.position(end);
    return { key: semanticKey("occurrence", [this.file, this.sourceDigest, context, a.byte, b.byte, role]), file: this.file,
      sourceDigest: this.sourceDigest, context, startByte: a.byte, endByte: b.byte, line: a.line, column: a.column,
      endLine: b.line, endColumn: b.column, role };
  }
}
