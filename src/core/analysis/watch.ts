import { watch } from "node:fs";
import path from "node:path";
import { resolveRepositoryRoot } from "../repository/repository.js";
import type { SyncResult } from "./sync.js";
import { executeIndex } from "./index-execution.js";

const IGNORED = /(?:^|\/)(?:\.git|\.prograph|node_modules|dist|build|out|target|coverage|vendor|generated|\.generated)(?:\/|$)/;

export function createDebouncedRunner(task: () => Promise<void>, debounceMs = 250): { schedule: () => void; close: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let closed = false;
  const run = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void run();
      }
    }
  };
  return {
    schedule: () => {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), debounceMs);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export async function watchRepository(input = ".", index?: string, onSync?: (result: SyncResult) => void, debounceMs = 250): Promise<() => void> {
  const root = await resolveRepositoryRoot(input);
  const selected = path.resolve(index ?? path.join(root, ".prograph"));
  const relativeIndex = path.relative(root, selected.endsWith(".sqlite") ? path.dirname(selected) : selected).split(path.sep).join("/");
  const nestedIndex = relativeIndex && relativeIndex !== ".." && !relativeIndex.startsWith("../") && !path.isAbsolute(relativeIndex) ? relativeIndex : undefined;
  const controller = new AbortController();
  const runner = createDebouncedRunner(async () => {
    try { onSync?.(await executeIndex({ operation: "sync", repository: root, ...(index !== undefined ? { index } : {}) }, { signal: controller.signal })); }
    catch (error) { if (!controller.signal.aborted) process.stderr.write(`ProGraph sync failed: ${String(error).slice(0, 2048)}\n`); }
  }, debounceMs);
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    const normalized = String(filename ?? "").replaceAll("\\", "/");
    if (!normalized || IGNORED.test(normalized) || nestedIndex && (normalized === nestedIndex || normalized.startsWith(`${nestedIndex}/`))) return;
    runner.schedule();
  });
  return () => {
    controller.abort();
    runner.close();
    watcher.close();
  };
}
