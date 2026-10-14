import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/** Hash dependency/artifact inputs without retaining their contents in memory. */
export async function digestFile(filename: string, maxBytes = 10 * 1024 ** 3, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(filename)) {
    signal?.throwIfAborted(); size += chunk.length; if (size > maxBytes) throw Error("Input exceeds byte quota"); hash.update(chunk);
  }
  return hash.digest("hex");
}
/** A file growing concurrently cannot turn a bounded read into an unbounded allocation. */
export async function boundedInput(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes) throw Error("Input size quota exceeded");
    const output = Buffer.alloc(info.size); let offset = 0;
    while (offset < output.length) {
      const result = await handle.read(output, offset, output.length - offset, offset);
      if (!result.bytesRead) throw Error("Input truncated during read"); offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== info.size) throw Error("Input changed size during read"); return output;
  } finally { await handle.close(); }
}
