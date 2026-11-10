import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

export class InputLimitError extends Error {}
const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Hash dependency/artifact inputs without retaining their contents in memory. */
export async function digestFile(filename: string, maxBytes = 10 * 1024 ** 3, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256"); let size = 0;
  const handle = await open(filename, readFlags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error("Input is not a regular file");
    if (info.size > maxBytes) throw new InputLimitError("Input exceeds byte quota");
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      size += chunk.length;
      if (size > maxBytes) throw new InputLimitError("Input exceeds byte quota");
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
/** A file growing concurrently cannot turn a bounded read into an unbounded allocation. */
export async function boundedInput(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filename, readFlags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error("Input is not a regular file");
    if (info.size > maxBytes) throw new InputLimitError("Input size quota exceeded");
    const output = Buffer.alloc(info.size); let offset = 0;
    while (offset < output.length) {
      const result = await handle.read(output, offset, output.length - offset, offset);
      if (!result.bytesRead) throw Error("Input truncated during read"); offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== info.size) throw Error("Input changed size during read"); return output;
  } finally { await handle.close(); }
}
