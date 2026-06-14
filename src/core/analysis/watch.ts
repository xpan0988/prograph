import { watch } from "node:fs";
import { resolveRepositoryRoot } from "../repository/repository.js";
import { syncRepository, type SyncResult } from "./sync.js";

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
  const runner = createDebouncedRunner(async () => {
    onSync?.(await syncRepository(root, index));
  }, debounceMs);
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    const normalized = String(filename ?? "").replaceAll("\\", "/");
    if (!normalized || IGNORED.test(normalized)) return;
    runner.schedule();
  });
  return () => {
    runner.close();
    watcher.close();
  };
}
