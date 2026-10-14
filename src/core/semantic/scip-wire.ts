import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import protobuf from "protobufjs";

export const SCIP_PROTOCOL_DIGEST = "b38021b65ef90cbbf6af9c829ff75192859ad9b5da05439ef154bea4ceb2bf03";
// Wire-compatible subset of https://github.com/scip-code/scip/blob/main/scip.proto,
// pinned by the digest above (14 October 2026). Unknown fields are skipped by protobufjs.
const protocol = `syntax="proto3";
message ToolInfo { string name=1; string version=2; repeated string arguments=3; }
message Metadata { int32 version=1; ToolInfo tool_info=2; string project_root=3; int32 text_document_encoding=4; }
message SingleLineRange { int32 line=1; int32 start_character=2; int32 end_character=3; }
message MultiLineRange { int32 start_line=1; int32 start_character=2; int32 end_line=3; int32 end_character=4; }
message Diagnostic { int32 severity=1; string code=2; string message=3; string source=4; repeated int32 tags=5; }
message Occurrence { repeated int32 range=1; string symbol=2; int32 symbol_roles=3; repeated string override_documentation=4; int32 syntax_kind=5; repeated Diagnostic diagnostics=6; repeated int32 enclosing_range=7; SingleLineRange single_line_range=8; MultiLineRange multi_line_range=9; SingleLineRange single_line_enclosing_range=10; MultiLineRange multi_line_enclosing_range=11; }
message Relationship { string symbol=1; bool is_reference=2; bool is_implementation=3; bool is_type_definition=4; bool is_definition=5; }
message Signature { repeated Occurrence occurrences=2; string language=4; string text=5; }
message SymbolInformation { string symbol=1; repeated string documentation=3; repeated Relationship relationships=4; int32 kind=5; string display_name=6; Signature signature_documentation=7; string enclosing_symbol=8; }
message Document { string relative_path=1; repeated Occurrence occurrences=2; repeated SymbolInformation symbols=3; string language=4; string text=5; int32 position_encoding=6; }`;
const root = protobuf.parse(protocol, { keepCase: true }).root;
root.resolveAll();
export const scipType = (name: string): protobuf.Type => root.lookupType(name);
export const decodeScip = (name: string, bytes: Uint8Array): Record<string, unknown> => {
  const type = scipType(name); return type.toObject(type.decode(bytes), { defaults: true }) as Record<string, unknown>;
};

/** Reads Index fields without allocating an Index object, including unknown-field skipping. */
export class ScipStream {
  private handle!: FileHandle;
  private buffer = Buffer.alloc(65536);
  private position = 0;
  private available = 0;
  private offset = 0;
  private readonly hash = createHash("sha256");
  private maxBytes = 0;
  private constructor() {}
  static async open(filename: string, maxIndexBytes: number): Promise<ScipStream> {
    const stream = new ScipStream(); stream.maxBytes = maxIndexBytes; stream.handle = await open(filename, "r");
    const info = await stream.handle.stat();
    if (!info.isFile() || info.size > maxIndexBytes) { await stream.close(); throw Error("SCIP index exceeds file/resource limit"); }
    return stream;
  }
  close(): Promise<void> { return this.handle.close(); }
  digest(): string { return this.hash.copy().digest("hex"); }
  private async refill(): Promise<boolean> {
    if (this.position < this.available) return true;
    const { bytesRead } = await this.handle.read(this.buffer, 0, this.buffer.length, this.offset);
    this.offset += bytesRead; this.position = 0; this.available = bytesRead;
    if (this.offset > this.maxBytes) throw Error("SCIP index grew beyond resource limit");
    if (bytesRead) this.hash.update(this.buffer.subarray(0, bytesRead));
    return bytesRead > 0;
  }
  async integer(eofAllowed = false): Promise<number | undefined> {
    let result = 0; let multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (!await this.refill()) { if (i === 0 && eofAllowed) return undefined; throw Error("Truncated SCIP varint"); }
      const byte = this.buffer[this.position++]!; result += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(result)) throw Error("SCIP wire integer exceeds safe bounds");
      if (!(byte & 128)) return result; multiplier *= 128;
    }
    throw Error("Oversized SCIP varint");
  }
  async bytes(size: number, allocate: boolean): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0) throw Error("Invalid SCIP length");
    const output = allocate ? Buffer.alloc(size) : Buffer.alloc(0); let copied = 0;
    while (copied < size) {
      if (!await this.refill()) throw Error("Truncated SCIP field");
      const part = Math.min(size - copied, this.available - this.position);
      if (allocate) this.buffer.copy(output, copied, this.position, this.position + part);
      copied += part; this.position += part;
    }
    return output;
  }
  async skip(wire: number): Promise<void> {
    if (wire === 0) { for (let i = 0; i < 10; i++) { if (!await this.refill()) throw Error("Truncated unknown varint"); if (!(this.buffer[this.position++]! & 128)) return; } throw Error("Oversized unknown varint"); }
    if (wire === 1 || wire === 5) { await this.bytes(wire === 1 ? 8 : 4, false); return; }
    if (wire === 2) { await this.bytes((await this.integer())!, false); return; }
    throw Error(`Unsupported SCIP wire type ${wire}`);
  }
}

/** Count repeated children before decoding, bounding object expansion as well as wire bytes. */
export function validateDocumentSize(bytes: Uint8Array, maxOccurrences: number, message = "Document", maxRelationships = 1024): void {
  const nested: Record<string, Record<number, string>> = { Metadata: { 2: "ToolInfo" }, Document: { 2: "Occurrence", 3: "SymbolInformation" }, SymbolInformation: { 4: "Relationship", 7: "Signature" }, Signature: { 2: "Occurrence" }, Occurrence: { 6: "Diagnostic", 8: "SingleLineRange", 9: "MultiLineRange", 10: "SingleLineRange", 11: "MultiLineRange" } };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let objects = 0; let fields = 0;
  const inspect = (body: Uint8Array, name: string, depth: number): void => {
    if (++objects > Math.min(1000000, maxOccurrences * 12 + 1024) || depth > 8) throw Error("SCIP decoded object quota exceeded");
    const reader = protobuf.Reader.create(body); let occurrences = 0; let symbols = 0; let relationships = 0;
    const descriptors = scipType(name).fieldsById;
    while (reader.pos < reader.len) {
      if (++fields > Math.min(2000000, maxOccurrences * 32 + 1024)) throw Error("SCIP decoded field quota exceeded");
      const tag = reader.uint32(); const field = tag >>> 3; const wire = tag & 7;
      if (!field) throw Error("Invalid document field tag");
      const descriptor = descriptors[field];
      if (descriptor) {
        const expected = descriptor.type === "string" || !!nested[name]?.[field] ? [2] : descriptor.repeated ? [0, 2] : [0];
        if (!expected.includes(wire)) throw Error("Wrong wire type for known SCIP field");
      }
      if (name === "Document" && (field === 2 && ++occurrences > maxOccurrences || field === 3 && ++symbols > maxOccurrences)) throw Error("SCIP document exceeds occurrence/symbol bound");
      if (name === "SymbolInformation" && field === 4 && ++relationships > maxRelationships) throw Error("SCIP relationship quota exceeded");
      if (wire === 2 && nested[name]?.[field]) {
        const size = reader.uint32(); if (reader.pos + size > reader.len) throw Error("Truncated SCIP nested message");
        inspect(body.subarray(reader.pos, reader.pos + size), nested[name]![field]!, depth + 1); reader.pos += size;
      } else if (wire === 2 && descriptor?.type === "string") {
        const size = reader.uint32(); if (reader.pos + size > reader.len) throw Error("Truncated SCIP string");
        utf8.decode(body.subarray(reader.pos, reader.pos + size)); reader.pos += size;
      } else if (wire === 2 && (name === "Occurrence" && [1, 7].includes(field) || name === "Diagnostic" && field === 5)) {
        const size = reader.uint32(); if (size > 64 || reader.pos + size > reader.len) throw Error("SCIP packed scalar quota exceeded"); reader.pos += size;
      } else reader.skipType(wire);
    }
  };
  inspect(bytes, message, 0);
}
